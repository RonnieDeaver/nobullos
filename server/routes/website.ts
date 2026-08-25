// Task #3740 — public intake endpoint for the marketing website forms
// (contact form at homepage #contact, unsubscribe form on /unsubscribe/).
// Unauthenticated by design (visitors are anonymous), defended by:
//   - per-IP rate limit (6/min, matching the repo's public-endpoint pattern)
//   - zod validation with hard length caps
//   - honeypot field ("website") that silently succeeds without storing
// Successful submissions are stored in website_inquiries and fanned out to
// the responsible admins through the existing in-app notification path.

import type { Express } from "express";
import rateLimit, { MemoryStore } from "express-rate-limit";
import { z } from "zod";
import { cleanAttribution, publicAttributionSchema } from "@shared/schema";
import { storage } from "../storage";
import { registerModuleStateResetForTest } from "../services/moduleStateReset";
import {
  getPublicRecaptchaSiteKey,
  verifyRecaptchaToken,
  type RecaptchaVerificationResult,
} from "../services/recaptcha";
import {
  kickWebsiteInquirySlackRelay,
  type WebsiteInquirySlackArgs,
  type WebsiteInquirySlackResult,
} from "../services/websiteInquirySlackRelay";
import {
  getMarketingHostnames,
  requestHostname,
} from "../website/marketingSite";

// Explicit store so the between-suite reset seam below can clear it — the
// batched test runner hosts several suites in one process, and hit counts
// carried across suites would 429 a sibling's legitimate inquiry POSTs.
const inquiryLimiterStore = new MemoryStore();
const inquiryLimiter = rateLimit({
  windowMs: 60_000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  store: inquiryLimiterStore,
  message: { error: "Too many requests. Please try again in a minute." },
});

/** Test-only seam used when one focused suite intentionally exercises more
 * than the six-request production window. Production never calls this. */
export function __resetWebsiteInquiryLimiterForTest(): void {
  void inquiryLimiterStore.resetAll();
}

// No-op outside NODE_ENV=test (see server/services/moduleStateReset.ts).
registerModuleStateResetForTest(
  "websiteInquiryLimiter",
  __resetWebsiteInquiryLimiterForTest,
);

const inquirySchema = z.object({
  kind: z.enum(["contact", "unsubscribe"]),
  fullName: z.string().trim().max(200).optional().default(""),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().max(40).optional().default(""),
  message: z.string().trim().max(5000).optional().default(""),
  page: z.string().trim().max(300).optional().default(""),
  // Honeypot — humans never fill this (visually hidden field).
  website: z.string().max(500).optional().default(""),
  // Contact-only Google reCAPTCHA response. Unsubscribe submissions do not
  // render or require reCAPTCHA and this optional field is ignored there.
  recaptchaToken: z.string().trim().max(2048).optional().default(""),
  // Task #4337 — optional first-touch attribution forwarded by the site
  // client (write-once localStorage record). Additive + hard-capped:
  // validation is not weakened, and requests without them stay valid.
  ...publicAttributionSchema.shape,
});

export interface WebsiteRouteDeps {
  getRecaptchaSiteKey: () => string | null;
  verifyRecaptcha: (args: {
    token: string;
    remoteIp?: string | null;
    expectedHostnames: readonly string[];
  }) => Promise<RecaptchaVerificationResult>;
  kickContactSlackRelay: (
    args: WebsiteInquirySlackArgs,
  ) => Promise<WebsiteInquirySlackResult>;
}

const defaultWebsiteRouteDeps: WebsiteRouteDeps = {
  getRecaptchaSiteKey: getPublicRecaptchaSiteKey,
  verifyRecaptcha: verifyRecaptchaToken,
  kickContactSlackRelay: kickWebsiteInquirySlackRelay,
};

const RECAPTCHA_DIAGNOSTIC_COOLDOWN_MS = 5 * 60_000;
let lastRecaptchaConfigurationDiagnosticAt = 0;

