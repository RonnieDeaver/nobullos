// @db-pool-intent: worker
/**
 * Task #1829 — Front pipeline warp-speed throughput settings.
 *
 * Centralizes the five numeric knobs that tune the Front pipeline
 * fast-poll multi-dispatch loop. The three boolean kill switches
 * (`front_warp_speed_enabled`, `front_ingestion_api_waiter_backoff_enabled`,
 * `front_ingestion_front_rate_limit_guard_enabled`) live in
 * `poolEpicKillSwitches.ts` so they share the existing hot-flip surface
 * and the snapshot endpoint.
 *
 * Read pattern: in-memory cache with a 30-second TTL. Callers on the
 * dispatch hot path call `getFrontWarpSettings()` which returns the
 * cached snapshot and kicks off a background refresh if the TTL has
 * elapsed. Boot wiring should call `ensureFrontWarpSettingsLoaded()`
 * once so the first dispatch tick sees the persisted values rather
 * than hard-coded defaults.
 *
 * Loader fails open: a settings-read failure leaves the previous
 * cached value (or the default on first load) in place — the fast
 * poll path must never block on a settings refresh.
 *
 * Pool tenancy: all settings reads route through `runWithWorkerDb`
 * because callers run inside the scheduler (worker pool tenant).
 */
import { runWithWorkerDb, withDbAttribution } from "../db";
import { storage } from "../storage";
import {
  setFrontIngestionClassConcurrency,
  setFrontIngestionManualReserve,
} from "./workloadManager";

export const FRONT_WARP_SETTING_KEYS = [
  "front_ingestion_class_concurrency",
  "front_ingestion_manual_reserve",
  "front_ingestion_poll_interval_ms",
  "front_ingestion_per_cycle_dispatch_max",
  "front_ingestion_worker_idle_min",
] as const;

export type FrontWarpSettingKey = (typeof FRONT_WARP_SETTING_KEYS)[number];

export interface FrontWarpSettings {
  classConcurrency: number;
  manualReserve: number;
  pollIntervalMs: number;
  perCycleDispatchMax: number;
  workerIdleMin: number;
}

const DEFAULTS: FrontWarpSettings = {
  classConcurrency: 4,
  manualReserve: 1,
  pollIntervalMs: 500,
  perCycleDispatchMax: 8,
  workerIdleMin: 2,
};

const BOUNDS: Record<keyof FrontWarpSettings, { min: number; max: number }> = {
  classConcurrency: { min: 1, max: 8 },
  manualReserve: { min: 0, max: 4 },
  // 100 ms floor so a misconfiguration cannot saturate the CPU with
  // dispatch ticks; 10 s ceiling so a typo cannot turn the fast poll
  // into a slow poll without operators noticing.
  pollIntervalMs: { min: 100, max: 10_000 },
  perCycleDispatchMax: { min: 1, max: 32 },
  workerIdleMin: { min: 0, max: 8 },
};

const CACHE_TTL_MS = 30_000;

let cached: FrontWarpSettings = { ...DEFAULTS };
let loadedAt = 0;
let loadingPromise: Promise<void> | null = null;

