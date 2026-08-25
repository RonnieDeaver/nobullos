// @db-pool-intent: ambient
/**
 * Book operations detail — full record view for a given contact, checkout
 * session, or order ID.
 *
 * Collection caps (all newest-first):
 *   entitlements          → 20 rows
 *   delivery audit        → batched via a single LEFT JOIN, 50 per entitlement
 *   payment events        → 50 rows
 *   lifecycle events      → 100 rows
 *   provider correlations → 50 rows
 *   outbox entries        → 50 rows
 *   attribution deliveries→ 100 rows
 *
 * Privacy: contact email/name/phone are masked.  The following are NEVER
 * returned: address_snapshot, raw_payload, intake answers, notes,
 * cancelledReason, decisionReason, tokens, hashes, object keys, outbox
 * payload, raw provider errors.
 */

import { and, eq, or, sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../../db";
import {
  bookCheckoutSessions,
  bookContacts,
  bookOrders,
  bookEntitlements,
  bookDeliveryAudit,
  bookAuditApplications,
  bookAppointments,
  bookPaymentEvents,
  bookLifecycleEvents,
  bookProviderCorrelations,
  bookOutbox,
  bookAttributionEvents,
  bookAttributionEventDeliveries,
} from "@shared/schema";
import { maskEmail, maskName, maskPhone } from "./masking";
import { bindArrayParam } from "../../utils/sqlArray";
import type {
  BookOperationDetail,
  BookOperationEntitlement,
  BookOperationEntitlementDeliveryAuditEntry,
  BookOperationPaymentEventRef,
  BookOperationLifecycleEntry,
  BookOperationProviderCorrelation,
  BookOperationOutboxState,
  BookOperationAttributionDelivery,
} from "./types";
import { ghlOpsHandledEventTypesSql } from "./ghlPolicy";
import { toIsoTimestamp } from "./time";

const OPS_LABEL = "route:book-operations:detail";

// Hard caps per collection
const CAP_ENTITLEMENTS          = 20;
const CAP_DELIVERY_AUDIT        = 50;
const CAP_PAYMENT_EVENTS        = 50;
const CAP_LIFECYCLE             = 100;
const CAP_CORRELATIONS          = 50;
const CAP_OUTBOX                = 50;
const CAP_ATTRIBUTION_DELIVERIES = 100;

const SAFE_DELIVERY_AUDIT_EVENT_TYPES = new Set([
  "access_revoked",
  "download",
  "link_exchanged",
]);

function publicDeliveryAuditEventType(value: unknown): string {
  return typeof value === "string" && SAFE_DELIVERY_AUDIT_EVENT_TYPES.has(value)
    ? value
    : "delivery_event";
}

export async function getBookOperationRecord(
  recordId: string,
): Promise<BookOperationDetail | null> {
  return withDbAttribution(OPS_LABEL, async () => {
    const db = getDb();

    // ── Resolve anchor row ─────────────────────────────────────────────────
    const anchorResult = await db.execute(sql`
      SELECT
        bc.id                     AS contact_id,
        bc.email                  AS contact_email,
        bc.name                   AS contact_name,
        bc.phone                  AS contact_phone,
        bcs.id                    AS checkout_session_id,
        bcs.package_code          AS checkout_package_code,
        bcs.status                AS checkout_status,
        bcs.payment_state         AS checkout_payment_state,
        bcs.subtotal_amount_cents AS checkout_subtotal_cents,
        bcs.discount_amount_cents AS checkout_discount_cents,
        bcs.shipping_amount_cents AS checkout_shipping_cents,
        bcs.tax_amount_cents      AS checkout_tax_cents,
        bcs.amount_total_cents    AS checkout_total_cents,
        bcs.currency              AS checkout_currency,
        bcs.created_at            AS checkout_created_at,
        bcs.completed_at          AS checkout_completed_at,
        bo.id                     AS order_id,
        bo.order_number           AS order_number,
        bo.status                 AS order_status,
        bo.package_code           AS order_package_code,
        bo.total_amount_cents     AS order_total_cents,
        bo.refunded_amount_cents  AS order_refunded_cents,
        bo.currency               AS order_currency,
        bo.created_at             AS order_created_at
      FROM book_checkout_sessions bcs
      LEFT JOIN book_contacts bc ON bc.id = bcs.contact_id
      LEFT JOIN book_orders bo   ON bo.checkout_session_id = bcs.id
      WHERE bcs.id = ${recordId}
         OR bc.id  = ${recordId}
         OR bo.id  = ${recordId}
      LIMIT 1
    `);

    if (!anchorResult.rows.length) return null;

    const a = anchorResult.rows[0] as Record<string, unknown>;

    const contactId        = (a.contact_id as string | null) ?? null;
    const checkoutSessionId = (a.checkout_session_id as string | null) ?? null;
    const orderId          = (a.order_id as string | null) ?? null;

    // ── Entitlements + batched delivery audit (single JOIN, no N+1) ───────
    // We collect entitlements first (capped), then load all their delivery
    // audit rows in a single query using the IN list.
    const entitlementRows = orderId
      ? await db
          .select({
            id:              bookEntitlements.id,
            entitlementCode: bookEntitlements.entitlementCode,
            packageCode:     bookEntitlements.packageCode,
            status:          bookEntitlements.status,
            grantedAt:       bookEntitlements.grantedAt,
            revokedAt:       bookEntitlements.revokedAt,
            expiresAt:       bookEntitlements.expiresAt,
          })
          .from(bookEntitlements)
          .where(eq(bookEntitlements.orderId, orderId))
          .orderBy(sql`${bookEntitlements.grantedAt} DESC`)
          .limit(CAP_ENTITLEMENTS)
      : [];

    // Batch-load delivery audit for all entitlements in one query
    type AuditRow = BookOperationEntitlementDeliveryAuditEntry & { entitlementId: string };
    let auditByEntitlement = new Map<string, AuditRow[]>();
    if (entitlementRows.length > 0) {
      const entIds = entitlementRows.map((e) => e.id);
      const auditResult = await db.execute(sql`
        SELECT
          id,
          entitlement_id,
          event_type,
          outcome,
          created_at
        FROM book_delivery_audit
        WHERE entitlement_id = ANY(${bindArrayParam(entIds, "text")})
        ORDER BY entitlement_id, created_at DESC
        LIMIT ${entIds.length * CAP_DELIVERY_AUDIT}
      `);
      // Group by entitlementId, keep newest CAP_DELIVERY_AUDIT per entitlement
      const countByEnt = new Map<string, number>();
      for (const row of auditResult.rows as Record<string, unknown>[]) {
        const eid = row.entitlement_id as string;
        const cnt = countByEnt.get(eid) ?? 0;
        if (cnt >= CAP_DELIVERY_AUDIT) continue;
        countByEnt.set(eid, cnt + 1);
        const arr = auditByEntitlement.get(eid) ?? [];
        arr.push({
          entitlementId: eid,
          id:        row.id as string,
          eventType: publicDeliveryAuditEventType(row.event_type),
          outcome:   row.outcome as string,
          createdAt: toIsoTimestamp(row.created_at)!,
        });
        auditByEntitlement.set(eid, arr);
      }
    }

    const entitlements: BookOperationEntitlement[] = entitlementRows.map((ent) => ({
      id:              ent.id,
      entitlementCode: ent.entitlementCode,
      packageCode:     ent.packageCode,
      status:          ent.status,
      grantedAt:       ent.grantedAt.toISOString(),
      revokedAt:       ent.revokedAt ? ent.revokedAt.toISOString() : null,
      expiresAt:       ent.expiresAt ? ent.expiresAt.toISOString() : null,
      deliveryAudit:   auditByEntitlement.get(ent.id) ?? [],
    }));

    // ── Application status only (no answers, notes, decisionReason) ───────
    const appRows =
      orderId || contactId
        ? await db
            .select({
              status:      bookAuditApplications.status,
              submittedAt: bookAuditApplications.submittedAt,
              decidedAt:   bookAuditApplications.decidedAt,
            })
            .from(bookAuditApplications)
            .where(
              orderId
                ? eq(bookAuditApplications.orderId, orderId)
                : eq(bookAuditApplications.contactId, contactId!),
            )
            .orderBy(sql`${bookAuditApplications.createdAt} DESC`)
            .limit(1)
        : [];
    const app = appRows[0] ?? null;

    // ── Appointment status only (no notes, cancelledReason) ───────────────
    const apptRows =
      orderId || contactId
        ? await db
            .select({
              status:      bookAppointments.status,
              scheduledAt: bookAppointments.scheduledAt,
            })
            .from(bookAppointments)
            .where(
              orderId
                ? eq(bookAppointments.orderId, orderId)
                : eq(bookAppointments.contactId, contactId!),
            )
            .orderBy(sql`${bookAppointments.createdAt} DESC`)
            .limit(1)
        : [];
    const appt = apptRows[0] ?? null;

    // ── Payment events (safe refs, no raw_payload) ─────────────────────────
    const peConditions = [];
    if (orderId)          peConditions.push(eq(bookPaymentEvents.orderId, orderId));
    if (checkoutSessionId) peConditions.push(eq(bookPaymentEvents.checkoutSessionId, checkoutSessionId));

    const paymentEventRows =
      peConditions.length > 0
        ? await db
            .select({
              id:              bookPaymentEvents.id,
              provider:        bookPaymentEvents.provider,
              providerEventId: bookPaymentEvents.providerEventId,
              eventType:       bookPaymentEvents.eventType,
              amountCents:     bookPaymentEvents.amountCents,
              currency:        bookPaymentEvents.currency,
              processedAt:     bookPaymentEvents.processedAt,
              createdAt:       bookPaymentEvents.createdAt,
            })
            .from(bookPaymentEvents)
            .where(or(...peConditions))
            .orderBy(sql`${bookPaymentEvents.createdAt} DESC`)
            .limit(CAP_PAYMENT_EVENTS)
        : [];

    const paymentEvents: BookOperationPaymentEventRef[] = paymentEventRows.map((pe) => ({
      id:             pe.id,
      provider:       pe.provider,
      providerEventId: pe.providerEventId ?? null,
      eventType:      pe.eventType,
      amountCents:    pe.amountCents ?? null,
      currency:       pe.currency ?? null,
      processedAt:    pe.processedAt ? pe.processedAt.toISOString() : null,
      createdAt:      pe.createdAt.toISOString(),
    }));

    // ── Lifecycle events (no metadata) ─────────────────────────────────────
    const lcConditions = [];
    if (contactId)        lcConditions.push(eq(bookLifecycleEvents.contactId, contactId));
    if (orderId)          lcConditions.push(eq(bookLifecycleEvents.orderId, orderId));
    if (checkoutSessionId) lcConditions.push(eq(bookLifecycleEvents.checkoutSessionId, checkoutSessionId));

    const lifecycleRows =
      lcConditions.length > 0
        ? await db
            .select({
              id:          bookLifecycleEvents.id,
              eventType:   bookLifecycleEvents.eventType,
              fromStatus:  bookLifecycleEvents.fromStatus,
              toStatus:    bookLifecycleEvents.toStatus,
              actorUserId: bookLifecycleEvents.actorUserId,
              reason:      bookLifecycleEvents.reason,
              createdAt:   bookLifecycleEvents.createdAt,
            })
            .from(bookLifecycleEvents)
            .where(or(...lcConditions))
            .orderBy(sql`${bookLifecycleEvents.createdAt} DESC`)
            .limit(CAP_LIFECYCLE)
        : [];

    const lifecycleEvents: BookOperationLifecycleEntry[] = lifecycleRows.map((le) => ({
      id:          le.id,
      eventType:   le.eventType,
      fromStatus:  le.fromStatus ?? null,
      toStatus:    le.toStatus ?? null,
      actorUserId: le.actorUserId ?? null,
      reason:      le.reason ?? null,
      createdAt:   le.createdAt.toISOString(),
    }));

    // ── Provider correlations ──────────────────────────────────────────────
    const corrConditions = [];
    if (orderId)
      corrConditions.push(and(
        eq(bookProviderCorrelations.localEntityType, "order"),
        eq(bookProviderCorrelations.localEntityId, orderId),
      ));
    if (contactId)
      corrConditions.push(and(
        eq(bookProviderCorrelations.localEntityType, "contact"),
        eq(bookProviderCorrelations.localEntityId, contactId),
      ));
    if (checkoutSessionId)
      corrConditions.push(and(
        eq(bookProviderCorrelations.localEntityType, "checkout_session"),
        eq(bookProviderCorrelations.localEntityId, checkoutSessionId),
      ));

    const corrRows =
      corrConditions.length > 0
        ? await db
            .select({
              id:                 bookProviderCorrelations.id,
              provider:           bookProviderCorrelations.provider,
              providerEntityType: bookProviderCorrelations.providerEntityType,
              providerEntityId:   bookProviderCorrelations.providerEntityId,
              localEntityType:    bookProviderCorrelations.localEntityType,
              localEntityId:      bookProviderCorrelations.localEntityId,
              createdAt:          bookProviderCorrelations.createdAt,
            })
            .from(bookProviderCorrelations)
            .where(or(...corrConditions))
            .orderBy(sql`${bookProviderCorrelations.createdAt} DESC`)
            .limit(CAP_CORRELATIONS)
        : [];

    const providerCorrelations: BookOperationProviderCorrelation[] = corrRows.map((c) => ({
      id:                 c.id,
      provider:           c.provider,
      providerEntityType: c.providerEntityType,
      providerEntityId:   c.providerEntityId,
      localEntityType:    c.localEntityType,
      localEntityId:      c.localEntityId,
      createdAt:          c.createdAt.toISOString(),
    }));

    // ── GHL outbox state (no payload) ──────────────────────────────────────
    const obConditions = [];
    if (orderId)
      obConditions.push(and(eq(bookOutbox.sourceType, "order"), eq(bookOutbox.sourceId, orderId)));
    if (contactId)
      obConditions.push(and(eq(bookOutbox.sourceType, "contact"), eq(bookOutbox.sourceId, contactId)));
    if (checkoutSessionId)
      obConditions.push(and(eq(bookOutbox.sourceType, "checkout_session"), eq(bookOutbox.sourceId, checkoutSessionId)));

    const outboxRows =
      obConditions.length > 0
        ? await db
            .select({
              id:            bookOutbox.id,
              eventType:     bookOutbox.eventType,
              sourceType:    bookOutbox.sourceType,
              sourceId:      bookOutbox.sourceId,
              status:        bookOutbox.status,
              attemptCount:  bookOutbox.attemptCount,
              maxAttempts:   bookOutbox.maxAttempts,
              lastAttemptAt: bookOutbox.lastAttemptAt,
              nextRetryAt:   bookOutbox.nextRetryAt,
              createdAt:     bookOutbox.createdAt,
            })
            .from(bookOutbox)
            .where(
              and(
                or(...obConditions),
                sql`${bookOutbox.eventType} IN (${ghlOpsHandledEventTypesSql()})`,
              ),
            )
            .orderBy(sql`${bookOutbox.createdAt} DESC`)
            .limit(CAP_OUTBOX)
        : [];

    const outboxEntries: BookOperationOutboxState[] = outboxRows.map((ob) => ({
      id:            ob.id,
      eventType:     ob.eventType,
      sourceType:    ob.sourceType,
      sourceId:      ob.sourceId,
      status:        ob.status,
      attemptCount:  ob.attemptCount,
      maxAttempts:   ob.maxAttempts,
      lastAttemptAt: ob.lastAttemptAt ? ob.lastAttemptAt.toISOString() : null,
      nextRetryAt:   ob.nextRetryAt ? ob.nextRetryAt.toISOString() : null,
      createdAt:     ob.createdAt.toISOString(),
    }));

    // ── Attribution delivery state ─────────────────────────────────────────
    const attrConditions = [];
    if (orderId)           attrConditions.push(eq(bookAttributionEvents.orderId, orderId));
    if (contactId)         attrConditions.push(eq(bookAttributionEvents.contactId, contactId));
    if (checkoutSessionId) attrConditions.push(eq(bookAttributionEvents.checkoutSessionId, checkoutSessionId));

    const attrDeliveryRows =
      attrConditions.length > 0
        ? await db
            .select({
              id:                     bookAttributionEventDeliveries.id,
              eventId:                bookAttributionEventDeliveries.eventId,
              provider:               bookAttributionEventDeliveries.provider,
              status:                 bookAttributionEventDeliveries.status,
              attempts:               bookAttributionEventDeliveries.attempts,
              externalReceiptId:      bookAttributionEventDeliveries.externalReceiptId,
              externalIdempotencyKey: bookAttributionEventDeliveries.externalIdempotencyKey,
              errorClass:             bookAttributionEventDeliveries.errorClass,
              sentAt:                 bookAttributionEventDeliveries.sentAt,
              createdAt:              bookAttributionEventDeliveries.createdAt,
            })
            .from(bookAttributionEventDeliveries)
            .innerJoin(
              bookAttributionEvents,
              eq(bookAttributionEventDeliveries.eventId, bookAttributionEvents.id),
            )
            .where(or(...attrConditions))
            .orderBy(sql`${bookAttributionEventDeliveries.createdAt} DESC`)
            .limit(CAP_ATTRIBUTION_DELIVERIES)
        : [];

    const attributionDeliveries: BookOperationAttributionDelivery[] = attrDeliveryRows.map(
      (ad) => ({
        id:                     ad.id,
        eventId:                ad.eventId,
        provider:               ad.provider,
        status:                 ad.status,
        attempts:               ad.attempts,
        externalReceiptId:      ad.externalReceiptId ?? null,
        externalIdempotencyKey: ad.externalIdempotencyKey ?? null,
        errorClass:             ad.errorClass ?? null,
        sentAt:                 ad.sentAt ? ad.sentAt.toISOString() : null,
        createdAt:              ad.createdAt.toISOString(),
      }),
    );

    // ── Assemble ───────────────────────────────────────────────────────────
    return {
      contactId,
      contactEmailMasked:   maskEmail(a.contact_email as string | null),
      contactNameMasked:    maskName(a.contact_name as string | null),
      contactPhoneMasked:   maskPhone(a.contact_phone as string | null),
      checkoutSessionId,
      checkoutPackageCode:  (a.checkout_package_code as string | null) ?? null,
      checkoutStatus:       (a.checkout_status as string | null) ?? null,
      checkoutPaymentState: (a.checkout_payment_state as string | null) ?? null,
      checkoutSubtotalCents: (a.checkout_subtotal_cents as number | null) ?? null,
      checkoutDiscountCents: (a.checkout_discount_cents as number | null) ?? null,
      checkoutShippingCents: (a.checkout_shipping_cents as number | null) ?? null,
      checkoutTaxCents:      (a.checkout_tax_cents as number | null) ?? null,
      checkoutTotalCents:    (a.checkout_total_cents as number | null) ?? null,
      checkoutCurrency:      (a.checkout_currency as string | null) ?? null,
      checkoutCreatedAt:     toIsoTimestamp(a.checkout_created_at),
      checkoutCompletedAt:   toIsoTimestamp(a.checkout_completed_at),
      orderId,
      orderNumber:      (a.order_number as string | null) ?? null,
      orderStatus:      (a.order_status as string | null) ?? null,
      orderPackageCode: (a.order_package_code as string | null) ?? null,
      orderTotalCents:  (a.order_total_cents as number | null) ?? null,
      orderRefundedCents: (a.order_refunded_cents as number | null) ?? null,
      orderCurrency:    (a.order_currency as string | null) ?? null,
      orderCreatedAt:   toIsoTimestamp(a.order_created_at),
      entitlements,
      applicationStatus:      app?.status ?? null,
      applicationSubmittedAt: app?.submittedAt ? app.submittedAt.toISOString() : null,
      applicationDecidedAt:   app?.decidedAt ? app.decidedAt.toISOString() : null,
      appointmentStatus:      appt?.status ?? null,
      appointmentScheduledAt: appt?.scheduledAt ? appt.scheduledAt.toISOString() : null,
      paymentEvents,
      lifecycleEvents,
      providerCorrelations,
      outboxEntries,
      attributionDeliveries,
    };
  });
}
