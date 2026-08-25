/**
 * Task #1098 — Alert when call recordings stay stuck in
 * `archive_status='processing'` past the call_archive lease ceiling.
 *
 * Background
 * ----------
 * Task #1078 added the admin page `/admin/twilio/call-archive` and the
 * read-only inventory at `GET /api/admin/twilio/call-archive/stuck-processing`
 * which surfaces rows where `archive_status='processing'` and the lease
 * has been released (`archive_locked_until <= NOW()`). The next claim
 * tick reclaims those rows, but until an operator opens the page nobody
 * knows the backlog is growing — silent symptom of a hung handler or a
 * crashed worker leaving leases dangling. This watcher mirrors the
 * `queueDrainBacklogAlerts` and `callArchiveBacklogAlerts` patterns and
 * pages someone via the existing Slack/email notification dispatcher
 * once the count of "stuck past ceiling" rows crosses an operator-tunable
 * threshold.
 *
 * Predicate
 * ---------
 * A row is alert-worthy when ALL hold:
 *   - `archive_status = 'processing'`
 *   - `archive_locked_until IS NOT NULL`
 *   - `archive_locked_until <= NOW() - (ageMinutes || ' minutes')::interval`
 *
 * The default `ageMinutes` is the call_archive ceiling
 * (`getMaxProcessingMs("call_archive") / 60000`, currently 15 min). Any
 * row whose lease has been released longer than that has missed at
 * least one heartbeat tick beyond the ceiling and is genuinely stuck —
 * the next claim tick will reclaim it, this alert just makes sure
 * someone is paged before that backlog snowballs.
 *
 * Cooldown / re-fire semantics match the sibling watchers:
 *   - per-bucket cooldown (default 6h);
 *   - re-fire inside cooldown only when the count grows by at least
 *     another full `count_threshold` rows over the previously alerted
 *     snapshot.
 *
 * Channel/enabled state lives in `notification_settings` for
 * `queue.call_recording_archive.stuck_processing` (registry id);
 * threshold knobs live in `system_settings` so an admin can tune them
 * without a deploy.
 */
import { sql } from "drizzle-orm";
import { workerDb as db, withDbAttribution } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";
import { getMaxProcessingMs } from "./queueMaxProcessing";

const NOTIFICATION_ID = "queue.call_recording_archive.stuck_processing";

export const SETTING_ENABLED = "call_archive_stuck_processing_alert_enabled";
export const SETTING_AGE_MINUTES = "call_archive_stuck_processing_alert_age_minutes";
export const SETTING_COUNT = "call_archive_stuck_processing_alert_count_threshold";
export const SETTING_COOLDOWN = "call_archive_stuck_processing_alert_cooldown_minutes";

const DEFAULTS = {
  enabled: true,
  // ageMinutes default is resolved dynamically from the call_archive
  // ceiling at evaluation time when the setting is missing/blank.
  countThreshold: 1,
  cooldownMinutes: 6 * 60,
};

const CHECK_INTERVAL_MS = 15 * 60_000;

export interface CallArchiveStuckProcessingAlertConfig {
  enabled: boolean;
  ageMinutes: number;
  /**
   * True when `ageMinutes` was resolved from the call_archive ceiling
   * (no explicit `system_settings` override). Surfaced in the
   * diagnostic result so the admin "test alert" path can show whether
   * the threshold is operator-set or auto-derived.
   */
  ageMinutesFromCeiling: boolean;
  countThreshold: number;
  cooldownMinutes: number;
}

interface LastAlertRecord {
  at: number;
  count: number;
}

let lastAlert: LastAlertRecord | null = null;

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: { triggerSource: string; bypassDedupe?: boolean; metadata?: Record<string, unknown> },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;

let interval: ReturnType<typeof setInterval> | null = null;
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

export async function getCallArchiveStuckProcessingAlertConfig(): Promise<CallArchiveStuckProcessingAlertConfig> {
  const [enabledRow, ageRow, countRow, cooldownRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_AGE_MINUTES).catch(() => null),
    getSystemSetting(SETTING_COUNT).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN).catch(() => null),
  ]);
  const ageRaw = ageRow?.value ? String(ageRow.value).trim() : "";
  const ageOverride = ageRaw ? Number.parseInt(ageRaw, 10) : NaN;
  let ageMinutes: number;
  let ageMinutesFromCeiling: boolean;
  if (Number.isFinite(ageOverride) && ageOverride > 0) {
    ageMinutes = ageOverride;
    ageMinutesFromCeiling = false;
  } else {
    const ceilingMs = await getMaxProcessingMs("call_archive").catch(() => 15 * 60_000);
    ageMinutes = Math.max(1, Math.round(ceilingMs / 60_000));
    ageMinutesFromCeiling = true;
  }
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    ageMinutes,
    ageMinutesFromCeiling,
    countThreshold: parsePositiveInt(countRow?.value, DEFAULTS.countThreshold),
    cooldownMinutes: parsePositiveInt(cooldownRow?.value, DEFAULTS.cooldownMinutes),
  };
}

/**
 * Canonical SQL predicate for "stuck past ceiling" — exported so tests
 * (and any future admin card that wants the same drill-in row set) can
 * reuse the exact same shape the watcher evaluates.
 */
