// @cross-instance-safe: persists tuning via idempotent UPSERT to system_settings; in-memory limiter state is per-instance by design.
import {
  getLimiterConfigs,
  getEventsForCategory,
  getRequestCounts,
  updateLimiterConfig,
  type RateLimitEvent,
} from "./rateLimitMonitor";
import { withDbAttribution } from "../db";

export interface TuningSuggestion {
  category: string;
  currentMax: number;
  suggestedMax: number;
  direction: "increase" | "decrease" | "no_change";
  reason: string;
  confidence: "low" | "medium" | "high";
  metrics: {
    totalBlocked: number;
    uniqueIPs: number;
    blockRate: number;
    totalRequests: number;
    observationMinutes: number;
  };
}

export interface AutoTuneConfig {
  enabled: boolean;
  minObservationMinutes: number;
  maxIncreasePct: number;
  maxDecreasePct: number;
  floorLimits: Record<string, number>;
  ceilingLimits: Record<string, number>;
  blockRateThresholdHigh: number;
  blockRateThresholdLow: number;
  ipDiversityThreshold: number;
  intervalMinutes: number;
}

const DEFAULT_FLOOR_LIMITS: Record<string, number> = {
  api: 50,
  auth: 5,
  ai: 5,
  write: 15,
  upload: 5,
  admin: 10,
  sensitiveWrite: 5,
  webhook: 100,
};

const DEFAULT_CEILING_LIMITS: Record<string, number> = {
  api: 1000,
  auth: 30,
  ai: 100,
  write: 300,
  upload: 100,
  admin: 150,
  sensitiveWrite: 50,
  webhook: 1500,
};

let autoTuneConfig: AutoTuneConfig = {
  enabled: false,
  minObservationMinutes: 30,
  maxIncreasePct: 50,
  maxDecreasePct: 25,
  floorLimits: { ...DEFAULT_FLOOR_LIMITS },
  ceilingLimits: { ...DEFAULT_CEILING_LIMITS },
  blockRateThresholdHigh: 0.05,
  blockRateThresholdLow: 0.001,
  ipDiversityThreshold: 0.5,
  intervalMinutes: 60,
};

interface AppliedAdjustment {
  category: string;
  previousMax: number;
  newMax: number;
  reason: string;
  appliedAt: number;
  appliedBy: string;
}

const appliedAdjustments: AppliedAdjustment[] = [];

const AUTO_TUNE_CONFIG_KEY = "rate_limit_auto_tune_config";
const AUTO_TUNE_HISTORY_KEY = "rate_limit_auto_tune_history";
const AUTO_TUNE_OVERRIDES_KEY = "rate_limit_auto_tune_overrides";
const MAX_HISTORY = 100;

let persistenceLoaded = false;

function persistConfig(): void {
  void (async () => {
    try {
      const { setSystemSetting } = await import("../storage/settingsStorage");
      await setSystemSetting(AUTO_TUNE_CONFIG_KEY, JSON.stringify(autoTuneConfig));
    } catch (err) {
      console.warn("[AutoTuner] Failed to persist config:", err);
    }
  })();
}

function persistHistory(): void {
  void (async () => {
    try {
      const { setSystemSetting } = await import("../storage/settingsStorage");
      await setSystemSetting(AUTO_TUNE_HISTORY_KEY, JSON.stringify(appliedAdjustments));
    } catch (err) {
      console.warn("[AutoTuner] Failed to persist adjustment history:", err);
    }
  })();
}

function persistOverrides(): void {
  void (async () => {
    try {
      const { setSystemSetting } = await import("../storage/settingsStorage");
      const overrides: Record<string, number> = {};
      for (const [cat, cfg] of getLimiterConfigs().entries()) {
        overrides[cat] = cfg.max;
      }
      await setSystemSetting(AUTO_TUNE_OVERRIDES_KEY, JSON.stringify(overrides));
    } catch (err) {
      console.warn("[AutoTuner] Failed to persist limiter overrides:", err);
    }
  })();
}

