/**
 * Task #861 Phase 5 — DB server-side metrics.
 *
 * Admin-gated, cached, timeout-protected SELECT-only queries against
 * pg_stat_statements / pg_locks / pg_stat_user_tables / pg_stat_activity.
 *
 * Safety rules (non-negotiable):
 *   - SELECT only. No DDL, no advisory locks, no writes.
 *   - Hard 2s statement timeout per query (set per-session via SET LOCAL).
 *   - Row limits on every result set.
 *   - 30s in-memory cache; concurrent callers share a single in-flight
 *     promise so a dashboard refresh storm cannot fan out N identical
 *     queries against the production DB.
 *   - Graceful "unavailable" fallback when an extension or permission
 *     is missing — never bubbles up as a 500.
 */

// Task #1573 (Audit Track C) + Pool Epic Phase 2.2: on-demand admin
// diagnostics use the worker pool, NOT `probePool` (which is reserved
// exclusively for the 30s health sampler, max 1 connection). An admin
// clicking "Server Metrics" while the sampler is running would otherwise
// starve the probe. Imported as `workerPool` (no alias) so the
// `lint-db-pool-tenancy` guard can verify tenancy at a glance and we
// don't accidentally read the misleading old name elsewhere.
import { workerPool } from "../db";
import type { PoolClient } from "pg";
import { PERF } from "../perfConfig";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";

// Task #1850 — On-demand admin diagnostics gated on a dedicated
// `db_server_metrics_enabled` kill switch AND the global
// `KILL_SWITCH_NON_CRITICAL_SWEEPS`. Default ON so behavior is
// unchanged; flip either off via `system_settings` / env to halt all
// outbound pg_stat_* probes without a redeploy. When disabled every
// fetcher returns an `available: false` envelope — no DB work, no
// cache write, no external calls.
function metricsKillSwitchSkipReason(): string | null {
  if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
    return "KILL_SWITCH_NON_CRITICAL_SWEEPS=true";
  }
  if (!isPoolEpicSwitchEnabled("db_server_metrics_enabled")) {
    return "db_server_metrics_enabled=false";
  }
  return null;
}

function disabledEnvelope<T>(
  source: string,
  data: T,
  reason: string,
): MetricEnvelope<T> {
  console.log(`[DbServerMetrics] ${source} skipped — ${reason}`);
  return {
    available: false,
    unavailableReason: `Disabled by kill switch (${reason})`,
    generatedAt: Date.now(),
    source,
    data,
  };
}

const CACHE_TTL_MS = 30_000;
const QUERY_TIMEOUT_MS = 2_000;
const SLOW_QUERY_LIMIT = 25;
const LOCK_LIMIT = 50;
const TABLE_HEALTH_LIMIT = 20;

type Cached<T> = { value: T; expires: number };
const cache = new Map<string, Cached<any>>();
const inflight = new Map<string, Promise<any>>();

export interface MetricEnvelope<T> {
  available: boolean;
  unavailableReason?: string;
  generatedAt: number;
  source: string;
  data: T;
}

export interface SlowQueryRow {
  query: string;
  calls: number;
  totalTimeMs: number;
  meanTimeMs: number;
  rows: number;
  shared_blks_hit?: number | null;
}

export interface LockRow {
  blockingPid: number | null;
  blockedPid: number;
  blockingQuery: string | null;
  blockedQuery: string;
  waitDurationMs: number;
  relation: string | null;
  lockType: string | null;
  state: string | null;
}

export interface TableHealthRow {
  schema: string;
  table: string;
  liveTuples: number;
  deadTuples: number;
  deadTupleRatio: number;
  tableSizeBytes: number;
  indexSizeBytes: number;
  lastVacuum: string | null;
  lastAutovacuum: string | null;
  lastAnalyze: string | null;
  lastAutoanalyze: string | null;
}

export interface MetricAvailabilityStatus {
  feature: string;
  available: boolean;
  reason?: string;
  lastCheckedAt: number;
}

/**
 * Run `fn` inside a `BEGIN READ ONLY` transaction with `SET LOCAL
 * statement_timeout = ${QUERY_TIMEOUT_MS}`, then ROLLBACK. The transaction is
 * essential for `SET LOCAL` to actually scope the timeout to the queries we
 * run inside — outside an explicit transaction `SET LOCAL` only takes effect
 * for the SET statement itself and is then immediately discarded, leaving
 * subsequent queries unprotected. We also wrap the per-query execution in
 * a wall-clock `Promise.race` as a defense-in-depth backstop in case the
 * driver, network, or session swallows the server-side cancel.
 */
