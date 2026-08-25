/**
 * Task #2663 — Alert when the Replit Auth session-refresh breaker
 * (`server/services/replitAuthBreaker.ts`) is persistently tripped.
 *
 * The per-session breaker correctly handles ordinary churn: a single operator
 * whose refresh-token family went terminal is gated, routed to a clean
 * sign-in, and their next successful login ends the sustained-failure streak.
 * That is NOT an outage and must never page anyone.
 *
 * What DOES warrant an operator alert is a sustained streak — terminal trips
 * that keep happening with NO successful refresh of any session in between,
 * past the configured threshold. That pattern means the issue is issuer-wide
 * (e.g. the OIDC provider rejecting every refresh) rather than one operator who
 * just needs to re-login.
 *
 * This watcher reads the aggregate telemetry exposed by
 * `getReplitAuthBreakerState()` (specifically `streakStartedAt`) and emits two
 * notifications via the unified `notifyByType` dispatcher:
 *   • `integration.replit_auth.breaker_stuck` — fires once per cooldown window
 *     after the open streak has lasted longer than the configured threshold.
 *   • `integration.replit_auth.breaker_recovered` — fires exactly once after a
 *     stuck alert previously fired and a session refresh has since succeeded
 *     (the streak ended).
 *
 * The breaker is unchanged. This watcher is observability + alerts only and
 * must never call into the breaker's control flow.
 */
import { getReplitAuthBreakerState } from "./replitAuthBreaker";
import { getSystemSetting } from "../storage/settingsStorage";
import { withDbAttribution } from "../db";

const STUCK_NOTIFICATION_ID = "integration.replit_auth.breaker_stuck";
const RECOVERED_NOTIFICATION_ID = "integration.replit_auth.breaker_recovered";

export const SETTING_ENABLED = "replit_auth_breaker_alerts_enabled";
export const SETTING_THRESHOLD_MINUTES = "replit_auth_breaker_stuck_threshold_minutes";
export const SETTING_COOLDOWN_MINUTES = "replit_auth_breaker_stuck_cooldown_minutes";

const DEFAULTS = {
  enabled: true,
  thresholdMinutes: 15,
  cooldownMinutes: 6 * 60,
};

const CHECK_INTERVAL_MS = 5 * 60_000;

export interface ReplitAuthBreakerStuckConfig {
  enabled: boolean;
  thresholdMinutes: number;
  cooldownMinutes: number;
}

export interface ReplitAuthBreakerLastAlert {
  alertType: "stuck";
  alertedAt: Date;
  streakStartedAt: Date | null;
  lastTrippedCode: string | null;
}

let lastAlert: ReplitAuthBreakerLastAlert | null = null;

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

/**
 * Loader fails open with defaults if `system_settings` is unreachable.
 * Operator intent: an alerting subsystem must never go silent because a
 * config read failed.
 */
export async function getReplitAuthBreakerStuckConfig(): Promise<ReplitAuthBreakerStuckConfig> {
  const [enabledRow, thresholdRow, cooldownRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_THRESHOLD_MINUTES).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN_MINUTES).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    thresholdMinutes: parsePositiveInt(thresholdRow?.value, DEFAULTS.thresholdMinutes),
    cooldownMinutes: parsePositiveInt(cooldownRow?.value, DEFAULTS.cooldownMinutes),
  };
}

function parseIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function buildStuckText(args: {
  lastTrippedCode: string | null;
  streakStartedAt: Date | null;
  lastSuccessAt: Date | null;
  minutesInStreak: number;
  config: ReplitAuthBreakerStuckConfig;
  deadSessionCount: number;
}): string {
  return [
    `:warning: *Replit Auth session-refresh breaker is persistently tripped*`,
    `• Last terminal code: \`${args.lastTrippedCode ?? "unknown"}\``,
    `• Streak started at: ${args.streakStartedAt ? args.streakStartedAt.toISOString() : "n/a"}`,
    `• Last successful refresh: ${args.lastSuccessAt ? args.lastSuccessAt.toISOString() : "never (or before boot)"}`,
    `• Minutes in sustained failure: *${args.minutesInStreak}m* (threshold ${args.config.thresholdMinutes}m)`,
    `• Sessions currently gated: ${args.deadSessionCount}`,
    `• Recommended action: This usually means the OIDC issuer is rejecting refresh tokens for everyone. Verify Replit Auth / OIDC issuer health; a single successful operator re-login will clear the streak.`,
  ].join("\n");
}

