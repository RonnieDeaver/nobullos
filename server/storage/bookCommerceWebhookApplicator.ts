// @db-pool-intent: ambient
//
// Task #5097 — book-commerce persistence, VERIFIED WEBHOOK APPLICATOR slice.
//
// ONE atomic verified-event applicator. Receives an already signature-verified,
// PCI-sanitized normalized Stripe book event and in ONE DB transaction: records
// the event once (composite unique → replay-safe); short-circuits fully-
// processed replays; when effectsPaused links session + reconciliation_needed
// with no effects; resolves checkout (metadata → PI binding); validates PI
// identity/amount/currency (mismatch → reconciliation_needed + durable); creates
// the order aggregate when evidence supports; applies legal status/lifecycle/
// outbox transitions; sets refundedAmountCents monotonically; grants on
// capture/won-dispute and revokes on full-refund/dispute/lost-dispute (event-
// scoped keys); marks processedAt only on the clean path.
//
// Invariants: replays with processedAt → idempotent no-op; out-of-order
// charge/dispute create the order then transition; deterministic order number
// when metadata lacks one; no vendor/network calls in the transaction; DB
// protocol triggers are never weakened.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bookCheckoutSessions,
  bookContacts,
  bookOrders,
  bookEntitlements,
  bookPaymentEvents,
  isValidBookOrderTransition,
  addressSnapshotSchema,
  type BookOrder,
  type BookOrderStatus,
  type BookCheckoutSession,
  type BookPackageCode,
} from "@shared/schema";
export { addressSnapshotSchema } from "@shared/schema";
export type { AddressSnapshot } from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { requirePackageByCode } from "../services/bookCommerceCatalog";
import { isBookPhysicalFulfillmentActive } from "../services/bookPhysicalFulfillment";
import {
  bookCommerceLabel,
  insertLifecycleEventTx,
  insertOutboxTx,
  createBookOrderInTx,
  IdempotencyConflictError,
  IncompleteAggregateError,
  type TxLike,
  type CreateOrderResult,
} from "./bookCommerceStorage";
import {
  entitlementGrantLifecycleKey,
  entitlementGrantOutboxKey,
  entitlementRevokeLifecycleKey,
  entitlementRevokeOutboxKey,
  orderTransitionLifecycleKey,
  orderTransitionOutboxKey,
} from "./bookCommerceEventStorage";

// ── Event types the applicator handles ────────────────────────────────────────

export const BOOK_WEBHOOK_EVENT_TYPES = [
  "payment_intent.processing",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const;
export type BookWebhookEventType = (typeof BOOK_WEBHOOK_EVENT_TYPES)[number];

// ── Normalized event input ─────────────────────────────────────────────────────

export const normalizedStripeBookEventSchema = z.object({
  /** Stripe event ID for composite dedup. */
  providerEventId: z.string().min(1).max(256),
  eventType: z.enum(BOOK_WEBHOOK_EVENT_TYPES),
  /** PaymentIntent ID (anchor for all supported event types). */
  paymentIntentId: z.string().min(1).max(256),
  /**
   * Amount in cents:
   *   - PI events: the PaymentIntent amount (== original charge total).
   *   - charge.refunded: the ORIGINAL charge total (must equal session total);
   *     the refund figure itself is refundedAmountCentsCumulative.
   *   - charge.dispute.*: the DISPUTED amount (Stripe Dispute.amount), which
   *     may be a partial amount 1..sessionTotal (NOT necessarily the total).
   */
  amountCents: z.number().int().min(0),
  currency: z.string().length(3),
  /** Trusted checkout session ID from PI metadata (pre-verified by caller). */
  checkoutSessionIdFromMeta: z.string().min(1).optional().nullable(),
  /** Server-generated order number from PI metadata. May be absent. */
  orderNumberFromMeta: z.string().min(1).max(64).optional().nullable(),
  /**
   * Cumulative refunded amount in cents as of this event.
   * REQUIRED for charge.refunded; must be >= 1 and <= amountCents (original
   * charge). Never silently clamped — over-charge cumulative is rejected.
   * Stored monotonically — no double-counting.
   */
  refundedAmountCentsCumulative: z.number().int().min(0).optional().nullable(),
  /** won/lost — REQUIRED for charge.dispute.closed. */
  disputeOutcome: z.enum(["won", "lost"]).optional().nullable(),
  /**
   * When true: record event durably, link session, set reconciliation_needed,
   * leave processedAt NULL. Apply NO order/entitlement effects.
   */
  effectsPaused: z.boolean().default(false),
  /** PCI-sanitized payload snapshot for audit. */
  rawPayload: z.record(z.unknown()).optional().nullable(),
})
  .superRefine((v, ctx) => {
    // charge.refunded requires a cumulative refund figure.
    if (v.eventType === "charge.refunded") {
      if (v.refundedAmountCentsCumulative === null || v.refundedAmountCentsCumulative === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["refundedAmountCentsCumulative"],
          message: "refundedAmountCentsCumulative is required for charge.refunded",
        });
      } else {
        if (v.refundedAmountCentsCumulative < 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["refundedAmountCentsCumulative"],
            message: "refundedAmountCentsCumulative must be >= 1 for charge.refunded",
          });
        }
        // Reject over-charge cumulative — do NOT silently clamp.
        if (v.refundedAmountCentsCumulative > v.amountCents) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["refundedAmountCentsCumulative"],
            message: `refundedAmountCentsCumulative (${v.refundedAmountCentsCumulative}) exceeds original charge amountCents (${v.amountCents})`,
          });
        }
      }
    }
    // charge.dispute.closed requires an outcome.
    if (v.eventType === "charge.dispute.closed" && (v.disputeOutcome === null || v.disputeOutcome === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["disputeOutcome"],
        message: "disputeOutcome is required for charge.dispute.closed",
      });
    }
    // Disputes require a positive disputed amount.
    if ((v.eventType === "charge.dispute.created" || v.eventType === "charge.dispute.closed") && v.amountCents < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountCents"],
        message: "disputed amountCents must be >= 1 for dispute events",
      });
    }
  });
