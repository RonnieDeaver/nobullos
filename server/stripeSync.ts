import { StripeSync, runMigrations } from "stripe-replit-sync";
import {
  constructStripeWebhookEvent,
  getStripeSecretKey,
  STRIPE_API_VERSION,
} from "./stripeClient";
import { auditOutboundCall } from "./services/externalCallAudit";
import { createHash } from "node:crypto";
import type { NormalizedStripeBookEvent } from "./storage/bookCheckoutEngineStorage";

let syncInstance: StripeSync | null = null;

export function getStripeSync(): StripeSync | null {
  return syncInstance;
}

export async function getStripeSyncAsync(): Promise<StripeSync | null> {
  if (syncInstance) return syncInstance;
  const key = await getStripeSecretKey();
  if (!key) return null;
  syncInstance = new StripeSync({
    poolConfig: {
      connectionString: process.env.DATABASE_URL!,
      max: 3,
    },
    stripeSecretKey: key,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
    // Task #1590 — pin the sync library's internal Stripe client to the
    // same API version as our own clients (shared constant) so webhook
    // ingestion/backfill reads and app code can't skew.
    stripeApiVersion: STRIPE_API_VERSION,
  });
  return syncInstance;
}

export function resetStripeSyncInstance(): void {
  syncInstance = null;
}

export async function initializeStripeSync(): Promise<void> {
  const sync = await getStripeSyncAsync();
  if (!sync) {
    console.log("[StripeSync] No Stripe secret key configured, skipping sync initialization");
    return;
  }

  try {
    console.log("[StripeSync] Running migrations...");
    await runMigrations({
      databaseUrl: process.env.DATABASE_URL!,
    });
    console.log("[StripeSync] Migrations complete");

    console.log("[StripeSync] Starting initial backfill...");
    const backfillObjects = [
      "customer",
      "subscription",
      "invoice",
      "charge",
      "payment_intent",
      "payment_method",
      "product",
      "price",
    ] as const;
    for (const object of backfillObjects) {
      await auditOutboundCall(
        {
          integration: "stripe",
          endpoint: `/v1/${object}s`,
          method: "GET",
          dedupeParams: { op: "syncBackfill", object },
          callerLabel: `stripe:syncBackfill:${object}`,
        },
        async () => {
          await sync.syncBackfill({ object });
          return { value: undefined as void, statusCode: 200 };
        },
      );
    }
    console.log("[StripeSync] Initial backfill complete");
  } catch (error: any) {
    console.error("[StripeSync] Initialization error:", error.message);
  }
}

// ─── Book webhook event types ─────────────────────────────────────────────────

/**
 * Supported Stripe event types dispatched to the book-commerce storage layer.
 * Any event not in this set is a sync-only no-op (generic sync still processes it).
 */
