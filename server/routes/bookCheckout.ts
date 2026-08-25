/**
 * Task #5097 — Book-commerce public checkout API route surface.
 *
 * Six routes, all carrying inline `bookCheckoutLimiter` so the route-inventory
 * parser detects the dedicated limiter on each registration:
 *
 *   GET  /api/book/checkout/catalog         — enabled packages (intentional_public)
 *   POST /api/book/checkout/start           — create checkout session (intentional_public)
 *   POST /api/book/checkout/resume          — resume by token (capability_token)
 *   POST /api/book/checkout/contact         — save contact info (capability_token)
 *   POST /api/book/checkout/totals          — compute authoritative quote (capability_token)
 *   POST /api/book/checkout/payment-intent  — create/refresh PaymentIntent (capability_token)
 *
 * Security model:
 *  - catalog + start are intentional_public (no credential required).
 *  - resume/contact/totals/payment-intent require a `resumeToken` in the
 *    request body; the raw token is NEVER stored — only its domain-separated
 *    HMAC-SHA256 over SESSION_SECRET is persisted and compared timing-safely.
 *  - The resume token is itself DERIVED deterministically (domain-separated
 *    HMAC over the canonical normalized email + package + idempotencyKey), so
 *    an idempotent `start` replay returns the SAME usable token and existing
 *    expiry — the token/hash relationship is stable across retries. No
 *    randomBytes are used.
 *  - Token expiry ≤ 24 h.
 *  - Generic 404 for "not found OR expired" to prevent enumeration; 410 when
 *    the session is definitively expired/completed.
 *  - .strict() schemas reject any extra fields (Stripe IDs, SKUs, prices, etc.)
 *    submitted by the browser.
 *  - The /contact route records an independent checkout SMS choice through the
 *    canonical ledger; a checked box stays pending until approved confirmation.
 *
 * Provider errors → 503/504 (timeout vs generic); validation → 400;
 * package/geo → 409; expiry → 410. All handlers use asyncHandler
 * (server/observability/httpErrors.ts).
 *
 * Dependencies are directly imported (no dynamic import / local stubs):
 *  - server/services/bookCheckoutStripe.ts  — high-level
 *    calculateAuthoritativeBookQuote / createOrRefreshBookPaymentIntent +
 *    classifyStripeError (service owns amounts / geography / shipping / tax).
 *  - server/storage/bookCheckoutEngineStorage.ts — resume/quote/bind/state fns.
 *  - server/storage/bookCommerceStorage.ts — contact/session persistence.
 *  - server/services/bookCommerceCatalog.ts — public catalog + selectability.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

import { asyncHandler, HttpError } from "../observability/httpErrors";
import {
  registerLimiterConfig,
  getDynamicMax,
  createRateLimitHandler,
  trackRequest,
} from "../services/rateLimitMonitor";

import {
  bookPackageCodes,
  type BookCheckoutSession,
} from "@shared/schema";

import {
  getEnabledPackagesForCatalog,
  isPackageSelectable,
  PackageNotSelectableError,
  type BookCommercePackageCode,
} from "../services/bookCommerceCatalog";

import {
  upsertBookContact,
  createBookCheckoutSession,
  normalizeBookEmail,
  IdempotencyConflictError,
  publicBookAttributionTouchSchema,
} from "../storage/bookCommerceStorage";

import {
  findCheckoutSessionByResumeHash,
  validateCheckoutContactSave,
  markCheckoutContactCompleted,
  persistCheckoutQuote,
  bindCheckoutPaymentIntent,
  updateCheckoutPaymentState,
} from "../storage/bookCheckoutEngineStorage";

import {
  calculateAuthoritativeBookQuote,
  createOrRefreshBookPaymentIntent,
  classifyStripeError,
  BookPaymentIntentReconciliationError,
  type CalculateBookQuoteResult,
  type CreateOrRefreshPaymentIntentResult,
} from "../services/bookCheckoutStripe";
import {
  BOOK_CHECKOUT_SMS_DISCLOSURE_VERSION,
  recordBookCheckoutSmsChoice,
} from "../services/smsConsent";
import { createImmediateBookAccessCapabilityForCheckout } from "../services/bookDelivery";

// ─── Rate limiter — dedicated IP-keyed 30/15m bucket ─────────────────────────

registerLimiterConfig("bookCheckout", 15 * 60 * 1000, 30, false);

const bookCheckoutLimiterInner = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => getDynamicMax("bookCheckout"),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  message: { message: "Too many checkout requests, please try again later." },
  handler: createRateLimitHandler("bookCheckout"),
});

/** Tracker middleware — always pass through, records usage counters. */
function bookCheckoutTracker(_req: Request, _res: Response, next: () => void): void {
  trackRequest("bookCheckout");
  next();
}

