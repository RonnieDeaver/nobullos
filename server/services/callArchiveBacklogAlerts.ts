/**
 * Task #1053 — Alert when the Twilio call-recording archive pipeline
 * stalls.
 *
 * Background
 * ----------
 * Task #1046 went unnoticed for ~12 days because nothing alerted us
 * that `callArchivePipeline` had stopped draining its backlog. The
 * symptoms were two-fold:
 *
 *   1. Recently-created `twilio_calls` rows sat at `archive_status =
 *      'pending'` indefinitely because the recording-status webhook
 *      never re-enqueued them after the post-#1046 reset.
 *   2. Rows that DID get claimed exhausted the bounded retry ladder
 *      (1m / 5m / 15m / 30m / 1h / 2h, MAX_ATTEMPTS=6) and landed in
 *      `failed` — also silently.
 *
 * This watcher runs on a 15-minute cadence (cheap COUNT(*) queries),
 * and fires a Slack alert via the unified `notifyByType` dispatcher
 * when EITHER bucket crosses its operator-configurable threshold:
 *
 *   - `pending_stuck`  — rows in `archive_status='pending'` with NO
 *     `recording_url` and NO `recording_sid` (the recording-status
 *     webhook never delivered metadata) whose `created_at` is older
 *     than `pending_hours_threshold` hours. The two NULL predicates
 *     mirror the admin "Stuck" tile's filter
 *     (`GET /api/admin/twilio/call-archive`) so the alert count and
 *     the admin page agree on what "stuck" means — Task #1081.
 *   - `recent_failures` — rows in `archive_status='failed'` whose
 *     `updated_at` is within the last `failed_lookback_hours` hours
 *     AND `archive_attempts >= MAX_ATTEMPTS` (the only legitimate
 *     way the pipeline reaches `failed`).
 *
 * Each bucket has its own per-bucket cooldown (default 6h) so a
 * single stuck batch doesn't spam the channel every 15 minutes; we
 * re-alert early only when the count grows by another full
 * `count_threshold` rows over the previously-alerted snapshot.
 *
 * Channel/enabled state lives in `notification_settings` for
 * `queue.call_recording_archive.backlog_or_failures` (registry id);
 * threshold knobs live in `system_settings` so an admin can tune
 * them without a deploy.
 */
import { workerDb as db, withDbAttribution } from "../db";
import { sql } from "drizzle-orm";
import { getSystemSetting } from "../storage/settingsStorage";
import { MAX_ATTEMPTS } from "./callArchivePipeline";

// Task #1094: trend snapshot retention. We keep ~30 days of samples
// (≈ 2880 rows at one per 15 min) so the 24h sparkline always has
// data even right after a long deploy gap. Older rows are pruned
// opportunistically on each tick.
const SNAPSHOT_RETENTION_DAYS = 30;

const NOTIFICATION_ID = "queue.call_recording_archive.backlog_or_failures";

export const SETTING_ENABLED = "call_archive_alert_enabled";
export const SETTING_PENDING_HOURS = "call_archive_alert_pending_hours_threshold";
export const SETTING_PENDING_COUNT = "call_archive_alert_pending_count_threshold";
export const SETTING_FAILED_LOOKBACK_HOURS = "call_archive_alert_failed_lookback_hours";
export const SETTING_FAILED_COUNT = "call_archive_alert_failed_count_threshold";
export const SETTING_COOLDOWN = "call_archive_alert_cooldown_minutes";

const DEFAULTS = {
  enabled: true,
  pendingHours: 1,
  pendingCount: 1,
  failedLookbackHours: 24,
  failedCount: 1,
  cooldownMinutes: 6 * 60,
};

const CHECK_INTERVAL_MS = 15 * 60_000;

export interface CallArchiveBacklogAlertConfig {
  enabled: boolean;
  pendingHours: number;
  pendingCount: number;
  failedLookbackHours: number;
  failedCount: number;
  cooldownMinutes: number;
}

type Bucket = "pending_stuck" | "recent_failures";

