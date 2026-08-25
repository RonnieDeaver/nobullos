/**
 * Task #1076 — Alert when call-analysis failures spike for a single
 * failure_reason.
 *
 * Background
 * ----------
 * Task #1057 added a panel showing the call-analysis failure mix by
 * `failure_reason × lane` for the last 24h / 7d, but operators still
 * have to be looking at the dashboard to notice a regression. This
 * watcher runs hourly, aggregates failed `call_analysis_jobs` rows by
 * `failure_reason` over a short window (default 60 min), and fires a
 * Slack alert via the unified `notifyByType` dispatcher when ANY
 * single reason crosses an operator-configurable threshold:
 *
 *   - `absolute` — the count in the window is at or above
 *     `absolute_threshold` (default 10/h). Catches sudden outages
 *     that come out of nowhere even when the 7d baseline is empty.
 *   - `ratio` — the count is at or above `ratio_threshold` (default
 *     3.0) times the 7d hourly baseline for the same reason. Catches
 *     a 3x jump in something that was previously rare. We require
 *     a small absolute floor (`min_count_for_ratio`, default 3) so a
 *     baseline of 0.1/h doesn't fire on a single failure.
 *
 * Each reason has its own per-reason cooldown (default 6h) so a
 * single sustained outage doesn't spam the channel every hour; we
 * re-alert early only when the count grows by another full
 * `absolute_threshold` rows over the previously-alerted snapshot.
 *
 * Specific reasons can be silenced via a comma-separated mute list
 * in `system_settings.call_analysis_failure_spike_muted_reasons`
 * (e.g. `unknown,cpu_starved` while a known issue is being worked).
 *
 * Channel/enabled state lives in `notification_settings` for
 * `queue.call_analysis.failure_spike` (registry id); threshold knobs
 * live in `system_settings` so an admin can tune them without a
 * deploy.
 */
import { workerDb as db, withDbAttribution } from "../db";
import { sql } from "drizzle-orm";
import { getSystemSetting } from "../storage/settingsStorage";
import {
  callAnalysisFailureReasons,
  type CallAnalysisFailureReason,
} from "@shared/models/ceoTools";

const NOTIFICATION_ID = "queue.call_analysis.failure_spike";

export const SETTING_ENABLED = "call_analysis_failure_spike_alert_enabled";
export const SETTING_WINDOW_MINUTES = "call_analysis_failure_spike_window_minutes";
export const SETTING_BASELINE_DAYS = "call_analysis_failure_spike_baseline_days";
export const SETTING_ABSOLUTE_THRESHOLD = "call_analysis_failure_spike_absolute_threshold";
export const SETTING_RATIO_THRESHOLD = "call_analysis_failure_spike_ratio_threshold";
export const SETTING_MIN_COUNT_FOR_RATIO = "call_analysis_failure_spike_min_count_for_ratio";
export const SETTING_COOLDOWN = "call_analysis_failure_spike_cooldown_minutes";
export const SETTING_MUTED_REASONS = "call_analysis_failure_spike_muted_reasons";

const DEFAULTS = {
  enabled: true,
  windowMinutes: 60,
  baselineDays: 7,
  absoluteThreshold: 10,
  ratioThreshold: 3,
  minCountForRatio: 3,
  cooldownMinutes: 6 * 60,
  mutedReasons: [] as string[],
};

const CHECK_INTERVAL_MS = 60 * 60_000;

export interface CallAnalysisFailureSpikeAlertConfig {
  enabled: boolean;
  windowMinutes: number;
  baselineDays: number;
  absoluteThreshold: number;
  ratioThreshold: number;
  minCountForRatio: number;
  cooldownMinutes: number;
  mutedReasons: string[];
}

interface LastAlertRecord {
  at: number;
  count: number;
}

const lastAlertByReason = new Map<string, LastAlertRecord>();

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

function parsePositiveFloat(raw: string | undefined | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseFloat(String(raw).trim());
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

function parseMutedReasons(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export async function getCallAnalysisFailureSpikeAlertConfig(): Promise<CallAnalysisFailureSpikeAlertConfig> {
  const [
    enabledRow,
    windowRow,
    baselineRow,
    absoluteRow,
    ratioRow,
    minCountRow,
    cooldownRow,
    mutedRow,
  ] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_WINDOW_MINUTES).catch(() => null),
    getSystemSetting(SETTING_BASELINE_DAYS).catch(() => null),
    getSystemSetting(SETTING_ABSOLUTE_THRESHOLD).catch(() => null),
    getSystemSetting(SETTING_RATIO_THRESHOLD).catch(() => null),
    getSystemSetting(SETTING_MIN_COUNT_FOR_RATIO).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN).catch(() => null),
    getSystemSetting(SETTING_MUTED_REASONS).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    windowMinutes: parsePositiveInt(windowRow?.value, DEFAULTS.windowMinutes),
    baselineDays: parsePositiveInt(baselineRow?.value, DEFAULTS.baselineDays),
    absoluteThreshold: parsePositiveInt(absoluteRow?.value, DEFAULTS.absoluteThreshold),
    ratioThreshold: parsePositiveFloat(ratioRow?.value, DEFAULTS.ratioThreshold),
    minCountForRatio: parsePositiveInt(minCountRow?.value, DEFAULTS.minCountForRatio),
    cooldownMinutes: parsePositiveInt(cooldownRow?.value, DEFAULTS.cooldownMinutes),
    mutedReasons: parseMutedReasons(mutedRow?.value),
  };
}

