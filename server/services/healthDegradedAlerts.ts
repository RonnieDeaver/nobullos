/**
 * Task #1073 — Alert when a `/api/health` sub-check has been
 * persistently degraded.
 *
 * Task #1070 added per-entry "degraded for Xm" durations and pulses
 * critical entries past 10 minutes in the UI, but only operators
 * actively looking at `/admin/health` would notice. This watcher fires
 * a Slack alert (via the unified `notifyByType` dispatcher) when a
 * sub-check has been in the `degraded` set longer than the configured
 * per-key threshold.
 *
 *   - Critical keys (`db`, `tables`) — default 10 min
 *   - All other (soft) keys          — default 30 min
 *
 * Defaults can be overridden via `system_settings`:
 *   - `health_degraded_alert_enabled` — kill switch (default true)
 *   - `health_degraded_alert_threshold_critical_minutes` (default 10)
 *   - `health_degraded_alert_threshold_default_minutes`  (default 30)
 *   - `health_degraded_alert_threshold_<key>_minutes`    — per-key
 *     override (e.g. `health_degraded_alert_threshold_scheduler_stale_minutes`)
 *   - `health_degraded_alert_cooldown_minutes` — per-key re-alert
 *     cooldown (default 60). Same key won't re-page within this window
 *     while still degraded.
 *
 * Auto-resolve: when a key drops out of the degraded set after this
 * watcher has alerted on it, a single "cleared" Slack message goes out
 * to the same channel and the per-key state is cleared. Re-degrading
 * later starts a fresh duration/cooldown cycle.
 *
 * Channel resolution is owned by the dispatcher (notification id
 * `infra.health.subcheck_degraded_persistent` → `notification_settings`
 * → `rate_limit_alert_slack_channel_id` legacy fallback).
 */
import { runWithWorkerDb, withDbAttribution } from "../db";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";
import { getSystemSetting } from "../storage/settingsStorage";
import {
  evaluateHealthChecks as realEvaluateHealthChecks,
  recordDegradedSnapshot,
  getDegradedFirstSeenSnapshot,
} from "./healthDegradedTracker";

let evaluatorOverride: (() => Promise<{ degraded: string[] }>) | null = null;
async function evaluateHealthChecks(): Promise<{ degraded: string[] }> {
  if (evaluatorOverride) return evaluatorOverride();
  const r = await realEvaluateHealthChecks();
  return { degraded: r.degraded };
}

const NOTIFICATION_ID = "infra.health.subcheck_degraded_persistent";

export const SETTING_ENABLED = "health_degraded_alert_enabled";
export const SETTING_CRITICAL_MINUTES = "health_degraded_alert_threshold_critical_minutes";
export const SETTING_DEFAULT_MINUTES = "health_degraded_alert_threshold_default_minutes";
export const SETTING_COOLDOWN_MINUTES = "health_degraded_alert_cooldown_minutes";
export const SETTING_PER_KEY_PREFIX = "health_degraded_alert_threshold_";
export const SETTING_PER_KEY_SUFFIX = "_minutes";

export const CRITICAL_KEYS = new Set(["db", "tables"]);

const DEFAULTS = {
  enabled: true,
  criticalMinutes: 10,
  defaultMinutes: 30,
  cooldownMinutes: 60,
};

const CHECK_INTERVAL_MS = 60_000;

interface KeyAlertRecord {
  /** Epoch ms of the most recent fired alert for this key. */
  lastAlertedAt: number;
  /** First-seen timestamp of the degradation episode this record belongs to. */
  episodeStartedAt: number;
}
const lastAlertByKey = new Map<string, KeyAlertRecord>();

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

export interface DegradedAlertConfig {
  enabled: boolean;
  criticalMinutes: number;
  defaultMinutes: number;
  cooldownMinutes: number;
}

export async function getDegradedAlertConfig(): Promise<DegradedAlertConfig> {
  const [enabledRow, critRow, defRow, cdRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_CRITICAL_MINUTES).catch(() => null),
    getSystemSetting(SETTING_DEFAULT_MINUTES).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN_MINUTES).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    criticalMinutes: parsePositiveInt(critRow?.value, DEFAULTS.criticalMinutes),
    defaultMinutes: parsePositiveInt(defRow?.value, DEFAULTS.defaultMinutes),
    cooldownMinutes: parsePositiveInt(cdRow?.value, DEFAULTS.cooldownMinutes),
  };
}

/**
 * Resolve the per-key alert threshold (in minutes). Honours an optional
 * per-key override row and falls back to the critical/default tier
 * based on whether the key is in `CRITICAL_KEYS`.
 */