function clamp(value: number, key: keyof FrontWarpSettings): number {
  const { min, max } = BOUNDS[key];
  if (!Number.isFinite(value)) return DEFAULTS[key];
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function parseInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

async function loadFromSettings(): Promise<void> {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      const rows = await runWithWorkerDb(() =>
        withDbAttribution(
          "front_warp_settings:load",
          () => storage.getSystemSettings([...FRONT_WARP_SETTING_KEYS]),
        ),
      );
      const next: FrontWarpSettings = { ...DEFAULTS };
      const cc = parseInteger(rows["front_ingestion_class_concurrency"]);
      if (cc !== undefined) next.classConcurrency = clamp(cc, "classConcurrency");
      const mr = parseInteger(rows["front_ingestion_manual_reserve"]);
      if (mr !== undefined) next.manualReserve = clamp(mr, "manualReserve");
      const pi = parseInteger(rows["front_ingestion_poll_interval_ms"]);
      if (pi !== undefined) next.pollIntervalMs = clamp(pi, "pollIntervalMs");
      const pc = parseInteger(rows["front_ingestion_per_cycle_dispatch_max"]);
      if (pc !== undefined) next.perCycleDispatchMax = clamp(pc, "perCycleDispatchMax");
      const wi = parseInteger(rows["front_ingestion_worker_idle_min"]);
      if (wi !== undefined) next.workerIdleMin = clamp(wi, "workerIdleMin");
      cached = next;
      loadedAt = Date.now();
      // Push live values into the workload manager so the class budget
      // and manual reserve match the freshly-loaded settings without
      // requiring a restart.
      setFrontIngestionClassConcurrency(next.classConcurrency);
      setFrontIngestionManualReserve(next.manualReserve);
    } catch (err: any) {
      // Best-effort. Keep the previous cached snapshot (or defaults
      // on first load) so the fast-poll loop never blocks on settings.
      console.warn(
        "[FrontWarpSettings] failed to load settings:",
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
  if (loadedAt === 0) {
    void loadFromSettings();
    return;
  }
  if (Date.now() - loadedAt >= CACHE_TTL_MS) {
    void loadFromSettings();
  }
}

export function getFrontWarpSettings(): FrontWarpSettings {
  maybeBackgroundRefresh();
  return cached;
}

export async function ensureFrontWarpSettingsLoaded(): Promise<void> {
  if (loadedAt !== 0 && Date.now() - loadedAt < CACHE_TTL_MS) return;
  await loadFromSettings();
}

// Test seam: reset the in-memory cache so unit tests can simulate a
// fresh process.
export function __resetFrontWarpSettingsForTest(): void {
  cached = { ...DEFAULTS };
  loadedAt = 0;
  loadingPromise = null;
}

// Test seam: directly inject a settings snapshot (bypassing the
// settings table) and propagate it to the workload manager.
export function __setFrontWarpSettingsForTest(partial: Partial<FrontWarpSettings>): void {
  cached = {
    classConcurrency: clamp(partial.classConcurrency ?? cached.classConcurrency, "classConcurrency"),
    manualReserve: clamp(partial.manualReserve ?? cached.manualReserve, "manualReserve"),
    pollIntervalMs: clamp(partial.pollIntervalMs ?? cached.pollIntervalMs, "pollIntervalMs"),
    perCycleDispatchMax: clamp(partial.perCycleDispatchMax ?? cached.perCycleDispatchMax, "perCycleDispatchMax"),
    workerIdleMin: clamp(partial.workerIdleMin ?? cached.workerIdleMin, "workerIdleMin"),
  };
  loadedAt = Date.now();
  setFrontIngestionClassConcurrency(cached.classConcurrency);
  setFrontIngestionManualReserve(cached.manualReserve);
}

export const FRONT_WARP_DEFAULTS = DEFAULTS;
export const FRONT_WARP_BOUNDS = BOUNDS;

// The three Front pipeline queues that route through `front_ingestion`
// when warp speed is on. Exported so the scheduler enqueue remap and
// the fast-poll loop share one source of truth.
export const FRONT_WARP_QUEUE_NAMES = [
  "front_webhook_normalize",
  "front_webhook_apply",
  "front_reconciliation",
] as const;

export type FrontWarpQueueName = (typeof FRONT_WARP_QUEUE_NAMES)[number];

export function isFrontWarpQueue(queueName: string): queueName is FrontWarpQueueName {
  return (FRONT_WARP_QUEUE_NAMES as readonly string[]).includes(queueName);
}

// Task #1829 Phase 4 — Front API 429 tracker. The webhook ingestion
// path records each 429 hit; the fast-poll guard reads the recent
// count and backs off when Front is rate-limiting us so multi-dispatch
// cannot create a 429 storm. In-memory ring (single process); resets
// on restart by design.
const FRONT_429_WINDOW_MS = 60_000;
const FRONT_429_THRESHOLD = 3;
const front429Times: number[] = [];

export function recordFront429Hit(): void {
  const now = Date.now();
  front429Times.push(now);
  // Trim old entries opportunistically.
  const cutoff = now - FRONT_429_WINDOW_MS;
  while (front429Times.length > 0 && front429Times[0] < cutoff) {
    front429Times.shift();
  }
}

export function getRecentFront429Count(): number {
  const cutoff = Date.now() - FRONT_429_WINDOW_MS;
  while (front429Times.length > 0 && front429Times[0] < cutoff) {
    front429Times.shift();
  }
  return front429Times.length;
}

export function isFrontRateLimitElevated(): boolean {
  return getRecentFront429Count() >= FRONT_429_THRESHOLD;
}

export function __resetFront429TrackerForTest(): void {
  front429Times.length = 0;
}

// Task #1829 Phase 4 — observable guard-trigger counters surfaced by
// the validator + admin trends panel. Each guard increments its
// counter when it suppresses a dispatch attempt so operators can see
// whether the throttle is active.
export interface FrontWarpGuardCounters {
  workerIdle: number;
  apiPoolWaiter: number;
  frontRateLimit: number;
  dbHoldThrottle: number;
  classCapReached: number;
  perCycleMaxReached: number;
  masterSwitchOff: number;
  queuePaused: number;
}

const guardCounters: FrontWarpGuardCounters = {
  workerIdle: 0,
  apiPoolWaiter: 0,
  frontRateLimit: 0,
  dbHoldThrottle: 0,
  classCapReached: 0,
  perCycleMaxReached: 0,
  masterSwitchOff: 0,
  queuePaused: 0,
};

export function incrementFrontWarpGuard(name: keyof FrontWarpGuardCounters): void {
  guardCounters[name] += 1;
}

export function getFrontWarpGuardCounters(): FrontWarpGuardCounters {
  return { ...guardCounters };
}

export function __resetFrontWarpGuardCountersForTest(): void {
  for (const k of Object.keys(guardCounters) as (keyof FrontWarpGuardCounters)[]) {
    guardCounters[k] = 0;
  }
}
