/* test-registration
{
  "name": "Prod-action background-drain primitive (Task #1980)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.4s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/prodActionDrainSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #1980 — Unit coverage for the shared prod-action background-drain
 * primitive (`server/services/prodActionBackgroundDrain.ts`).
 *
 * This helper now backs four one-and-done CEO prod-actions (Front backlog
 * reclassify, Front warp class backfill, dead-letter replay, dedupe-key
 * backfill). The contract pinned here — without it, every consumer
 * regresses silently:
 *
 *   1. `nothing-to-do` when `countPending` is 0 — no audit row written and
 *      the drain loop never fires.
 *   2. A concurrent kick for the same `actionId` while a drain is running
 *      is a safe no-op that returns `already-running` and reports current
 *      progress (single-flight).
 *   3. The drain loop terminates when `runChunk` returns `processed: 0`.
 *   4. On success, exactly ONE `prod_action_runs` row is recorded with
 *      outcome `applied`, the summed `rowsAffected`, and the merged
 *      `perKey` tally surfaced through `formatDrainProgress`.
 *   5. A throw inside `runChunk` records outcome `error` with the error
 *      message and the partial progress accumulated before the throw.
 *   6. `__resetDrainsForTest` clears the in-memory single-flight map so
 *      each case starts clean.
 *
 * The real `recordProdActionRun` is replaced with an in-memory stub via a
 * Node ESM resolve hook (registered through
 * `--import ./tests/helpers/prodActionDrainSetup.mjs` in run-all.ts), so
 * this suite never touches the `prod_action_runs` table / database.
 */
import assert from "node:assert/strict";
import {
  startBackgroundDrain,
  getDrainState,
  isDrainRunning,
  formatDrainProgress,
  __resetDrainsForTest,
  type DrainChunkResult,
  type DrainSpec,
} from "../server/services/prodActionBackgroundDrain";
import {
  __getRecordedRuns,
  __resetRecordedRuns,
} from "./helpers/prodActionRunsStub.mjs";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

function resetAll(): void {
  __resetDrainsForTest();
  __resetRecordedRuns();
}

function baseSpec(overrides: Partial<DrainSpec> & Pick<DrainSpec, "actionId">): DrainSpec {
  return {
    actionTitle: `Title for ${overrides.actionId}`,
    attributionLabel: `maintenance:test-${overrides.actionId}`,
    countPending: async () => 0,
    runChunk: async () => ({ processed: 0 }),
    ...overrides,
  };
}

async function testNothingToDoWritesNoAuditRow(): Promise<void> {
  resetAll();
  const spec = baseSpec({
    actionId: "nothing-to-do",
    countPending: async () => 0,
    runChunk: async () => {
      throw new Error("runChunk must not run when nothing is pending");
    },
    unit: "widget(s)",
  });

  const out = await startBackgroundDrain(spec, "actor-1");

  assert.equal(out.state, "nothing-to-do");
  assert.equal(out.totalAtStart, 0);
  assert.match(out.detail, /0 widget\(s\) pending/);
  // The loop never started, so no in-memory state and no audit row.
  assert.equal(getDrainState(spec.actionId), undefined);
  assert.equal(__getRecordedRuns().length, 0);
}

async function testConcurrentKickReturnsAlreadyRunningWithProgress(): Promise<void> {
  resetAll();
  const reachedChunk2 = deferred<void>();
  const gate = deferred<void>();
  let chunkCalls = 0;

  const spec = baseSpec({
    actionId: "concurrent",
    countPending: async () => 10,
    runChunk: async (): Promise<DrainChunkResult> => {
      chunkCalls += 1;
      if (chunkCalls === 1) {
        return { processed: 5, perKey: { alpha: 5 } };
      }
      // Second chunk parks until the test releases the gate, holding the
      // drain in a running state so the concurrent kick observes it.
      reachedChunk2.resolve();
      await gate.promise;
      return { processed: 0 };
    },
  });

  const out1 = await startBackgroundDrain(spec, "actor-1");
  assert.equal(out1.state, "started");
  assert.equal(out1.totalAtStart, 10);

  // Wait until chunk 1 has been tallied and chunk 2 is parked.
  await reachedChunk2.promise;
  await waitFor(
    () => (getDrainState(spec.actionId)?.processed ?? 0) === 5,
    5000,
    "chunk 1 tally",
  );
  assert.equal(isDrainRunning(spec.actionId), true);

  const out2 = await startBackgroundDrain(spec, "actor-2");
  assert.equal(out2.state, "already-running");
  assert.equal(out2.totalAtStart, 10);
  // Progress is surfaced in the detail string.
  assert.match(out2.detail, /5 \/ 10/);
  assert.match(out2.detail, /alpha: 5/);
  // The concurrent kick must NOT have started a second chunk run.
  assert.equal(chunkCalls, 2);

  gate.resolve();
  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  // Task #2234 reversed finalize ordering (audit row lands BEFORE the
  // finishedAt flip), so poll the flag instead of asserting immediately.
  await waitFor(() => isDrainRunning(spec.actionId) === false, 5000, "drain finished");

  const [row] = __getRecordedRuns();
  assert.equal(row.outcomeState, "applied");
  assert.equal(row.rowsAffected, 5);
}

