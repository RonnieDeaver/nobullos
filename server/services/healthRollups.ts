// @cross-instance-safe: idempotent replace-style rollup keyed by (metric,date) + idempotent retention DELETE; converges across instances.
/**
 * Task #861 Phase 8 — Daily rollups + Phase 2 freshness checks.
 *
 * Aggregates the previous day's raw samples into `health_daily_rollups` so
 * the dashboard can render 30/90-day SLO views without scanning raw samples.
 * Also exposes a freshness API so the dashboard can flag broken capture
 * pipelines (the original `manual_reserve_worker_samples` capture failure
 * that motivated this task).
 */

// Task #1573 (Audit Track C): hourly rollup + retention pruner runs on a
// background timer; uses the worker pool so it doesn't consume request-pool
// capacity. `dbRetry` and `withDbAttribution` are pool-agnostic helpers.
import { workerDb as db, dbRetry, withDbAttribution } from "../db";
import { sql } from "drizzle-orm";
import * as healthStore from "../storage/healthMetricsStorage";
import type { InsertHealthDailyRollup } from "@shared/schema";
import { PERF } from "../perfConfig";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";

// Task #1850 — Gate both ticks on a dedicated `health_rollups_enabled`
// kill switch AND the global `KILL_SWITCH_NON_CRITICAL_SWEEPS`. Default
// is ON so behavior is unchanged; operators can flip either off via
// `system_settings` / env to halt the worker without a redeploy.
function rollupsKillSwitchSkipReason(): string | null {
  if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
    return "KILL_SWITCH_NON_CRITICAL_SWEEPS=true";
  }
  if (!isPoolEpicSwitchEnabled("health_rollups_enabled")) {
    return "health_rollups_enabled=false";
  }
  return null;
}

const ROLLUP_INTERVAL_MS = 60 * 60_000; // hourly upsert of "today" rollup
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
const RAW_RETENTION_MS = 30 * 24 * 60 * 60_000; // raw samples kept 30 days
const ROLLUP_RETENTION_DAYS = 90;
const RESOLVED_INCIDENT_RETENTION_MS = 90 * 24 * 60 * 60_000;

let rollupInterval: ReturnType<typeof setInterval> | null = null;
let pruneInterval: ReturnType<typeof setInterval> | null = null;

export interface FreshnessRow {
  table: string;
  rowsLastHour: number;
  rowsLast24h: number;
  lastSampleTimestamp: number | null;
  expectedCadenceSeconds: number;
  status: "healthy" | "delayed" | "missing" | "disabled";
  notes?: string;
}

const FRESHNESS_TARGETS: Array<{
  table: string;
  tsColumn: string;
  cadenceSeconds: number;
  delayedFactor: number; // factor of cadence after which we consider delayed
  missingFactor: number; // factor after which we consider missing
}> = [
  { table: "health_samples", tsColumn: "timestamp", cadenceSeconds: 30, delayedFactor: 4, missingFactor: 20 },
  { table: "manual_reserve_worker_samples", tsColumn: "timestamp", cadenceSeconds: 300, delayedFactor: 2, missingFactor: 6 },
  { table: "pool_state_samples", tsColumn: "sampled_at", cadenceSeconds: 60, delayedFactor: 4, missingFactor: 15 },
  { table: "health_incidents", tsColumn: "last_seen_at", cadenceSeconds: 0, delayedFactor: 0, missingFactor: 0 },
  { table: "health_daily_rollups", tsColumn: "(EXTRACT(EPOCH FROM created_at) * 1000)::bigint", cadenceSeconds: 86400, delayedFactor: 2, missingFactor: 4 },
];

export async function getFreshness(): Promise<FreshnessRow[]> {
  // Task #1722 Phase 1.3 — Collapse the previous 3*N round-trips (one
  // SELECT per (target × {rowsLastHour, rowsLast24h, maxTs})) into a
  // single UNION ALL statement, and pin the DB attribution label to
  // `route:health-freshness` so the holds it does take are not blamed
  // on whichever caller (HTTP handler, Slack digest, post-deploy
  // verifier) wrapped it in their own scope.
  return withDbAttribution("route:health-freshness", () =>
    getFreshnessInner(),
  );
}

