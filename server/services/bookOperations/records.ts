// @db-pool-intent: ambient
/**
 * Book operations records list — cross-join of checkout sessions, contacts,
 * and orders with search + status filter.
 *
 * Status filter vocabulary (what the UI sends → what DB states are matched):
 *
 *   all         → no filter (all checkout sessions)
 *   pending     → checkout.status IN ('pending','abandoned')
 *                 AND (order is absent OR order.status = 'pending_payment')
 *                 AND checkout.payment_state NOT IN ('unknown','reconciliation_needed')
 *   completed   → order.status IN ('payment_captured','fulfillment_queued','fulfilled')
 *   exception   → checkout.payment_state IN ('unknown','reconciliation_needed')
 *                 OR order.status = 'disputed'
 *   refunded    → order.status IN ('refunded','partially_refunded')
 *   cancelled   → checkout.status IN ('expired') OR order.status = 'cancelled'
 *
 * Search: inspects raw email/name/phone server-side for matching; returns
 * masked values only.  Also matches order_number, checkout id, order id,
 * and provider correlation entity ids.
 *
 * Privacy: raw contact email/name/phone are NEVER returned; they are masked
 * before placement into the returned model.
 */

import { sql, type SQL } from "drizzle-orm";
import { getDb, withDbAttribution } from "../../db";
import { maskEmail, maskName, maskPhone } from "./masking";
import type { BookOperationListItem, BookOperationListResult } from "./types";
import { toIsoTimestamp } from "./time";

const OPS_LABEL = "route:book-operations:list-records";

// ─── Status filter → SQL fragment ─────────────────────────────────────────────

/**
 * Build a raw SQL WHERE predicate for the given status filter value.
 * Returns null for "all" (no filter applied).
 *
 * Column aliases used in the outer query:
 *   bcs  → book_checkout_sessions
 *   bo   → book_orders (LEFT JOIN)
 */
function statusFilterSql(status: string): SQL | null {
  switch (status) {
    case "all":
      return null;

    case "pending":
      // Checkout in an open state with no active order or only a payment-pending order,
      // and no durable payment anomaly.
      return sql`(
        bcs.status IN ('pending','abandoned')
        AND (bo.id IS NULL OR bo.status = 'pending_payment')
        AND bcs.payment_state NOT IN ('unknown','reconciliation_needed')
      )`;

    case "completed":
      return sql`bo.status IN ('payment_captured','fulfillment_queued','fulfilled')`;

    case "exception":
      // Payment-state anomalies OR disputed orders.
      return sql`(
        bcs.payment_state IN ('unknown','reconciliation_needed')
        OR bo.status = 'disputed'
      )`;

    case "refunded":
      return sql`bo.status IN ('refunded','partially_refunded')`;

    case "cancelled":
      // Expired checkouts or explicitly cancelled orders.
      return sql`(bcs.status = 'expired' OR bo.status = 'cancelled')`;

    default:
      return null;
  }
}

// ─── Search filter → SQL fragment ─────────────────────────────────────────────

/**
 * Build a raw SQL WHERE predicate for a search term.  The predicate matches
 * raw PII (email, name, phone) server-side so legitimate support queries work,
 * but ONLY masked values appear in the returned models.
 *
 * Also searches by: order_number, checkout-session id, order id, and any
 * provider_correlations.provider_entity_id for the checkout/order.
 */
function searchFilterSql(term: string): SQL {
  // Escape ILIKE wildcards in the literal term.
  const escaped = term.replace(/[\\%_]/g, "\\$&");
  const like = `%${escaped}%`;
  return sql`(
    bc.email        ILIKE ${like} ESCAPE '\\'
    OR bc.name      ILIKE ${like} ESCAPE '\\'
    OR bc.phone     ILIKE ${like} ESCAPE '\\'
    OR bo.order_number ILIKE ${like} ESCAPE '\\'
    OR bcs.id::text = ${term}
    OR bo.id::text  = ${term}
    OR EXISTS (
      SELECT 1 FROM book_provider_correlations bpc
      WHERE (
        (bpc.local_entity_type = 'order'            AND bpc.local_entity_id = bo.id)
        OR (bpc.local_entity_type = 'checkout_session' AND bpc.local_entity_id = bcs.id)
        OR (bpc.local_entity_type = 'contact'          AND bpc.local_entity_id = bc.id)
      )
      AND bpc.provider_entity_id ILIKE ${like} ESCAPE '\\'
    )
  )`;
}

// ─── Main list function ────────────────────────────────────────────────────────

export async function listBookOperationRecords({
  search,
  status = "all",
  limit,
  offset,
}: {
  search?: string;
  status?: string;
  limit: number;
  offset: number;
}): Promise<BookOperationListResult> {
  return withDbAttribution(OPS_LABEL, async () => {
    const db = getDb();

    const predicates: SQL[] = [];
    const statusPredicate = statusFilterSql(status);
    if (statusPredicate) predicates.push(statusPredicate);

    if (search && search.trim().length > 0) {
      predicates.push(searchFilterSql(search.trim()));
    }

    const whereClause = predicates.length > 0
      ? sql`WHERE ${sql.join(predicates, sql` AND `)}`
      : sql``;

    const baseSql = sql`
      FROM book_checkout_sessions bcs
      LEFT JOIN book_contacts bc ON bc.id = bcs.contact_id
      LEFT JOIN book_orders bo ON bo.checkout_session_id = bcs.id
      ${whereClause}
    `;

    const countResult = await db.execute(sql`SELECT count(*)::int AS total ${baseSql}`);
    const total: number = (countResult.rows[0] as { total: number }).total ?? 0;

    const dataResult = await db.execute(sql`
      SELECT
        bc.id                  AS contact_id,
        bc.email               AS contact_email,
        bc.name                AS contact_name,
        bc.phone               AS contact_phone,
        bcs.id                 AS checkout_session_id,
        bcs.status             AS checkout_status,
        bcs.package_code       AS checkout_package_code,
        bcs.payment_state      AS checkout_payment_state,
        bo.id                  AS order_id,
        bo.order_number        AS order_number,
        bo.status              AS order_status,
        bo.total_amount_cents  AS order_total_cents,
        bcs.created_at         AS created_at
      ${baseSql}
      ORDER BY bcs.created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);

    const items: BookOperationListItem[] = (
      dataResult.rows as Record<string, unknown>[]
    ).map((r) => ({
      contactId:            (r.contact_id as string | null) ?? null,
      contactEmailMasked:   maskEmail(r.contact_email as string | null),
      contactNameMasked:    maskName(r.contact_name as string | null),
      contactPhoneMasked:   maskPhone(r.contact_phone as string | null),
      checkoutSessionId:    (r.checkout_session_id as string | null) ?? null,
      checkoutStatus:       (r.checkout_status as string | null) ?? null,
      checkoutPackageCode:  (r.checkout_package_code as string | null) ?? null,
      checkoutPaymentState: (r.checkout_payment_state as string | null) ?? null,
      orderId:              (r.order_id as string | null) ?? null,
      orderNumber:          (r.order_number as string | null) ?? null,
      orderStatus:          (r.order_status as string | null) ?? null,
      orderTotalCents:      (r.order_total_cents as number | null) ?? null,
      createdAt:            toIsoTimestamp(r.created_at)!,
    }));

    return {
      total,
      hasMore: offset + items.length < total,
      items,
    };
  });
}