function warnRecaptchaConfiguration(issue: string): void {
  const now = Date.now();
  if (
    now - lastRecaptchaConfigurationDiagnosticAt <
    RECAPTCHA_DIAGNOSTIC_COOLDOWN_MS
  ) {
    return;
  }
  lastRecaptchaConfigurationDiagnosticAt = now;
  console.warn(
    `[WebsiteInquiry] reCAPTCHA configuration ${issue}. Set RECAPTCHA_SITE_KEY and RECAPTCHA_SECRET_KEY in Replit Secrets, then allow the production marketing and Replit preview hostnames in Google reCAPTCHA.`,
  );
}

function recaptchaAllowedHostnames(): string[] {
  const deploymentHosts = (process.env.REPLIT_DOMAINS || "").split(",");
  const developmentHosts =
    process.env.NODE_ENV === "production"
      ? []
      : [process.env.REPLIT_DEV_DOMAIN || "", "127.0.0.1", "localhost"];
  return Array.from(
    new Set(
      [...getMarketingHostnames(), ...deploymentHosts, ...developmentHosts]
        .map((hostname) =>
          hostname
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/:\d+$/, "")
            .replace(/\.$/, ""),
        )
        .filter(Boolean),
    ),
  ).slice(0, 32);
}

function recaptchaFailureResponse(reason: RecaptchaVerificationResult): {
  status: number;
  error: string;
} {
  if (reason.ok) {
    return { status: 500, error: "Unexpected security verification state." };
  }
  if (reason.reason === "missing_token") {
    return {
      status: 400,
      error: "Please complete the security check and try again.",
    };
  }
  if (
    reason.reason === "invalid_or_expired" ||
    reason.reason === "hostname_mismatch"
  ) {
    return {
      status: 403,
      error:
        "We couldn’t verify the security check. Please refresh it and try again.",
    };
  }
  if (reason.reason === "timeout") {
    return {
      status: 503,
      error:
        "Security verification took too long. Please refresh it and try again.",
    };
  }
  return {
    status: 503,
    error:
      "Security verification is temporarily unavailable. Please try again shortly.",
  };
}

