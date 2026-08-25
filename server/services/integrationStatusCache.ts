/**
 * Task #1842 — Integrations Hub probe cache + single-flight.
 * Task #1861 — Outcome-aware probe results + cross-instance invalidation.
 *
 * `/api/integrations/all-status` was previously firing live upstream probes
 * (Front /me, Zoom /users/me, Slack auth.test, Google Ads, Stripe,
 * GoogleDrive, PandaDoc) on every poll. That made the bundled response
 * bound by the slowest probe (often 10–30s when Zoom was in backoff or
 * Front was refreshing a token) AND multiplied upstream API call volume
 * by every admin tab open × the 5s poll.
 *
 * This module is the small layer the route handler now sits behind:
 *
 *   - Per-integration in-memory cache with `{ value, lastCheckedAt }`.
 *   - Single-flight: concurrent requests for the same integration collapse
 *     to one upstream call.
 *   - Stale-while-revalidate: a cached value within `freshTtlMs` is served
 *     immediately; an older value is served immediately but a background
 *     refresh is kicked on `workerDb` so the request stays off the
 *     `api` pool.
 *   - Cold start: no cached value → returns `{ value: null,
 *     lastCheckedAt: null }` and kicks a background refresh. The client
 *     paints "Checking…" for that card on the first poll and upgrades
 *     individually as each refresh lands.
 *   - Cross-process best-effort hydration via `redisCache` (no-op if the
 *     `redis_cache_enabled` kill switch is off or Upstash creds missing).
 *   - Cross-process invalidation via a Redis epoch key. When
 *     `invalidateIntegrationStatus(name)` runs on one instance it bumps
 *     `${name}:epoch` in Redis. Every other instance polls that epoch
 *     (debounced) on the next read and drops its local entry when the
 *     remote epoch is newer than its own `storedAtMs`.
 *   - Invalidate on OAuth callback / connect / disconnect / reconnect so
 *     user-initiated changes are reflected on the very next poll.
 *
 * Loader outcome contract (Task #1861):
 *   A loader may return either a plain value `T` (treated as a successful
 *   commit, replaces the cache entry) OR a `ProbeOutcomeResult<T>`:
 *
 *     { outcome: "commit", value, freshTtlMs?, lastProbeError? }
 *       → Replace the cached value. `freshTtlMs` overrides the default
 *         for this entry only (the override is sticky on the entry, so
 *         it also controls when the NEXT background refresh fires).
 *     { outcome: "preserve", lastProbeError }
 *       → A transient probe failure (5xx, network, refresh transport
 *         error). Keep the previously-cached value unchanged but bump
 *         `lastCheckedAt` and record `lastProbeError`. If there is no
 *         previously-cached value, write nothing — the response stays
 *         `{ value: null }` so the UI renders "Checking…" instead of
 *         "Not Connected".
 *
 *   This lets the Front loader distinguish "Front says this token is
 *   bad" (commit `connected: false`) from "we couldn't reach Front"
 *   (preserve last-known-good).
 */
import { runWithWorkerDb } from "../db";
import { cacheGet, cacheSet, cacheDel } from "./cache/redisCache";
import { registerModuleStateResetForTest } from "./moduleStateReset";

const REDIS_NS = "integration_status";
const REDIS_EPOCH_NS = "integration_status_epoch";
const REDIS_EPOCH_TTL_SECONDS = 24 * 60 * 60; // 24h — much longer than any cached value
const EPOCH_CHECK_DEBOUNCE_MS = 2_000;

interface CacheEntry<T> {
  value: T;
  storedAtMs: number;
  lastCheckedAt: string;
  /** Last transient probe failure reason, cleared on the next successful commit. */
  lastProbeError: string | null;
  /** Optional per-entry override for the stale-detection threshold. */
  freshTtlMsOverride?: number;
}

interface RedisShape<T> {
  value: T;
  storedAtMs: number;
  lastCheckedAt: string;
  lastProbeError?: string | null;
  freshTtlMsOverride?: number;
}

/**
 * Loader outcome sentinel. Detected by `outcome` field — plain values
 * without that field are treated as `{ outcome: "commit", value }`.
 */
export type ProbeOutcomeResult<T> =
  | {
      outcome: "commit";
      value: T;
      /** Override the default `freshTtlMs` for this cache entry. */
      freshTtlMs?: number;
      /** Carry a probe error forward even on a successful commit (rare). */
      lastProbeError?: string | null;
    }
  | {
      outcome: "preserve";
      /** Short reason string (e.g. `"http_503"`, `"network_timeout"`). */
      lastProbeError: string;
    };

function isOutcomeResult<T>(x: unknown): x is ProbeOutcomeResult<T> {
  if (!x || typeof x !== "object") return false;
  const o = (x as { outcome?: unknown }).outcome;
  return o === "commit" || o === "preserve";
}

