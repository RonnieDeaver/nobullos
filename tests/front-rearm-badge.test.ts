/* test-registration
{
  "name": "Front re-arm progress badge projection (Task #2149)",
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
 * Task #2149 — Re-arm progress badge coverage.
 *
 * Task #2118 surfaces per-window re-arm drain state through
 * `getFrontAutoClosureStatus().reArmDrains` so the admin panel can render
 * a running / finished badge for each parked month being re-driven by its
 * `rearm_parked_front_recovery_window_${month}` drain. The projection
 * itself (`collectReArmDrainStatuses`) and the status payload it feeds had
 * no direct test. This file pins:
 *
 *   1. (pure) `collectReArmDrainStatuses` projects the in-memory
 *      `DrainState` to the JSON-safe badge view: `running` reflects
 *      `finishedAt === null`, epoch `startedAt` / `finishedAt` become ISO
 *      strings, `lastOutcomeKind` is the per-key tally's DOMINANT key
 *      (highest count), null when the tally is empty, and a month with no
 *      drain is omitted entirely. The module is passed in as a parameter
 *      so this case is a pure injection — no DB / state I/O.
 *
 *   2. (integration) `getFrontAutoClosureStatus().reArmDrains[month]`
 *      reports a started per-window drain as `running` (no `finishedAt`),
 *      then flips to finished with the right `lastOutcomeKind` and an ISO
 *      `finishedAt` once the drain completes. The drain is registered
 *      directly under the per-window `actionId` with a GATED chunk so the
 *      running snapshot is observed deterministically before the chunk is
 *      released.
 *
 * The drain's finalize-audit (`recordProdActionRun`) is redirected to an
 * in-memory stub via the shared Node ESM resolve hook (registered through
 * `--import ./tests/helpers/oneWindowReArmDrainSetup.mjs` in run-all.ts),
 * so this suite never writes the `prod_action_runs` table.
 *
 * State note: like the sibling re-arm suites, the integration case
 * reads/writes the shared persisted auto-closure state in
 * `system_settings`, which the live dev server's `runFrontAutoClosureTick`
 * also mutates. All persisted rows use a unique far-future month prefix
 * (2997-*) that never appears in the coverage table, so the dev server's
 * read-modify-write preserves them and this suite cleans them up before
 * and after.
 *
 * Usage: tsx --import ./tests/helpers/oneWindowReArmDrainSetup.mjs \
 *            tests/front-rearm-badge.test.ts
 */
import assert from "node:assert/strict";
import {
  getFrontAutoClosureStatus,
  createInMemoryStateStore,
  __frontAutoClosureTestHelpers,
} from "../server/services/frontAutoClosure";
import {
  startBackgroundDrain,
  isDrainRunning,
  __resetDrainsForTest,
} from "../server/services/prodActionBackgroundDrain";
import { __resetRecordedRuns } from "./helpers/prodActionRunsStub.mjs";

const { collectReArmDrainStatuses } = __frontAutoClosureTestHelpers;

const FUTURE_YEAR = 2997;

// Task #2239 — the integration case drives an injected in-memory store
// instead of read-modify-writing the global `front_auto_closure_state`
// setting on the shared dev DB. Re-created per case to reset.
let stateStore = createInMemoryStateStore();

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

async function seedParkedWindow(month: string): Promise<void> {
  const state = await stateStore.load();
  state.parkedWindows = state.parkedWindows ?? {};
  state.parkedWindows[month] = {
    parkedAt: "2030-04-01T00:00:00Z",
    reason: "dead_run_streak:3_runs",
    deadRuns: 3,
    lastCheckpointAt: "2030-04-01T00:00:00Z",
  } as any;
  await stateStore.save(state);
}

