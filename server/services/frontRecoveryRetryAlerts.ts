/**
 * Task #1023 — warn admins when a Front Historical Recovery window has
 * to retry against Front excessively (a strong signal that Front is
 * either flaky for us or rate-limiting us hard).
 *
 * Task #1016 already persists per-window retry counters
 * (`retriesByReason`, `totalRetries`, `tokenRefreshes`) on every
 * `WindowCheckpoint`, but the admin only sees them passively in the
 * recovery panel. This watcher fires a single Slack admin notification
 * via the unified `notifyByType` dispatcher when a completed window's
 * `totalRetries` crosses the configured threshold.
 *
 * Dedupe: in-memory `(jobId, windowLabel)` set, plus the dispatcher's
 * own `dedupeKey` → at most one alert per window per process lifetime
 * AND at most one per window across the dispatcher's transition
 * window.
 *
 * Channel/enabled state lives in `notification_settings` for
 * `integration.front.recovery_retry_pressure`; threshold knobs live in
 * `system_settings` so an admin can tune them without a deploy.
 */
import { getSystemSetting } from "../storage/settingsStorage";
import type { WindowCheckpoint } from "./frontHistoricalRecovery";

export const NOTIFICATION_ID = "integration.front.recovery_retry_pressure";

export const SETTING_ENABLED = "front_recovery_retry_alert_enabled";
// Task #1903 — same-response suppression dominance alert. Fires when
// `same_response_suppressed` skips dominate a recovery window's pages
// (default ≥ 25% of pages over a minimum sample). Tied to the same
// owner notification but a separate registry id so admins can mute it
// independently of the per-window retry pressure alert.
export const SETTING_SUPPRESSION_DOMINANCE_ENABLED =
  "front_recovery_suppression_dominance_alert_enabled";
export const SETTING_SUPPRESSION_DOMINANCE_RATIO =
  "front_recovery_suppression_dominance_alert_ratio";
export const SETTING_SUPPRESSION_DOMINANCE_MIN_PAGES =
  "front_recovery_suppression_dominance_alert_min_pages";
// Task #1903 — sibling check: count `source_event_log` rows whose
// dedupe key ends with an empty version slot (`front:recovery:<id>:`).
// The Task #1887 helper means this should stay flat; any non-zero
// count means a writer regressed back to the trailing-empty-colon
// shape.
export const SETTING_EMPTY_SUFFIX_ENABLED =
  "front_recovery_empty_suffix_dedupe_alert_enabled";
export const SETTING_TOTAL_RETRIES_THRESHOLD =
  "front_recovery_retry_alert_window_threshold";
// Task #1083 — slow-burn pattern: N consecutive completed windows in
// the same job each bleeding ≥ floor front_5xx retries.
export const SETTING_CONSECUTIVE_WINDOW_COUNT =
  "front_recovery_retry_alert_consecutive_window_count";
export const SETTING_CONSECUTIVE_5XX_FLOOR =
  "front_recovery_retry_alert_consecutive_5xx_floor";

export const DEFAULTS = {
  enabled: true,
  // 10 retries on a single window is the threshold called out in the
  // task brief — a healthy window typically retries 0-2 times.
  totalRetriesThreshold: 10,
  // Slow-burn defaults: 3 consecutive completed windows each bleeding
  // ≥ 5 front_5xx-class retries. Both knobs are tunable via
  // system_settings without a deploy.
  consecutiveWindowCount: 3,
  consecutive5xxFloor: 5,
  // Task #1903 — same-response suppression dominance.
  suppressionDominanceEnabled: true,
  suppressionDominanceRatio: 0.25,
  suppressionDominanceMinPages: 8,
  // Task #1903 — empty-suffix dedupe key probe.
  emptySuffixEnabled: true,
} as const;

export const MIN_TOTAL_RETRIES_THRESHOLD = 1;
export const MAX_TOTAL_RETRIES_THRESHOLD = 10_000;
export const MIN_CONSECUTIVE_WINDOW_COUNT = 2;
export const MAX_CONSECUTIVE_WINDOW_COUNT = 50;
export const MIN_CONSECUTIVE_5XX_FLOOR = 1;
export const MAX_CONSECUTIVE_5XX_FLOOR = 10_000;
export const MIN_SUPPRESSION_DOMINANCE_RATIO = 0.01;
export const MAX_SUPPRESSION_DOMINANCE_RATIO = 1.0;
export const MIN_SUPPRESSION_DOMINANCE_MIN_PAGES = 1;
export const MAX_SUPPRESSION_DOMINANCE_MIN_PAGES = 10_000;

export interface FrontRecoveryRetryAlertConfig {
  enabled: boolean;
  totalRetriesThreshold: number;
  consecutiveWindowCount: number;
  consecutive5xxFloor: number;
  suppressionDominanceEnabled: boolean;
  suppressionDominanceRatio: number;
  suppressionDominanceMinPages: number;
  emptySuffixEnabled: boolean;
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

const alertedWindows = new Set<string>();

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

function parseRatio(
  raw: string | undefined | null,
  fallback: number,
): number {
  if (raw == null) return fallback;
  const n = Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0 || n > 1) return fallback;
  return n;
}

