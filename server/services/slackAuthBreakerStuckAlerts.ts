/**
 * Task #1610 — Alert when the Slack auth circuit breaker (added by
 * Task #1602 in `server/services/slackIntegration.ts`) is persistently
 * tripping. The breaker itself protects us from hammering Slack when a
 * token has been revoked, but on its own it has a blind spot: a
 * permanently-broken token keeps reopening the breaker every 5 min
 * forever, and the only operator signal is one throttled log line.
 * Alert dispatchers silently record `not_configured` (Task #1602
 * intent), which is the right behavior for noise control but hides the
 * fact that Slack delivery is functionally dead.
 *
 * This watcher reads the minimal breaker introspection exposed by
 * `getSlackAuthState()` and emits two notifications via the unified
 * `notifyByType` dispatcher:
 *   • `pipeline.slack_auth.breaker_stuck` — fires once per cooldown
 *     window after Slack has been failing terminal auth checks for
 *     longer than the configured threshold (default 30 min).
 *   • `pipeline.slack_auth.breaker_recovered` — fires exactly once
 *     after a stuck alert previously fired and the breaker has since
 *     closed because of a successful Slack call (incl. `auth.test`).
 *
 * The Slack breaker is unchanged. This watcher is observability + alerts
 * only and must never call into the breaker's control flow.
 *
 * Slack-delivery caveat: while the Slack breaker is open the notification
 * registry will record `not_configured` for the Slack channel. The real
 * delivery channels for this alert are email + in-app (see
 * `server/services/notifications/registry.ts`).
 */
import { getSlackAuthState } from "./slackIntegration";
import { getSystemSetting } from "../storage/settingsStorage";
import { withDbAttribution } from "../db";

const SLACK_BOT_TOKEN_SETTING_KEY = "slack_bot_token";

const STUCK_NOTIFICATION_ID = "pipeline.slack_auth.breaker_stuck";
const RECOVERED_NOTIFICATION_ID = "pipeline.slack_auth.breaker_recovered";
/** Fires when feedback→Slack delivery has been dark for a sustained window
 * even though the auth breaker has not tripped (e.g. a negative-cache miss
 * that returned an empty token without ever making a Slack API call). */
const DELIVERY_DEAD_NOTIFICATION_ID = "pipeline.slack_delivery.dead";

export const SETTING_ENABLED = "slack_auth_breaker_alerts_enabled";
export const SETTING_THRESHOLD_MINUTES = "slack_auth_breaker_stuck_threshold_minutes";
export const SETTING_COOLDOWN_MINUTES = "slack_auth_breaker_stuck_cooldown_minutes";
/** Minutes of Slack silence (no successful call of any kind) that triggers the
 * delivery-dead alert when the auth breaker has NOT tripped. Default 60 min. */
export const SETTING_DELIVERY_DEAD_THRESHOLD_MINUTES = "slack_delivery_dead_alert_threshold_minutes";

const DEFAULTS = {
  enabled: true,
  thresholdMinutes: 30,
  cooldownMinutes: 6 * 60,
  deliveryDeadThresholdMinutes: 60,
};

const CHECK_INTERVAL_MS = 5 * 60_000;

const BOOT_AT_MS = Date.now();

export interface SlackAuthBreakerStuckConfig {
  enabled: boolean;
  thresholdMinutes: number;
  cooldownMinutes: number;
  deliveryDeadThresholdMinutes: number;
}

export interface SlackAuthBreakerLastAlert {
  alertType: "stuck";
  alertedAt: Date;
  lastTrippedAt: Date | null;
  lastTrippedCode: string | null;
  lastSuccessAtAtAlert: Date | null;
}

let lastAlert: SlackAuthBreakerLastAlert | null = null;
/** Separate per-process cooldown for the delivery-dead alert so it doesn't
 * share state with the auth-breaker-stuck alert. */
let lastDeliveryDeadAlertAt: Date | null = null;

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
export async function getSlackAuthBreakerStuckConfig(): Promise<SlackAuthBreakerStuckConfig> {
  const [enabledRow, thresholdRow, cooldownRow, deliveryDeadRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_THRESHOLD_MINUTES).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN_MINUTES).catch(() => null),
    getSystemSetting(SETTING_DELIVERY_DEAD_THRESHOLD_MINUTES).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    thresholdMinutes: parsePositiveInt(thresholdRow?.value, DEFAULTS.thresholdMinutes),
    cooldownMinutes: parsePositiveInt(cooldownRow?.value, DEFAULTS.cooldownMinutes),
    deliveryDeadThresholdMinutes: parsePositiveInt(
      deliveryDeadRow?.value,
      DEFAULTS.deliveryDeadThresholdMinutes,
    ),
  };
}

function parseIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * When was the Slack token last (re-)installed? We use
 * `system_settings.slack_bot_token.updatedAt` as a stable anchor for
 * "this Slack integration was set up at T" so the watcher's
 * minutes-since-last-success clock doesn't reset every time the
 * breaker re-trips on a permanently-revoked token. Fails open (null)
 * if the row is missing or the query fails.
 */
async function getSlackIntegrationSetupAt(): Promise<Date | null> {
  try {
    const row = await getSystemSetting(SLACK_BOT_TOKEN_SETTING_KEY);
    if (!row?.value) return null;
    const ts = row.updatedAt;
    if (!ts) return null;
    const d = ts instanceof Date ? ts : new Date(ts as unknown as string);
    return Number.isFinite(d.getTime()) ? d : null;
  } catch {
    return null;
  }
}

function buildStuckText(args: {
  lastTrippedCode: string | null;
  lastTrippedAt: Date | null;
  lastSuccessAt: Date | null;
  minutesSinceSuccess: number;
  config: SlackAuthBreakerStuckConfig;
  breakerOpen: boolean;
}): string {
  return [
    `:warning: *Slack auth breaker is persistently tripped*`,
    `• Last terminal code: \`${args.lastTrippedCode ?? "unknown"}\``,
    `• Last tripped at: ${args.lastTrippedAt ? args.lastTrippedAt.toISOString() : "n/a"}`,
    `• Last successful Slack call: ${args.lastSuccessAt ? args.lastSuccessAt.toISOString() : "never (or before boot)"}`,
    `• Minutes since last success: *${args.minutesSinceSuccess}m* (threshold ${args.config.thresholdMinutes}m)`,
    `• Breaker currently open: ${args.breakerOpen ? "yes" : "no (auto-closed; will reopen on next call)"}`,
    `• Recommended action: Open Settings → Integrations → Slack and reconnect the Slack integration. Then run/test Slack auth. A successful auth.test will clear the breaker.`,
  ].join("\n");
}

function buildDeliveryDeadText(args: {
  lastSuccessAt: Date | null;
  minutesSinceSuccess: number;
  deliveryDeadThresholdMinutes: number;
}): string {
  return [
    `:no_entry: *Slack delivery appears dead*`,
    `No successful Slack call has been recorded for *${args.minutesSinceSuccess}m* (threshold ${args.deliveryDeadThresholdMinutes}m).`,
    `The auth breaker has not tripped, so the token was never outright rejected — a likely cause is a transient credential-read miss (e.g. a Redis negative-cache sentinel) that dropped delivery silently.`,
    `• Last successful Slack call: ${args.lastSuccessAt ? args.lastSuccessAt.toISOString() : "never (or before boot)"}`,
    `• Recommended action: Check Settings → Integrations → Slack. If the badge shows connected, re-send any feedback rows left in "not_connected" or "failed" from the feedback admin page. If disconnected, reconnect Slack.`,
  ].join("\n");
}

function buildRecoveredText(args: {
  recoveredAt: Date;
  lastSuccessAt: Date | null;
  previousAlertedAt: Date;
  lastTrippedCode: string | null;
}): string {
  return [
    `:white_check_mark: *Slack auth recovered*`,
    `Slack authentication has recovered after a sustained breaker-open period.`,
    `• Recovered at: ${args.recoveredAt.toISOString()}`,
    `• Last successful Slack call: ${args.lastSuccessAt ? args.lastSuccessAt.toISOString() : "n/a"}`,
    `• Previous stuck alert at: ${args.previousAlertedAt.toISOString()}`,
    `• Prior terminal code: \`${args.lastTrippedCode ?? "unknown"}\``,
  ].join("\n");
}

export type SlackAuthBreakerCheckDecision =
  | "alerted"
  | "alerted_delivery_dead"
  | "recovered"
  | "skipped_below_threshold"
  | "skipped_not_possibly_stuck"
  | "skipped_cooldown"
  | "skipped_dispatcher_skipped"
  | "skipped_disabled";

export interface SlackAuthBreakerCheckResult {
  decision: SlackAuthBreakerCheckDecision;
  alertsSent: number;
  lastAlert: SlackAuthBreakerLastAlert | null;
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
    console.error(`[SlackAuthBreakerStuck] dispatch failed: ${msg}`);
    return { delivered: false, skipReason: `dispatch_error:${msg || "unknown"}` };
  }
}

