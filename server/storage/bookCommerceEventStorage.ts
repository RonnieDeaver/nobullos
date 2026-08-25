// @db-pool-intent: ambient
//
// Task #5096 — book-commerce persistence, EVENT slice
// (payment events, order status transitions, entitlement grant/revoke).
//
// Every getDb() call in this module lands on the ambient API pool.
// See scripts/lint-db-pool-tenancy.ts for the contract and server/db.ts
// for the routing.
//
// Invariants owned in the EVENT slice:
//
//   - Payment events dedupe on the composite (provider, provider_event_id).
//     providerEventId is REQUIRED at this boundary so every provider event
//     converges. Optional retention metadata is only settable through a
//     separate focused trusted boundary.
//
//   - Order transitions validate the shared legal-transition map BEFORE any DB
//     mutation (illegal / same-state moves throw). lifecycleEventType and the
//     outbox event type are derived SERVER-SIDE from toStatus — callers never
//     choose arbitrary strings. In one transaction we CAS the status then
//     insert the lifecycle event + outbox row with deterministic keys.
//     A CAS miss returns transitioned: false. No generic financial update path.
//
//   - Entitlement grant requires orderId + packageCode + entitlementCode, and
//     validates entitlement/package compatibility. The active-unique key is
//     (orderId, entitlementCode). Grant and revoke append lifecycle + outbox
//     rows transactionally with deterministic keys; revoke is an active→revoked
//     CAS.

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bookOrders,
  bookCheckoutSessions,
  bookPaymentEvents,
  bookEntitlements,
  bookEntitlementCodes,
  bookOrderStatuses,
  isValidBookOrderTransition,
  type BookOrder,
  type BookOrderStatus,
  type BookPaymentEvent,
  type BookEntitlement,
  type BookLifecycleEvent,
  type BookOutboxEntry,
  type BookLifecycleEventType,
  type BookOutboxEventType,
  type BookPackageCode,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import {
  assertEntitlementCompatible,
  type BookCommercePackageCode,
} from "../services/bookCommerceCatalog";
import {
  bookCommerceLabel,
  insertLifecycleEventTx,
  insertOutboxTx,
  IllegalTransitionError,
  IncompleteAggregateError,
  IdempotencyConflictError,
  OrderNotEligibleForEntitlementError,
} from "./bookCommerceStorage";

/** Order statuses that permit granting an entitlement. */
const ENTITLEMENT_ELIGIBLE_STATUSES: readonly BookOrderStatus[] = [
  "payment_captured",
  "fulfillment_queued",
  "fulfilled",
];

// ═══════════════════════════════════════════════════════════════════════════
// 4. Conflict-safe payment event insert (composite provider + providerEventId)
// ═══════════════════════════════════════════════════════════════════════════

export const insertPaymentEventSchema = z.object({
  orderId: z.string().optional().nullable(),
  checkoutSessionId: z.string().optional().nullable(),
  provider: z.string().min(1).max(64),
  /** REQUIRED so every provider event converges on the composite dedupe key. */
  providerEventId: z.string().min(1).max(256),
  eventType: z.string().min(1).max(128),
  amountCents: z.number().int().min(0).optional().nullable(),
  currency: z.string().length(3).optional().nullable(),
  rawPayload: z.record(z.unknown()).optional().nullable(),
  processedAt: z.date().optional().nullable(),
});
export type InsertPaymentEventInput = z.infer<typeof insertPaymentEventSchema>;

export interface InsertPaymentEventResult {
  event: BookPaymentEvent | null;
  /** False when (provider, providerEventId) already existed (replay). */
  inserted: boolean;
}

/**
 * Insert a payment-provider event, deduped on (provider, provider_event_id).
 *
 * When both orderId and checkoutSessionId are supplied, the order must actually
 * reference that checkout (else IdempotencyConflictError). On provider+event
 * replay the existing row's eventType/orderId/checkoutSessionId must match the
 * request, otherwise IdempotencyConflictError. Returns
 * `{ inserted: false, event: <existing> }` on a matching replay — idempotent
 * success. Retention metadata is intentionally NOT settable here (see
 * `setPaymentEventRetention`).
 */
