import { MarketAreaSummary } from "./types";
import { getCached, setCache } from "./cache";
import { loadCensusTracts, getTractCount } from "./tractLoader";
import { isH3PopulationSeeded, seedH3Population } from "./h3pop";
import { isCanadaH3Seeded, seedCanadaH3Population } from "./canadaLoader";
import { runWithWorkerDb, withDbAttribution } from "../db";

const MCU_SUMMARY_CACHE_KEY = "full_summary";
const MCU_SUMMARY_CACHE_TYPE = "mcu_summary";

let cachedSummary: MarketAreaSummary[] | null = null;
let lastComputedAt: Date | null = null;
let computeStatus: 'idle' | 'computing' | 'ready' | 'error' = 'idle';
let computeError: string | null = null;
let computeProgress: string = '';
let computePercent: number = 0;
let computeStartedAt: number | null = null;
let computeEtaSeconds: number | null = null;

export function getCachedSummary(): {
  data: MarketAreaSummary[] | null;
  status: string;
  lastComputedAt: Date | null;
  progress: string;
  percent: number;
  etaSeconds: number | null;
  error: string | null;
  isComputing: boolean;
} {
  const isComputing = computeStatus === 'computing';

  if (cachedSummary && cachedSummary.length > 0) {
    return {
      data: cachedSummary,
      status: isComputing ? 'computing' : (computeStatus === 'error' ? 'error' : 'ready'),
      lastComputedAt,
      progress: isComputing ? computeProgress : '',
      percent: isComputing ? computePercent : 100,
      etaSeconds: isComputing ? computeEtaSeconds : null,
      error: computeError,
      isComputing,
    };
  }

  return {
    data: null,
    status: computeStatus,
    lastComputedAt,
    progress: computeProgress,
    percent: computePercent,
    etaSeconds: computeEtaSeconds,
    error: computeError,
    isComputing,
  };
}

let pendingRefresh = false;
let nextForceProbeSearch = false;

export function triggerRefresh(forceProbeSearch: boolean = false): void {
  if (computeStatus === 'computing') {
    pendingRefresh = true;
    if (forceProbeSearch) nextForceProbeSearch = true;
    console.log('[MCU Worker] Computation in progress — will recompute again when current run finishes.');
    return;
  }
  // Fire-and-forget by design: triggerRefresh must never block its caller.
  runComputation(forceProbeSearch).catch((err) => {
    console.error("[MCU Worker] Computation run failed:", err);
  });
}

const LOCATION_CHANGE_DELAY_MS = 30_000;
let locationChangeTimer: ReturnType<typeof setTimeout> | null = null;

export function onLocationChanged(): void {
  if (locationChangeTimer) {
    clearTimeout(locationChangeTimer);
  }
  console.log('[MCU Worker] Location change detected. Scheduling recomputation in 30s...');
  locationChangeTimer = setTimeout(() => {
    locationChangeTimer = null;
    console.log('[MCU Worker] Recomputing due to location change...');
    triggerRefresh();
  }, LOCATION_CHANGE_DELAY_MS);
}

async function runComputation(forceProbeSearch: boolean = false): Promise<void> {
  return runWithWorkerDb(() =>
    withDbAttribution("worker:mcu_compute", () => runComputationInner(forceProbeSearch)),
  );
}

