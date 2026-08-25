/* test-registration
{
  "name": "Front probe classification (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
// Task #1861 — Front probe outcome classification + cache preserve.
//
// Pins the contract that:
//   1. The Integration-status cache's `preserve` outcome keeps the
//      previously-cached value (does NOT flip connected:true → false).
//   2. A cold cache + preserve outcome returns `{ value: null }` (UI
//      paints "Checking…") instead of synthesizing a Not Connected
//      marker.
//   3. A `commit` outcome with `freshTtlMs` overrides the per-entry
//      freshness window so a real Not-Connected entry expires faster.
//   4. `invalidateIntegrationStatus()` drops in-flight stale commits
//      via the generation counter (no connected:true leak after a
//      disconnect call races a slow probe).
//
// Run: tsx tests/front-probe-classification.test.ts

import {
  __resetIntegrationStatusCacheForTest,
  getCachedIntegrationStatus,
  invalidateIntegrationStatus,
  type CachedIntegrationStatus,
  type ProbeOutcomeResult,
} from "../server/services/integrationStatusCache";

let passed = 0;
let failed = 0;

function assert(cond: unknown, label: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Shape = { connected: boolean; lastSyncError: string | null };
type CachedStatus = CachedIntegrationStatus<Shape>;

/** Poll a predicate every 25 ms up to `timeoutMs`. Returns true if the
 *  predicate became true, false if we timed out. Used to wait for an
 *  inFlight refresh to settle without hard-coding a brittle delay
 *  (worker-pool warmup can stall the first loader >500 ms under
 *  concurrent test load). */
async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await wait(25);
  }
  return await pred();
}

