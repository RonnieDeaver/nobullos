/* test-registration
{
  "name": "Front all-windows re-arm progress indicator (Task #2168)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/oneWindowReArmDrainSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2148 — All-windows "Re-arm all (search strategy)" progress
 * indicator (`getFrontAutoClosureStatus().allReArmDrain`).
 *
 * Task #2148 surfaced live running/finished progress for the all-windows
 * `rearm_parked_front_recovery_windows` drain through the new
 * `allReArmDrain` field on the auto-closure status payload, mirroring the
 * per-window `reArmDrains[month]` badges (covered by
 * `tests/front-rearm-badge.test.ts`). The all-windows drain WIRING is
 * pinned by `tests/front-all-windows-rearm-drain.test.ts`, but its
 * projection into `allReArmDrain` had no direct coverage, so a regression
 * that dropped or mis-shaped that field would go unnoticed. This file
 * pins:
 *
 *   1. `allReArmDrain` is null when no all-windows drain has run this
 *      process (the per-window map / badges are independent of it).
 *   2. Starting the all-windows drain via `startParkedWindowReArmDrain`
 *      surfaces `allReArmDrain` as RUNNING (running=true, finishedAt=null,
 *      processed/totalAtStart populated) while the gated Front walk is
 *      held mid-flight, then flips to the terminal outcome once released
 *      (running=false, ISO finishedAt, dominant lastOutcomeKind).
 *
 * The Front walk (`runTargetedWindowBackfill`) is gated/redirected and the
 * drain's finalize-audit (`recordProdActionRun`) is redirected to in-memory
 * stubs via a Node ESM resolve hook (registered through
 * `--import ./tests/helpers/oneWindowReArmDrainSetup.mjs` in run-all.ts —
 * shared with the Task #2119 / #2151 siblings), so this suite makes no
 * real Front API calls and never writes the `prod_action_runs` table.
 *
 * State note: like the sibling re-arm suites, this reads/writes the shared
 * persisted auto-closure state in `system_settings`, which the live dev
 * server's `runFrontAutoClosureTick` also mutates. The all-windows drain
 * enumerates the WHOLE parked set, so to keep the counts deterministic
 * this suite snapshots the existing `parkedWindows` map, replaces it with
 * only its own far-future (2996-*) test windows for the duration of a
 * case, and restores the snapshot afterwards.
 *
 * Usage: tsx --import ./tests/helpers/oneWindowReArmDrainSetup.mjs \
 *            tests/front-rearm-all-drain-progress.test.ts
 */
import assert from "node:assert/strict";
import {
  getFrontAutoClosureStatus,
  startParkedWindowReArmDrain,
  createInMemoryStateStore,
} from "../server/services/frontAutoClosure";
import {
  getDrainState,
  isDrainRunning,
  __resetDrainsForTest,
} from "../server/services/prodActionBackgroundDrain";
import {
  setPoolEpicSwitch,
  isPoolEpicSwitchEnabled,
  ensurePoolEpicSwitchesLoaded,
} from "../server/services/poolEpicKillSwitches";
import {
  __getRecordedRuns,
  __resetRecordedRuns,
} from "./helpers/prodActionRunsStub.mjs";
import {
  __setNextCheckpoint,
  __installGate,
  __resetStub,
} from "./helpers/frontHistoricalRecoveryReArmStub.mjs";

const FUTURE_YEAR = 2996;

// Task #2239 — drive an injected in-memory store instead of read-modify-
// writing the global `front_auto_closure_state` setting on the shared dev
// DB. Re-created per case to reset; the all-windows drain reads it through
// the explicit `stateStore` param.
let stateStore = createInMemoryStateStore();
const SEARCH_SWITCH = "front_recovery_sparse_month_search_strategy_enabled";
const ALL_ACTION_ID = "rearm_parked_front_recovery_windows";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function mkParkedEntry(): any {
  return {
    parkedAt: "2030-04-01T00:00:00Z",
    reason: "dead_run_streak:3_runs",
    deadRuns: 3,
    lastCheckpointAt: "2030-04-01T00:00:00Z",
  };
}

/**
 * Replace the entire `parkedWindows` map with exactly `entries`. The
 * all-windows drain enumerates every parked window, so the suite owns the
 * whole map while a case runs and restores the original afterwards.
 */
async function setParked(entries: Record<string, any>): Promise<void> {
  const state = await stateStore.load();
  state.parkedWindows = entries;
  await stateStore.save(state);
}

// ── 1. No all-windows drain this process → allReArmDrain is null. ───────
async function testNullWhenNoDrain(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();

  // A parked window that never had an all-windows drain run against it:
  // the per-window badge map may be empty too, but the all-windows field
  // must be explicitly null (not undefined, not a stale object).
  await setParked({ [`${FUTURE_YEAR}-01`]: mkParkedEntry() });

  const status = await getFrontAutoClosureStatus({ stateStore });
  assert.equal(
    status.allReArmDrain,
    null,
    "allReArmDrain is null when no all-windows drain has run this process",
  );
}