function buildAdminLink(): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  // The failure-mix panel lives on the CEO/health tools dashboard.
  const path = "/admin/ceo-tools#call-analysis-failure-mix";
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

export type SpikeReason = "absolute" | "ratio" | "absolute_and_ratio";

export interface ReasonEvaluation {
  reason: string;
  windowCount: number;
  baselinePerWindow: number;
  ratio: number | null;
  triggered: SpikeReason | null;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_muted"
    | "skipped_below_threshold"
    | "skipped_cooldown"
    | "skipped_no_growth_since_last_alert"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  skipReason?: string;
}

export interface CallAnalysisFailureSpikeCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  windowMinutes: number;
  baselineDays: number;
  alertsSent: number;
  reasons: ReasonEvaluation[];
}

type WindowCountRow = {
  failure_reason: string;
  n: number;
  [key: string]: unknown;
};

type BaselineRow = {
  failure_reason: string;
  total: number;
  [key: string]: unknown;
};

async function loadWindowCounts(
  windowMinutes: number,
  nowMs: number,
): Promise<Map<string, number>> {
  // Use the caller-supplied `nowMs` instead of SQL `NOW()` so the
  // alert window is anchored to a single JS-side clock snapshot.
  // Tests pass the same `nowMs` to seedFailures() so seed offsets
  // and the window floor share an identical origin to the ms.
  const nowSeconds = nowMs / 1000;
  const rows = await db.execute<WindowCountRow>(sql`
    SELECT
      COALESCE(failure_reason, 'unknown') AS failure_reason,
      COUNT(*)::int AS n
    FROM call_analysis_jobs
    WHERE status = 'failed'
      AND completed_at >= to_timestamp(${nowSeconds}) - (${windowMinutes} || ' minutes')::interval
    GROUP BY 1
  `);
  const out = new Map<string, number>();
  for (const r of rows.rows as readonly WindowCountRow[]) {
    out.set(String(r.failure_reason ?? "unknown"), Number(r.n) || 0);
  }
  return out;
}

async function loadBaselinePerWindow(
  baselineDays: number,
  windowMinutes: number,
  nowMs: number,
): Promise<Map<string, number>> {
  // Average count PER window-of-windowMinutes over the baseline
  // period, EXCLUDING the current alert window so the spike doesn't
  // pollute its own baseline. Normalising to the configured window
  // length means the ratio comparison is correct for non-60m
  // windows (e.g. windowMinutes=15 compares this 15-min count to the
  // average 15-min count over the prior baselineDays).
  // Anchor both window bounds on the caller-supplied `nowMs` (see
  // loadWindowCounts above) so the baseline floor and the
  // current-window ceiling are coherent with each other and with
  // the SELECT in loadWindowCounts.
  const nowSeconds = nowMs / 1000;
  const rows = await db.execute<BaselineRow>(sql`
    SELECT
      COALESCE(failure_reason, 'unknown') AS failure_reason,
      COUNT(*)::int AS total
    FROM call_analysis_jobs
    WHERE status = 'failed'
      AND completed_at >= to_timestamp(${nowSeconds}) - (${baselineDays} || ' days')::interval
      AND completed_at <  to_timestamp(${nowSeconds}) - (${windowMinutes} || ' minutes')::interval
    GROUP BY 1
  `);
  // Total minutes covered by the baseline query, expressed in
  // window-of-windowMinutes units. Floor at 1 window so a tiny
  // baselineDays setting can't divide by zero.
  const baselineMinutes = Math.max(
    windowMinutes,
    baselineDays * 24 * 60 - windowMinutes,
  );
  const baselineWindows = baselineMinutes / windowMinutes;
  const out = new Map<string, number>();
  for (const r of rows.rows as readonly BaselineRow[]) {
    const perWindow = (Number(r.total) || 0) / baselineWindows;
    out.set(String(r.failure_reason ?? "unknown"), perWindow);
  }
  return out;
}

