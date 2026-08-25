/**
 * Task #1689 — Alert when the Front self-healing coverage loop itself
 * is stalled.
 *
 * Task #1682 wires up the auto-closer (`runFrontAutoClosureTick` in
 * `frontAutoClosure.ts`) which persists its last summary in
 * `system_settings.front_auto_closure_state`. If the loop itself stops
 * running (coverage-refresh worker stalled, master kill switch flipped
 * and forgotten, `lastSelfError` keeps re-tripping) nothing pages an
 * operator today: the existing regression alerter (Task #1684) detects
 * a stale summary as one of seven conditions, but it has no dedicated
 * recovery-alert and shares state with five other conditions. This
 * watcher is the lightweight, dedicated counterpart for the
 * loop-stalled signal alone — mirroring
 * `slackAuthBreakerStuckAlerts.ts` (Task #1610) so operators get the
 * same stuck → recovered pair pattern they already know.
 *
 * What it fires on:
 *   • `lastSummary.ranAt` older than
 *     `front_auto_closure_stalled_loop_alert_threshold_minutes`
 *     (default 30, ≈ one coverage refresh interval), OR
 *   • `lastSummary.lastSelfError` non-null for
 *     `front_auto_closure_stalled_loop_alert_self_error_streak`
 *     consecutive ticks (default 3 — needs to be sticky so a single
 *     transient orchestrator throw doesn't page).
 *
 * Both branches respect:
 *   • Master kill switch `front_auto_closure_stalled_loop_alerts_enabled`
 *   • Per-alert cooldown
 *     `front_auto_closure_stalled_loop_alert_cooldown_minutes`
 *     (default 360, same default as the Slack auth breaker watcher).
 *
 * Recovery alert (`pipeline.front_auto_closure.loop_recovered`) fires
 * exactly once after a stuck alert when the summary becomes fresh AND
 * `lastSelfError` is null again.
 *
 * MEASUREMENT-ONLY: never reads or writes the auto-closer's
 * orchestration state outside `getFrontAutoClosureStatus()`.
 */
import { getFrontAutoClosureStatus } from "./frontAutoClosure";
import { getSystemSetting } from "../storage/settingsStorage";
import { withDbAttribution } from "../db";

const STUCK_NOTIFICATION_ID = "pipeline.front_auto_closure.loop_stalled";
const RECOVERED_NOTIFICATION_ID = "pipeline.front_auto_closure.loop_recovered";

export const SETTING_ENABLED = "front_auto_closure_stalled_loop_alerts_enabled";
export const SETTING_THRESHOLD_MINUTES =
  "front_auto_closure_stalled_loop_alert_threshold_minutes";
export const SETTING_COOLDOWN_MINUTES =
  "front_auto_closure_stalled_loop_alert_cooldown_minutes";
export const SETTING_SELF_ERROR_STREAK =
  "front_auto_closure_stalled_loop_alert_self_error_streak";

const DEFAULTS = {
  enabled: true,
  thresholdMinutes: 30,
  cooldownMinutes: 6 * 60,
  selfErrorStreak: 3,
};

const CHECK_INTERVAL_MS = 5 * 60_000;

const RUNBOOK_LINK =
  "FRONT_ANALYTICS_COVERAGE.md#auto-closure-loop-stalled-alerts";

export interface FrontAutoClosureStalledConfig {
  enabled: boolean;
  thresholdMinutes: number;
  cooldownMinutes: number;
  selfErrorStreak: number;
}

export type StuckReason = "stale_summary" | "self_error_streak";

export interface FrontAutoClosureStalledLastAlert {
  alertedAt: Date;
  reason: StuckReason;
  lastRanAt: string | null;
  lastSelfError: string | null;
  streakAtAlert: number;
}

interface InMemoryState {
  lastObservedRanAt: string | null;
  selfErrorStreak: number;
  lastAlert: FrontAutoClosureStalledLastAlert | null;
}

let state: InMemoryState = {
  lastObservedRanAt: null,
  selfErrorStreak: 0,
  lastAlert: null,
};

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

type StatusFn = typeof getFrontAutoClosureStatus;
let statusOverride: StatusFn | null = null;

// Task #2200 — in-memory config override so the alerter tests can drive
// their scenarios without writing the shared `system_settings` config
// rows the always-on dev-server scheduler also reads. Production passes
// nothing and the config is read from `system_settings` as before.
let configOverride: FrontAutoClosureStalledConfig | null = null;

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

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

