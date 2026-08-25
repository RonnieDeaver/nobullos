// @cross-instance-safe: cooldown-guarded emit — DB manual_reserve_digest.last_sent_key in system_settings gates the digest; duplicate emit is low-harm.
/**
 * Task #711 — Slack digest summarizing recent reserve-pressure spikes.
 *
 * Per-tick manual-reserve alerts (server/services/manualReserveAlerts.ts) each
 * have their own 15-minute (metric, severity) cooldown to avoid spam. After a
 * multi-hour incident, that leaves admins scrolling the Health Dashboard to
 * see how many warning vs critical breaches each metric had. This scheduler
 * aggregates the last N hours of dispatch rows from
 * `manual_reserve_alert_dispatches` and posts a single Slack summary.
 *
 * Cadence + channel are configurable via `system_settings`. The notification
 * itself routes through the unified dispatcher
 * (`usage.manual_reserve.digest`), so the channel can also be steered from
 * the Slack Notifications Console — when notification_settings is empty the
 * resolver falls back to the digest-specific setting key, then the
 * shared rate-limit alert channel (same fallback chain as the live alert).
 *
 * Configuration keys (all in `system_settings`):
 *   - `manual_reserve_digest.enabled`         "true"/"false" (default false)
 *   - `manual_reserve_digest.cadence`         "daily" | "weekly" (default daily)
 *   - `manual_reserve_digest.hour_utc`        0..23 (default 15)
 *   - `manual_reserve_digest.weekday_utc`     0..6 (Sun=0, default 1=Mon, weekly only)
 *   - `manual_reserve_digest.window_hours`    aggregation window (default 24)
 *   - `manual_reserve_digest.channel`         channel id override
 *   - `manual_reserve_digest.last_sent_key`   idempotency token (YYYY-MM-DD or
 *                                              YYYY-Www depending on cadence)
 *   - `manual_reserve_digest.snoozed_until`   ms epoch
 */

import { withDbAttribution } from "../db";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import {
  listManualReserveAlertDispatches,
  getHealthSamplesSince,
} from "../storage/healthMetricsStorage";
import type { Alert } from "./healthMetrics";

/**
 * Manual-reserve metric names emitted by `evaluateManualReserveAlerts` and
 * `evaluatePerEntryPointManualReserveAlerts` in `server/services/healthMetrics.ts`.
 * The digest counts only these metrics out of the broader `health_samples.alerts`
 * stream so DB-latency / consecutive-failure alerts don't pollute the report.
 */
const MANUAL_RESERVE_METRIC_NAMES = new Set<string>([
  "manual_wait_p95_ms",
  "manual_timeout_window",
  "manual_delayed_by_background_window",
  "background_ingestion_saturation_window",
]);
const MANUAL_RESERVE_METRIC_PREFIXES = [
  "manual_entrypoint_timeout_window:",
  "manual_entrypoint_delayed_window:",
];

function isManualReserveMetric(metric: string): boolean {
  if (MANUAL_RESERVE_METRIC_NAMES.has(metric)) return true;
  return MANUAL_RESERVE_METRIC_PREFIXES.some((p) => metric.startsWith(p));
}

export const NOTIFICATION_ID = "usage.manual_reserve.digest";

export const SETTING_ENABLED = "manual_reserve_digest.enabled";
export const SETTING_CADENCE = "manual_reserve_digest.cadence";
export const SETTING_HOUR = "manual_reserve_digest.hour_utc";
export const SETTING_WEEKDAY = "manual_reserve_digest.weekday_utc";
export const SETTING_WINDOW_HOURS = "manual_reserve_digest.window_hours";
export const SETTING_CHANNEL = "manual_reserve_digest.channel";
export const SETTING_LAST_SENT = "manual_reserve_digest.last_sent_key";
export const SETTING_SNOOZED = "manual_reserve_digest.snoozed_until";
/**
 * Task #1181 — Optional comma-separated allow-list of manual-reserve metric
 * names. When set, `buildDigestSummary` only counts breaches whose metric
 * name appears in this list (still gated by `isManualReserveMetric`).
 * Empty / missing keeps the legacy "all manual-reserve metrics" behaviour.
 */
