// @db-pool-intent: ambient
/**
 * Book operations summary — funnel event counts + financial roll-up.
 *
 * Reads from:
 *   - book_attribution_events  (funnel stage counts)
 *   - book_orders              (financial aggregates + channel/package/campaign slices)
 *
 * No PII is returned.  Attribution is read only from utm columns
 * (latestTouchUtmMedium, latestTouchUtmCampaign) which are non-identifying
 * channel/campaign strings.
 */

import { and, gte, lte, sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../../db";
import { bookAttributionEvents, bookOrders } from "@shared/schema";
import type {
  BookOperationsSummary,
  BookOperationsSummaryFunnelStage,
  BookOperationsSummaryConversionRate,
  BookOperationsSummarySlice,
  BookOperationsSummaryFinancials,
} from "./types";

const OPS_LABEL = "route:book-operations:summary";

/** Blueprint funnel stages, ordered from top to bottom. */
const FUNNEL_EVENT_MAP: ReadonlyArray<{ eventName: string; stage: string }> = [
  { eventName: "view_item",                      stage: "visitor"     },
  { eventName: "begin_checkout",                 stage: "checkout"    },
  { eventName: "purchase",                       stage: "purchase"    },
  { eventName: "audit_application_submit",       stage: "application" },
  { eventName: "audit_application_qualified",    stage: "qualified"   },
  { eventName: "appointment_booked",             stage: "booked"      },
  { eventName: "appointment_attended",           stage: "attended"    },
  { eventName: "qualified_opportunity",          stage: "opportunity" },
  { eventName: "client_closed",                  stage: "client"      },
] as const;

/**
 * Order statuses that represent revenue-bearing records.
 * pending_payment rows are excluded from financial roll-up.
 */
const REVENUE_ORDER_STATUSES = [
  "payment_captured",
  "fulfillment_queued",
  "fulfilled",
  "refunded",
  "partially_refunded",
  "disputed",
] as const;

export async function getBookOperationsSummary({
  from,
  to,
}: {
  from: Date;
  to: Date;
}): Promise<BookOperationsSummary> {
  return withDbAttribution(OPS_LABEL, async () => {
    const db = getDb();

    // ── Funnel counts ──────────────────────────────────────────────────────
    const funnelEventNames = FUNNEL_EVENT_MAP.map((e) => e.eventName);
    const funnelRows = await db
      .select({
        eventName: bookAttributionEvents.eventName,
        cnt: sql<number>`count(*)::int`,
      })
      .from(bookAttributionEvents)
      .where(
        and(
          gte(bookAttributionEvents.occurredAt, from),
          lte(bookAttributionEvents.occurredAt, to),
          sql`${bookAttributionEvents.eventName} IN (${sql.join(
            funnelEventNames.map((n) => sql`${n}`),
            sql`, `,
          )})`,
        ),
      )
      .groupBy(bookAttributionEvents.eventName);

    const funnelMap = new Map<string, number>(funnelRows.map((r) => [r.eventName, r.cnt]));

    const funnel: BookOperationsSummaryFunnelStage[] = FUNNEL_EVENT_MAP.map((e) => ({
      stage: e.stage,
      count: funnelMap.get(e.eventName) ?? 0,
    }));

    const conversionRates: BookOperationsSummaryConversionRate[] = [];
    for (let i = 1; i < funnel.length; i++) {
      const prev = funnel[i - 1];
      const curr = funnel[i];
      conversionRates.push({
        from: prev.stage,
        to: curr.stage,
        rate: prev.count > 0 ? Math.round((curr.count / prev.count) * 10000) / 10000 : null,
      });
    }

    // ── Financial aggregates ───────────────────────────────────────────────
    const revenueStatusList = REVENUE_ORDER_STATUSES.map((s) => sql`${s}`);
    const [financialRow] = await db
      .select({
        grossCents: sql<number>`coalesce(sum(${bookOrders.totalAmountCents}), 0)`,
        refundCents: sql<number>`coalesce(sum(${bookOrders.refundedAmountCents}), 0)`,
        orderCount: sql<number>`count(*)::int`,
      })
      .from(bookOrders)
      .where(
        and(
          gte(bookOrders.createdAt, from),
          lte(bookOrders.createdAt, to),
          sql`${bookOrders.status} IN (${sql.join(revenueStatusList, sql`, `)})`,
        ),
      );

    interface SliceAggregateRow {
      slice_key: string;
      gross_cents: string | number;
      refund_cents: string | number;
      order_count: string | number;
      position: string | number;
    }

    /**
     * Aggregate and rank in PostgreSQL so high-cardinality campaign values
     * never become an unbounded API response or application-memory scan.
     * The final row preserves the complete tail as an explicit Other bucket.
     */
    const loadSlices = async (
      keyExpression: ReturnType<typeof sql>,
      limit: number,
    ): Promise<BookOperationsSummarySlice[]> => {
      const result = await db.execute(sql`
        WITH grouped AS (
          SELECT
            (${keyExpression})::text AS slice_key,
            coalesce(sum(${bookOrders.totalAmountCents}), 0)::bigint AS gross_cents,
            coalesce(sum(${bookOrders.refundedAmountCents}), 0)::bigint AS refund_cents,
            count(*)::bigint AS order_count
          FROM ${bookOrders}
          WHERE ${bookOrders.createdAt} >= ${from}
            AND ${bookOrders.createdAt} <= ${to}
            AND ${bookOrders.status} IN (${sql.join(revenueStatusList, sql`, `)})
          GROUP BY (${keyExpression})
        ),
        ranked AS (
          SELECT
            grouped.*,
            row_number() OVER (
              ORDER BY gross_cents DESC, slice_key ASC
            ) AS position
          FROM grouped
        )
        SELECT slice_key, gross_cents, refund_cents, order_count, position
        FROM ranked
        WHERE position <= ${limit}
        UNION ALL
        SELECT
          '__other__'::text AS slice_key,
          coalesce(sum(gross_cents), 0)::bigint AS gross_cents,
          coalesce(sum(refund_cents), 0)::bigint AS refund_cents,
          coalesce(sum(order_count), 0)::bigint AS order_count,
          ${limit + 1}::bigint AS position
        FROM ranked
        WHERE position > ${limit}
        HAVING count(*) > 0
        ORDER BY position
      `);

      return (result.rows as unknown as SliceAggregateRow[]).map((row) => {
        const grossCents = Number(row.gross_cents);
        const refundCents = Number(row.refund_cents);
        return {
          key: row.slice_key,
          label: row.slice_key === "__other__" ? "Other" : row.slice_key,
          grossCents,
          refundCents,
          netCents: grossCents - refundCents,
          orderCount: Number(row.order_count),
        };
      });
    };

    const packageSlices = await loadSlices(
      sql`coalesce(${bookOrders.packageCode}, 'unknown')`,
      10,
    );
    const channelSlices = await loadSlices(
      sql`coalesce(${bookOrders.latestTouchUtmMedium}, 'direct')`,
      20,
    );
    const campaignSlices = await loadSlices(
      sql`coalesce(${bookOrders.latestTouchUtmCampaign}, 'unknown')`,
      20,
    );

    const totalGross = Number(financialRow?.grossCents ?? 0);
    const totalRefund = Number(financialRow?.refundCents ?? 0);
    const totalOrders = Number(financialRow?.orderCount ?? 0);

    const financials: BookOperationsSummaryFinancials = {
      grossCents:  totalGross,
      refundCents: totalRefund,
      netCents:    totalGross - totalRefund,
      orderCount:  totalOrders,
      aovCents:    totalOrders > 0 ? Math.round(totalGross / totalOrders) : null,
    };

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      funnel,
      conversionRates,
      packageSlices,
      channelSlices,
      campaignSlices,
      financials,
      marginInputs: { status: "unavailable", value: null },
    };
  });
}
