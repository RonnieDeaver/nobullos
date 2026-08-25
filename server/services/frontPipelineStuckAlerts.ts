/**
 * Task #1642 — Alert when Front emails get stuck in the pipeline.
 *
 * Background
 * ----------
 * On May 18 2026 a 17,805-row backlog was discovered sitting in
 * `front_sync_emails.pipeline_state='discovered'` because the apply
 * stage had been silently disabled. The coverage report only showed a
 * flat gap (lagging + ambiguous); nothing actively watched the
 * pipeline-state distribution.
 *
 * Task #1640 made the stall *visible on demand* via
 * `scripts/diagnostic_front_recovery_gap.sql` (Q1 + Q3). This watcher
 * runs the same shape of query on a cadence and fires a Slack alert
 * (via the unified `notifyByType` dispatcher) when rows in any
 * non-terminal `pipeline_state` have been waiting longer than the
 * configured threshold.
 *
 * Configuration (all in `system_settings`):
 *   * `front_pipeline_stuck_alert_enabled` — kill switch (default true).
 *   * `front_pipeline_stuck_alert_age_minutes` — how old a row must
 *     be (per `COALESCE(state_changed_at, created_at)`) to count as
 *     stuck (default 60).
 *   * `front_pipeline_stuck_alert_min_count` — minimum stuck-row
 *     count required to fire (default 1).
 *   * `front_pipeline_stuck_alert_cooldown_minutes` — re-alert
 *     cooldown while still stuck (default 360 = 6h).
 *
 * Channel resolution is owned by the dispatcher (notification id
 * `pipeline.front_sync_emails.stuck` → `notification_settings` →
 * `rate_limit_alert_slack_channel_id` legacy fallback).
 */
// @db-pool-intent: worker
//   This watcher runs from the staggered worker scheduler; all DB work
//   is wrapped in runWithWorkerDb(...) so the test-only AsyncLocalStorage
//   schema sandbox in `tests/db-sandbox.ts` can redirect getDb() at the
//   isolated schema (Task #1929).
import { sql } from "drizzle-orm";
import { getDb, runWithWorkerDb, withDbAttribution } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";

const NOTIFICATION_ID = "pipeline.front_sync_emails.stuck";

export const SETTING_ENABLED = "front_pipeline_stuck_alert_enabled";
export const SETTING_AGE_MINUTES = "front_pipeline_stuck_alert_age_minutes";
export const SETTING_MIN_COUNT = "front_pipeline_stuck_alert_min_count";
export const SETTING_COOLDOWN_MINUTES =
  "front_pipeline_stuck_alert_cooldown_minutes";

const DEFAULTS = {
  enabled: true,
  ageMinutes: 60,
  minCount: 1,
  cooldownMinutes: 6 * 60,
};

const CHECK_INTERVAL_MS = 5 * 60_000;

/**
 * The terminal state we never want to alert on. Anything else is
 * considered "in-flight" and ages out the threshold if it sits there
 * too long.
 */
const TERMINAL_STATE = "applied";

export interface FrontPipelineStuckConfig {
  enabled: boolean;
  ageMinutes: number;
  minCount: number;
  cooldownMinutes: number;
}

interface StateRow {
  pipeline_state: string;
  row_count: number;
  oldest_age_minutes: number;
}

interface LastAlertRecord {
  at: number;
  totalCount: number;
}

let lastAlert: LastAlertRecord | null = null;

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: {
    triggerSource: string;
    bypassDedupe?: boolean;
    metadata?: Record<string, unknown>;
  },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;

let interval: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

function parsePositiveInt(
  raw: string | undefined | null,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseNonNegativeInt(
  raw: string | undefined | null,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

export async function getFrontPipelineStuckConfig(): Promise<FrontPipelineStuckConfig> {
  const [enabledRow, ageRow, minCountRow, cooldownRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_AGE_MINUTES).catch(() => null),
    getSystemSetting(SETTING_MIN_COUNT).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN_MINUTES).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    ageMinutes: parsePositiveInt(ageRow?.value, DEFAULTS.ageMinutes),
    minCount: parseNonNegativeInt(minCountRow?.value, DEFAULTS.minCount),
    cooldownMinutes: parsePositiveInt(
      cooldownRow?.value,
      DEFAULTS.cooldownMinutes,
    ),
  };
}