export async function getThresholdMinutesForKey(
  key: string,
  config: DegradedAlertConfig,
): Promise<number> {
  const overrideRow = await getSystemSetting(
    `${SETTING_PER_KEY_PREFIX}${key}${SETTING_PER_KEY_SUFFIX}`,
  ).catch(() => null);
  if (overrideRow?.value) {
    const n = Number.parseInt(String(overrideRow.value).trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return CRITICAL_KEYS.has(key) ? config.criticalMinutes : config.defaultMinutes;
}

function buildHealthLink(): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  const path = "/admin/health";
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

function formatMinutes(min: number): string {
  if (min >= 60) {
    const h = min / 60;
    return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  }
  return `${Math.round(min)}m`;
}

function buildFiringText(args: {
  key: string;
  isCritical: boolean;
  durationMin: number;
  thresholdMin: number;
}): string {
  const tag = args.isCritical ? ":rotating_light:" : ":warning:";
  const link = buildHealthLink();
  return [
    `${tag} *Health sub-check has been degraded for ${formatMinutes(args.durationMin)}* — \`${args.key}\``,
    `• Threshold: ${formatMinutes(args.thresholdMin)} (${args.isCritical ? "critical" : "soft"})`,
    `• Investigate on the Health Dashboard: ${link}`,
  ].join("\n");
}

function buildClearedText(args: { key: string; durationMin: number }): string {
  const link = buildHealthLink();
  return [
    `:white_check_mark: *Health sub-check recovered* — \`${args.key}\``,
    `• Was degraded for *${formatMinutes(args.durationMin)}*`,
    `• Health Dashboard: ${link}`,
  ].join("\n");
}

export type DegradedAlertDecision =
  | "alerted"
  | "cleared"
  | "skipped_disabled"
  | "skipped_below_threshold"
  | "skipped_cooldown"
  | "skipped_send_failed"
  | "skipped_dispatcher_skipped";

export interface DegradedAlertCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  degradedKeys: string[];
  alertsSent: number;
  cleared: number;
  perKey: Array<{
    key: string;
    durationMin: number | null;
    thresholdMin: number;
    isCritical: boolean;
    decision: DegradedAlertDecision;
    skipReason?: string;
  }>;
}

async function dispatch(
  text: string,
  metadata: Record<string, unknown>,
): Promise<{ delivered: boolean; skipReason?: string }> {
  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      { triggerSource: "alert_service", bypassDedupe: true, metadata },
    );
    return {
      delivered: r.delivered,
      skipReason: r.delivered ? undefined : (r.skipReason ?? r.status),
    };
  } catch (err: any) {
    return {
      delivered: false,
      skipReason: `dispatch_error:${err?.message ?? "unknown"}`,
    };
  }
}

/**
 * One pass of the watcher: evaluate the health sub-checks, refresh the
 * shared first-seen tracker, then fire / clear alerts based on per-key
 * durations.
 */