// ── 1. Pure projection — collectReArmDrainStatuses. ─────────────────────
function testProjectionPure(): void {
  const runningMonth = "2997-01";
  const finishedMonth = "2997-02";
  const emptyTallyMonth = "2997-03";
  const noDrainMonth = "2997-04";

  const startedAtMs = 1_700_000_000_000;
  const finishedAtMs = 1_700_000_005_000;

  // Stand-in DrainState records keyed by the per-window actionId. The
  // dominant outcome-kind for the finished drain is `re_armed` (3), which
  // must win over `still_empty` (1) and `unparked` (2) even though they
  // are inserted in a non-sorted order.
  const states: Record<string, any> = {
    [`rearm_parked_front_recovery_window_${runningMonth}`]: {
      actionId: `rearm_parked_front_recovery_window_${runningMonth}`,
      startedAt: startedAtMs,
      finishedAt: null,
      totalAtStart: 3,
      processed: 1,
      perKey: { re_armed: 1 },
      chunks: 1,
      error: null,
      actorId: "actor-x",
      unit: "window(s)",
    },
    [`rearm_parked_front_recovery_window_${finishedMonth}`]: {
      actionId: `rearm_parked_front_recovery_window_${finishedMonth}`,
      startedAt: startedAtMs,
      finishedAt: finishedAtMs,
      totalAtStart: 6,
      processed: 6,
      perKey: { still_empty: 1, re_armed: 3, unparked: 2 },
      chunks: 3,
      error: null,
      actorId: "actor-y",
      unit: "window(s)",
    },
    [`rearm_parked_front_recovery_window_${emptyTallyMonth}`]: {
      actionId: `rearm_parked_front_recovery_window_${emptyTallyMonth}`,
      startedAt: startedAtMs,
      finishedAt: finishedAtMs,
      totalAtStart: 1,
      processed: 0,
      perKey: {},
      chunks: 0,
      error: null,
      actorId: null,
      unit: "window(s)",
    },
  };

  const fakeMod = {
    getDrainState: (actionId: string) => states[actionId],
    formatDrainProgress: (s: any) => `progress:${s.processed}/${s.totalAtStart}`,
  } as any;

  const out = collectReArmDrainStatuses(fakeMod, [
    runningMonth,
    finishedMonth,
    emptyTallyMonth,
    noDrainMonth,
  ]);

  // Running drain: running=true, finishedAt=null, ISO startedAt.
  const r = out[runningMonth];
  assert.ok(r, "running month is projected");
  assert.equal(r.running, true, "finishedAt===null ⇒ running:true");
  assert.equal(r.finishedAt, null, "running drain has no finishedAt");
  assert.equal(
    r.startedAt,
    new Date(startedAtMs).toISOString(),
    "startedAt epoch projected to ISO",
  );
  assert.equal(r.processed, 1);
  assert.equal(r.totalAtStart, 3);
  assert.equal(r.lastOutcomeKind, "re_armed", "single-key tally is dominant");
  assert.equal(r.progress, "progress:1/3", "progress comes from the module");
  assert.equal(r.error, null);

  // Finished drain: running=false, ISO finishedAt, DOMINANT outcome kind.
  const f = out[finishedMonth];
  assert.ok(f, "finished month is projected");
  assert.equal(f.running, false, "finishedAt set ⇒ running:false");
  assert.equal(
    f.startedAt,
    new Date(startedAtMs).toISOString(),
    "finished drain startedAt is ISO",
  );
  assert.equal(
    f.finishedAt,
    new Date(finishedAtMs).toISOString(),
    "finished drain finishedAt is ISO",
  );
  assert.equal(
    f.lastOutcomeKind,
    "re_armed",
    "dominant outcome = highest tally (re_armed:3 > unparked:2 > still_empty:1)",
  );

  // Empty tally ⇒ lastOutcomeKind null (no chunk recorded an outcome yet).
  const e = out[emptyTallyMonth];
  assert.ok(e, "empty-tally month is still projected");
  assert.equal(
    e.lastOutcomeKind,
    null,
    "empty perKey ⇒ lastOutcomeKind null, not a crash",
  );

  // A parked month with no drain registered is omitted entirely.
  assert.equal(
    out[noDrainMonth],
    undefined,
    "a month with no in-memory drain is not projected",
  );
  assert.equal(
    Object.keys(out).length,
    3,
    "only months with a drain appear in the badge map",
  );
}

// ── 2. Integration — getFrontAutoClosureStatus().reArmDrains[month]. ─────
async function testStatusBadgeRunningThenFinished(): Promise<void> {
  __resetDrainsForTest();
  __resetRecordedRuns();
  stateStore = createInMemoryStateStore();

  const month = `${FUTURE_YEAR}-09`;
  const actionId = `rearm_parked_front_recovery_window_${month}`;
  await seedParkedWindow(month);

  // Gate the first chunk so the drain is observably "running" before we
  // let it finish. The dominant outcome (re_armed:2 > still_empty:1) must
  // surface as lastOutcomeKind once finished.
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let chunkCalls = 0;

  const out = await startBackgroundDrain(
    {
      actionId,
      actionTitle: `Re-arm parked Front recovery window ${month}`,
      attributionLabel: "test:rearm-badge",
      unit: "window(s)",
      countPending: async () => 1,
      runChunk: async () => {
        chunkCalls += 1;
        if (chunkCalls === 1) {
          await gate;
          return { processed: 1, perKey: { re_armed: 2, still_empty: 1 } };
        }
        return { processed: 0 };
      },
    },
    "actor-badge",
  );
  assert.equal(out.state, "started", "an eligible drain starts");

  // RUNNING snapshot: the badge map includes the month and reports it as
  // running with no finishedAt yet.
  const runningStatus = await getFrontAutoClosureStatus({ stateStore });
  const running = runningStatus.reArmDrains[month];
  assert.ok(running, "the started drain shows up in reArmDrains");
  assert.equal(running.running, true, "drain reports running before release");
  assert.equal(running.finishedAt, null, "no finishedAt while running");
  assert.equal(
    running.startedAt,
    new Date(running.startedAt!).toISOString(),
    "startedAt is a valid ISO timestamp",
  );

  // Release the gate and wait for the drain to finalize.
  releaseGate();
  await waitFor(() => !isDrainRunning(actionId), 5000, "drain finalize");

  // FINISHED snapshot: running flips false, finishedAt is ISO, and the
  // dominant outcome kind surfaces.
  const doneStatus = await getFrontAutoClosureStatus({ stateStore });
  const done = doneStatus.reArmDrains[month];
  assert.ok(done, "finished drain still shows up in reArmDrains");
  assert.equal(done.running, false, "drain reports finished after release");
  assert.ok(done.finishedAt, "finishedAt is populated once finished");
  assert.equal(
    done.finishedAt,
    new Date(done.finishedAt!).toISOString(),
    "finishedAt is a valid ISO timestamp",
  );
  assert.equal(done.processed, 1, "one window processed");
  assert.equal(
    done.lastOutcomeKind,
    "re_armed",
    "dominant outcome kind (re_armed:2 > still_empty:1) is projected",
  );
}

async function main(): Promise<void> {
  // No DB state to clean: the integration case drives a fresh in-memory
  // store (Task #2239), discarded with this process.
  const cases: Array<[string, () => void | Promise<void>]> = [
    ["collectReArmDrainStatuses projects the badge view", testProjectionPure],
    [
      "status.reArmDrains[month] reports running then finished",
      testStatusBadgeRunningThenFinished,
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
    throw new Error("front-rearm-badge test cases failed");
  }
  console.log("front-rearm-badge: OK");
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once main() settles — no manual process.exit() (Task #2084).
main().catch((err) => {
  console.error("front-rearm-badge: FAILED —", err?.stack ?? err);
  process.exitCode = 1;
});