/**
 * `bookCheckoutLimiter` — array middleware carrying both the tracker and the
 * rate limiter so the route-inventory parser sees the name `bookCheckoutLimiter`
 * inline in every app.METHOD() registration.
 */
export const bookCheckoutLimiter = [bookCheckoutTracker, bookCheckoutLimiterInner];

// ─── Token helpers (deterministic, domain-separated) ─────────────────────────

const RESUME_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 h

/** Domain separators keep the derived TOKEN and its stored HASH independent. */
const TOKEN_DERIVE_DOMAIN = "book-checkout:resume-token:v1";
const TOKEN_HASH_DOMAIN = "book-checkout:resume-hash:v1";

function getSessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new HttpError(503, "Service configuration error", { expose: false });
  }
  return s;
}

/**
 * Derive a stable 256-bit pseudorandom resume token (64-char hex) from the
 * canonical identity of the checkout: normalized email + package code +
 * idempotencyKey, domain-separated under SESSION_SECRET.
 *
 * Because the derivation is deterministic, an idempotent `start` replay yields
 * the EXACT same token — whose hash is already stored — so the returned token
 * remains usable and the original expiry is preserved.
 */
function deriveResumeToken(
  normalizedEmail: string,
  packageCode: string,
  idempotencyKey: string,
): string {
  const canonical = `${TOKEN_DERIVE_DOMAIN}\n${normalizedEmail}\n${packageCode}\n${idempotencyKey}`;
  return createHmac("sha256", getSessionSecret()).update(canonical, "utf8").digest("hex");
}

/**
 * Compute the SEPARATE domain-separated HMAC hash of a raw resume token. This
 * is what is persisted; the raw token is never stored. Distinct domain from
 * the derivation so knowledge of the stored hash cannot reproduce the token.
 */
