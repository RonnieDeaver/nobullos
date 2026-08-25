/**
 * Live-tunable thresholds for `isApiPoolUnderPressure()` and the
 * "slow acquire" warning in `server/db.ts`.
 *
 * Why this exists: the original thresholds (`util>80%`, `waiters>=1`,
 * `slow_acquires>=5 in 60s`, `slow_acquire_ms=100`) were calibrated
 * for a hot pool, but in practice the API pool sits at ~8% util with
 * 1-2 active connections of 18. Daytime trips on the *count* of slow
 * acquires because acquire volume scales with traffic, not with
 * actual pool pressure — and 100ms is well within Neon network
 * jitter. This module lets operators dial those four thresholds from
 * `system_settings` without a redeploy.
 *
 * The PERF env constants remain the safety defaults — every getter
 * falls back to its `PERF.*` value when the setting is absent or
 * malformed, so a totally empty `system_settings` table preserves the
 * legacy behaviour exactly.
 *
 * Read pattern is the same cached-with-background-refresh shape used
 * by `frontRecoveryTuning.ts`: the in-process gate readers stay
 * synchronous and cheap, the cache refreshes itself every
 * `CACHE_TTL_MS` from a background promise.
 */
import { PERF } from "../perfConfig";
// NOTE: We import `storage` LAZILY inside `loadCache()` rather than at the
// top level to avoid an import cycle. `server/db.ts` imports this module
// to call `getApiPoolPressureTuning()`; `storage` transitively reaches
// back into `server/db.ts` via the settings storage layer. The lazy
// import keeps the static import graph acyclic — the storage subtree
// is only resolved on the first background cache load, well after
// module init.

export const API_POOL_PRESSURE_TUNING_SETTING_NAMES = [
  "db_pool_util_warn_pct",
  "db_pool_waiting_warn_count",
  "db_api_slow_acquire_backoff_count",
  "db_acquire_wait_warn_ms",
] as const;

export type ApiPoolPressureTuningSettingName =
  (typeof API_POOL_PRESSURE_TUNING_SETTING_NAMES)[number];

interface CachedValues {
  utilWarnPct: number | null;
  waitingWarnCount: number | null;
  slowAcquireBackoffCount: number | null;
  acquireWaitWarnMs: number | null;
}

const EMPTY_CACHE: CachedValues = {
  utilWarnPct: null,
  waitingWarnCount: null,
  slowAcquireBackoffCount: null,
  acquireWaitWarnMs: null,
};

let cache: CachedValues = { ...EMPTY_CACHE };
let cachedAt = 0;
let loadingPromise: Promise<void> | null = null;
const CACHE_TTL_MS = 30_000;

function parseIntSafe(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

async function loadCache(): Promise<void> {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      const { storage } = await import("../storage");
      const rows = await storage.getSystemSettings([
        ...API_POOL_PRESSURE_TUNING_SETTING_NAMES,
      ]);
      cache = {
        utilWarnPct: parseIntSafe(rows.db_pool_util_warn_pct),
        waitingWarnCount: parseIntSafe(rows.db_pool_waiting_warn_count),
        slowAcquireBackoffCount: parseIntSafe(
          rows.db_api_slow_acquire_backoff_count,
        ),
        acquireWaitWarnMs: parseIntSafe(rows.db_acquire_wait_warn_ms),
      };
      cachedAt = Date.now();
    } catch (err: any) {
      console.warn(
        "[ApiPoolPressureTuning] Failed to load tuning settings (using PERF defaults):",
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface ApiPoolPressureTuningSnapshot {
  utilWarnPct: number;
  waitingWarnCount: number;
  slowAcquireBackoffCount: number;
  acquireWaitWarnMs: number;
}

export function getApiPoolPressureTuning(): ApiPoolPressureTuningSnapshot {
  maybeBackgroundRefresh();
  return {
    utilWarnPct: clamp(cache.utilWarnPct ?? PERF.DB_POOL_UTIL_WARN_PCT, 1, 100),
    waitingWarnCount: clamp(
      cache.waitingWarnCount ?? PERF.DB_POOL_WAITING_WARN_COUNT,
      1,
      1000,
    ),
    slowAcquireBackoffCount: clamp(
      cache.slowAcquireBackoffCount ?? PERF.DB_API_SLOW_ACQUIRE_BACKOFF_COUNT,
      1,
      10_000,
    ),
    acquireWaitWarnMs: clamp(
      cache.acquireWaitWarnMs ?? PERF.DB_ACQUIRE_WAIT_WARN_MS,
      1,
      60_000,
    ),
  };
}

export function __resetApiPoolPressureTuningCacheForTest(): void {
  cache = { ...EMPTY_CACHE };
  cachedAt = 0;
  loadingPromise = null;
}

export function __setApiPoolPressureTuningCacheForTest(
  partial: Partial<CachedValues>,
): void {
  cache = { ...cache, ...partial };
  cachedAt = Date.now();
}
