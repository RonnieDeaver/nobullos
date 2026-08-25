/**
 * Task #1282 — proactive alert when Front Historical Recovery jobs end
 * with a fatal error.
 *
 * Task #843 made fatal errors persist on `RecoveryJobState` (status =
 * `"failed"`, `statusReason` starts with `fatal_error:`) instead of
 * silently disappearing, but the only place an operator sees them is
 * the Front Historical Recovery admin panel. This watcher periodically
 * inspects recently-failed recovery jobs and fires a Slack alert (via
 * the unified `notifyByType` dispatcher) when the count of NEW fatal
 * jobs in a rolling window crosses the configured threshold.
 *
 * Exclusion: `db_pool_saturated:` statusReasons are NOT fatal errors —
 * they're recoverable pool stalls owned by the pool stabilization
 * subsystem, with their own alerting. Per the task brief we only fire
 * on `fatal_error:` reasons. (A `db_pool_contended:* | fatal_error:`
 * combined reason DOES qualify — the job still hit a fatal error.)
 *
 * Dedupe: in-memory `(jobId)` set so the same job never re-alerts on a
 * subsequent sweep. Jobs are keyed by their lineage root when known
 * (`autoContinueLineageRootJobId`) so auto-continue retries that all
 * fail fatally in the same lineage collapse into a single alert per
 * sweep instead of one per retry.
 *
 * Channel/enabled state lives in `notification_settings` for
 * `integration.front.historical_recovery_fatal_errors`; threshold and
 * window knobs live in `system_settings` so an admin can tune them
 * without a deploy.
 */
import { withDbAttribution } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";
import {
  listRecoveryJobs,
  type RecoveryJobState,
} from "./frontHistoricalRecovery";

export const NOTIFICATION_ID =
  "integration.front.historical_recovery_fatal_errors";

export const SETTING_ENABLED =
  "front_historical_recovery_fatal_alert_enabled";
export const SETTING_WINDOW_MINUTES =
  "front_historical_recovery_fatal_alert_window_minutes";
export const SETTING_THRESHOLD =
  "front_historical_recovery_fatal_alert_threshold";
export const SETTING_COOLDOWN_MINUTES =
  "front_historical_recovery_fatal_alert_cooldown_minutes";

export const DEFAULTS = {
  enabled: true,
  // Look back 60 minutes; with the default scheduler tick of ~10 min
  // this catches a fatal-error burst within minutes.
  windowMinutes: 60,
  // 2 fatal jobs inside the rolling window is enough to fire — a
  // single fatal is suspicious, two in an hour is almost certainly a
  // real bug/outage rather than a one-off Front blip.
  threshold: 2,
  // Don't re-alert the same `(lineageRoot)` set more than once per hour
  // even if new fatal jobs keep landing for the same lineage. New jobs
  // in NEW lineages bypass the cooldown.
  cooldownMinutes: 60,
} as const;

export const MIN_WINDOW_MINUTES = 1;
export const MAX_WINDOW_MINUTES = 7 * 24 * 60;
export const MIN_THRESHOLD = 1;
export const MAX_THRESHOLD = 1_000;
export const MIN_COOLDOWN_MINUTES = 0;
export const MAX_COOLDOWN_MINUTES = 7 * 24 * 60;

const CHECK_INTERVAL_MS = 10 * 60_000;

export interface FrontRecoveryFatalAlertConfig {
  enabled: boolean;
  windowMinutes: number;
  threshold: number;
  cooldownMinutes: number;
}

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: {
    triggerSource: string;
    bypassDedupe?: boolean;
    dedupeKey?: string;
    metadata?: Record<string, unknown>;
  },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

/** Per-jobId dedupe — once a fatal job has been included in an alert,
 *  it never appears in another alert from this process. */
const alertedJobs = new Set<string>();

/** Last alert per lineage root → suppresses re-alerts for the same
 *  lineage within `cooldownMinutes` even if a brand-new fatal job in
 *  that lineage shows up. New lineages bypass the cooldown. */
const lastAlertByLineage = new Map<string, number>();

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

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
  if (raw == null) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export async function getFrontRecoveryFatalAlertConfig(): Promise<FrontRecoveryFatalAlertConfig> {
  const [enabledRow, windowRow, thresholdRow, cooldownRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_WINDOW_MINUTES).catch(() => null),
    getSystemSetting(SETTING_THRESHOLD).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN_MINUTES).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    windowMinutes: parsePositiveInt(windowRow?.value, DEFAULTS.windowMinutes),
    threshold: parsePositiveInt(thresholdRow?.value, DEFAULTS.threshold),
    cooldownMinutes: parseNonNegativeInt(
      cooldownRow?.value,
      DEFAULTS.cooldownMinutes,
    ),
  };
}