/**
 * Fails open with defaults if `system_settings` is unreachable —
 * an alerting subsystem must never go silent because a config read
 * failed.
 */
export async function getFrontAutoClosureStalledConfig(): Promise<FrontAutoClosureStalledConfig> {
  if (configOverride) return configOverride;
  const [enabledRow, thresholdRow, cooldownRow, streakRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_THRESHOLD_MINUTES).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN_MINUTES).catch(() => null),
    getSystemSetting(SETTING_SELF_ERROR_STREAK).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    thresholdMinutes: parsePositiveInt(
      thresholdRow?.value,
      DEFAULTS.thresholdMinutes,
    ),
    cooldownMinutes: parsePositiveInt(
      cooldownRow?.value,
      DEFAULTS.cooldownMinutes,
    ),
    selfErrorStreak: parsePositiveInt(
      streakRow?.value,
      DEFAULTS.selfErrorStreak,
    ),
  };
}

function buildStuckText(args: {
  reason: StuckReason;
  lastRanAt: string | null;
  minutesSinceRun: number | null;
  lastSelfError: string | null;
  streak: number;
  config: FrontAutoClosureStalledConfig;
  enabledInConfig: boolean;
  skippedReason: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`:warning: *Front auto-closure loop is stalled*`);
  if (args.reason === "stale_summary") {
    lines.push(
      `• Reason: \`stale_summary\` — no new tick for ${
        args.minutesSinceRun != null
          ? `${args.minutesSinceRun}m`
          : "unknown duration"
      } (threshold ${args.config.thresholdMinutes}m)`,
    );
  } else {
    lines.push(
      `• Reason: \`self_error_streak\` — \`lastSelfError\` non-null for ${args.streak} consecutive ticks (threshold ${args.config.selfErrorStreak})`,
    );
  }
  lines.push(
    `• Last run: ${args.lastRanAt ?? "never (no summary persisted)"}`,
  );
  lines.push(
    `• Loop enabled in config: ${args.enabledInConfig ? "yes" : "no (master kill switch tripped?)"}`,
  );
  if (args.skippedReason) {
    lines.push(`• Last tick skip reason: \`${args.skippedReason}\``);
  }
  if (args.lastSelfError) {
    lines.push(
      `• Last self-error: \`${args.lastSelfError.slice(0, 200)}\``,
    );
  }
  lines.push(
    `• Recommended action: check the front-analytics coverage refresh worker is dispatching, confirm \`front_auto_closure_enabled\` / \`front_analytics_refresh_enabled\` / \`KILL_SWITCH_NON_CRITICAL_SWEEPS\`, and inspect \`system_settings.front_auto_closure_state\` for the last summary.`,
  );
  lines.push(`• Runbook: ${RUNBOOK_LINK}`);
  return lines.join("\n");
}

function buildRecoveredText(args: {
  recoveredAt: Date;
  newLastRanAt: string | null;
  previousAlertedAt: Date;
  previousReason: StuckReason;
}): string {
  return [
    `:white_check_mark: *Front auto-closure loop recovered*`,
    `The Front self-healing coverage loop is producing fresh, error-free summaries again.`,
    `• Recovered at: ${args.recoveredAt.toISOString()}`,
    `• Latest summary ranAt: ${args.newLastRanAt ?? "n/a"}`,
    `• Previous stuck alert at: ${args.previousAlertedAt.toISOString()}`,
    `• Prior stuck reason: \`${args.previousReason}\``,
    `• Runbook: ${RUNBOOK_LINK}`,
  ].join("\n");
}

export type FrontAutoClosureStalledDecision =
  | "alerted"
  | "recovered"
  | "skipped_below_threshold"
  | "skipped_cooldown"
  | "skipped_no_summary"
  | "skipped_dispatcher_skipped"
  | "skipped_disabled";

export interface FrontAutoClosureStalledCheckResult {
  decision: FrontAutoClosureStalledDecision;
  alertsSent: number;
  lastAlert: FrontAutoClosureStalledLastAlert | null;
  skipReason?: string;
}