export type NormalizedStripeBookEvent = z.infer<typeof normalizedStripeBookEventSchema>;

// ── Applicator result ──────────────────────────────────────────────────────────

export interface ApplyBookWebhookEventResult {
  /** True when a new event row was inserted (not a replay). */
  eventInserted: boolean;
  /** True when the event was already fully processed (processedAt non-null). */
  wasAlreadyProcessed: boolean;
  /**
   * True when this call ended with the event's processedAt set (clean path, or
   * an already-processed replay). False for every reconciliation/retry return
   * (unmatched session, paused, currency/amount mismatch, no-contact). The
   * replay seam uses this as the authoritative processed/needs-reconciliation
   * signal.
   */
  markedProcessed: boolean;
  /** True when effects were skipped because effectsPaused=true. */
  effectsPaused: boolean;
  /** Resolved checkout session (null if unresolvable). */
  session: BookCheckoutSession | null;
  /** Order created or fetched (null if not applicable). */
  order: BookOrder | null;
  /** Status transitioned (null if no transition applied). */
  transitionedTo: BookOrderStatus | null;
  /** Entitlements granted in this application. */
  entitlementsGranted: string[];
  /** Entitlements revoked in this application. */
  entitlementsRevoked: string[];
}

// ── Closed lifecycle/outbox derivation maps ────────────────────────────────────

const ORDER_STATUS_TO_LIFECYCLE: Partial<Record<BookOrderStatus, Parameters<typeof insertLifecycleEventTx>[1]["eventType"]>> = {
  payment_captured: "payment_captured",
  fulfillment_queued: "fulfillment_queued",
  fulfilled: "fulfilled",
  refunded: "refunded",
  partially_refunded: "partially_refunded",
  cancelled: "cancelled",
  disputed: "disputed",
};

// A buyer legitimately holds active entitlements only in these order states.
// Gates grants against late success / won-dispute after terminal refund/cancel.
function isFulfillmentEligible(status: BookOrderStatus): boolean {
  return status === "payment_captured" || status === "fulfillment_queued" || status === "fulfilled";
}

// Every non-initial status maps to its OWN explicit outbox event — never a
// coarse order.created fallback — so downstream work is not duplicated.
const ORDER_STATUS_TO_OUTBOX: Record<Exclude<BookOrderStatus, "pending_payment">, Parameters<typeof insertOutboxTx>[1]["eventType"]> = {
  payment_captured: "order.payment_captured",
  partially_refunded: "order.partially_refunded",
  disputed: "order.disputed",
  fulfillment_queued: "order.fulfillment_queued",
  fulfilled: "order.fulfilled",
  refunded: "order.refunded",
  cancelled: "order.cancelled",
};

// ── Durable state helpers ──────────────────────────────────────────────────────

async function setDurableStateOnEvent(
  tx: TxLike,
  eventId: string,
  kind: "unmatched" | "mismatch" | "exception" | "paused" | "blocked",
  detail: string,
): Promise<void> {
  const note = JSON.stringify({ kind, detail });
  await tx
    .update(bookPaymentEvents)
    .set({
      rawPayload: sql`jsonb_set(COALESCE(raw_payload,'{}'), '{_durableState}', ${note}::jsonb, true)`,
    })
    .where(eq(bookPaymentEvents.id, eventId));
}

async function setSessionReconciliation(
  tx: TxLike,
  sessionId: string,
  note: string,
): Promise<void> {
  const bounded = note.slice(0, 500);
  await tx
    .update(bookCheckoutSessions)
    .set({
      paymentState: "reconciliation_needed",
      reconciliationNote: bounded,
      updatedAt: sql`now()`,
    })
    .where(eq(bookCheckoutSessions.id, sessionId));
}