async function queryStuckByState(
  ageMinutes: number,
  conversationIdPrefix?: string,
): Promise<StateRow[]> {
  // Uses COALESCE(state_changed_at, created_at) so that rows whose
  // state was last advanced (e.g. `discovered` → `hydrate_pending`)
  // age out from the transition rather than the original insert.
  // Rows where `state_changed_at` is NULL (historical, pre-column)
  // fall back to `created_at`.
  //
  // Test seam: when `conversationIdPrefix` is supplied (Task #1642 test),
  // the query restricts to only rows whose `conversation_id` starts with
  // that prefix so the shared dev DB's real stuck backlog can't make
  // Group 1 ("no stuck rows" scenario) flaky. Production callers never
  // pass it, so behavior is unchanged in real environments.
  const prefixClause = conversationIdPrefix
    ? sql`AND conversation_id LIKE ${conversationIdPrefix + "%"}`
    : sql``;
  const r = await runWithWorkerDb(() =>
    withDbAttribution("alerts:front_pipeline_stuck:query", () => getDb().execute(sql`
    SELECT
      pipeline_state                                              AS pipeline_state,
      COUNT(*)::int                                               AS row_count,
      EXTRACT(
        EPOCH FROM (NOW() - MIN(COALESCE(state_changed_at, created_at)))
      )::int / 60                                                 AS oldest_age_minutes
    FROM front_sync_emails
    WHERE pipeline_state <> ${TERMINAL_STATE}
      AND COALESCE(state_changed_at, created_at)
            < NOW() - (${ageMinutes}::int * INTERVAL '1 minute')
      ${prefixClause}
    GROUP BY pipeline_state
    ORDER BY row_count DESC
  `)),
  );
  return (r.rows ?? []).map((row) => {
    const raw = row as unknown as {
      pipeline_state: unknown;
      row_count: unknown;
      oldest_age_minutes: unknown;
    };
    return {
      pipeline_state: String(raw.pipeline_state ?? ""),
      row_count: Number(raw.row_count ?? 0) || 0,
      oldest_age_minutes: Number(raw.oldest_age_minutes ?? 0) || 0,
    };
  });
}

function buildAdminLink(): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  const path = "/admin/front-historical-recovery";
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

function buildAlertText(args: {
  totalCount: number;
  oldestAgeMinutes: number;
  byState: StateRow[];
  config: FrontPipelineStuckConfig;
}): string {
  const byStateLine = args.byState
    .map(
      (s) =>
        `\`${s.pipeline_state}\`=${s.row_count} (oldest ${s.oldest_age_minutes}m)`,
    )
    .join(", ");
  return [
    `:warning: *Front pipeline rows are stuck* — ${args.totalCount} non-terminal row(s) older than ${args.config.ageMinutes}m`,
    `• By state: ${byStateLine}`,
    `• Likely causes — check in this order:`,
    `   1. \`PERF.FRONT_PIPELINE_APPLY_ENABLED\` env kill switch is \`false\` (apply stage disabled)`,
    `   2. \`system_settings.queue_drain_state\` has \`front_webhook_apply\` paused / rate-limited`,
    `   3. Apply worker is dead or wedged (stale leases — see Q7 in \`scripts/diagnostic_front_recovery_gap.sql\`)`,
    `• Silence during planned maintenance: \`system_settings.${SETTING_ENABLED}\` → \`false\``,
    `• Drill in: ${buildAdminLink()}`,
  ].join("\n");
}

export interface FrontPipelineStuckCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  ageMinutes: number;
  minCount: number;
  cooldownMinutes: number;
  totalStuck: number;
  oldestAgeMinutes: number | null;
  byState: Array<{ pipelineState: string; rowCount: number; oldestAgeMinutes: number }>;
  alertsSent: number;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_below_threshold"
    | "skipped_cooldown"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  skipReason?: string;
}