const memCache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();
const hydratedFromRedis = new Set<string>();
// Per-key generation counter. `invalidateIntegrationStatus()` increments
// the generation for a key so that any in-flight refresh that started
// before the invalidate cannot overwrite the freshly-cleared cache with
// a now-stale value (race fixed in code review).
const generations = new Map<string, number>();
// Per-key last-known-remote-epoch + last debounce timestamp so the
// background epoch check doesn't hit Redis on every read.
const lastEpochCheckMs = new Map<string, number>();
const knownRemoteEpoch = new Map<string, number>();
const epochInFlight = new Set<string>();

function currentGeneration(name: string): number {
  return generations.get(name) ?? 0;
}

function bumpGeneration(name: string): void {
  generations.set(name, currentGeneration(name) + 1);
}

export interface CachedIntegrationStatus<T> {
  value: T | null;
  lastCheckedAt: string | null;
  /** Most recent transient probe error, if any. */
  lastProbeError: string | null;
}

export interface IntegrationProbeOptions {
  /** Age beyond which we trigger a background refresh while still serving the cached value. */
  freshTtlMs?: number;
  /**
   * TTL written to Redis. Defaults to 5 minutes — long enough that a fresh
   * process boot inheriting a cached value from another worker can paint
   * immediately, short enough that a forgotten invalidate self-heals.
   */
  redisTtlSeconds?: number;
}

const DEFAULT_FRESH_MS = 60_000;
const DEFAULT_REDIS_TTL_SECONDS = 300;

/**
 * Read a cache snapshot without checking epochs or starting a loader.
 *
 * Oversight consoles use this when an ordinary page render must never become a
 * provider probe trigger. Best-effort Redis hydration is still allowed because
 * it reads only the cache written by the normal Integration Hub refresh lane.
 */
export async function readCachedIntegrationStatusOnly<T>(
  name: string,
): Promise<CachedIntegrationStatus<T>> {
  if (
    process.env.NODE_ENV !== "test" &&
    !memCache.has(name) &&
    !hydratedFromRedis.has(name)
  ) {
    hydratedFromRedis.add(name);
    try {
      const cached = await cacheGet<RedisShape<T>>(REDIS_NS, name);
      if (cached && !memCache.has(name)) {
        memCache.set(name, {
          value: cached.value,
          storedAtMs:
            typeof cached.storedAtMs === "number" ? cached.storedAtMs : 0,
          lastCheckedAt: cached.lastCheckedAt,
          lastProbeError: cached.lastProbeError ?? null,
          freshTtlMsOverride: cached.freshTtlMsOverride,
        });
      }
    } catch {
      // Cache-only status is best-effort. A miss remains an explicit unknown.
    }
  }

  const entry = memCache.get(name) as CacheEntry<T> | undefined;
  return entry
    ? {
        value: entry.value,
        lastCheckedAt: entry.lastCheckedAt,
        lastProbeError: entry.lastProbeError,
      }
    : { value: null, lastCheckedAt: null, lastProbeError: null };
}

/**
 * Returns the current cached status for `name`, kicking a background
 * refresh through `loader` if the entry is missing or older than
 * `freshTtlMs`. Never awaits the loader on the calling request.
 *
 * The loader is invoked inside `runWithWorkerDb` so any DB work it does
 * lands on the worker pool — the API-pool request only does the cache
 * read and JSON build.
 */
export async function getCachedIntegrationStatus<T>(
  name: string,
  loader: () => Promise<T | ProbeOutcomeResult<T>>,
  opts: IntegrationProbeOptions = {},
): Promise<CachedIntegrationStatus<T>> {
  const freshMs = opts.freshTtlMs ?? DEFAULT_FRESH_MS;
  const redisTtl = opts.redisTtlSeconds ?? DEFAULT_REDIS_TTL_SECONDS;

  // Best-effort one-time Redis hydration so a freshly booted process
  // doesn't paint "Checking…" for every card when another worker (or
  // the previous deploy generation) already has a warm value.
  //
  // Task #3824 — SKIPPED under test runs. The shared Redis instance can
  // hold a stale `connected: true` (seeded by the dev server's Hub-badge
  // prewarm, or by a sibling suite earlier in the same run writing into
  // the per-run namespace), which cold-hydrates here and contradicts the
  // suite's stubbed storage — the "confirmed-empty read → not connected"
  // step then randomly sees `connected: true`. Test processes must derive
  // integration status ONLY from their (stubbed) loaders; read-time check
  // so import order can't freeze a pre-stub NODE_ENV.
  if (process.env.NODE_ENV !== "test" && !memCache.has(name) && !hydratedFromRedis.has(name)) {
    hydratedFromRedis.add(name);
    try {
      const cached = await cacheGet<RedisShape<T>>(REDIS_NS, name);
      if (cached && !memCache.has(name)) {
        memCache.set(name, {
          value: cached.value,
          storedAtMs: typeof cached.storedAtMs === "number" ? cached.storedAtMs : 0,
          lastCheckedAt: cached.lastCheckedAt,
          lastProbeError: cached.lastProbeError ?? null,
          freshTtlMsOverride: cached.freshTtlMsOverride,
        });
      }
    } catch {
      // fail-open
    }
  }

  // Kick (debounced) background check against the Redis epoch so a
  // remote invalidate (OAuth callback on another instance) self-heals
  // here on the next poll.
  kickEpochCheck(name);

  const entry = memCache.get(name) as CacheEntry<T> | undefined;
  const now = Date.now();

  if (!entry) {
    kickRefresh(name, loader, redisTtl, freshMs);
    return { value: null, lastCheckedAt: null, lastProbeError: null };
  }

  const effectiveFreshMs = entry.freshTtlMsOverride ?? freshMs;
  if (now - entry.storedAtMs > effectiveFreshMs) {
    kickRefresh(name, loader, redisTtl, freshMs);
  }

  return {
    value: entry.value,
    lastCheckedAt: entry.lastCheckedAt,
    lastProbeError: entry.lastProbeError,
  };
}

