// @db-pool-intent: ambient
//
// Task #5097 — book-commerce persistence, CHECKOUT ENGINE slice.
//
// Focused storage functions for checkout session state management:
//   1. Resume lookup by hash
//   2. Contact save validation
//   3. Quote persistence: quoteVersion CAS + expiry window enforcement
//      (quoteExpiresAt > now AND <= now+30m; session pending; status guard)
//   4. PaymentIntent binding: quoteVersion CAS + expiry + status guards
//   5. Payment state update
//   6. Bounded reconciliation candidate listing
//
// Commerce authority fields (subtotal, discount, shipping, tax, total,
// quoteVersion, paymentState) are always server-owned — Zod schemas are
// bounded/strict; no z.record(z.unknown()) for structured data.
//
// No vendor/network calls inside transactions.

import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bookCheckoutSessions,
  bookContacts,
  checkoutPaymentStates,
  addressSnapshotSchema,
  type BookCheckoutSession,
  type BookContact,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import {
  bookCommerceLabel,
  IdempotencyConflictError,
  IncompleteAggregateError,
  insertOutboxTx,
} from "./bookCommerceStorage";

// ═══════════════════════════════════════════════════════════════════════════
// 1. Resume lookup by hash
// ═══════════════════════════════════════════════════════════════════════════

export const resumeByHashSchema = z.object({
  resumeTokenHash: z.string().min(1).max(256),
});