async function blockInactiveCompleteEvent(
  tx: TxLike,
  input: NormalizedStripeBookEvent,
  session: BookCheckoutSession,
  eventId: string,
  eventInserted: boolean,
): Promise<ApplyBookWebhookEventResult | null> {
  if (
    session.packageCode !== "complete" ||
    isBookPhysicalFulfillmentActive()
  ) {
    return null;
  }

  const canCreateOrGrant =
    input.eventType === "payment_intent.succeeded" ||
    (input.eventType === "charge.dispute.closed" &&
      input.disputeOutcome === "won");
  const canSynthesizeOrder =
    input.eventType === "charge.refunded" ||
    input.eventType === "charge.dispute.created" ||
    input.eventType === "charge.dispute.closed";

  let existingOrder: BookOrder | null = null;
  if (canSynthesizeOrder) {
    const [existing] = await tx
      .select()
      .from(bookOrders)
      .where(eq(bookOrders.checkoutSessionId, session.id))
      .limit(1);
    existingOrder = existing ?? null;
  }

  // Never accept/re-grant an inactive Complete purchase. Negative remediation
  // (refunds and lost disputes) may continue only for an order that already
  // exists; no webhook may synthesize a new Complete order while inactive.
  if (!canCreateOrGrant && (!canSynthesizeOrder || existingOrder)) {
    return null;
  }

  const detail =
    `Complete Collection ${input.eventType} blocked while physical fulfillment is inactive`;
  await setDurableStateOnEvent(tx, eventId, "blocked", detail);
  await setSessionReconciliation(
    tx,
    session.id,
    `${detail}; no order or entitlements created; evt=${input.providerEventId}`,
  );
  return {
    eventInserted,
    wasAlreadyProcessed: false,
    markedProcessed: false,
    effectsPaused: false,
    session,
    order: null,
    transitionedTo: null,
    entitlementsGranted: [],
    entitlementsRevoked: [],
  };
}

// ── Deterministic order number fallback ───────────────────────────────────────

function deterministicOrderNumber(checkoutSessionId: string): string {
  return `WH-${checkoutSessionId.slice(0, 24).toUpperCase()}`;
}

// ── CAS order status transition (explicit closed maps; no unsafe cast) ─────────

async function casTransitionOrder(
  tx: TxLike,
  order: BookOrder,
  to: BookOrderStatus,
  reason: string,
  // Retained for call-site symmetry with grant/revoke; the transition keys are
  // NOT provider-scoped (see idempotency-key comment below).
  _providerEventId: string,
): Promise<{ order: BookOrder; transitioned: boolean }> {
  const from = order.status as BookOrderStatus;
  if (!isValidBookOrderTransition(from, to)) {
    return { order, transitioned: false };
  }
  const [updated] = await tx
    .update(bookOrders)
    .set({ status: to, updatedAt: sql`now()` })
    .where(and(eq(bookOrders.id, order.id), eq(bookOrders.status, from)))
    .returning();
  if (!updated) return { order, transitioned: false };

  const lifecycleType = ORDER_STATUS_TO_LIFECYCLE[to] ?? "manual_correction";
  const outboxType =
    to === "pending_payment" ? "order.created" : ORDER_STATUS_TO_OUTBOX[to];

  // Lifecycle/outbox idempotency keys MUST be EXACTLY
  // order-transition:<orderId>:<from>:<to> — the DB deferred protocol verifier
  // enforces this shape. Provider-event dedupe (the payment-event row's own
  // unique provider id) already prevents duplicate processing, so no provider
  // suffix is appended here.
  await insertLifecycleEventTx(tx, {
    contactId: updated.contactId,
    orderId: updated.id,
    checkoutSessionId: updated.checkoutSessionId,
    eventType: lifecycleType,
    fromStatus: from,
    toStatus: to,
    reason,
    idempotencyKey: orderTransitionLifecycleKey(updated.id, from, to),
  });
  await insertOutboxTx(tx, {
    eventType: outboxType,
    sourceType: "order",
    sourceId: updated.id,
    payload: { orderId: updated.id, fromStatus: from, toStatus: to, reason },
    idempotencyKey: orderTransitionOutboxKey(updated.id, from, to),
  });
  return { order: updated, transitioned: true };
}

// ── Grant entitlements (event-scoped keys prevent won-dispute collisions) ──────