function kickRefresh<T>(
  name: string,
  loader: () => Promise<T | ProbeOutcomeResult<T>>,
  redisTtlSeconds: number,
  defaultFreshMs: number,
): void {
  if (inFlight.has(name)) return;
  // Snapshot the generation *before* we start the load. If anyone calls
  // `invalidateIntegrationStatus(name)` while the loader is running the
  // generation will advance, and we'll discard our now-stale result on
  // resolve instead of clobbering the freshly-invalidated cache.
  const startGen = currentGeneration(name);
  const p: Promise<void> = (async () => {
    try {
      const raw = await runWithWorkerDb(() => loader());
      if (currentGeneration(name) !== startGen) {
        // Invalidated mid-flight — drop this result. The next caller will
        // kick a fresh refresh on the new generation.
        return;
      }
      const lastCheckedAt = new Date().toISOString();
      const storedAtMs = Date.now();

      if (isOutcomeResult<T>(raw) && raw.outcome === "preserve") {
        // Transient probe failure. Preserve the previous value if any;
        // otherwise leave the cache cold so the response is `null` and
        // the UI keeps showing "Checking…" instead of being pinned to
        // a stale or fabricated "Not Connected".
        const existing = memCache.get(name) as CacheEntry<T> | undefined;
        if (!existing) {
          // No previously-cached value — record nothing. We do NOT write
          // a synthetic `{ value: null }` entry because that would mask
          // the next real probe behind a "fresh" window. Logging only.
          console.warn(
            `[IntegrationStatusCache] preserve outcome on cold cache for ${name}: ${raw.lastProbeError}`,
          );
          return;
        }
        const next: CacheEntry<T> = {
          ...existing,
          // Don't bump storedAtMs — preserve outcome should NOT extend
          // the freshness window. The next poll re-attempts the probe.
          lastCheckedAt,
          lastProbeError: raw.lastProbeError,
        };
        memCache.set(name, next);
        // Don't write `preserve` outcomes to Redis — they're per-instance
        // observability, not authoritative state.
        return;
      }

      // Commit outcome (either explicit or plain value).
      let commitValue: T;
      let commitFreshMs: number | undefined;
      let commitLastProbeError: string | null = null;
      if (isOutcomeResult<T>(raw)) {
        // Preserve branch returned above, so only "commit" remains.
        const commit = raw as Extract<ProbeOutcomeResult<T>, { outcome: "commit" }>;
        commitValue = commit.value;
        commitFreshMs = typeof commit.freshTtlMs === "number" ? commit.freshTtlMs : undefined;
        commitLastProbeError = commit.lastProbeError ?? null;
      } else {
        commitValue = raw as T;
      }

      const entry: CacheEntry<T> = {
        value: commitValue,
        storedAtMs,
        lastCheckedAt,
        lastProbeError: commitLastProbeError,
        freshTtlMsOverride: commitFreshMs,
      };
      memCache.set(name, entry);
      try {
        await cacheSet<RedisShape<T>>(
          REDIS_NS,
          name,
          {
            value: commitValue,
            storedAtMs,
            lastCheckedAt,
            lastProbeError: commitLastProbeError,
            freshTtlMsOverride: commitFreshMs,
          },
          { ttlSeconds: redisTtlSeconds },
        );
      } catch {
        // fail-open — redis is best-effort
      }
    } catch (err: any) {
      // Loader itself threw. Treat as a transient probe failure: keep
      // the old value (if any) and record the error so the UI can
      // surface "Last check failed". Same generation guard applies.
      if (currentGeneration(name) === startGen) {
        const existing = memCache.get(name) as CacheEntry<T> | undefined;
        const reason = err?.message ? `loader_error: ${err.message}` : "loader_error";
        if (existing) {
          memCache.set(name, { ...existing, lastProbeError: reason });
        }
        // Cold cache + loader threw → leave cache empty (UI keeps
        // showing "Checking…"). No synthetic-disconnected marker.
      }
      console.warn(`[IntegrationStatusCache] refresh ${name} failed: ${err?.message ?? err}`);
    } finally {
      inFlight.delete(name);
    }
  })();
  inFlight.set(name, p);
}