interface LastAlertRecord {
  at: number;
  count: number;
}

const lastAlertByBucket = new Map<Bucket, LastAlertRecord>();

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: { triggerSource: string; bypassDedupe?: boolean; metadata?: Record<string, unknown> },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;

let interval: ReturnType<typeof setInterval> | null = null;
let bootstrapTimeout: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

function parsePositiveInt(raw: string | undefined | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

export async function getCallArchiveBacklogAlertConfig(): Promise<CallArchiveBacklogAlertConfig> {
  const [enabledRow, pendingHoursRow, pendingCountRow, failedHoursRow, failedCountRow, cooldownRow] =
    await Promise.all([
      getSystemSetting(SETTING_ENABLED).catch(() => null),
      getSystemSetting(SETTING_PENDING_HOURS).catch(() => null),
      getSystemSetting(SETTING_PENDING_COUNT).catch(() => null),
      getSystemSetting(SETTING_FAILED_LOOKBACK_HOURS).catch(() => null),
      getSystemSetting(SETTING_FAILED_COUNT).catch(() => null),
      getSystemSetting(SETTING_COOLDOWN).catch(() => null),
    ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    pendingHours: parsePositiveInt(pendingHoursRow?.value, DEFAULTS.pendingHours),
    pendingCount: parsePositiveInt(pendingCountRow?.value, DEFAULTS.pendingCount),
    failedLookbackHours: parsePositiveInt(failedHoursRow?.value, DEFAULTS.failedLookbackHours),
    failedCount: parsePositiveInt(failedCountRow?.value, DEFAULTS.failedCount),
    cooldownMinutes: parsePositiveInt(cooldownRow?.value, DEFAULTS.cooldownMinutes),
  };
}

function buildAdminLink(): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  const path = "/admin/twilio";
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

export interface BucketEvaluation {
  bucket: Bucket;
  count: number;
  threshold: number;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_below_threshold"
    | "skipped_cooldown"
    | "skipped_no_growth_since_last_alert"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  skipReason?: string;
}

export interface CallArchiveBacklogCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  alertsSent: number;
  buckets: BucketEvaluation[];
}

/**
 * Canonical SQL predicates for the watcher's two buckets. Exported so
 * the admin Twilio "Archive pipeline health" card (Task #1079) can
 * render the same numbers and the same drill-in row sets the watcher
 * evaluates — no divergence between alert text and dashboard.
 *
 * `pendingStuckWhere` matches the Task #1081 definition: pending rows
 * where the recording-status webhook never delivered metadata (no
 * `recording_url` AND no `recording_sid`), older than `pendingHours`.
 */
export function pendingStuckWhere(pendingHours: number) {
  return sql`archive_status = 'pending'
    AND recording_url IS NULL
    AND recording_sid IS NULL
    AND created_at < NOW() - (${pendingHours} || ' hours')::interval`;
}

export function recentFailuresWhere(lookbackHours: number) {
  return sql`archive_status = 'failed'
    AND archive_attempts >= ${MAX_ATTEMPTS}
    AND updated_at >= NOW() - (${lookbackHours} || ' hours')::interval`;
}

export async function countPendingStuck(pendingHours: number): Promise<number> {
  const r = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM twilio_calls
    WHERE ${pendingStuckWhere(pendingHours)}
  `);
  return Number((r.rows?.[0] as any)?.n ?? 0);
}

export async function countRecentFailures(lookbackHours: number): Promise<number> {
  const r = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM twilio_calls
    WHERE ${recentFailuresWhere(lookbackHours)}
  `);
  return Number((r.rows?.[0] as any)?.n ?? 0);
}