export async function getFrontRecoveryRetryAlertConfig(): Promise<FrontRecoveryRetryAlertConfig> {
  const [
    enabledRow,
    thresholdRow,
    consecutiveCountRow,
    consecutiveFloorRow,
    suppressionEnabledRow,
    suppressionRatioRow,
    suppressionMinPagesRow,
    emptySuffixEnabledRow,
  ] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_TOTAL_RETRIES_THRESHOLD).catch(() => null),
    getSystemSetting(SETTING_CONSECUTIVE_WINDOW_COUNT).catch(() => null),
    getSystemSetting(SETTING_CONSECUTIVE_5XX_FLOOR).catch(() => null),
    getSystemSetting(SETTING_SUPPRESSION_DOMINANCE_ENABLED).catch(() => null),
    getSystemSetting(SETTING_SUPPRESSION_DOMINANCE_RATIO).catch(() => null),
    getSystemSetting(SETTING_SUPPRESSION_DOMINANCE_MIN_PAGES).catch(() => null),
    getSystemSetting(SETTING_EMPTY_SUFFIX_ENABLED).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    totalRetriesThreshold: parsePositiveInt(
      thresholdRow?.value,
      DEFAULTS.totalRetriesThreshold,
    ),
    consecutiveWindowCount: parsePositiveInt(
      consecutiveCountRow?.value,
      DEFAULTS.consecutiveWindowCount,
    ),
    consecutive5xxFloor: parsePositiveInt(
      consecutiveFloorRow?.value,
      DEFAULTS.consecutive5xxFloor,
    ),
    suppressionDominanceEnabled: parseBool(
      suppressionEnabledRow?.value,
      DEFAULTS.suppressionDominanceEnabled,
    ),
    suppressionDominanceRatio: parseRatio(
      suppressionRatioRow?.value,
      DEFAULTS.suppressionDominanceRatio,
    ),
    suppressionDominanceMinPages: parsePositiveInt(
      suppressionMinPagesRow?.value,
      DEFAULTS.suppressionDominanceMinPages,
    ),
    emptySuffixEnabled: parseBool(
      emptySuffixEnabledRow?.value,
      DEFAULTS.emptySuffixEnabled,
    ),
  };
}

export async function setFrontRecoveryRetryAlertThreshold(
  value: number,
  updatedBy: string,
): Promise<number> {
  if (
    !Number.isInteger(value) ||
    value < MIN_TOTAL_RETRIES_THRESHOLD ||
    value > MAX_TOTAL_RETRIES_THRESHOLD
  ) {
    throw new Error(
      `threshold must be an integer between ${MIN_TOTAL_RETRIES_THRESHOLD} and ${MAX_TOTAL_RETRIES_THRESHOLD}`,
    );
  }
  const { storage } = await import("../storage");
  await storage.setSystemSetting(
    SETTING_TOTAL_RETRIES_THRESHOLD,
    String(value),
    updatedBy,
  );
  return value;
}

