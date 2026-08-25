/* test-registration
{
  "name": "Redis cache / kill-switch boundary (Task #3947)",
  "smoke": true,
  "smokeReason": "Guards the Task #3947 cycle break: redisCache's traced import closure must exclude server/storage.ts, the server/storage barrel modules, server/db.ts and poolEpicKillSwitches.ts (it may depend only on the dependency-free poolEpicSwitchState leaf), and the loader must register the leaf's refresh trigger at module init so cache-only read paths keep the hot-flip contract. A regression here re-couples the cache/storage/kill-switch boot rings or silently freezes switch flips for cache readers.",
  "tier": "small"
}
test-registration */
/**
 * Task #3947 — cache / kill-switch / storage boundary test.
 *
 * The Knip audit (Task #3894) found a boot-time runtime module cycle:
 * poolEpicKillSwitches → storage → storage/settingsStorage →
 * services/cache/redisCache → poolEpicKillSwitches. Task #3947 split the
 * kill-switch surface into a dependency-free leaf
 * (`server/services/poolEpicSwitchState.ts`) that the cache imports, with
 * the DB-backed loader (`poolEpicKillSwitches.ts`) registering the leaf's
 * background-refresh trigger at its own module-init time.
 *
 * Proves, without a real Upstash endpoint (fetch stubbed via the shared
 * helper) and without a DB settings dependency (storage settings ops
 * patched in-memory):
 *
 *   Group 1 — import-closure boundary: redisCache's traced closure
 *     includes the leaf and EXCLUDES server/storage.ts, everything under
 *     server/storage/, server/db.ts, and the loader module.
 *   Group 2 — public-surface identity: the loader re-exports the leaf's
 *     sync read and names list (same underlying objects), so the ~20
 *     existing import sites observe identical behavior.
 *   Group 3 — `redis_cache_enabled` gates the cache exactly as before:
 *     bypassed counters (zero Upstash traffic) when off, real (stubbed)
 *     Upstash traffic + miss/set counters when on, write-through of the
 *     flip to the settings backend, and metrics.enabled tracking.
 *   Group 4 — fail-open: when the settings load throws, reads serve the
 *     hard-coded defaults (redis_cache_enabled=false,
 *     health_rollups_enabled=true) and ensurePoolEpicSwitchesLoaded still
 *     resolves; cacheGetOrSet falls through to its loader.
 *   Group 5 — the flip stays hot on cache-only read paths: within the
 *     60s fresh window a cache read does NOT refetch settings; once state
 *     is stale a cache read kicks the background refresh that picks up an
 *     out-of-process flip.
 *   Group 6 — deterministic wiring: __resetPoolEpicSwitchesForTest keeps
 *     the module-init trigger registered — a pure leaf read after reset
 *     reaches storage.getSystemSettings with zero manual test wiring.
 */
