// @cross-instance-safe: idempotent UPSERT (ON CONFLICT) keyed by time bucket + idempotent prune DELETE; converges across instances.
/**
 * Task #1728 (Pool epic Phase 1.5.1 + 1.5.2) — daily rollup workers.
 *
 *   * `runExternalCallAuditRollup(date)` aggregates `external_call_audits`
 *     into `external_call_audit_daily_rollups`. Gated by
 *     `external_call_audit_enabled`.
 *   * `runDbHoldLabelRollup(date)` aggregates the previous day's
 *     `pool_state_samples.top_hold_labels` into `db_hold_label_rollups`.
 *     Gated by `db_hold_rollup_enabled`.
 *
 * Both run on the `workerDb` pool so the daily aggregate query never
 * competes with API-request capacity, and both are scheduled on a 1-hour
 * cadence (re-computing today + yesterday on each tick) so a transient
 * failure self-heals without operator intervention.
 */

import { sql } from "drizzle-orm";
import { workerDb, dbRetry, withDbAttribution } from "../db";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";
import {
  DEDUPE_DROP_VERDICT_ROLLUP_RETENTION_DAYS,
  DEDUPE_DROP_ACTIVE_CHAIN_STALE_MS,
} from "./frontRecoveryDedupeDropAlerts";

const ROLLUP_INTERVAL_MS = 60 * 60_000; // hourly
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
// Raw audit rows are kept for 14 days; rollups for 90 days.
const RAW_RETENTION_MS = 14 * 24 * 60 * 60_000;
const ROLLUP_RETENTION_DAYS = 90;

let rollupTimer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Task #1937 — surface table size + last-prune counts.
 *
 * Operators need to see how big each pool-epic background table is and
 * how many rows the most-recent prune sweep removed, so a silently
 * broken prune (or a sudden growth spike) doesn't only show up as a
 * slow database. The five tracked tables are the ones pruneTick()
 * already deletes from.
 */
export const POOL_AUDIT_TRACKED_TABLES = [
  "external_call_audits",
  "external_call_audit_daily_rollups",
  "db_hold_label_rollups",
  "dedupe_drop_verdict_rollups",
  "dedupe_drop_active_chains",
] as const;

export type PoolAuditTrackedTable = (typeof POOL_AUDIT_TRACKED_TABLES)[number];

type LastPruneRecord = { deleted: number; prunedAt: number };

const lastPruneByTable = new Map<PoolAuditTrackedTable, LastPruneRecord>();

function recordPruneResult(table: PoolAuditTrackedTable, deleted: number): void {
  lastPruneByTable.set(table, { deleted, prunedAt: Date.now() });
}

export type PoolAuditTableSizeRow = {
  table: PoolAuditTrackedTable;
  rowCount: number | null;
  rowCountError: string | null;
  lastPruneDeleted: number | null;
  lastPruneAt: number | null;
};

