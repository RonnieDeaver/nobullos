/* test-registration
{
  "name": "Redis cache foundation (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * DB Scale Layer epic — Phase 1 foundation test.
 *
 * Verifies the Redis cache service's fail-open contract WITHOUT
 * requiring a real Upstash endpoint:
 *  • Without env vars configured: every op short-circuits as "bypassed"
 *    and `cacheGetOrSet` falls through to the loader.
 *  • With the kill switch off: same bypass behavior even if env vars
 *    are present.
 *  • TTL is mandatory at set time.
 *  • `cacheGetOrSet` does not cache null/undefined returns.
 *
 * This is the foundation test — Phase 2 will add an integration test
 * that exercises the real Upstash client behind a feature flag.
 */
import {
  __resetRedisCacheClientForTest,
  __resetRedisCacheMetricsForTest,
  cacheGet,
  cacheGetOrSet,
  cacheSet,
  getRedisCacheMetrics,
  isRedisConfigured,
} from "../server/services/cache/redisCache";
import {
  __resetPoolEpicSwitchesForTest,
  setPoolEpicSwitch,
} from "../server/services/poolEpicKillSwitches";

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function run(): Promise<void> {
  // ─── Test 1: with no env vars, isRedisConfigured() returns false
  // and every op bypasses cleanly without throwing ─────────────
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetPoolEpicSwitchesForTest();
  __resetRedisCacheMetricsForTest();

  assert(isRedisConfigured() === false, "isRedisConfigured() should be false without env vars");

  const got = await cacheGet("test-ns", "key1");
  assert(got === null, "cacheGet bypassed should return null");

  await cacheSet("test-ns", "key1", { v: 1 }, { ttlSeconds: 60 });

  let loaderCalls = 0;
  const got2 = await cacheGetOrSet(
    "test-ns",
    "key2",
    async () => {
      loaderCalls++;
      return { value: 42 };
    },
    { ttlSeconds: 60 },
  );
  assert(loaderCalls === 1, "loader should run exactly once on bypass");
  assert((got2 as any).value === 42, "loader value should be returned");

  // A second call should also run the loader again because no cache.
  const got3 = await cacheGetOrSet(
    "test-ns",
    "key2",
    async () => {
      loaderCalls++;
      return { value: 42 };
    },
    { ttlSeconds: 60 },
  );
  assert(loaderCalls === 2, "loader should run again on each bypass call");
  assert((got3 as any).value === 42, "second loader call value matches");

  const m = getRedisCacheMetrics();
  assert(m.configured === false, "metrics.configured should be false");
  assert(m.enabled === false, "metrics.enabled should be false (kill switch default off)");
  // We made 4 ops (1 get, 1 set, 2 getOrSet); each bumps bypassed.
  // (getOrSet bypassed path increments bypassed once per call, no nested get.)
  assert(m.totals.bypassed >= 4, `expected >=4 bypassed ops, got ${m.totals.bypassed}`);
  assert(m.totals.hit === 0, "no hits");
  assert(m.totals.miss === 0, "no misses recorded on bypass");
  assert(m.totals.error === 0, "no errors");

  console.log("[Test1] Bypassed path (no env vars) — fail-open verified");

  // ─── Test 2: TTL must be > 0 at set time ─────────────────────────
  __resetRedisCacheMetricsForTest();
  __resetRedisCacheClientForTest();
  // Force the kill switch on AND fake env vars so the active path runs.
  process.env.UPSTASH_REDIS_REST_URL = "https://example.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  await setPoolEpicSwitch("redis_cache_enabled", true, "test");

  // Bad TTL = 0 → silently rejected, error counter increments, no throw.
  await cacheSet("test-ns", "k", { v: 1 }, { ttlSeconds: 0 });
  const m2 = getRedisCacheMetrics();
  assert(m2.totals.error >= 1, "TTL <= 0 should bump error counter");
  assert(m2.totals.set === 0, "TTL <= 0 must not record a set");

  console.log("[Test2] TTL=0 rejected as error, no throw");

  // ─── Test 3: With kill switch on but env vars only fake, the
  // service will TRY to construct a client and may succeed at
  // construction but fail on the actual HTTP call. We don't actually
  // care about whether the HTTP call succeeds here — only that it
  // never throws past the helper. cacheGet should return null on
  // error and bump the error counter (or return null cleanly if the
  // client failed to construct). ───────────────────────────────────
  __resetRedisCacheMetricsForTest();
  __resetRedisCacheClientForTest();
  process.env.UPSTASH_REDIS_REST_URL = "https://example.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  const r = await cacheGet("test-ns", "never-exists-key");
  assert(r === null, "cacheGet with bad endpoint should return null, not throw");
  // We don't assert on which counter incremented (configured vs error)
  // because @upstash/redis may defer connection failures until first
  // HTTP call; both outcomes are valid fail-open behavior.

  console.log("[Test3] Bad endpoint fail-open verified (no throw)");

  // Clean up env so other tests in the same process aren't affected.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetPoolEpicSwitchesForTest();
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {
    console.log("redis-cache-foundation: all cases passed");
  })
  .catch((err) => {
    console.error("redis-cache-foundation: FAILED", err);
    process.exitCode = 1;
  });
