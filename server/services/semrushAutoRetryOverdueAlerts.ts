// @cross-instance-safe: read-only COUNT probe + notifyByType alert whose once-per-streak
// @cross-instance-safe:   state is backed by the dispatcher's DB-backed notification_health_state
// @cross-instance-safe:   (shared dedupe key) — same streak class as semrushDisconnectAlert;
// @cross-instance-safe:   duplicate instances at worst re-attempt a dispatch the transition dedupe absorbs.
/**
 * Workers/queues audit parity (E-F15/E-F16) — alert when Semrush location
 * auto-retry rows stay overdue (due-for-retry but never picked up).
 *
 * Background
 * ----------
 * The auto-retry lane over `semrush_location_sync_state` re-drives
 * `failed` rows whose `next_retry_at` has elapsed. The ticker runs every
 * ~30s and (post E-F01) claims rows atomically by pushing `next_retry_at`
 * forward as a bounded lease. If rows sit due for a long time, the ticker
 * is dead (scheduler wedged, cross-instance lock stuck, deploy without
 * the worker) and locations silently stop retrying — the failure mode
 * this watcher pages on.
 *
 * Predicate
 * ---------
 * A row is alert-worthy when ALL hold:
 *   - `status = 'failed'`
 *   - `next_retry_at IS NOT NULL` (NULL = attempt budget exhausted or
 *     retry not scheduled — terminal, not this watcher's business)
 *   - `next_retry_at <= NOW() - ageMinutes` (overdue by a full threshold,
 *     not merely due)
 *
 * Default `ageMinutes` is 60 — two orders of magnitude above the 30s tick
 * cadence and 4× the 15-min claim lease, so neither normal scheduling lag
 * nor a crashed-claimer recovery window can fire it. Rows claimed by a
 * healthy ticker have `next_retry_at` pushed FORWARD (an active lease),
 * so in-flight work is never counted.
 *
 * Kill-switch interplay: while the `auto_retry` kill switch is ON,
 * overdue rows are EXPECTED (the operator stopped the lane), so the
 * watcher skips instead of paging — mirroring how the work_queue watchers
 * treat operator-stopped lanes. Kill-switch/disabled skips make no
 * observation, so they never touch the streak state.
 *
 * Alert-state semantics (E-F16 — once per stuck streak)
 * -----------------------------------------------------
 * Mirrors `semrushDisconnectAlert` / the dispatcher's transition dedupe:
 *   - a per-process `streakAlerted` flag suppresses repeats within one
 *     overdue streak (exactly one page per streak per process — count
 *     growth no longer re-fires; the page already says the ticker is dead);
 *   - the dispatch itself carries a stable `dedupeKey`, so the dispatcher
 *     persists an `unhealthy` transition in `notification_health_state`.
 *     That state SURVIVES RESTARTS: a restarted process that observes the
 *     same ongoing streak gets `skipped_deduped` from the dispatcher and
 *     re-adopts the flag instead of double-paging (after 6h of sustained
 *     overdue rows the dispatcher sends its standard reminder — accepted);
 *   - every healthy observation (count below threshold) clears the flag
 *     AND calls `markRecovered`, so the NEXT streak alerts immediately.
 *
 * Channel/enabled state lives in `notification_settings` for
 * `queue.semrush_auto_retry.overdue_rows` (registry id); threshold knobs
 * live in `system_settings` so an admin can tune them without a deploy.
 */
import { sql } from "drizzle-orm";
import { workerDb as db, withDbAttribution } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";
import { isKillSwitchEnabled } from "./killSwitches";

const NOTIFICATION_ID = "queue.semrush_auto_retry.overdue_rows";
/** Stable transition-dedupe identity for this watcher's single signal. */
const DEDUPE_KEY = "semrush_auto_retry:overdue_rows";

export const SETTING_ENABLED = "semrush_auto_retry_overdue_alert_enabled";
export const SETTING_AGE_MINUTES = "semrush_auto_retry_overdue_alert_age_minutes";
export const SETTING_COUNT = "semrush_auto_retry_overdue_alert_count_threshold";