function buildAlertText(args: {
  bucket: Bucket;
  count: number;
  config: CallArchiveBacklogAlertConfig;
}): string {
  const link = buildAdminLink();
  if (args.bucket === "pending_stuck") {
    return [
      `:warning: *Call recording archive — pending backlog stuck*`,
      `• *${args.count}* row(s) in \`archive_status='pending'\` with no recording_url/sid, older than *${args.config.pendingHours}h*`,
      `• Threshold: ≥ ${args.config.pendingCount} row(s) older than ${args.config.pendingHours}h`,
      `• Likely cause: recording-status webhook never re-enqueued the row, or the archive scheduler is not running.`,
      `Investigate from the Twilio admin: ${link}`,
    ].join("\n");
  }
  return [
    `:warning: *Call recording archive — bounded retries exhausted*`,
    `• *${args.count}* row(s) marked \`archive_status='failed'\` in the last *${args.config.failedLookbackHours}h* (attempts ≥ ${MAX_ATTEMPTS})`,
    `• Threshold: ≥ ${args.config.failedCount} row(s) in the last ${args.config.failedLookbackHours}h`,
    `• These rows are recoverable — a late recording-status webhook will reset them via \`enqueueCallArchive\`.`,
    `Investigate from the Twilio admin: ${link}`,
  ].join("\n");
}

async function dispatchBucketAlert(
  bucket: Bucket,
  count: number,
  config: CallArchiveBacklogAlertConfig,
  now: number,
): Promise<BucketEvaluation> {
  const threshold = bucket === "pending_stuck" ? config.pendingCount : config.failedCount;
  const cooldownMs = config.cooldownMinutes * 60_000;

  if (count < threshold) {
    return {
      bucket,
      count,
      threshold,
      decision: "skipped_below_threshold",
      skipReason: `count ${count} < threshold ${threshold}`,
    };
  }

  const last = lastAlertByBucket.get(bucket);
  if (last) {
    const elapsedMs = now - last.at;
    const growth = count - last.count;
    if (elapsedMs < cooldownMs && growth < threshold) {
      if (growth <= 0) {
        return {
          bucket,
          count,
          threshold,
          decision: "skipped_no_growth_since_last_alert",
          skipReason: `no growth since last alert (${count} ≤ ${last.count})`,
        };
      }
      return {
        bucket,
        count,
        threshold,
        decision: "skipped_cooldown",
        skipReason: `cooldown ${Math.round(elapsedMs / 60_000)}m < ${config.cooldownMinutes}m and growth-since-last ${growth} < ${threshold}`,
      };
    }
  }

  const text = buildAlertText({ bucket, count, config });
  let delivered = false;
  let skipReason: string | undefined;
  try {
    const notifyByType =
      dispatcherOverride ?? (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        // The watcher manages its own per-bucket cooldown above; let the
        // dispatcher fire whenever we get here.
        bypassDedupe: true,
        metadata: {
          bucket,
          count,
          threshold,
          pendingHours: config.pendingHours,
          failedLookbackHours: config.failedLookbackHours,
          maxAttempts: MAX_ATTEMPTS,
        },
      },
    );
    delivered = r.delivered;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: any) {
    console.error(
      `[CallArchiveBacklogAlerts] dispatch failed for ${bucket}: ${err?.message}`,
    );
    skipReason = `dispatch_error:${err?.message ?? "unknown"}`;
  }

  if (delivered) {
    lastAlertByBucket.set(bucket, { at: now, count });
    return { bucket, count, threshold, decision: "alerted" };
  }
  return {
    bucket,
    count,
    threshold,
    decision: skipReason?.startsWith("dispatch_error")
      ? "skipped_send_failed"
      : "skipped_dispatcher_skipped",
    skipReason,
  };
}