const BOOK_EVENT_TYPES = new Set([
  "payment_intent.processing",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const);

type BookEventType =
  | "payment_intent.processing"
  | "payment_intent.succeeded"
  | "payment_intent.payment_failed"
  | "payment_intent.canceled"
  | "charge.refunded"
  | "charge.dispute.created"
  | "charge.dispute.closed";

function isBookEventType(t: string): t is BookEventType {
  return BOOK_EVENT_TYPES.has(t as BookEventType);
}

// ─── Verification test seam ───────────────────────────────────────────────────

/**
 * Injectable constructEvent function for zero-egress signed-event tests.
 * In production, uses the real Stripe SDK constructEvent.
 * Tests can inject a custom verifier via __setWebhookVerifierForTest.
 *
 * The seam accepts the same signature as stripe.webhooks.constructEvent
 * but is synchronous (matching the SDK's sync API).
 */
export type WebhookVerifierFn = (
  payload: string | Buffer,
  signature: string,
  secret: string,
) => unknown;

let _webhookVerifierForTest: WebhookVerifierFn | null = null;

/**
 * Test seam: inject a custom webhook event verifier/constructor.
 * Pass null to restore production SDK behaviour.
 * Production code never calls this.
 */
export function __setWebhookVerifierForTest(fn: WebhookVerifierFn | null): void {
  _webhookVerifierForTest = fn;
}

// ─── Book event normalizer ────────────────────────────────────────────────────

/**
 * Extract PCI-safe fields from a verified Stripe event object.
 * No body/secret/address/card data is forwarded — only:
 *   - Stripe event ID (providerEventId)
 *   - Event type
 *   - PaymentIntent ID (from PI or from charge's payment_intent field)
 *   - Amount in cents, currency, status
 *   - Trusted book_checkout_session_id metadata
 *   - Cumulative refund amount (charge.refunded only)
 *   - Dispute outcome (charge.dispute.closed only)
 *
 * Returns null if the event cannot be safely normalized (missing required IDs).
 */
function normalizeBookEvent(event: any): NormalizedStripeBookEvent | null {
  const eventType: string = event.type ?? "";
  const obj = event.data?.object;
  if (!obj) return null;

  let paymentIntentId: string | null = null;
  let amountCents: number = 0;
  let currency: string = "usd";
  let checkoutSessionIdFromMeta: string | null = null;
  let orderNumberFromMeta: string | null = null;
  let disputeOutcome: "won" | "lost" | null = null;
  // For charge.refunded: cumulative refunded amount from Stripe.
  let refundCumulativeAmountCents: number | null = null;

  switch (eventType as BookEventType) {
    case "payment_intent.processing":
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
    case "payment_intent.canceled": {
      // obj is a PaymentIntent
      paymentIntentId = typeof obj.id === "string" ? obj.id : null;
      amountCents = typeof obj.amount === "number" ? obj.amount : 0;
      currency = typeof obj.currency === "string" ? obj.currency : "usd";
      checkoutSessionIdFromMeta =
        typeof obj.metadata?.book_checkout_session_id === "string"
          ? obj.metadata.book_checkout_session_id
          : null;
      orderNumberFromMeta =
        typeof obj.metadata?.order_number === "string"
          ? obj.metadata.order_number
          : null;
      break;
    }
    case "charge.refunded": {
      // obj is a Charge
      paymentIntentId =
        typeof obj.payment_intent === "string" ? obj.payment_intent : null;
      amountCents = typeof obj.amount === "number" ? obj.amount : 0;
      currency = typeof obj.currency === "string" ? obj.currency : "usd";
      // Cumulative refund amount: amount_refunded from the charge (not the refund sub-object).
      refundCumulativeAmountCents =
        typeof obj.amount_refunded === "number" ? obj.amount_refunded : 0;
      // Extract metadata from the associated PaymentIntent metadata if present.
      // Charges may not carry PI metadata directly; use payment_intent id for lookup.
      checkoutSessionIdFromMeta =
        typeof obj.metadata?.book_checkout_session_id === "string"
          ? obj.metadata.book_checkout_session_id
          : null;
      orderNumberFromMeta =
        typeof obj.metadata?.order_number === "string"
          ? obj.metadata.order_number
          : null;
      break;
    }
    case "charge.dispute.created":
    case "charge.dispute.closed": {
      // obj is a Dispute
      paymentIntentId =
        typeof obj.payment_intent === "string" ? obj.payment_intent : null;
      amountCents = typeof obj.amount === "number" ? obj.amount : 0;
      currency = typeof obj.currency === "string" ? obj.currency : "usd";
      if (eventType === "charge.dispute.closed") {
        const outcome: string = obj.status ?? "";
        disputeOutcome = outcome === "won" ? "won" : outcome === "lost" ? "lost" : null;
      }
      // Dispute objects don't carry PI metadata; checkoutSessionId resolved
      // by the applicator via PI binding fallback.
      break;
    }
    default:
      return null;
  }

  if (!paymentIntentId) return null;

  // Build PCI-safe payload: only ids/type/amount/currency/status and
  // trusted metadata. NO body content, NO addresses, NO card data.
  const safePayload: Record<string, unknown> = {
    event_id: event.id,
    event_type: eventType,
    payment_intent_id: paymentIntentId,
    amount_cents: amountCents,
    currency,
    book_checkout_session_id: checkoutSessionIdFromMeta,
    ...(refundCumulativeAmountCents !== null
      ? { refund_cumulative_amount_cents: refundCumulativeAmountCents }
      : {}),
    ...(disputeOutcome !== null ? { dispute_outcome: disputeOutcome } : {}),
  };

  return {
    providerEventId: event.id as string,
    eventType: eventType as BookEventType,
    paymentIntentId,
    amountCents,
    currency,
    checkoutSessionIdFromMeta: checkoutSessionIdFromMeta ?? null,
    orderNumberFromMeta: orderNumberFromMeta ?? null,
    refundedAmountCentsCumulative: refundCumulativeAmountCents,
    disputeOutcome: disputeOutcome ?? null,
    // Default false; the dispatcher/façade overwrites this authoritatively
    // from the book_payment_processing kill switch.
    effectsPaused: false,
    rawPayload: safePayload,
  };
}

// Test seam: expose the normalizer for hostile/unit tests without going
// through the full signed-webhook path. Production code uses processStripeWebhook.
export const __test = {
  normalizeBookEvent,
  isBookEventType,
};

// ─── Extended processStripeWebhook ────────────────────────────────────────────

/**
 * Canonical POST webhook handler.
 *
 * Processing order (all steps must complete; step failure is logged but does
 * NOT suppress later steps):
 *
 *   1. Verify exact raw bytes + stripe-signature using SDK constructEvent
 *      with STRIPE_WEBHOOK_SECRET BEFORE any routing. A verification failure
 *      throws immediately — nothing downstream runs.
 *
 *   2. Pass payload + signature to stripe-replit-sync (existing generic sync
 *      behaviour — always active, unaffected by kill switches).
 *
 *   3. If the event type is a supported book event type, normalize to a
 *      PCI-safe NormalizedStripeBookEvent and dispatch to
 *      applyVerifiedStripeBookEvent. The book_payment_processing kill switch
 *      controls effectsPaused — even when paused, the storage call is made
 *      so the payment event row is durably recorded.
 *
 *   4. Unknown / non-book event types: sync-only no-op (step 2 handles them).
 *
 * IMPORTANT: No webhook secret, no raw body content, no address/card data
 * is forwarded to the storage layer. Only PCI-safe ids/type/amount/currency/
 * status and trusted metadata from the verified event object.
 */
export async function processStripeWebhook(payload: string | Buffer, signature: string): Promise<void> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // ── Step 1: Signature verification (raw bytes, BEFORE any routing) ──────────
  //
  // Must use exact raw bytes (Buffer). Never use parsed/re-serialized body.
  // A missing or invalid STRIPE_WEBHOOK_SECRET is a hard error — we cannot
  // safely process any webhook without a secret.

  const buf = typeof payload === "string" ? Buffer.from(payload) : payload;

  if (!webhookSecret) {
    throw new Error(
      "[StripeWebhook] STRIPE_WEBHOOK_SECRET is not configured — " +
        "cannot verify webhook signatures. Configure it before enabling webhooks.",
    );
  }

  let verifiedEvent: any;
  if (_webhookVerifierForTest !== null) {
    // Test seam: use injected verifier (allows zero-egress signed-event tests).
    verifiedEvent = _webhookVerifierForTest(buf, signature, webhookSecret);
  } else {
    // Production: verify inside the sole Stripe SDK owner.
    verifiedEvent = await constructStripeWebhookEvent(buf, signature, webhookSecret);
  }

  // ── Step 2: Generic stripe-replit-sync processing (always active) ───────────
  const payloadHash = createHash("sha256").update(buf).digest("hex").slice(0, 64);

  const sync = await getStripeSyncAsync();
  if (!sync) {
    // If sync is not initialized, we still verified the signature — log and
    // continue to step 3 (book dispatch) if applicable. Sync unavailability
    // should not suppress book event recording.
    console.warn("[StripeSync] Sync instance not available — skipping generic sync processing");
  } else {
    await auditOutboundCall(
      {
        integration: "stripe",
        endpoint: "/v1/webhooks/process",
        method: "POST",
        dedupeParams: { op: "processWebhook", payloadHash },
        callerLabel: "stripe:processWebhook",
      },
      async () => {
        await sync.processWebhook(payload, signature);
        return {
          value: undefined as void,
          statusCode: 200,
          responseSizeBytes: buf.byteLength,
          responseHash: payloadHash,
        };
      },
    );
  }

  // ── Step 3: Book event dispatch ──────────────────────────────────────────────
  const eventType: string = verifiedEvent?.type ?? "";

  if (!isBookEventType(eventType)) {
    // Non-book event: sync-only no-op. Already processed above.
    return;
  }

  const normalized = normalizeBookEvent(verifiedEvent);
  if (!normalized) {
    // A SUPPORTED book event that we cannot normalize after signature
    // verification is an actionable problem — the payload shape is wrong or a
    // required ID (paymentIntentId) is missing. We MUST NOT swallow it: throw
    // so Stripe retries and the exception surfaces. (Non-book events already
    // returned above as sync-only no-ops.)
    throw new Error(
      `[StripeWebhook] Supported book event ${eventType} (id=${verifiedEvent?.id}) ` +
        "failed normalization — missing paymentIntentId or malformed payload.",
    );
  }

  // Determine effectsPaused from the book_payment_processing kill switch.
  // Import lazily to avoid circular-dep risk during module init.
  const { isKillSwitchEnabled } = await import("./services/killSwitches");
  const effectsPaused = isKillSwitchEnabled("book_payment_processing");

  if (effectsPaused) {
    console.log(
      `[StripeWebhook] book_payment_processing kill switch active — ` +
        `dispatching event ${eventType} (${verifiedEvent.id}) to storage with effectsPaused=true`,
    );
  }

  try {
    const { applyVerifiedStripeBookEvent } = await import(
      "./storage/bookCheckoutEngineStorage"
    );
    const result = await applyVerifiedStripeBookEvent(normalized, { effectsPaused });
    // Paid-content delivery is strictly independent from qualification,
    // appointments, and GHL. This is intentionally post-commit: Stripe's
    // authoritative commerce transaction must not be rolled back by a mailbox
    // outage. The delivery service uses deterministic link+email keys, so
    // every webhook replay safely heals a missed post-commit kick.
    if (!effectsPaused && result.order) {
      try {
        const { kickBookPaidDeliverySafe, revokeDeliveryForOrder } = await import(
          "./services/bookDelivery"
        );
        // Repeat this on every replay of a terminal reversal. The entitlement
        // write is replay-safe, but this separate post-commit credential
        // invalidation must also heal a crash after the commerce transaction.
        if (
          result.entitlementsRevoked.length > 0 ||
          result.order.status === "refunded" ||
          result.order.status === "disputed"
        ) {
          await revokeDeliveryForOrder(result.order.id, "payment_reversed");
        }
        await kickBookPaidDeliverySafe(result.order.id);
      } catch (deliveryError) {
        console.error(
          "[StripeWebhook] paid-book delivery kick failed:",
          deliveryError instanceof Error ? deliveryError.message : "unknown",
        );
      }
    }
  } catch (err: any) {
    // Book dispatch errors are logged but MUST NOT suppress the generic sync
    // outcome already committed in step 2. Re-throw so the route can return
    // an appropriate status and trigger Stripe's retry logic.
    console.error(
      `[StripeWebhook] applyVerifiedStripeBookEvent failed for event ` +
        `${eventType} (${verifiedEvent.id}): ${err?.message ?? err}`,
    );
    throw err;
  }
}
