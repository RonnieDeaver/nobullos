/* test-registration
{
  "name": "Front auto-closure park-window (Task #1885)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1885 — Park dead recovery windows.
 *
 * Verifies:
 *   1. `updateDeadRunStreak` increments on each new dead checkpoint,
 *      never double-counts the same `completedAt`, and resets to 0
 *      the moment forward progress (ingested > 0) lands.
 *   2. `isDeadRunCheckpoint` matches the documented zero-ingest /
 *      `safety_max_pages_reached_resume_available` shape and rejects
 *      anything else.
 *   3. `unparkRecoveryWindow` clears both the parked entry and the
 *      dead-run streak, is reflected in `getFrontAutoClosureStatus`,
 *      and is idempotent on an unknown month.
 *
 * Lives in its own file so it isn't blocked by unrelated pre-existing
 * failures in tests/front-auto-closure.test.ts.
 */
import assert from "node:assert/strict";
import {
  getFrontAutoClosureStatus,
  isDeadRunCheckpoint,
  shouldAutoUnparkWindow,
  unparkRecoveryWindow,
  createInMemoryStateStore,
  __frontAutoClosureTestHelpers,
} from "../server/services/frontAutoClosure";

const FUTURE_YEAR = 2998;

async function main(): Promise<void> {
  const { updateDeadRunStreak, EMPTY_STATE } = __frontAutoClosureTestHelpers;

  // ── 1. updateDeadRunStreak ──────────────────────────────────────────
  const parkMonth = `${FUTURE_YEAR}-07`;
  const synthState: any = {
    ...EMPTY_STATE,
    deadRunStreak: {},
    parkedWindows: {},
  };
  const dead = (completedAt: string) => ({
    ingested: 0,
    scanned: 25_000,
    status: "paused",
    statusReason:
      "safety_max_pages_reached_resume_available scanned=25000 ingested=0",
    completedAt,
  });

  const s1 = updateDeadRunStreak(synthState, parkMonth, dead("2030-01-01T00:00:00Z"));
  assert.equal(s1.count, 1, "first dead checkpoint = streak 1");
  const s2 = updateDeadRunStreak(synthState, parkMonth, dead("2030-01-01T00:00:00Z"));
  assert.equal(s2.count, 1, "same completedAt must not double-count");
  const s3 = updateDeadRunStreak(synthState, parkMonth, dead("2030-01-02T00:00:00Z"));
  assert.equal(s3.count, 2, "new dead checkpoint = streak 2");
  const s4 = updateDeadRunStreak(synthState, parkMonth, {
    ingested: 5,
    scanned: 100,
    status: "completed",
    statusReason: "done",
    completedAt: "2030-01-03T00:00:00Z",
  });
  assert.equal(s4.count, 0, "any forward progress resets streak");

  // ── 2. isDeadRunCheckpoint classifier ───────────────────────────────
  assert.equal(
    isDeadRunCheckpoint({
      ingested: 0,
      statusReason: "safety_max_pages_reached_resume_available scanned=25000",
      completedAt: "2030-01-01T00:00:00Z",
    } as any),
    true,
    "ingested=0 + safety_max reason = dead run",
  );
  assert.equal(
    isDeadRunCheckpoint({
      ingested: 1,
      statusReason: "safety_max_pages_reached_resume_available scanned=25000",
      completedAt: "2030-01-01T00:00:00Z",
    } as any),
    false,
    "any ingested > 0 is forward progress, not a dead run",
  );
  assert.equal(
    isDeadRunCheckpoint({
      ingested: 0,
      statusReason: "auth_failed",
      completedAt: "2030-01-01T00:00:00Z",
    } as any),
    false,
    "non-safety_max reason is not a dead run",
  );
  assert.equal(isDeadRunCheckpoint(null), false, "null checkpoint is not a dead run");

  // ── 3. unparkRecoveryWindow + status round-trip ─────────────────────
  // Task #2239 — seed/inspect through an injected in-memory store instead
  // of the global `front_auto_closure_state` setting, so this round-trip
  // never touches the shared dev DB and needs no teardown.
  const persistMonth = `${FUTURE_YEAR}-08`;
  const stateStore = createInMemoryStateStore();
  const live = await stateStore.load();
  live.parkedWindows = live.parkedWindows ?? {};
  live.deadRunStreak = live.deadRunStreak ?? {};
  live.parkedWindows[persistMonth] = {
    parkedAt: new Date().toISOString(),
    reason: "test_seed",
    deadRuns: 3,
    lastCheckpointAt: "2030-01-01T00:00:00Z",
  } as any;
  live.deadRunStreak[persistMonth] = {
    count: 3,
    lastCheckpointAt: "2030-01-01T00:00:00Z",
  } as any;
  await stateStore.save(live);

  {
    const status1 = await getFrontAutoClosureStatus({
      now: new Date(Date.UTC(FUTURE_YEAR, 5, 15)),
      stateStore,
    });
    assert.ok(
      status1.parkedWindows[persistMonth],
      "status exposes the seeded parked window",
    );
    assert.equal(
      status1.deadRunStreak[persistMonth]?.count,
      3,
      "status exposes the seeded dead-run streak",
    );

    const unparkRes = await unparkRecoveryWindow(persistMonth, stateStore);
    assert.equal(unparkRes.unparked, true, "first un-park reports a change");
    assert.equal(unparkRes.month, persistMonth);

    const status2 = await getFrontAutoClosureStatus({
      now: new Date(Date.UTC(FUTURE_YEAR, 5, 15)),
      stateStore,
    });
    assert.equal(
      status2.parkedWindows[persistMonth],
      undefined,
      "un-park clears the parked entry from status",
    );
    assert.equal(
      status2.deadRunStreak[persistMonth],
      undefined,
      "un-park also clears the dead-run streak from status",
    );

    const unparkAgain = await unparkRecoveryWindow(persistMonth, stateStore);
    assert.equal(
      unparkAgain.unparked,
      false,
      "un-parking an unknown month is an idempotent no-op",
    );

    // ── 4. shouldAutoUnparkWindow (Task #1890) ────────────────────────
    const parkedEntry = {
      parkedAt: "2030-02-01T00:00:00Z",
      reason: "dead_run_streak:3_runs",
      deadRuns: 3,
      lastCheckpointAt: "2030-01-15T00:00:00Z",
    } as any;

    // (a) Operator cleared the per-window checkpoint → auto-unpark.
    const cleared = shouldAutoUnparkWindow(parkedEntry, null);
    assert.equal(
      cleared?.reason,
      "checkpoint_cleared",
      "checkpoint deletion (e.g. resumeMode=clear_checkpoints) auto-unparks",
    );

    // (b) Same dead checkpoint we parked on → stay parked. This is the
    //     load-bearing invariant — without it, the parking is a no-op
    //     because the dead checkpoint persists on disk after parking.
    const sameDead = shouldAutoUnparkWindow(parkedEntry, {
      ingested: 0,
      scanned: 25_000,
      status: "paused",
      statusReason: "safety_max_pages_reached_resume_available scanned=25000",
      completedAt: "2030-01-15T00:00:00Z",
    });
    assert.equal(sameDead, null, "same-completedAt dead checkpoint keeps the window parked");

    // (c) Fresh dead checkpoint (new completedAt, still dead pattern)
    //     → stay parked. A manual re-run that produced another dead
    //     run is not a release signal.
    const freshDead = shouldAutoUnparkWindow(parkedEntry, {
      ingested: 0,
      scanned: 25_000,
      status: "paused",
      statusReason: "safety_max_pages_reached_resume_available scanned=25000",
      completedAt: "2030-02-10T00:00:00Z",
    });
    assert.equal(freshDead, null, "another dead run does not auto-unpark");

    // (d) Fresh checkpoint with forward progress → auto-unpark.
    const progress = shouldAutoUnparkWindow(parkedEntry, {
      ingested: 42,
      scanned: 500,
      status: "completed",
      statusReason: "done",
      completedAt: "2030-02-10T00:00:00Z",
    });
    assert.equal(
      progress?.reason,
      "checkpoint_advanced_with_progress",
      "fresh checkpoint with ingested>0 auto-unparks",
    );

    // (e) No parked entry → nothing to release.
    assert.equal(
      shouldAutoUnparkWindow(undefined, null),
      null,
      "undefined parked entry never reports an unpark",
    );
  }
  // No teardown needed: the in-memory `stateStore` is discarded with this
  // process, so nothing was written to the shared dev DB (Task #2239).

  console.log("✓ front-auto-closure park-window tests passed");
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once main() settles — no manual process.exit() (Task #2084).
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