const DEFAULTS = {
  enabled: true,
  ageMinutes: 60,
  countThreshold: 1,
};

const CHECK_INTERVAL_MS = 15 * 60_000;

export interface SemrushAutoRetryOverdueAlertConfig {
  enabled: boolean;
  ageMinutes: number;
  countThreshold: number;
}

/**
 * Per-process streak gate. Set after the first delivery (or a dispatcher
 * `skipped_deduped` proving a pre-restart delivery) within an overdue
 * streak; cleared only by a healthy observation.
 */
let streakAlerted = false;

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: {
    triggerSource: string;
    dedupeKey?: string;
    bypassDedupe?: boolean;
    metadata?: Record<string, unknown>;
  },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

type MarkRecoveredFn = (id: string, dedupeKey: string) => Promise<void>;

let dispatcherOverride: NotifyByTypeFn | null = null;
let markRecoveredOverride: MarkRecoveredFn | null = null;

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

export async function getSemrushAutoRetryOverdueAlertConfig(): Promise<SemrushAutoRetryOverdueAlertConfig> {
  const [enabledRow, ageRow, countRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_AGE_MINUTES).catch(() => null),
    getSystemSetting(SETTING_COUNT).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    ageMinutes: parsePositiveInt(ageRow?.value, DEFAULTS.ageMinutes),
    countThreshold: parsePositiveInt(countRow?.value, DEFAULTS.countThreshold),
  };
}

/**
 * Healthy observation ⇒ the streak (if any) is over. Clears the in-process
 * flag and best-effort clears the dispatcher's persisted health state so the
 * NEXT streak alerts immediately. Called unconditionally on healthy ticks —
 * that also heals health-state rows orphaned by an alert-then-restart. Never
 * throws (the watcher must not crash on dispatcher/DB hiccups).
 */
async function rearmAfterHealthyObservation(): Promise<void> {
  streakAlerted = false;
  try {
    const markRecovered =
      markRecoveredOverride ?? (await import("./notifications/dispatcher")).markRecovered;
    await markRecovered(NOTIFICATION_ID, DEDUPE_KEY);
  } catch (err: any) {
    console.warn(
      `[SemrushAutoRetryOverdueAlerts] markRecovered failed (non-fatal): ${err?.message ?? err}`,
    );
  }
}

/**
 * Canonical SQL predicate for "overdue past threshold" — exported so tests
 * can reuse the exact same shape the watcher evaluates.
 */
export function overdueRetryWhere(ageMinutes: number) {
  return sql`status = 'failed'
    AND next_retry_at IS NOT NULL
    AND next_retry_at <= NOW() - (${ageMinutes} || ' minutes')::interval`;
}

async function countOverdueRetries(ageMinutes: number): Promise<number> {
  const r = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM semrush_location_sync_state
    WHERE ${overdueRetryWhere(ageMinutes)}
  `);
  return Number((r.rows?.[0] as any)?.n ?? 0);
}

function buildAlertText(args: {
  count: number;
  config: SemrushAutoRetryOverdueAlertConfig;
}): string {
  return [
    `:warning: *Semrush auto-retry — due rows not being picked up*`,
    `• *${args.count}* row(s) in \`semrush_location_sync_state\` with \`status='failed'\` whose \`next_retry_at\` has been overdue for more than *${args.config.ageMinutes}m*`,
    `• Threshold: ≥ ${args.config.countThreshold} row(s)`,
    `• The auto-retry ticker claims due rows every ~30s — rows overdue this long mean the ticker is not running (scheduler wedged, cross-instance lock stuck) and failed locations have silently stopped retrying.`,
  ].join("\n");
}

export interface SemrushAutoRetryOverdueCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  alertsSent: number;
  count: number;
  threshold: number;
  ageMinutes: number;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_kill_switch"
    | "skipped_below_threshold"
    | "skipped_streak_already_alerted"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  skipReason?: string;
}