export async function getPoolAuditTableSizes(): Promise<PoolAuditTableSizeRow[]> {
  const out: PoolAuditTableSizeRow[] = [];
  for (const table of POOL_AUDIT_TRACKED_TABLES) {
    const last = lastPruneByTable.get(table) ?? null;
    let rowCount: number | null = null;
    let rowCountError: string | null = null;
    try {
      // Use the planner's reltuples estimate so this stays O(1) on
      // large tables — exact COUNT(*) would force a seq scan every
      // 60s when the admin trends page polls.
      const res = await workerDb.execute<any>(sql`
        SELECT COALESCE(reltuples, 0)::bigint AS estimate
        FROM pg_class
        WHERE oid = to_regclass(${table})
      `);
      const rows = (res as any).rows ?? (Array.isArray(res) ? res : []);
      const estimate = rows[0]?.estimate;
      rowCount = estimate == null ? 0 : Number(estimate);
      if (!Number.isFinite(rowCount)) rowCount = null;
      if (rowCount != null && rowCount < 0) rowCount = 0;
    } catch (err: any) {
      rowCountError = err?.message ?? String(err);
    }
    out.push({
      table,
      rowCount,
      rowCountError,
      lastPruneDeleted: last?.deleted ?? null,
      lastPruneAt: last?.prunedAt ?? null,
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

export async function runExternalCallAuditRollup(targetDateMs: number): Promise<number> {
  if (!isPoolEpicSwitchEnabled("external_call_audit_enabled")) return 0;
  const dayStart = startOfUtcDay(targetDateMs);
  const dayEnd = dayStart + 24 * 60 * 60_000;
  const dateStr = utcDateString(dayStart);

  return dbRetry(async () => {
    // Aggregate + upsert in a single statement so the writer doesn't
    // double-count on retry. `caller_label` defaults to "" (NOT NULL) so
    // the unique key (date, integration, endpoint, caller_label) is
    // always populated.
    const res = await workerDb.execute<any>(sql`
      INSERT INTO external_call_audit_daily_rollups (
        date, integration, endpoint, caller_label,
        call_count, error_count, avg_duration_ms, p95_duration_ms,
        cache_hit_count, same_response_count, total_response_bytes
      )
      SELECT
        ${dateStr}::varchar AS date,
        integration,
        endpoint,
        COALESCE(caller_label, '') AS caller_label,
        COUNT(*)::int AS call_count,
        COUNT(*) FILTER (WHERE error_class IS NOT NULL)::int AS error_count,
        AVG(duration_ms)::int AS avg_duration_ms,
        PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_duration_ms,
        COUNT(*) FILTER (WHERE response_cache_hit)::int AS cache_hit_count,
        COUNT(*) FILTER (WHERE same_response_as_previous)::int AS same_response_count,
        COALESCE(SUM(response_size_bytes), 0)::bigint AS total_response_bytes
      FROM external_call_audits
      WHERE called_at >= ${dayStart} AND called_at < ${dayEnd}
      GROUP BY integration, endpoint, COALESCE(caller_label, '')
      ON CONFLICT (date, integration, endpoint, caller_label)
      DO UPDATE SET
        call_count = EXCLUDED.call_count,
        error_count = EXCLUDED.error_count,
        avg_duration_ms = EXCLUDED.avg_duration_ms,
        p95_duration_ms = EXCLUDED.p95_duration_ms,
        cache_hit_count = EXCLUDED.cache_hit_count,
        same_response_count = EXCLUDED.same_response_count,
        total_response_bytes = EXCLUDED.total_response_bytes,
        updated_at = NOW()
    `);
    const count = (res as any)?.rowCount ?? (Array.isArray(res) ? res.length : 0);
    return Number(count) || 0;
  }, "externalCallAuditRollup");
}

export async function runDbHoldLabelRollup(targetDateMs: number): Promise<number> {
  if (!isPoolEpicSwitchEnabled("db_hold_rollup_enabled")) return 0;
  const dayStart = startOfUtcDay(targetDateMs);
  const dayEnd = dayStart + 24 * 60 * 60_000;
  const dateStr = utcDateString(dayStart);

  return dbRetry(async () => {
    // `top_hold_labels` is a JSONB blob with shape:
    //   { byCount: [{label, count, maxMs, totalMs}, ...],
    //     byMaxMs: [...], byTotalMs: [...] }
    // We aggregate `byCount` since it carries every label's count + max +
    // total. UNNEST yields one row per (sample × label).
    const res = await workerDb.execute<any>(sql`
      WITH expanded AS (
        SELECT
          pss.pool_name AS pool,
          pss.sampled_at,
          (elem ->> 'label')::varchar(256) AS hold_label,
          COALESCE((elem ->> 'count')::int, 0) AS cnt,
          COALESCE((elem ->> 'maxMs')::int, 0) AS max_ms,
          COALESCE((elem ->> 'totalMs')::bigint, 0) AS total_ms
        FROM pool_state_samples pss,
             jsonb_array_elements(COALESCE(pss.top_hold_labels -> 'byCount', '[]'::jsonb)) AS elem
        WHERE pss.sampled_at >= ${dayStart}
          AND pss.sampled_at < ${dayEnd}
          AND elem ? 'label'
      ),
      agg AS (
        SELECT
          pool,
          hold_label,
          SUM(cnt)::int AS count,
          MAX(max_ms)::int AS max_duration_ms,
          CASE WHEN SUM(cnt) > 0 THEN (SUM(total_ms) / SUM(cnt))::int ELSE NULL END AS avg_duration_ms,
          MAX(max_ms)::int AS p95_duration_ms,
          SUM(total_ms)::bigint AS total_hold_time_ms,
          MIN(sampled_at)::bigint AS first_seen_at,
          MAX(sampled_at)::bigint AS last_seen_at
        FROM expanded
        WHERE hold_label IS NOT NULL AND hold_label <> ''
        GROUP BY pool, hold_label
      )
      INSERT INTO db_hold_label_rollups (
        date, pool, hold_label, count, max_duration_ms, avg_duration_ms,
        p95_duration_ms, total_hold_time_ms, first_seen_at, last_seen_at
      )
      SELECT
        ${dateStr}::varchar AS date,
        pool, hold_label, count, max_duration_ms, avg_duration_ms,
        p95_duration_ms, total_hold_time_ms, first_seen_at, last_seen_at
      FROM agg
      ON CONFLICT (date, pool, hold_label)
      DO UPDATE SET
        count = EXCLUDED.count,
        max_duration_ms = EXCLUDED.max_duration_ms,
        avg_duration_ms = EXCLUDED.avg_duration_ms,
        p95_duration_ms = EXCLUDED.p95_duration_ms,
        total_hold_time_ms = EXCLUDED.total_hold_time_ms,
        last_seen_at = EXCLUDED.last_seen_at,
        updated_at = NOW()
    `);
    const count = (res as any)?.rowCount ?? (Array.isArray(res) ? res.length : 0);
    return Number(count) || 0;
  }, "dbHoldLabelRollup");
}

async function rollupTick(): Promise<void> {
  const now = Date.now();
  // Refresh today + yesterday on every tick so partial-day rows close out
  // and late-arriving inserts are captured without manual reruns.
  for (const offset of [0, 24 * 60 * 60_000]) {
    try {
      await runExternalCallAuditRollup(now - offset);
    } catch (err: any) {
      console.warn(
        `[PoolAuditRollups] external-call rollup failed (offset=${offset}):`,
        err?.message ?? err,
      );
    }
    try {
      await runDbHoldLabelRollup(now - offset);
    } catch (err: any) {
      console.warn(
        `[PoolAuditRollups] db-hold rollup failed (offset=${offset}):`,
        err?.message ?? err,
      );
    }
  }
}

async function pruneTick(): Promise<void> {
  const now = Date.now();
  const rawCutoff = now - RAW_RETENTION_MS;
  const rollupCutoff = utcDateString(now - ROLLUP_RETENTION_DAYS * 24 * 60 * 60_000);
  try {
    const r1 = await workerDb.execute<any>(sql`
      DELETE FROM external_call_audits WHERE called_at < ${rawCutoff}
    `);
    const removed = Number((r1 as any)?.rowCount ?? 0);
    recordPruneResult("external_call_audits", removed);
    if (removed > 0) {
      console.log(`[PoolAuditRollups] pruned ${removed} raw external_call_audits (>14d)`);
    }
  } catch (err: any) {
    console.warn("[PoolAuditRollups] raw audit prune failed:", err?.message ?? err);
  }
  try {
    const r2 = await workerDb.execute<any>(sql`
      DELETE FROM external_call_audit_daily_rollups WHERE date < ${rollupCutoff}
    `);
    const removed = Number((r2 as any)?.rowCount ?? 0);
    recordPruneResult("external_call_audit_daily_rollups", removed);
    if (removed > 0) {
      console.log(`[PoolAuditRollups] pruned ${removed} external_call_audit_daily_rollups (>${ROLLUP_RETENTION_DAYS}d)`);
    }
  } catch (err: any) {
    console.warn("[PoolAuditRollups] rollup prune failed:", err?.message ?? err);
  }
  try {
    const r3 = await workerDb.execute<any>(sql`
      DELETE FROM db_hold_label_rollups WHERE date < ${rollupCutoff}
    `);
    const removed = Number((r3 as any)?.rowCount ?? 0);
    recordPruneResult("db_hold_label_rollups", removed);
    if (removed > 0) {
      console.log(`[PoolAuditRollups] pruned ${removed} db_hold_label_rollups (>${ROLLUP_RETENTION_DAYS}d)`);
    }
  } catch (err: any) {
    console.warn("[PoolAuditRollups] hold rollup prune failed:", err?.message ?? err);
  }
  // Task #1913 — keep the apply-layer dedupe drop tables small.
  // Verdict rollups follow the same 90-day retention as the other
  // pool-epic rollup tables. Active-chain rows whose observed_at has
  // not advanced in 7 days are dropped so the admin panel's "active
  // chains" list reflects actually-live incidents instead of stuck
  // rows for windows that will never produce another sample.
  const verdictRollupCutoff = utcDateString(
    now - DEDUPE_DROP_VERDICT_ROLLUP_RETENTION_DAYS * 24 * 60 * 60_000,
  );
  const activeChainStaleCutoff = now - DEDUPE_DROP_ACTIVE_CHAIN_STALE_MS;
  try {
    const r4 = await workerDb.execute<any>(sql`
      DELETE FROM dedupe_drop_verdict_rollups WHERE date < ${verdictRollupCutoff}
    `);
    const removed = Number((r4 as any)?.rowCount ?? 0);
    recordPruneResult("dedupe_drop_verdict_rollups", removed);
    if (removed > 0) {
      console.log(
        `[PoolAuditRollups] pruned ${removed} dedupe_drop_verdict_rollups (>${DEDUPE_DROP_VERDICT_ROLLUP_RETENTION_DAYS}d)`,
      );
    }
  } catch (err: any) {
    console.warn(
      "[PoolAuditRollups] dedupe drop verdict prune failed:",
      err?.message ?? err,
    );
  }
  try {
    const r5 = await workerDb.execute<any>(sql`
      DELETE FROM dedupe_drop_active_chains WHERE observed_at < ${activeChainStaleCutoff}
    `);
    const removed = Number((r5 as any)?.rowCount ?? 0);
    recordPruneResult("dedupe_drop_active_chains", removed);
    if (removed > 0) {
      console.log(
        `[PoolAuditRollups] pruned ${removed} dedupe_drop_active_chains (>${DEDUPE_DROP_ACTIVE_CHAIN_STALE_MS / 86400000}d stale)`,
      );
    }
  } catch (err: any) {
    console.warn(
      "[PoolAuditRollups] dedupe drop active chain prune failed:",
      err?.message ?? err,
    );
  }
}

export function startPoolAuditRollups(): void {
  if (rollupTimer) return;
  // Initial tick so the first 24h window is materialized without waiting
  // a full hour after deploy.
  void withDbAttribution("maintenance:pool-audit-rollup-tick", () =>
    rollupTick().catch((err) =>
      console.warn("[PoolAuditRollups] initial tick failed:", err?.message ?? err),
    ),
  );
  rollupTimer = setInterval(() => {
    void withDbAttribution("maintenance:pool-audit-rollup-tick", () =>
      rollupTick().catch((err) =>
        console.warn("[PoolAuditRollups] tick failed:", err?.message ?? err),
      ),
    );
  }, ROLLUP_INTERVAL_MS);
  pruneTimer = setInterval(() => {
    void withDbAttribution("maintenance:pool-audit-rollup-prune", () =>
      pruneTick(),
    );
  }, PRUNE_INTERVAL_MS);
  if (typeof (rollupTimer as any).unref === "function") (rollupTimer as any).unref();
  if (typeof (pruneTimer as any).unref === "function") (pruneTimer as any).unref();
  console.log(
    `[PoolAuditRollups] started — rollup hourly, raw retention ${RAW_RETENTION_MS / 86400000}d, rollup retention ${ROLLUP_RETENTION_DAYS}d`,
  );
}

export function stopPoolAuditRollups(): void {
  if (rollupTimer) {
    clearInterval(rollupTimer);
    rollupTimer = null;
  }
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

export const __test = {
  rollupTick,
  pruneTick,
  utcDateString,
  startOfUtcDay,
};