function hashResumeToken(token: string): string {
  const material = `${TOKEN_HASH_DOMAIN}\n${token}`;
  return createHmac("sha256", getSessionSecret()).update(material, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hex HMAC strings.
 * Reduces both to SHA-256 digests first so Buffer lengths always match.
 */
function tokenHashEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

// ─── Geography / shipping authority ───────────────────────────────────────────
//
// Geography is OWNED by the Stripe service: `calculateAuthoritativeBookQuote`
// enforces Complete = U.S.-only and resolves shipping, and Stripe Tax itself
// decides which countries are supported for tax. The route only normalizes the
// country to uppercase and maps the service's PackageNotSelectableError to a
// GENERIC 409 (never leaking approval/config reasoning). No route-local
// country allow-list or shipping computation.

// ─── Schemas ──────────────────────────────────────────────────────────────────

/** Package-code enum from the shared model (no `any` casts downstream). */
const packageCodeSchema = z.enum(bookPackageCodes);

// Public checkout accepts legacy click/device keys for rolling-deploy
// compatibility, but drops them. Only the explicitly approved campaign,
// referrer, landing, click-ID, and session fields cross the route boundary.
const attributionSchema = publicBookAttributionTouchSchema;

// POST /api/book/checkout/start
const startCheckoutSchema = z.object({
  packageCode:    packageCodeSchema,
  email:          z.string().email().max(320),
  idempotencyKey: z.string().min(1).max(128),
  /** Legacy single-touch payload retained for atomic-deploy compatibility. */
  attribution:    attributionSchema.optional(),
  firstAttribution: attributionSchema.optional(),
  latestAttribution: attributionSchema.optional(),
  // Honeypot: accept a BOUNDED non-empty string; a filled value → generic
  // accepted response with no side effects (see handler). A max(0) here would
  // make the "filled" branch unreachable, so the bound is a real length cap.
  website:        z.string().max(256).optional(),
}).strict();

// Token-bearing routes: resumeToken is the capability credential (64-char hex).
const resumeTokenField = z.object({
  resumeToken: z.string().length(64).regex(/^[0-9a-f]+$/),
});

// POST /api/book/checkout/resume
const resumeCheckoutSchema = resumeTokenField.strict();

// POST /api/book/checkout/contact
const contactCheckoutSchema = resumeTokenField.extend({
  firstName: z.string().trim().min(1).max(200),
  lastName:  z.string().trim().max(200).optional(),
  phone:     z.string().max(50).optional(),
  email:     z.string().email().max(320),
  smsMarketingConsent: z.boolean().default(false),
}).strict();

// Bounded address input (used by totals). Matches shared addressSnapshotSchema
// bounds; strict rejects any browser-supplied price/tax/SKU fields.
const addressInputSchema = z.object({
  line1:      z.string().min(1).max(200),
  line2:      z.string().max(200).optional(),
  city:       z.string().min(1).max(100),
  state:      z.string().min(1).max(100),
  postalCode: z.string().min(1).max(20),
  country:    z.string().length(2).regex(/^[A-Za-z]{2}$/),
}).strict();
type AddressInput = z.infer<typeof addressInputSchema>;

// POST /api/book/checkout/totals
const totalsCheckoutSchema = resumeTokenField.extend({
  address: addressInputSchema,
}).strict();

// POST /api/book/checkout/payment-intent
const paymentIntentCheckoutSchema = resumeTokenField.strict();

// ─── Session resolution (generic non-enumeration) ─────────────────────────────

/**
 * Resolve a checkout session from a raw resume token.
 *
 * Non-enumeration: EVERY unusable outcome (unknown token, expired session,
 * completed/expired/abandoned-final status) returns the SAME generic
 * HttpError(404). A definitively-expired session likewise maps to a generic
 * 410 only for the token-valid-but-time-expired case, but to avoid revealing
 * token validity we prefer 404 for lookup misses and reserve 410 for a
 * matched-but-expired session (a resumeToken holder legitimately learns their
 * own session expired).
 */
export async function requireCheckoutSession(
  resumeToken: string,
  opts: { allowCompleted?: boolean } = {},
): Promise<BookCheckoutSession> {
  const hash = hashResumeToken(resumeToken);

  const session = await findCheckoutSessionByResumeHash({ resumeTokenHash: hash });

  // Lookup miss (unknown/absent/final-status) → generic 404, no enumeration.
  if (!session) {
    throw new HttpError(404, "Checkout session not found");
  }

  // Defensive constant-time re-verification of the stored hash. A mismatch is
  // treated identically to a lookup miss.
  if (!tokenHashEqual(hash, session.resumeTokenHash ?? "")) {
    throw new HttpError(404, "Checkout session not found");
  }

  // Session time-expiry — the token holder learns their own session expired.
  if (session.expiresAt && session.expiresAt <= new Date()) {
    throw new HttpError(410, "Checkout session has expired");
  }

  // Mutating routes accept only pending sessions. Resume may explicitly read a
  // completed session so the browser can wait for verified webhook authority.
  if (
    session.status !== "pending" &&
    !(opts.allowCompleted && session.status === "completed")
  ) {
    throw new HttpError(410, "Checkout session is no longer active");
  }

  return session;
}

function requireActiveSession(resumeToken: string): Promise<BookCheckoutSession> {
  return requireCheckoutSession(resumeToken);
}

async function requireCompletedCheckoutContact(
  session: BookCheckoutSession,
): Promise<Awaited<ReturnType<typeof validateCheckoutContactSave>>["contact"]> {
  if (!session.contactId || !session.contactCompletedAt) {
    throw new HttpError(409, "Complete contact details before continuing");
  }
  try {
    const validated = await validateCheckoutContactSave({
      checkoutSessionId: session.id,
      contactId: session.contactId,
    });
    if (!validated.contact.name?.trim()) {
      throw new HttpError(409, "Complete contact details before continuing");
    }
    return validated.contact;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof IdempotencyConflictError) {
      throw new HttpError(409, "Checkout session conflict");
    }
    throw new HttpError(503, "Unable to validate contact", { cause: err });
  }
}

/** Canonical buyer-facing source; never persist an attacker-controlled Host. */
function bookCheckoutSourceUrl(): string {
  return "https://nobullmarketing.com/book/checkout/";
}

function requireStripePublishableKey(): string {
  const key = process.env.STRIPE_PUBLISHABLE_KEY?.trim();
  if (!key || !/^pk_(?:test|live)_[A-Za-z0-9]+$/.test(key)) {
    throw new HttpError(503, "Secure payment is temporarily unavailable");
  }
  return key;
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerBookCheckoutRoutes(app: Express): void {

  // ── GET /api/book/checkout/catalog ────────────────────────────────────────
  // Public: currently-enabled purchasable packages. Exposes ONLY public code,
  // name, authoritative amount, currency, and shipping. No SKU, no entitlement
  // codes, no provider IDs.
  app.get(
    "/api/book/checkout/catalog",
    bookCheckoutLimiter,
    asyncHandler(async (_req: Request, res: Response) => {
      const { getBookLaunchReadinessReport, launchGateContextFromReport } =
        await import("../services/bookLaunchReadiness");
      const readiness = await getBookLaunchReadinessReport();
      const packages = getEnabledPackagesForCatalog(
        undefined,
        launchGateContextFromReport(readiness),
      );

      const catalog = packages.map((pkg) => ({
        code:          pkg.code,
        name:          pkg.name,
        amountCents:   pkg.amountCents,
        currency:      pkg.currency,
        shippingCents: pkg.shippingCents,
      }));

      res.json({ packages: catalog });
    }),
  );

  // ── POST /api/book/checkout/start ─────────────────────────────────────────
  // Public: begin a checkout. Upserts a contact and creates a session; returns
  // a deterministic resumeToken so idempotent replays return the same token +
  // existing expiry.
  app.post(
    "/api/book/checkout/start",
    bookCheckoutLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = startCheckoutSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, "Invalid request");
      }
      const {
        packageCode,
        email,
        idempotencyKey,
        attribution,
        firstAttribution,
        latestAttribution,
        website,
      } = parsed.data;

      // Honeypot: a filled (non-empty) value → generic accepted response with
      // NO contact/session created. Bounded above by max(256).
      if (typeof website === "string" && website.length > 0) {
        res.status(202).json({ status: "accepted" });
        return;
      }

      // Package availability — GENERIC 409, never expose approval/config reason.
      const { getBookLaunchReadinessReport, launchGateContextFromReport } =
        await import("../services/bookLaunchReadiness");
      const readiness = await getBookLaunchReadinessReport();
      const sel = isPackageSelectable(
        packageCode as BookCommercePackageCode,
        undefined,
        launchGateContextFromReport(readiness),
      );
      if (!sel.selectable) {
        throw new HttpError(409, "This package is not available");
      }

      const normalizedEmail = normalizeBookEmail(email);
      // During an atomic deploy, older clients may still send the legacy
      // single-touch field. New clients send both snapshots so immutable first
      // touch is never reconstructed from a later checkout page.
      const firstTouch = firstAttribution ?? attribution ?? latestAttribution;
      const latestTouch = latestAttribution ?? attribution ?? firstAttribution;

      // Contact upsert (no SMS consent / no name here — just identity).
      let contactResult: Awaited<ReturnType<typeof upsertBookContact>>;
      try {
        contactResult = await upsertBookContact({
          email:       normalizedEmail,
          firstTouch,
          latestTouch,
        });
      } catch (err) {
        throw new HttpError(503, "Unable to process your request at this time", { cause: err });
      }

      // Deterministic token derivation → stable across idempotent replays.
      const resumeToken = deriveResumeToken(normalizedEmail, packageCode, idempotencyKey);
      const resumeTokenHash = hashResumeToken(resumeToken);
      const expiresAt = new Date(Date.now() + RESUME_TOKEN_EXPIRY_MS);

      let sessionResult: Awaited<ReturnType<typeof createBookCheckoutSession>>;
      try {
        sessionResult = await createBookCheckoutSession({
          contactId:       contactResult.contact.id,
          packageCode,
          idempotencyKey,
          resumeTokenHash,
          expiresAt,
          currentTouch:    latestTouch,
        });
      } catch (err) {
        if (err instanceof IdempotencyConflictError) {
          // Same key, different identity — generic conflict.
          throw new HttpError(409, "Checkout session conflict");
        }
        if (err instanceof PackageNotSelectableError) {
          throw new HttpError(409, "This package is not available");
        }
        throw new HttpError(503, "Unable to create checkout session", { cause: err });
      }

      // On an idempotent replay (created=false), return the STORED session's
      // expiry (not the freshly computed one) so the client sees the real
      // remaining window. The derived token is identical either way.
      const effectiveExpiry = sessionResult.session.expiresAt ?? expiresAt;

      res.status(sessionResult.created ? 201 : 200).json({
        resumeToken,
        expiresAt: effectiveExpiry.toISOString(),
      });
    }),
  );

  // ── POST /api/book/checkout/resume ────────────────────────────────────────
  // capability_token: resume an existing session by token. Returns current
  // workable state only (no contact/session identifiers beyond status flags).
  app.post(
    "/api/book/checkout/resume",
    bookCheckoutLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = resumeCheckoutSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, "Invalid request");
      }

      const session = await requireCheckoutSession(parsed.data.resumeToken, {
        allowCompleted: true,
      });

      const quoteValid =
        session.quoteVersion > 0 &&
        !!session.quoteExpiresAt &&
        session.quoteExpiresAt > new Date();
      let contactComplete = session.status === "completed";
      if (
        session.status === "pending" &&
        session.contactId &&
        session.contactCompletedAt
      ) {
        try {
          const validated = await validateCheckoutContactSave({
            checkoutSessionId: session.id,
            contactId: session.contactId,
          });
          contactComplete = Boolean(validated.contact.name?.trim());
        } catch (err) {
          if (err instanceof IdempotencyConflictError) {
            throw new HttpError(409, "Checkout session conflict");
          }
          throw new HttpError(503, "Unable to resume checkout", { cause: err });
        }
      }

      const accessToken =
        session.status === "completed"
          ? await createImmediateBookAccessCapabilityForCheckout(session.id)
          : null;

      res.json({
        packageCode:  session.packageCode,
        status:       session.status,
        paymentState: session.paymentState,
        hasContact:   !!session.contactId,
        contactComplete,
        hasQuote:     quoteValid,
        currency:     session.currency,
        expiresAt:    session.expiresAt?.toISOString() ?? null,
        accessReady:  accessToken !== null,
        accessToken,
      });
    }),
  );

  // ── POST /api/book/checkout/contact ───────────────────────────────────────
  // capability_token: save buyer contact details.
  //  - The session's existing contact/email is validated BEFORE any upsert, so
  //    a mismatched email never creates a stray contact row.
  //  - SMS choice is separate and server-evidenced; a checked box is pending
  //    confirmation and cannot make the send gate treat the number as opted in.
  //  - Returns a GENERIC success; no contactId / checkoutSessionId leaked.
  app.post(
    "/api/book/checkout/contact",
    bookCheckoutLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = contactCheckoutSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, "Invalid request");
      }
      const {
        resumeToken,
        firstName,
        lastName,
        phone,
        email,
        smsMarketingConsent,
      } = parsed.data;

      const session = await requireActiveSession(resumeToken);
      const normalizedEmail = normalizeBookEmail(email);

      // The session must already be bound to a contact (created at /start).
      if (!session.contactId) {
        throw new HttpError(409, "Checkout session is not ready for contact details");
      }

      // Validate the EXISTING session contact BEFORE upserting. This resolves
      // the session→contact binding without creating anything.
      let validated: Awaited<ReturnType<typeof validateCheckoutContactSave>>;
      try {
        validated = await validateCheckoutContactSave({
          checkoutSessionId: session.id,
          contactId:         session.contactId,
        });
      } catch (err) {
        if (err instanceof IdempotencyConflictError) {
          throw new HttpError(409, "Checkout session conflict");
        }
        throw new HttpError(503, "Unable to validate contact", { cause: err });
      }

      // Email must match the original contact BEFORE any write. A mismatch
      // returns 409 and creates no stray contact.
      if (normalizeBookEmail(validated.contact.email) !== normalizedEmail) {
        throw new HttpError(409, "Email address does not match this checkout");
      }

      if (smsMarketingConsent && !phone?.trim()) {
        throw new HttpError(400, "Enter a mobile number to choose SMS updates");
      }

      let smsChoice:
        | Awaited<ReturnType<typeof recordBookCheckoutSmsChoice>>
        | undefined;
      if (phone?.trim()) {
        try {
          smsChoice = await recordBookCheckoutSmsChoice({
            phone,
            selected: smsMarketingConsent,
            sourceUrl: bookCheckoutSourceUrl(),
            capturedAt: new Date(),
            ipAddress: req.ip,
            userAgent: req.get("user-agent"),
          });
        } catch (err) {
          throw new HttpError(503, "Unable to save SMS choice at this time", {
            cause: err,
          });
        }
        if ("error" in smsChoice) {
          throw new HttpError(400, smsChoice.error);
        }
      }

      // Safe to update name/phone on the existing contact (email unchanged,
      // so this cannot fork a new row). Consent authority is the canonical
      // ledger row; only versioned disclosure/confirmation fields are supplied.
      const fullName = lastName ? `${firstName} ${lastName}` : firstName;
      try {
        const saved = await upsertBookContact({
          email: normalizedEmail,
          name:  fullName,
          phone: smsChoice && !("error" in smsChoice) ? smsChoice.phoneE164 : phone ?? undefined,
          smsConsent:
            smsChoice && !("error" in smsChoice)
              ? {
                  ledgerId: smsChoice.ledgerId,
                  copyVersion: BOOK_CHECKOUT_SMS_DISCLOSURE_VERSION,
                   sourceUrl: bookCheckoutSourceUrl(),
                  confirmationStatus: smsChoice.confirmationStatus,
                  confirmedAt: smsChoice.confirmedAt,
                }
              : undefined,
        });
        const completed = await markCheckoutContactCompleted({
          checkoutSessionId: session.id,
          contactId: saved.contact.id,
        });
        if (!completed) {
          throw new IdempotencyConflictError(
            "checkout-contact-complete",
            session.id,
            "session is not active or contact is incomplete",
          );
        }
      } catch (err) {
        if (err instanceof IdempotencyConflictError) {
          throw new HttpError(409, "Checkout session conflict");
        }
        throw new HttpError(503, "Unable to save contact information", { cause: err });
      }

      res.json({ status: "ok" });
    }),
  );

  // ── POST /api/book/checkout/totals ────────────────────────────────────────
  // capability_token: compute the authoritative server-side quote. The Stripe
  // service (calculateAuthoritativeBookQuote) OWNS the catalog amounts,
  // Complete-US geography, shipping resolution, and Stripe Tax (called OUTSIDE
  // any DB transaction). The route only normalizes country, persists the
  // service's exact authoritative fields (≤ 30 min), and echoes persisted
  // values. The browser never supplies prices/tax.
  app.post(
    "/api/book/checkout/totals",
    bookCheckoutLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = totalsCheckoutSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, "Invalid request");
      }
      const { resumeToken, address } = parsed.data;

      const session = await requireActiveSession(resumeToken);
      await requireCompletedCheckoutContact(session);
      const { requireBookPackageLaunchReady } = await import(
        "../services/bookLaunchReadiness"
      );
      try {
        await requireBookPackageLaunchReady(
          session.packageCode as BookCommercePackageCode,
        );
      } catch (err) {
        if (err instanceof PackageNotSelectableError) {
          throw new HttpError(409, "This package is not available for this order");
        }
        throw err;
      }
      const countryUpper = address.country.toUpperCase();

      // Authoritative quote — service owns amounts/geo/shipping/tax.
      let quote: CalculateBookQuoteResult;
      try {
        quote = await calculateAuthoritativeBookQuote({
          checkoutSessionId: session.id,
          packageCode:       session.packageCode as BookCommercePackageCode,
          address: {
            line1:      address.line1,
            line2:      address.line2,
            city:       address.city,
            state:      address.state,
            postalCode: address.postalCode,
            country:    countryUpper,
          },
        });
      } catch (err) {
        if (err instanceof PackageNotSelectableError) {
          // Covers Complete-non-US, unconfigured shipping, and gating — all
          // mapped to a GENERIC 409 (no config/approval reasoning leaked).
          throw new HttpError(409, "This package is not available for this order");
        }
        throw mapProviderError(err);
      }

      // Persist the service's EXACT authoritative fields + calculation id.
      // Storage enforces the 30-minute ceiling + quoteVersion CAS.
      const quoteExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const persist = await persistCheckoutQuote({
        checkoutSessionId:      session.id,
        expectedQuoteVersion:   session.quoteVersion,
        subtotalAmountCents:    quote.subtotalAmountCents,
        discountAmountCents:    quote.discountAmountCents,
        shippingAmountCents:    quote.shippingAmountCents,
        taxAmountCents:         quote.taxAmountCents,
        stripeTaxCalculationId: quote.stripeTaxCalculationId,
        addressSnapshot: {
          line1:      address.line1,
          line2:      address.line2 ?? null,
          city:       address.city,
          state:      address.state,
          postalCode: address.postalCode,
          country:    countryUpper,
        },
        quoteExpiresAt,
      });

      if (!persist.updated || !persist.session) {
        // CAS miss / session no longer pending → generic conflict.
        throw new HttpError(409, "Quote could not be updated; please retry");
      }

      res.json({
        subtotalAmountCents: persist.session.subtotalAmountCents,
        discountAmountCents: persist.session.discountAmountCents,
        shippingAmountCents: persist.session.shippingAmountCents,
        taxAmountCents:      persist.session.taxAmountCents,
        amountTotalCents:    persist.session.amountTotalCents,
        currency:            persist.session.currency,
        quoteVersion:        persist.session.quoteVersion,
        quoteExpiresAt:      persist.session.quoteExpiresAt?.toISOString() ?? null,
      });
    }),
  );

  // ── POST /api/book/checkout/payment-intent ────────────────────────────────
  // capability_token: create/refresh a PaymentIntent from the stored unexpired
  // quote. The provider call happens OUTSIDE any DB transaction. On bind
  // CAS/conflict AFTER provider success, the session is flagged
  // reconciliation_needed (durably, not swallowed). Returns ONLY clientSecret
  // + server-authoritative totals/status — no PI id, SKU, or session id.
  app.post(
    "/api/book/checkout/payment-intent",
    bookCheckoutLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = paymentIntentCheckoutSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, "Invalid request");
      }
      const { resumeToken } = parsed.data;

      const session = await requireActiveSession(resumeToken);
      const checkoutContact = await requireCompletedCheckoutContact(session);
      const { requireBookPackageLaunchReady } = await import(
        "../services/bookLaunchReadiness"
      );
      try {
        await requireBookPackageLaunchReady(
          session.packageCode as BookCommercePackageCode,
        );
      } catch (err) {
        if (err instanceof PackageNotSelectableError) {
          throw new HttpError(409, "This package is not available");
        }
        throw err;
      }
      // Fail before any provider side effect when the browser cannot securely
      // mount Stripe.js for the resulting client secret.
      const publishableKey = requireStripePublishableKey();

      // Require a valid, unexpired quote. A null quoteExpiresAt is treated as
      // NO valid quote (must recalculate) — not as "never expires".
      if (session.quoteVersion === 0) {
        throw new HttpError(409, "No quote exists for this session; calculate totals first");
      }
      if (!session.quoteExpiresAt || session.quoteExpiresAt <= new Date()) {
        throw new HttpError(410, "Quote has expired; please recalculate totals");
      }

      // Payment-state gating (which states may create/refresh a PI):
      //  - none            → first PI creation.
      //  - intent_created  → refresh the existing bound PI.
      //  - unknown         → safe to retry with the SAME immutable quote and
      //                      stable create/update idempotency key, whether or
      //                      not the provider id was bound before the timeout.
      // Everything else (processing/captured/failed/canceled/
      // reconciliation_needed) is refused here.
      const isSafeUnknownRetry = session.paymentState === "unknown";
      if (session.paymentState === "reconciliation_needed") {
        throw new HttpError(409, "This checkout requires manual review; please contact support");
      }
      if (
        session.paymentState !== "none" &&
        session.paymentState !== "intent_created" &&
        !isSafeUnknownRetry
      ) {
        throw new HttpError(409, "Payment is already in progress for this checkout");
      }

      // Receipt email — validate the session's bound contact (no stray writes).
      const receiptEmail = checkoutContact.email || null;

      // Provider call OUTSIDE any DB transaction. The service owns metadata,
      // amount/currency validation, and client-secret non-null guarantee.
      let pi: CreateOrRefreshPaymentIntentResult;
      try {
        pi = await createOrRefreshBookPaymentIntent({
          checkoutSessionId:         session.id,
          packageCode:               session.packageCode as BookCommercePackageCode,
          quoteVersion:              session.quoteVersion,
          amountCents:               session.amountTotalCents,
          currency:                  "USD",
          existingProviderSessionId: session.providerSessionId,
          receiptEmail,
        });
      } catch (err) {
        if (err instanceof BookPaymentIntentReconciliationError) {
          await flagReconciliationNeeded(session.id);
          throw new HttpError(
            409,
            "This checkout requires manual review; please contact support",
          );
        }
        // Classified: timeout/network → durable 'unknown' (safe to retry with
        // the same quote later); other provider errors → generic 503.
        const outcome = classifyStripeError(err);
        if (outcome.kind === "timeout_or_network") {
          await persistUnknownState(session.id, "payment provider timeout");
          throw new HttpError(504, "Payment service timed out; please try again");
        }
        throw new HttpError(503, "Unable to process payment at this time", { cause: err });
      }

      // Durably bind the PI under a quoteVersion CAS. A conflict AFTER a
      // successful provider call means the local record and Stripe may
      // diverge → flag reconciliation_needed durably (the DB error is NOT
      // swallowed: if that write itself fails it propagates as a 500).
      try {
        await bindCheckoutPaymentIntent({
          checkoutSessionId:    session.id,
          paymentIntentId:      pi.paymentIntentId,
          expectedQuoteVersion: session.quoteVersion,
        });
      } catch (err) {
        if (err instanceof IdempotencyConflictError) {
          await flagReconciliationNeeded(session.id);
          throw new HttpError(409, "This checkout requires manual review; please contact support");
        }
        await flagReconciliationNeeded(session.id);
        throw new HttpError(503, "Payment could not be finalized; please contact support", { cause: err });
      }

      // Return ONLY clientSecret + status + server-authoritative totals. No PI
      // id, SKU, or session id is echoed.
      res.json({
        clientSecret:        pi.clientSecret,
        publishableKey,
        status:              pi.status,
        subtotalAmountCents: session.subtotalAmountCents,
        discountAmountCents: session.discountAmountCents,
        shippingAmountCents: session.shippingAmountCents,
        taxAmountCents:      session.taxAmountCents,
        amountTotalCents:    session.amountTotalCents,
        currency:            session.currency,
      });
    }),
  );
}