export async function checkFrontPipelineStuck(
  now: number = Date.now(),
  options?: { conversationIdPrefix?: string },
): Promise<FrontPipelineStuckCheckResult> {
  const config = await getFrontPipelineStuckConfig();
  const base = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    ageMinutes: config.ageMinutes,
    minCount: config.minCount,
    cooldownMinutes: config.cooldownMinutes,
  };

  if (!config.enabled) {
    return {
      ...base,
      totalStuck: 0,
      oldestAgeMinutes: null,
      byState: [],
      alertsSent: 0,
      decision: "skipped_disabled",
      skipReason: "alert disabled in system_settings",
    };
  }

  const rows = await queryStuckByState(config.ageMinutes, options?.conversationIdPrefix);
  const totalStuck = rows.reduce((acc, r) => acc + r.row_count, 0);
  const oldestAgeMinutes = rows.length
    ? Math.max(...rows.map((r) => r.oldest_age_minutes))
    : null;
  const byState = rows.map((r) => ({
    pipelineState: r.pipeline_state,
    rowCount: r.row_count,
    oldestAgeMinutes: r.oldest_age_minutes,
  }));

  if (totalStuck < config.minCount) {
    return {
      ...base,
      totalStuck,
      oldestAgeMinutes,
      byState,
      alertsSent: 0,
      decision: "skipped_below_threshold",
      skipReason: `${totalStuck} stuck row(s) < min_count ${config.minCount}`,
    };
  }

  const cooldownMs = config.cooldownMinutes * 60_000;
  if (lastAlert && now - lastAlert.at < cooldownMs) {
    const elapsedMin = Math.round((now - lastAlert.at) / 60_000);
    return {
      ...base,
      totalStuck,
      oldestAgeMinutes,
      byState,
      alertsSent: 0,
      decision: "skipped_cooldown",
      skipReason: `cooldown ${elapsedMin}m < ${config.cooldownMinutes}m`,
    };
  }

  const text = buildAlertText({
    totalCount: totalStuck,
    oldestAgeMinutes: oldestAgeMinutes ?? 0,
    byState: rows,
    config,
  });

  let delivered = false;
  let skipReason: string | undefined;
  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        bypassDedupe: true,
        metadata: {
          totalStuck,
          oldestAgeMinutes,
          ageMinutes: config.ageMinutes,
          minCount: config.minCount,
          byState,
        },
      },
    );
    delivered = r.delivered;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[FrontPipelineStuckAlerts] dispatch failed: ${msg}`);
    skipReason = `dispatch_error:${msg || "unknown"}`;
  }

  if (delivered) {
    lastAlert = { at: now, totalCount: totalStuck };
    return {
      ...base,
      totalStuck,
      oldestAgeMinutes,
      byState,
      alertsSent: 1,
      decision: "alerted",
    };
  }
  return {
    ...base,
    totalStuck,
    oldestAgeMinutes,
    byState,
    alertsSent: 0,
    decision: skipReason?.startsWith("dispatch_error")
      ? "skipped_send_failed"
      : "skipped_dispatcher_skipped",
    skipReason,
  };
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await checkFrontPipelineStuck();
      if (r.alertsSent > 0) {
        console.log(
          `[FrontPipelineStuckAlerts] sent=1 totalStuck=${r.totalStuck} oldestAgeMinutes=${r.oldestAgeMinutes}`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[FrontPipelineStuckAlerts] tick failed: ${msg}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startFrontPipelineStuckAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution(
      "scheduler:front-pipeline-stuck-alerts",
      () => tick(),
    );
  }, CHECK_INTERVAL_MS);
  interval.unref?.();
  console.log(
    `[FrontPipelineStuckAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopFrontPipelineStuckAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_ID,
  DEFAULTS,
  TERMINAL_STATE,
  resetLastAlertCache(): void {
    lastAlert = null;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
};