export async function checkCallArchiveBacklog(
  now: number = Date.now(),
): Promise<CallArchiveBacklogCheckResult> {
  const config = await getCallArchiveBacklogAlertConfig();
  const result: CallArchiveBacklogCheckResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    alertsSent: 0,
    buckets: [],
  };

  if (!config.enabled) {
    // Surface the counts for diagnostics even when the alert is off so
    // an operator hitting the manual "test alert" path sees what would
    // be evaluated.
    const [pendingCount, failedCount] = await Promise.all([
      countPendingStuck(config.pendingHours).catch(() => 0),
      countRecentFailures(config.failedLookbackHours).catch(() => 0),
    ]);
    result.buckets.push({
      bucket: "pending_stuck",
      count: pendingCount,
      threshold: config.pendingCount,
      decision: "skipped_disabled",
      skipReason: "alert disabled in system_settings",
    });
    result.buckets.push({
      bucket: "recent_failures",
      count: failedCount,
      threshold: config.failedCount,
      decision: "skipped_disabled",
      skipReason: "alert disabled in system_settings",
    });
    return result;
  }

  const [pendingCount, failedCount] = await Promise.all([
    countPendingStuck(config.pendingHours),
    countRecentFailures(config.failedLookbackHours),
  ]);

  const pendingEval = await dispatchBucketAlert("pending_stuck", pendingCount, config, now);
  const failedEval = await dispatchBucketAlert("recent_failures", failedCount, config, now);
  result.buckets.push(pendingEval, failedEval);
  result.alertsSent =
    (pendingEval.decision === "alerted" ? 1 : 0) +
    (failedEval.decision === "alerted" ? 1 : 0);
  return result;
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await checkCallArchiveBacklog();
      if (r.alertsSent > 0) {
        const summary = r.buckets
          .filter((b) => b.decision === "alerted")
          .map((b) => `${b.bucket}=${b.count}`)
          .join(",");
        console.log(`[CallArchiveBacklogAlerts] sent=${r.alertsSent} ${summary}`);
      }
      // Task #1094: record a 15-min snapshot for the trend sparklines
      // on the admin Twilio "Archive pipeline health" card and the
      // /admin/twilio/call-archive drill-in. The watcher already ran
      // the same COUNT(*) queries above, but we re-run them here so
      // disabled-alert and dispatcher-skipped paths still produce a
      // sample (cheap on the indexed columns).
      try {
        await recordCallArchiveHealthSnapshot();
      } catch (err: any) {
        console.warn(
          `[CallArchiveBacklogAlerts] snapshot failed: ${err?.message ?? err}`,
        );
      }
    } catch (err: any) {
      console.warn(`[CallArchiveBacklogAlerts] tick failed: ${err?.message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Task #1094: write one row to `call_archive_health_snapshots`
 * capturing the same three counters the alert card surfaces. Called
 * from the 15-min `tick()` and exported so tests can drive it
 * deterministically without waiting for the scheduler. Old rows
 * (> SNAPSHOT_RETENTION_DAYS) are pruned in the same statement to
 * keep the table bounded.
 */
export interface CallArchiveHealthSnapshotResult {
  pendingStuckCount: number;
  oldestPendingAgeSeconds: number | null;
  recentFailedCount: number;
  pendingHours: number;
  failedLookbackHours: number;
}

export async function recordCallArchiveHealthSnapshot(): Promise<CallArchiveHealthSnapshotResult> {
  const config = await getCallArchiveBacklogAlertConfig();
  const pendingWhere = pendingStuckWhere(config.pendingHours);
  const failedWhere = recentFailuresWhere(config.failedLookbackHours);

  const [pendingResult, failedResult] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*)::int AS count,
        MAX(EXTRACT(EPOCH FROM (NOW() - created_at)))::int AS oldest_age_seconds
      FROM twilio_calls
      WHERE ${pendingWhere}
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM twilio_calls
      WHERE ${failedWhere}
    `),
  ]);

  const pendingRow = (pendingResult.rows ?? [])[0] as
    | { count: number | string; oldest_age_seconds: number | string | null }
    | undefined;
  const failedRow = (failedResult.rows ?? [])[0] as
    | { count: number | string }
    | undefined;

  const pendingStuckCount = Number(pendingRow?.count ?? 0);
  const oldestPendingAgeSeconds =
    pendingRow?.oldest_age_seconds == null
      ? null
      : Number(pendingRow.oldest_age_seconds);
  const recentFailedCount = Number(failedRow?.count ?? 0);

  await db.execute(sql`
    INSERT INTO call_archive_health_snapshots (
      pending_stuck_count,
      oldest_pending_age_seconds,
      recent_failed_count,
      pending_hours,
      failed_lookback_hours
    ) VALUES (
      ${pendingStuckCount},
      ${oldestPendingAgeSeconds},
      ${recentFailedCount},
      ${config.pendingHours},
      ${config.failedLookbackHours}
    )
  `);

  // Opportunistic prune; bounded delete on an indexed column.
  await db
    .execute(sql`
      DELETE FROM call_archive_health_snapshots
      WHERE sampled_at < NOW() - (${SNAPSHOT_RETENTION_DAYS} || ' days')::interval
    `)
    .catch((err: any) => {
      console.warn(
        `[CallArchiveBacklogAlerts] snapshot prune failed: ${err?.message ?? err}`,
      );
    });

  return {
    pendingStuckCount,
    oldestPendingAgeSeconds,
    recentFailedCount,
    pendingHours: config.pendingHours,
    failedLookbackHours: config.failedLookbackHours,
  };
}