export async function insertBookPaymentEvent(
  raw: InsertPaymentEventInput,
): Promise<InsertPaymentEventResult> {
  const input = insertPaymentEventSchema.parse(raw);
  return withDbAttribution(bookCommerceLabel("payment-event-insert"), async () => {
    const db = getDb();

    // Relationship integrity: an order+checkout pair must actually be linked.
    if (input.orderId && input.checkoutSessionId) {
      const [order] = await db
        .select({ checkoutSessionId: bookOrders.checkoutSessionId })
        .from(bookOrders)
        .where(eq(bookOrders.id, input.orderId))
        .limit(1);
      if (!order) {
        throw new IdempotencyConflictError(
          "payment-event",
          `${input.provider}:${input.providerEventId}`,
          `orderId ${input.orderId} does not exist`,
        );
      }
      if (order.checkoutSessionId !== input.checkoutSessionId) {
        throw new IdempotencyConflictError(
          "payment-event",
          `${input.provider}:${input.providerEventId}`,
          `order ${input.orderId} references checkout ${order.checkoutSessionId}, not ${input.checkoutSessionId}`,
        );
      }
    }

    const [row] = await db
      .insert(bookPaymentEvents)
      .values({
        orderId: input.orderId ?? null,
        checkoutSessionId: input.checkoutSessionId ?? null,
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        amountCents: input.amountCents ?? null,
        currency: input.currency ?? null,
        rawPayload: input.rawPayload ?? null,
        processedAt: input.processedAt ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (row) return { event: row, inserted: true };

    // Provider-scoped replay: verify the persisted event's identity matches.
    const [existing] = await db
      .select()
      .from(bookPaymentEvents)
      .where(
        and(
          eq(bookPaymentEvents.provider, input.provider),
          eq(bookPaymentEvents.providerEventId, input.providerEventId),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new IncompleteAggregateError(
        `payment event ${input.provider}:${input.providerEventId} conflicted but no row was found`,
      );
    }

    const key = `${input.provider}:${input.providerEventId}`;
    if (existing.eventType !== input.eventType) {
      throw new IdempotencyConflictError(
        "payment-event",
        key,
        `existing eventType ${existing.eventType} != requested ${input.eventType}`,
      );
    }
    if ((existing.orderId ?? null) !== (input.orderId ?? null)) {
      throw new IdempotencyConflictError(
        "payment-event",
        key,
        `existing orderId ${existing.orderId} != requested ${input.orderId ?? null}`,
      );
    }
    if ((existing.checkoutSessionId ?? null) !== (input.checkoutSessionId ?? null)) {
      throw new IdempotencyConflictError(
        "payment-event",
        key,
        `existing checkoutSessionId ${existing.checkoutSessionId} != requested ${input.checkoutSessionId ?? null}`,
      );
    }
    return { event: existing, inserted: false };
  });
}

/**
 * Focused trusted boundary for setting payment-event retention metadata.
 * Kept separate from the ingest path so webhook handlers cannot set retention.
 */
export const setPaymentEventRetentionSchema = z.object({
  paymentEventId: z.string().min(1),
  retentionUntil: z.date().nullable(),
  retentionReason: z.string().max(200).nullable(),
});
export type SetPaymentEventRetentionInput = z.infer<typeof setPaymentEventRetentionSchema>;

export async function setPaymentEventRetention(
  raw: SetPaymentEventRetentionInput,
): Promise<BookPaymentEvent | null> {
  const input = setPaymentEventRetentionSchema.parse(raw);
  return withDbAttribution(bookCommerceLabel("payment-event-set-retention"), async () => {
    const [row] = await getDb()
      .update(bookPaymentEvents)
      .set({
        retentionUntil: input.retentionUntil,
        retentionReason: input.retentionReason,
      })
      .where(eq(bookPaymentEvents.id, input.paymentEventId))
      .returning();
    return row ?? null;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Legal atomic order status transition
// ═══════════════════════════════════════════════════════════════════════════

export const transitionOrderStatusSchema = z.object({
  orderId: z.string().min(1),
  fromStatus: z.enum(bookOrderStatuses),
  toStatus: z.enum(bookOrderStatuses),
  actorUserId: z.string().optional().nullable(),
  reason: z.string().max(1000).optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});
export type TransitionOrderStatusInput = z.infer<typeof transitionOrderStatusSchema>;

export interface TransitionOrderStatusResult {
  transitioned: boolean;
  order: BookOrder | null;
  lifecycleEvent: BookLifecycleEvent | null;
  outboxEntry: BookOutboxEntry | null;
}

/** Server-side derivation of the lifecycle event type for an order status. */
const ORDER_STATUS_LIFECYCLE: Record<BookOrderStatus, BookLifecycleEventType> = {
  pending_payment: "order_created",
  payment_captured: "payment_captured",
  fulfillment_queued: "fulfillment_queued",
  fulfilled: "fulfilled",
  refunded: "refunded",
  partially_refunded: "partially_refunded",
  cancelled: "cancelled",
  disputed: "disputed",
};

/**
 * Server-side derivation of the outbox event type for an order status.
 * Every non-initial status maps to its OWN explicit outbox event so downstream
 * consumers never see a duplicated coarse order.created for distinct semantic
 * transitions (payment_captured / partially_refunded / disputed / etc.).
 */
const ORDER_STATUS_OUTBOX: Partial<Record<BookOrderStatus, BookOutboxEventType>> = {
  payment_captured: "order.payment_captured",
  partially_refunded: "order.partially_refunded",
  disputed: "order.disputed",
  fulfillment_queued: "order.fulfillment_queued",
  fulfilled: "order.fulfilled",
  refunded: "order.refunded",
  cancelled: "order.cancelled",
};

function deriveOrderOutboxEventType(to: BookOrderStatus): BookOutboxEventType {
  // Only pending_payment (the initial status) has no dedicated transition
  // event; it emits order.created exactly once at order creation.
  return ORDER_STATUS_OUTBOX[to] ?? "order.created";
}

/** Deterministic keys for a transition (stable across retries). */
export function orderTransitionLifecycleKey(
  orderId: string,
  from: BookOrderStatus,
  to: BookOrderStatus,
): string {
  return `order-transition:${orderId}:${from}:${to}`;
}
export function orderTransitionOutboxKey(
  orderId: string,
  from: BookOrderStatus,
  to: BookOrderStatus,
): string {
  return `order-transition:${orderId}:${from}:${to}`;
}

/**
 * Legally transition an order's status.
 *
 * The transition is validated against the shared legal map BEFORE the DB write
 * (illegal or same-state throws IllegalTransitionError). In one transaction:
 * CAS the status (WHERE status = fromStatus), then insert a lifecycle event and
 * outbox row derived server-side from toStatus, keyed deterministically. A CAS
 * miss returns transitioned: false with no side effects.
 */
export async function transitionBookOrderStatus(
  raw: TransitionOrderStatusInput,
): Promise<TransitionOrderStatusResult> {
  const input = transitionOrderStatusSchema.parse(raw);

  if (!isValidBookOrderTransition(input.fromStatus, input.toStatus)) {
    throw new IllegalTransitionError("order", input.fromStatus, input.toStatus);
  }

  const lifecycleEventType = ORDER_STATUS_LIFECYCLE[input.toStatus];
  const outboxEventType = deriveOrderOutboxEventType(input.toStatus);

  const result = await withDbAttribution(bookCommerceLabel("order-transition"), async () => {
    const db = getDb();

    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(bookOrders)
        .set({ status: input.toStatus, updatedAt: sql`now()` })
        .where(
          and(
            eq(bookOrders.id, input.orderId),
            eq(bookOrders.status, input.fromStatus),
          ),
        )
        .returning();

      if (!updated) {
        return { transitioned: false, order: null, lifecycleEvent: null, outboxEntry: null };
      }

      const lifecycleEvent = await insertLifecycleEventTx(tx, {
        contactId: updated.contactId,
        orderId: updated.id,
        checkoutSessionId: updated.checkoutSessionId,
        eventType: lifecycleEventType,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        actorUserId: input.actorUserId ?? null,
        reason: input.reason ?? null,
        metadata: input.metadata ?? null,
        idempotencyKey: orderTransitionLifecycleKey(
          updated.id,
          input.fromStatus,
          input.toStatus,
        ),
      });

      const outboxEntry = await insertOutboxTx(tx, {
        eventType: outboxEventType,
        sourceType: "order",
        sourceId: updated.id,
        payload: {
          orderId: updated.id,
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          reason: input.reason ?? null,
        },
        idempotencyKey: orderTransitionOutboxKey(
          updated.id,
          input.fromStatus,
          input.toStatus,
        ),
      });

      return { transitioned: true, order: updated, lifecycleEvent, outboxEntry };
    });
  });

  if (result.outboxEntry) {
    const { kickGhlOutboundSyncFireAndForget } = await import("../services/ghlOutboundKick");
    kickGhlOutboundSyncFireAndForget();
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Entitlement grant (idempotent, compatibility-validated, transactional)
// ═══════════════════════════════════════════════════════════════════════════

export const grantEntitlementSchema = z.object({
  orderId: z.string().min(1),
  entitlementCode: z.enum(bookEntitlementCodes),
  expiresAt: z.date().optional().nullable(),
  actorUserId: z.string().optional().nullable(),
  // NOTE: packageCode + contactId are derived authoritatively from the order.
});
export type GrantEntitlementInput = z.infer<typeof grantEntitlementSchema>;

export interface GrantEntitlementResult {
  entitlement: BookEntitlement;
  /** False when an active grant already existed (idempotent no-op). */
  granted: boolean;
  lifecycleEvent: BookLifecycleEvent | null;
  outboxEntry: BookOutboxEntry | null;
}

export function entitlementGrantLifecycleKey(orderId: string, code: string): string {
  return `entitlement-granted:${orderId}:${code}`;
}
export function entitlementGrantOutboxKey(orderId: string, code: string): string {
  return `entitlement-granted:${orderId}:${code}`;
}
export function entitlementRevokeLifecycleKey(entitlementId: string): string {
  return `entitlement-revoked:${entitlementId}`;
}
export function entitlementRevokeOutboxKey(entitlementId: string): string {
  return `entitlement-revoked:${entitlementId}`;
}

/**
 * Grant an entitlement for an order, idempotent on the active-unique
 * (orderId, entitlementCode).
 *
 * In one transaction the order is SELECTed FOR UPDATE and must exist with a
 * status in {payment_captured, fulfillment_queued, fulfilled}; packageCode and
 * contactId are DERIVED from the order (never caller-supplied) and the derived
 * package/entitlement compatibility is asserted. A missing or ineligible order
 * raises OrderNotEligibleForEntitlementError. On a fresh grant a lifecycle
 * event + outbox row are appended with deterministic keys. On an existing
 * active grant the row is returned with granted: false; if that row is
 * unexpectedly absent we throw loudly.
 */
export async function grantBookEntitlement(
  raw: GrantEntitlementInput,
): Promise<GrantEntitlementResult> {
  const input = grantEntitlementSchema.parse(raw);

  return withDbAttribution(bookCommerceLabel("entitlement-grant"), async () => {
    const db = getDb();

    return db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(bookOrders)
        .where(eq(bookOrders.id, input.orderId))
        .for("update")
        .limit(1);

      if (!order) {
        throw new OrderNotEligibleForEntitlementError(input.orderId, "order not found");
      }
      if (!ENTITLEMENT_ELIGIBLE_STATUSES.includes(order.status as BookOrderStatus)) {
        throw new OrderNotEligibleForEntitlementError(
          input.orderId,
          `status ${order.status} is not one of ${ENTITLEMENT_ELIGIBLE_STATUSES.join("|")}`,
        );
      }

      // Derive package + contact from the order; assert compatibility.
      const derivedPackage = order.packageCode as BookPackageCode;
      const derivedContactId = order.contactId;
      assertEntitlementCompatible(
        derivedPackage as BookCommercePackageCode,
        input.entitlementCode,
      );

      const [inserted] = await tx
        .insert(bookEntitlements)
        .values({
          contactId: derivedContactId ?? null,
          orderId: input.orderId,
          packageCode: derivedPackage,
          entitlementCode: input.entitlementCode,
          status: "active",
          expiresAt: input.expiresAt ?? null,
          actorUserId: input.actorUserId ?? null,
        })
        .onConflictDoNothing()
        .returning();

      if (!inserted) {
        // Active grant already exists — idempotent no-op.
        const [existing] = await tx
          .select()
          .from(bookEntitlements)
          .where(
            and(
              eq(bookEntitlements.orderId, input.orderId),
              eq(bookEntitlements.entitlementCode, input.entitlementCode),
              eq(bookEntitlements.status, "active"),
            ),
          )
          .limit(1);
        if (!existing) {
          throw new IncompleteAggregateError(
            `entitlement grant for order ${input.orderId}/${input.entitlementCode} ` +
              `conflicted on the active-unique index but no active row was found`,
          );
        }
        return {
          entitlement: existing,
          granted: false,
          lifecycleEvent: null,
          outboxEntry: null,
        };
      }

      const lifecycleEvent = await insertLifecycleEventTx(tx, {
        contactId: inserted.contactId,
        orderId: inserted.orderId,
        eventType: "entitlement_granted",
        toStatus: "active",
        actorUserId: input.actorUserId ?? null,
        metadata: { entitlementCode: inserted.entitlementCode },
        idempotencyKey: entitlementGrantLifecycleKey(
          inserted.orderId,
          inserted.entitlementCode,
        ),
      });

      const outboxEntry = await insertOutboxTx(tx, {
        eventType: "entitlement.granted",
        sourceType: "entitlement",
        sourceId: inserted.id,
        payload: {
          entitlementId: inserted.id,
          orderId: inserted.orderId,
          entitlementCode: inserted.entitlementCode,
          packageCode: inserted.packageCode,
        },
        idempotencyKey: entitlementGrantOutboxKey(
          inserted.orderId,
          inserted.entitlementCode,
        ),
      });

      return { entitlement: inserted, granted: true, lifecycleEvent, outboxEntry };
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Entitlement revocation (active → revoked CAS, transactional)
// ═══════════════════════════════════════════════════════════════════════════

export const revokeEntitlementSchema = z.object({
  entitlementId: z.string().min(1),
  actorUserId: z.string().optional().nullable(),
  revokedReason: z.string().max(1000).optional().nullable(),
});
export type RevokeEntitlementInput = z.infer<typeof revokeEntitlementSchema>;

export interface RevokeEntitlementResult {
  revoked: boolean;
  entitlement: BookEntitlement | null;
  lifecycleEvent: BookLifecycleEvent | null;
  outboxEntry: BookOutboxEntry | null;
}

/**
 * Revoke an entitlement (active → revoked CAS). On success a lifecycle event +
 * outbox row are appended transactionally with deterministic keys. If the
 * entitlement is not currently active, returns revoked: false with no effects.
 */
export async function revokeBookEntitlement(
  raw: RevokeEntitlementInput,
): Promise<RevokeEntitlementResult> {
  const input = revokeEntitlementSchema.parse(raw);

  return withDbAttribution(bookCommerceLabel("entitlement-revoke"), async () => {
    const db = getDb();

    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(bookEntitlements)
        .set({
          status: "revoked",
          revokedAt: new Date(),
          revokedReason: input.revokedReason ?? null,
          actorUserId: input.actorUserId ?? null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(bookEntitlements.id, input.entitlementId),
            eq(bookEntitlements.status, "active"),
          ),
        )
        .returning();

      if (!updated) {
        return { revoked: false, entitlement: null, lifecycleEvent: null, outboxEntry: null };
      }

      const lifecycleEvent = await insertLifecycleEventTx(tx, {
        contactId: updated.contactId,
        orderId: updated.orderId,
        eventType: "entitlement_revoked",
        fromStatus: "active",
        toStatus: "revoked",
        actorUserId: input.actorUserId ?? null,
        reason: input.revokedReason ?? null,
        metadata: { entitlementCode: updated.entitlementCode },
        idempotencyKey: entitlementRevokeLifecycleKey(updated.id),
      });

      const outboxEntry = await insertOutboxTx(tx, {
        eventType: "entitlement.revoked",
        sourceType: "entitlement",
        sourceId: updated.id,
        payload: {
          entitlementId: updated.id,
          orderId: updated.orderId,
          entitlementCode: updated.entitlementCode,
          reason: input.revokedReason ?? null,
        },
        idempotencyKey: entitlementRevokeOutboxKey(updated.id),
      });

      return { revoked: true, entitlement: updated, lifecycleEvent, outboxEntry };
    });
  });
}

// Re-export shared status/entitlement types for consumers of this slice.
export type {
  BookOrderStatus,
  BookPaymentEvent,
  BookEntitlement,
};
