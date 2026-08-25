// @cross-instance-safe: read-only COUNT probe + notifyByType alert with in-memory
// @cross-instance-safe:   cooldown — same per-instance watcher class as the baselined
// @cross-instance-safe:   callArchiveStuckProcessingAlerts family; duplicate instances at worst
// @cross-instance-safe:   re-attempt a dispatch the watcher-owned cooldown/growth gate absorbs.
/**
 * Workers/queues audit parity (E-F12) — alert when call-analysis jobs
 * stay stuck in `status='processing'` past the lane lease ceiling.
 *
 * Background
 * ----------
 * `call_analysis_jobs` is a custom-table queue (it bypasses `work_queue`),
 * processed by the two lane pollers in callAnalysis.ts. Those pollers now
 * claim atomically and hold a bounded lease (locked_until / leased_at,
 * migration 20260806182338), and `recoverStaleJobs` requeues or fails
 * expired-lease rows. What was still missing — and what the established
 * work_queue lanes have via leaseChurnAlerts — is a *page* when stuck
 * rows accumulate, i.e. when recovery itself is not running (worker dead,
 * scheduler wedged) or rows churn through stale leases repeatedly. This
 * watcher mirrors callArchiveStuckProcessingAlerts one-for-one.
 *
 * Predicate
 * ---------
 * A row is alert-worthy when ALL hold:
 *   - `status = 'processing'`
 *   - `locked_until IS NOT NULL`
 *   - `locked_until <= NOW() - (ageMinutes || ' minutes')::interval`
 *
 * The default `ageMinutes` is the normal-lane ceiling
 * (`getMaxProcessingMs("call_analysis") / 60000`, 5 min by default).
 * A healthy worker heartbeats every 60s, and stale recovery requeues
 * expired rows within ~3 minutes — so a lease that has been expired for
 * a further full ceiling means recovery is not draining. Legacy rows
 * with `locked_until IS NULL` (claimed by pre-lease code) are excluded
 * here, exactly like the call-archive watcher; recovery's started_at
 * fallback handles those.
 *
 * Cooldown / re-fire semantics match the sibling watchers:
 *   - per-bucket cooldown (default 6h);
 *   - re-fire inside cooldown only when the count grows by at least
 *     another full `count_threshold` rows over the previously alerted
 *     snapshot.
 *
 * Channel/enabled state lives in `notification_settings` for
 * `queue.call_analysis.stuck_processing` (registry id); threshold knobs
 * live in `system_settings` so an admin can tune them without a deploy.
 */
import { sql } from "drizzle-orm";
import { workerDb as db, withDbAttribution } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";
import { getMaxProcessingMs } from "./queueMaxProcessing";

const NOTIFICATION_ID = "queue.call_analysis.stuck_processing";

export const SETTING_ENABLED = "call_analysis_stuck_processing_alert_enabled";
export const SETTING_AGE_MINUTES = "call_analysis_stuck_processing_alert_age_minutes";
export const SETTING_COUNT = "call_analysis_stuck_processing_alert_count_threshold";
export const SETTING_COOLDOWN = "call_analysis_stuck_processing_alert_cooldown_minutes";

const DEFAULTS = {
  enabled: true,
  // ageMinutes default is resolved dynamically from the call_analysis
  // (normal lane) ceiling at evaluation time when the setting is
  // missing/blank.
  countThreshold: 1,
  cooldownMinutes: 6 * 60,
};

const CHECK_INTERVAL_MS = 15 * 60_000;

export interface CallAnalysisStuckProcessingAlertConfig {
  enabled: boolean;
  ageMinutes: number;
  /**
   * True when `ageMinutes` was resolved from the call_analysis ceiling
   * (no explicit `system_settings` override).
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

export async function getCallAnalysisStuckProcessingAlertConfig(): Promise<CallAnalysisStuckProcessingAlertConfig> {
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
    const ceilingMs = await getMaxProcessingMs("call_analysis").catch(() => 5 * 60_000);
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
 * can reuse the exact same shape the watcher evaluates.
 */
export function stuckProcessingWhere(ageMinutes: number) {
  return sql`status = 'processing'
    AND locked_until IS NOT NULL
    AND locked_until <= NOW() - (${ageMinutes} || ' minutes')::interval`;
}

async function countStuckProcessing(ageMinutes: number): Promise<number> {
  const r = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM call_analysis_jobs
    WHERE ${stuckProcessingWhere(ageMinutes)}
  `);
  return Number((r.rows?.[0] as any)?.n ?? 0);
}

function buildAlertText(args: {
  count: number;
  config: CallAnalysisStuckProcessingAlertConfig;
}): string {
  const sourceNote = args.config.ageMinutesFromCeiling
    ? ` (call_analysis ceiling)`
    : "";
  return [
    `:warning: *Call analysis — jobs stuck in processing*`,
    `• *${args.count}* row(s) in \`call_analysis_jobs\` with \`status='processing'\` whose lease has been expired for more than *${args.config.ageMinutes}m*${sourceNote}`,
    `• Threshold: ≥ ${args.config.countThreshold} row(s)`,
    `• Stale recovery normally requeues expired-lease rows within ~3 minutes — a growing count means the call-analysis workers (or their recovery pass) are not running, or rows are churning through stale leases repeatedly.`,
  ].join("\n");
}

export interface CallAnalysisStuckProcessingCheckResult {
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

export async function checkCallAnalysisStuckProcessing(
  now: number = Date.now(),
): Promise<CallAnalysisStuckProcessingCheckResult> {
  const config = await getCallAnalysisStuckProcessingAlertConfig();
  const baseResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    threshold: config.countThreshold,
    ageMinutes: config.ageMinutes,
    ageMinutesFromCeiling: config.ageMinutesFromCeiling,
  };

  if (!config.enabled) {
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
      `[CallAnalysisStuckProcessingAlerts] dispatch failed: ${err?.message}`,
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
      const r = await checkCallAnalysisStuckProcessing();
      if (r.alertsSent > 0) {
        console.log(
          `[CallAnalysisStuckProcessingAlerts] sent=${r.alertsSent} count=${r.count} ageMinutes=${r.ageMinutes}`,
        );
      }
    } catch (err: any) {
      console.warn(`[CallAnalysisStuckProcessingAlerts] tick failed: ${err?.message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startCallAnalysisStuckProcessingAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution("scheduler:call-analysis-stuck-processing-alerts", () => tick());
  }, CHECK_INTERVAL_MS);
  interval.unref?.();
  console.log(
    `[CallAnalysisStuckProcessingAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopCallAnalysisStuckProcessingAlertsScheduler(): void {
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
