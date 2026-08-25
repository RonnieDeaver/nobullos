/**
 * Task #1728 (Pool epic Phase 1.5.3) — admin trend endpoints powering
 * `/admin/db-attribution/trends`.
 *
 * All endpoints require `team_lead` (existing admin gate) and read from
 * the daily rollup tables (`db_hold_label_rollups`,
 * `external_call_audit_daily_rollups`) plus the live audit table for the
 * "today" and "front recovery backoff frequency" slices.
 */

import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { workerDb, withDbAttribution } from "../db";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";
import { getActiveLongHoldAlerts, getLongHoldCounters } from "../services/longDbHoldAlerts";
import { getActiveExternalCallAlerts } from "../services/externalCallAuditAlerts";
import { getFrontWarpSchedulerStatus } from "../services/workScheduler";
import {
  getFrontWarpSettings,
  getFrontWarpGuardCounters,
  getRecentFront429Count,
  FRONT_WARP_QUEUE_NAMES,
} from "../services/frontWarpSettings";
import {
  getFrontIngestionClassConcurrency,
  getFrontIngestionManualReserve,
  TOTAL_BUDGET,
} from "../services/workloadManager";
import { isPoolEpicSwitchEnabled } from "../services/poolEpicKillSwitches";
import { getWorkerPoolSnapshot, getApiPoolSnapshot } from "../db";
import { getDedupeDropState } from "../services/frontRecoveryDedupeDropAlerts";
import { getPoolAuditTableSizes } from "../services/poolAuditRollups";
import { getFrontParkSummary } from "../services/frontAutoClosure";
import { evaluateFrontMirrorFreshness } from "../services/frontMirrorFreshnessAlerts";