function buildAlertText(args: {
  reason: string;
  windowCount: number;
  baselinePerWindow: number;
  ratio: number | null;
  triggered: SpikeReason;
  config: CallAnalysisFailureSpikeAlertConfig;
}): string {
  const link = buildAdminLink();
  const baselineLabel = args.baselinePerWindow > 0
    ? `${args.baselinePerWindow.toFixed(2)} per ${args.config.windowMinutes}m over the prior ${args.config.baselineDays}d`
    : `0 per ${args.config.windowMinutes}m over the prior ${args.config.baselineDays}d`;
  const triggerLines: string[] = [];
  if (args.triggered === "absolute" || args.triggered === "absolute_and_ratio") {
    triggerLines.push(
      `• Absolute: *${args.windowCount}* ≥ threshold *${args.config.absoluteThreshold}*`,
    );
  }
  if (args.triggered === "ratio" || args.triggered === "absolute_and_ratio") {
    triggerLines.push(
      `• Ratio: *${(args.ratio ?? 0).toFixed(2)}x* baseline ≥ threshold *${args.config.ratioThreshold.toFixed(2)}x* (baseline ${baselineLabel})`,
    );
  }
  return [
    `:warning: *Call-analysis failure spike* — \`${args.reason}\``,
    `• *${args.windowCount}* failure(s) in the last *${args.config.windowMinutes}m*`,
    `• Baseline: ${baselineLabel}`,
    ...triggerLines,
    `Investigate the failure mix panel: ${link}`,
  ].join("\n");
}

function evaluateThresholds(
  windowCount: number,
  baselinePerWindow: number,
  config: CallAnalysisFailureSpikeAlertConfig,
): { triggered: SpikeReason | null; ratio: number | null } {
  const ratio = baselinePerWindow > 0 ? windowCount / baselinePerWindow : null;
  const absoluteHit = windowCount >= config.absoluteThreshold;
  // Require a small absolute floor before honouring the ratio rule so
  // a baseline of 0.1/h doesn't fire on the very first failure.
  const ratioHit =
    ratio != null &&
    windowCount >= config.minCountForRatio &&
    ratio >= config.ratioThreshold;
  if (absoluteHit && ratioHit) return { triggered: "absolute_and_ratio", ratio };
  if (absoluteHit) return { triggered: "absolute", ratio };
  if (ratioHit) return { triggered: "ratio", ratio };
  return { triggered: null, ratio };
}

async function dispatchReasonAlert(
  reason: string,
  windowCount: number,
  baselinePerWindow: number,
  triggered: SpikeReason,
  ratio: number | null,
  config: CallAnalysisFailureSpikeAlertConfig,
  now: number,
): Promise<ReasonEvaluation> {
  const cooldownMs = config.cooldownMinutes * 60_000;
  const last = lastAlertByReason.get(reason);
  if (last) {
    const elapsedMs = now - last.at;
    const growth = windowCount - last.count;
    if (elapsedMs < cooldownMs && growth < config.absoluteThreshold) {
      if (growth <= 0) {
        return {
          reason,
          windowCount,
          baselinePerWindow,
          ratio,
          triggered,
          decision: "skipped_no_growth_since_last_alert",
          skipReason: `no growth since last alert (${windowCount} ≤ ${last.count})`,
        };
      }
      return {
        reason,
        windowCount,
        baselinePerWindow,
        ratio,
        triggered,
        decision: "skipped_cooldown",
        skipReason: `cooldown ${Math.round(elapsedMs / 60_000)}m < ${config.cooldownMinutes}m and growth-since-last ${growth} < ${config.absoluteThreshold}`,
      };
    }
  }

  const text = buildAlertText({
    reason,
    windowCount,
    baselinePerWindow,
    ratio,
    triggered,
    config,
  });

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
        // The watcher manages its own per-reason cooldown above; let
        // the dispatcher fire whenever we get here.
        bypassDedupe: true,
        metadata: {
          reason,
          windowCount,
          baselinePerWindow: Number(baselinePerWindow.toFixed(4)),
          ratio: ratio == null ? null : Number(ratio.toFixed(2)),
          triggered,
          windowMinutes: config.windowMinutes,
          baselineDays: config.baselineDays,
          absoluteThreshold: config.absoluteThreshold,
          ratioThreshold: config.ratioThreshold,
          minCountForRatio: config.minCountForRatio,
        },
      },
    );
    delivered = r.delivered;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: any) {
    console.error(
      `[CallAnalysisFailureSpikeAlerts] dispatch failed for ${reason}: ${err?.message}`,
    );
    skipReason = `dispatch_error:${err?.message ?? "unknown"}`;
  }

  if (delivered) {
    lastAlertByReason.set(reason, { at: now, count: windowCount });
    return {
      reason,
      windowCount,
      baselinePerWindow,
      ratio,
      triggered,
      decision: "alerted",
    };
  }
  return {
    reason,
    windowCount,
    baselinePerWindow,
    ratio,
    triggered,
    decision: skipReason?.startsWith("dispatch_error")
      ? "skipped_send_failed"
      : "skipped_dispatcher_skipped",
    skipReason,
  };
}