// ── 2. Running → finished projection for the all-windows drain. ─────────
async function testRunningThenFinished(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  __resetStub();
  stateStore = createInMemoryStateStore();
  await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");
  // The stub default classifies as `still_empty` (page-cap dead run, 0
  // ingested) — every re-armed window stays parked and gets a terminal
  // outcome so the drain converges after a single pass over the set.
  __setNextCheckpoint({
    status: "partial",
    statusReason:
      "safety_max_pages_reached_resume_available scanned=25000 ingested=0",
    ingested: 0,
  });

  const months = [`${FUTURE_YEAR}-02`, `${FUTURE_YEAR}-03`];
  const N = months.length;
  const entries: Record<string, any> = {};
  for (const m of months) entries[m] = mkParkedEntry();
  await setParked(entries);

  // Gate the first Front walk so the drain is observably "running" before
  // we let it finish.
  const releaseGate = __installGate();

  const res = await startParkedWindowReArmDrain("actor-2148", stateStore);
  assert.equal(res.state, "started", "eligible windows start a drain");
  assert.equal(res.totalParked, N, "countPending counts the eligible windows");

  // RUNNING snapshot: the all-windows field is populated, reports running,
  // has no finishedAt, and exposes processed / totalAtStart progress.
  const runningStatus = await getFrontAutoClosureStatus({ stateStore });
  const running = runningStatus.allReArmDrain;
  assert.ok(running, "allReArmDrain is populated once the drain starts");
  assert.equal(running!.running, true, "drain reports running before release");
  assert.equal(running!.finishedAt, null, "no finishedAt while running");
  assert.equal(running!.totalAtStart, N, "totalAtStart reflects the epoch set");
  assert.equal(
    typeof running!.processed,
    "number",
    "processed is a number while running",
  );
  assert.ok(running!.processed < N, "not all windows processed yet (gated)");
  assert.equal(
    running!.startedAt,
    new Date(running!.startedAt!).toISOString(),
    "startedAt is a valid ISO timestamp",
  );

  // Release the gate and wait for the drain to finalize (single audit row).
  releaseGate();
  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  // Task #2234 reversed finalize ordering (audit row lands BEFORE the
  // finishedAt flip), so poll the flag instead of asserting immediately.
  await waitFor(() => isDrainRunning(ALL_ACTION_ID) === false, 5000, "drain finished");

  // FINISHED snapshot: running flips false, finishedAt is ISO, processed
  // reaches N, and the dominant outcome kind surfaces.
  const doneStatus = await getFrontAutoClosureStatus({ stateStore });
  const done = doneStatus.allReArmDrain;
  assert.ok(done, "allReArmDrain still populated once finished");
  assert.equal(done!.running, false, "drain reports finished after release");
  assert.ok(done!.finishedAt, "finishedAt populated once finished");
  assert.equal(
    done!.finishedAt,
    new Date(done!.finishedAt!).toISOString(),
    "finishedAt is a valid ISO timestamp",
  );
  assert.equal(done!.processed, N, "all eligible windows processed");
  assert.equal(done!.totalAtStart, N, "totalAtStart unchanged once finished");
  assert.equal(
    done!.lastOutcomeKind,
    "still_empty",
    "dominant outcome kind (still_empty) is projected once finished",
  );

  // Sanity: the projection reads the same in-memory drain the primitive
  // tracks under the all-windows actionId.
  assert.ok(
    getDrainState(ALL_ACTION_ID),
    "drain state registered under the all-windows actionId",
  );
}

async function main(): Promise<void> {
  await ensurePoolEpicSwitchesLoaded();
  const origSwitch = isPoolEpicSwitchEnabled(SEARCH_SWITCH);
  try {
    const cases: Array<[string, () => Promise<void>]> = [
      ["allReArmDrain is null with no all-windows drain", testNullWhenNoDrain],
      [
        "allReArmDrain reports running then finished",
        testRunningThenFinished,
      ],
    ];
    for (const [name, fn] of cases) {
      try {
        await fn();
        console.log(`  ✓ ${name}`);
      } catch (err: any) {
        console.error(`  ✗ ${name}: ${err?.stack ?? err?.message ?? err}`);
        process.exitCode = 1;
      }
    }
    if (process.exitCode && process.exitCode !== 0) {
      throw new Error("front-rearm-all-drain-progress test cases failed");
    }
    console.log("front-rearm-all-drain-progress: OK");
  } finally {
    await setPoolEpicSwitch(SEARCH_SWITCH, origSwitch, "system");
    // No parked-state restore needed: each case drives a fresh in-memory
    // store (Task #2239), so nothing was written to the shared dev DB.
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {
    // Importing frontAutoClosure / server/db warms pool connections that
    // keep the event loop alive. Exit explicitly so the run-all child
    // terminates instead of tripping the per-test timeout.
  },
  (err) => {
    console.error("front-rearm-all-drain-progress: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
