// @db-pool-intent: ambient
//
// Task #2686 — Live Data snapshot storage.
// Reads/writes `live_data_snapshots` rows. The pull service is the only writer;
// the API route is the only reader.

import { desc, eq, and, inArray, sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import {
  clients,
  liveDataSnapshots,
  liveDataMetricSchema,
  type LiveDataSnapshot,
  type InsertLiveDataSnapshot,
} from "@shared/schema";

/** Metric key of the measured monthly lead total (RIS auto-source id). */
export const MEASURED_LEADS_METRIC_KEY = "perf_total_leads";

/** Insert one snapshot row (called by the pull service after a BigQuery run). */
export async function insertLiveDataSnapshot(
  data: InsertLiveDataSnapshot,
): Promise<LiveDataSnapshot> {
  return withDbAttribution("liveData:insert", async () => {
    const [row] = await getDb()
      .insert(liveDataSnapshots)
      .values(data)
      .returning();
    return row;
  });
}

/** Latest snapshot for a client+period (or null when none exists yet). */
export async function getLatestLiveDataSnapshot(
  clientId: string,
  period: string,
): Promise<LiveDataSnapshot | null> {
  return withDbAttribution("liveData:getLatest", async () => {
    const [row] = await getDb()
      .select()
      .from(liveDataSnapshots)
      .where(
        and(
          eq(liveDataSnapshots.clientId, clientId),
          eq(liveDataSnapshots.period, period),
        ),
      )
      .orderBy(desc(liveDataSnapshots.fetchedAt))
      .limit(1);
    return row ?? null;
  });
}

/** Last N distinct period snapshots for a client (one latest per period),
 *  ordered newest-first. Used to build the trend view in the UI. */
export async function getLiveDataTrend(
  clientId: string,
  limitPeriods = 6,
): Promise<LiveDataSnapshot[]> {
  return withDbAttribution("liveData:trend", async () => {
    // Fetch the most recent `limitPeriods` distinct periods for this client,
    // then get the latest snapshot per period.
    const db = getDb();

    // Step 1: distinct periods ordered by period desc
    const periodRows = await db
      .selectDistinct({ period: liveDataSnapshots.period })
      .from(liveDataSnapshots)
      .where(eq(liveDataSnapshots.clientId, clientId))
      .orderBy(desc(liveDataSnapshots.period))
      .limit(limitPeriods);

    if (periodRows.length === 0) return [];

    const periods = periodRows.map((r) => r.period);

    // Step 2: latest snapshot per period
    const rows = await db
      .select()
      .from(liveDataSnapshots)
      .where(
        and(
          eq(liveDataSnapshots.clientId, clientId),
          inArray(liveDataSnapshots.period, periods),
        ),
      )
      .orderBy(desc(liveDataSnapshots.period), desc(liveDataSnapshots.fetchedAt));

    // Dedupe: keep only the first (latest) row per period
    const seen = new Set<string>();
    const deduped: LiveDataSnapshot[] = [];
    for (const row of rows) {
      if (!seen.has(row.period)) {
        seen.add(row.period);
        deduped.push(row);
      }
    }
    return deduped;
  });
}

// ─── Task #4766 — measured monthly-leads series (tier-gate fallback) ───

/** SQL predicate: snapshot fetched AFTER its period closed (final total). */
const postCloseFetch = sql`${liveDataSnapshots.fetchedAt} >= (to_date(${liveDataSnapshots.period} || '-01', 'YYYY-MM-DD') + interval '1 month')`;

export interface MeasuredMonthlyLeadsRow {
  month: string;
  leads: number;
  fetchedAt: string;
}

/**
 * Measured monthly lead totals for the tier gate's fallback stability
 * source: for each completed period strictly before the judgment month,
 * the LATEST snapshot fetched AFTER that period closed, keeping only an
 * ok-status `perf_total_leads` metric value. Newest-first. Periods whose
 * final snapshot lacks an ok leads metric are omitted (no fabricated
 * zeros) — absence stays absence.
 */
export async function getMeasuredMonthlyLeadsSeries(
  clientId: string,
  judgmentDateStr: string,
  limitPeriods = 8,
): Promise<MeasuredMonthlyLeadsRow[]> {
  const judgmentMonth = judgmentDateStr.substring(0, 7);
  return withDbAttribution("liveData:measuredLeadsSeries", async () => {
    const rows = await getDb()
      .select()
      .from(liveDataSnapshots)
      .where(
        and(
          eq(liveDataSnapshots.clientId, clientId),
          sql`${liveDataSnapshots.period} < ${judgmentMonth}`,
          postCloseFetch,
        ),
      )
      .orderBy(desc(liveDataSnapshots.period), desc(liveDataSnapshots.fetchedAt))
      .limit(limitPeriods * 8); // several snapshots may exist per period

    const out: MeasuredMonthlyLeadsRow[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.period)) continue; // latest post-close per period wins
      seen.add(row.period);
      const metrics = Array.isArray(row.metrics) ? row.metrics : [];
      for (const raw of metrics) {
        const parsed = liveDataMetricSchema.safeParse(raw);
        if (!parsed.success) continue;
        const m = parsed.data;
        if (m.key === MEASURED_LEADS_METRIC_KEY && m.status === "ok" && m.value !== null) {
          out.push({
            month: row.period,
            leads: m.value,
            fetchedAt: row.fetchedAt.toISOString(),
          });
          break;
        }
      }
      if (out.length >= limitPeriods) break;
    }
    return out;
  });
}

/**
 * Active (non-archived, non-demo, customer-lifecycle) client ids with NO
 * post-close snapshot for `period` — the seed/close-out backlog. A
 * not-configured or partial/ok snapshot fetched after close COUNTS as
 * final: the disposition is explainable and recorded, never a silent gap.
 * An all-error snapshot does NOT count, so a failed pull stays pending and
 * gets retried by the next close-out tick / seed press.
 */
export async function listActiveClientIdsMissingFinalSnapshot(
  period: string,
): Promise<string[]> {
  return withDbAttribution("liveData:missingFinalSnapshot", async () => {
    const rows = await getDb().execute(sql`
      SELECT c.id
      FROM ${clients} c
      WHERE (c.is_archived = false OR c.is_archived IS NULL)
        AND (c.is_demo = false OR c.is_demo IS NULL)
        AND c.lifecycle_stage = 'customer'
        AND NOT EXISTS (
          SELECT 1 FROM ${liveDataSnapshots} s
          WHERE s.client_id = c.id
            AND s.period = ${period}
            AND s.overall_status <> 'error'
            AND s.fetched_at >= (to_date(s.period || '-01', 'YYYY-MM-DD') + interval '1 month')
        )
      ORDER BY c.firm_name
    `);
    return ((rows as any).rows ?? []).map((r: any) => String(r.id));
  });
}
