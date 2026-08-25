/* test-registration
{
  "name": "Front recovery dedupe drop alerts (Task #1906)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1906 regression tests for `frontRecoveryDedupeDropAlerts`.
 *
 * Covers the apply-layer drop escalation added in Task #1872:
 *   - consecutive `apply_layer_dropping` samples reach threshold → one alert
 *   - non-dropping verdict breaks the chain and clears the alerted flag
 *   - `front_recovery_dedupe_drop_alert_enabled=false` suppresses the
 *     alert but still records samples and counters
 *   - dispatcher `skipped_deduped` still marks the window as alerted so
 *     the next sample does not retry
 *   - `getDedupeDropState()` aggregate numbers match recorded samples
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import {
  __setDispatcherOverrideForTests,
  __resetStateForTests,
  __setPersistenceDisabledForTests,
  recordDedupeSample,
  getDedupeDropState,
  SETTING_ENABLED,
  SETTING_CONSECUTIVE_PAGES,
  type DedupeSampleObservation,
  type DedupeSampleVerdict,
} from "../server/services/frontRecoveryDedupeDropAlerts";

const SETTING_KEYS = [SETTING_ENABLED, SETTING_CONSECUTIVE_PAGES] as const;

const JOB_ID = `t1906_${process.pid}_${Date.now()}`;
const WINDOW = "2024-01_w1";

function makeSample(
  overrides: Partial<DedupeSampleObservation> & { verdict: DedupeSampleVerdict; pageNumber: number },
): DedupeSampleObservation {
  return {
    jobId: JOB_ID,
    windowLabel: WINDOW,
    pageScanned: 100,
    pageDedupeSkipped: 90,
    dedupePct: 0.9,
    sampleSize: 10,
    applied: 0,
    discovered: 8,
    missing: 2,
    otherStates: 0,
    observedAt: Date.now(),
    ...overrides,
  };
}

interface DispatchCall {
  id: string;
  payload: { text: string; preview?: string };
  options: { triggerSource: string; dedupeKey?: string; metadata?: Record<string, unknown> };
}

function makeDispatcher(result: { delivered: boolean; status?: string; skipReason?: string }) {
  const calls: DispatchCall[] = [];
  const fn = async (id: string, payload: any, options: any) => {
    calls.push({ id, payload, options });
    return result;
  };
  return { fn, calls };
}

async function resetAll(): Promise<void> {
  for (const k of SETTING_KEYS) {
    try {
      await storage.deleteSystemSetting(k);
    } catch {}
  }
  __resetStateForTests();
  __setDispatcherOverrideForTests(null);
  // This suite exercises the in-memory escalator only; disable rollup /
  // active-chain persistence so it never reads or writes the shared dev
  // DB tables (kept hermetic). The persisted path is covered by the
  // Task #1914 rollup suite.
  __setPersistenceDisabledForTests(true);
}

async function configure(opts: { enabled?: boolean; consecutivePages?: number }): Promise<void> {
  if (opts.enabled !== undefined) {
    await storage.setSystemSetting(SETTING_ENABLED, opts.enabled ? "true" : "false", "system");
  }
  if (opts.consecutivePages !== undefined) {
    await storage.setSystemSetting(
      SETTING_CONSECUTIVE_PAGES,
      String(opts.consecutivePages),
      "system",
    );
  }
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  await resetAll();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    await resetAll();
  }
}

async function main(): Promise<void> {
  console.log("Front recovery dedupe drop alerts (Task #1906)");

  await step(
    "streak reaches threshold → alert fires exactly once and dedupes on next sample",
    async () => {
      await configure({ enabled: true, consecutivePages: 3 });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __setDispatcherOverrideForTests(fn);

      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 1 }));
      assert.equal(calls.length, 0, "no alert below threshold (page 1)");
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 2 }));
      assert.equal(calls.length, 0, "no alert below threshold (page 2)");
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 3 }));
      assert.equal(calls.length, 1, "alert fires once threshold reached");

      assert.equal(calls[0].id, "integration.front.recovery_apply_layer_drop");
      assert.equal(calls[0].options.dedupeKey, `${JOB_ID}|${WINDOW}`);
      assert.equal((calls[0].options.metadata as any)?.consecutivePages, 3);
      assert.equal((calls[0].options.metadata as any)?.threshold, 3);
      assert.equal((calls[0].options.metadata as any)?.firstPageNumber, 1);
      assert.equal((calls[0].options.metadata as any)?.lastPageNumber, 3);

      // Subsequent dropping page extends the chain but does NOT re-alert.
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 4 }));
      assert.equal(calls.length, 1, "dedupes on next sample within same window");

      const state = await getDedupeDropState();
      const chain = state.activeChains.find((c) => c.windowLabel === WINDOW);
      assert.ok(chain, "active chain still tracked");
      assert.equal(chain!.consecutivePages, 4);
      assert.equal(chain!.alerted, true);
    },
  );

  await step(
    "non-dropping verdict breaks the chain and clears the alerted flag (re-alert allowed)",
    async () => {
      await configure({ enabled: true, consecutivePages: 2 });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __setDispatcherOverrideForTests(fn);

      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 1 }));
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 2 }));
      assert.equal(calls.length, 1, "first alert fires");

      // Chain-breaker: any non-dropping verdict clears window state.
      await recordDedupeSample(makeSample({ verdict: "mixed", pageNumber: 3 }));
      let state = await getDedupeDropState();
      assert.equal(
        state.activeChains.find((c) => c.windowLabel === WINDOW),
        undefined,
        "active chain removed on chain-break",
      );

      // After the chain breaks, a fresh streak must be able to alert again.
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 4 }));
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 5 }));
      assert.equal(calls.length, 2, "alert fires again after chain clears");

      // Also verify the `coverage_denominator_likely_wrong` verdict
      // breaks the chain identically.
      await recordDedupeSample(makeSample({ verdict: "coverage_denominator_likely_wrong", pageNumber: 6 }));
      state = await getDedupeDropState();
      assert.equal(
        state.activeChains.find((c) => c.windowLabel === WINDOW),
        undefined,
        "coverage_denominator_likely_wrong also clears chain",
      );
    },
  );

  await step(
    "enabled=false suppresses the alert but still records samples + counters",
    async () => {
      await configure({ enabled: false, consecutivePages: 2 });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __setDispatcherOverrideForTests(fn);

      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 1 }));
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 2 }));
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 3 }));
      assert.equal(calls.length, 0, "disabled flag suppresses dispatch");

      const state = await getDedupeDropState();
      assert.equal(state.verdictCounters.apply_layer_dropping, 3, "counter still incremented");
      assert.equal(state.recentSamples.length, 3, "samples still recorded");
      // Chain is still tracked while dropping continues — the disable
      // switch silences the dispatcher, it does not stop bookkeeping.
      const chain = state.activeChains.find((c) => c.windowLabel === WINDOW);
      assert.ok(chain, "chain tracked even when disabled");
      assert.equal(chain!.consecutivePages, 3);
      assert.equal(chain!.alerted, false, "never marked alerted when disabled");
    },
  );

  await step(
    "dispatcher skipped_deduped still marks window as alerted (no retry loop)",
    async () => {
      await configure({ enabled: true, consecutivePages: 2 });
      const { fn, calls } = makeDispatcher({
        delivered: false,
        status: "skipped_deduped",
        skipReason: "dispatcher dedupe window",
      });
      __setDispatcherOverrideForTests(fn);

      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 1 }));
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 2 }));
      assert.equal(calls.length, 1, "dispatcher invoked once");

      // Even though `delivered=false`, status=skipped_deduped must
      // flip the alertedWindows flag — otherwise every subsequent
      // dropping sample would call the dispatcher again.
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 3 }));
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 4 }));
      assert.equal(calls.length, 1, "no dispatcher retry after skipped_deduped");

      const chain = (await getDedupeDropState()).activeChains.find((c) => c.windowLabel === WINDOW);
      assert.ok(chain);
      assert.equal(chain!.alerted, true, "window marked alerted on skipped_deduped");
    },
  );

  await step(
    "dispatcher non-delivered + non-deduped does NOT mark alerted (retry on next sample)",
    async () => {
      await configure({ enabled: true, consecutivePages: 2 });
      const { fn, calls } = makeDispatcher({
        delivered: false,
        status: "skipped_disabled",
        skipReason: "channel disabled",
      });
      __setDispatcherOverrideForTests(fn);

      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 1 }));
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 2 }));
      assert.equal(calls.length, 1);

      // Not yet marked alerted → next dropping sample retries dispatch.
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 3 }));
      assert.equal(calls.length, 2, "dispatcher retried while not flagged alerted");

      const chain = (await getDedupeDropState()).activeChains.find((c) => c.windowLabel === WINDOW);
      assert.equal(chain?.alerted, false);
    },
  );

  await step(
    "getDedupeDropState aggregate numbers match the recorded samples",
    async () => {
      await configure({ enabled: true, consecutivePages: 99 });
      __setDispatcherOverrideForTests(makeDispatcher({ delivered: true }).fn);

      await recordDedupeSample(
        makeSample({ verdict: "apply_layer_dropping", pageNumber: 1, dedupePct: 0.9 }),
      );
      await recordDedupeSample(
        makeSample({ verdict: "apply_layer_dropping", pageNumber: 2, dedupePct: 0.8 }),
      );
      await recordDedupeSample(
        makeSample({ verdict: "coverage_denominator_likely_wrong", pageNumber: 3, dedupePct: 0.5 }),
      );
      await recordDedupeSample(
        makeSample({ verdict: "mixed", pageNumber: 4, dedupePct: 0.4 }),
      );

      const state = await getDedupeDropState();
      assert.equal(state.aggregate.sampleCount, 4);
      assert.equal(state.recentSamples.length, 4);
      // 2 of 4 dropping → 0.5
      assert.equal(state.aggregate.applyLayerDropRate, 0.5);
      // (0.9 + 0.8 + 0.5 + 0.4) / 4 = 0.65
      assert.ok(Math.abs(state.aggregate.avgDedupePct - 0.65) < 1e-9);

      assert.equal(state.verdictCounters.apply_layer_dropping, 2);
      assert.equal(state.verdictCounters.coverage_denominator_likely_wrong, 1);
      assert.equal(state.verdictCounters.mixed, 1);

      // Most recent samples come first (unshift order).
      assert.equal(state.recentSamples[0].pageNumber, 4);
      assert.equal(state.recentSamples[3].pageNumber, 1);
    },
  );

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exitCode = 1;
  }
  console.log("\nAll Front recovery dedupe drop alert tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error("Test runner crashed:", err);
    process.exitCode = 1;
  });