export async function setFrontRecoveryFatalAlertEnabled(
  enabled: boolean,
  updatedBy: string,
): Promise<boolean> {
  const { storage } = await import("../storage");
  await storage.setSystemSetting(
    SETTING_ENABLED,
    enabled ? "true" : "false",
    updatedBy,
  );
  return enabled;
}

export async function setFrontRecoveryFatalAlertWindowMinutes(
  value: number,
  updatedBy: string,
): Promise<number> {
  if (
    !Number.isInteger(value) ||
    value < MIN_WINDOW_MINUTES ||
    value > MAX_WINDOW_MINUTES
  ) {
    throw new Error(
      `window must be an integer between ${MIN_WINDOW_MINUTES} and ${MAX_WINDOW_MINUTES} minutes`,
    );
  }
  const { storage } = await import("../storage");
  await storage.setSystemSetting(
    SETTING_WINDOW_MINUTES,
    String(value),
    updatedBy,
  );
  return value;
}

export async function setFrontRecoveryFatalAlertThreshold(
  value: number,
  updatedBy: string,
): Promise<number> {
  if (
    !Number.isInteger(value) ||
    value < MIN_THRESHOLD ||
    value > MAX_THRESHOLD
  ) {
    throw new Error(
      `threshold must be an integer between ${MIN_THRESHOLD} and ${MAX_THRESHOLD}`,
    );
  }
  const { storage } = await import("../storage");
  await storage.setSystemSetting(SETTING_THRESHOLD, String(value), updatedBy);
  return value;
}

export async function setFrontRecoveryFatalAlertCooldownMinutes(
  value: number,
  updatedBy: string,
): Promise<number> {
  if (
    !Number.isInteger(value) ||
    value < MIN_COOLDOWN_MINUTES ||
    value > MAX_COOLDOWN_MINUTES
  ) {
    throw new Error(
      `cooldown must be an integer between ${MIN_COOLDOWN_MINUTES} and ${MAX_COOLDOWN_MINUTES} minutes`,
    );
  }
  const { storage } = await import("../storage");
  await storage.setSystemSetting(
    SETTING_COOLDOWN_MINUTES,
    String(value),
    updatedBy,
  );
  return value;
}

/**
 * A job is "fatal" iff `status === "failed"` AND its `statusReason`
 * contains `fatal_error:` (the canonical prefix written by
 * `frontHistoricalRecovery.ts` when the recovery IIFE hits an
 * unexpected throw). `db_pool_saturated:` is intentionally NOT fatal
 * — it's a recoverable pool stall handled separately.
 *
 * Exported for the unit test.
 */
export function isFatalRecoveryJob(job: RecoveryJobState): boolean {
  if (job.status !== "failed") return false;
  const reason = (job.statusReason ?? "").trim();
  if (!reason) return false;
  if (reason.includes("fatal_error:")) return true;
  return false;
}

function lineageRootFor(job: RecoveryJobState): string {
  return job.autoContinueLineageRootJobId || job.jobId;
}

function jobEndTime(job: RecoveryJobState): number {
  const completed = job.completedAt ? Date.parse(job.completedAt) : NaN;
  if (Number.isFinite(completed)) return completed;
  const started = Date.parse(job.startedAt);
  return Number.isFinite(started) ? started : 0;
}

function buildRecoveryPanelLink(): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  const path = "/admin/integrations#front-historical-recovery";
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

interface FatalJobSummary {
  jobId: string;
  lineageRoot: string;
  statusReason: string;
  completedAt: string | null;
}

function summarizeJob(job: RecoveryJobState): FatalJobSummary {
  return {
    jobId: job.jobId,
    lineageRoot: lineageRootFor(job),
    statusReason: (job.statusReason ?? "").trim(),
    completedAt: job.completedAt,
  };
}