export async function setFrontRecoveryRetryAlertEnabled(
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

export async function setFrontRecoveryConsecutiveWindowCount(
  value: number,
  updatedBy: string,
): Promise<number> {
  if (
    !Number.isInteger(value) ||
    value < MIN_CONSECUTIVE_WINDOW_COUNT ||
    value > MAX_CONSECUTIVE_WINDOW_COUNT
  ) {
    throw new Error(
      `consecutive window count must be an integer between ${MIN_CONSECUTIVE_WINDOW_COUNT} and ${MAX_CONSECUTIVE_WINDOW_COUNT}`,
    );
  }
  const { storage } = await import("../storage");
  await storage.setSystemSetting(
    SETTING_CONSECUTIVE_WINDOW_COUNT,
    String(value),
    updatedBy,
  );
  return value;
}

export async function setFrontRecoveryConsecutive5xxFloor(
  value: number,
  updatedBy: string,
): Promise<number> {
  if (
    !Number.isInteger(value) ||
    value < MIN_CONSECUTIVE_5XX_FLOOR ||
    value > MAX_CONSECUTIVE_5XX_FLOOR
  ) {
    throw new Error(
      `consecutive 5xx floor must be an integer between ${MIN_CONSECUTIVE_5XX_FLOOR} and ${MAX_CONSECUTIVE_5XX_FLOOR}`,
    );
  }
  const { storage } = await import("../storage");
  await storage.setSystemSetting(
    SETTING_CONSECUTIVE_5XX_FLOOR,
    String(value),
    updatedBy,
  );
  return value;
}

export async function setFrontRecoverySuppressionDominanceEnabled(
  enabled: boolean,
  updatedBy: string,
): Promise<boolean> {
  const { storage } = await import("../storage");
  await storage.setSystemSetting(
    SETTING_SUPPRESSION_DOMINANCE_ENABLED,
    enabled ? "true" : "false",
    updatedBy,
  );
  return enabled;
}

export async function setFrontRecoverySuppressionDominanceRatio(
  value: number,
  updatedBy: string,
): Promise<number> {
  if (
    !Number.isFinite(value) ||
    value < MIN_SUPPRESSION_DOMINANCE_RATIO ||
    value > MAX_SUPPRESSION_DOMINANCE_RATIO
  ) {
    throw new Error(
      `suppression dominance ratio must be between ${MIN_SUPPRESSION_DOMINANCE_RATIO} and ${MAX_SUPPRESSION_DOMINANCE_RATIO}`,
    );
  }
  const { storage } = await import("../storage");
  await storage.setSystemSetting(
    SETTING_SUPPRESSION_DOMINANCE_RATIO,
    String(value),
    updatedBy,
  );
  return value;
}

export async function setFrontRecoverySuppressionDominanceMinPages(
  value: number,
  updatedBy: string,
): Promise<number> {
  if (
    !Number.isInteger(value) ||
    value < MIN_SUPPRESSION_DOMINANCE_MIN_PAGES ||
    value > MAX_SUPPRESSION_DOMINANCE_MIN_PAGES
  ) {
    throw new Error(
      `suppression dominance min pages must be an integer between ${MIN_SUPPRESSION_DOMINANCE_MIN_PAGES} and ${MAX_SUPPRESSION_DOMINANCE_MIN_PAGES}`,
    );
  }
  const { storage } = await import("../storage");
  await storage.setSystemSetting(
    SETTING_SUPPRESSION_DOMINANCE_MIN_PAGES,
    String(value),
    updatedBy,
  );
  return value;
}

export async function setFrontRecoveryEmptySuffixAlertEnabled(
  enabled: boolean,
  updatedBy: string,
): Promise<boolean> {
  const { storage } = await import("../storage");
  await storage.setSystemSetting(
    SETTING_EMPTY_SUFFIX_ENABLED,
    enabled ? "true" : "false",
    updatedBy,
  );
  return enabled;
}

function dedupeKey(jobId: string, windowLabel: string): string {
  return `${jobId}|${windowLabel}`;
}

function consecutiveDedupeKey(jobId: string, lastWindowLabel: string): string {
  return `consecutive|${jobId}|${lastWindowLabel}`;
}

function suppressionDominanceDedupeKey(
  jobId: string,
  windowLabel: string,
): string {
  return `suppression|${jobId}|${windowLabel}`;
}

function emptySuffixDedupeKey(jobId: string, windowLabel: string): string {
  return `empty_suffix|${jobId}|${windowLabel}`;
}

const alertedConsecutivePatterns = new Set<string>();
const alertedSuppressionWindows = new Set<string>();
const alertedEmptySuffixWindows = new Set<string>();

/**
 * Sum of all Front 5xx-class retry counters on a single window
 * checkpoint. Front splits its 5xx counters into per-status buckets
 * (`front_501` / `front_502` / `front_503` / `front_504`) plus a
 * generic `front_5xx` fallback for any 5xx that didn't fit one of
 * those — we treat them as one signal because they all mean "Front
 * returned a server error". `front_501` is included even though the
 * existing recovery loop doesn't emit it today, so any future
 * per-status bucket that gets added (or a checkpoint persisted from a
 * future build) is counted instead of silently dropped.
 */
export function count5xxRetries(checkpoint: WindowCheckpoint): number {
  const r = checkpoint.retriesByReason ?? {};
  return (
    (Number(r.front_501) || 0) +
    (Number(r.front_502) || 0) +
    (Number(r.front_503) || 0) +
    (Number(r.front_504) || 0) +
    (Number(r.front_5xx) || 0)
  );
}

const RETRY_REASON_LABELS: Record<string, string> = {
  timeout: "timeout",
  network: "network",
  front_501: "Front 501",
  front_502: "Front 502",
  front_503: "Front 503",
  front_504: "Front 504",
  front_5xx: "Front 5xx",
  front_429: "rate-limit (429)",
  auth_refresh_transient: "token refresh",
  db_pool_saturated: "DB pool saturated",
  db_pool_contended: "DB pool contended",
};

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

function buildAlertText(args: {
  jobId: string;
  checkpoint: WindowCheckpoint;
  threshold: number;
}): string {
  const { jobId, checkpoint, threshold } = args;
  const total = checkpoint.totalRetries ?? 0;
  const breakdown = Object.entries(checkpoint.retriesByReason ?? {})
    .filter(([, v]) => Number(v) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([k, v]) => `${RETRY_REASON_LABELS[k] ?? k}: ${v}`);
  const tokenRefreshes = Number(checkpoint.tokenRefreshes ?? 0) || 0;
  const link = buildRecoveryPanelLink();
  const lines = [
    `:warning: *Front recovery window is hammering Front* — \`${checkpoint.windowLabel}\``,
    `• Job: \`${jobId}\` — window status *${checkpoint.status}*`,
    `• Retries: *${total}* (threshold ≥ ${threshold})${tokenRefreshes > 0 ? ` · token refreshes: ${tokenRefreshes}` : ""}`,
    breakdown.length > 0
      ? `• Breakdown: ${breakdown.join(", ")}`
      : "• Breakdown: (no per-reason counters)",
    `• Pages: ${checkpoint.pages} · scanned: ${checkpoint.scanned} · ingested: ${checkpoint.ingested} · errors: ${checkpoint.errors.length}`,
    `Open the Front Historical Recovery panel: ${link}`,
  ];
  return lines.join("\n");
}

export interface RetryPressureEvaluationResult {
  evaluated: boolean;
  alerted: boolean;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_below_threshold"
    | "skipped_already_alerted"
    | "skipped_no_counters"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  totalRetries: number;
  threshold: number;
  skipReason?: string;
}

/**
 * Evaluate a freshly-completed window for retry pressure and fire a
 * single admin notification when the threshold is crossed. Safe to
 * call from the recovery loop fire-and-forget — never throws.
 *
 * Returns a structured outcome so callers (and unit tests) can assert
 * on the decision without scraping logs.
 */
export async function evaluateWindowForRetryPressure(args: {
  jobId: string;
  checkpoint: WindowCheckpoint;
}): Promise<RetryPressureEvaluationResult> {
  const { jobId, checkpoint } = args;
  const totalRetries = Number(checkpoint.totalRetries ?? 0) || 0;

  let config: FrontRecoveryRetryAlertConfig;
  try {
    config = await getFrontRecoveryRetryAlertConfig();
  } catch (err: any) {
    console.warn(
      `[FrontRecoveryRetryAlerts] config load failed (${err?.message ?? err}); skipping`,
    );
    return {
      evaluated: false,
      alerted: false,
      decision: "skipped_send_failed",
      totalRetries,
      threshold: DEFAULTS.totalRetriesThreshold,
      skipReason: `config_load_failed:${err?.message ?? "unknown"}`,
    };
  }

  if (!config.enabled) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_disabled",
      totalRetries,
      threshold: config.totalRetriesThreshold,
      skipReason: "alert disabled in system_settings",
    };
  }

  if (totalRetries < config.totalRetriesThreshold) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_below_threshold",
      totalRetries,
      threshold: config.totalRetriesThreshold,
      skipReason: `totalRetries ${totalRetries} < ${config.totalRetriesThreshold}`,
    };
  }

  const key = dedupeKey(jobId, checkpoint.windowLabel);
  if (alertedWindows.has(key)) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_already_alerted",
      totalRetries,
      threshold: config.totalRetriesThreshold,
      skipReason: "already alerted for this (jobId, windowLabel)",
    };
  }

  const text = buildAlertText({
    jobId,
    checkpoint,
    threshold: config.totalRetriesThreshold,
  });

  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        // We manage our own per-(jobId,windowLabel) dedupe above. Pass
        // a stable dedupeKey too so the dispatcher's transition-based
        // dedupe also collapses any racing duplicate within its
        // reminder window.
        dedupeKey: key,
        metadata: {
          jobId,
          windowLabel: checkpoint.windowLabel,
          windowStatus: checkpoint.status,
          totalRetries,
          threshold: config.totalRetriesThreshold,
          retriesByReason: checkpoint.retriesByReason ?? {},
          tokenRefreshes: Number(checkpoint.tokenRefreshes ?? 0) || 0,
          pages: checkpoint.pages,
          scanned: checkpoint.scanned,
          ingested: checkpoint.ingested,
          errors: checkpoint.errors.length,
        },
      },
    );
    if (r.delivered) {
      alertedWindows.add(key);
      return {
        evaluated: true,
        alerted: true,
        decision: "alerted",
        totalRetries,
        threshold: config.totalRetriesThreshold,
      };
    }
    // Treat dispatcher-side dedupe as "we already alerted" so a
    // restart of the recovery loop doesn't keep retrying a delivery
    // that the dispatcher is intentionally suppressing.
    if (r.status === "skipped_deduped") {
      alertedWindows.add(key);
    }
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_dispatcher_skipped",
      totalRetries,
      threshold: config.totalRetriesThreshold,
      skipReason: r.skipReason ?? r.status,
    };
  } catch (err: any) {
    console.error(
      `[FrontRecoveryRetryAlerts] dispatch failed for job=${jobId} window=${checkpoint.windowLabel}: ${err?.message ?? err}`,
    );
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_send_failed",
      totalRetries,
      threshold: config.totalRetriesThreshold,
      skipReason: `dispatch_error:${err?.message ?? "unknown"}`,
    };
  }
}