/**
 * Drop the cached probe result for `name` (e.g. after an OAuth callback,
 * connect, disconnect, or manual reconnect). The next poll runs the
 * loader fresh. Also bumps a per-key epoch in Redis so other server
 * instances observe the invalidation on their next poll (Task #1861).
 */
export async function invalidateIntegrationStatus(name: string | string[]): Promise<void> {
  const names = Array.isArray(name) ? name : [name];
  const now = Date.now();
  for (const n of names) {
    // Advance the generation FIRST so any in-flight loader that resolves
    // after this call will see the mismatch and drop its result.
    bumpGeneration(n);
    memCache.delete(n);
    inFlight.delete(n);
    hydratedFromRedis.delete(n);
    // Bump our local known-remote-epoch so we don't immediately
    // re-evict on the next epoch check.
    knownRemoteEpoch.set(n, now);
    try {
      await cacheDel(REDIS_NS, n);
    } catch {
      // fail-open
    }
    try {
      // Write the epoch with a long TTL — much longer than any cached
      // probe value — so a slow cross-instance reader still sees it.
      await cacheSet<number>(REDIS_EPOCH_NS, n, now, { ttlSeconds: REDIS_EPOCH_TTL_SECONDS });
    } catch {
      // fail-open
    }
  }
}

/**
 * Best-effort cross-instance invalidation check. Reads the per-key
 * epoch from Redis (debounced per key) and, if it's newer than our
 * local entry's `storedAtMs`, evicts the local entry so the next
 * read kicks a fresh load.
 *
 * Runs fire-and-forget on every cache read but does at most one
 * Redis round-trip per key per `EPOCH_CHECK_DEBOUNCE_MS`.
 */
function kickEpochCheck(name: string): void {
  const now = Date.now();
  const last = lastEpochCheckMs.get(name) ?? 0;
  if (now - last < EPOCH_CHECK_DEBOUNCE_MS) return;
  if (epochInFlight.has(name)) return;
  lastEpochCheckMs.set(name, now);
  epochInFlight.add(name);
  void (async () => {
    try {
      const remote = await cacheGet<number>(REDIS_EPOCH_NS, name);
      if (typeof remote !== "number" || !Number.isFinite(remote)) return;
      const known = knownRemoteEpoch.get(name) ?? 0;
      if (remote <= known) return;
      knownRemoteEpoch.set(name, remote);
      const entry = memCache.get(name);
      if (!entry) return;
      if (remote > entry.storedAtMs) {
        // Another instance invalidated us — drop the local entry so
        // the next read kicks a fresh load. Bump generation so any
        // in-flight loader doesn't clobber the freshly-cleared cache.
        bumpGeneration(name);
        memCache.delete(name);
        inFlight.delete(name);
        hydratedFromRedis.delete(name);
      }
    } catch {
      // fail-open
    } finally {
      epochInFlight.delete(name);
    }
  })();
}

/**
 * Test seam — rewinds the cached entry's `storedAtMs` by `ageMs` so the
 * next read sees the entry as stale and kicks a background refresh,
 * WITHOUT discarding the cached value. Used by the Task #1889 route
 * test to exercise the warm-cache preserve branch in `/api/integrations
 * /all-status` without waiting out a 60-second freshness window.
 */
export function __rewindStoredAtMsForTest(name: string, ageMs: number): boolean {
  const entry = memCache.get(name);
  if (!entry) return false;
  entry.storedAtMs = Math.max(0, entry.storedAtMs - ageMs);
  // Also clear the per-entry override so the route's default freshMs
  // (the value the route passes) is what decides freshness.
  entry.freshTtlMsOverride = undefined;
  return true;
}

/** Test seam. */
export function __resetIntegrationStatusCacheForTest(): void {
  memCache.clear();
  inFlight.clear();
  hydratedFromRedis.clear();
  generations.clear();
  lastEpochCheckMs.clear();
  knownRemoteEpoch.clear();
  epochInFlight.clear();
}

// Task #4097: the batched test runner hosts several suites in one process;
// this module's SWR memCache (and friends) must not leak a sibling suite's
// entries into the next suite. No-op outside NODE_ENV=test.
registerModuleStateResetForTest(
  "integrationStatusCache",
  __resetIntegrationStatusCacheForTest,
);