async function testLoopTerminatesOnZeroProcessed(): Promise<void> {
  resetAll();
  let chunkCalls = 0;
  const spec = baseSpec({
    actionId: "zero-processed",
    // Pending count is non-zero (so the drain starts), but the very first
    // chunk reports nothing processed — e.g. another worker already
    // drained the backlog between count and claim.
    countPending: async () => 3,
    runChunk: async (): Promise<DrainChunkResult> => {
      chunkCalls += 1;
      return { processed: 0 };
    },
  });

  const out = await startBackgroundDrain(spec, "actor-1");
  assert.equal(out.state, "started");

  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  // Task #2234 reversed finalize ordering (audit row lands BEFORE the
  // finishedAt flip), so poll for the flag instead of asserting immediately.
  await waitFor(() => isDrainRunning(spec.actionId) === false, 5000, "drain finished");

  // Exactly one chunk ran and the loop stopped immediately.
  assert.equal(chunkCalls, 1);
  const state = getDrainState(spec.actionId);
  assert.ok(state);
  assert.equal(state!.chunks, 0);
  assert.equal(state!.processed, 0);
  assert.notEqual(state!.finishedAt, null);

  // processed === 0 → audit records the not-needed branch, not applied.
  const [row] = __getRecordedRuns();
  assert.equal(row.outcomeState, "not-needed");
  assert.equal(row.rowsAffected, 0);
}

async function testSuccessRecordsSingleAppliedRowWithMergedPerKey(): Promise<void> {
  resetAll();
  const chunks: DrainChunkResult[] = [
    { processed: 2, perKey: { x: 2 } },
    { processed: 3, perKey: { x: 1, y: 2 } },
    { processed: 0 },
  ];
  let i = 0;
  const spec = baseSpec({
    actionId: "success",
    actionTitle: "Drain success path",
    countPending: async () => 5,
    runChunk: async () => chunks[i++],
    unit: "message(s)",
  });

  const out = await startBackgroundDrain(spec, "actor-7");
  assert.equal(out.state, "started");

  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");

  const recorded = __getRecordedRuns();
  assert.equal(recorded.length, 1);
  const row = recorded[0];
  assert.equal(row.actionId, "success");
  assert.equal(row.actionTitle, "Drain success path");
  assert.equal(row.actorUserId, "actor-7");
  assert.equal(row.outcomeState, "applied");
  assert.equal(row.rowsAffected, 5);
  assert.equal(row.errorMessage, null);

  // Merged perKey tally surfaces in formatDrainProgress / detail.
  const state = getDrainState(spec.actionId)!;
  assert.deepEqual(state.perKey, { x: 3, y: 2 });
  assert.equal(state.chunks, 2);
  const progress = formatDrainProgress(state);
  assert.match(progress, /5 \/ 5 message\(s\)/);
  assert.match(progress, /x: 3/);
  assert.match(progress, /y: 2/);
  assert.match(row.detail ?? "", /x: 3/);
}

async function testErrorRecordsErrorStateWithPartialProgress(): Promise<void> {
  resetAll();
  let chunkCalls = 0;
  const spec = baseSpec({
    actionId: "error",
    countPending: async () => 9,
    runChunk: async (): Promise<DrainChunkResult> => {
      chunkCalls += 1;
      if (chunkCalls === 1) return { processed: 2, perKey: { x: 2 } };
      throw new Error("boom in chunk 2");
    },
  });

  const out = await startBackgroundDrain(spec, "actor-9");
  assert.equal(out.state, "started");

  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");

  const [row] = __getRecordedRuns();
  assert.equal(row.outcomeState, "error");
  assert.equal(row.errorMessage, "boom in chunk 2");
  // Partial progress (the one successful chunk) is preserved.
  assert.equal(row.rowsAffected, 2);
  assert.match(row.detail ?? "", /2 \/ 9/);

  const state = getDrainState(spec.actionId)!;
  assert.equal(state.error, "boom in chunk 2");
  assert.equal(state.processed, 2);
}

async function testResetDrainsForTestClearsState(): Promise<void> {
  resetAll();
  const spec = baseSpec({
    actionId: "reset",
    countPending: async () => 1,
    runChunk: async () => ({ processed: 1 }),
  });
  await startBackgroundDrain(spec, null);
  await waitFor(() => __getRecordedRuns().length === 1, 5000, "drain finalize");
  assert.ok(getDrainState(spec.actionId));

  __resetDrainsForTest();
  assert.equal(getDrainState(spec.actionId), undefined);
  assert.equal(isDrainRunning(spec.actionId), false);
}