export interface ConsecutivePressureEvaluationResult {
  evaluated: boolean;
  alerted: boolean;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_not_enough_windows"
    | "skipped_chain_broken"
    | "skipped_below_floor"
    | "skipped_already_alerted"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  consecutiveWindowCount: number;
  consecutive5xxFloor: number;
  trailingWindow?: {
    windowLabel: string;
    front5xxRetries: number;
  };
  matchedWindowLabels?: string[];
  skipReason?: string;
}

function buildConsecutiveAlertText(args: {
  jobId: string;
  windows: Array<{ checkpoint: WindowCheckpoint; front5xxRetries: number }>;
  consecutiveWindowCount: number;
  consecutive5xxFloor: number;
}): string {
  const { jobId, windows, consecutiveWindowCount, consecutive5xxFloor } = args;
  const link = buildRecoveryPanelLink();
  const last = windows[windows.length - 1].checkpoint;
  const breakdown = windows
    .map(
      ({ checkpoint, front5xxRetries }) =>
        `  • \`${checkpoint.windowLabel}\` — Front 5xx retries: *${front5xxRetries}* (total retries: ${Number(checkpoint.totalRetries ?? 0) || 0})`,
    )
    .join("\n");
  const lines = [
    `:warning: *Front recovery is bleeding 5xx retries across ${consecutiveWindowCount} consecutive windows* — slow-burn Front regression`,
    `• Job: \`${jobId}\` — trailing window \`${last.windowLabel}\``,
    `• Floor: each of the last ${consecutiveWindowCount} completed windows has Front 5xx retries ≥ ${consecutive5xxFloor}`,
    `• Per-window breakdown:`,
    breakdown,
    `Open the Front Historical Recovery panel: ${link}`,
  ];
  return lines.join("\n");
}