async function withProbeClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await workerPool.connect();
  let txOpen = false;
  try {
    await client.query("BEGIN READ ONLY");
    txOpen = true;
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    const work = fn(client);
    const guardMs = QUERY_TIMEOUT_MS + 500;
    const guard = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`statement timeout (client guard ${guardMs}ms)`)), guardMs).unref?.(),
    );
    return (await Promise.race([work, guard])) as T;
  } finally {
    if (txOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
    }
    client.release();
  }
}

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = (async () => {
    try {
      const value = await fn();
      cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

export async function getSlowQueries(): Promise<MetricEnvelope<SlowQueryRow[]>> {
  const skip = metricsKillSwitchSkipReason();
  if (skip) return disabledEnvelope<SlowQueryRow[]>("pg_stat_statements", [], skip);
  return cached("slowQueries", async () => {
    const generatedAt = Date.now();
    try {
      return await withProbeClient(async (client) => {
        const r = await client.query(
          `SELECT query, calls, total_exec_time, mean_exec_time, rows, shared_blks_hit
           FROM pg_stat_statements
           ORDER BY total_exec_time DESC
           LIMIT $1`,
          [SLOW_QUERY_LIMIT],
        );
        const data = r.rows.map((row: any) => ({
          query: String(row.query ?? "").slice(0, 1000),
          calls: Number(row.calls ?? 0),
          totalTimeMs: Math.round(Number(row.total_exec_time ?? 0)),
          meanTimeMs: Math.round(Number(row.mean_exec_time ?? 0) * 100) / 100,
          rows: Number(row.rows ?? 0),
          shared_blks_hit: row.shared_blks_hit !== undefined ? Number(row.shared_blks_hit) : null,
        }));
        return {
          available: true,
          generatedAt,
          source: "pg_stat_statements",
          data,
        } satisfies MetricEnvelope<SlowQueryRow[]>;
      });
    } catch (err: any) {
      const message = String(err?.message ?? err);
      return {
        available: false,
        unavailableReason: detectUnavailable(message, "pg_stat_statements"),
        generatedAt,
        source: "pg_stat_statements",
        data: [],
      } satisfies MetricEnvelope<SlowQueryRow[]>;
    }
  });
}

export async function getLocks(): Promise<MetricEnvelope<LockRow[]>> {
  const skip = metricsKillSwitchSkipReason();
  if (skip) return disabledEnvelope<LockRow[]>("pg_locks", [], skip);
  return cached("locks", async () => {
    const generatedAt = Date.now();
    try {
      return await withProbeClient(async (client) => {
        const r = await client.query(
          `SELECT
              blocked.pid AS blocked_pid,
              blocking.pid AS blocking_pid,
              blocked.query AS blocked_query,
              blocking.query AS blocking_query,
              blocked.state AS state,
              blocked.wait_event_type AS wait_event_type,
              EXTRACT(EPOCH FROM (now() - blocked.xact_start)) * 1000 AS wait_ms,
              bl.locktype AS locktype,
              bl.relation::regclass::text AS relation
            FROM pg_stat_activity blocked
            JOIN pg_locks bl ON bl.pid = blocked.pid AND bl.granted = false
            LEFT JOIN pg_stat_activity blocking
              ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
            WHERE blocked.wait_event_type IN ('Lock','LWLock','BufferPin')
            LIMIT $1`,
          [LOCK_LIMIT],
        );
        const data: LockRow[] = r.rows.map((row: any) => ({
          blockedPid: Number(row.blocked_pid),
          blockingPid: row.blocking_pid !== null ? Number(row.blocking_pid) : null,
          blockedQuery: String(row.blocked_query ?? "").slice(0, 500),
          blockingQuery: row.blocking_query ? String(row.blocking_query).slice(0, 500) : null,
          waitDurationMs: row.wait_ms !== null ? Math.round(Number(row.wait_ms)) : 0,
          relation: row.relation ?? null,
          lockType: row.locktype ?? null,
          state: row.state ?? null,
        }));
        return {
          available: true,
          generatedAt,
          source: "pg_locks + pg_stat_activity",
          data,
        };
      });
    } catch (err: any) {
      const message = String(err?.message ?? err);
      return {
        available: false,
        unavailableReason: detectUnavailable(message, "pg_locks"),
        generatedAt,
        source: "pg_locks",
        data: [],
      };
    }
  });
}

export async function getTableHealth(): Promise<MetricEnvelope<TableHealthRow[]>> {
  const skip = metricsKillSwitchSkipReason();
  if (skip) return disabledEnvelope<TableHealthRow[]>("pg_stat_user_tables", [], skip);
  return cached("tableHealth", async () => {
    const generatedAt = Date.now();
    try {
      return await withProbeClient(async (client) => {
        const r = await client.query(
          `SELECT
              schemaname,
              relname,
              n_live_tup,
              n_dead_tup,
              last_vacuum,
              last_autovacuum,
              last_analyze,
              last_autoanalyze,
              pg_total_relation_size(relid) AS total_size,
              pg_indexes_size(relid) AS index_size
            FROM pg_stat_user_tables
            ORDER BY pg_total_relation_size(relid) DESC NULLS LAST
            LIMIT $1`,
          [TABLE_HEALTH_LIMIT],
        );
        const data: TableHealthRow[] = r.rows.map((row: any) => {
          const live = Number(row.n_live_tup ?? 0);
          const dead = Number(row.n_dead_tup ?? 0);
          const ratio = live + dead > 0 ? Math.round((dead / (live + dead)) * 1000) / 10 : 0;
          return {
            schema: row.schemaname,
            table: row.relname,
            liveTuples: live,
            deadTuples: dead,
            deadTupleRatio: ratio,
            tableSizeBytes: Number(row.total_size ?? 0),
            indexSizeBytes: Number(row.index_size ?? 0),
            lastVacuum: row.last_vacuum ? new Date(row.last_vacuum).toISOString() : null,
            lastAutovacuum: row.last_autovacuum ? new Date(row.last_autovacuum).toISOString() : null,
            lastAnalyze: row.last_analyze ? new Date(row.last_analyze).toISOString() : null,
            lastAutoanalyze: row.last_autoanalyze ? new Date(row.last_autoanalyze).toISOString() : null,
          };
        });
        return {
          available: true,
          generatedAt,
          source: "pg_stat_user_tables",
          data,
        };
      });
    } catch (err: any) {
      const message = String(err?.message ?? err);
      return {
        available: false,
        unavailableReason: detectUnavailable(message, "pg_stat_user_tables"),
        generatedAt,
        source: "pg_stat_user_tables",
        data: [],
      };
    }
  });
}

export async function getMetricAvailability(): Promise<MetricEnvelope<MetricAvailabilityStatus[]>> {
  const skip = metricsKillSwitchSkipReason();
  if (skip) return disabledEnvelope<MetricAvailabilityStatus[]>("diagnostic-probes", [], skip);
  return cached("metricAvailability", async () => {
    const now = Date.now();
    const probes: MetricAvailabilityStatus[] = [];

    async function probeFeature(feature: string, query: string): Promise<MetricAvailabilityStatus> {
      try {
        return await withProbeClient(async (client) => {
          await client.query(query);
          return { feature, available: true, lastCheckedAt: now };
        });
      } catch (err: any) {
        return {
          feature,
          available: false,
          reason: detectUnavailable(String(err?.message ?? err), feature),
          lastCheckedAt: now,
        };
      }
    }

    probes.push(await probeFeature("pg_stat_statements", "SELECT 1 FROM pg_stat_statements LIMIT 1"));
    probes.push(await probeFeature("pg_stat_user_tables", "SELECT 1 FROM pg_stat_user_tables LIMIT 1"));
    probes.push(await probeFeature("pg_stat_activity", "SELECT 1 FROM pg_stat_activity LIMIT 1"));
    probes.push(await probeFeature("pg_locks", "SELECT 1 FROM pg_locks LIMIT 1"));

    return {
      available: true,
      generatedAt: now,
      source: "diagnostic-probes",
      data: probes,
    };
  });
}

function detectUnavailable(message: string, feature: string): string {
  const m = message.toLowerCase();
  if (m.includes("does not exist") || m.includes("undefined table") || m.includes("relation") && m.includes("does not exist")) {
    return `${feature} is not installed in this database. Enable the extension or contact the DB administrator.`;
  }
  if (m.includes("permission denied") || m.includes("must be superuser")) {
    return `Insufficient permission to read ${feature}. Grant pg_read_all_stats or contact the DB administrator.`;
  }
  if (m.includes("statement timeout") || m.includes("canceling statement")) {
    return `${feature} query exceeded the ${QUERY_TIMEOUT_MS}ms safety timeout.`;
  }
  return `${feature} unavailable: ${message.slice(0, 200)}`;
}

export function clearCacheForTest(): void {
  cache.clear();
  inflight.clear();
}
