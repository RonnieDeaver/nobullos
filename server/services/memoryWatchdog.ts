/**
 * Task #2897 — lightweight memory watchdog for the Reserved VM switch.
 *
 * A Reserved VM process can stay up for weeks, so unbounded in-memory
 * growth that autoscale recycles used to mask becomes a real risk. This
 * watchdog logs process RSS / heap once an hour and fires a Slack alert
 * (via the unified `notifyByType` dispatcher, notification id
 * `infra.memory.high_rss`) when RSS crosses a configurable threshold
 * (default 3072 MB ≈ 75% of the 4 GB tier).
 *
 * Alerting is once-per-breach-streak: the first sample at/above the
 * threshold alerts; further breached samples stay quiet; once RSS drops
 * below the re-arm level (90% of the threshold, hysteresis so a value
 * oscillating right at the threshold can't flap), a single "recovered"
 * follow-up is sent and the alert re-arms.
 *
 * Settings (registered in audits/G-docs-findings.md § 4b):
 *   - `memory_watchdog_enabled`      — kill switch, default ON.
 *   - `memory_watchdog_alert_rss_mb` — alert threshold in MB, default 3072.
 *
 * @cross-instance-safe: idempotent per-process observability — each
 * instance logs and alerts on ITS OWN process RSS (per-process data, so a
 * cluster-wide singleton would be wrong); the once-per-breach-streak latch
 * bounds alert volume to one per instance per breach, safe if multiple
 * instances run during any autoscale interim.
 */
import { getSystemSetting } from "../storage/settingsStorage";
import { withDbAttribution } from "../db";

export const SETTING_ENABLED = "memory_watchdog_enabled";
export const SETTING_ALERT_RSS_MB = "memory_watchdog_alert_rss_mb";

export const NOTIFICATION_ID = "infra.memory.high_rss";

export const DEFAULTS = {
  enabled: true,
  alertRssMb: 3072, // ~75% of the 4 GB Reserved VM tier
};

/** Re-arm when RSS falls below this fraction of the alert threshold. */
export const REARM_FRACTION = 0.9;

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly

export interface MemoryWatchdogConfig {
  enabled: boolean;
  alertRssMb: number;
}

export interface MemorySample {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
}

export type MemoryDecision =
  | "skipped_disabled"
  | "ok"
  | "alerted"
  | "breach_already_alerted"
  | "breach_dispatch_failed"
  | "recovered"
  | "recovered_dispatch_failed"
  | "above_rearm_still_alerted";

export interface MemoryCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  sample: MemorySample;
  thresholdMb: number;
  rearmMb: number;
  decision: MemoryDecision;
  skipReason?: string;
}

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

function parsePositiveInt(raw: string | undefined | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export async function getMemoryWatchdogConfig(): Promise<MemoryWatchdogConfig> {
  const [enabledRow, thresholdRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_ALERT_RSS_MB).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    alertRssMb: parsePositiveInt(thresholdRow?.value, DEFAULTS.alertRssMb),
  };
}

function toMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function realSampleMemory(): MemorySample {
  const m = process.memoryUsage();
  return {
    rssMb: toMb(m.rss),
    heapUsedMb: toMb(m.heapUsed),
    heapTotalMb: toMb(m.heapTotal),
    externalMb: toMb(m.external),
  };
}

let samplerOverride: (() => MemorySample) | null = null;

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: { triggerSource: string; bypassDedupe?: boolean; metadata?: Record<string, unknown> },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;

/** True while a breach streak has already alerted and not yet recovered. */
let alerted = false;

async function dispatchAlert(
  text: string,
  metadata: Record<string, unknown>,
): Promise<{ delivered: boolean; skipReason?: string }> {
  try {
    const notifyByType =
      dispatcherOverride ?? (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        // Breach-streak dedupe is managed here; let the dispatcher fire.
        bypassDedupe: true,
        metadata,
      },
    );
    return {
      delivered: r.delivered,
      skipReason: r.delivered ? undefined : (r.skipReason ?? r.status),
    };
  } catch (err: any) {
    console.error(`[MemoryWatchdog] dispatch failed: ${err?.message}`);
    return { delivered: false, skipReason: `dispatch_error:${err?.message ?? "unknown"}` };
  }
}

