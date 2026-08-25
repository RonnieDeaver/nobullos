// @cross-instance-safe: read-only COUNT probe + notifyByType alert whose once-per-streak
// @cross-instance-safe:   state is backed by the dispatcher's DB-backed notification_health_state
// @cross-instance-safe:   (shared dedupe key) — same streak class as semrushDisconnectAlert;
// @cross-instance-safe:   duplicate instances at worst re-attempt a dispatch the transition dedupe absorbs.
/**
 * Workers/queues audit parity (E-F15/E-F16) — alert when Local Dominance
 * per-location sync rows stay stuck in `status='in_progress'` past the
 * lane ceiling.
 *
 * Background
 * ----------
 * `semrush_location_sync_state` rows are flipped to `in_progress` by
 * `beginAttempt` and are supposed to reach a terminal status via
 * `completeAttempt` within one location budget (~minutes). The worker's
 * `sweepStuckInProgress` pass promotes crashed rows to `failed/timeout`
 * at the start of each sweep — but that recovery is SILENT and only runs
 * while the worker itself is healthy. What was missing (E-F15) is a page
 * when stuck rows accumulate: worker dead, scheduler wedged, or rows
 * churning back into in_progress repeatedly.
 *
 * Predicate
 * ---------
 * A row is alert-worthy when ALL hold:
 *   - `status = 'in_progress'`
 *   - `last_attempt_at IS NOT NULL`
 *   - `last_attempt_at <= NOW() - ageMinutes`
 *
 * The default `ageMinutes` is the `local_dominance_sync` max-processing
 * ceiling (default 4h — same value the recovery sweep uses), so a healthy
 * sweep will normally promote rows BEFORE this watcher sees them; anything
 * this watcher counts survived at least one missed recovery pass. Rows
 * inside an active lease window are therefore never counted — healthy
 * in-flight work stays quiet.
 *
 * Kill-switch interplay: this watcher keeps firing while the
 * `local_dominance_sync` kill switch is ON — deliberately. The switch
 * also stops the recovery sweep, so pre-existing in_progress rows CANNOT
 * self-heal during an operator stop; a page telling the operator "rows
 * are stuck and recovery is off" is signal, not noise.
 *
 * Alert-state semantics (E-F16 — once per stuck streak)
 * -----------------------------------------------------
 * Mirrors `semrushDisconnectAlert` / the dispatcher's transition dedupe:
 *   - a per-process `streakAlerted` flag suppresses repeats within one
 *     stuck streak (exactly one page per streak per process — count growth
 *     no longer re-fires; the page already says recovery is not running);
 *   - the dispatch itself carries a stable `dedupeKey`, so the dispatcher
 *     persists an `unhealthy` transition in `notification_health_state`.
 *     That state SURVIVES RESTARTS: a restarted process that observes the
 *     same ongoing streak gets `skipped_deduped` from the dispatcher and
 *     re-adopts the flag instead of double-paging (after 6h of sustained
 *     stuckness the dispatcher sends its standard reminder — accepted);
 *   - every healthy observation (count below threshold) clears the flag
 *     AND calls `markRecovered`, so the NEXT streak alerts immediately.
 *
 * Channel/enabled state lives in `notification_settings` for
 * `queue.local_dominance_sync.stuck_rows` (registry id); threshold knobs
 * live in `system_settings` so an admin can tune them without a deploy.
 */
import { sql } from "drizzle-orm";
import { workerDb as db, withDbAttribution } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";
import { getMaxProcessingMs } from "./queueMaxProcessing";

const NOTIFICATION_ID = "queue.local_dominance_sync.stuck_rows";
/** Stable transition-dedupe identity for this watcher's single signal. */
const DEDUPE_KEY = "local_dominance_sync:stuck_rows";

export const SETTING_ENABLED = "local_dominance_stuck_sync_alert_enabled";
export const SETTING_AGE_MINUTES = "local_dominance_stuck_sync_alert_age_minutes";
export const SETTING_COUNT = "local_dominance_stuck_sync_alert_count_threshold";

const DEFAULTS = {
  enabled: true,
  // ageMinutes default is resolved dynamically from the
  // local_dominance_sync ceiling at evaluation time when the setting is
  // missing/blank.
  countThreshold: 1,
};

const CHECK_INTERVAL_MS = 15 * 60_000;

export interface LocalDominanceStuckSyncAlertConfig {
  enabled: boolean;
  ageMinutes: number;
  /**
   * True when `ageMinutes` was resolved from the local_dominance_sync
   * ceiling (no explicit `system_settings` override).
   */
  ageMinutesFromCeiling: boolean;
  countThreshold: number;
}