/**
 * Task #1083 — second signal alongside `evaluateWindowForRetryPressure`.
 *
 * Catches the slow-burn pattern where no single window crosses the
 * per-window total-retries threshold but every recent completed window
 * is bleeding ≥ floor front_5xx-class retries. Examines the trailing
 * N completed windows in `jobState.windows`; only fires when the chain
 * is unbroken (the trailing N windows, in chronological order, are all
 * `status === "complete"` AND each has Front 5xx retries ≥ floor).
 *
 * Dedupes per `(jobId, lastWindowLabel)` so the same trailing-window
 * pattern doesn't re-alert on every subsequent window. As soon as the
 * recovery loop appends a new completed window, that window becomes
 * the new `lastWindowLabel` and the watcher can fire again if the
 * pattern persists.
 *
 * Reuses NOTIFICATION_ID — admins don't need to configure a second
 * channel.
 */
export async function evaluateConsecutiveWindowsForFront5xxPressure(args: {
  jobId: string;
  windows: WindowCheckpoint[];
}): Promise<ConsecutivePressureEvaluationResult> {
  const { jobId, windows } = args;

  let config: FrontRecoveryRetryAlertConfig;
  try {
    config = await getFrontRecoveryRetryAlertConfig();
  } catch (err: any) {
    console.warn(
      `[FrontRecoveryRetryAlerts] consecutive config load failed (${err?.message ?? err}); skipping`,
    );
    return {
      evaluated: false,
      alerted: false,
      decision: "skipped_send_failed",
      consecutiveWindowCount: DEFAULTS.consecutiveWindowCount,
      consecutive5xxFloor: DEFAULTS.consecutive5xxFloor,
      skipReason: `config_load_failed:${err?.message ?? "unknown"}`,
    };
  }

  if (!config.enabled) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_disabled",
      consecutiveWindowCount: config.consecutiveWindowCount,
      consecutive5xxFloor: config.consecutive5xxFloor,
      skipReason: "alert disabled in system_settings",
    };
  }

  const N = config.consecutiveWindowCount;
  if (!Array.isArray(windows) || windows.length < N) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_not_enough_windows",
      consecutiveWindowCount: N,
      consecutive5xxFloor: config.consecutive5xxFloor,
      skipReason: `need ${N} windows, have ${windows?.length ?? 0}`,
    };
  }

  // Trailing N in chronological order. The recovery loop appends
  // window checkpoints in completion order, so slicing the tail is
  // already chronological.
  const trailing = windows.slice(-N);

  // Chain is "unbroken" only if every trailing window is itself
  // completed. A non-`complete` window in the chain (blocked, failed,
  // empty_source, partial, running, pending) means we can't prove the
  // slow-burn pattern.
  const chainBroken = trailing.find((w) => w.status !== "complete");
  if (chainBroken) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_chain_broken",
      consecutiveWindowCount: N,
      consecutive5xxFloor: config.consecutive5xxFloor,
      skipReason: `window ${chainBroken.windowLabel} status=${chainBroken.status}`,
    };
  }

  const enriched = trailing.map((checkpoint) => ({
    checkpoint,
    front5xxRetries: count5xxRetries(checkpoint),
  }));

  const belowFloor = enriched.find(
    (w) => w.front5xxRetries < config.consecutive5xxFloor,
  );
  if (belowFloor) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_below_floor",
      consecutiveWindowCount: N,
      consecutive5xxFloor: config.consecutive5xxFloor,
      skipReason: `window ${belowFloor.checkpoint.windowLabel} front_5xx=${belowFloor.front5xxRetries} < ${config.consecutive5xxFloor}`,
    };
  }

  const lastWindow = trailing[trailing.length - 1];
  const lastFront5xx = enriched[enriched.length - 1].front5xxRetries;
  const key = consecutiveDedupeKey(jobId, lastWindow.windowLabel);
  if (alertedConsecutivePatterns.has(key)) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_already_alerted",
      consecutiveWindowCount: N,
      consecutive5xxFloor: config.consecutive5xxFloor,
      trailingWindow: {
        windowLabel: lastWindow.windowLabel,
        front5xxRetries: lastFront5xx,
      },
      matchedWindowLabels: trailing.map((w) => w.windowLabel),
      skipReason: "already alerted for this (jobId, lastWindowLabel)",
    };
  }

  const text = buildConsecutiveAlertText({
    jobId,
    windows: enriched,
    consecutiveWindowCount: N,
    consecutive5xxFloor: config.consecutive5xxFloor,
  });

  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        dedupeKey: key,
        metadata: {
          jobId,
          pattern: "consecutive_front_5xx",
          consecutiveWindowCount: N,
          consecutive5xxFloor: config.consecutive5xxFloor,
          lastWindowLabel: lastWindow.windowLabel,
          windows: enriched.map(({ checkpoint, front5xxRetries }) => ({
            windowLabel: checkpoint.windowLabel,
            status: checkpoint.status,
            front5xxRetries,
            totalRetries: Number(checkpoint.totalRetries ?? 0) || 0,
            retriesByReason: checkpoint.retriesByReason ?? {},
            pages: checkpoint.pages,
            scanned: checkpoint.scanned,
            ingested: checkpoint.ingested,
            errors: checkpoint.errors.length,
          })),
        },
      },
    );
    if (r.delivered) {
      alertedConsecutivePatterns.add(key);
      return {
        evaluated: true,
        alerted: true,
        decision: "alerted",
        consecutiveWindowCount: N,
        consecutive5xxFloor: config.consecutive5xxFloor,
        trailingWindow: {
          windowLabel: lastWindow.windowLabel,
          front5xxRetries: lastFront5xx,
        },
        matchedWindowLabels: trailing.map((w) => w.windowLabel),
      };
    }
    if (r.status === "skipped_deduped") {
      alertedConsecutivePatterns.add(key);
    }
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_dispatcher_skipped",
      consecutiveWindowCount: N,
      consecutive5xxFloor: config.consecutive5xxFloor,
      trailingWindow: {
        windowLabel: lastWindow.windowLabel,
        front5xxRetries: lastFront5xx,
      },
      matchedWindowLabels: trailing.map((w) => w.windowLabel),
      skipReason: r.skipReason ?? r.status,
    };
  } catch (err: any) {
    console.error(
      `[FrontRecoveryRetryAlerts] consecutive dispatch failed for job=${jobId} lastWindow=${lastWindow.windowLabel}: ${err?.message ?? err}`,
    );
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_send_failed",
      consecutiveWindowCount: N,
      consecutive5xxFloor: config.consecutive5xxFloor,
      trailingWindow: {
        windowLabel: lastWindow.windowLabel,
        front5xxRetries: lastFront5xx,
      },
      matchedWindowLabels: trailing.map((w) => w.windowLabel),
      skipReason: `dispatch_error:${err?.message ?? "unknown"}`,
    };
  }
}