export function stuckProcessingWhere(ageMinutes: number) {
  return sql`archive_status = 'processing'
    AND archive_locked_until IS NOT NULL
    AND archive_locked_until <= NOW() - (${ageMinutes} || ' minutes')::interval`;
}

async function countStuckProcessing(ageMinutes: number): Promise<number> {
  const r = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM twilio_calls
    WHERE ${stuckProcessingWhere(ageMinutes)}
  `);
  return Number((r.rows?.[0] as any)?.n ?? 0);
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

function buildAlertText(args: {
  count: number;
  config: CallArchiveStuckProcessingAlertConfig;
}): string {
  const link = buildAdminLink();
  const sourceNote = args.config.ageMinutesFromCeiling
    ? ` (call_archive ceiling)`
    : "";
  return [
    `:warning: *Call recording archive — recordings stuck in processing*`,
    `• *${args.count}* row(s) in \`archive_status='processing'\` whose lease has been released for more than *${args.config.ageMinutes}m*${sourceNote}`,
    `• Threshold: ≥ ${args.config.countThreshold} row(s)`,
    `• These rows will be reclaimed by the next archive claim tick; investigate the handler if the count keeps growing.`,
    `Drill in from the Twilio admin: ${link}`,
  ].join("\n");
}

export interface CallArchiveStuckProcessingCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  alertsSent: number;
  count: number;
  threshold: number;
  ageMinutes: number;
  ageMinutesFromCeiling: boolean;
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

export async function checkCallArchiveStuckProcessing(
  now: number = Date.now(),
): Promise<CallArchiveStuckProcessingCheckResult> {
  const config = await getCallArchiveStuckProcessingAlertConfig();
  const baseResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    threshold: config.countThreshold,
    ageMinutes: config.ageMinutes,
    ageMinutesFromCeiling: config.ageMinutesFromCeiling,
  };

  if (!config.enabled) {
    // Surface the count for diagnostics even when the alert is off so
    // an operator hitting a manual "test alert" path sees what would
    // be evaluated.
    const count = await countStuckProcessing(config.ageMinutes).catch(() => 0);
    return {
      ...baseResult,
      alertsSent: 0,
      count,
      decision: "skipped_disabled",
      skipReason: "alert disabled in system_settings",
    };
  }

  const count = await countStuckProcessing(config.ageMinutes);

  if (count < config.countThreshold) {
    return {
      ...baseResult,
      alertsSent: 0,
      count,
      decision: "skipped_below_threshold",
      skipReason: `count ${count} < threshold ${config.countThreshold}`,
    };
  }

  const cooldownMs = config.cooldownMinutes * 60_000;
  if (lastAlert) {
    const elapsedMs = now - lastAlert.at;
    const growth = count - lastAlert.count;
    if (elapsedMs < cooldownMs && growth < config.countThreshold) {
      if (growth <= 0) {
        return {
          ...baseResult,
          alertsSent: 0,
          count,
          decision: "skipped_no_growth_since_last_alert",
          skipReason: `no growth since last alert (${count} ≤ ${lastAlert.count})`,
        };
      }
      return {
        ...baseResult,
        alertsSent: 0,
        count,
        decision: "skipped_cooldown",
        skipReason: `cooldown ${Math.round(elapsedMs / 60_000)}m < ${config.cooldownMinutes}m and growth-since-last ${growth} < ${config.countThreshold}`,
      };
    }
  }

  const text = buildAlertText({ count, config });
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
        // The watcher manages its own cooldown above; let the
        // dispatcher fire whenever we get here.
        bypassDedupe: true,
        metadata: {
          count,
          threshold: config.countThreshold,
          ageMinutes: config.ageMinutes,
          ageMinutesFromCeiling: config.ageMinutesFromCeiling,
        },
      },
    );
    delivered = r.delivered;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: any) {
    console.error(
      `[CallArchiveStuckProcessingAlerts] dispatch failed: ${err?.message}`,
    );
    skipReason = `dispatch_error:${err?.message ?? "unknown"}`;
  }

  if (delivered) {
    lastAlert = { at: now, count };
    return {
      ...baseResult,
      alertsSent: 1,
      count,
      decision: "alerted",
    };
  }
  return {
    ...baseResult,
    alertsSent: 0,
    count,
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
      const r = await checkCallArchiveStuckProcessing();
      if (r.alertsSent > 0) {
        console.log(
          `[CallArchiveStuckProcessingAlerts] sent=${r.alertsSent} count=${r.count} ageMinutes=${r.ageMinutes}`,
        );
      }
    } catch (err: any) {
      console.warn(`[CallArchiveStuckProcessingAlerts] tick failed: ${err?.message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startCallArchiveStuckProcessingAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution("scheduler:call-archive-stuck-processing-alerts", () => tick());
  }, CHECK_INTERVAL_MS);
  interval.unref?.();
  console.log(
    `[CallArchiveStuckProcessingAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopCallArchiveStuckProcessingAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_ID,
  DEFAULTS,
  resetLastAlertCache(): void {
    lastAlert = null;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
};