export async function loadAutoTunePersistedState(): Promise<void> {
  if (persistenceLoaded) return;
  type Setting = { value: string | null } | undefined;
  let configSetting: Setting, historySetting: Setting, overridesSetting: Setting;
  try {
    const { getSystemSetting } = await import("../storage/settingsStorage");
    [configSetting, historySetting, overridesSetting] = await Promise.all([
      getSystemSetting(AUTO_TUNE_CONFIG_KEY),
      getSystemSetting(AUTO_TUNE_HISTORY_KEY),
      getSystemSetting(AUTO_TUNE_OVERRIDES_KEY),
    ]);
  } catch (err) {
    console.warn("[AutoTuner] Failed to read persisted state, will retry on next call:", err);
    return;
  }
  persistenceLoaded = true;
  try {

    if (configSetting?.value) {
      try {
        const parsed = JSON.parse(configSetting.value);
        if (parsed && typeof parsed === "object") {
          autoTuneConfig = {
            ...autoTuneConfig,
            ...parsed,
            floorLimits: { ...DEFAULT_FLOOR_LIMITS, ...(parsed.floorLimits ?? {}) },
            ceilingLimits: { ...DEFAULT_CEILING_LIMITS, ...(parsed.ceilingLimits ?? {}) },
          };
          console.log("[AutoTuner] Loaded persisted auto-tune config from database");
        }
      } catch (err) {
        console.warn("[AutoTuner] Invalid persisted config, using defaults:", err);
      }
    }

    if (historySetting?.value) {
      try {
        const parsed = JSON.parse(historySetting.value);
        if (Array.isArray(parsed)) {
          const sliced = parsed.slice(-MAX_HISTORY) as AppliedAdjustment[];
          appliedAdjustments.splice(0, appliedAdjustments.length, ...sliced);
          console.log(`[AutoTuner] Loaded ${appliedAdjustments.length} persisted adjustment history entries`);
        }
      } catch (err) {
        console.warn("[AutoTuner] Invalid persisted adjustment history, ignoring:", err);
      }
    }

    if (overridesSetting?.value) {
      try {
        const parsed = JSON.parse(overridesSetting.value);
        if (parsed && typeof parsed === "object") {
          const configs = getLimiterConfigs();
          let restored = 0;
          for (const [cat, max] of Object.entries(parsed)) {
            if (typeof max === "number" && max > 0 && configs.has(cat)) {
              updateLimiterConfig(cat, max);
              restored++;
            }
          }
          if (restored > 0) {
            console.log(`[AutoTuner] Restored ${restored} previously applied rate limit override(s)`);
          }
        }
      } catch (err) {
        console.warn("[AutoTuner] Invalid persisted limiter overrides, ignoring:", err);
      }
    }
  } catch (err) {
    console.warn("[AutoTuner] Failed to load persisted state:", err);
  }
}

export function getAutoTuneConfig(): AutoTuneConfig {
  return { ...autoTuneConfig };
}

export function updateAutoTuneConfig(updates: Partial<AutoTuneConfig>): AutoTuneConfig {
  if (updates.enabled !== undefined) autoTuneConfig.enabled = updates.enabled;
  if (updates.minObservationMinutes !== undefined && updates.minObservationMinutes >= 5) {
    autoTuneConfig.minObservationMinutes = updates.minObservationMinutes;
  }
  if (updates.maxIncreasePct !== undefined && updates.maxIncreasePct > 0 && updates.maxIncreasePct <= 100) {
    autoTuneConfig.maxIncreasePct = updates.maxIncreasePct;
  }
  if (updates.maxDecreasePct !== undefined && updates.maxDecreasePct > 0 && updates.maxDecreasePct <= 100) {
    autoTuneConfig.maxDecreasePct = updates.maxDecreasePct;
  }
  if (updates.blockRateThresholdHigh !== undefined && updates.blockRateThresholdHigh > 0) {
    autoTuneConfig.blockRateThresholdHigh = updates.blockRateThresholdHigh;
  }
  if (updates.blockRateThresholdLow !== undefined && updates.blockRateThresholdLow >= 0) {
    autoTuneConfig.blockRateThresholdLow = updates.blockRateThresholdLow;
  }
  if (updates.ipDiversityThreshold !== undefined && updates.ipDiversityThreshold > 0 && updates.ipDiversityThreshold <= 1) {
    autoTuneConfig.ipDiversityThreshold = updates.ipDiversityThreshold;
  }
  if (updates.intervalMinutes !== undefined && updates.intervalMinutes >= 5 && updates.intervalMinutes <= 1440) {
    const previous = autoTuneConfig.intervalMinutes;
    autoTuneConfig.intervalMinutes = updates.intervalMinutes;
    if (autoTuneSchedulerTimer !== null && previous !== updates.intervalMinutes) {
      restartAutoTuneScheduler();
    }
  }
  if (updates.floorLimits) {
    autoTuneConfig.floorLimits = { ...autoTuneConfig.floorLimits, ...updates.floorLimits };
  }
  if (updates.ceilingLimits) {
    autoTuneConfig.ceilingLimits = { ...autoTuneConfig.ceilingLimits, ...updates.ceilingLimits };
  }
  persistConfig();
  return { ...autoTuneConfig };
}