export interface CallArchiveHealthTrendPoint {
  sampledAt: string;
  pendingStuckCount: number;
  oldestPendingAgeSeconds: number | null;
  recentFailedCount: number;
}

/**
 * Task #1094: returns up to `hours` of snapshots ordered oldest →
 * newest so the UI can plot a sparkline directly without re-sorting.
 * Defaults to 24h to match the card's stated promise.
 */
export async function getCallArchiveHealthTrend(
  hours: number = 24,
): Promise<CallArchiveHealthTrendPoint[]> {
  const safeHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 30) : 24;
  const result = await db.execute(sql`
    SELECT
      sampled_at,
      pending_stuck_count,
      oldest_pending_age_seconds,
      recent_failed_count
    FROM call_archive_health_snapshots
    WHERE sampled_at >= NOW() - (${safeHours} || ' hours')::interval
    ORDER BY sampled_at ASC
  `);
  const rows = (result.rows ?? []) as Array<{
    sampled_at: string | Date;
    pending_stuck_count: number | string;
    oldest_pending_age_seconds: number | string | null;
    recent_failed_count: number | string;
  }>;
  return rows.map((r) => ({
    sampledAt:
      r.sampled_at instanceof Date
        ? r.sampled_at.toISOString()
        : new Date(r.sampled_at).toISOString(),
    pendingStuckCount: Number(r.pending_stuck_count ?? 0),
    oldestPendingAgeSeconds:
      r.oldest_pending_age_seconds == null
        ? null
        : Number(r.oldest_pending_age_seconds),
    recentFailedCount: Number(r.recent_failed_count ?? 0),
  }));
}

export function startCallArchiveBacklogAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution("scheduler:call-archive-backlog-alerts", () => tick());
  }, CHECK_INTERVAL_MS);
  interval.unref?.();
  // Task #1094: write one snapshot a few seconds after boot so the
  // /admin/twilio sparklines are populated immediately on first
  // deploy instead of showing "no trend data" for 15 minutes. The
  // handle is tracked so stopCallArchiveBacklogAlertsScheduler() can
  // cancel a pending bootstrap on rapid start/stop cycles (tests).
  bootstrapTimeout = setTimeout(() => {
    bootstrapTimeout = null;
    void withDbAttribution(
      "scheduler:call-archive-backlog-alerts:bootstrap-snapshot",
      () =>
        recordCallArchiveHealthSnapshot().catch((err: any) =>
          console.warn(
            `[CallArchiveBacklogAlerts] bootstrap snapshot failed: ${err?.message ?? err}`,
          ),
        ),
    );
  }, 15_000);
  bootstrapTimeout.unref?.();
  console.log(
    `[CallArchiveBacklogAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopCallArchiveBacklogAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  if (bootstrapTimeout) {
    clearTimeout(bootstrapTimeout);
    bootstrapTimeout = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_ID,
  DEFAULTS,
  resetLastAlertCache(): void {
    lastAlertByBucket.clear();
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
};