function buildAlertText(args: {
  fatal: FatalJobSummary[];
  config: FrontRecoveryFatalAlertConfig;
}): string {
  const { fatal, config } = args;
  const link = buildRecoveryPanelLink();
  const lines = [
    `:warning: *Front Historical Recovery fatal-error rate exceeded* — ${fatal.length} fatal job(s) in the last ${config.windowMinutes}m (threshold ≥ ${config.threshold})`,
    ...fatal.slice(0, 10).map((j) => {
      // Trim very long reasons so the Slack message stays readable.
      const reason =
        j.statusReason.length > 200
          ? `${j.statusReason.slice(0, 200)}…`
          : j.statusReason;
      const at = j.completedAt ? ` at ${j.completedAt}` : "";
      const lineage =
        j.lineageRoot !== j.jobId ? ` (lineage \`${j.lineageRoot}\`)` : "";
      return `• \`${j.jobId}\`${lineage}${at} — ${reason}`;
    }),
    fatal.length > 10
      ? `• …and ${fatal.length - 10} more`
      : null,
    `Open the Front Historical Recovery panel: ${link}`,
  ].filter((x): x is string => typeof x === "string");
  return lines.join("\n");
}

export interface FatalAlertCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  recentFatalCount: number;
  newFatalCount: number;
  alertsSent: number;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_below_threshold"
    | "skipped_no_new_jobs"
    | "skipped_cooldown"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  skipReason?: string;
  newFatalJobIds?: string[];
}

/**
 * One-shot evaluation. Safe to call from the scheduler tick OR a
 * manual "test alert" admin endpoint.
 *
 * Tests can inject `jobsOverride` to avoid touching the real
 * `listRecoveryJobs()` (which would otherwise hydrate persisted state
 * from `system_settings`).
 */