function analyzeCategoryTraffic(category: string): TuningSuggestion {
  const configs = getLimiterConfigs();
  const config = configs.get(category);
  const currentMax = config?.max ?? 0;
  const windowMs = config?.windowMs ?? 0;

  const events = getEventsForCategory(category);
  const requestCountData = getRequestCounts().get(category);
  const totalRequests = requestCountData?.total ?? 0;
  const firstSeen = requestCountData?.firstSeen ?? Date.now();

  const observationMs = Date.now() - firstSeen;
  const observationMinutes = observationMs / 60000;

  const totalBlocked = events.length;

  const uniqueIPs = new Set(events.map(e => e.ip)).size;

  const blockRate = totalRequests > 0 ? totalBlocked / totalRequests : 0;

  const metrics = {
    totalBlocked,
    uniqueIPs,
    blockRate,
    totalRequests,
    observationMinutes: Math.round(observationMinutes * 10) / 10,
  };

  if (observationMinutes < autoTuneConfig.minObservationMinutes) {
    return {
      category,
      currentMax,
      suggestedMax: currentMax,
      direction: "no_change",
      reason: `Insufficient observation time (${metrics.observationMinutes}min < ${autoTuneConfig.minObservationMinutes}min required)`,
      confidence: "low",
      metrics,
    };
  }

  if (totalBlocked === 0 && totalRequests === 0) {
    return {
      category,
      currentMax,
      suggestedMax: currentMax,
      direction: "no_change",
      reason: "No traffic observed in this category",
      confidence: "low",
      metrics,
    };
  }

  if (totalBlocked === 0) {
    return {
      category,
      currentMax,
      suggestedMax: currentMax,
      direction: "no_change",
      reason: "No blocks recorded — current limit appears adequate",
      confidence: "medium",
      metrics,
    };
  }

  const ipDiversity = totalBlocked > 0 ? uniqueIPs / totalBlocked : 0;
  const isHighDiversity = ipDiversity >= autoTuneConfig.ipDiversityThreshold;

  if (blockRate >= autoTuneConfig.blockRateThresholdHigh && isHighDiversity) {
    const increasePct = Math.min(
      autoTuneConfig.maxIncreasePct / 100,
      blockRate * 2
    );
    const rawSuggested = Math.ceil(currentMax * (1 + increasePct));
    const ceiling = autoTuneConfig.ceilingLimits[category] ?? currentMax * 3;
    const suggestedMax = Math.min(rawSuggested, ceiling);

    return {
      category,
      currentMax,
      suggestedMax,
      direction: suggestedMax > currentMax ? "increase" : "no_change",
      reason: `High block rate (${(blockRate * 100).toFixed(1)}%) across ${uniqueIPs} unique IPs suggests legitimate traffic is being throttled`,
      confidence: "high",
      metrics,
    };
  }

  if (blockRate >= autoTuneConfig.blockRateThresholdHigh && !isHighDiversity) {
    const decreasePct = Math.min(autoTuneConfig.maxDecreasePct / 100, 0.15);
    const rawSuggested = Math.floor(currentMax * (1 - decreasePct));
    const floor = autoTuneConfig.floorLimits[category] ?? Math.ceil(currentMax * 0.25);
    const suggestedMax = Math.max(rawSuggested, floor);

    return {
      category,
      currentMax,
      suggestedMax,
      direction: suggestedMax < currentMax ? "decrease" : "no_change",
      reason: `High block rate (${(blockRate * 100).toFixed(1)}%) concentrated on ${uniqueIPs} IP(s) — likely abuse; consider lowering threshold`,
      confidence: "medium",
      metrics,
    };
  }

  if (blockRate >= autoTuneConfig.blockRateThresholdLow && isHighDiversity) {
    const increasePct = Math.min(autoTuneConfig.maxIncreasePct / 100, 0.20);
    const rawSuggested = Math.ceil(currentMax * (1 + increasePct));
    const ceiling = autoTuneConfig.ceilingLimits[category] ?? currentMax * 3;
    const suggestedMax = Math.min(rawSuggested, ceiling);

    return {
      category,
      currentMax,
      suggestedMax,
      direction: suggestedMax > currentMax ? "increase" : "no_change",
      reason: `Moderate block rate (${(blockRate * 100).toFixed(1)}%) with diverse IPs — a small increase may reduce false positives`,
      confidence: "medium",
      metrics,
    };
  }

  return {
    category,
    currentMax,
    suggestedMax: currentMax,
    direction: "no_change",
    reason: `Traffic patterns are within normal bounds (block rate: ${(blockRate * 100).toFixed(2)}%)`,
    confidence: "medium",
    metrics,
  };
}