async function runComputationInner(forceProbeSearch: boolean = false): Promise<void> {
  const startTime = Date.now();
  computeStartedAt = startTime;
  try {
    computeStatus = 'computing';
    computeError = null;
    computeProgress = 'Starting MCU computation...';
    computePercent = 0;
    computeEtaSeconds = null;
    console.log('[MCU Worker] Computation starting...');

    const tractCount = await getTractCount();
    if (tractCount === 0) {
      computeProgress = 'Loading census tract data (one-time setup)...';
      console.log('[MCU Worker] Census tract data not loaded yet. Loading now...');
      await loadCensusTracts();
    }

    const { getMarketAreaSummaries } = await import("./engine");
    console.log('[MCU Worker] Engine loaded, calling getMarketAreaSummaries...');

    computeProgress = 'Computing market data...';

    console.log(`[MCU Worker] forceProbeSearch=${forceProbeSearch}`);
    const result = await getMarketAreaSummaries(undefined, undefined, (info) => {
      computeProgress = info.detail
        ? `${info.phase}: ${info.detail}`
        : info.phase;

      if (info.total > 0) {
        const phaseWeights: Record<string, { start: number; end: number }> = {
          'Loading locations': { start: 0, end: 5 },
          'Computing radii': { start: 5, end: 70 },
          'Analyzing markets': { start: 70, end: 100 },
        };
        const w = phaseWeights[info.phase] || { start: 0, end: 100 };
        const phaseProgress = info.current / info.total;
        computePercent = Math.round(w.start + phaseProgress * (w.end - w.start));

        const elapsed = (Date.now() - startTime) / 1000;
        if (computePercent > 2 && elapsed > 3) {
          const totalEstimate = elapsed / (computePercent / 100);
          computeEtaSeconds = Math.max(0, Math.round(totalEstimate - elapsed));
        }
      }

      if (info.partialResults && info.partialResults.length > 0) {
        cachedSummary = info.partialResults;
        lastComputedAt = new Date();

        setCache(MCU_SUMMARY_CACHE_TYPE, MCU_SUMMARY_CACHE_KEY, {
          data: info.partialResults,
          computedAt: lastComputedAt.toISOString(),
          partial: true,
        }).catch(() => {});
      }
    }, forceProbeSearch);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    cachedSummary = result;
    lastComputedAt = new Date();
    computeStatus = 'ready';
    computeProgress = '';
    computePercent = 100;
    computeEtaSeconds = null;
    computeError = null;
    computeStartedAt = null;
    console.log(`[MCU Worker] Computation complete in ${elapsed}s. ${result.length} market areas cached.`);

    let persisted = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await setCache(MCU_SUMMARY_CACHE_TYPE, MCU_SUMMARY_CACHE_KEY, {
          data: result,
          computedAt: lastComputedAt.toISOString(),
        });
        console.log('[MCU Worker] Results persisted to database cache.');
        persisted = true;
        break;
      } catch (e: any) {
        const msg = e?.message || String(e);
        console.warn(`[MCU Worker] Persist attempt ${attempt}/5 failed: ${msg.slice(0, 100)}`);
        if (attempt < 5) {
          const delay = attempt * 3000;
          console.log(`[MCU Worker] Retrying persist in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    if (!persisted) {
      console.error('[MCU Worker] CRITICAL: Failed to persist results after 5 attempts. Results are in memory only and will be lost on restart.');
    }
  } catch (err: any) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    computeStatus = 'error';
    computeError = err?.message || String(err);
    computeProgress = '';
    computePercent = 0;
    computeEtaSeconds = null;
    computeStartedAt = null;
    console.error(`[MCU Worker] Computation failed after ${elapsed}s:`, err);
  }

  if (pendingRefresh) {
    const shouldForce = nextForceProbeSearch;
    pendingRefresh = false;
    nextForceProbeSearch = false;
    console.log('[MCU Worker] Processing pending refresh (location changed during last computation)...');
    setTimeout(() => runComputation(shouldForce), 5_000);
  }
}

async function loadFromDbCache(): Promise<boolean> {
  return runWithWorkerDb(() =>
    withDbAttribution("worker:mcu_load_from_db_cache", loadFromDbCacheInner),
  );
}

async function loadFromDbCacheInner(): Promise<boolean> {
  try {
    const cached = await getCached<{ data: MarketAreaSummary[]; computedAt: string }>(
      MCU_SUMMARY_CACHE_TYPE,
      MCU_SUMMARY_CACHE_KEY
    );
    if (cached && cached.data && Array.isArray(cached.data)) {
      cachedSummary = cached.data;
      lastComputedAt = new Date(cached.computedAt);
      computeStatus = 'ready';
      console.log(`[MCU Worker] Loaded ${cached.data.length} market areas from DB cache (computed at ${cached.computedAt}).`);
      return true;
    }
  } catch (e) {
    console.warn('[MCU Worker] Failed to load from DB cache:', e);
  }
  return false;
}

export async function startMcuWorker(): Promise<void> {
  return runWithWorkerDb(() =>
    withDbAttribution("worker:mcu_start", startMcuWorkerInner),
  );
}

async function startMcuWorkerInner(): Promise<void> {
  console.log('[MCU Worker] Starting...');

  const seeded = await isH3PopulationSeeded();
  if (!seeded) {
    console.log('[MCU Worker] Seeding H3 population grid (one-time)...');
    const count = await seedH3Population();
    console.log(`[MCU Worker] H3 population grid seeded: ${count} cells`);
  }

  const canadaSeeded = await isCanadaH3Seeded();
  if (!canadaSeeded) {
    console.log('[MCU Worker] Seeding Canadian H3 population grid (one-time)...');
    try {
      const canadaCells = await seedCanadaH3Population();
      console.log(`[MCU Worker] Canadian H3 population grid seeded: ${canadaCells} cells`);
    } catch (e: any) {
      console.warn(`[MCU Worker] Failed to seed Canadian population (non-fatal): ${e?.message}`);
    }
  }

  const hadCache = await loadFromDbCache();

  if (hadCache) {
    console.log(`[MCU Worker] Using cached data. Will recompute only when client locations change or manual refresh is triggered.`);
  } else {
    console.log('[MCU Worker] No cache found. Scheduling initial computation in 10 seconds...');
    setTimeout(() => {
      triggerRefresh();
    }, 10_000);
  }
}