/**
 * Task #1091 — operator-facing reset of the per-window alert dedupe.
 *
 * Removes both the single-window dedupe key (`alertedWindows`) and any
 * consecutive-pattern dedupe keys whose trailing window is this one
 * (`alertedConsecutivePatterns`) so a re-evaluation can fire a fresh
 * alert if the threshold is crossed again.
 *
 * Returns the number of dedupe keys actually removed (0 if none were
 * present), so the caller can include it in the audit log.
 */
export function clearRetryPressureAlertDedupe(args: {
  jobId: string;
  windowLabel: string;
}): {
  singleWindowCleared: boolean;
  consecutivePatternsCleared: number;
  suppressionDominanceCleared: boolean;
  emptySuffixCleared: boolean;
} {
  const { jobId, windowLabel } = args;
  const singleKey = dedupeKey(jobId, windowLabel);
  const singleWindowCleared = alertedWindows.delete(singleKey);
  const consecutiveKey = consecutiveDedupeKey(jobId, windowLabel);
  const consecutivePatternsCleared = alertedConsecutivePatterns.delete(
    consecutiveKey,
  )
    ? 1
    : 0;
  const suppressionDominanceCleared = alertedSuppressionWindows.delete(
    suppressionDominanceDedupeKey(jobId, windowLabel),
  );
  const emptySuffixCleared = alertedEmptySuffixWindows.delete(
    emptySuffixDedupeKey(jobId, windowLabel),
  );
  return {
    singleWindowCleared,
    consecutivePatternsCleared,
    suppressionDominanceCleared,
    emptySuffixCleared,
  };
}

// ----- Task #1903: same-response suppression dominance alert ---------------

export const SUPPRESSION_DOMINANCE_NOTIFICATION_ID =
  "integration.front.recovery_dedupe_contract_failure";

export interface SuppressionDominanceEvaluationResult {
  evaluated: boolean;
  alerted: boolean;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_below_min_pages"
    | "skipped_below_ratio"
    | "skipped_already_alerted"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  suppressedPages: number;
  pages: number;
  ratio: number;
  ratioThreshold: number;
  minPages: number;
  skipReason?: string;
}

function buildSuppressionDominanceAlertText(args: {
  jobId: string;
  checkpoint: WindowCheckpoint;
  suppressedPages: number;
  ratio: number;
  ratioThreshold: number;
  minPages: number;
}): string {
  const { jobId, checkpoint, suppressedPages, ratio, ratioThreshold, minPages } =
    args;
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
  const link = buildRecoveryPanelLink();
  const lines = [
    `:warning: *Front recovery same-response suppression is dominating a window* — \`${checkpoint.windowLabel}\``,
    `• Job: \`${jobId}\` — window status *${checkpoint.status}*`,
    `• Suppressed pages: *${suppressedPages}* of ${checkpoint.pages} (*${pct(ratio)}*, threshold ≥ ${pct(ratioThreshold)} over ${minPages}+ pages)`,
    `• When this dominates throughput, it usually means the dedupe-key version slot has regressed and Front pages look identical — the suppression skip is silently absorbing a contract failure rather than persisting new conversations.`,
    `• Pages: ${checkpoint.pages} · scanned: ${checkpoint.scanned} · ingested: ${checkpoint.ingested} · skipped: ${checkpoint.skipped}`,
    `Open the Front Historical Recovery panel: ${link}`,
  ];
  return lines.join("\n");
}

/**
 * Task #1903 — fire a single admin notification when
 * `same_response_suppressed` skips dominate a recovery window's page
 * sample. Mirrors the per-window retry-pressure evaluator's
 * fire-and-forget contract: never throws, dedupes per
 * `(jobId, windowLabel)` so resume/auto-continue cannot re-alert on
 * the same window.
 */
