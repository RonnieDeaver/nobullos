// @db-pool-intent: ambient
/**
 * Book operations exceptions — union of durable anomaly rows from:
 *   1. checkout_payment   — book_checkout_sessions with payment_state IN
 *                           ('unknown','reconciliation_needed')
 *   2. payment_event      — book_payment_events whose checkout_session_id
 *                           references a now-missing session (orphaned)
 *   3. ghl_outbox         — book_outbox rows that are GHL-handled event types
 *                           AND in status 'failed' OR 'dead_letter'
 *   4. analytics_delivery — book_attribution_event_deliveries in status
 *                           'retry' OR 'dead'
 *   5. delivery_audit     — book_delivery_audit rows with outcome 'failed'
 *                           OR 'unavailable'
 *
 * GHL event eligibility is shared with detail/replay through ghlPolicy.ts.
 *
 * Privacy: no raw provider errors, no outbox payload, no address data.
 * The `reason` field carries a sanitized error-class or outcome code only.
 */

import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../../db";
import type {
  BookOperationExceptionKind,
  BookOperationException,
  BookOperationExceptionsResult,
} from "./types";
import { ghlOpsHandledEventTypesLiteral } from "./ghlPolicy";
import { toIsoTimestamp } from "./time";

const OPS_LABEL = "route:book-operations:exceptions";