/**
 * Per-process streak gate. Set after the first delivery (or a dispatcher
 * `skipped_deduped` proving a pre-restart delivery) within a stuck streak;
 * cleared only by a healthy observation.
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

export async function getLocalDominanceStuckSyncAlertConfig(): Promise<LocalDominanceStuckSyncAlertConfig> {
  const [enabledRow, ageRow, countRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_AGE_MINUTES).catch(() => null),
    getSystemSetting(SETTING_COUNT).catch(() => null),
  ]);
  const ageRaw = ageRow?.value ? String(ageRow.value).trim() : "";
  const ageOverride = ageRaw ? Number.parseInt(ageRaw, 10) : NaN;
  let ageMinutes: number;
  let ageMinutesFromCeiling: boolean;
  if (Number.isFinite(ageOverride) && ageOverride > 0) {
    ageMinutes = ageOverride;
    ageMinutesFromCeiling = false;
  } else {
    const ceilingMs = await getMaxProcessingMs("local_dominance_sync").catch(() => 4 * 60 * 60_000);
    ageMinutes = Math.max(1, Math.round(ceilingMs / 60_000));
    ageMinutesFromCeiling = true;
  }
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    ageMinutes,
    ageMinutesFromCeiling,
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
      `[LocalDominanceStuckSyncAlerts] markRecovered failed (non-fatal): ${err?.message ?? err}`,
    );
  }
}

/**
 * Canonical SQL predicate for "stuck past ceiling" — exported so tests
 * can reuse the exact same shape the watcher evaluates.
 */
export function stuckInProgressWhere(ageMinutes: number) {
  return sql`status = 'in_progress'
    AND last_attempt_at IS NOT NULL
    AND last_attempt_at <= NOW() - (${ageMinutes} || ' minutes')::interval`;
}

async function countStuckInProgress(ageMinutes: number): Promise<number> {
  const r = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM semrush_location_sync_state
    WHERE ${stuckInProgressWhere(ageMinutes)}
  `);
  return Number((r.rows?.[0] as any)?.n ?? 0);
}

function buildAlertText(args: {
  count: number;
  config: LocalDominanceStuckSyncAlertConfig;
}): string {
  const sourceNote = args.config.ageMinutesFromCeiling
    ? ` (local_dominance_sync ceiling)`
    : "";
  return [
    `:warning: *Local Dominance sync — rows stuck in in_progress*`,
    `• *${args.count}* row(s) in \`semrush_location_sync_state\` with \`status='in_progress'\` whose last attempt started more than *${args.config.ageMinutes}m* ago${sourceNote}`,
    `• Threshold: ≥ ${args.config.countThreshold} row(s)`,
    `• The worker's stuck-in_progress sweep normally promotes these to failed/timeout at the start of each sweep — a growing count means the Local Dominance worker (and with it, recovery) is not running, or rows are churning back into in_progress repeatedly.`,
  ].join("\n");
}

export interface LocalDominanceStuckSyncCheckResult {
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
    | "skipped_streak_already_alerted"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  skipReason?: string;
}

export async function checkLocalDominanceStuckSync(
  now: number = Date.now(),
): Promise<LocalDominanceStuckSyncCheckResult> {
  const config = await getLocalDominanceStuckSyncAlertConfig();
  const baseResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    threshold: config.countThreshold,
    ageMinutes: config.ageMinutes,
    ageMinutesFromCeiling: config.ageMinutesFromCeiling,
  };

  if (!config.enabled) {
    // Disabled ⇒ observational only; never touches the streak state.
    const count = await countStuckInProgress(config.ageMinutes).catch(() => 0);
    return {
      ...baseResult,
      alertsSent: 0,
      count,
      decision: "skipped_disabled",
      skipReason: "alert disabled in system_settings",
    };
  }

  const count = await countStuckInProgress(config.ageMinutes);

  if (count < config.countThreshold) {
    // Recovery: the stuck backlog cleared (sweep promoted the rows, or an
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
      skipReason: "already alerted for this stuck streak - a healthy observation re-arms",
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
          ageMinutesFromCeiling: config.ageMinutesFromCeiling,
        },
      },
    );
    delivered = r.delivered;
    dispatchStatus = r.status;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: any) {
    console.error(
      `[LocalDominanceStuckSyncAlerts] dispatch failed: ${err?.message}`,
    );
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
      const r = await checkLocalDominanceStuckSync();
      if (r.alertsSent > 0) {
        console.log(
          `[LocalDominanceStuckSyncAlerts] sent=${r.alertsSent} count=${r.count} ageMinutes=${r.ageMinutes}`,
        );
      }
    } catch (err: any) {
      console.warn(`[LocalDominanceStuckSyncAlerts] tick failed: ${err?.message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startLocalDominanceStuckSyncAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution("scheduler:local-dominance-stuck-sync-alerts", () => tick());
  }, CHECK_INTERVAL_MS);
  interval.unref?.();
  console.log(
    `[LocalDominanceStuckSyncAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopLocalDominanceStuckSyncAlertsScheduler(): void {
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