/** Look up a checkout session by its hashed resume token, including completion. */
export async function findCheckoutSessionByResumeHash(
  raw: z.infer<typeof resumeByHashSchema>,
): Promise<BookCheckoutSession | null> {
  const input = resumeByHashSchema.parse(raw);
  return withDbAttribution(bookCommerceLabel("checkout-resume-lookup"), async () => {
    const [row] = await getDb()
      .select()
      .from(bookCheckoutSessions)
      .where(
        and(
          eq(bookCheckoutSessions.resumeTokenHash, input.resumeTokenHash),
          or(
            eq(bookCheckoutSessions.status, "pending"),
            eq(bookCheckoutSessions.status, "completed"),
            eq(bookCheckoutSessions.status, "abandoned"),
          ),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Contact save validation
// ═══════════════════════════════════════════════════════════════════════════

export const validateContactSaveSchema = z.object({
  checkoutSessionId: z.string().min(1),
  contactId: z.string().min(1),
});

/**
 * Validate that the contactId belongs to a pending session. Returns the
 * session + contact pair or throws on mismatch/not-found/not-pending.
 */
export async function validateCheckoutContactSave(
  raw: z.infer<typeof validateContactSaveSchema>,
): Promise<{ session: BookCheckoutSession; contact: BookContact }> {
  const input = validateContactSaveSchema.parse(raw);
  return withDbAttribution(bookCommerceLabel("checkout-contact-validate"), async () => {
    const db = getDb();
    const [session] = await db
      .select()
      .from(bookCheckoutSessions)
      .where(eq(bookCheckoutSessions.id, input.checkoutSessionId))
      .limit(1);
    if (!session) {
      throw new IdempotencyConflictError(
        "checkout-contact-save",
        input.checkoutSessionId,
        "session does not exist",
      );
    }
    if (session.status !== "pending") {
      throw new IdempotencyConflictError(
        "checkout-contact-save",
        input.checkoutSessionId,
        `session status is ${session.status}, not pending`,
      );
    }
    if (session.contactId && session.contactId !== input.contactId) {
      throw new IdempotencyConflictError(
        "checkout-contact-save",
        input.checkoutSessionId,
        `session already bound to contactId ${session.contactId}`,
      );
    }
    const [contact] = await db
      .select()
      .from(bookContacts)
      .where(eq(bookContacts.id, input.contactId))
      .limit(1);
    if (!contact) {
      throw new IncompleteAggregateError(
        `contact ${input.contactId} not found for checkout ${input.checkoutSessionId}`,
      );
    }
    return { session, contact };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Contact-step completion
// ═══════════════════════════════════════════════════════════════════════════

export const completeContactStepSchema = z.object({
  checkoutSessionId: z.string().min(1),
  contactId: z.string().min(1),
});

/**
 * Mark the checkout contact step complete only while the same active pending
 * session remains bound to a contact with a nonblank name.
 *
 * When the update succeeds and the contact step was not previously completed
 * (first time), this also inserts a `checkout.recoverable` outbox entry in
 * the same transaction so that downstream GHL sync can mirror the lead state.
 * This is idempotent: the outbox key `checkout-recoverable:<sessionId>` uses
 * onConflictDoNothing, so a retry never duplicates the entry.
 */
export async function markCheckoutContactCompleted(
  raw: z.infer<typeof completeContactStepSchema>,
): Promise<BookCheckoutSession | null> {
  const input = completeContactStepSchema.parse(raw);
  const result = await withDbAttribution(bookCommerceLabel("checkout-contact-complete"), async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(bookCheckoutSessions)
        .set({
          contactCompletedAt: sql`COALESCE(${bookCheckoutSessions.contactCompletedAt}, now())`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(bookCheckoutSessions.id, input.checkoutSessionId),
            eq(bookCheckoutSessions.contactId, input.contactId),
            eq(bookCheckoutSessions.status, "pending"),
            or(
              isNull(bookCheckoutSessions.expiresAt),
              gt(bookCheckoutSessions.expiresAt, sql`now()`),
            ),
            sql`EXISTS (
              SELECT 1
              FROM book_contacts bc
              WHERE bc.id = ${input.contactId}
                AND btrim(COALESCE(bc.name, '')) <> ''
            )`,
          ),
        )
        .returning();

      if (!updated) return null;

      // Emit checkout.recoverable only on the first contact completion
      // (i.e., when contactCompletedAt was just set, not a no-op COALESCE).
      // We detect "first time" by checking the pre-update state was null —
      // COALESCE preserved the old value if already set, so the row's
      // contactCompletedAt was null before this update if and only if the
      // WHERE clause matched and the row had a null contactCompletedAt.
      // Since the WHERE has no contactCompletedAt IS NULL guard, it can match
      // an already-completed session (idempotent). We still insert the outbox
      // row with onConflictDoNothing — the outer idempotency key prevents
      // duplicates, and the very first write wins.
      await insertOutboxTx(tx, {
        eventType: "checkout.recoverable",
        sourceType: "checkout_session",
        sourceId: updated.id,
        payload: {
          checkoutSessionId: updated.id,
          contactId: updated.contactId,
          packageCode: updated.packageCode,
        },
        idempotencyKey: `checkout-recoverable:${updated.id}`,
      });

      return updated;
    });
  });

  // Post-commit kick so the GHL relay drains the checkout.recoverable entry
  // promptly. Never throws; boot catch-up recovers a lost kick.
  if (result) {
    const { kickGhlOutboundSyncFireAndForget } = await import("../services/ghlOutboundKick");
    kickGhlOutboundSyncFireAndForget();
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Quote persistence (optimistic quoteVersion CAS + expiry enforcement)
// ═══════════════════════════════════════════════════════════════════════════

/** Max quote validity window: 30 minutes from now. */
const QUOTE_MAX_FUTURE_MS = 30 * 60 * 1000;

export const persistQuoteSchema = z.object({
  checkoutSessionId: z.string().min(1),
  /** Current quoteVersion the caller last read (CAS guard). */
  expectedQuoteVersion: z.number().int().min(0),
  /** Server-computed subtotal (must satisfy catalog guard: digital=499, complete=1999). */
  subtotalAmountCents: z.number().int().min(0),
  /** Discount applied (0 for fixed catalog). */
  discountAmountCents: z.number().int().min(0),
  /** Shipping charged. */
  shippingAmountCents: z.number().int().min(0),
  /** Tax charged. */
  taxAmountCents: z.number().int().min(0),
  /** Stripe Tax calculation ID (null if not applicable). */
  stripeTaxCalculationId: z.string().max(256).optional().nullable(),
  /**
   * Billing/shipping address snapshot (strict schema — no arbitrary keys).
   * null = no address collected yet.
   */
  addressSnapshot: addressSnapshotSchema.optional().nullable(),
  /**
   * When this quote expires. Must be > now and <= now+30m.
   * null = quote has no expiry (allowed but not recommended).
   */
  quoteExpiresAt: z.date().optional().nullable(),
});
export type PersistQuoteInput = z.infer<typeof persistQuoteSchema>;

export interface PersistQuoteResult {
  /** Updated session; null when CAS failed (stale version or wrong status). */
  session: BookCheckoutSession | null;
  updated: boolean;
}

/**
 * Persist a server-computed quote update using quoteVersion CAS.
 *
 * Validation (before DB write):
 *   - quoteExpiresAt, if provided, must be > now AND <= now+30 minutes.
 *   - discount <= subtotal (DB check also enforces this).
 *
 * CAS / lock conditions (all must hold or the write is a no-op):
 *   - status = 'pending'
 *   - quote_version = expectedQuoteVersion
 *   - provider_session_id IS NULL (no PaymentIntent bound yet)
 *   - payment_state IN ('none','failed') — quote is locked once payment moved
 *     to intent_created/processing/captured/unknown/reconciliation_needed/canceled
 *   - session not expired (expires_at NULL or in the future)
 */
export async function persistCheckoutQuote(
  raw: PersistQuoteInput,
): Promise<PersistQuoteResult> {
  const input = persistQuoteSchema.parse(raw);

  // Pre-validate expiry window.
  if (input.quoteExpiresAt !== null && input.quoteExpiresAt !== undefined) {
    const now = Date.now();
    if (input.quoteExpiresAt.getTime() <= now) {
      throw new IdempotencyConflictError(
        "checkout-quote-persist",
        input.checkoutSessionId,
        `quoteExpiresAt must be in the future (got ${input.quoteExpiresAt.toISOString()})`,
      );
    }
    if (input.quoteExpiresAt.getTime() > now + QUOTE_MAX_FUTURE_MS) {
      throw new IdempotencyConflictError(
        "checkout-quote-persist",
        input.checkoutSessionId,
        `quoteExpiresAt exceeds 30-minute maximum (got ${input.quoteExpiresAt.toISOString()})`,
      );
    }
  }
  if (input.discountAmountCents > input.subtotalAmountCents) {
    throw new IdempotencyConflictError(
      "checkout-quote-persist",
      input.checkoutSessionId,
      `discountAmountCents (${input.discountAmountCents}) exceeds subtotal (${input.subtotalAmountCents})`,
    );
  }

  const amountTotal =
    input.subtotalAmountCents -
    input.discountAmountCents +
    input.shippingAmountCents +
    input.taxAmountCents;

  return withDbAttribution(bookCommerceLabel("checkout-quote-persist"), async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(bookCheckoutSessions)
        .set({
          subtotalAmountCents: input.subtotalAmountCents,
          discountAmountCents: input.discountAmountCents,
          shippingAmountCents: input.shippingAmountCents,
          taxAmountCents: input.taxAmountCents,
          amountTotalCents: amountTotal,
          quoteVersion: input.expectedQuoteVersion + 1,
          quoteExpiresAt: input.quoteExpiresAt ?? null,
          stripeTaxCalculationId: input.stripeTaxCalculationId ?? null,
          addressSnapshot: input.addressSnapshot ?? null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(bookCheckoutSessions.id, input.checkoutSessionId),
            eq(bookCheckoutSessions.quoteVersion, input.expectedQuoteVersion),
            eq(bookCheckoutSessions.status, "pending"),
            isNotNull(bookCheckoutSessions.contactCompletedAt),
            // Quote writes are refused once a PaymentIntent is bound.
            isNull(bookCheckoutSessions.providerSessionId),
            // Only re-quotable payment states: none | failed. Any of
            // intent_created / processing / captured / unknown /
            // reconciliation_needed / canceled locks the quote.
            inArray(bookCheckoutSessions.paymentState, ["none", "failed"]),
            // Session must not be expired.
            or(
              isNull(bookCheckoutSessions.expiresAt),
              gt(bookCheckoutSessions.expiresAt, sql`now()`),
            ),
          ),
        )
        .returning();
      if (!updated) return { session: null, updated: false };
      return { session: updated, updated: true };
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. PaymentIntent binding (quoteVersion CAS + expiry + status guards)
// ═══════════════════════════════════════════════════════════════════════════

export const bindPaymentIntentSchema = z.object({
  checkoutSessionId: z.string().min(1),
  /** The Stripe PaymentIntent ID to bind (stored in provider_session_id). */
  paymentIntentId: z.string().min(1).max(256),
  /**
   * quoteVersion CAS guard: prevents binding a PI to a stale quote if a tax
   * calculation or amount has changed since the PI was created. Must be >= 1 —
   * a PI can only be bound after at least one quote has been persisted.
   */
  expectedQuoteVersion: z.number().int().min(1),
});

/**
 * Durably bind a PaymentIntent ID to a checkout session. Requires:
 *   - status = 'pending'
 *   - session not expired
 *   - a persisted quote: quoteVersion >= 1 AND quoteExpiresAt non-null & future
 *   - quoteVersion == expectedQuoteVersion (CAS; blocks tax/amount races)
 *   - provider_session_id currently NULL (or same PI → idempotent)
 * Throws IdempotencyConflictError on PI conflict, expired/absent quote, expired
 * session, or stale quote version. Idempotent when the same PI is re-bound.
 */
export async function bindCheckoutPaymentIntent(
  raw: z.infer<typeof bindPaymentIntentSchema>,
): Promise<BookCheckoutSession> {
  const input = bindPaymentIntentSchema.parse(raw);
  return withDbAttribution(bookCommerceLabel("checkout-pi-bind"), async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(bookCheckoutSessions)
        .where(eq(bookCheckoutSessions.id, input.checkoutSessionId))
        .for("update")
        .limit(1);

      if (!session) {
        throw new IdempotencyConflictError(
          "checkout-pi-bind",
          input.checkoutSessionId,
          "session does not exist",
        );
      }
      if (session.status !== "pending") {
        throw new IdempotencyConflictError(
          "checkout-pi-bind",
          input.checkoutSessionId,
          `session status is ${session.status}, not pending`,
        );
      }
      if (!session.contactCompletedAt) {
        throw new IdempotencyConflictError(
          "checkout-pi-bind",
          input.checkoutSessionId,
          "contact step has not been completed",
        );
      }
      // Reject expired sessions.
      if (session.expiresAt && session.expiresAt <= new Date()) {
        throw new IdempotencyConflictError(
          "checkout-pi-bind",
          input.checkoutSessionId,
          `session has expired at ${session.expiresAt.toISOString()}`,
        );
      }
      // A valid, unexpired quote is required to bind a PaymentIntent.
      if (session.quoteExpiresAt === null) {
        throw new IdempotencyConflictError(
          "checkout-pi-bind",
          input.checkoutSessionId,
          "no quote expiry set — a valid quote must be persisted before binding a PI",
        );
      }
      if (session.quoteExpiresAt <= new Date()) {
        throw new IdempotencyConflictError(
          "checkout-pi-bind",
          input.checkoutSessionId,
          `quote has expired at ${session.quoteExpiresAt.toISOString()}`,
        );
      }
      // A PI can only bind after a real quote (version must have advanced).
      if (session.quoteVersion < 1) {
        throw new IdempotencyConflictError(
          "checkout-pi-bind",
          input.checkoutSessionId,
          `no quote persisted yet (quoteVersion=${session.quoteVersion})`,
        );
      }
      // CAS guard: quote version must not have advanced since PI was created.
      if (session.quoteVersion !== input.expectedQuoteVersion) {
        throw new IdempotencyConflictError(
          "checkout-pi-bind",
          input.checkoutSessionId,
          `quoteVersion mismatch: expected=${input.expectedQuoteVersion} current=${session.quoteVersion}`,
        );
      }
      // Idempotent: same PI already bound. A stable retry after a client
      // timeout re-binds the same PI; if the session drifted to a recoverable
      // state (unknown / failed) we atomically restore it to intent_created and
      // clear the transient diagnostics so the flow converges. We NEVER
      // downgrade an advanced/terminal state (processing / captured / canceled
      // / reconciliation_needed): those are returned as-is.
      if (session.providerSessionId === input.paymentIntentId) {
        if (session.paymentState === "unknown" || session.paymentState === "failed") {
          const [restored] = await tx
            .update(bookCheckoutSessions)
            .set({
              paymentState: "intent_created",
              paymentUnknownReason: null,
              paymentError: null,
              reconciliationNote: null,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(bookCheckoutSessions.id, input.checkoutSessionId),
                eq(bookCheckoutSessions.providerSessionId, input.paymentIntentId),
                inArray(bookCheckoutSessions.paymentState, ["unknown", "failed"]),
              ),
            )
            .returning();
          if (restored) return restored;
        }
        return session;
      }
      // Conflict: different PI already bound.
      if (session.providerSessionId !== null) {
        throw new IdempotencyConflictError(
          "checkout-pi-bind",
          input.checkoutSessionId,
          `session already bound to PI ${session.providerSessionId}`,
        );
      }

      const [updated] = await tx
        .update(bookCheckoutSessions)
        .set({
          providerSessionId: input.paymentIntentId,
          paymentState: "intent_created",
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(bookCheckoutSessions.id, input.checkoutSessionId),
            eq(bookCheckoutSessions.quoteVersion, input.expectedQuoteVersion),
            eq(bookCheckoutSessions.status, "pending"),
            isNotNull(bookCheckoutSessions.contactCompletedAt),
            isNull(bookCheckoutSessions.providerSessionId),
            // Quote must still be in the future at write time.
            gt(bookCheckoutSessions.quoteExpiresAt, sql`now()`),
          ),
        )
        .returning();

      if (!updated) {
        throw new IncompleteAggregateError(
          `checkout ${input.checkoutSessionId} PI bind CAS failed unexpectedly`,
        );
      }
      return updated;
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Payment state update
// ═══════════════════════════════════════════════════════════════════════════

export const updatePaymentStateSchema = z.object({
  checkoutSessionId: z.string().min(1),
  paymentState: z.enum(checkoutPaymentStates),
  paymentError: z.string().max(2000).optional().nullable(),
  paymentUnknownReason: z.string().max(2000).optional().nullable(),
  reconciliationNote: z.string().max(500).optional().nullable(),
  markCompleted: z.boolean().optional(),
});
export type UpdatePaymentStateInput = z.infer<typeof updatePaymentStateSchema>;

/**
 * Durably update the payment state on a checkout session.
 * Returns the updated session or null if session not found.
 */
export async function updateCheckoutPaymentState(
  raw: UpdatePaymentStateInput,
): Promise<BookCheckoutSession | null> {
  const input = updatePaymentStateSchema.parse(raw);
  return withDbAttribution(bookCommerceLabel("checkout-payment-state"), async () => {
    const [updated] = await getDb()
      .update(bookCheckoutSessions)
      .set({ // spread-write-approved: focused updatePaymentStateSchema fields plus server-owned completion timestamps only
        paymentState: input.paymentState,
        paymentError: input.paymentError ?? null,
        paymentUnknownReason: input.paymentUnknownReason ?? null,
        reconciliationNote: input.reconciliationNote ?? null,
        ...(input.markCompleted
          ? { status: "completed", completedAt: sql`now()` }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(bookCheckoutSessions.id, input.checkoutSessionId))
      .returning();
    return updated ?? null;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Bounded reconciliation candidate listing
// ═══════════════════════════════════════════════════════════════════════════

export const listReconciliationCandidatesSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  beforeCreatedAt: z.date().optional(),
});
export type ListReconciliationCandidatesInput = z.infer<
  typeof listReconciliationCandidatesSchema
>;

/**
 * Return a bounded list of checkout sessions needing reconciliation:
 * unknown/reconciliation_needed payment states, or processing with expired quote.
 */
export async function listReconciliationCandidates(
  raw: ListReconciliationCandidatesInput,
): Promise<BookCheckoutSession[]> {
  const input = listReconciliationCandidatesSchema.parse(raw);
  const before = input.beforeCreatedAt ?? new Date();
  return withDbAttribution(
    bookCommerceLabel("checkout-reconciliation-list"),
    async () => {
      return getDb()
        .select()
        .from(bookCheckoutSessions)
        .where(
          and(
            lt(bookCheckoutSessions.createdAt, before),
            or(
              eq(bookCheckoutSessions.paymentState, "unknown"),
              eq(bookCheckoutSessions.paymentState, "reconciliation_needed"),
              and(
                eq(bookCheckoutSessions.paymentState, "processing"),
                lte(bookCheckoutSessions.quoteExpiresAt, sql`now()`),
              ),
            ),
          ),
        )
        .orderBy(bookCheckoutSessions.createdAt)
        .limit(input.limit);
    },
  );
}

export type { BookCheckoutSession };

// ═══════════════════════════════════════════════════════════════════════════
// 7. applyVerifiedStripeBookEvent — thin façade for the webhook dispatcher
//
// Task #5097: the webhook dispatcher in stripeSync.ts imports THIS function
// rather than importing bookCommerceWebhookApplicator directly, keeping
// stripeSync's dependency surface narrow and the applicator replaceable.
//
// COMPILE ALIGNMENT NOTES:
//   - NormalizedStripeBookEvent from bookCommerceWebhookApplicator includes a
//     native effectsPaused field (default false) and refundedAmountCentsCumulative.
//   - The dispatcher in stripeSync.ts maps verified Stripe event objects to
//     this shape (safe ids/type/amount/currency/status/metadata only, plus
//     refundedAmountCentsCumulative and effectsPaused:false).
//   - This façade OVERWRITES the native event.effectsPaused with opts.effectsPaused
//     so the kill-switch decision made by the dispatcher is authoritative.
// ═══════════════════════════════════════════════════════════════════════════

import {
  applyVerifiedBookWebhookEvent,
  normalizedStripeBookEventSchema,
  type NormalizedStripeBookEvent,
  type ApplyBookWebhookEventResult,
} from "./bookCommerceWebhookApplicator";
import { bookPaymentEvents } from "@shared/schema";

export type { NormalizedStripeBookEvent, ApplyBookWebhookEventResult };

export interface ApplyVerifiedStripeBookEventOptions {
  /**
   * When true (kill switch engaged), the applicator records the event for
   * receipt/reconciliation durability (links session, sets
   * reconciliation_needed, leaves processedAt NULL) but applies NO order or
   * entitlement side-effects. The storage call is still made so the payment
   * event row is inserted with replay-safe idempotency.
   */
  effectsPaused: boolean;
}

/**
 * Apply a pre-verified, PCI-sanitised Stripe book webhook event to the
 * book-commerce storage layer.
 *
 * This is the canonical entry point for stripeSync.ts's webhook dispatcher.
 * All Stripe signature verification MUST be done BEFORE calling this function.
 *
 * When effectsPaused=true the event is recorded for durability/reconciliation
 * but fulfilment side-effects are suppressed (order creation, entitlements,
 * outbox). This supports the book_payment_processing kill switch requirement:
 * "even when paused, dispatch verified supported event to storage with
 * effectsPaused=true so receipt/reconciliation is durable."
 */
export async function applyVerifiedStripeBookEvent(
  event: NormalizedStripeBookEvent,
  opts: ApplyVerifiedStripeBookEventOptions,
): Promise<ApplyBookWebhookEventResult> {
  // Set the native effectsPaused from the dispatcher's kill-switch decision —
  // this is authoritative over whatever the event carried. Also drop a safe,
  // bounded audit marker into rawPayload (no PCI data) for reconciliation.
  const forwarded: NormalizedStripeBookEvent = {
    ...event,
    effectsPaused: opts.effectsPaused,
    rawPayload: {
      ...(event.rawPayload ?? {}),
      _killSwitchPaused: opts.effectsPaused,
    },
  };
  return applyVerifiedBookWebhookEvent(forwarded);
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. replayPendingVerifiedBookEvents — restart-safe kill-switch replay seam
//
// After the book_payment_processing kill switch is released (or the process
// restarts), verified events that were persisted with processedAt=NULL (either
// paused, or failed mid-apply) must be re-driven to completion. This seam:
//   - lists at most `limit` (<=100) stripe payment events with processedAt NULL,
//     oldest first, in ONE read-only query;
//   - for each, rehydrates a NormalizedStripeBookEvent ONLY from the row's
//     PCI-safe persisted columns + reserved `_`-prefixed rawPayload keys;
//   - validates it through normalizedStripeBookEventSchema — malformed rows are
//     reported as errors and left UNPROCESSED (never marked done);
//   - calls applyVerifiedBookWebhookEvent ONE event at a time, each in its own
//     transaction OWNED BY the applicator, strictly OUTSIDE the listing query.
//     No vendor/network call and no applicator call ever runs inside the
//     listing transaction.
// Returns a bounded numeric/string summary — never the full event payloads.
// ═══════════════════════════════════════════════════════════════════════════

export const replayPendingVerifiedBookEventsSchema = z.object({
  /** Max events to attempt this pass (bounded 1..100). */
  limit: z.number().int().min(1).max(100).default(50),
  /** Restrict a production catch-up pass to kill-switch-paused events. */
  onlyPaused: z.boolean().default(false),
  /**
   * Applied to every rehydrated event. Default false = drive to completion
   * (used after switch release). Pass true to re-record durably while paused.
   */
  effectsPaused: z.boolean().default(false),
  /** Optional operator-targeted replay. When set, no sibling event is touched. */
  paymentEventId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._~:-]*$/)
    .optional(),
});

export interface ReplayPendingVerifiedBookEventsResult {
  /** Events fetched and attempted this pass. */
  attempted: number;
  /** Events that reached a clean processed state (processedAt set). */
  processed: number;
  /**
   * Events that applied but still need reconciliation (session unresolved,
   * amount mismatch, or paused) — processedAt still NULL, retryable.
   */
  needsReconciliation: number;
  /** Malformed / un-rehydratable rows left unprocessed, with a bounded reason. */
  errors: Array<{ providerEventId: string | null; reason: string }>;
  /**
   * Whether more unprocessed events likely remain (a full page was returned),
   * so the caller can schedule another bounded pass.
   */
  moreLikely: boolean;
}

/** Coerce a persisted rawPayload jsonb into a plain record (or empty). */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Rehydrate + validate a persisted payment-event row into a
 * NormalizedStripeBookEvent using ONLY PCI-safe fields. Returns null (with a
 * caller-logged reason) when the row cannot form a valid normalized event.
 */
function rehydrateNormalizedEvent(
  row: typeof bookPaymentEvents.$inferSelect,
  effectsPaused: boolean,
): { ok: true; event: NormalizedStripeBookEvent } | { ok: false; reason: string } {
  if (!row.providerEventId) {
    return { ok: false, reason: "missing providerEventId" };
  }
  const rp = asRecord(row.rawPayload);
  const piid = rp["_paymentIntentId"];
  const candidate = {
    providerEventId: row.providerEventId,
    eventType: row.eventType,
    paymentIntentId: typeof piid === "string" ? piid : undefined,
    amountCents: row.amountCents ?? undefined,
    currency: row.currency ?? undefined,
    checkoutSessionIdFromMeta:
      typeof rp["_checkoutSessionIdFromMeta"] === "string"
        ? (rp["_checkoutSessionIdFromMeta"] as string)
        : null,
    orderNumberFromMeta:
      typeof rp["_orderNumberFromMeta"] === "string"
        ? (rp["_orderNumberFromMeta"] as string)
        : null,
    refundedAmountCentsCumulative:
      typeof rp["_refundedAmountCentsCumulative"] === "number"
        ? (rp["_refundedAmountCentsCumulative"] as number)
        : null,
    disputeOutcome:
      rp["_disputeOutcome"] === "won" || rp["_disputeOutcome"] === "lost"
        ? (rp["_disputeOutcome"] as "won" | "lost")
        : null,
    effectsPaused,
    rawPayload: rp,
  };
  const parsed = normalizedStripeBookEventSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues
        .map((i) => `${i.path.join(".") || "_"}: ${i.message}`)
        .join("; ")
        .slice(0, 500),
    };
  }
  return { ok: true, event: parsed.data };
}

/**
 * Drive pending (processedAt NULL) verified Stripe book events to completion.
 * Restart-safe and bounded. See section header for the invariants.
 */
export async function replayPendingVerifiedBookEvents(
  raw: z.infer<typeof replayPendingVerifiedBookEventsSchema>,
): Promise<ReplayPendingVerifiedBookEventsResult> {
  const input = replayPendingVerifiedBookEventsSchema.parse(raw);

  // 1. Read-only listing in its OWN short query — no applicator/vendor call
  //    happens here. We fetch the raw rows, then close this query.
  const rows = await withDbAttribution(
    bookCommerceLabel("webhook-replay-list"),
    async () => {
      const db = getDb();
       const basePredicate = and(
         eq(bookPaymentEvents.provider, "stripe"),
         isNull(bookPaymentEvents.processedAt),
          input.paymentEventId
            ? eq(bookPaymentEvents.id, input.paymentEventId)
            : undefined,
       );
       const predicate = input.onlyPaused
         ? and(
             basePredicate,
             sql`${bookPaymentEvents.rawPayload}->'_durableState'->>'kind' = 'paused'`,
           )
         : basePredicate;
       return db
        .select()
        .from(bookPaymentEvents)
         .where(predicate)
        .orderBy(bookPaymentEvents.createdAt)
        .limit(input.limit);
    },
  );

  const result: ReplayPendingVerifiedBookEventsResult = {
    attempted: rows.length,
    processed: 0,
    needsReconciliation: 0,
    errors: [],
    moreLikely: input.paymentEventId ? false : rows.length === input.limit,
  };

  // 2. Apply ONE event at a time, OUTSIDE the listing query. Each call owns its
  //    own transaction inside the applicator. A malformed row is recorded as an
  //    error and left unprocessed; a thrown applicator error is likewise
  //    captured so a single bad event never aborts the whole bounded pass.
  for (const row of rows) {
    const rehydrated = rehydrateNormalizedEvent(row, input.effectsPaused);
    if (!rehydrated.ok) {
      result.errors.push({ providerEventId: row.providerEventId, reason: rehydrated.reason });
      await markReplayException(row.id, rehydrated.reason);
      continue;
    }
    try {
      const applied = await applyVerifiedBookWebhookEvent(rehydrated.event);
      // markedProcessed is the authoritative signal: true only when the
      // applicator set processedAt (clean path or already-processed replay).
      // Every reconciliation/retry return (unmatched, paused, mismatch,
      // no-contact) leaves processedAt NULL and counts as needs-reconciliation.
      if (applied.markedProcessed) {
        result.processed += 1;
      } else {
        result.needsReconciliation += 1;
      }
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      result.errors.push({
        providerEventId: row.providerEventId,
        reason,
      });
      await markReplayException(row.id, reason);
    }
  }

  return result;
}

/** Keep replay failures durable and out of the automatic paused-event lane. */
async function markReplayException(eventId: string, reason: string): Promise<void> {
  const note = JSON.stringify({ kind: "exception", detail: reason.slice(0, 500) });
  await withDbAttribution(
    bookCommerceLabel("webhook-replay-exception"),
    async () => {
      await getDb()
        .update(bookPaymentEvents)
        .set({
          rawPayload: sql`jsonb_set(COALESCE(raw_payload,'{}'), '{_durableState}', ${note}::jsonb, true)`,
        })
        .where(and(
          eq(bookPaymentEvents.id, eventId),
          isNull(bookPaymentEvents.processedAt),
        ));
    },
  );
}
