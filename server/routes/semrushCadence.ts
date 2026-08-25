/**
 * Task #1785 — Admin trend endpoint powering `/admin/semrush/cadence`.
 *
 * Read-only summary of skip-log activity, identical-result hash
 * coverage, active-client volume, and the live cadence settings.
 *
 * All endpoints require `team_lead` (existing admin gate).
 */

import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { workerDb, withDbAttribution } from "../db";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";
import { getCadenceSettings, _resetCadenceSettingsCache } from "../services/semrushCadenceGate";
import { isKillSwitchEnabled } from "../services/killSwitches";
import { isQueuePaused } from "../services/queueDrainControl";

function utcDateString(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function rows<T = any>(q: any): Promise<T[]> {
  const r = await q;
  return (Array.isArray(r) ? r : (r as any).rows ?? []) as T[];
}

export function registerSemrushCadenceRoutes(app: Express): void {
  app.get(
    "/api/admin/semrush/cadence",
    isAuthenticated,
    requireTeamLead,
    async (_req: Request, res: Response) => {
      try {
        const payload = await withDbAttribution("route:semrush-cadence-trends", async () => {
          const now = Date.now();
          const today = utcDateString(now);
          const sevenDaysAgo = utcDateString(now - 7 * 24 * 60 * 60_000);

          const settings = await getCadenceSettings();

          // Daily skip / enqueue rollup over the last 7 days.
          const dailyRollup = await rows(
            workerDb.execute(sql`
              SELECT date::text AS date, queue_name, reason,
                     SUM(count)::int AS count,
                     MAX(client_count)::int AS client_count,
                     MAX(campaign_count)::int AS campaign_count
              FROM semrush_cadence_skip_log
              WHERE date >= ${sevenDaysAgo}::date
              GROUP BY date, queue_name, reason
              ORDER BY date DESC, queue_name, reason
            `),
          );

          // Today's totals by reason.
          const todayByReason = await rows(
            workerDb.execute(sql`
              SELECT reason, SUM(count)::int AS count
              FROM semrush_cadence_skip_log
              WHERE date = ${today}::date
              GROUP BY reason
              ORDER BY count DESC
            `),
          );

          // Identical-hash coverage — how many (campaign, location, snapshot) keys we've seen.
          const hashCoverage = await rows(
            workerDb.execute(sql`
              SELECT COUNT(*)::int AS total_keys,
                     COUNT(DISTINCT campaign_id)::int AS distinct_campaigns,
                     COUNT(DISTINCT location_id)::int AS distinct_locations,
                     MAX(applied_at) AS most_recent_apply
              FROM semrush_last_applied_hashes
            `),
          );

          // Active-client volume.
          const cutoff = new Date(now - settings.activeWindowDays * 24 * 60 * 60 * 1000);
          const activeClients = await rows(
            workerDb.execute(sql`
              SELECT COUNT(*)::int AS active_count
              FROM clients
              WHERE last_viewed_at IS NOT NULL AND last_viewed_at >= ${cutoff}
            `),
          );
          const totalClients = await rows(
            workerDb.execute(sql`SELECT COUNT(*)::int AS total FROM clients`),
          );

          // Dead-letter trend for the two SEMrush queues over 7 days.
          const deadLetters = await rows(
            workerDb.execute(sql`
              SELECT queue_name,
                     COUNT(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letters,
                     COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
              FROM work_queue
              WHERE queue_name IN ('semrush_background_refresh','semrush_report_refresh','semrush_heatmap_apply')
                AND updated_at >= NOW() - INTERVAL '7 days'
              GROUP BY queue_name
            `),
          );

          // Task #1785 review-remediation panels.
          // 1) Live queue-pause state for the three SEMrush queues.
          const semrushQueueNames = [
            "semrush_background_refresh",
            "semrush_report_refresh",
            "semrush_heatmap_apply",
          ];
          const queuePauseState = semrushQueueNames.map((q) => ({
            queue_name: q,
            paused: isQueuePaused(q),
          }));

          // 2) Retry-backoff queue depth (rows in failed status with a
          //    scheduled next-retry — i.e. waiting in the backoff curve).
          const retryBackoffDepth = await rows(
            workerDb.execute(sql`
              SELECT COUNT(*)::int AS waiting,
                     MIN(next_retry_at) AS next_due_at,
                     COUNT(*) FILTER (WHERE next_retry_at <= NOW())::int AS due_now
              FROM semrush_location_sync_state
              WHERE status = 'failed' AND next_retry_at IS NOT NULL
            `),
          );

          // 3) Permanent-error triage (terminal: prefix or status=dead_letter).
          const permanentErrors = await rows(
            workerDb.execute(sql`
              SELECT COUNT(*)::int AS terminal_locations,
                     MAX(last_attempt_at) AS most_recent
              FROM semrush_location_sync_state
              WHERE (last_error LIKE 'terminal:%' OR status = 'dead_letter')
            `),
          );
          const permanentErrorsByCategory = await rows(
            workerDb.execute(sql`
              SELECT split_part(regexp_replace(last_error, '^terminal:\\s*', ''), ':', 1) AS category,
                     COUNT(*)::int AS count
              FROM semrush_location_sync_state
              WHERE last_error LIKE 'terminal:%'
              GROUP BY 1
              ORDER BY count DESC
              LIMIT 10
            `),
          );

          // 4) Last-run timestamps per queue (most recent completed job).
          const lastRuns = await rows(
            workerDb.execute(sql`
              SELECT queue_name,
                     MAX(completed_at) AS last_completed_at,
                     COUNT(*) FILTER (WHERE completed_at >= NOW() - INTERVAL '24 hours')::int AS completed_24h
              FROM work_queue
              WHERE queue_name = ANY(ARRAY['semrush_background_refresh','semrush_report_refresh','semrush_heatmap_apply']::text[])
                AND status = 'completed'
              GROUP BY queue_name
            `),
          );

          return {
            generatedAt: new Date().toISOString(),
            settings: {
              ...settings,
              killSwitches: {
                demandDriven: isKillSwitchEnabled("semrush_demand_driven_refresh"),
                autoRetryBackoff: isKillSwitchEnabled("semrush_auto_retry_backoff"),
                identicalResultSuppression: isKillSwitchEnabled(
                  "semrush_identical_result_apply_suppression",
                ),
              },
            },
            dailyRollup,
            todayByReason,
            hashCoverage: hashCoverage[0] ?? null,
            activeClients: {
              active: activeClients[0]?.active_count ?? 0,
              total: totalClients[0]?.total ?? 0,
              windowDays: settings.activeWindowDays,
            },
            deadLetters,
            queuePauseState,
            retryBackoff: retryBackoffDepth[0] ?? { waiting: 0, next_due_at: null, due_now: 0 },
            permanentErrors: {
              total: permanentErrors[0]?.terminal_locations ?? 0,
              mostRecent: permanentErrors[0]?.most_recent ?? null,
              byCategory: permanentErrorsByCategory,
            },
            lastRuns,
          };
        });
        res.json(payload);
      } catch (err: any) {
        console.error("[SemrushCadence] admin trends error:", err);
        res.status(500).json({ error: err?.message || "Failed to load cadence trends" });
      }
    },
  );

  app.post(
    "/api/admin/semrush/cadence/reset-cache",
    isAuthenticated,
    requireTeamLead,
    (_req: Request, res: Response) => {
      _resetCadenceSettingsCache();
      res.json({ ok: true });
    },
  );
}
