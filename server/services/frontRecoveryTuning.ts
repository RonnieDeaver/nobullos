/**
 * Task #1730 — Pool Epic Phase 3: Front recovery throughput tuning.
 *
 * Centralises the four live-tunable knobs that Phase 3 (3.1 – 3.4)
 * introduces so that the Front Historical Recovery worker can be
 * tightened or loosened from `system_settings` without a redeploy:
 *
 *   3.1 — `backoffForApiPoolPressure`-style threshold + hysteresis used
 *         by the recovery inter-page sleep, with separate trigger /
 *         clear / required-samples knobs.
 *   3.2 — Per-page penalty applied after pg-pool saturation, with a
 *         "require N consecutive saturated signals before penalty"
 *         guard so a single blip no longer slows the whole window.
 *   3.3 — Reduced inter-page delay when the Phase 0 kill switch
 *         `front_recovery_pool_threshold_tuning_enabled` is on
 *         (default drops from 500ms → 200ms; legacy 500ms preserved
 *         when the switch is off so rollback is a single setting flip).
 *   3.4 — Front recovery ingest concurrency, live-tunable so operators
 *         can ramp 1 → 2 → 3 with explicit observation windows.
 *
 * The module is read-mostly, fails open to the documented defaults
 * (and emits a single warn line per load failure), and caches each
 * settings batch for `CACHE_TTL_MS` so the recovery loop's per-page
 * lookups stay cheap even on long windows.
 */
import { PERF } from "../perfConfig";
import { storage } from "../storage";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";

export const FRONT_RECOVERY_TUNING_SETTING_NAMES = [
  "front_recovery_api_pool_backoff_threshold_percent",
  "front_recovery_api_pool_backoff_clear_percent",
  "front_recovery_api_pool_backoff_required_samples",
  "front_recovery_db_saturated_page_delay_ms",
  "front_recovery_db_saturated_required_signals",
  "front_recovery_page_delay_ms",
  "front_recovery_ingest_concurrency",
] as const;

export type FrontRecoveryTuningSettingName =
  (typeof FRONT_RECOVERY_TUNING_SETTING_NAMES)[number];

interface TuningDefaults {
  apiPoolBackoffThresholdPercent: number;
  apiPoolBackoffClearPercent: number;
  apiPoolBackoffRequiredSamples: number;
  dbSaturatedPageDelayMs: number;
  dbSaturatedRequiredSignals: number;
  pageDelayMs: number;
  ingestConcurrency: number;
}

// "Tuned" defaults applied when the Phase 0 kill switch
// `front_recovery_pool_threshold_tuning_enabled` is ON. These are the
// values Phase 3 ships once Phase 1+2 verification passes.
const TUNED_DEFAULTS: TuningDefaults = {
  apiPoolBackoffThresholdPercent: 90,
  apiPoolBackoffClearPercent: 80,
  apiPoolBackoffRequiredSamples: 2,
  dbSaturatedPageDelayMs: 2000,
  dbSaturatedRequiredSignals: 2,
  // 3.3 — toward 150-200ms; we pick 200ms as the conservative end of
  // the spec range.
  pageDelayMs: 200,
  // 3.4 — concurrency stays at 1 by default; operator ramps via
  // setting (1 → 2 → 3).
  ingestConcurrency: 1,
};

// Legacy defaults applied when the kill switch is OFF. Preserves the
// pre-Phase 3 behaviour exactly so a single settings flip rolls back.
function legacyDefaults(): TuningDefaults {
  return {
    // Legacy isApiPoolUnderPressure() uses PERF.DB_POOL_UTIL_WARN_PCT
    // (default 80) with no hysteresis and no consecutive-sample
    // requirement. Match that here.
    apiPoolBackoffThresholdPercent: PERF.DB_POOL_UTIL_WARN_PCT,
    apiPoolBackoffClearPercent: PERF.DB_POOL_UTIL_WARN_PCT,
    apiPoolBackoffRequiredSamples: 1,
    dbSaturatedPageDelayMs: PERF.FRONT_RECOVERY_PAGE_DELAY_SATURATED_MS,
    // Legacy behaviour: a single saturated signal trips the longer
    // delay for the rest of the window (sticky).
    dbSaturatedRequiredSignals: 1,
    pageDelayMs: PERF.FRONT_RECOVERY_PAGE_DELAY_MS,
    ingestConcurrency: PERF.FRONT_RECOVERY_INGEST_CONCURRENCY,
  };
}