export function getTuningSuggestions(): {
  suggestions: TuningSuggestion[];
  config: AutoTuneConfig;
  adjustmentHistory: typeof appliedAdjustments;
} {
  const configs = getLimiterConfigs();
  const suggestions: TuningSuggestion[] = [];

  for (const [category, cfg] of configs.entries()) {
    if (cfg.exempt) continue;
    // Task #2883: tuner-read-only buckets (e.g. background_polling) enforce a
    // real limit but are non-interactive safety nets — their steady polling
    // traffic would mislead the interactive tuning heuristics, so the tuner
    // never suggests for them.
    if (cfg.tunerReadOnly) continue;
    suggestions.push(analyzeCategoryTraffic(category));
  }

  suggestions.sort((a, b) => {
    const directionOrder = { increase: 0, decrease: 1, no_change: 2 };
    return directionOrder[a.direction] - directionOrder[b.direction];
  });

  return {
    suggestions,
    config: { ...autoTuneConfig },
    adjustmentHistory: [...appliedAdjustments],
  };
}

export function applySuggestion(
  category: string,
  newMax: number,
  appliedBy: string
): { success: boolean; error?: string; previousMax?: number; newMax?: number } {
  const configs = getLimiterConfigs();
  const config = configs.get(category);
  if (!config) {
    return { success: false, error: `Unknown rate limit category: ${category}` };
  }
  if (config.exempt) {
    return { success: false, error: `Category ${category} is exempt from rate limiting and cannot be tuned` };
  }
  if (config.tunerReadOnly) {
    return { success: false, error: `Category ${category} is read-only for the auto-tuner (non-interactive safety-net bucket) and cannot be tuned` };
  }

  const floor = autoTuneConfig.floorLimits[category] ?? 1;
  const ceiling = autoTuneConfig.ceilingLimits[category] ?? config.max * 5;

  if (newMax < floor) {
    return { success: false, error: `Suggested max ${newMax} is below floor limit ${floor} for category ${category}` };
  }
  if (newMax > ceiling) {
    return { success: false, error: `Suggested max ${newMax} exceeds ceiling limit ${ceiling} for category ${category}` };
  }

  const previousMax = config.max;
  updateLimiterConfig(category, newMax);

  appliedAdjustments.push({
    category,
    previousMax,
    newMax,
    reason: `Manual adjustment by ${appliedBy}`,
    appliedAt: Date.now(),
    appliedBy,
  });

  if (appliedAdjustments.length > MAX_HISTORY) {
    appliedAdjustments.splice(0, appliedAdjustments.length - MAX_HISTORY);
  }

  console.log(`[AutoTuner] Applied rate limit adjustment: ${category} ${previousMax} → ${newMax} (by ${appliedBy})`);

  persistHistory();
  persistOverrides();

  return { success: true, previousMax, newMax };
}