export async function checkRecentFatalRecoveries(
  options: {
    now?: number;
    jobsOverride?: RecoveryJobState[];
  } = {},
): Promise<FatalAlertCheckResult> {
  const now = options.now ?? Date.now();
  let config: FrontRecoveryFatalAlertConfig;
  try {
    config = await getFrontRecoveryFatalAlertConfig();
  } catch (err: any) {
    console.warn(
      `[FrontHistoricalRecoveryFatalAlerts] config load failed (${err?.message ?? err}); skipping`,
    );
    return {
      evaluatedAt: new Date(now).toISOString(),
      enabled: false,
      recentFatalCount: 0,
      newFatalCount: 0,
      alertsSent: 0,
      decision: "skipped_send_failed",
      skipReason: `config_load_failed:${err?.message ?? "unknown"}`,
    };
  }

  if (!config.enabled) {
    return {
      evaluatedAt: new Date(now).toISOString(),
      enabled: false,
      recentFatalCount: 0,
      newFatalCount: 0,
      alertsSent: 0,
      decision: "skipped_disabled",
      skipReason: "alert disabled in system_settings",
    };
  }

  const windowMs = config.windowMinutes * 60_000;
  const cutoff = now - windowMs;

  let jobs: RecoveryJobState[];
  if (options.jobsOverride) {
    jobs = options.jobsOverride;
  } else {
    try {
      jobs = await listRecoveryJobs();
    } catch (err: any) {
      console.warn(
        `[FrontHistoricalRecoveryFatalAlerts] listRecoveryJobs failed (${err?.message ?? err}); skipping`,
      );
      return {
        evaluatedAt: new Date(now).toISOString(),
        enabled: true,
        recentFatalCount: 0,
        newFatalCount: 0,
        alertsSent: 0,
        decision: "skipped_send_failed",
        skipReason: `list_jobs_failed:${err?.message ?? "unknown"}`,
      };
    }
  }

  const fatalInWindow = jobs.filter(
    (j) => isFatalRecoveryJob(j) && jobEndTime(j) >= cutoff,
  );

  const newFatal = fatalInWindow.filter((j) => !alertedJobs.has(j.jobId));

  if (newFatal.length === 0) {
    return {
      evaluatedAt: new Date(now).toISOString(),
      enabled: true,
      recentFatalCount: fatalInWindow.length,
      newFatalCount: 0,
      alertsSent: 0,
      decision: "skipped_no_new_jobs",
      skipReason: `all ${fatalInWindow.length} fatal job(s) already alerted`,
    };
  }

  if (newFatal.length < config.threshold) {
    return {
      evaluatedAt: new Date(now).toISOString(),
      enabled: true,
      recentFatalCount: fatalInWindow.length,
      newFatalCount: newFatal.length,
      alertsSent: 0,
      decision: "skipped_below_threshold",
      skipReason: `new fatal jobs ${newFatal.length} < ${config.threshold}`,
      newFatalJobIds: newFatal.map((j) => j.jobId),
    };
  }

  // Cooldown only applies when EVERY new fatal job belongs to a
  // lineage we've already alerted on recently. As soon as a brand-new
  // lineage shows up the cooldown is bypassed — a fatal error in a
  // different lineage is a different signal.
  const cooldownMs = config.cooldownMinutes * 60_000;
  if (cooldownMs > 0) {
    const allLineagesCoolingDown = newFatal.every((j) => {
      const lineage = lineageRootFor(j);
      const lastAt = lastAlertByLineage.get(lineage);
      return lastAt != null && now - lastAt < cooldownMs;
    });
    if (allLineagesCoolingDown) {
      // Suppress for now — but DON'T mark the jobs as alerted; if the
      // cooldown lapses (or a new lineage joins them) on a later sweep
      // they should still be considered.
      return {
        evaluatedAt: new Date(now).toISOString(),
        enabled: true,
        recentFatalCount: fatalInWindow.length,
        newFatalCount: newFatal.length,
        alertsSent: 0,
        decision: "skipped_cooldown",
        skipReason: `all ${newFatal.length} new fatal job(s) belong to lineages still in cooldown (${config.cooldownMinutes}m)`,
        newFatalJobIds: newFatal.map((j) => j.jobId),
      };
    }
  }

  const summaries = newFatal.map(summarizeJob);
  const text = buildAlertText({ fatal: summaries, config });
  const lineageRoots = Array.from(new Set(summaries.map((s) => s.lineageRoot)));
  const dedupeKey = `front_recovery_fatal|${lineageRoots.sort().join(",")}|${Math.floor(now / cooldownMs || now)}`;

  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        dedupeKey,
        metadata: {
          windowMinutes: config.windowMinutes,
          threshold: config.threshold,
          cooldownMinutes: config.cooldownMinutes,
          recentFatalCount: fatalInWindow.length,
          newFatalCount: newFatal.length,
          newFatalJobIds: summaries.map((s) => s.jobId),
          lineageRoots,
          jobs: summaries,
        },
      },
    );

    if (r.delivered) {
      for (const j of newFatal) alertedJobs.add(j.jobId);
      for (const lineage of lineageRoots) {
        lastAlertByLineage.set(lineage, now);
      }
      return {
        evaluatedAt: new Date(now).toISOString(),
        enabled: true,
        recentFatalCount: fatalInWindow.length,
        newFatalCount: newFatal.length,
        alertsSent: 1,
        decision: "alerted",
        newFatalJobIds: summaries.map((s) => s.jobId),
      };
    }

    // Dispatcher-side dedupe: treat as "already alerted" so a restart
    // of the watcher doesn't keep retrying a delivery the dispatcher
    // is intentionally suppressing.
    if (r.status === "skipped_deduped") {
      for (const j of newFatal) alertedJobs.add(j.jobId);
      for (const lineage of lineageRoots) {
        lastAlertByLineage.set(lineage, now);
      }
    }
    return {
      evaluatedAt: new Date(now).toISOString(),
      enabled: true,
      recentFatalCount: fatalInWindow.length,
      newFatalCount: newFatal.length,
      alertsSent: 0,
      decision: "skipped_dispatcher_skipped",
      skipReason: r.skipReason ?? r.status,
      newFatalJobIds: summaries.map((s) => s.jobId),
    };
  } catch (err: any) {
    console.error(
      `[FrontHistoricalRecoveryFatalAlerts] dispatch failed: ${err?.message ?? err}`,
    );
    return {
      evaluatedAt: new Date(now).toISOString(),
      enabled: true,
      recentFatalCount: fatalInWindow.length,
      newFatalCount: newFatal.length,
      alertsSent: 0,
      decision: "skipped_send_failed",
      skipReason: `dispatch_error:${err?.message ?? "unknown"}`,
      newFatalJobIds: summaries.map((s) => s.jobId),
    };
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await checkRecentFatalRecoveries();
      if (r.alertsSent > 0) {
        console.log(
          `[FrontHistoricalRecoveryFatalAlerts] sent=${r.alertsSent} newFatal=${r.newFatalCount} totalFatalInWindow=${r.recentFatalCount}`,
        );
      }
    } catch (err: any) {
      console.warn(
        `[FrontHistoricalRecoveryFatalAlerts] tick failed: ${err?.message ?? err}`,
      );
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startFrontHistoricalRecoveryFatalAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution(
      "scheduler:front-historical-recovery-fatal-alerts",
      () => tick(),
    );
  }, CHECK_INTERVAL_MS);
  console.log(
    `[FrontHistoricalRecoveryFatalAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopFrontHistoricalRecoveryFatalAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_ID,
  DEFAULTS,
  resetAlertedCache(): void {
    alertedJobs.clear();
    lastAlertByLineage.clear();
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  isFatalRecoveryJob,
  buildAlertText,
};