export async function evaluateWindowForSuppressionDominance(args: {
  jobId: string;
  checkpoint: WindowCheckpoint;
}): Promise<SuppressionDominanceEvaluationResult> {
  const { jobId, checkpoint } = args;
  const pages = Number(checkpoint.pages ?? 0) || 0;
  const suppressedPages =
    Number(checkpoint.retriesByReason?.["same_response_suppressed"] ?? 0) || 0;
  const ratio = pages > 0 ? suppressedPages / pages : 0;

  let config: FrontRecoveryRetryAlertConfig;
  try {
    config = await getFrontRecoveryRetryAlertConfig();
  } catch (err: any) {
    console.warn(
      `[FrontRecoveryRetryAlerts] suppression config load failed (${err?.message ?? err}); skipping`,
    );
    return {
      evaluated: false,
      alerted: false,
      decision: "skipped_send_failed",
      suppressedPages,
      pages,
      ratio,
      ratioThreshold: DEFAULTS.suppressionDominanceRatio,
      minPages: DEFAULTS.suppressionDominanceMinPages,
      skipReason: `config_load_failed:${err?.message ?? "unknown"}`,
    };
  }

  if (!config.suppressionDominanceEnabled) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_disabled",
      suppressedPages,
      pages,
      ratio,
      ratioThreshold: config.suppressionDominanceRatio,
      minPages: config.suppressionDominanceMinPages,
      skipReason: "alert disabled in system_settings",
    };
  }

  if (pages < config.suppressionDominanceMinPages) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_below_min_pages",
      suppressedPages,
      pages,
      ratio,
      ratioThreshold: config.suppressionDominanceRatio,
      minPages: config.suppressionDominanceMinPages,
      skipReason: `pages ${pages} < ${config.suppressionDominanceMinPages}`,
    };
  }

  if (ratio < config.suppressionDominanceRatio) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_below_ratio",
      suppressedPages,
      pages,
      ratio,
      ratioThreshold: config.suppressionDominanceRatio,
      minPages: config.suppressionDominanceMinPages,
      skipReason: `ratio ${ratio.toFixed(3)} < ${config.suppressionDominanceRatio}`,
    };
  }

  const key = suppressionDominanceDedupeKey(jobId, checkpoint.windowLabel);
  if (alertedSuppressionWindows.has(key)) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_already_alerted",
      suppressedPages,
      pages,
      ratio,
      ratioThreshold: config.suppressionDominanceRatio,
      minPages: config.suppressionDominanceMinPages,
      skipReason: "already alerted for this (jobId, windowLabel)",
    };
  }

  const text = buildSuppressionDominanceAlertText({
    jobId,
    checkpoint,
    suppressedPages,
    ratio,
    ratioThreshold: config.suppressionDominanceRatio,
    minPages: config.suppressionDominanceMinPages,
  });

  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      SUPPRESSION_DOMINANCE_NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        dedupeKey: key,
        metadata: {
          jobId,
          windowLabel: checkpoint.windowLabel,
          windowStatus: checkpoint.status,
          pattern: "same_response_suppression_dominance",
          suppressedPages,
          pages,
          ratio,
          ratioThreshold: config.suppressionDominanceRatio,
          minPages: config.suppressionDominanceMinPages,
          retriesByReason: checkpoint.retriesByReason ?? {},
          scanned: checkpoint.scanned,
          ingested: checkpoint.ingested,
          skipped: checkpoint.skipped,
        },
      },
    );
    if (r.delivered) {
      alertedSuppressionWindows.add(key);
      return {
        evaluated: true,
        alerted: true,
        decision: "alerted",
        suppressedPages,
        pages,
        ratio,
        ratioThreshold: config.suppressionDominanceRatio,
        minPages: config.suppressionDominanceMinPages,
      };
    }
    if (r.status === "skipped_deduped") {
      alertedSuppressionWindows.add(key);
    }
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_dispatcher_skipped",
      suppressedPages,
      pages,
      ratio,
      ratioThreshold: config.suppressionDominanceRatio,
      minPages: config.suppressionDominanceMinPages,
      skipReason: r.skipReason ?? r.status,
    };
  } catch (err: any) {
    console.error(
      `[FrontRecoveryRetryAlerts] suppression dispatch failed for job=${jobId} window=${checkpoint.windowLabel}: ${err?.message ?? err}`,
    );
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_send_failed",
      suppressedPages,
      pages,
      ratio,
      ratioThreshold: config.suppressionDominanceRatio,
      minPages: config.suppressionDominanceMinPages,
      skipReason: `dispatch_error:${err?.message ?? "unknown"}`,
    };
  }
}

// ----- Task #1903: empty-suffix dedupe-key probe ----------------------------

export interface EmptySuffixProbeEvaluationResult {
  evaluated: boolean;
  alerted: boolean;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_probe_failed"
    | "skipped_clean"
    | "skipped_already_alerted"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  emptySuffixCount: number;
  skipReason?: string;
}

type EmptySuffixCounter = () => Promise<number>;

let emptySuffixCounterOverride: EmptySuffixCounter | null = null;