async function getFreshnessInner(): Promise<FreshnessRow[]> {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60_000;
  const twentyFourHoursAgo = now - 24 * 60 * 60_000;

  // FRESHNESS_TARGETS is a code-level constant; table/tsColumn values
  // are safe SQL identifiers (some `tsColumn` entries are expressions
  // like `(EXTRACT(EPOCH FROM created_at) * 1000)::bigint`). We embed
  // them with sql.raw and parameterize the two cutoff timestamps once.
  const unions = FRESHNESS_TARGETS.map((t, i) => `
    SELECT
      ${i}::int AS idx,
      (SELECT COUNT(*)::int FROM ${t.table} WHERE ${t.tsColumn} >= ${oneHourAgo}) AS rows_last_hour,
      (SELECT COUNT(*)::int FROM ${t.table} WHERE ${t.tsColumn} >= ${twentyFourHoursAgo}) AS rows_last_24h,
      (SELECT MAX(${t.tsColumn})::bigint FROM ${t.table}) AS max_ts
  `).join(" UNION ALL ");

  type Row = { idx: number; rows_last_hour: number | string | null; rows_last_24h: number | string | null; max_ts: number | string | null };
  let rows: Row[] = [];
  let bulkError: string | null = null;
  try {
    const r = await db.execute<any>(sql.raw(unions));
    rows = Array.isArray(r) ? r : (r as any).rows ?? [];
  } catch (err: any) {
    bulkError = String(err?.message ?? err).slice(0, 120);
  }

  const byIdx = new Map<number, Row>();
  for (const r of rows) byIdx.set(Number(r.idx), r);

  const out: FreshnessRow[] = [];
  for (let i = 0; i < FRESHNESS_TARGETS.length; i++) {
    const t = FRESHNESS_TARGETS[i];
    const r = byIdx.get(i);
    if (bulkError || !r) {
      out.push({
        table: t.table,
        rowsLastHour: 0,
        rowsLast24h: 0,
        lastSampleTimestamp: null,
        expectedCadenceSeconds: t.cadenceSeconds,
        status: "missing",
        notes: bulkError ? `query error: ${bulkError}` : `missing row in bulk freshness result`,
      });
      continue;
    }
    const rowsLastHour = Number(r.rows_last_hour ?? 0);
    const rowsLast24h = Number(r.rows_last_24h ?? 0);
    const last = r.max_ts === null || r.max_ts === undefined ? null : Number(r.max_ts);

    let status: FreshnessRow["status"] = "healthy";
    let notes: string | undefined;

    if (t.cadenceSeconds === 0) {
      status = "healthy";
    } else {
      const expectedDelayMs = t.cadenceSeconds * 1000;
      if (last === null) {
        status = "missing";
        notes = `No rows ever recorded`;
      } else {
        const ageMs = now - last;
        if (ageMs > expectedDelayMs * t.missingFactor) {
          status = "missing";
          notes = `No row in ${Math.round(ageMs / 60_000)}m (cadence ${t.cadenceSeconds}s)`;
        } else if (ageMs > expectedDelayMs * t.delayedFactor) {
          status = "delayed";
          notes = `Last row ${Math.round(ageMs / 1000)}s ago (cadence ${t.cadenceSeconds}s)`;
        }
      }
    }

    out.push({
      table: t.table,
      rowsLastHour,
      rowsLast24h,
      lastSampleTimestamp: last,
      expectedCadenceSeconds: t.cadenceSeconds,
      status,
      notes,
    });
  }
  return out;
}