async function callDispatcher(
  id: string,
  text: string,
  metadata: Record<string, unknown>,
): Promise<{ delivered: boolean; skipReason?: string }> {
  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      id,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        bypassDedupe: true,
        metadata,
      },
    );
    return {
      delivered: r.delivered,
      skipReason: r.delivered ? undefined : (r.skipReason ?? r.status),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[FrontAutoClosureStalled] dispatch failed: ${msg}`);
    return {
      delivered: false,
      skipReason: `dispatch_error:${msg || "unknown"}`,
    };
  }
}

export async function checkFrontAutoClosureStalledLoop(
  now: Date = new Date(),
): Promise<FrontAutoClosureStalledCheckResult> {
  const config = await getFrontAutoClosureStalledConfig();
  if (!config.enabled) {
    return {
      decision: "skipped_disabled",
      alertsSent: 0,
      lastAlert: state.lastAlert,
      skipReason: "alert disabled in system_settings",
    };
  }

  const statusFn = statusOverride ?? getFrontAutoClosureStatus;
  const status = await statusFn({ now });
  const summary = status.lastSummary;

  // Maintain the consecutive `lastSelfError` streak. Only advance the
  // streak on a NEW tick (ranAt change) so repeated watcher polls
  // between two auto-closer runs don't inflate the count.
  if (summary) {
    if (state.lastObservedRanAt !== summary.ranAt) {
      if (summary.lastSelfError) {
        state.selfErrorStreak += 1;
      } else {
        state.selfErrorStreak = 0;
      }
      state.lastObservedRanAt = summary.ranAt;
    }
  }

  const ranAtMs = summary ? new Date(summary.ranAt).getTime() : NaN;
  const haveRanAt = Number.isFinite(ranAtMs);
  const minutesSinceRun = haveRanAt
    ? Math.max(0, Math.round((now.getTime() - ranAtMs) / 60_000))
    : null;

  // ── Recovery branch (comes first) ─────────────────────────────────
  if (
    state.lastAlert &&
    summary &&
    haveRanAt &&
    minutesSinceRun != null &&
    minutesSinceRun <= config.thresholdMinutes &&
    !summary.lastSelfError
  ) {
    const text = buildRecoveredText({
      recoveredAt: now,
      newLastRanAt: summary.ranAt,
      previousAlertedAt: state.lastAlert.alertedAt,
      previousReason: state.lastAlert.reason,
    });
    const metadata: Record<string, unknown> = {
      recoveredAt: now.toISOString(),
      latestRanAt: summary.ranAt,
      previousAlertedAt: state.lastAlert.alertedAt.toISOString(),
      previousReason: state.lastAlert.reason,
    };
    const r = await callDispatcher(RECOVERED_NOTIFICATION_ID, text, metadata);
    if (r.delivered) {
      console.log(
        `[FrontAutoClosureStalled] loop recovered; sent recovery alert ranAt=${summary.ranAt}`,
      );
      state.lastAlert = null;
      return {
        decision: "recovered",
        alertsSent: 1,
        lastAlert: null,
      };
    }
    return {
      decision: "skipped_dispatcher_skipped",
      alertsSent: 0,
      lastAlert: state.lastAlert,
      skipReason: r.skipReason,
    };
  }

  // ── Stuck branch ──────────────────────────────────────────────────
  if (!summary) {
    // No summary persisted yet — we can't tell if the loop is stalled
    // or simply hasn't run since boot. Stay quiet rather than page on
    // a fresh deploy.
    return {
      decision: "skipped_no_summary",
      alertsSent: 0,
      lastAlert: state.lastAlert,
      skipReason: "no auto-closure summary persisted yet",
    };
  }

  const staleSummary =
    haveRanAt &&
    minutesSinceRun != null &&
    minutesSinceRun > config.thresholdMinutes;
  const selfErrorStuck = state.selfErrorStreak >= config.selfErrorStreak;

  if (!staleSummary && !selfErrorStuck) {
    console.log(
      `[FrontAutoClosureStalled] Skipped below threshold minutesSinceRun=${minutesSinceRun} threshold=${config.thresholdMinutes} selfErrorStreak=${state.selfErrorStreak}/${config.selfErrorStreak}`,
    );
    return {
      decision: "skipped_below_threshold",
      alertsSent: 0,
      lastAlert: state.lastAlert,
      skipReason: `minutesSinceRun=${minutesSinceRun} ≤ ${config.thresholdMinutes} and selfErrorStreak=${state.selfErrorStreak} < ${config.selfErrorStreak}`,
    };
  }

  if (state.lastAlert) {
    const elapsedMs = now.getTime() - state.lastAlert.alertedAt.getTime();
    if (elapsedMs < config.cooldownMinutes * 60_000) {
      const elapsedMin = Math.round(elapsedMs / 60_000);
      console.log(
        `[FrontAutoClosureStalled] Skipped cooldown lastAlert=${state.lastAlert.alertedAt.toISOString()} cooldownMinutes=${config.cooldownMinutes}`,
      );
      return {
        decision: "skipped_cooldown",
        alertsSent: 0,
        lastAlert: state.lastAlert,
        skipReason: `cooldown ${elapsedMin}m < ${config.cooldownMinutes}m`,
      };
    }
  }

  // Prefer the more actionable reason when both signals trip together.
  const reason: StuckReason = staleSummary
    ? "stale_summary"
    : "self_error_streak";

  const text = buildStuckText({
    reason,
    lastRanAt: summary.ranAt,
    minutesSinceRun,
    lastSelfError: summary.lastSelfError ?? null,
    streak: state.selfErrorStreak,
    config,
    enabledInConfig: status.config.enabled,
    skippedReason: summary.skippedReason ?? null,
  });
  const metadata: Record<string, unknown> = {
    reason,
    lastRanAt: summary.ranAt,
    minutesSinceRun,
    selfErrorStreak: state.selfErrorStreak,
    lastSelfError: summary.lastSelfError ?? null,
    skippedReason: summary.skippedReason ?? null,
    thresholdMinutes: config.thresholdMinutes,
    cooldownMinutes: config.cooldownMinutes,
    selfErrorStreakThreshold: config.selfErrorStreak,
    loopEnabledInConfig: status.config.enabled,
  };
  const r = await callDispatcher(STUCK_NOTIFICATION_ID, text, metadata);
  if (r.delivered) {
    state.lastAlert = {
      alertedAt: now,
      reason,
      lastRanAt: summary.ranAt,
      lastSelfError: summary.lastSelfError ?? null,
      streakAtAlert: state.selfErrorStreak,
    };
    console.log(
      `[FrontAutoClosureStalled] Alerting stalled loop reason=${reason} lastRanAt=${summary.ranAt} minutesSinceRun=${minutesSinceRun} selfErrorStreak=${state.selfErrorStreak}`,
    );
    return { decision: "alerted", alertsSent: 1, lastAlert: state.lastAlert };
  }
  // Dispatcher skipped — do NOT arm cooldown so a future tick (after
  // the notification subsystem recovers) can deliver.
  return {
    decision: "skipped_dispatcher_skipped",
    alertsSent: 0,
    lastAlert: state.lastAlert,
    skipReason: r.skipReason,
  };
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await checkFrontAutoClosureStalledLoop();
      console.log(
        `[FrontAutoClosureStalled] tick decision=${r.decision} alertsSent=${r.alertsSent}${
          r.skipReason ? ` skipReason="${r.skipReason}"` : ""
        }`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[FrontAutoClosureStalled] tick failed: ${msg}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startFrontAutoClosureStalledLoopAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution(
      "scheduler:front-auto-closure-stalled-loop-alerts",
      () => tick(),
    );
  }, CHECK_INTERVAL_MS);
  interval.unref?.();
  console.log(
    `[FrontAutoClosureStalled] scheduler started (check every ${
      CHECK_INTERVAL_MS / 60_000
    }min)`,
  );
}

export function stopFrontAutoClosureStalledLoopAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __frontAutoClosureStalledLoopTestHelpers = {
  STUCK_NOTIFICATION_ID,
  RECOVERED_NOTIFICATION_ID,
  DEFAULTS,
  resetStateForTests(): void {
    state = {
      lastObservedRanAt: null,
      selfErrorStreak: 0,
      lastAlert: null,
    };
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  setStatusProviderForTests(fn: StatusFn | null): void {
    statusOverride = fn;
  },
  // Task #2200 — drive config from memory instead of shared
  // `system_settings` rows so concurrent dev-server writers can't race
  // the test. Pass `null` to restore production (system_settings) reads.
  setConfigForTests(cfg: FrontAutoClosureStalledConfig | null): void {
    configOverride = cfg;
  },
  getStateForTests(): InMemoryState {
    return state;
  },
};