export function registerWebsiteRoutes(
  app: Express,
  overrides: Partial<WebsiteRouteDeps> = {},
): void {
  const deps: WebsiteRouteDeps = {
    ...defaultWebsiteRouteDeps,
    ...overrides,
  };

  // Public by design: the browser receives exactly one bounded public value.
  // RECAPTCHA_SECRET_KEY is read only inside the server-side verifier.
  app.get("/api/website/inquiry/config", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const recaptchaSiteKey = deps.getRecaptchaSiteKey();
    if (!recaptchaSiteKey) {
      warnRecaptchaConfiguration("is missing its public site key");
    }
    return res.json({ recaptchaSiteKey });
  });

  app.post("/api/website/inquiry", inquiryLimiter, async (req, res) => {
    try {
      const parsed = inquirySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Please check the form fields and try again." });
      }
      const d = parsed.data;

      // Honeypot tripped: pretend success so bots learn nothing.
      if (d.website) return res.json({ ok: true });

      if (d.kind === "contact" && (!d.fullName || !d.phone || !d.message)) {
        return res
          .status(400)
          .json({ error: "Full name, phone, and message are required." });
      }

      const sourceHost = requestHostname(req);
      if (d.kind === "contact") {
        const verification = await deps.verifyRecaptcha({
          token: d.recaptchaToken,
          remoteIp: req.ip,
          // Never derive this trust boundary from Host/X-Forwarded-Host:
          // callers control those headers. Google's verified hostname must
          // belong to this deployment's configured marketing/domain set.
          expectedHostnames: recaptchaAllowedHostnames(),
        });
        if (!verification.ok) {
          if (verification.reason === "misconfigured") {
            warnRecaptchaConfiguration(
              "is missing a key or Google rejected the configured key pair",
            );
          } else {
            console.warn(
              `[WebsiteInquiry] reCAPTCHA verification failed (${verification.reason})`,
            );
          }
          const failure = recaptchaFailureResponse(verification);
          return res.status(failure.status).json({ error: failure.error });
        }
      }

      // Task #4337 — raw first-touch attribution as captured ("" → NULL);
      // normalization into a lead source happens at promotion time.
      const attribution = cleanAttribution(d);

      const inquiry = await storage.createWebsiteInquiry({
        kind: d.kind,
        fullName: d.fullName || null,
        email: d.email,
        phone: d.phone || null,
        message: d.message || null,
        sourcePage: d.page || null,
        sourceHost: sourceHost || null,
        userAgent:
          String(req.headers["user-agent"] || "").slice(0, 300) || null,
        utmSource: attribution.utmSource,
        utmMedium: attribution.utmMedium,
        utmCampaign: attribution.utmCampaign,
        utmTerm: attribution.utmTerm,
        utmContent: attribution.utmContent,
        referrer: attribution.referrer,
      });

      // Contact-only, one-attempt Slack notification. The row above is the
      // durable system of record; this promise never changes the HTTP outcome
      // and is deliberately not retried after an uncertain post failure.
      if (d.kind === "contact") {
        try {
          void deps.kickContactSlackRelay({
            inquiryId: inquiry.id,
            fullName: d.fullName,
            email: d.email,
            phone: d.phone,
            message: d.message,
            sourcePage: d.page || null,
            sourceHost: sourceHost || null,
          });
        } catch {
          console.warn(
            `[WebsiteInquiry] Slack relay did not start for stored inquiry ${inquiry.id}`,
          );
        }
      }

      // Task #4334 — unsubscribe requests feed the global outbound-email
      // suppression list (enforced on every send path) via the shared
      // side-effect helper, which also eagerly cancels any active sequence
      // enrollments + pending approval drafts for the address (Task #4335).
      // Best-effort here: the inquiry row is already stored, and the
      // send-time suppression check plus admin view make a missed upsert
      // recoverable.
      if (d.kind === "unsubscribe") {
        try {
          const { addEmailSuppressionWithSideEffects } = await import(
            "../services/outboundEmail"
          );
          await addEmailSuppressionWithSideEffects({
            email: d.email,
            reason: "unsubscribe",
            source: "website_unsubscribe",
            cancelNote: "Unsubscribe request via website form",
          });
        } catch (suppressErr) {
          console.error(
            "[WebsiteInquiry] suppression upsert failed (unsubscribe intake):",
            suppressErr,
          );
        }
      }

      // Task #4330 — promote contact inquiries into first-class lead
      // records (match-or-create against clients/contacts, stamp source,
      // link the inquiry row). Best-effort: the public form must never
      // fail because promotion did, and the notification flow below stays
      // untouched either way.
      if (d.kind === "contact") {
        try {
          const { promoteWebsiteInquiryToLead } = await import(
            "../services/leadIntake"
          );
          await promoteWebsiteInquiryToLead(inquiry);
        } catch (leadErr) {
          console.error(
            "[WebsiteInquiry] lead promotion failed (inquiry stored, continuing):",
            leadErr,
          );
        }
      }

      // Notify the team (best-effort — the inquiry is already stored).
      try {
        const { notifyUser } = await import(
          "../services/notifications/userInbox"
        );
        const { getResponsibleAdminsForAlert } = await import(
          "../services/notifications/recipients"
        );
        const admins = await getResponsibleAdminsForAlert();
        const title =
          d.kind === "unsubscribe"
            ? "Website unsubscribe request"
            : "New website inquiry";
        const body =
          d.kind === "unsubscribe"
            ? `${d.email} asked to be unsubscribed from all NoBull Marketing emails.`
            : `${d.fullName} (${d.email}, ${d.phone}) sent a message via the marketing website: "${d.message.slice(0, 300)}"`;
        for (const adminId of admins) {
          try {
            await notifyUser(adminId, {
              category: "system",
              title,
              body,
              metadata: {
                source: "marketing_website",
                inquiryId: inquiry.id,
                kind: d.kind,
              },
            });
          } catch (notifyErr) {
            console.error(
              `[WebsiteInquiry] notify failed for admin ${adminId}:`,
              notifyErr,
            );
          }
        }
      } catch (dispatchErr) {
        console.error(
          "[WebsiteInquiry] notification dispatch failed:",
          dispatchErr,
        );
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error("[WebsiteInquiry] failed to store inquiry:", err);
      return res
        .status(500)
        .json({ error: "Something went wrong. Please try again." });
    }
  });
}