// Task #2400 — a drain that HANGS (an external call stalls without a timeout)
// rather than crashing keeps its cluster-wide advisory lock forever, so
// re-running that action on any instance is blocked indefinitely. The bounded
// `maxHoldMs` watchdog must force-release the lock so a later press takes over,
// AND keep the drain's own finalize/audit bookkeeping consistent (exactly one
// `prod_action_runs` row, `finishedAt` set, no row left "running" with a freed
// lock). This mirrors `tests/cross-instance-singleton-lock.test.ts`'s watchdog
// case but at the drain layer. It uses the REAL advisory lock against dev
// Postgres (same as the other cases here); only `recordProdActionRun` is
// stubbed. A unique actionId keeps it from colliding on the shared lock space.
async function testWatchdogForceReleasesHungDrain(): Promise<void> {
  resetAll();
  const actionId = `watchdog-hung-${process.pid}-${Date.now()}`;
  const hang = deferred<void>();

  // First press: the very first chunk parks forever (simulates a wedged
  // external call). The drain acquires the lock and never reaches its own
  // `finally`, so only the watchdog can finalize it.
  const hungSpec = baseSpec({
    actionId,
    actionTitle: "Hung drain",
    unit: "row(s)",
    countPending: async () => 5,
    // 150ms ceiling so the watchdog fires quickly in the test.
    maxHoldMs: 150,
    runChunk: async (): Promise<DrainChunkResult> => {
      await hang.promise;
      return { processed: 0 };
    },
  });

  const out1 = await startBackgroundDrain(hungSpec, "actor-1");
  assert.equal(out1.state, "started", "the hung drain must start (lock acquired)");

  // While the holder still legitimately holds the lock (before the ceiling), a
  // concurrent press on the same action must lose — it is a safe no-op.
  const early = await startBackgroundDrain(hungSpec, "actor-2");
  assert.equal(
    early.state,
    "already-running",
    "a press while the drain still holds the lock must report already-running",
  );

  // Wait for the watchdog to fire and finalize. It writes exactly one audit
  // row (the `error` branch, carrying the watchdog reason) and flips finishedAt.
  await waitFor(
    () => __getRecordedRuns().length === 1,
    5000,
    "watchdog finalize",
  );
  const [row] = __getRecordedRuns();
  assert.equal(row.actionId, actionId);
  assert.equal(row.outcomeState, "error", "watchdog finalize records the error outcome");
  assert.match(
    row.errorMessage ?? "",
    /watchdog force-released/i,
    "audit error message names the watchdog force-release",
  );
  const hungState = getDrainState(actionId)!;
  assert.notEqual(hungState.finishedAt, null, "watchdog must flip finishedAt");
  assert.equal(
    isDrainRunning(actionId),
    false,
    "no drain may be left 'running' with a freed lock",
  );

  // A later press must now win the cluster-wide lock (force-released by the
  // watchdog) and start a fresh drain that completes normally. Poll because the
  // primitive's force-release runs just after onWatchdog returns.
  let took: Awaited<ReturnType<typeof startBackgroundDrain>> | null = null;
  const takeoverDeadline = Date.now() + 5000;
  while (Date.now() < takeoverDeadline) {
    took = await startBackgroundDrain(
      baseSpec({
        actionId,
        actionTitle: "Takeover drain",
        unit: "row(s)",
        countPending: async () => 2,
        runChunk: (() => {
          let calls = 0;
          return async (): Promise<DrainChunkResult> => {
            calls += 1;
            return calls === 1 ? { processed: 2 } : { processed: 0 };
          };
        })(),
      }),
      "actor-3",
    );
    if (took.state === "started") break;
    await sleep(20);
  }
  assert.equal(took?.state, "started", "a later press must take over after force-release");

  await waitFor(
    () => __getRecordedRuns().length === 2,
    5000,
    "takeover drain finalize",
  );
  const takeoverRow = __getRecordedRuns()[1];
  assert.equal(takeoverRow.outcomeState, "applied", "the takeover drain completes normally");
  assert.equal(takeoverRow.rowsAffected, 2);

  // Release the original hung chunk so its parked loop unwinds; its eventual
  // finalize must be an idempotent no-op (no third audit row).
  hang.resolve();
  await sleep(50);
  assert.equal(
    __getRecordedRuns().length,
    2,
    "the un-hung loop's late finalize must be an idempotent no-op",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["nothing-to-do writes no audit row", testNothingToDoWritesNoAuditRow],
    [
      "concurrent kick returns already-running with progress",
      testConcurrentKickReturnsAlreadyRunningWithProgress,
    ],
    ["loop terminates when runChunk returns processed: 0", testLoopTerminatesOnZeroProcessed],
    [
      "success records a single applied row with merged perKey",
      testSuccessRecordsSingleAppliedRowWithMergedPerKey,
    ],
    [
      "thrown error records error state with partial progress",
      testErrorRecordsErrorStateWithPartialProgress,
    ],
    ["__resetDrainsForTest clears in-memory state", testResetDrainsForTestClearsState],
    [
      "watchdog force-releases a hung drain so a later press takes over",
      testWatchdogForceReleasesHungDrain,
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
    throw new Error("prod-action-background-drain test cases failed");
  }
  console.log("prod-action-background-drain: OK");
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once main() settles — no manual process.exit() (Task #2084).
main().catch((err) => {
  console.error("prod-action-background-drain: FAILED —", err?.stack ?? err);
  process.exitCode = 1;
});