export interface CheckCallAnalysisFailureSpikesOptions {
  /**
   * When true, evaluate every reason the same way the live tick does
   * but never call the dispatcher and never update the per-reason
   * cooldown cache. Reasons that WOULD have alerted are reported with
   * decision `"alerted"` so the admin preview UI can surface them
   * truthfully — but no Slack message is sent.
   */
  dryRun?: boolean;
}

export async function checkCallAnalysisFailureSpikes(
  now: number = Date.now(),
  options: CheckCallAnalysisFailureSpikesOptions = {},
): Promise<CallAnalysisFailureSpikeCheckResult> {
  const config = await getCallAnalysisFailureSpikeAlertConfig();
  const result: CallAnalysisFailureSpikeCheckResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    windowMinutes: config.windowMinutes,
    baselineDays: config.baselineDays,
    alertsSent: 0,
    reasons: [],
  };

  // Always pull window + baseline counts so the diagnostics view
  // shows what would be evaluated even when the alert is disabled.
  const [windowCounts, baselinePerWindow] = await Promise.all([
    loadWindowCounts(config.windowMinutes, now),
    loadBaselinePerWindow(config.baselineDays, config.windowMinutes, now),
  ]);

  const muted = new Set(config.mutedReasons.map((r) => r.toLowerCase()));

  // Iterate the canonical reason set (Task #1049) so the diagnostics
  // table always shows the same rows; also fold in any unexpected
  // reasons that show up in the data so we don't silently drop them.
  const reasons = new Set<string>([
    ...callAnalysisFailureReasons,
    ...windowCounts.keys(),
  ]);

  for (const reason of reasons) {
    const windowCount = windowCounts.get(reason) ?? 0;
    const baseline = baselinePerWindow.get(reason) ?? 0;
    const { triggered, ratio } = evaluateThresholds(windowCount, baseline, config);

    if (!config.enabled) {
      result.reasons.push({
        reason,
        windowCount,
        baselinePerWindow: baseline,
        ratio,
        triggered,
        decision: "skipped_disabled",
        skipReason: "alert disabled in system_settings",
      });
      continue;
    }

    if (muted.has(reason.toLowerCase())) {
      result.reasons.push({
        reason,
        windowCount,
        baselinePerWindow: baseline,
        ratio,
        triggered,
        decision: "skipped_muted",
        skipReason: `reason '${reason}' is in the muted list`,
      });
      continue;
    }

    if (!triggered) {
      result.reasons.push({
        reason,
        windowCount,
        baselinePerWindow: baseline,
        ratio,
        triggered: null,
        decision: "skipped_below_threshold",
        skipReason: `count ${windowCount} below absolute (${config.absoluteThreshold}) and ratio (${config.ratioThreshold}x of ${baseline.toFixed(2)} per ${config.windowMinutes}m)`,
      });
      continue;
    }

    if (options.dryRun) {
      // Preview path: report what WOULD alert without touching the
      // dispatcher or the per-reason cooldown cache. Cooldown is NOT
      // consulted here either — the caller wants to see every reason
      // currently above threshold, not "what would the next live tick
      // send right now".
      result.reasons.push({
        reason,
        windowCount,
        baselinePerWindow: baseline,
        ratio,
        triggered,
        decision: "alerted",
        skipReason: "dry_run: dispatcher not invoked",
      });
      result.alertsSent += 1;
      continue;
    }

    const evalResult = await dispatchReasonAlert(
      reason,
      windowCount,
      baseline,
      triggered,
      ratio,
      config,
      now,
    );
    if (evalResult.decision === "alerted") result.alertsSent += 1;
    result.reasons.push(evalResult);
  }

  return result;
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await checkCallAnalysisFailureSpikes();
      if (r.alertsSent > 0) {
        const summary = r.reasons
          .filter((b) => b.decision === "alerted")
          .map((b) => `${b.reason}=${b.windowCount}`)
          .join(",");
        console.log(`[CallAnalysisFailureSpikeAlerts] sent=${r.alertsSent} ${summary}`);
      }
    } catch (err: any) {
      console.warn(`[CallAnalysisFailureSpikeAlerts] tick failed: ${err?.message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startCallAnalysisFailureSpikeAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution("scheduler:call-analysis-failure-spike-alerts", () => tick());
  }, CHECK_INTERVAL_MS);
  interval.unref?.();
  console.log(
    `[CallAnalysisFailureSpikeAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopCallAnalysisFailureSpikeAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_ID,
  DEFAULTS,
  CHECK_INTERVAL_MS,
  resetLastAlertCache(): void {
    lastAlertByReason.clear();
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  evaluateThresholds,
};