function buildBreachText(sample: MemorySample, thresholdMb: number): string {
  return [
    `:rotating_light: *High memory usage* — process RSS *${sample.rssMb} MB* ≥ threshold ${thresholdMb} MB`,
    `• Heap used ${sample.heapUsedMb} MB / total ${sample.heapTotalMb} MB, external ${sample.externalMb} MB`,
    `• Reserved VM tier is 4096 MB — investigate in-memory cache growth (see WORKERS_QUEUES_RUNBOOK.md § In-memory cache & buffer bounds) or plan a restart.`,
    `• Tune via system_settings \`${SETTING_ALERT_RSS_MB}\`; disable via \`${SETTING_ENABLED}\`.`,
  ].join("\n");
}

function buildRecoveredText(sample: MemorySample, thresholdMb: number, rearmMb: number): string {
  return [
    `:white_check_mark: *Memory recovered* — process RSS *${sample.rssMb} MB* back below re-arm level ${rearmMb} MB (threshold ${thresholdMb} MB)`,
    `• Heap used ${sample.heapUsedMb} MB / total ${sample.heapTotalMb} MB`,
  ].join("\n");
}

/**
 * Run one watchdog evaluation: sample memory, log it, and apply the
 * alert-once / re-arm state machine. Exported for the regression test.
 */
export async function checkMemoryOnce(now: number = Date.now()): Promise<MemoryCheckResult> {
  const config = await getMemoryWatchdogConfig();
  const sample = samplerOverride ? samplerOverride() : realSampleMemory();
  const thresholdMb = config.alertRssMb;
  const rearmMb = Math.round(thresholdMb * REARM_FRACTION);

  const base: Omit<MemoryCheckResult, "decision"> = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    sample,
    thresholdMb,
    rearmMb,
  };

  console.log(
    `[MemoryWatchdog] rss=${sample.rssMb}MB heapUsed=${sample.heapUsedMb}MB heapTotal=${sample.heapTotalMb}MB external=${sample.externalMb}MB threshold=${thresholdMb}MB alerted=${alerted}`,
  );

  if (!config.enabled) {
    return { ...base, decision: "skipped_disabled", skipReason: "watchdog disabled in system_settings" };
  }

  if (sample.rssMb >= thresholdMb) {
    if (alerted) {
      return { ...base, decision: "breach_already_alerted" };
    }
    const r = await dispatchAlert(buildBreachText(sample, thresholdMb), {
      event: "breach",
      rssMb: sample.rssMb,
      heapUsedMb: sample.heapUsedMb,
      thresholdMb,
    });
    if (r.delivered) {
      alerted = true;
      return { ...base, decision: "alerted" };
    }
    // Leave un-latched so the next hourly tick retries the alert.
    return { ...base, decision: "breach_dispatch_failed", skipReason: r.skipReason };
  }

  // Below threshold.
  if (!alerted) {
    return { ...base, decision: "ok" };
  }
  if (sample.rssMb >= rearmMb) {
    // Hysteresis band: below the threshold but not yet below the re-arm
    // level — stay latched so an RSS oscillating at the threshold can't
    // fire an alert per hour.
    return { ...base, decision: "above_rearm_still_alerted" };
  }
  const r = await dispatchAlert(buildRecoveredText(sample, thresholdMb, rearmMb), {
    event: "recovered",
    rssMb: sample.rssMb,
    thresholdMb,
    rearmMb,
  });
  if (r.delivered) {
    alerted = false;
    return { ...base, decision: "recovered" };
  }
  // Keep latched so the resolve is retried next tick.
  return { ...base, decision: "recovered_dispatch_failed", skipReason: r.skipReason };
}

let interval: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      await checkMemoryOnce();
    } catch (err: any) {
      console.warn(`[MemoryWatchdog] tick failed: ${err?.message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startMemoryWatchdog(): void {
  if (interval) return;
  // First sample shortly after start so boot RSS lands in the logs, then hourly.
  void withDbAttribution("scheduler:memory-watchdog", () => tick());
  interval = setInterval(() => {
    void withDbAttribution("scheduler:memory-watchdog", () => tick());
  }, CHECK_INTERVAL_MS);
  console.log(`[MemoryWatchdog] started (sample every ${CHECK_INTERVAL_MS / 60000} min)`);
}

export function stopMemoryWatchdog(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  resetStateForTests(): void {
    alerted = false;
  },
  isAlerted(): boolean {
    return alerted;
  },
  setSamplerForTests(fn: (() => MemorySample) | null): void {
    samplerOverride = fn;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
};