async function defaultCountEmptySuffixRecoveryDedupeKeys(): Promise<number> {
  // Lazy-load drizzle + db handle to avoid bootstrap order issues and
  // keep this file lightweight for callers that never invoke the probe.
  const { sql } = await import("drizzle-orm");
  const { workerDb } = await import("../db");
  const res: any = await workerDb.execute(sql`
    SELECT COUNT(*)::bigint AS n
    FROM source_event_log
    WHERE dedupe_key LIKE 'front:recovery:%:'
  `);
  const rows = Array.isArray(res?.rows) ? res.rows : Array.isArray(res) ? res : [];
  const n = Number(rows[0]?.n ?? rows[0]?.count ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function buildEmptySuffixAlertText(args: {
  jobId: string;
  windowLabel: string;
  emptySuffixCount: number;
}): string {
  const { jobId, windowLabel, emptySuffixCount } = args;
  const link = buildRecoveryPanelLink();
  const lines = [
    `:warning: *Front recovery dedupe keys have regressed to the empty-suffix shape*`,
    `• Detected during job \`${jobId}\` window \`${windowLabel}\``,
    `• \`source_event_log\` rows matching \`front:recovery:<convId>:\` (no version slot): *${emptySuffixCount}*`,
    `• The Task #1887 helper means this should stay flat. Any non-zero count means a writer regressed back to the trailing-empty-colon shape, which collapses one dedupe entry per thread and silently drops new inbound messages.`,
    `Open the Front Historical Recovery panel: ${link}`,
  ];
  return lines.join("\n");
}

/**
 * Task #1903 — sibling check to the same-response suppression
 * dominance alert. Counts `source_event_log` rows whose dedupe key
 * ends with an empty version slot (`front:recovery:<id>:`). The
 * Task #1887 `extractFrontConvMessageVersion` helper means this
 * should stay flat; any non-zero count is a real contract failure.
 *
 * Dedupes per `(jobId, windowLabel)` so a long-running job doesn't
 * spam admins on every completed window once the regression has been
 * surfaced.
 */
export async function evaluateEmptySuffixDedupeKeys(args: {
  jobId: string;
  windowLabel: string;
}): Promise<EmptySuffixProbeEvaluationResult> {
  const { jobId, windowLabel } = args;

  let config: FrontRecoveryRetryAlertConfig;
  try {
    config = await getFrontRecoveryRetryAlertConfig();
  } catch (err: any) {
    return {
      evaluated: false,
      alerted: false,
      decision: "skipped_send_failed",
      emptySuffixCount: 0,
      skipReason: `config_load_failed:${err?.message ?? "unknown"}`,
    };
  }

  if (!config.emptySuffixEnabled) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_disabled",
      emptySuffixCount: 0,
      skipReason: "alert disabled in system_settings",
    };
  }

  let emptySuffixCount: number;
  try {
    const counter =
      emptySuffixCounterOverride ?? defaultCountEmptySuffixRecoveryDedupeKeys;
    emptySuffixCount = await counter();
  } catch (err: any) {
    console.warn(
      `[FrontRecoveryRetryAlerts] empty-suffix probe failed: ${err?.message ?? err}`,
    );
    return {
      evaluated: false,
      alerted: false,
      decision: "skipped_probe_failed",
      emptySuffixCount: 0,
      skipReason: `probe_error:${err?.message ?? "unknown"}`,
    };
  }

  if (emptySuffixCount <= 0) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_clean",
      emptySuffixCount: 0,
    };
  }

  const key = emptySuffixDedupeKey(jobId, windowLabel);
  if (alertedEmptySuffixWindows.has(key)) {
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_already_alerted",
      emptySuffixCount,
      skipReason: "already alerted for this (jobId, windowLabel)",
    };
  }

  const text = buildEmptySuffixAlertText({
    jobId,
    windowLabel,
    emptySuffixCount,
  });

  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      SUPPRESSION_DOMINANCE_NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        dedupeKey: key,
        metadata: {
          jobId,
          windowLabel,
          pattern: "empty_suffix_dedupe_keys",
          emptySuffixCount,
        },
      },
    );
    if (r.delivered) {
      alertedEmptySuffixWindows.add(key);
      return {
        evaluated: true,
        alerted: true,
        decision: "alerted",
        emptySuffixCount,
      };
    }
    if (r.status === "skipped_deduped") {
      alertedEmptySuffixWindows.add(key);
    }
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_dispatcher_skipped",
      emptySuffixCount,
      skipReason: r.skipReason ?? r.status,
    };
  } catch (err: any) {
    console.error(
      `[FrontRecoveryRetryAlerts] empty-suffix dispatch failed for job=${jobId} window=${windowLabel}: ${err?.message ?? err}`,
    );
    return {
      evaluated: true,
      alerted: false,
      decision: "skipped_send_failed",
      emptySuffixCount,
      skipReason: `dispatch_error:${err?.message ?? "unknown"}`,
    };
  }
}

export const __testHelpers = {
  resetAlertedCache(): void {
    alertedWindows.clear();
    alertedConsecutivePatterns.clear();
    alertedSuppressionWindows.clear();
    alertedEmptySuffixWindows.clear();
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  setEmptySuffixCounterForTests(fn: EmptySuffixCounter | null): void {
    emptySuffixCounterOverride = fn;
  },
  buildAlertText,
  buildConsecutiveAlertText,
  buildSuppressionDominanceAlertText,
  buildEmptySuffixAlertText,
};