interface CachedValues {
  threshold: number | null;
  clear: number | null;
  requiredSamples: number | null;
  dbSatDelay: number | null;
  dbSatRequired: number | null;
  pageDelay: number | null;
  ingestConcurrency: number | null;
}

const EMPTY_CACHE: CachedValues = {
  threshold: null,
  clear: null,
  requiredSamples: null,
  dbSatDelay: null,
  dbSatRequired: null,
  pageDelay: null,
  ingestConcurrency: null,
};

let cache: CachedValues = { ...EMPTY_CACHE };
let cachedAt = 0;
let loadingPromise: Promise<void> | null = null;
const CACHE_TTL_MS = 30_000;

function parseInt(raw: string | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

async function loadCache(): Promise<void> {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      const rows = await storage.getSystemSettings([
        ...FRONT_RECOVERY_TUNING_SETTING_NAMES,
      ]);
      cache = {
        threshold: parseInt(rows.front_recovery_api_pool_backoff_threshold_percent),
        clear: parseInt(rows.front_recovery_api_pool_backoff_clear_percent),
        requiredSamples: parseInt(rows.front_recovery_api_pool_backoff_required_samples),
        dbSatDelay: parseInt(rows.front_recovery_db_saturated_page_delay_ms),
        dbSatRequired: parseInt(rows.front_recovery_db_saturated_required_signals),
        pageDelay: parseInt(rows.front_recovery_page_delay_ms),
        ingestConcurrency: parseInt(rows.front_recovery_ingest_concurrency),
      };
      cachedAt = Date.now();
    } catch (err: any) {
      // Fail open: keep whatever cache we had, log once per refresh
      // attempt. Defaults still resolve via `effective*()` getters.
      console.warn(
        "[FrontRecoveryTuning] Failed to load tuning settings (using defaults):",
        err?.message ?? err,
      );
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

function maybeBackgroundRefresh(): void {
  if (loadingPromise) return;
  if (cachedAt === 0 || Date.now() - cachedAt >= CACHE_TTL_MS) {
    void loadCache();
  }
}

function defaults(): TuningDefaults {
  return isPoolEpicSwitchEnabled("front_recovery_pool_threshold_tuning_enabled")
    ? TUNED_DEFAULTS
    : legacyDefaults();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface FrontRecoveryTuningSnapshot {
  apiPoolBackoffThresholdPercent: number;
  apiPoolBackoffClearPercent: number;
  apiPoolBackoffRequiredSamples: number;
  dbSaturatedPageDelayMs: number;
  dbSaturatedRequiredSignals: number;
  pageDelayMs: number;
  ingestConcurrency: number;
  tuningEnabled: boolean;
}

/**
 * Resolve every Phase 3 knob in one call. Cheap — driven entirely by
 * the cached settings map, refreshed in the background.
 */
export function getFrontRecoveryTuning(): FrontRecoveryTuningSnapshot {
  maybeBackgroundRefresh();
  const def = defaults();
  // 3.1 — threshold ≥ clear, both in [1,100], samples ≥ 1.
  const threshold = clamp(cache.threshold ?? def.apiPoolBackoffThresholdPercent, 1, 100);
  const clearRaw = clamp(cache.clear ?? def.apiPoolBackoffClearPercent, 1, 100);
  const clear = Math.min(clearRaw, threshold);
  const requiredSamples = clamp(
    cache.requiredSamples ?? def.apiPoolBackoffRequiredSamples,
    1,
    100,
  );
  // 3.2 — saturation knobs.
  const dbSaturatedPageDelayMs = clamp(
    cache.dbSatDelay ?? def.dbSaturatedPageDelayMs,
    0,
    60_000,
  );
  const dbSaturatedRequiredSignals = clamp(
    cache.dbSatRequired ?? def.dbSaturatedRequiredSignals,
    1,
    100,
  );
  // 3.3 — base inter-page delay (always tunable; default depends on
  // the kill switch).
  const pageDelayMs = clamp(cache.pageDelay ?? def.pageDelayMs, 0, 60_000);
  // 3.4 — bounded just like the env knob in perfConfig.
  const ingestConcurrency = clamp(
    cache.ingestConcurrency ?? def.ingestConcurrency,
    1,
    5,
  );
  return {
    apiPoolBackoffThresholdPercent: threshold,
    apiPoolBackoffClearPercent: clear,
    apiPoolBackoffRequiredSamples: requiredSamples,
    dbSaturatedPageDelayMs,
    dbSaturatedRequiredSignals,
    pageDelayMs,
    ingestConcurrency,
    tuningEnabled: isPoolEpicSwitchEnabled(
      "front_recovery_pool_threshold_tuning_enabled",
    ),
  };
}

/**
 * Hysteresis state machine for the API-pool-pressure check that the
 * recovery loop runs between pages (3.1).
 *
 * Behaviour:
 *   - Starts in `clear` state.
 *   - In `clear`, requires `requiredSamples` consecutive readings at
 *     >= threshold% before flipping to `pressured`.
 *   - In `pressured`, stays pressured until a reading drops to <=
 *     clear% — at which point a single clean reading flips it back to
 *     `clear` (one-sided hysteresis: slow to engage, immediate to
 *     release once the pool genuinely recovers).
 *
 * Per-instance state so each recovery window gets its own machine —
 * we do not want a long-running window's history to bleed into a
 * sibling window's first page.
 */
export interface ApiPoolPressureHysteresisState {
  pressured: boolean;
  consecutiveHighSamples: number;
}

export function createApiPoolPressureHysteresis(): ApiPoolPressureHysteresisState {
  return { pressured: false, consecutiveHighSamples: 0 };
}

export interface PressureSample {
  utilizationPct: number;
  waitingCount: number;
}

export interface PressureDecision {
  pressured: boolean;
  // True only on the tick that flipped the state, so callers can log
  // sparingly without flooding when the recovery loop polls every page.
  changed: boolean;
  reason: string;
}

export function evaluateApiPoolPressureWithHysteresis(
  state: ApiPoolPressureHysteresisState,
  sample: PressureSample,
  tuning: FrontRecoveryTuningSnapshot = getFrontRecoveryTuning(),
): PressureDecision {
  const wasPressured = state.pressured;
  const high = sample.utilizationPct >= tuning.apiPoolBackoffThresholdPercent;
  const cleared = sample.utilizationPct <= tuning.apiPoolBackoffClearPercent;
  // Waiters are an unambiguous signal of contention — treat any
  // waiter as immediately satisfying the "required samples" gate so
  // we don't let real backpressure leak through hysteresis.
  const waitersTrip = sample.waitingCount > 0;

  if (!state.pressured) {
    if (high || waitersTrip) {
      state.consecutiveHighSamples += 1;
    } else {
      state.consecutiveHighSamples = 0;
    }
    if (
      waitersTrip ||
      state.consecutiveHighSamples >= tuning.apiPoolBackoffRequiredSamples
    ) {
      state.pressured = true;
      state.consecutiveHighSamples = 0;
      return {
        pressured: true,
        changed: !wasPressured,
        reason: waitersTrip
          ? `waiters>=1 (util=${sample.utilizationPct}%)`
          : `util>=${tuning.apiPoolBackoffThresholdPercent}% x${tuning.apiPoolBackoffRequiredSamples} samples (util=${sample.utilizationPct}%)`,
      };
    }
    return {
      pressured: false,
      changed: false,
      reason: `util=${sample.utilizationPct}% below trigger ${tuning.apiPoolBackoffThresholdPercent}% (samples=${state.consecutiveHighSamples}/${tuning.apiPoolBackoffRequiredSamples})`,
    };
  }

  // Already pressured — stay pressured until the pool clears.
  if (cleared && sample.waitingCount === 0) {
    state.pressured = false;
    state.consecutiveHighSamples = 0;
    return {
      pressured: false,
      changed: true,
      reason: `util=${sample.utilizationPct}% at/below clear ${tuning.apiPoolBackoffClearPercent}%`,
    };
  }
  return {
    pressured: true,
    changed: false,
    reason: `still pressured (util=${sample.utilizationPct}%, waiting=${sample.waitingCount}, clear=${tuning.apiPoolBackoffClearPercent}%)`,
  };
}

/**
 * Test seam: drop the cache so unit tests can stage a fresh load
 * without restarting the module.
 */
export function __resetFrontRecoveryTuningCacheForTest(): void {
  cache = { ...EMPTY_CACHE };
  cachedAt = 0;
  loadingPromise = null;
}

/**
 * Test seam: install a pre-baked cache and freeze the TTL so tests
 * don't race against the background refresh.
 */
export function __setFrontRecoveryTuningCacheForTest(
  partial: Partial<CachedValues>,
): void {
  cache = { ...cache, ...partial };
  cachedAt = Date.now();
}