export async function listBookOperationExceptions({
  kind = "all",
  limit,
  offset,
}: {
  kind?: BookOperationExceptionKind;
  limit: number;
  offset: number;
}): Promise<BookOperationExceptionsResult> {
  return withDbAttribution(OPS_LABEL, async () => {
    const db = getDb();

    const includePayments  = kind === "all" || kind === "payments";
    const includeGhl       = kind === "all" || kind === "ghl";
    const includeAnalytics = kind === "all" || kind === "analytics";
    const includeDelivery  = kind === "all" || kind === "delivery";

    const parts: string[] = [];

    if (includePayments) {
      // 1. Checkout sessions with durable payment anomalies
      parts.push(`
        SELECT
          'checkout_payment'::text                      AS source,
          bcs.payment_state                             AS exception_kind,
          bcs.id                                        AS entity_id,
          'checkout_session'::text                      AS entity_type,
          'stripe'::text                                AS provider_or_platform,
          bcs.provider_session_id                       AS local_reference_id,
          (
            SELECT bpe.id
            FROM book_payment_events bpe
            WHERE bpe.checkout_session_id = bcs.id
              AND bpe.processed_at IS NULL
            ORDER BY bpe.created_at DESC
            LIMIT 1
          )                                             AS repair_target_id,
          bcs.payment_state                             AS status,
          CASE bcs.payment_state
            WHEN 'unknown' THEN 'payment_state_unknown'
            ELSE 'reconciliation_required'
          END::text                                     AS reason,
          bcs.created_at,
          bcs.updated_at
        FROM book_checkout_sessions bcs
        WHERE bcs.payment_state IN ('unknown', 'reconciliation_needed')
      `);

      // 2. Payment events whose checkout session no longer exists (orphaned)
      parts.push(`
        SELECT
          'payment_event'::text                         AS source,
          'orphaned_payment_event'::text                AS exception_kind,
          bpe.id                                        AS entity_id,
          'payment_event'::text                         AS entity_type,
          bpe.provider                                  AS provider_or_platform,
          bpe.id                                        AS local_reference_id,
          NULL::text                                    AS repair_target_id,
          'orphaned'::text                              AS status,
          'missing_checkout_session'::text              AS reason,
          bpe.created_at,
          NULL::timestamptz                             AS updated_at
        FROM book_payment_events bpe
        LEFT JOIN book_checkout_sessions bcs ON bcs.id = bpe.checkout_session_id
        WHERE bpe.checkout_session_id IS NOT NULL
          AND bcs.id IS NULL
      `);
    }

    if (includeGhl) {
      // 3. GHL outbox rows that are failed or dead_letter AND belong to the
      //    GHL-handled event type set. Non-GHL outbox rows are excluded.
      parts.push(`
        SELECT
          'ghl_outbox'::text                            AS source,
          bo.status                                     AS exception_kind,
          bo.id                                         AS entity_id,
          'outbox'::text                                AS entity_type,
          'ghl'::text                                   AS provider_or_platform,
          bo.source_id                                  AS local_reference_id,
          bo.id                                         AS repair_target_id,
          bo.status                                     AS status,
          CASE bo.status
            WHEN 'dead_letter' THEN 'delivery_dead_letter'
            ELSE 'delivery_failed'
          END::text                                     AS reason,
          bo.created_at,
          bo.updated_at
        FROM book_outbox bo
        WHERE bo.status IN ('failed', 'dead_letter')
          AND bo.event_type IN (${ghlOpsHandledEventTypesLiteral()})
      `);
    }

    if (includeAnalytics) {
      // 4. Attribution delivery rows in retry or dead state.
      //    error_class is a sanitized classification (no raw provider errors).
      parts.push(`
        SELECT
          'analytics_delivery'::text                    AS source,
          baed.status                                   AS exception_kind,
          baed.id                                       AS entity_id,
          'analytics_delivery'::text                    AS entity_type,
          baed.provider                                 AS provider_or_platform,
          baed.event_id                                 AS local_reference_id,
          NULL::text                                    AS repair_target_id,
          baed.status                                   AS status,
          baed.error_class                              AS reason,
          baed.created_at,
          baed.updated_at
        FROM book_attribution_event_deliveries baed
        WHERE baed.status IN ('retry', 'dead')
      `);
    }

    if (includeDelivery) {
      // 5. Delivery audit rows with failed or unavailable outcomes.
      //    detail is capped at 400 chars per the schema; no object paths
      //    or token data may be stored there (schema enforcement).
      parts.push(`
        SELECT
          'delivery_audit'::text                        AS source,
          bda.outcome                                   AS exception_kind,
          bda.id                                        AS entity_id,
          'delivery_audit'::text                        AS entity_type,
          NULL::text                                    AS provider_or_platform,
          bda.entitlement_id                            AS local_reference_id,
          bda.entitlement_id                            AS repair_target_id,
          bda.outcome                                   AS status,
          CASE bda.outcome
            WHEN 'unavailable' THEN 'access_delivery_unavailable'
            ELSE 'access_delivery_failed'
          END::text                                     AS reason,
          bda.created_at,
          NULL::timestamptz                             AS updated_at
        FROM book_delivery_audit bda
        WHERE bda.outcome IN ('failed', 'unavailable')
      `);
    }

    if (!parts.length) {
      return { total: 0, hasMore: false, items: [] };
    }

    const unionSql = parts.join(" UNION ALL ");

    const countResult = await db.execute(
      sql`SELECT count(*)::int AS total FROM (${sql.raw(unionSql)}) AS _exc`,
    );
    const total: number = (countResult.rows[0] as { total: number }).total ?? 0;

    const dataResult = await db.execute(sql`
      SELECT *
      FROM (${sql.raw(unionSql)}) AS _exc
      ORDER BY created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);

    const items: BookOperationException[] = (
      dataResult.rows as Record<string, unknown>[]
    ).map((r) => ({
      source:             r.source as BookOperationException["source"],
      exceptionKind:      r.exception_kind as string,
      entityId:           r.entity_id as string,
      entityType:         r.entity_type as string,
      providerOrPlatform: (r.provider_or_platform as string | null) ?? null,
      localReferenceId:   (r.local_reference_id as string | null) ?? null,
      repairTargetId:      (r.repair_target_id as string | null) ?? null,
      status:             r.status as string,
      reason:             (r.reason as string | null) ?? null,
      createdAt:          toIsoTimestamp(r.created_at)!,
      updatedAt:          toIsoTimestamp(r.updated_at),
    }));

    return { total, hasMore: offset + items.length < total, items };
  });
}