import {
  __resetRedisCacheClientForTest,
  __resetRedisCacheMetricsForTest,
  cacheGet,
  cacheGetOrSet,
  cacheSet,
  getRedisCacheMetrics,
} from "../server/services/cache/redisCache";
import * as loaderModule from "../server/services/poolEpicKillSwitches";
import * as leafModule from "../server/services/poolEpicSwitchState";
import { storage } from "../server/storage";
import {
  isUpstashRedisUrl,
  makeUpstashPassthroughResponse,
} from "./helpers/upstashFetchStub";
import { traceImportClosures } from "./relatedSmokeSelection";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function poll(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const stepMs = 25;
  for (let waited = 0; waited <= timeoutMs; waited += stepMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
}

async function run(): Promise<void> {
  const ORIG_URL = process.env.UPSTASH_REDIS_REST_URL;
  const ORIG_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const originalFetch = global.fetch;
  const realDateNow = Date.now;

  // In-memory settings backend replacing the two storage ops the loader
  // uses. Installed as OWN properties on the storage instance (methods
  // live on the prototype), removed with `delete` in the finally block.
  let settingsImpl: () => Promise<Record<string, string | undefined>> = async () => ({});
  let settingsCalls = 0;
  const recordedSets: Array<{ key: string; value: string; updatedBy: string | undefined }> = [];

  let upstashCalls = 0;

  try {
    // ─── Group 1: import-closure boundary ─────────────────────────────
    const ENTRY = "server/services/cache/redisCache.ts";
    const trace = await traceImportClosures([ENTRY], process.cwd());
    assert(trace.ok, `closure trace failed: ${trace.error ?? "unknown"}`);
    const closure = trace.closures.get(ENTRY) ?? new Set<string>();
    assert(
      closure.size >= 3,
      `closure implausibly small (${closure.size}) — trace did not resolve imports`,
    );
    const forbidden = [...closure].filter(
      (p) =>
        p === "server/storage.ts" ||
        p.startsWith("server/storage/") ||
        p === "server/db.ts" ||
        p === "server/services/poolEpicKillSwitches.ts",
    );
    assert(
      forbidden.length === 0,
      `redisCache import closure re-coupled to forbidden modules: ${forbidden.join(", ")}`,
    );
    assert(
      closure.has("server/services/poolEpicSwitchState.ts"),
      "closure includes the kill-switch state leaf",
    );
    assert(
      closure.has("server/lib/deploymentEnv.ts"),
      "sanity: known closure member present (trace really resolved imports)",
    );
    console.log(
      `[Group1] redisCache import closure is storage-free (${closure.size} files): ${[...closure].sort().join(", ")}`,
    );

    // ─── Group 2: public-surface identity ─────────────────────────────
    assert(
      loaderModule.isPoolEpicSwitchEnabled === leafModule.isPoolEpicSwitchEnabled,
      "loader re-exports the leaf's isPoolEpicSwitchEnabled (same function object)",
    );
    assert(
      loaderModule.POOL_EPIC_SWITCH_NAMES === leafModule.POOL_EPIC_SWITCH_NAMES,
      "loader re-exports the leaf's POOL_EPIC_SWITCH_NAMES (same array object)",
    );
    console.log("[Group2] loader re-exports are identity-equal to the leaf's");

    // Install the in-memory settings backend before any group that can
    // trigger a switch load.
    (storage as any).getSystemSettings = async (_keys: string[]) => {
      settingsCalls++;
      return settingsImpl();
    };
    (storage as any).setSystemSetting = async (
      key: string,
      value: string,
      updatedBy?: string,
    ) => {
      recordedSets.push({ key, value, updatedBy });
    };

    // ─── Group 3: ON/OFF gating with stubbed Upstash traffic ──────────
    loaderModule.__resetPoolEpicSwitchesForTest();
    __resetRedisCacheMetricsForTest();
    settingsImpl = async () => ({});
    process.env.UPSTASH_REDIS_REST_URL = "https://boundary-3947.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "boundary-test-token";
    global.fetch = (async (input: any, init?: any) => {
      if (isUpstashRedisUrl(input)) {
        upstashCalls++;
        return makeUpstashPassthroughResponse(input, init);
      }
      return (originalFetch as any)(input, init);
    }) as any;
    __resetRedisCacheClientForTest();

    // Default OFF → bypass, zero Upstash traffic even though configured.
    const g0 = await cacheGet("boundary3947", "k0");
    assert(g0 === null, "cacheGet returns null while switch is off");
    let m = getRedisCacheMetrics();
    assert(m.configured === true, "client is configured from env vars");
    assert(m.enabled === false, "metrics.enabled false while switch is off");
    assert(m.totals.bypassed === 1, `expected exactly 1 bypassed op, got ${m.totals.bypassed}`);
    assert(upstashCalls === 0, "no Upstash traffic while switch is off");

    // Flip ON through the unchanged public API — write-through recorded.
    await loaderModule.setPoolEpicSwitch("redis_cache_enabled", true, "test");
    assert(
      recordedSets.some((s) => s.key === "redis_cache_enabled" && s.value === "true"),
      "setPoolEpicSwitch writes through to the settings backend",
    );
    m = getRedisCacheMetrics();
    assert(m.enabled === true, "metrics.enabled true after in-process flip");

    const g1 = await cacheGet("boundary3947", "k1");
    assert(g1 === null, "stubbed Upstash always misses");
    m = getRedisCacheMetrics();
    assert(m.totals.miss === 1, `expected 1 miss, got ${m.totals.miss}`);
    assert(upstashCalls === 1, `expected 1 Upstash call after active get, got ${upstashCalls}`);

    await cacheSet("boundary3947", "k1", { v: 1 }, { ttlSeconds: 60 });
    m = getRedisCacheMetrics();
    assert(m.totals.set === 1, `expected 1 set, got ${m.totals.set}`);
    assert(upstashCalls === 2, `expected 2 Upstash calls after active set, got ${upstashCalls}`);
    assert(m.totals.error === 0, "no cache errors on the stubbed active path");

    let getOrSetLoaderCalls = 0;
    const g2 = await cacheGetOrSet(
      "boundary3947",
      "k2",
      async () => {
        getOrSetLoaderCalls++;
        return { fresh: 42 };
      },
      { ttlSeconds: 60 },
    );
    assert((g2 as any).fresh === 42, "cacheGetOrSet returns the loader value");
    assert(getOrSetLoaderCalls === 1, "loader ran exactly once");
    m = getRedisCacheMetrics();
    assert(m.totals.miss === 2, `expected 2 misses after getOrSet, got ${m.totals.miss}`);
    assert(m.totals.set === 2, `expected 2 sets after getOrSet, got ${m.totals.set}`);
    assert(upstashCalls === 4, `expected 4 Upstash calls (get+set), got ${upstashCalls}`);

    // Flip OFF → bypass returns, Upstash traffic freezes.
    await loaderModule.setPoolEpicSwitch("redis_cache_enabled", false, "test");
    const frozenUpstashCalls = upstashCalls;
    const bypassedBefore = getRedisCacheMetrics().totals.bypassed;
    const g3 = await cacheGet("boundary3947", "k1");
    assert(g3 === null, "cacheGet returns null after flipping off");
    m = getRedisCacheMetrics();
    assert(m.enabled === false, "metrics.enabled false after flipping off");
    assert(
      m.totals.bypassed === bypassedBefore + 1,
      `bypassed counter resumes: expected ${bypassedBefore + 1}, got ${m.totals.bypassed}`,
    );
    assert(upstashCalls === frozenUpstashCalls, "no Upstash traffic after flipping off");
    console.log("[Group3] redis_cache_enabled ON/OFF gates the cache exactly as before");

    // ─── Group 4: fail-open on settings-load failure ───────────────────
    loaderModule.__resetPoolEpicSwitchesForTest();
    settingsImpl = async () => {
      throw new Error("settings backend unavailable (boundary test)");
    };
    assert(
      leafModule.isPoolEpicSwitchEnabled("redis_cache_enabled") === false,
      "redis_cache_enabled serves its hard-coded default (false) under load failure",
    );
    assert(
      leafModule.isPoolEpicSwitchEnabled("health_rollups_enabled") === true,
      "health_rollups_enabled serves its hard-coded default (true) under load failure",
    );
    await loaderModule.ensurePoolEpicSwitchesLoaded();
    assert(
      leafModule.isPoolEpicSwitchEnabled("redis_cache_enabled") === false,
      "still the hard-coded default after ensurePoolEpicSwitchesLoaded resolves on failure",
    );
    assert(getRedisCacheMetrics().enabled === false, "cache gate reads the default under load failure");
    let failOpenLoaderCalls = 0;
    const v4 = await cacheGetOrSet(
      "boundary3947",
      "k4",
      async () => {
        failOpenLoaderCalls++;
        return { ok: true };
      },
      { ttlSeconds: 60 },
    );
    assert(failOpenLoaderCalls === 1 && (v4 as any).ok === true, "getOrSet falls through to its loader while gated off");
    console.log("[Group4] settings-load failure fails open to hard-coded defaults");

    // ─── Group 5: hot flip via the cache-only read path ────────────────
    loaderModule.__resetPoolEpicSwitchesForTest();
    settingsImpl = async () => ({ redis_cache_enabled: "false" });
    await loaderModule.ensurePoolEpicSwitchesLoaded();
    const callsAfterLoad = settingsCalls;
    assert(
      leafModule.isPoolEpicSwitchEnabled("redis_cache_enabled") === false,
      "switch off after explicit load",
    );
    assert(settingsCalls === callsAfterLoad, "fresh-window sync read does not refetch");

    // Out-of-process flip lands in the settings backend.
    settingsImpl = async () => ({ redis_cache_enabled: "true" });

    await cacheGet("boundary3947", "k5");
    assert(settingsCalls === callsAfterLoad, "fresh-window cache read does not refetch settings");
    assert(
      getRedisCacheMetrics().enabled === false,
      "out-of-process flip not yet visible inside the 60s fresh window",
    );

    // Advance the clock past the 60s freshness horizon for the SYNC
    // prefix of one cache read (isActive → isPoolEpicSwitchEnabled →
    // maybeBackgroundRefresh), then restore Date.now before awaiting so
    // the refreshed state records a sane loadedAt.
    let staleRead: Promise<unknown>;
    try {
      Date.now = () => realDateNow() + 61_000;
      staleRead = cacheGet("boundary3947", "k5-stale");
    } finally {
      Date.now = realDateNow;
    }
    await staleRead;
    await poll(
      () => leafModule.isPoolEpicSwitchEnabled("redis_cache_enabled") === true,
      5_000,
      "out-of-process flip visible after a stale cache read",
    );
    assert(settingsCalls > callsAfterLoad, "stale cache read kicked the background settings refresh");
    assert(getRedisCacheMetrics().enabled === true, "cache gate sees the hot-flipped switch");
    console.log("[Group5] hot flip propagates through the cache-only read path (60s stale branch)");

    // ─── Group 6: reset keeps the module-init trigger wired ────────────
    loaderModule.__resetPoolEpicSwitchesForTest();
    const callsBeforePureRead = settingsCalls;
    settingsImpl = async () => ({ redis_cache_enabled: "true" });
    assert(
      leafModule.isPoolEpicSwitchEnabled("redis_cache_enabled") === false,
      "sync read serves the default before the background load lands",
    );
    await poll(
      () => leafModule.isPoolEpicSwitchEnabled("redis_cache_enabled") === true,
      5_000,
      "a pure leaf read after reset triggers the loader via the module-init wiring",
    );
    assert(
      settingsCalls > callsBeforePureRead,
      "trigger reached storage.getSystemSettings with zero manual test wiring",
    );
    console.log("[Group6] __resetPoolEpicSwitchesForTest keeps the boundary wiring intact");
  } finally {
    delete (storage as any).getSystemSettings;
    delete (storage as any).setSystemSetting;
    global.fetch = originalFetch;
    Date.now = realDateNow;
    if (ORIG_URL === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = ORIG_URL;
    if (ORIG_TOKEN === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = ORIG_TOKEN;
    loaderModule.__resetPoolEpicSwitchesForTest();
    __resetRedisCacheMetricsForTest();
    __resetRedisCacheClientForTest();
    // Stop the esbuild service child spawned by the closure trace so the
    // test process drains naturally.
    try {
      const esb = await import("esbuild");
      await esb.stop();
    } catch {
      // service cleanup only; nothing to stop when esbuild never started
    }
  }
}

run()
  .then(() => {
    console.log("✅ redis-cache-kill-switch-boundary: all groups passed");
  })
  .catch((err) => {
    console.error("❌ redis-cache-kill-switch-boundary FAILED:", err);
    process.exitCode = 1;
  });