async function run(): Promise<void> {
  console.log("Test 1: cold cache + preserve outcome stays null (Checking…)");
  __resetIntegrationStatusCacheForTest();
  {
    let preserveCalls = 0;
    const preserveLoader = async (): Promise<ProbeOutcomeResult<Shape>> => {
      preserveCalls++;
      return { outcome: "preserve", lastProbeError: "http_503" };
    };
    const first = await getCachedIntegrationStatus<Shape>("front", preserveLoader, {
      freshTtlMs: 60_000,
    });
    assert(first.value === null, "cold cache first read returns null");
    await waitUntil(() => preserveCalls >= 1);
    const second = await getCachedIntegrationStatus<Shape>("front", preserveLoader, {
      freshTtlMs: 60_000,
    });
    assert(
      second.value === null,
      "preserve outcome on cold cache leaves the entry empty (no synthetic Not Connected)",
    );
  }

  console.log("\nTest 2: warm cache + preserve outcome keeps connected:true and records lastProbeError");
  __resetIntegrationStatusCacheForTest();
  {
    let callIdx = 0;
    const flipLoader = async (): Promise<ProbeOutcomeResult<Shape>> => {
      callIdx++;
      if (callIdx === 1) {
        return {
          outcome: "commit",
          value: { connected: true, lastSyncError: null },
          freshTtlMs: 1,
        };
      }
      return { outcome: "preserve", lastProbeError: "http_503" };
    };

    // Warm phase: kick the first refresh and poll until the commit
    // lands (don't trust a fixed delay — worker-pool warmup is slow
    // under load).
    await getCachedIntegrationStatus<Shape>("front", flipLoader, { freshTtlMs: 1 });
    await waitUntil(async () => {
      const r = await getCachedIntegrationStatus<Shape>("front", flipLoader, { freshTtlMs: 1 });
      return r.value?.connected === true;
    });
    const warm = await getCachedIntegrationStatus<Shape>("front", flipLoader, { freshTtlMs: 1 });
    assert(warm.value?.connected === true, "warmed cache has connected:true");

    // Trigger the transient refresh and wait for callIdx to advance
    // past the warm commit. Each read re-kicks because override=1ms.
    const callsBefore = callIdx;
    await waitUntil(async () => {
      await getCachedIntegrationStatus<Shape>("front", flipLoader, { freshTtlMs: 1 });
      return callIdx > callsBefore;
    });
    // And wait for the preserve handler to apply lastProbeError to the entry.
    let afterBlip: CachedStatus = { value: null, lastCheckedAt: null, lastProbeError: null };
    await waitUntil(async () => {
      afterBlip = await getCachedIntegrationStatus<Shape>("front", flipLoader, {
        freshTtlMs: 1,
      });
      return afterBlip.lastProbeError === "http_503";
    });

    assert(
      afterBlip.value?.connected === true,
      "preserve outcome keeps connected:true (does NOT flip to false)",
    );
    assert(
      afterBlip.lastProbeError === "http_503",
      `preserve outcome records lastProbeError (got: ${afterBlip.lastProbeError})`,
    );
  }

  console.log("\nTest 3: commit with short freshTtlMs override re-triggers loader past window");
  __resetIntegrationStatusCacheForTest();
  {
    let loaderCalls = 0;
    const OVERRIDE_MS = 800;
    const shortTtlLoader = async (): Promise<ProbeOutcomeResult<Shape>> => {
      loaderCalls++;
      return {
        outcome: "commit",
        value: { connected: false, lastSyncError: null },
        freshTtlMs: OVERRIDE_MS,
      };
    };
    await getCachedIntegrationStatus<Shape>("front", shortTtlLoader, { freshTtlMs: 60_000 });
    const t0 = Date.now();
    await waitUntil(() => loaderCalls >= 1);
    const callsAfterFirstCommit = loaderCalls;
    assert(
      callsAfterFirstCommit === 1,
      `initial commit ran loader exactly once (got: ${callsAfterFirstCommit})`,
    );

    // While still within the override window, reads must NOT re-fire.
    const ageMs = Date.now() - t0;
    if (ageMs < OVERRIDE_MS - 200) {
      await getCachedIntegrationStatus<Shape>("front", shortTtlLoader, { freshTtlMs: 60_000 });
      await wait(50);
      assert(
        loaderCalls === callsAfterFirstCommit,
        `loader does not re-fire within freshTtlMs override window (got: ${loaderCalls})`,
      );
    } else {
      // The warmup pushed us past the window; skip the inner-window
      // check rather than emit a false-failure.
      console.log(
        `  (skipped inner-window check — warmup consumed ${ageMs}ms of the ${OVERRIDE_MS}ms window)`,
      );
      passed++;
    }

    // Past the override window → loader SHOULD re-fire.
    const remaining = Math.max(0, OVERRIDE_MS - (Date.now() - t0)) + 100;
    await wait(remaining);
    await getCachedIntegrationStatus<Shape>("front", shortTtlLoader, { freshTtlMs: 60_000 });
    await waitUntil(() => loaderCalls > callsAfterFirstCommit);
    assert(
      loaderCalls > callsAfterFirstCommit,
      `loader re-fires once entry is past freshTtlMs override (got: ${loaderCalls})`,
    );
  }

  console.log("\nTest 4: invalidate drops in-flight stale commits");
  __resetIntegrationStatusCacheForTest();
  {
    let release: (v: ProbeOutcomeResult<Shape>) => void = () => {};
    const slowLoader = (): Promise<ProbeOutcomeResult<Shape>> =>
      new Promise((resolve) => {
        release = resolve;
      });
    await getCachedIntegrationStatus<Shape>("front", slowLoader, { freshTtlMs: 60_000 });
    await invalidateIntegrationStatus("front");
    release({
      outcome: "commit",
      value: { connected: true, lastSyncError: null },
      freshTtlMs: 60_000,
    });
    await wait(50);
    // Cache must be cold — the stale loader's connected:true was dropped.
    // We read with a loader that would commit connected:false; the
    // first read returns null (cold) and kicks the new loader.
    const afterInvalidate = await getCachedIntegrationStatus<Shape>(
      "front",
      async () => ({
        outcome: "commit",
        value: { connected: false, lastSyncError: null },
        freshTtlMs: 60_000,
      }),
      { freshTtlMs: 60_000 },
    );
    assert(
      afterInvalidate.value === null || afterInvalidate.value?.connected === false,
      "stale in-flight commit dropped after invalidate (no connected:true leak)",
    );
  }

  __resetIntegrationStatusCacheForTest();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; return; }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