// ─── Local helpers ──────────────────────────────────────────────────────────

/** Map a Stripe/provider error to a classified 503/504 (generic message). */
function mapProviderError(err: unknown): HttpError {
  const outcome = classifyStripeError(err);
  if (outcome.kind === "timeout_or_network") {
    return new HttpError(504, "Pricing service timed out; please try again");
  }
  return new HttpError(503, "Unable to calculate totals at this time", { cause: err });
}

/** Persist a durable 'unknown' payment state with a bounded generic note. */
async function persistUnknownState(checkoutSessionId: string, reason: string): Promise<void> {
  await updateCheckoutPaymentState({
    checkoutSessionId,
    paymentState:         "unknown",
    paymentUnknownReason: reason.slice(0, 500),
  });
}

/**
 * Flag a session as reconciliation_needed with a bounded generic note. Does
 * NOT swallow DB errors silently — the caller decides the response, but if this
 * write itself throws it propagates to the global handler (a lost
 * reconciliation flag is worse than a 500).
 */
async function flagReconciliationNeeded(checkoutSessionId: string): Promise<void> {
  await updateCheckoutPaymentState({
    checkoutSessionId,
    paymentState:       "reconciliation_needed",
    reconciliationNote: "payment intent bind conflict after provider success",
  });
}

/** Narrow test surface for hostile-payload validation without mounting Express. */
export const __test = {
  startCheckoutSchema,
  resumeCheckoutSchema,
  contactCheckoutSchema,
  totalsCheckoutSchema,
  paymentIntentCheckoutSchema,
};