function utcDateString(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

export async function buildRollupForDate(targetDateMs: number): Promise<void> {
  const dayStart = startOfUtcDay(targetDateMs);
  const dayEnd = dayStart + 24 * 60 * 60_000;
  const dateStr = utcDateString(dayStart);

  await dbRetry(async () => {
    // Pull the percentiles in a single SELECT to avoid N round-trips.
    const r = await db.execute<any>(sql`
      SELECT
        COUNT(*)::int AS sample_count,
        COUNT(*) FILTER (WHERE status = 'ok')::int AS ok_count,
        COUNT(*) FILTER (WHERE status = 'degraded')::int AS degraded_count,
        COUNT(*) FILTER (WHERE status = 'error')::int AS error_count,
        PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY db_round_trip_ms) AS p50,
        PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY db_round_trip_ms) AS p95,
        PERCENTILE_DISC(0.99) WITHIN GROUP (ORDER BY db_round_trip_ms) AS p99,
        MIN(db_round_trip_ms) AS min_val,
        MAX(db_round_trip_ms) AS max_val,
        AVG(db_round_trip_ms)::int AS avg_val,
        SUM(jsonb_array_length(alerts))::int AS alert_count
      FROM health_samples
      WHERE timestamp >= ${dayStart} AND timestamp < ${dayEnd}
    `);
    const list = Array.isArray(r) ? r : (r as any).rows ?? [];
    const row = list[0];
    if (!row || Number(row.sample_count ?? 0) === 0) return;

    const incidentCount = await healthStore.countIncidentsSince(dayStart);
    const record: InsertHealthDailyRollup = {
      metric: "db_round_trip_ms",
      date: dateStr,
      sampleCount: Number(row.sample_count ?? 0),
      okCount: Number(row.ok_count ?? 0),
      degradedCount: Number(row.degraded_count ?? 0),
      errorCount: Number(row.error_count ?? 0),
      p50: row.p50 !== null ? Number(row.p50) : null,
      p95: row.p95 !== null ? Number(row.p95) : null,
      p99: row.p99 !== null ? Number(row.p99) : null,
      minVal: row.min_val !== null ? Number(row.min_val) : null,
      maxVal: row.max_val !== null ? Number(row.max_val) : null,
      avgVal: row.avg_val !== null ? Number(row.avg_val) : null,
      alertCount: Number(row.alert_count ?? 0),
      incidentCount,
      metadata: {},
    };
    await healthStore.upsertDailyRollup(record);
  }, "healthRollups.buildRollupForDate");
}

async function rollupTick(): Promise<void> {
  const skip = rollupsKillSwitchSkipReason();
  if (skip) {
    console.log(
      `[HealthRollups] rollup tick skipped — ${skip}`,
    );
    return;
  }
  const now = Date.now();
  // Keep today and yesterday fresh — yesterday closes out, today is partial.
  await buildRollupForDate(now);
  await buildRollupForDate(now - 24 * 60 * 60_000);
}

async function pruneTick(): Promise<void> {
  const skip = rollupsKillSwitchSkipReason();
  if (skip) {
    console.log(
      `[HealthRollups] prune tick skipped — ${skip}`,
    );
    return;
  }
  const now = Date.now();
  try {
    // Raw samples — extend to 30 days (was 7 in legacy code, that prune lives
    // in healthMetrics.ts and continues to apply; this is an additional sweep
    // that respects the longer retention if the legacy interval stops).
    const removedSamples = await dbRetry(
      () => healthStore.pruneHealthSamples(now - RAW_RETENTION_MS),
      "healthRollups.pruneRawSamples",
    );
    if (removedSamples > 0) {
      console.log(`[HealthRollups] Pruned ${removedSamples} raw health samples (>30d)`);
    }

    const cutoffDate = utcDateString(now - ROLLUP_RETENTION_DAYS * 24 * 60 * 60_000);
    const removedRollups = await dbRetry(
      () => healthStore.pruneDailyRollups(cutoffDate),
      "healthRollups.pruneRollups",
    );
    if (removedRollups > 0) {
      console.log(`[HealthRollups] Pruned ${removedRollups} daily rollups (>${ROLLUP_RETENTION_DAYS}d)`);
    }

    const removedIncidents = await dbRetry(
      () => healthStore.pruneResolvedIncidents(now - RESOLVED_INCIDENT_RETENTION_MS),
      "healthRollups.pruneIncidents",
    );
    if (removedIncidents > 0) {
      console.log(`[HealthRollups] Pruned ${removedIncidents} resolved incidents (>90d)`);
    }
  } catch (err: any) {
    console.warn("[HealthRollups] prune tick failed:", err?.message || err);
  }
}

export function startHealthRollups(): void {
  if (rollupInterval) return;
  rollupTick().catch((err) =>
    console.warn("[HealthRollups] initial rollup failed:", err?.message || err),
  );
  rollupInterval = setInterval(() => {
    void withDbAttribution("maintenance:health-rollups-tick", () =>
      rollupTick().catch((err) =>
        console.warn("[HealthRollups] rollup tick failed:", err?.message || err),
      ),
    );
  }, ROLLUP_INTERVAL_MS);
  pruneInterval = setInterval(() => {
    void withDbAttribution("maintenance:health-rollups-prune", () =>
      pruneTick().catch((err) =>
        console.warn("[HealthRollups] prune tick failed:", err?.message || err),
      ),
    );
  }, PRUNE_INTERVAL_MS);
  console.log(
    `[HealthRollups] started — rollup hourly, retention raw ${RAW_RETENTION_MS / 86400000}d / daily ${ROLLUP_RETENTION_DAYS}d`,
  );
}

export function stopHealthRollups(): void {
  if (rollupInterval) {
    clearInterval(rollupInterval);
    rollupInterval = null;
  }
  if (pruneInterval) {
    clearInterval(pruneInterval);
    pruneInterval = null;
  }
}

export const __test = {
  buildRollupForDate,
  utcDateString,
  startOfUtcDay,
};
