/* test-registration
{
  "name": "Front recovery dedupe drop rollup persistence (Task #1914)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1914 regression tests for the Front recovery apply-layer drop
 * service's *persisted* state. The Task #1906 suite covers the
 * in-memory escalator; this suite locks down the bits Task #1907 added
 * and that the operator panel actually depends on:
 *
 *   1. A non-dropping verdict deletes the row from
 *      `dedupe_drop_active_chains` (not just the in-memory map) and
 *      clears the alerted flag, so the panel doesn't show a phantom
 *      open chain after the window recovers.
 *
 *   2. The N-consecutive escalator fires the dispatcher exactly once
 *      per chain. After the chain breaks AND re-forms, it fires
 *      again — but a chain that just keeps extending does not
 *      re-fire.
 *
 *   3. Hydrate-from-DB restores BOTH `consecutiveByWindow` and
 *      `alertedWindows`, so a process restart mid-incident does not
 *      lose the chain in the panel and does not re-fire the Slack
 *      alert.
 *
 *   4. `getDedupeDropState()` reads verdict counters from the persisted
 *      rollup, not the in-memory recent-samples buffer.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { storage } from "../server/storage";
import {
  __setDispatcherOverrideForTests,
  __resetStateForTests,
  recordDedupeSample,
  getDedupeDropState,
  SETTING_ENABLED,
  SETTING_CONSECUTIVE_PAGES,
  type DedupeSampleObservation,
  type DedupeSampleVerdict,
} from "../server/services/frontRecoveryDedupeDropAlerts";

const JOB_ID = `t1914_${process.pid}_${Date.now()}`;
const WINDOW = "2099-01_w1";
const WINDOW_KEY = `${JOB_ID}|${WINDOW}`;
// Far-future date so we can write deterministic rows to
// `dedupe_drop_verdict_rollups` without trampling real production
// counts in the shared dev DB.
const FUTURE_DATE = "2099-01-01";
// Use the same far-future date as observedAt so the rollup increments
// from `recordDedupeSample` also land on FUTURE_DATE and get cleaned
// up by the same DELETE.
const FUTURE_TS = Date.UTC(2099, 0, 1, 12, 0, 0);

function makeSample(
  overrides: Partial<DedupeSampleObservation> & {
    verdict: DedupeSampleVerdict;
    pageNumber: number;
  },
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
    observedAt: FUTURE_TS,
    ...overrides,
  };
}

interface DispatchCall {
  id: string;
  options: { dedupeKey?: string; metadata?: Record<string, unknown> };
}

function makeDispatcher(result: { delivered: boolean; status?: string }) {
  const calls: DispatchCall[] = [];
  const fn = async (id: string, _payload: any, options: any) => {
    calls.push({ id, options });
    return result;
  };
  return { fn, calls };
}

async function chainRow(): Promise<
  | {
      consecutive_pages: number;
      first_page_number: number;
      last_page_number: number;
      alerted: boolean;
    }
  | null
> {
  const r = await workerDb.execute<any>(sql`
    SELECT consecutive_pages, first_page_number, last_page_number, alerted
    FROM dedupe_drop_active_chains
    WHERE window_key = ${WINDOW_KEY}
  `);
  const rows = ((r as any).rows ?? []) as any[];
  if (rows.length === 0) return null;
  return {
    consecutive_pages: Number(rows[0].consecutive_pages),
    first_page_number: Number(rows[0].first_page_number),
    last_page_number: Number(rows[0].last_page_number),
    alerted: Boolean(rows[0].alerted),
  };
}

async function cleanup(): Promise<void> {
  __setDispatcherOverrideForTests(null);
  __resetStateForTests();
  await workerDb.execute(sql`
    DELETE FROM dedupe_drop_active_chains WHERE window_key = ${WINDOW_KEY}
  `);
  // getDedupeDropState() → loadPersistedVerdictCounters() aggregates every
  // rollup row with `date >= now - VERDICT_HISTORICAL_WINDOW_DAYS` (and
  // FUTURE_DATE is always in that window), so any rows left behind by a
  // prior run on the shared dev DB leak into this suite's counters. Clear
  // the whole rollup table so the seeded rows are the only ones counted.
  await workerDb.execute(sql`DELETE FROM dedupe_drop_verdict_rollups`);
  for (const k of [SETTING_ENABLED, SETTING_CONSECUTIVE_PAGES]) {
    try {
      await storage.deleteSystemSetting(k);
    } catch {}
  }
}

async function configure(opts: { enabled?: boolean; consecutivePages?: number }) {
  if (opts.enabled !== undefined) {
    await storage.setSystemSetting(
      SETTING_ENABLED,
      opts.enabled ? "true" : "false",
      "system",
    );
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
  await cleanup();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    await cleanup();
  }
}

async function main(): Promise<void> {
  console.log("Front recovery dedupe drop rollup persistence (Task #1914)");

  await step(
    "non-dropping verdict deletes the persisted chain row and clears alerted",
    async () => {
      await configure({ enabled: true, consecutivePages: 2 });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __setDispatcherOverrideForTests(fn);

      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 1 }));
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 2 }));
      assert.equal(calls.length, 1, "alert dispatched at threshold");

      const persisted = await chainRow();
      assert.ok(persisted, "chain row persisted after threshold");
      assert.equal(persisted!.consecutive_pages, 2);
      assert.equal(persisted!.alerted, true, "DB row reflects alerted=true");

      // Chain-break: any non-dropping verdict must delete the DB row,
      // not just the in-memory map.
      await recordDedupeSample(makeSample({ verdict: "mixed", pageNumber: 3 }));
      assert.equal(await chainRow(), null, "chain row deleted on chain-break");

      // After the chain breaks AND re-forms, the dispatcher fires again.
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 4 }));
      await recordDedupeSample(makeSample({ verdict: "apply_layer_dropping", pageNumber: 5 }));
      assert.equal(calls.length, 2, "alert re-fires on a fresh chain");

      const reformed = await chainRow();
      assert.ok(reformed);
      assert.equal(reformed!.first_page_number, 4, "row tracks the new chain start");
      assert.equal(reformed!.alerted, true);
    },
  );

  await step(
    "single chain that keeps extending fires the dispatcher exactly once",
    async () => {
      await configure({ enabled: true, consecutivePages: 3 });
      const { fn, calls } = makeDispatcher({ delivered: true });
      __setDispatcherOverrideForTests(fn);

      for (let p = 1; p <= 10; p++) {
        await recordDedupeSample(
          makeSample({ verdict: "apply_layer_dropping", pageNumber: p }),
        );
      }
      assert.equal(calls.length, 1, "dispatcher invoked exactly once for the chain");

      const persisted = await chainRow();
      assert.ok(persisted);
      assert.equal(persisted!.consecutive_pages, 10);
      assert.equal(persisted!.last_page_number, 10);
      assert.equal(persisted!.alerted, true);
    },
  );

  await step(
    "hydrate-from-DB restores chain count AND alerted flag (no re-fire after restart)",
    async () => {
      await configure({ enabled: true, consecutivePages: 3 });

      // Simulate prior process: a chain of 5 dropping samples that
      // already alerted. Write directly to the DB and then nuke
      // in-memory state so the next `recordDedupeSample` is forced
      // through `ensureHydrated` against our persisted row.
      await workerDb.execute(sql`
        INSERT INTO dedupe_drop_active_chains
          (window_key, job_id, window_label, consecutive_pages,
           first_page_number, last_page_number, observed_at, alerted)
        VALUES
          (${WINDOW_KEY}, ${JOB_ID}, ${WINDOW}, 5, 1, 5, ${FUTURE_TS}, TRUE)
      `);

      __resetStateForTests();
      const { fn, calls } = makeDispatcher({ delivered: true });
      __setDispatcherOverrideForTests(fn);

      // Restart-equivalent sample. With hydrate working, `count`
      // becomes 6 and `alertedWindows` already contains the key, so
      // the dispatcher must NOT be invoked.
      await recordDedupeSample(
        makeSample({ verdict: "apply_layer_dropping", pageNumber: 6 }),
      );
      assert.equal(
        calls.length,
        0,
        "no Slack re-fire after restart while incident is ongoing",
      );

      const persisted = await chainRow();
      assert.ok(persisted);
      assert.equal(persisted!.consecutive_pages, 6, "hydrated count extended, not reset");
      assert.equal(persisted!.first_page_number, 1, "original chain start preserved");
      assert.equal(persisted!.alerted, true);

      const state = await getDedupeDropState();
      const chain = state.activeChains.find((c) => c.windowLabel === WINDOW);
      assert.ok(chain, "panel still sees the chain after restart");
      assert.equal(chain!.consecutivePages, 6);
      assert.equal(chain!.alerted, true);
    },
  );

  await step(
    "hydrated chain below threshold still alerts once when the next sample crosses it",
    async () => {
      await configure({ enabled: true, consecutivePages: 3 });

      // Pre-restart chain of 2 (below threshold, not yet alerted).
      await workerDb.execute(sql`
        INSERT INTO dedupe_drop_active_chains
          (window_key, job_id, window_label, consecutive_pages,
           first_page_number, last_page_number, observed_at, alerted)
        VALUES
          (${WINDOW_KEY}, ${JOB_ID}, ${WINDOW}, 2, 1, 2, ${FUTURE_TS}, FALSE)
      `);

      __resetStateForTests();
      const { fn, calls } = makeDispatcher({ delivered: true });
      __setDispatcherOverrideForTests(fn);

      // Post-restart sample takes count 2 → 3 and trips the threshold.
      await recordDedupeSample(
        makeSample({ verdict: "apply_layer_dropping", pageNumber: 3 }),
      );
      assert.equal(calls.length, 1, "alert fires when hydrated chain crosses threshold");

      const persisted = await chainRow();
      assert.ok(persisted);
      assert.equal(persisted!.alerted, true);
      assert.equal(persisted!.consecutive_pages, 3);
    },
  );

  await step(
    "getDedupeDropState verdict counters come from the rollup, not the in-memory buffer",
    async () => {
      // Seed the persisted rollup directly. No samples are recorded
      // here, so anything appearing in `verdictCounters` can only
      // come from the rollup table.
      await workerDb.execute(sql`
        INSERT INTO dedupe_drop_verdict_rollups
          (date, verdict, count, first_seen_at, last_seen_at)
        VALUES
          (${FUTURE_DATE}, 'apply_layer_dropping', 100, ${FUTURE_TS}, ${FUTURE_TS}),
          (${FUTURE_DATE}, 'coverage_denominator_likely_wrong', 25, ${FUTURE_TS}, ${FUTURE_TS}),
          (${FUTURE_DATE}, 'mixed', 5, ${FUTURE_TS}, ${FUTURE_TS})
      `);

      const initial = await getDedupeDropState();
      assert.equal(initial.aggregate.sampleCount, 0, "no in-memory samples yet");
      assert.equal(initial.recentSamples.length, 0);
      assert.equal(initial.verdictCounters.apply_layer_dropping, 100);
      assert.equal(initial.verdictCounters.coverage_denominator_likely_wrong, 25);
      assert.equal(initial.verdictCounters.mixed, 5);
      // 100 / (100 + 25 + 5) = 0.769...
      assert.ok(
        Math.abs(initial.aggregate.applyLayerDropRate - 100 / 130) < 1e-9,
        "drop rate derived from rollup totals",
      );

      // Record one mixed sample. The in-memory buffer grows by 1, but
      // verdictCounters still reflect the rollup (which now also
      // includes the +1 mixed increment from `persistVerdictIncrement`).
      await configure({ enabled: true, consecutivePages: 99 });
      __setDispatcherOverrideForTests(makeDispatcher({ delivered: true }).fn);
      await recordDedupeSample(
        makeSample({ verdict: "mixed", pageNumber: 1, dedupePct: 0.1 }),
      );

      const after = await getDedupeDropState();
      assert.equal(after.aggregate.sampleCount, 1, "in-memory buffer reflects the one new sample");
      assert.equal(after.recentSamples.length, 1);
      // Rollup totals: apply_layer_dropping=100 unchanged; mixed=5+1.
      assert.equal(
        after.verdictCounters.apply_layer_dropping,
        100,
        "rollup value persists across calls (not derived from in-memory)",
      );
      assert.equal(after.verdictCounters.mixed, 6);
      // The in-memory buffer has only one mixed sample, but the drop
      // rate is still computed from the rollup (100/131), not from
      // the buffer (0/1).
      assert.ok(
        Math.abs(after.aggregate.applyLayerDropRate - 100 / 131) < 1e-9,
        "applyLayerDropRate independent of in-memory verdict mix",
      );
    },
  );

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exitCode = 1;
  }
  console.log("\nAll Task #1914 dedupe drop rollup persistence tests passed");
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