async function grantOrderEntitlements(
  tx: TxLike,
  order: BookOrder,
  providerEventId: string,
): Promise<string[]> {
  const pkg = requirePackageByCode(order.packageCode as BookPackageCode);
  const granted: string[] = [];
  for (const code of pkg.entitlementCodes) {
    const [inserted] = await tx
      .insert(bookEntitlements)
      .values({
        contactId: order.contactId ?? null,
        orderId: order.id,
        packageCode: order.packageCode,
        entitlementCode: code,
        status: "active",
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      await insertLifecycleEventTx(tx, {
        contactId: order.contactId,
        orderId: order.id,
        eventType: "entitlement_granted",
        toStatus: "active",
        metadata: { entitlementCode: code },
        idempotencyKey: `${entitlementGrantLifecycleKey(order.id, code)}:${providerEventId}`,
      });
      await insertOutboxTx(tx, {
        eventType: "entitlement.granted",
        sourceType: "entitlement",
        sourceId: inserted.id,
        payload: { entitlementId: inserted.id, orderId: order.id, entitlementCode: code },
        idempotencyKey: `${entitlementGrantOutboxKey(order.id, code)}:${providerEventId}`,
      });
      granted.push(code);
    }
  }
  return granted;
}

// ── Revoke entitlements (event-scoped keys) ───────────────────────────────────

async function revokeOrderEntitlements(
  tx: TxLike,
  order: BookOrder,
  reason: string,
  providerEventId: string,
): Promise<string[]> {
  const actives = await tx
    .select()
    .from(bookEntitlements)
    .where(
      and(
        eq(bookEntitlements.orderId, order.id),
        eq(bookEntitlements.status, "active"),
      ),
    );
  const revoked: string[] = [];
  for (const ent of actives) {
    const [updated] = await tx
      .update(bookEntitlements)
      .set({ status: "revoked", revokedAt: sql`now()`, revokedReason: reason, updatedAt: sql`now()` })
      .where(and(eq(bookEntitlements.id, ent.id), eq(bookEntitlements.status, "active")))
      .returning();
    if (updated) {
      await insertLifecycleEventTx(tx, {
        contactId: order.contactId,
        orderId: order.id,
        eventType: "entitlement_revoked",
        fromStatus: "active",
        toStatus: "revoked",
        reason,
        metadata: { entitlementCode: ent.entitlementCode },
        idempotencyKey: `${entitlementRevokeLifecycleKey(ent.id)}:${providerEventId}`,
      });
      await insertOutboxTx(tx, {
        eventType: "entitlement.revoked",
        sourceType: "entitlement",
        sourceId: ent.id,
        payload: { entitlementId: ent.id, orderId: order.id, entitlementCode: ent.entitlementCode, reason },
        idempotencyKey: `${entitlementRevokeOutboxKey(ent.id)}:${providerEventId}`,
      });
      revoked.push(ent.entitlementCode);
    }
  }
  return revoked;
}

// ── Ensure order exists (for out-of-order charge/dispute events) ──────────────
// Returns null ONLY for the recoverable "no contact yet" case (retryable).
// createBookOrderInTx converges concurrent same-checkout inserts; a genuine
// conflict throws and is NOT swallowed so Stripe retries.

async function ensureOrder(
  tx: TxLike,
  session: BookCheckoutSession,
  orderNumberFromMeta: string | null | undefined,
): Promise<BookOrder | null> {
  const [existing] = await tx
    .select()
    .from(bookOrders)
    .where(eq(bookOrders.checkoutSessionId, session.id))
    .limit(1);
  if (existing) return existing;

  if (!session.contactId) return null;
  const [contact] = await tx
    .select()
    .from(bookContacts)
    .where(eq(bookContacts.id, session.contactId))
    .limit(1);
  if (!contact) return null;

  const orderNumber = orderNumberFromMeta ?? deterministicOrderNumber(session.id);
  // No try/catch: createBookOrderInTx converges the proven concurrent-order
  // case internally; any thrown error is a real conflict/incomplete aggregate
  // and must propagate to keep the webhook retryable.
  const result: CreateOrderResult = await createBookOrderInTx(
    tx, session, contact, orderNumber, null,
  );
  return result.order;
}

// ── Synthesize pending_payment → payment_captured (idempotent) ────────────────
//
// Used by out-of-order refund/dispute events so the subsequent legal edge has a
// valid predecessor. No-op when the order is already past pending_payment.

async function ensureCaptured(
  tx: TxLike,
  order: BookOrder,
  reason: string,
  providerEventId: string,
): Promise<BookOrder> {
  if (order.status !== "pending_payment") return order;
  const { order: o, transitioned } = await casTransitionOrder(
    tx, order, "payment_captured", reason, providerEventId,
  );
  return transitioned ? o : order;
}

// ── Main applicator ────────────────────────────────────────────────────────────

/**
 * Atomically apply a verified Stripe book webhook event in ONE transaction.
 * Idempotent: safe to call multiple times for the same providerEventId.
 */
export async function applyVerifiedBookWebhookEvent(
  raw: NormalizedStripeBookEvent,
): Promise<ApplyBookWebhookEventResult> {
  const input = normalizedStripeBookEventSchema.parse(raw);
  const piid = input.paymentIntentId;
  const evid = input.providerEventId;

  const applied = await withDbAttribution(bookCommerceLabel("webhook-applicator"), async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      // ── 1. Insert event (composite unique dedup) ───────────────────────────
      // Persist PCI-safe reconstruction fields under reserved `_`-prefixed keys
      // so a later replay can rehydrate the NormalizedStripeBookEvent from the
      // row alone; also enables the replay identity check.
      const insertRawPayload: Record<string, unknown> = {
        ...(input.rawPayload ?? {}),
        _paymentIntentId: piid,
        ...(input.checkoutSessionIdFromMeta != null
          ? { _checkoutSessionIdFromMeta: input.checkoutSessionIdFromMeta }
          : {}),
        ...(input.orderNumberFromMeta != null
          ? { _orderNumberFromMeta: input.orderNumberFromMeta }
          : {}),
        ...(input.eventType === "charge.refunded" && input.refundedAmountCentsCumulative != null
          ? { _refundedAmountCentsCumulative: input.refundedAmountCentsCumulative }
          : {}),
        ...(input.disputeOutcome != null
          ? { _disputeOutcome: input.disputeOutcome }
          : {}),
      };
      const [evtInserted] = await tx
        .insert(bookPaymentEvents)
        .values({
          provider: "stripe",
          providerEventId: evid,
          eventType: input.eventType,
          amountCents: input.amountCents,
          currency: input.currency.toUpperCase(),
          rawPayload: Object.keys(insertRawPayload).length > 0 ? insertRawPayload : null,
        })
        .onConflictDoNothing()
        .returning();

      const eventInserted = !!evtInserted;

      // Fetch persisted row (may already exist on replay).
      const [evtRow] = await tx
        .select()
        .from(bookPaymentEvents)
        .where(
          and(
            eq(bookPaymentEvents.provider, "stripe"),
            eq(bookPaymentEvents.providerEventId, evid),
          ),
        )
        .limit(1);

      if (!evtRow) {
        throw new IncompleteAggregateError(
          `payment event stripe:${evid} missing after upsert`,
        );
      }

      const eventId = evtRow.id;

      // ── 2. Replay short-circuit: already fully processed ──────────────────
      if (!eventInserted && evtRow.processedAt !== null) {
        // Identity check: eventType, amount, currency (and cumulative refund
        // identity where feasible) must match the persisted event exactly.
        // Any divergence is a genuine conflict, NOT a benign replay — record
        // durably then THROW so the caller does not treat it as success.
        const persistedRefund =
          (evtRow.rawPayload as Record<string, unknown> | null)?.["_refundedAmountCentsCumulative"];
        const incomingRefund =
          input.eventType === "charge.refunded"
            ? input.refundedAmountCentsCumulative ?? null
            : null;
        const refundMismatch =
          persistedRefund !== undefined && persistedRefund !== null && incomingRefund !== null &&
          Number(persistedRefund) !== incomingRefund
            ? `refundCumulative ${String(persistedRefund)} != ${incomingRefund}`
            : null;
        const mismatch =
          evtRow.eventType !== input.eventType
            ? `eventType ${evtRow.eventType} != ${input.eventType}`
            : evtRow.amountCents !== input.amountCents
              ? `amountCents ${evtRow.amountCents} != ${input.amountCents}`
              : evtRow.currency !== input.currency.toUpperCase()
                ? `currency ${evtRow.currency} != ${input.currency}`
                : refundMismatch;
        if (mismatch) {
          await setDurableStateOnEvent(tx, eventId, "mismatch", `replay mismatch: ${mismatch}`);
          throw new IdempotencyConflictError(
            "webhook-event-replay",
            evid,
            `processed event replayed with divergent identity: ${mismatch}`,
          );
        }
        const [persistedOrder] = evtRow.orderId
          ? await tx
              .select()
              .from(bookOrders)
              .where(eq(bookOrders.id, evtRow.orderId))
              .limit(1)
          : [];
        return {
          eventInserted: false,
          wasAlreadyProcessed: true,
          markedProcessed: true,
          effectsPaused: false,
          session: null,
          // Preserve the order anchor on a clean replay so independent,
          // post-commit delivery effects can heal after a process crash.
          order: persistedOrder ?? null,
          transitionedTo: null,
          entitlementsGranted: [],
          entitlementsRevoked: [],
        };
      }

      // ── 3. Resolve session ─────────────────────────────────────────────────
      let session: BookCheckoutSession | null = null;

      if (input.checkoutSessionIdFromMeta) {
        const [s] = await tx
          .select()
          .from(bookCheckoutSessions)
          .where(eq(bookCheckoutSessions.id, input.checkoutSessionIdFromMeta))
          .for("update")
          .limit(1);
        session = s ?? null;

        // PI identity: metadata session has a different PI bound → mismatch.
        if (session?.providerSessionId !== null && session?.providerSessionId !== piid) {
          await setDurableStateOnEvent(tx, eventId, "mismatch",
            `PI mismatch: session ${session!.id} bound to ${session!.providerSessionId} != ${piid}`);
          await tx.update(bookPaymentEvents)
            .set({ checkoutSessionId: session!.id })
            .where(and(eq(bookPaymentEvents.id, eventId), isNull(bookPaymentEvents.checkoutSessionId)));
          await setSessionReconciliation(tx, session!.id,
            `PI mismatch: bound=${session!.providerSessionId} event=${piid} evt=${evid}`);
          return {
            eventInserted,
            wasAlreadyProcessed: false,
        markedProcessed: false,
            effectsPaused: false,
            session,
            order: null,
            transitionedTo: null,
            entitlementsGranted: [],
            entitlementsRevoked: [],
          };
        }
      }

      // Fall back to PI binding lookup.
      if (!session) {
        const [s] = await tx
          .select()
          .from(bookCheckoutSessions)
          .where(eq(bookCheckoutSessions.providerSessionId, piid))
          .for("update")
          .limit(1);
        session = s ?? null;
      }

      // ── 4. Unresolvable: durable + leave processedAt NULL for retry ────────
      if (!session) {
        await setDurableStateOnEvent(tx, eventId, "unmatched", `no session for PI ${piid}`);
        // processedAt stays NULL → retryable
        return {
          eventInserted,
          wasAlreadyProcessed: false,
        markedProcessed: false,
          effectsPaused: false,
          session: null,
          order: null,
          transitionedTo: null,
          entitlementsGranted: [],
          entitlementsRevoked: [],
        };
      }

      // Link event to session (idempotent).
      await tx.update(bookPaymentEvents)
        .set({ checkoutSessionId: session.id })
        .where(and(eq(bookPaymentEvents.id, eventId), isNull(bookPaymentEvents.checkoutSessionId)));

      // ── 5. effectsPaused: record + reconciliation; no effects ─────────────
      if (input.effectsPaused) {
        await setDurableStateOnEvent(tx, eventId, "paused", `effects paused at evid=${evid}`);
        await setSessionReconciliation(tx, session.id, `effects_paused evt=${evid}`);
        // processedAt stays NULL → worker will retry when kill-switch lifted.
        return {
          eventInserted,
          wasAlreadyProcessed: false,
        markedProcessed: false,
          effectsPaused: true,
          session,
          order: null,
          transitionedTo: null,
          entitlementsGranted: [],
          entitlementsRevoked: [],
        };
      }

      // ── 6. Currency validation ─────────────────────────────────────────────
      if (session.currency !== input.currency.toUpperCase()) {
        const detail = `currency mismatch: session=${session.currency} event=${input.currency}`;
        await setDurableStateOnEvent(tx, eventId, "mismatch", detail);
        await setSessionReconciliation(tx, session.id, `${detail} evt=${evid}`);
        await tx.update(bookPaymentEvents)
          .set({ checkoutSessionId: session.id })
          .where(eq(bookPaymentEvents.id, eventId));
        return {
          eventInserted,
          wasAlreadyProcessed: false,
        markedProcessed: false,
          effectsPaused: false,
          session,
          order: null,
          transitionedTo: null,
          entitlementsGranted: [],
          entitlementsRevoked: [],
        };
      }

      // ── 7. Amount validation (event-category specific) ────────────────────
      //   - PI processing/succeeded/failed/canceled + charge.refunded:
      //     amountCents == session total (exact; refund figure checked later).
      //   - charge.dispute.*: amountCents is the DISPUTED amount — accept
      //     1..session total, reject over-total.
      const sessionTotal = session.amountTotalCents;
      const isExactTotal =
        input.eventType === "payment_intent.processing" ||
        input.eventType === "payment_intent.succeeded" ||
        input.eventType === "payment_intent.payment_failed" ||
        input.eventType === "payment_intent.canceled" ||
        input.eventType === "charge.refunded";
      const isDispute =
        input.eventType === "charge.dispute.created" ||
        input.eventType === "charge.dispute.closed";

      let amountMismatch: string | null = null;
      if (isExactTotal && input.amountCents !== sessionTotal) {
        amountMismatch = `amount mismatch: session=${sessionTotal} event=${input.amountCents} (expected exact total)`;
      } else if (isDispute && (input.amountCents < 1 || input.amountCents > sessionTotal)) {
        amountMismatch = `disputed amount out of range: session=${sessionTotal} disputed=${input.amountCents} (expected 1..total)`;
      }

      if (amountMismatch) {
        await setDurableStateOnEvent(tx, eventId, "mismatch", amountMismatch);
        await setSessionReconciliation(tx, session.id, `${amountMismatch} evt=${evid}`);
        return {
          eventInserted,
          wasAlreadyProcessed: false,
        markedProcessed: false,
          effectsPaused: false,
          session,
          order: null,
          transitionedTo: null,
          entitlementsGranted: [],
          entitlementsRevoked: [],
        };
      }

      const entitlementsGranted: string[] = [];
      const entitlementsRevoked: string[] = [];
      let transitionedTo: BookOrderStatus | null = null;
      let order: BookOrder | null = null;

      // ── 8. Event-specific effects ──────────────────────────────────────────

      const fulfillmentBlocked = await blockInactiveCompleteEvent(
        tx,
        input,
        session,
        eventId,
        eventInserted,
      );
      if (fulfillmentBlocked) return fulfillmentBlocked;
      const inactiveComplete =
        session.packageCode === "complete" &&
        !isBookPhysicalFulfillmentActive();

      if (input.eventType === "payment_intent.processing") {
        // Automatic-payment-methods interim signal (async bank debits, etc.).
        // Identity/amount/currency already validated like succeeded. Pure
        // payment-state transition: NO order/entitlement/lifecycle/outbox
        // effects. WHERE guard is atomic AND never downgrades a captured/
        // completed session on an out-of-order processing event (no-op then;
        // still marked processed in §9 as stale/no-op).
        await tx.update(bookCheckoutSessions)
          .set({ paymentState: "processing", updatedAt: sql`now()` })
          .where(and(
            eq(bookCheckoutSessions.id, session.id),
            eq(bookCheckoutSessions.status, "pending"),
            inArray(bookCheckoutSessions.paymentState, ["none", "intent_created", "unknown"]),
          ));

      } else if (input.eventType === "payment_intent.succeeded") {
        order = await ensureOrder(tx, session, input.orderNumberFromMeta);
        if (!order) {
          await setDurableStateOnEvent(tx, eventId, "unmatched", `no contact for session ${session.id}`);
          return {
            eventInserted,
            wasAlreadyProcessed: false,
        markedProcessed: false,
            effectsPaused: false,
            session,
            order: null,
            transitionedTo: null,
            entitlementsGranted: [],
            entitlementsRevoked: [],
          };
        }

        await tx.update(bookPaymentEvents)
          .set({ orderId: order.id })
          .where(and(eq(bookPaymentEvents.id, eventId), isNull(bookPaymentEvents.orderId)));

        const { order: o, transitioned } = await casTransitionOrder(
          tx, order, "payment_captured", "payment_intent_succeeded", evid);
        if (transitioned) { order = o; transitionedTo = "payment_captured"; }

        // Grant + capture ONLY when the resulting order is fulfillment-eligible
        // (fresh capture OR idempotent already-eligible). A LATE succeeded after
        // full refund / lost dispute / cancel leaves a terminal non-eligible
        // order: no grant, no checkout overwrite — stale no-op (falls to §9).
        if (isFulfillmentEligible(order.status as BookOrderStatus)) {
          if (!inactiveComplete) {
            const granted = await grantOrderEntitlements(tx, order, evid);
            entitlementsGranted.push(...granted);
          }

          await tx.update(bookCheckoutSessions)
            .set({ paymentState: "captured", status: "completed", completedAt: sql`now()`, updatedAt: sql`now()` })
            .where(eq(bookCheckoutSessions.id, session.id));
        }

      } else if (input.eventType === "payment_intent.payment_failed") {
        // Best-effort: load existing order.
        const [existingOrder] = await tx.select().from(bookOrders)
          .where(eq(bookOrders.checkoutSessionId, session.id)).limit(1);
        order = existingOrder ?? null;

        // Guard: never downgrade a captured/completed session (late failure).
        await tx.update(bookCheckoutSessions)
          .set({ paymentState: "failed", paymentError: `PI ${piid} failed`, updatedAt: sql`now()` })
          .where(and(
            eq(bookCheckoutSessions.id, session.id),
            eq(bookCheckoutSessions.status, "pending"),
            inArray(bookCheckoutSessions.paymentState, ["none", "intent_created", "processing", "unknown"]),
          ));

        if (order) {
          await tx.update(bookPaymentEvents)
            .set({ orderId: order.id })
            .where(and(eq(bookPaymentEvents.id, eventId), isNull(bookPaymentEvents.orderId)));
          const { order: o, transitioned } = await casTransitionOrder(
            tx, order, "cancelled", "payment_failed", evid);
          if (transitioned) { order = o; transitionedTo = "cancelled"; }
        }

      } else if (input.eventType === "payment_intent.canceled") {
        const [existingOrder] = await tx.select().from(bookOrders)
          .where(eq(bookOrders.checkoutSessionId, session.id)).limit(1);
        order = existingOrder ?? null;

        // Guard: never downgrade a captured/completed session (late cancel).
        await tx.update(bookCheckoutSessions)
          .set({ paymentState: "canceled", updatedAt: sql`now()` })
          .where(and(
            eq(bookCheckoutSessions.id, session.id),
            eq(bookCheckoutSessions.status, "pending"),
            inArray(bookCheckoutSessions.paymentState, ["none", "intent_created", "processing", "unknown"]),
          ));

        if (order) {
          await tx.update(bookPaymentEvents)
            .set({ orderId: order.id })
            .where(and(eq(bookPaymentEvents.id, eventId), isNull(bookPaymentEvents.orderId)));
          const { order: o, transitioned } = await casTransitionOrder(
            tx, order, "cancelled", "payment_intent_canceled", evid);
          if (transitioned) { order = o; transitionedTo = "cancelled"; }
        }

      } else if (input.eventType === "charge.refunded") {
        // Out-of-order: create order if absent.
        order = await ensureOrder(tx, session, input.orderNumberFromMeta);
        if (!order) {
          await setDurableStateOnEvent(tx, eventId, "unmatched",
            `charge.refunded: no contact for session ${session.id}`);
          return {
            eventInserted,
            wasAlreadyProcessed: false,
        markedProcessed: false,
            effectsPaused: false,
            session,
            order: null,
            transitionedTo: null,
            entitlementsGranted: [],
            entitlementsRevoked: [],
          };
        }

        await tx.update(bookPaymentEvents)
          .set({ orderId: order.id })
          .where(and(eq(bookPaymentEvents.id, eventId), isNull(bookPaymentEvents.orderId)));

        // Cumulative refund figure (schema guarantees present for this event).
        // amountCents already validated to equal session total, and cumulative
        // validated <= amountCents, so no clamp is needed here.
        const cumulative = input.refundedAmountCentsCumulative ?? input.amountCents;

        // Monotonic SET: only advance, never decrease. Same cumulative → no-op.
        if (cumulative > order.refundedAmountCents) {
          await tx.update(bookOrders)
            .set({ refundedAmountCents: cumulative, updatedAt: sql`now()` })
            .where(and(
              eq(bookOrders.id, order.id),
              sql`refunded_amount_cents < ${cumulative}`,
            ));
          order = { ...order, refundedAmountCents: cumulative };
        }

        const isFullRefund = order.refundedAmountCents >= order.totalAmountCents;

        // Out-of-order: synthesize pending_payment → payment_captured first so
        // the refund transition has a valid predecessor. On a partial refund we
        // then GRANT entitlements (buyer retains access); a subsequent full
        // refund revokes them so no active grant survives.
        order = await ensureCaptured(tx, order, "charge_refund_ooo", evid);

        if (!isFullRefund) {
          // Partial refund: buyer keeps access. Ensure entitlements are granted
          // (idempotent — covers the out-of-order case where succeeded never
          // ran). An inactive Complete boundary still permits the financial
          // remediation below, but must never create physical access.
          if (!inactiveComplete) {
            const granted = await grantOrderEntitlements(tx, order, evid);
            entitlementsGranted.push(...granted);
          }

          const { order: o2, transitioned: t2 } = await casTransitionOrder(
            tx, order, "partially_refunded", "charge_refunded_partial", evid);
          if (t2) { order = o2; transitionedTo = "partially_refunded"; }
        } else {
          // Full refund: transition to refunded and revoke ALL active grants.
          const { order: o2, transitioned: t2 } = await casTransitionOrder(
            tx, order, "refunded", "charge_refunded_full", evid);
          if (t2) { order = o2; transitionedTo = "refunded"; }
          const rev = await revokeOrderEntitlements(tx, order, "full_refund", evid);
          entitlementsRevoked.push(...rev);
        }

      } else if (input.eventType === "charge.dispute.created") {
        order = await ensureOrder(tx, session, input.orderNumberFromMeta);
        if (!order) {
          await setDurableStateOnEvent(tx, eventId, "unmatched",
            `charge.dispute.created: no contact for session ${session.id}`);
          return {
            eventInserted,
            wasAlreadyProcessed: false,
        markedProcessed: false,
            effectsPaused: false,
            session,
            order: null,
            transitionedTo: null,
            entitlementsGranted: [],
            entitlementsRevoked: [],
          };
        }

        await tx.update(bookPaymentEvents)
          .set({ orderId: order.id })
          .where(and(eq(bookPaymentEvents.id, eventId), isNull(bookPaymentEvents.orderId)));

        // Out-of-order: synthesize capture first so payment_captured → disputed
        // is a legal edge. Then converge to disputed with NO active entitlements.
        order = await ensureCaptured(tx, order, "dispute_created_ooo", evid);

        const { order: o, transitioned } = await casTransitionOrder(
          tx, order, "disputed", "dispute_created", evid);
        if (transitioned) { order = o; transitionedTo = "disputed"; }

        const rev = await revokeOrderEntitlements(tx, order, "dispute_created", evid);
        entitlementsRevoked.push(...rev);

      } else if (input.eventType === "charge.dispute.closed") {
        order = await ensureOrder(tx, session, input.orderNumberFromMeta);
        if (!order) {
          await setDurableStateOnEvent(tx, eventId, "unmatched",
            `charge.dispute.closed: no contact for session ${session.id}`);
          return {
            eventInserted,
            wasAlreadyProcessed: false,
        markedProcessed: false,
            effectsPaused: false,
            session,
            order: null,
            transitionedTo: null,
            entitlementsGranted: [],
            entitlementsRevoked: [],
          };
        }

        await tx.update(bookPaymentEvents)
          .set({ orderId: order.id })
          .where(and(eq(bookPaymentEvents.id, eventId), isNull(bookPaymentEvents.orderId)));

        if (input.disputeOutcome === "won") {
          // Won dispute: if never captured (out-of-order), synthesize capture;
          // if currently disputed, restore to payment_captured. Then re-grant
          // entitlements idempotently (event-scoped keys avoid collisions).
          order = await ensureCaptured(tx, order, "dispute_won_ooo", evid);
          if (order.status === "disputed") {
            const { order: o, transitioned } = await casTransitionOrder(
              tx, order, "payment_captured", "dispute_won", evid);
            if (transitioned) { order = o; transitionedTo = "payment_captured"; }
          }
          // Only (re-)grant when fulfilment-eligible (guards won-after-refund).
          if (isFulfillmentEligible(order.status as BookOrderStatus)) {
            const granted = await grantOrderEntitlements(tx, order, evid);
            entitlementsGranted.push(...granted);
          }
        } else {
          // Lost dispute (out-of-order-safe): synthesize the full legal path
          // pending_payment → payment_captured → disputed → refunded so the
          // final transition is always valid. Set full refund before the
          // refunded transition; revoke all active grants.
          order = await ensureCaptured(tx, order, "dispute_lost_ooo", evid);
          if (order.status === "payment_captured") {
            const { order: o, transitioned } = await casTransitionOrder(
              tx, order, "disputed", "dispute_lost_synth", evid);
            if (transitioned) order = o;
          }
          await tx.update(bookOrders)
            .set({ refundedAmountCents: order.totalAmountCents, updatedAt: sql`now()` })
            .where(and(
              eq(bookOrders.id, order.id),
              sql`refunded_amount_cents < ${order.totalAmountCents}`,
            ));
          order = { ...order, refundedAmountCents: order.totalAmountCents };

          const { order: o, transitioned } = await casTransitionOrder(
            tx, order, "refunded", "dispute_lost", evid);
          if (transitioned) { order = o; transitionedTo = "refunded"; }
          const rev = await revokeOrderEntitlements(tx, order, "dispute_lost", evid);
          entitlementsRevoked.push(...rev);
        }
      }

      // ── 9. Mark event fully processed (clean path only) ───────────────────
      await tx.update(bookPaymentEvents)
        .set({ processedAt: sql`now()` })
        .where(eq(bookPaymentEvents.id, eventId));

      return {
        eventInserted,
        wasAlreadyProcessed: false,
        markedProcessed: true,
        effectsPaused: false,
        session,
        order,
        transitionedTo,
        entitlementsGranted,
        entitlementsRevoked,
      };
    });
  });

  // Post-commit kick: any order status transition (payment_captured, refunded,
  // cancelled, …) wrote a book_outbox row the GHL relay must drain. Never
  // throws; deployment boot catch-up recovers a lost kick.
  if (applied.transitionedTo) {
    const { kickGhlOutboundSyncFireAndForget } = await import("../services/ghlOutboundKick");
    kickGhlOutboundSyncFireAndForget();
  }
  return applied;
}