function buildRecoveredText(args: {
  recoveredAt: Date;
  lastSuccessAt: Date | null;
  previousAlertedAt: Date;
  lastTrippedCode: string | null;
}): string {
  return [
    `:white_check_mark: *Replit Auth session-refresh recovered*`,
    `Replit Auth session refresh has recovered after a sustained breaker-open period.`,
    `• Recovered at: ${args.recoveredAt.toISOString()}`,
    `• Last successful refresh: ${args.lastSuccessAt ? args.lastSuccessAt.toISOString() : "n/a"}`,
    `• Previous stuck alert at: ${args.previousAlertedAt.toISOString()}`,
    `• Prior terminal code: \`${args.lastTrippedCode ?? "unknown"}\``,
  ].join("\n");
}

export type ReplitAuthBreakerCheckDecision =
  | "alerted"
  | "recovered"
  | "skipped_below_threshold"
  | "skipped_cooldown"
  | "skipped_dispatcher_skipped"
  | "skipped_disabled";

export interface ReplitAuthBreakerCheckResult {
  decision: ReplitAuthBreakerCheckDecision;
  alertsSent: number;
  lastAlert: ReplitAuthBreakerLastAlert | null;
  skipReason?: string;
}

async function callDispatcher(
  id: string,
  text: string,
  metadata: Record<string, unknown>,
): Promise<{ delivered: boolean; skipReason?: string }> {
  try {
    const notifyByType =
      dispatcherOverride ?? (await import("./notifications/dispatcher")).notifyByType;
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
      skipReason: r.delivered ? undefined : r.skipReason ?? r.status,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ReplitAuthBreakerStuck] dispatch failed: ${msg}`);
    return { delivered: false, skipReason: `dispatch_error:${msg || "unknown"}` };
  }
}

export async function checkReplitAuthBreakerStuck(
  now: Date = new Date(),
): Promise<ReplitAuthBreakerCheckResult> {
  const config = await getReplitAuthBreakerStuckConfig();
  if (!config.enabled) {
    return {
      decision: "skipped_disabled",
      alertsSent: 0,
      lastAlert,
      skipReason: "alert disabled in system_settings",
    };
  }

  const state = getReplitAuthBreakerState();
  const streakStartedAt = parseIso(state.streakStartedAt);
  const lastSuccessAt = parseIso(state.lastSuccessAt);

  // ── Recovery branch (comes first) ─────────────────────────────────
  // A stuck alert fired previously and the streak has since ended (no open
  // streak) thanks to a successful refresh after that alert.
  if (
    lastAlert &&
    !streakStartedAt &&
    lastSuccessAt &&
    lastSuccessAt.getTime() > lastAlert.alertedAt.getTime()
  ) {
    const text = buildRecoveredText({
      recoveredAt: now,
      lastSuccessAt,
      previousAlertedAt: lastAlert.alertedAt,
      lastTrippedCode: lastAlert.lastTrippedCode,
    });
    const metadata: Record<string, unknown> = {
      recoveredAt: now.toISOString(),
      lastSuccessAt: lastSuccessAt.toISOString(),
      previousAlertedAt: lastAlert.alertedAt.toISOString(),
      lastTrippedCode: lastAlert.lastTrippedCode,
    };
    const r = await callDispatcher(RECOVERED_NOTIFICATION_ID, text, metadata);
    if (r.delivered) {
      console.log(
        `[ReplitAuthBreakerStuck] Replit Auth recovered; sent recovery alert lastSuccessAt=${lastSuccessAt.toISOString()}`,
      );
      lastAlert = null;
      return { decision: "recovered", alertsSent: 1, lastAlert: null };
    }
    return {
      decision: "skipped_dispatcher_skipped",
      alertsSent: 0,
      lastAlert,
      skipReason: r.skipReason,
    };
  }

  // ── Stuck branch ──────────────────────────────────────────────────
  if (!streakStartedAt) {
    return {
      decision: "skipped_below_threshold",
      alertsSent: 0,
      lastAlert,
      skipReason: "no open sustained-failure streak",
    };
  }

  const minutesInStreak = Math.max(
    0,
    Math.round((now.getTime() - streakStartedAt.getTime()) / 60_000),
  );

  if (minutesInStreak < config.thresholdMinutes) {
    console.log(
      `[ReplitAuthBreakerStuck] Skipped below threshold minutesInStreak=${minutesInStreak} threshold=${config.thresholdMinutes}`,
    );
    return {
      decision: "skipped_below_threshold",
      alertsSent: 0,
      lastAlert,
      skipReason: `minutesInStreak=${minutesInStreak} < threshold=${config.thresholdMinutes}`,
    };
  }

  if (lastAlert) {
    const elapsedMs = now.getTime() - lastAlert.alertedAt.getTime();
    if (elapsedMs < config.cooldownMinutes * 60_000) {
      const elapsedMin = Math.round(elapsedMs / 60_000);
      console.log(
        `[ReplitAuthBreakerStuck] Skipped cooldown lastAlert=${lastAlert.alertedAt.toISOString()} cooldownMinutes=${config.cooldownMinutes}`,
      );
      return {
        decision: "skipped_cooldown",
        alertsSent: 0,
        lastAlert,
        skipReason: `cooldown ${elapsedMin}m < ${config.cooldownMinutes}m`,
      };
    }
  }

  const text = buildStuckText({
    lastTrippedCode: state.lastTrippedCode,
    streakStartedAt,
    lastSuccessAt,
    minutesInStreak,
    config,
    deadSessionCount: state.deadSessionCount,
  });
  const metadata: Record<string, unknown> = {
    streakStartedAt: state.streakStartedAt,
    lastTrippedAt: state.lastTrippedAt,
    lastTrippedCode: state.lastTrippedCode,
    lastSuccessAt: state.lastSuccessAt,
    tripCount: state.tripCount,
    deadSessionCount: state.deadSessionCount,
    minutesInStreak,
    thresholdMinutes: config.thresholdMinutes,
    cooldownMinutes: config.cooldownMinutes,
    recommendedAction:
      "Verify Replit Auth / OIDC issuer health. A single successful operator re-login will clear the streak.",
  };
  const r = await callDispatcher(STUCK_NOTIFICATION_ID, text, metadata);
  if (r.delivered) {
    lastAlert = {
      alertType: "stuck",
      alertedAt: now,
      streakStartedAt,
      lastTrippedCode: state.lastTrippedCode,
    };
    console.log(
      `[ReplitAuthBreakerStuck] Alerting sustained Replit Auth breaker state lastCode=${state.lastTrippedCode} streakStartedAt=${state.streakStartedAt} minutesInStreak=${minutesInStreak}`,
    );
    return { decision: "alerted", alertsSent: 1, lastAlert };
  }
  // Dispatcher skipped — do NOT arm cooldown so a future tick (after the
  // notification subsystem recovers) can deliver.
  return {
    decision: "skipped_dispatcher_skipped",
    alertsSent: 0,
    lastAlert,
    skipReason: r.skipReason,
  };
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await checkReplitAuthBreakerStuck();
      console.log(
        `[ReplitAuthBreakerStuck] tick decision=${r.decision} alertsSent=${r.alertsSent}${
          r.skipReason ? ` skipReason="${r.skipReason}"` : ""
        }`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ReplitAuthBreakerStuck] tick failed: ${msg}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startReplitAuthBreakerStuckAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution(
      "scheduler:replit-auth-breaker-stuck-alerts",
      () => tick(),
    );
  }, CHECK_INTERVAL_MS);
  interval.unref?.();
  console.log(
    `[ReplitAuthBreakerStuck] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopReplitAuthBreakerStuckAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  STUCK_NOTIFICATION_ID,
  RECOVERED_NOTIFICATION_ID,
  DEFAULTS,
  resetLastAlertCache(): void {
    lastAlert = null;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  getLastAlertForTests(): ReplitAuthBreakerLastAlert | null {
    return lastAlert;
  },
};