export async function checkSemrushAutoRetryOverdue(
  now: number = Date.now(),
): Promise<SemrushAutoRetryOverdueCheckResult> {
  const config = await getSemrushAutoRetryOverdueAlertConfig();
  const baseResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    threshold: config.countThreshold,
    ageMinutes: config.ageMinutes,
  };

  if (!config.enabled) {
    // Disabled ⇒ observational only; never touches the streak state.
    const count = await countOverdueRetries(config.ageMinutes).catch(() => 0);
    return {
      ...baseResult,
      alertsSent: 0,
      count,
      decision: "skipped_disabled",
      skipReason: "alert disabled in system_settings",
    };
  }

  // Operator kill switch ON ⇒ the lane is intentionally stopped, so
  // overdue rows are expected, not an anomaly. No observation is made,
  // so the streak state stays untouched.
  if (isKillSwitchEnabled("auto_retry")) {
    const count = await countOverdueRetries(config.ageMinutes).catch(() => 0);
    return {
      ...baseResult,
      alertsSent: 0,
      count,
      decision: "skipped_kill_switch",
      skipReason: "auto_retry kill switch enabled - overdue rows expected during operator stop",
    };
  }

  const count = await countOverdueRetries(config.ageMinutes);

  if (count < config.countThreshold) {
    // Recovery: the overdue backlog cleared (ticker drained it, or an
    // operator intervened) — re-arm for the next streak.
    await rearmAfterHealthyObservation();
    return {
      ...baseResult,
      alertsSent: 0,
      count,
      decision: "skipped_below_threshold",
      skipReason: `count ${count} < threshold ${config.countThreshold}`,
    };
  }

  if (streakAlerted) {
    return {
      ...baseResult,
      alertsSent: 0,
      count,
      decision: "skipped_streak_already_alerted",
      skipReason: "already alerted for this overdue streak - a healthy observation re-arms",
    };
  }

  const text = buildAlertText({ count, config });
  let delivered = false;
  let dispatchStatus: string | undefined;
  let skipReason: string | undefined;
  try {
    const notifyByType =
      dispatcherOverride ?? (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        // Stable dedupe key: the dispatcher's DB-backed transition dedupe is
        // what makes "once per streak" hold across restarts.
        dedupeKey: DEDUPE_KEY,
        metadata: {
          count,
          threshold: config.countThreshold,
          ageMinutes: config.ageMinutes,
        },
      },
    );
    delivered = r.delivered;
    dispatchStatus = r.status;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: any) {
    console.error(`[SemrushAutoRetryOverdueAlerts] dispatch failed: ${err?.message}`);
    skipReason = `dispatch_error:${err?.message ?? "unknown"}`;
  }

  if (delivered) {
    streakAlerted = true;
    return {
      ...baseResult,
      alertsSent: 1,
      count,
      decision: "alerted",
    };
  }
  if (dispatchStatus === "skipped_deduped") {
    // The dispatcher's persisted health state says this streak was already
    // alerted (typically before a restart) — adopt it instead of retrying
    // every tick until the 6h reminder window opens.
    streakAlerted = true;
    return {
      ...baseResult,
      alertsSent: 0,
      count,
      decision: "skipped_streak_already_alerted",
      skipReason: skipReason ?? "dispatcher transition dedupe: streak already alerted",
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
      const r = await checkSemrushAutoRetryOverdue();
      if (r.alertsSent > 0) {
        console.log(
          `[SemrushAutoRetryOverdueAlerts] sent=${r.alertsSent} count=${r.count} ageMinutes=${r.ageMinutes}`,
        );
      }
    } catch (err: any) {
      console.warn(`[SemrushAutoRetryOverdueAlerts] tick failed: ${err?.message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startSemrushAutoRetryOverdueAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution("scheduler:semrush-auto-retry-overdue-alerts", () => tick());
  }, CHECK_INTERVAL_MS);
  interval.unref?.();
  console.log(
    `[SemrushAutoRetryOverdueAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopSemrushAutoRetryOverdueAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_ID,
  DEDUPE_KEY,
  DEFAULTS,
  resetLastAlertCache(): void {
    streakAlerted = false;
  },
  getStreakAlerted(): boolean {
    return streakAlerted;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  setMarkRecoveredForTests(fn: MarkRecoveredFn | null): void {
    markRecoveredOverride = fn;
  },
};