export async function checkSlackAuthBreakerStuck(
  now: Date = new Date(),
): Promise<SlackAuthBreakerCheckResult> {
  const config = await getSlackAuthBreakerStuckConfig();
  if (!config.enabled) {
    return {
      decision: "skipped_disabled",
      alertsSent: 0,
      lastAlert,
      skipReason: "alert disabled in system_settings",
    };
  }

  const state = getSlackAuthState();
  const lastTrippedAt = parseIso(state.lastTrippedAt);
  const lastSuccessAt = parseIso(state.lastSuccessAt);
  const slackSetupAt = await getSlackIntegrationSetupAt();

  // Reference time used to compute "minutes since last success" when we
  // have never recorded a successful Slack call. Preference order is
  // designed to keep advancing monotonically even when the breaker
  // re-trips every cycle (so the watcher *does* cross the threshold
  // on a permanently-revoked token instead of resetting the clock on
  // every trip):
  //   1. lastSuccessAt — the obvious anchor when it exists.
  //   2. slackSetupAt — `system_settings.slack_bot_token.updatedAt`,
  //      i.e. when the Slack token was last (re-)installed. Stable
  //      across retrips; advances only on real operator action.
  //   3. boot time — terminal fallback. Always non-null; covers the
  //      case where the integration was set up before this process
  //      started but somehow has no updatedAt. Note that this means
  //      `lastTrippedAt` is *intentionally never* the anchor — using
  //      it would re-introduce the bug this ordering is designed to
  //      prevent (clock resetting on every retrip).
  const referenceSuccess =
    lastSuccessAt ?? slackSetupAt ?? new Date(BOOT_AT_MS);
  const hasAnyHistory = !!lastSuccessAt || !!lastTrippedAt || !!slackSetupAt;

  const minutesSinceSuccess = Math.max(
    0,
    Math.round((now.getTime() - referenceSuccess.getTime()) / 60_000),
  );

  const isPossiblyStuck =
    state.breakerOpen ||
    (!!lastTrippedAt &&
      (!lastSuccessAt || lastTrippedAt.getTime() > lastSuccessAt.getTime()));

  // ── Recovery branch (comes first) ─────────────────────────────────
  if (
    lastAlert &&
    !state.breakerOpen &&
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
        `[SlackAuthBreakerStuck] Slack auth recovered; sent recovery alert lastSuccessAt=${lastSuccessAt.toISOString()}`,
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
  if (!hasAnyHistory) {
    // Empty/uninitialized system — never alert.
    return {
      decision: "skipped_below_threshold",
      alertsSent: 0,
      lastAlert,
      skipReason: "no Slack auth history",
    };
  }

  if (!isPossiblyStuck) {
    // Auth breaker has not tripped — but Slack delivery may still be
    // functionally dead (e.g. token read returned empty from a poisoned
    // negative-cache sentinel without ever making an API call). Check the
    // delivery-dead branch before giving up entirely.
    if (minutesSinceSuccess >= config.deliveryDeadThresholdMinutes) {
      const elapsedMs = lastDeliveryDeadAlertAt
        ? now.getTime() - lastDeliveryDeadAlertAt.getTime()
        : Infinity;
      const inCooldown = elapsedMs < config.cooldownMinutes * 60_000;
      if (!inCooldown) {
        const text = buildDeliveryDeadText({
          lastSuccessAt,
          minutesSinceSuccess,
          deliveryDeadThresholdMinutes: config.deliveryDeadThresholdMinutes,
        });
        const metadata: Record<string, unknown> = {
          minutesSinceSuccess,
          deliveryDeadThresholdMinutes: config.deliveryDeadThresholdMinutes,
          lastSuccessAt: state.lastSuccessAt,
          breakerOpen: state.breakerOpen,
          lastTrippedAt: state.lastTrippedAt,
          lastTrippedCode: state.lastTrippedCode,
        };
        const r = await callDispatcher(DELIVERY_DEAD_NOTIFICATION_ID, text, metadata);
        if (r.delivered) {
          lastDeliveryDeadAlertAt = now;
          console.log(
            `[SlackAuthBreakerStuck] Delivery-dead alert sent minutesSinceSuccess=${minutesSinceSuccess} threshold=${config.deliveryDeadThresholdMinutes}`,
          );
          return { decision: "alerted_delivery_dead", alertsSent: 1, lastAlert };
        }
        return {
          decision: "skipped_dispatcher_skipped",
          alertsSent: 0,
          lastAlert,
          skipReason: r.skipReason,
        };
      }
      const elapsedMin = Math.round(elapsedMs / 60_000);
      console.log(
        `[SlackAuthBreakerStuck] Delivery-dead skipped cooldown elapsedMin=${elapsedMin} cooldownMinutes=${config.cooldownMinutes}`,
      );
    }
    console.log(
      `[SlackAuthBreakerStuck] Skipped not_possibly_stuck breakerOpen=${state.breakerOpen} minutesSinceSuccess=${minutesSinceSuccess} deliveryDeadThreshold=${config.deliveryDeadThresholdMinutes}`,
    );
    return {
      decision: "skipped_not_possibly_stuck",
      alertsSent: 0,
      lastAlert,
      skipReason: `not_possibly_stuck minutesSinceSuccess=${minutesSinceSuccess}`,
    };
  }

  if (minutesSinceSuccess < config.thresholdMinutes) {
    console.log(
      `[SlackAuthBreakerStuck] Skipped below threshold breakerOpen=${state.breakerOpen} minutesSinceSuccess=${minutesSinceSuccess} threshold=${config.thresholdMinutes}`,
    );
    return {
      decision: "skipped_below_threshold",
      alertsSent: 0,
      lastAlert,
      skipReason: `below_threshold minutesSinceSuccess=${minutesSinceSuccess} < threshold=${config.thresholdMinutes}`,
    };
  }

  if (lastAlert) {
    const elapsedMs = now.getTime() - lastAlert.alertedAt.getTime();
    if (elapsedMs < config.cooldownMinutes * 60_000) {
      const elapsedMin = Math.round(elapsedMs / 60_000);
      console.log(
        `[SlackAuthBreakerStuck] Skipped cooldown lastAlert=${lastAlert.alertedAt.toISOString()} cooldownMinutes=${config.cooldownMinutes}`,
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
    lastTrippedAt,
    lastSuccessAt,
    minutesSinceSuccess,
    config,
    breakerOpen: state.breakerOpen,
  });
  const metadata: Record<string, unknown> = {
    lastTrippedAt: state.lastTrippedAt,
    lastTrippedCode: state.lastTrippedCode,
    lastSuccessAt: state.lastSuccessAt,
    tripCount: state.tripCount,
    thresholdMinutes: config.thresholdMinutes,
    cooldownMinutes: config.cooldownMinutes,
    breakerOpen: state.breakerOpen,
    openedUntil: state.openedUntil,
    recommendedAction:
      "Open Settings → Integrations → Slack and reconnect the Slack integration. Then run/test Slack auth. A successful auth.test will clear the breaker.",
  };
  const r = await callDispatcher(STUCK_NOTIFICATION_ID, text, metadata);
  if (r.delivered) {
    lastAlert = {
      alertType: "stuck",
      alertedAt: now,
      lastTrippedAt,
      lastTrippedCode: state.lastTrippedCode,
      lastSuccessAtAtAlert: lastSuccessAt,
    };
    console.log(
      `[SlackAuthBreakerStuck] Alerting sustained Slack auth breaker state lastCode=${state.lastTrippedCode} lastTrippedAt=${state.lastTrippedAt} lastSuccessAt=${state.lastSuccessAt}`,
    );
    return { decision: "alerted", alertsSent: 1, lastAlert };
  }
  // Dispatcher skipped — do NOT arm cooldown so a future tick (after
  // the notification subsystem recovers) can deliver.
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
      const r = await checkSlackAuthBreakerStuck();
      // Standardized per-tick decision log (every outcome, not just
      // alerted) so operators have a uniform line to grep on when
      // diagnosing why a stuck breaker did/didn't produce an alert.
      console.log(
        `[SlackAuthBreakerStuck] tick decision=${r.decision} alertsSent=${r.alertsSent}${
          r.skipReason ? ` skipReason="${r.skipReason}"` : ""
        }`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[SlackAuthBreakerStuck] tick failed: ${msg}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startSlackAuthBreakerStuckAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution(
      "scheduler:slack-auth-breaker-stuck-alerts",
      () => tick(),
    );
  }, CHECK_INTERVAL_MS);
  interval.unref?.();
  console.log(
    `[SlackAuthBreakerStuck] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopSlackAuthBreakerStuckAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  STUCK_NOTIFICATION_ID,
  RECOVERED_NOTIFICATION_ID,
  DELIVERY_DEAD_NOTIFICATION_ID,
  DEFAULTS,
  resetLastAlertCache(): void {
    lastAlert = null;
    lastDeliveryDeadAlertAt = null;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  getLastAlertForTests(): SlackAuthBreakerLastAlert | null {
    return lastAlert;
  },
  getLastDeliveryDeadAlertAtForTests(): Date | null {
    return lastDeliveryDeadAlertAt;
  },
};