export function runAutoTune(): {
  applied: Array<{ category: string; previousMax: number; newMax: number; reason: string }>;
  skipped: Array<{ category: string; reason: string }>;
} {
  if (!autoTuneConfig.enabled) {
    return { applied: [], skipped: [{ category: "*", reason: "Auto-tune is disabled" }] };
  }

  const { suggestions } = getTuningSuggestions();
  const applied: Array<{ category: string; previousMax: number; newMax: number; reason: string }> = [];
  const skipped: Array<{ category: string; reason: string }> = [];

  for (const suggestion of suggestions) {
    if (suggestion.direction === "no_change") {
      skipped.push({ category: suggestion.category, reason: suggestion.reason });
      continue;
    }

    if (suggestion.confidence === "low") {
      skipped.push({ category: suggestion.category, reason: `Low confidence: ${suggestion.reason}` });
      continue;
    }

    const result = applySuggestion(suggestion.category, suggestion.suggestedMax, "auto-tune");
    if (result.success) {
      applied.push({
        category: suggestion.category,
        previousMax: result.previousMax!,
        newMax: result.newMax!,
        reason: suggestion.reason,
      });
    } else {
      skipped.push({ category: suggestion.category, reason: result.error! });
    }
  }

  if (applied.length > 0) {
    console.log(`[AutoTuner] Auto-tune cycle complete: ${applied.length} adjusted, ${skipped.length} skipped`);
  }

  return { applied, skipped };
}

export function getAdjustmentHistory() {
  return [...appliedAdjustments];
}

let autoTuneSchedulerTimer: ReturnType<typeof setInterval> | null = null;
let autoTuneCycleInFlight = false;

function executeScheduledCycle(): Promise<void> {
  if (autoTuneCycleInFlight) {
    console.log("[AutoTuner] Skipping scheduled cycle — previous cycle still in flight");
    return Promise.resolve();
  }
  if (!autoTuneConfig.enabled) {
    return Promise.resolve();
  }
  autoTuneCycleInFlight = true;
  try {
    const result = runAutoTune();
    if (result.applied.length > 0 || result.skipped.length > 0) {
      console.log(
        `[AutoTuner] Scheduled cycle complete: ${result.applied.length} applied, ${result.skipped.length} skipped`,
      );
    }
  } catch (err: any) {
    console.error("[AutoTuner] Scheduled cycle failed:", err?.message ?? err);
  } finally {
    autoTuneCycleInFlight = false;
  }
  return Promise.resolve();
}

export function startAutoTuneScheduler(): void {
  if (autoTuneSchedulerTimer !== null) return;
  const intervalMs = Math.max(5, autoTuneConfig.intervalMinutes) * 60_000;
  console.log(
    `[AutoTuner] Starting auto-tune scheduler (every ${autoTuneConfig.intervalMinutes}min, enabled=${autoTuneConfig.enabled})`,
  );
  autoTuneSchedulerTimer = setInterval(() => {
    void withDbAttribution("scheduler:rate-limit-autotuner", () => executeScheduledCycle());
  }, intervalMs);
  if (typeof autoTuneSchedulerTimer.unref === "function") {
    autoTuneSchedulerTimer.unref();
  }
}

export function stopAutoTuneScheduler(): void {
  if (autoTuneSchedulerTimer !== null) {
    clearInterval(autoTuneSchedulerTimer);
    autoTuneSchedulerTimer = null;
    console.log("[AutoTuner] Auto-tune scheduler stopped");
  }
}

export function restartAutoTuneScheduler(): void {
  stopAutoTuneScheduler();
  startAutoTuneScheduler();
}

export function isAutoTuneSchedulerRunning(): boolean {
  return autoTuneSchedulerTimer !== null;
}