function utcDateString(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function rows<T = any>(q: any): Promise<T[]> {
  const r = await q;
  return (Array.isArray(r) ? r : (r as any).rows ?? []) as T[];
}

export function registerPoolAuditTrendRoutes(app: Express): void {
  app.get(
    "/api/admin/db-attribution/trends",
    isAuthenticated,
    requireTeamLead,
    async (_req: Request, res: Response) => {
      try {
        const payload = await withDbAttribution("route:db-attribution-trends", async () => {
          const now = Date.now();
          const today = utcDateString(now);
          const sevenDaysAgo = utcDateString(now - 7 * 24 * 60 * 60_000);
          const fourteenDaysAgo = utcDateString(now - 14 * 24 * 60 * 60_000);
          const last1h = now - 60 * 60_000;
          const last24h = now - 24 * 60 * 60_000;

          // 1. Top DB hold labels today.
          const topHoldsToday = await rows(
            workerDb.execute(sql`
              SELECT pool, hold_label, count, max_duration_ms, avg_duration_ms,
                     p95_duration_ms, total_hold_time_ms
              FROM db_hold_label_rollups
              WHERE date = ${today}
              ORDER BY total_hold_time_ms DESC
              LIMIT 20
            `),
          );

          // 2. Top WoW movers — compare last 7 days vs the prior 7 days.
          const wowMovers = await rows(
            workerDb.execute(sql`
              WITH curr AS (
                SELECT pool, hold_label,
                       SUM(count)::int AS c,
                       SUM(total_hold_time_ms)::bigint AS t
                FROM db_hold_label_rollups
                WHERE date >= ${sevenDaysAgo} AND date <= ${today}
                GROUP BY pool, hold_label
              ),
              prev AS (
                SELECT pool, hold_label,
                       SUM(count)::int AS c,
                       SUM(total_hold_time_ms)::bigint AS t
                FROM db_hold_label_rollups
                WHERE date >= ${fourteenDaysAgo} AND date < ${sevenDaysAgo}
                GROUP BY pool, hold_label
              )
              SELECT
                COALESCE(curr.pool, prev.pool) AS pool,
                COALESCE(curr.hold_label, prev.hold_label) AS hold_label,
                COALESCE(curr.c, 0) AS curr_count,
                COALESCE(prev.c, 0) AS prev_count,
                COALESCE(curr.t, 0) AS curr_total_ms,
                COALESCE(prev.t, 0) AS prev_total_ms
              FROM curr FULL OUTER JOIN prev USING (pool, hold_label)
              ORDER BY (COALESCE(curr.t, 0) - COALESCE(prev.t, 0)) DESC
              LIMIT 20
            `),
          );

          // 3. Longest max holds in the last 7 days.
          const longestMaxHolds = await rows(
            workerDb.execute(sql`
              SELECT pool, hold_label, MAX(max_duration_ms)::int AS max_duration_ms,
                     SUM(count)::int AS count
              FROM db_hold_label_rollups
              WHERE date >= ${sevenDaysAgo}
              GROUP BY pool, hold_label
              ORDER BY max_duration_ms DESC
              LIMIT 20
            `),
          );

          // 4. Labels exceeding 10s, last 7 days.
          const labelsOver10s = await rows(
            workerDb.execute(sql`
              SELECT pool, hold_label, MAX(max_duration_ms)::int AS max_duration_ms,
                     SUM(count)::int AS count, MAX(date) AS last_date
              FROM db_hold_label_rollups
              WHERE date >= ${sevenDaysAgo} AND max_duration_ms >= 10000
              GROUP BY pool, hold_label
              ORDER BY max_duration_ms DESC
              LIMIT 50
            `),
          );

          // 5. Background work hitting the API pool — any label whose
          // pool=api looks like a worker/maintenance/job (i.e. NOT
          // `route:*`). This is the canonical attribution-leak symptom.
          const backgroundOnApi = await rows(
            workerDb.execute(sql`
              SELECT hold_label,
                     SUM(count)::int AS count,
                     MAX(max_duration_ms)::int AS max_duration_ms,
                     SUM(total_hold_time_ms)::bigint AS total_hold_time_ms
              FROM db_hold_label_rollups
              WHERE date >= ${sevenDaysAgo}
                AND pool = 'api'
                AND hold_label NOT LIKE 'route:%'
              GROUP BY hold_label
              ORDER BY total_hold_time_ms DESC
              LIMIT 20
            `),
          );

          // 6. External call volume + cache-hit + same-response by integration.
          const externalByIntegration = await rows(
            workerDb.execute(sql`
              SELECT
                integration,
                SUM(call_count)::int AS call_count,
                SUM(error_count)::int AS error_count,
                SUM(cache_hit_count)::int AS cache_hit_count,
                SUM(same_response_count)::int AS same_response_count,
                CASE WHEN SUM(call_count) > 0
                     THEN (SUM(cache_hit_count)::float / SUM(call_count))
                     ELSE 0 END AS cache_hit_ratio,
                CASE WHEN SUM(call_count) > 0
                     THEN (SUM(same_response_count)::float / SUM(call_count))
                     ELSE 0 END AS same_response_ratio,
                SUM(total_response_bytes)::bigint AS total_response_bytes
              FROM external_call_audit_daily_rollups
              WHERE date >= ${sevenDaysAgo}
              GROUP BY integration
              ORDER BY call_count DESC
            `),
          );

          // 7. Top noisy endpoints — biggest contributors to same-response /
          // repeated calls in last 7 days.
          const noisyEndpoints = await rows(
            workerDb.execute(sql`
              SELECT integration, endpoint, caller_label,
                     SUM(call_count)::int AS call_count,
                     SUM(same_response_count)::int AS same_response_count,
                     SUM(cache_hit_count)::int AS cache_hit_count
              FROM external_call_audit_daily_rollups
              WHERE date >= ${sevenDaysAgo}
              GROUP BY integration, endpoint, caller_label
              ORDER BY same_response_count DESC
              LIMIT 25
            `),
          );

          // 8. Front recovery backoff frequency (live audit table, last
          // 24h). The Front recovery worker re-enters the wrapper each
          // time it backs off and retries, so call_count at the
          // `route:front-recovery` caller_label is the backoff frequency.
          // If audits are disabled this comes back empty — that's fine.
          const frontRecoveryBackoff = await rows(
            workerDb.execute(sql`
              SELECT caller_label,
                     COUNT(*)::int AS call_count_24h,
                     COUNT(*) FILTER (WHERE status_code = 429)::int AS rate_limited_count,
                     COUNT(*) FILTER (WHERE called_at >= ${last1h})::int AS call_count_1h
              FROM external_call_audits
              WHERE integration = 'front'
                AND called_at >= ${last24h}
                AND caller_label IS NOT NULL
              GROUP BY caller_label
              ORDER BY call_count_24h DESC
              LIMIT 10
            `),
          );

          // Task #1731 (Pool epic Phase 4) — surface active runtime
          // alerts so operators can spot in-flight incidents without
          // tabbing to Slack. Both lists are in-memory and cheap.
          const activeLongHolds = getActiveLongHoldAlerts();
          const longHoldCounters = getLongHoldCounters();
          const activeExternalCallAlerts = getActiveExternalCallAlerts();

          // Task #1829 Phase 6 — Front pipeline throughput panel.
          // Reads the live (in-memory) scheduler/settings/guards state
          // plus a single SQL pass over the 3 Front queues for backlog
          // + 5-min completion counts. All values are cheap; the query
          // pulls a few-hundred-row aggregate at most.
          const frontWarpRows = (
            await workerDb.execute<{
              queue_name: string;
              workload_class: string;
              pending: number;
              processing: number;
              completed_5m: number;
              completed_30m: number;
              oldest_pending_age_sec: number | null;
            }>(sql`
              SELECT
                queue_name,
                workload_class,
                COUNT(*) FILTER (WHERE status = 'pending')::int                                          AS pending,
                COUNT(*) FILTER (WHERE status IN ('leased','processing'))::int                          AS processing,
                COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= NOW() - INTERVAL '5 minutes')::int  AS completed_5m,
                COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= NOW() - INTERVAL '30 minutes')::int AS completed_30m,
                EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status = 'pending')))::int    AS oldest_pending_age_sec
              FROM work_queue
              WHERE queue_name IN (${sql.join(
                FRONT_WARP_QUEUE_NAMES.map((n) => sql`${n}`),
                sql`, `,
              )})
                AND (
                  status IN ('pending','leased','processing')
                  OR (status = 'completed' AND completed_at >= NOW() - INTERVAL '30 minutes')
                )
              GROUP BY queue_name, workload_class
              ORDER BY queue_name, workload_class
            `)
          ).rows as any[];

          const frontWarp = {
            scheduler: getFrontWarpSchedulerStatus(),
            settings: getFrontWarpSettings(),
            classCap: getFrontIngestionClassConcurrency(),
            manualReserve: getFrontIngestionManualReserve(),
            totalBudget: TOTAL_BUDGET,
            killSwitches: {
              front_warp_speed_enabled: isPoolEpicSwitchEnabled("front_warp_speed_enabled"),
              front_ingestion_api_waiter_backoff_enabled: isPoolEpicSwitchEnabled(
                "front_ingestion_api_waiter_backoff_enabled",
              ),
              front_ingestion_front_rate_limit_guard_enabled: isPoolEpicSwitchEnabled(
                "front_ingestion_front_rate_limit_guard_enabled",
              ),
            },
            guardCounters: getFrontWarpGuardCounters(),
            recentFront429: getRecentFront429Count(),
            workerPool: getWorkerPoolSnapshot(),
            apiPool: getApiPoolSnapshot(),
            perQueue: frontWarpRows,
          };

          // Task #1872 / Task #1907 — apply-layer drop panel data.
          // Recent per-sample buffer is in-memory ("right now"); verdict
          // counters + active chains are read from the persisted
          // rollup so the headline drop-rate and chain table survive
          // process restarts.
          const dedupeDrop = await getDedupeDropState();

          // Task #1937 — table-size + last-prune visibility for the
          // pool-epic background tables. Uses pg_class reltuples so
          // it stays O(1) on the hourly admin-trends poll.
          const poolAuditTableSizes = await getPoolAuditTableSizes();

          // Task #2088 — Front recovery parked-window visibility. Pure
          // read of the auto-closure state (currently-parked set) plus
          // its bounded park/unpark breadcrumb log (period counts).
          // Cheap; no SQL. Window matches the other 7d series.
          const frontParkedWindows = await getFrontParkSummary({
            sinceMs: now - 7 * 24 * 60 * 60_000,
          }).catch((err: any) => {
            console.warn(
              "[PoolAuditTrends] getFrontParkSummary failed:",
              err?.message ?? err,
            );
            return null;
          });

          // Task #2171 — always-visible Front mirror freshness. Reuses
          // the exact evaluation core the Task #2146 watcher and the
          // Task #2172 auto-recovery prod-action use, so the panel and
          // the alert can never disagree. The kill switch is NOT
          // consulted here (we always want to show health); the pure
          // evaluation is two MAX subqueries, cheap on the hourly poll.
          const frontMirrorFreshness = await evaluateFrontMirrorFreshness(
            now,
          ).catch((err: any) => {
            console.warn(
              "[PoolAuditTrends] evaluateFrontMirrorFreshness failed:",
              err?.message ?? err,
            );
            return null;
          });

          return {
            generatedAt: now,
            topHoldsToday,
            wowMovers,
            longestMaxHolds,
            labelsOver10s,
            backgroundOnApi,
            externalByIntegration,
            noisyEndpoints,
            frontRecoveryBackoff,
            activeLongHolds,
            longHoldCounters,
            activeExternalCallAlerts,
            frontWarp,
            dedupeDrop,
            poolAuditTableSizes,
            frontParkedWindows,
            frontMirrorFreshness,
          };
        });
        res.json(payload);
      } catch (err: any) {
        console.error("[PoolAuditTrends] route failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to load trends" });
      }
    },
  );
}