export async function checkDegradedSubChecks(
  now: number = Date.now(),
): Promise<DegradedAlertCheckResult> {
  const config = await getDegradedAlertConfig();

  const { degraded } = await evaluateHealthChecks();
  await recordDegradedSnapshot(degraded, now);
  const firstSeen = await getDegradedFirstSeenSnapshot();
  const degradedSet = new Set(degraded);

  const result: DegradedAlertCheckResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    degradedKeys: degraded,
    alertsSent: 0,
    cleared: 0,
    perKey: [],
  };

  // Auto-resolve: any key we've previously alerted on that is no longer
  // degraded gets a single "cleared" message, then drops out of state.
  for (const key of Array.from(lastAlertByKey.keys())) {
    if (degradedSet.has(key)) continue;
    const rec = lastAlertByKey.get(key)!;
    const durationMin = Math.max(
      0,
      Math.round((now - rec.episodeStartedAt) / 60_000),
    );
    if (config.enabled) {
      const r = await dispatch(buildClearedText({ key, durationMin }), {
        key,
        event: "cleared",
        episodeStartedAt: rec.episodeStartedAt,
        clearedAt: now,
        durationMin,
      });
      if (r.delivered) {
        result.cleared += 1;
        result.perKey.push({
          key,
          durationMin,
          thresholdMin: 0,
          isCritical: CRITICAL_KEYS.has(key),
          decision: "cleared",
        });
      } else {
        // Even if the cleared message fails to send, drop the state —
        // the key has recovered and we don't want to keep retrying a
        // recovery message forever. The next degradation will start
        // fresh.
        result.perKey.push({
          key,
          durationMin,
          thresholdMin: 0,
          isCritical: CRITICAL_KEYS.has(key),
          decision: r.skipReason?.startsWith("dispatch_error")
            ? "skipped_send_failed"
            : "skipped_dispatcher_skipped",
          skipReason: r.skipReason,
        });
      }
    }
    lastAlertByKey.delete(key);
  }

  if (!config.enabled) {
    for (const key of degraded) {
      const since = firstSeen[key] ?? now;
      const durationMin = (now - since) / 60_000;
      const thresholdMin = await getThresholdMinutesForKey(key, config);
      result.perKey.push({
        key,
        durationMin,
        thresholdMin,
        isCritical: CRITICAL_KEYS.has(key),
        decision: "skipped_disabled",
        skipReason: "alert disabled in system_settings",
      });
    }
    return result;
  }

  const cooldownMs = config.cooldownMinutes * 60_000;

  for (const key of degraded) {
    const since = firstSeen[key] ?? now;
    const durationMin = (now - since) / 60_000;
    const thresholdMin = await getThresholdMinutesForKey(key, config);
    const isCritical = CRITICAL_KEYS.has(key);

    if (durationMin < thresholdMin) {
      result.perKey.push({
        key,
        durationMin,
        thresholdMin,
        isCritical,
        decision: "skipped_below_threshold",
        skipReason: `degraded ${durationMin.toFixed(1)}m < ${thresholdMin}m`,
      });
      continue;
    }

    const cached = lastAlertByKey.get(key);
    // Honour the cached cooldown only if it belongs to the CURRENT
    // episode (same `since`). If the key recovered between ticks and
    // re-degraded, the old record will have been cleared by the
    // auto-resolve sweep above — but be defensive.
    const last =
      cached && cached.episodeStartedAt === since ? cached : null;
    if (cached && !last) lastAlertByKey.delete(key);
    if (last && now - last.lastAlertedAt < cooldownMs) {
      const elapsedMin = Math.round((now - last.lastAlertedAt) / 60_000);
      result.perKey.push({
        key,
        durationMin,
        thresholdMin,
        isCritical,
        decision: "skipped_cooldown",
        skipReason: `last alerted ${elapsedMin}m ago < ${config.cooldownMinutes}m`,
      });
      continue;
    }

    const text = buildFiringText({ key, isCritical, durationMin, thresholdMin });
    const r = await dispatch(text, {
      key,
      event: "firing",
      episodeStartedAt: since,
      durationMin: Number(durationMin.toFixed(2)),
      thresholdMin,
      isCritical,
    });
    if (r.delivered) {
      lastAlertByKey.set(key, { lastAlertedAt: now, episodeStartedAt: since });
      result.alertsSent += 1;
      result.perKey.push({
        key,
        durationMin,
        thresholdMin,
        isCritical,
        decision: "alerted",
      });
    } else {
      result.perKey.push({
        key,
        durationMin,
        thresholdMin,
        isCritical,
        decision: r.skipReason?.startsWith("dispatch_error")
          ? "skipped_send_failed"
          : "skipped_dispatcher_skipped",
        skipReason: r.skipReason,
      });
    }
  }

  return result;
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await checkDegradedSubChecks();
      if (r.alertsSent > 0 || r.cleared > 0) {
        console.log(
          `[HealthDegradedAlerts] sent=${r.alertsSent} cleared=${r.cleared} degradedKeys=${r.degradedKeys.length}`,
        );
      }
    } catch (err: any) {
      console.warn(`[HealthDegradedAlerts] tick failed: ${err?.message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startHealthDegradedAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    // Task #1729 Phase 2.1 — when tenancy enforcement is on, route this
    // scheduler tick onto the worker pool so the periodic settings reads
    // (`getSystemSetting`) inside `tick()` stop consuming API-pool slots.
    // Default OFF preserves current behavior.
    const run = () =>
      withDbAttribution("scheduler:health-degraded-alerts", () => tick());
    if (isPoolEpicSwitchEnabled("db_pool_tenancy_enforcement_enabled")) {
      void runWithWorkerDb(run);
    } else {
      void run();
    }
  }, CHECK_INTERVAL_MS);
  console.log(
    `[HealthDegradedAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopHealthDegradedAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_ID,
  DEFAULTS,
  resetLastAlertCache(): void {
    lastAlertByKey.clear();
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  /**
   * Override the in-process degraded-set evaluation for tests so we
   * don't have to actually break a real sub-check.
   */
  setEvaluatorForTests(
    fn: (() => Promise<{ degraded: string[] }>) | null,
  ): void {
    evaluatorOverride = fn;
  },
};