export const SETTING_METRICS = "manual_reserve_digest.metrics";

const CHECK_INTERVAL_MS = 5 * 60_000;

export type ManualReserveDigestCadence = "daily" | "weekly";

export interface ManualReserveDigestConfig {
  enabled: boolean;
  cadence: ManualReserveDigestCadence;
  hourUtc: number;
  weekdayUtc: number;
  windowHours: number;
  channel: string | null;
  snoozedUntil: number | null;
  lastSentKey: string | null;
  /**
   * Task #1181 — When non-empty, only these manual-reserve metric names are
   * counted in the digest summary. Empty array = include all (legacy).
   */
  metrics: string[];
}

/**
 * Task #1181 — Parse the comma-separated `manual_reserve_digest.metrics`
 * setting into a deduped, trimmed list. Tolerates newlines and whitespace
 * so admins can paste multiline lists.
 */
export function parseMetricsSetting(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const parts = String(raw)
    .split(/[,\n]/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Array.from(new Set(parts));
}

const DEFAULTS: Omit<
  ManualReserveDigestConfig,
  "channel" | "snoozedUntil" | "lastSentKey"
> = {
  enabled: false,
  cadence: "daily",
  hourUtc: 15,
  weekdayUtc: 1,
  windowHours: 24,
  metrics: [],
};

let interval: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

function parseInt0(raw: string | undefined | null, fallback: number, min: number, max: number): number {
  if (raw == null) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function parseCadence(raw: string | undefined | null): ManualReserveDigestCadence {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "weekly") return "weekly";
  return "daily";
}

export async function getManualReserveDigestConfig(): Promise<ManualReserveDigestConfig> {
  const [enabled, cadence, hour, weekday, windowH, channel, lastSent, snoozed, metrics] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_CADENCE).catch(() => null),
    getSystemSetting(SETTING_HOUR).catch(() => null),
    getSystemSetting(SETTING_WEEKDAY).catch(() => null),
    getSystemSetting(SETTING_WINDOW_HOURS).catch(() => null),
    getSystemSetting(SETTING_CHANNEL).catch(() => null),
    getSystemSetting(SETTING_LAST_SENT).catch(() => null),
    getSystemSetting(SETTING_SNOOZED).catch(() => null),
    getSystemSetting(SETTING_METRICS).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabled?.value, DEFAULTS.enabled),
    cadence: parseCadence(cadence?.value),
    hourUtc: parseInt0(hour?.value, DEFAULTS.hourUtc, 0, 23),
    weekdayUtc: parseInt0(weekday?.value, DEFAULTS.weekdayUtc, 0, 6),
    windowHours: parseInt0(windowH?.value, DEFAULTS.windowHours, 1, 24 * 14),
    channel: channel?.value?.trim() ? channel.value.trim() : null,
    snoozedUntil: snoozed?.value ? Number(snoozed.value) || null : null,
    lastSentKey: lastSent?.value ?? null,
    metrics: parseMetricsSetting(metrics?.value),
  };
}

function utcDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** ISO week key (YYYY-Www) computed in UTC, used for weekly idempotency. */
function utcIsoWeekKey(ts: number): string {
  const d = new Date(Date.UTC(
    new Date(ts).getUTCFullYear(),
    new Date(ts).getUTCMonth(),
    new Date(ts).getUTCDate(),
  ));
  // ISO 8601: Thursday in current week decides the year.
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const weekNum = 1 + Math.round(
    ((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function periodKey(cadence: ManualReserveDigestCadence, ts: number): string {
  return cadence === "weekly" ? utcIsoWeekKey(ts) : utcDateKey(ts);
}

export interface DigestAggregate {
  metric: string;
  warning: number;
  critical: number;
  total: number;
  firstSeenAt: number;
  lastSeenAt: number;
  peakValue: number;
  peakThreshold: number;
}

export interface DigestSummary {
  windowHours: number;
  windowStart: number;
  windowEnd: number;
  /** Number of sampler ticks in the window where ANY manual-reserve alert fired. */
  breachSamples: number;
  /** Total of warning + critical breach detections summed across all samples. */
  totalAlerts: number;
  totalWarning: number;
  totalCritical: number;
  perMetric: DigestAggregate[];
  /** First "backed_up"/"all_clear" transitions in the window, oldest first. */
  transitions: Array<{ at: number; eventType: string; message: string }>;
}

/**
 * Build a digest summary by aggregating manual-reserve breaches from raw
 * `health_samples.alerts` rows — the same per-tick alert evaluations that
 * `evaluateManualReserveAlerts` runs every 30s. Counting from samples (not
 * from `manual_reserve_alert_dispatches`) keeps the digest accurate even when
 * Slack is disconnected, muted, or rate-limited by the per-(metric,severity)
 * 15-minute cooldown — those paths suppress dispatch rows but still record
 * the underlying breach in the sample. Backed-up / all-clear transitions are
 * still sourced from the dispatch table because they are written exactly once
 * per state change, regardless of dispatch outcome.
 */
export async function buildDigestSummary(
  windowHours: number,
  now: number = Date.now(),
  /**
   * Task #1181 — Optional allow-list of metric names. When non-empty, only
   * matching breaches are counted; transitions are filtered with the same
   * substring match against `r.message` so a `manual_timeout_window` filter
   * still surfaces the matching backed_up/all_clear lines. An empty / undefined
   * filter preserves the legacy "all manual-reserve metrics" behaviour.
   */
  metricsFilter?: string[] | null,
): Promise<DigestSummary> {
  const windowStart = now - windowHours * 3_600_000;
  const allowSet =
    metricsFilter && metricsFilter.length > 0
      ? new Set(metricsFilter)
      : null;

  const [samples, dispatches] = await Promise.all([
    getHealthSamplesSince(windowStart),
    listManualReserveAlertDispatches({ sinceTimestamp: windowStart, untilTimestamp: now, limit: 1000 }),
  ]);

  const byMetric = new Map<string, DigestAggregate>();
  let totalWarning = 0;
  let totalCritical = 0;
  let breachSamples = 0;

  for (const sample of samples) {
    const ts = Number(sample.timestamp);
    const rawAlerts = Array.isArray(sample.alerts) ? (sample.alerts as Alert[]) : [];
    let sampleHadBreach = false;
    for (const alert of rawAlerts) {
      if (!alert || typeof alert.metric !== "string") continue;
      if (!isManualReserveMetric(alert.metric)) continue;
      if (allowSet && !allowSet.has(alert.metric)) continue;
      sampleHadBreach = true;
      const value = Number(alert.value) || 0;
      const threshold = Number(alert.threshold) || 0;
      const agg =
        byMetric.get(alert.metric) ??
        ({
          metric: alert.metric,
          warning: 0,
          critical: 0,
          total: 0,
          firstSeenAt: ts,
          lastSeenAt: ts,
          peakValue: value,
          peakThreshold: threshold,
        } satisfies DigestAggregate);
      if (alert.severity === "warning") {
        agg.warning += 1;
        totalWarning += 1;
      } else if (alert.severity === "critical") {
        agg.critical += 1;
        totalCritical += 1;
      }
      agg.total = agg.warning + agg.critical;
      if (ts < agg.firstSeenAt) agg.firstSeenAt = ts;
      if (ts > agg.lastSeenAt) agg.lastSeenAt = ts;
      if (value > agg.peakValue) {
        agg.peakValue = value;
        agg.peakThreshold = threshold;
      }
      byMetric.set(alert.metric, agg);
    }
    if (sampleHadBreach) breachSamples += 1;
  }

  const transitions: DigestSummary["transitions"] = [];
  for (const r of dispatches) {
    if (r.eventType === "backed_up" || r.eventType === "all_clear") {
      // Task #1181 — When a metric allow-list is configured, only keep
      // transitions whose message references at least one allowed metric.
      // The dispatch payload doesn't carry a structured metric column for
      // backed_up/all_clear, so substring-match against the rendered text.
      if (allowSet) {
        const msg = String(r.message ?? "");
        let matches = false;
        for (const m of allowSet) {
          if (msg.includes(m)) { matches = true; break; }
        }
        if (!matches) continue;
      }
      transitions.push({
        at: Number(r.timestamp),
        eventType: r.eventType,
        message: r.message,
      });
    }
  }
  transitions.sort((a, b) => a.at - b.at);

  const perMetric = Array.from(byMetric.values()).sort(
    (a, b) =>
      b.critical - a.critical || b.warning - a.warning || a.metric.localeCompare(b.metric),
  );
  return {
    windowHours,
    windowStart,
    windowEnd: now,
    breachSamples,
    totalAlerts: totalWarning + totalCritical,
    totalWarning,
    totalCritical,
    perMetric,
    transitions: transitions.slice(0, 10),
  };
}

function fmtTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function formatDigestText(
  summary: DigestSummary,
  cadence: ManualReserveDigestCadence,
): string {
  const cadenceLabel = cadence === "weekly" ? "Weekly" : "Daily";
  const lines: string[] = [];
  lines.push(
    `:bar_chart: *${cadenceLabel} reserve-pressure digest* — last ${summary.windowHours}h ` +
      `(${fmtTs(summary.windowStart)} → ${fmtTs(summary.windowEnd)})`,
  );
  if (summary.totalAlerts === 0 && summary.transitions.length === 0) {
    lines.push("No manual-reserve alerts and no backed-up/all-clear transitions in this window. :white_check_mark:");
    return lines.join("\n");
  }
  lines.push(
    `Totals: *${summary.totalAlerts}* breach detection(s) across *${summary.breachSamples}* sampler tick(s) — ${summary.totalCritical} critical, ${summary.totalWarning} warning across ${summary.perMetric.length} metric(s).`,
  );
  lines.push(
    "_Counts include every per-tick breach evaluation (sourced from `health_samples.alerts`), so they reflect real reserve pressure even if Slack delivery was muted, disconnected, or rate-limited by the per-(metric,severity) cooldown._",
  );
  if (summary.perMetric.length > 0) {
    lines.push("*Per metric:*");
    for (const m of summary.perMetric) {
      const peak =
        m.peakValue !== 0 || m.peakThreshold !== 0
          ? ` — peak ${m.peakValue} (thr ${m.peakThreshold})`
          : "";
      lines.push(
        `• \`${m.metric}\` — ${m.critical} critical / ${m.warning} warning${peak} · first ${fmtTs(m.firstSeenAt)} · last ${fmtTs(m.lastSeenAt)}`,
      );
    }
  }
  if (summary.transitions.length > 0) {
    lines.push("*Transitions:*");
    for (const t of summary.transitions) {
      const tag = t.eventType === "backed_up" ? ":small_red_triangle:" : ":small_blue_diamond:";
      lines.push(`• ${tag} ${fmtTs(t.at)} — ${t.message}`);
    }
  }
  lines.push("");
  lines.push("Open the Health Dashboard → *Manual reserve alerts* card for the full timeline.");
  return lines.join("\n");
}

export interface DigestPlan {
  shouldSend: boolean;
  reason: string;
  message?: string;
  summary?: DigestSummary;
  config: ManualReserveDigestConfig;
}

export async function planManualReserveDigest(
  now: number = Date.now(),
  opts?: { ignoreSchedule?: boolean; ignoreLastSent?: boolean },
): Promise<DigestPlan> {
  const config = await getManualReserveDigestConfig();
  if (!config.enabled && !opts?.ignoreSchedule) {
    return { shouldSend: false, reason: "digest disabled", config };
  }
  if (config.snoozedUntil && config.snoozedUntil > now && !opts?.ignoreSchedule) {
    return {
      shouldSend: false,
      reason: `snoozed until ${new Date(config.snoozedUntil).toISOString()}`,
      config,
    };
  }
  if (!opts?.ignoreSchedule) {
    const utcHour = new Date(now).getUTCHours();
    if (utcHour !== config.hourUtc) {
      return {
        shouldSend: false,
        reason: `not at digest hour (target ${config.hourUtc}, now ${utcHour})`,
        config,
      };
    }
    if (config.cadence === "weekly") {
      const utcDay = new Date(now).getUTCDay();
      if (utcDay !== config.weekdayUtc) {
        return {
          shouldSend: false,
          reason: `not at digest weekday (target ${config.weekdayUtc}, now ${utcDay})`,
          config,
        };
      }
    }
  }
  const key = periodKey(config.cadence, now);
  if (!opts?.ignoreLastSent && config.lastSentKey === key) {
    return { shouldSend: false, reason: `already sent for ${key}`, config };
  }

  const summary = await buildDigestSummary(config.windowHours, now, config.metrics);
  const message = formatDigestText(summary, config.cadence);
  return { shouldSend: true, reason: "digest pending", message, summary, config };
}

export interface DigestSendResult {
  sent: boolean;
  reason: string;
  summary?: DigestSummary;
  status?: string;
  channel?: string | null;
}

export async function sendManualReserveDigest(
  opts: {
    now?: number;
    triggerSource?: "scheduled" | "manual" | "test";
    bypassSchedule?: boolean;
  } = {},
): Promise<DigestSendResult> {
  const now = opts.now ?? Date.now();
  const plan = await planManualReserveDigest(now, {
    ignoreSchedule: opts.bypassSchedule === true,
    ignoreLastSent: opts.bypassSchedule === true,
  });
  if (!plan.shouldSend) {
    return { sent: false, reason: plan.reason };
  }
  const { notifyByType } = await import("./notifications/dispatcher");
  const result = await notifyByType(
    NOTIFICATION_ID,
    {
      text: plan.message!,
      preview: {
        windowHours: plan.summary!.windowHours,
        breachSamples: plan.summary!.breachSamples,
        totalAlerts: plan.summary!.totalAlerts,
        totalWarning: plan.summary!.totalWarning,
        totalCritical: plan.summary!.totalCritical,
        metrics: plan.summary!.perMetric.length,
      },
    },
    {
      triggerSource: opts.triggerSource ?? "scheduled",
      bypassDedupe: true,
      metadata: {
        cadence: plan.config.cadence,
        windowHours: plan.summary!.windowHours,
        breachSamples: plan.summary!.breachSamples,
        totalAlerts: plan.summary!.totalAlerts,
        totalCritical: plan.summary!.totalCritical,
        totalWarning: plan.summary!.totalWarning,
      },
    },
  );
  if (result.delivered) {
    if (opts.bypassSchedule !== true || opts.triggerSource === "scheduled") {
      await setSystemSetting(SETTING_LAST_SENT, periodKey(plan.config.cadence, now), "system");
    }
    return {
      sent: true,
      reason: "sent",
      summary: plan.summary,
      status: result.status,
      channel: result.channelId ?? null,
    };
  }
  return {
    sent: false,
    reason: result.skipReason ?? result.error ?? result.status ?? "skipped",
    summary: plan.summary,
    status: result.status,
    channel: result.channelId ?? null,
  };
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await sendManualReserveDigest({ triggerSource: "scheduled" });
      if (r.sent) {
        console.log(
          `[ManualReserveDigest] sent (alerts=${r.summary?.totalAlerts ?? 0} crit=${r.summary?.totalCritical ?? 0} warn=${r.summary?.totalWarning ?? 0})`,
        );
      }
    } catch (err: any) {
      console.warn("[ManualReserveDigest] tick failed:", err?.message || err);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startManualReserveDigestScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution("scheduler:manual-reserve-digest", () => tick());
  }, CHECK_INTERVAL_MS);
  console.log(
    `[ManualReserveDigest] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopManualReserveDigestScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_ID,
  DEFAULTS,
  utcDateKey,
  utcIsoWeekKey,
  periodKey,
};
