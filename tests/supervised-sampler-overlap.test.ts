/* test-registration
{
  "name": "Supervised sampler overlap (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #992 — non-overlap, structured skip-reason, and recovery-after-late-settle
 * contract tests for the supervised sampler.
 *
 * These tests are unit-time only; they do not touch the database.
 */

import assert from "node:assert/strict";
import {
  startSupervisedSampler,
  stopSupervisedSampler,
  getSupervisedSamplerState,
} from "../server/services/supervisedSampler";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function testNonOverlapAndSkipReason() {
  const name = "test_overlap_skip_reason";
  const resolvers: Array<() => void> = [];
  let tickStarts = 0;

  startSupervisedSampler({
    name,
    intervalMs: 30,
    // Far above the test runtime so the timeout path does NOT fire — we
    // are isolating the pure non-overlap-on-hung-tick behaviour here.
    tickTimeoutMs: 10_000,
    tick: () => {
      tickStarts++;
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    },
  });

  // Let the first tick start.
  await sleep(60);
  let state = getSupervisedSamplerState(name)!;
  assert.equal(state.inFlight, true, "first tick should be in flight");
  assert.equal(tickStarts, 1, "exactly one tick has started");
  assert.equal(state.totalTicks, 1, "totalTicks must be 1");

  // Several intervals must fire over the hung tick — every one is a
  // skip with the structured reason.
  await sleep(150);
  state = getSupervisedSamplerState(name)!;
  assert.equal(
    tickStarts,
    1,
    `non-overlap broken: a second tick started while the first was in flight (tickStarts=${tickStarts}, totalSkips=${state.totalSkips})`,
  );
  assert.equal(state.totalTicks, 1, "totalTicks must still be 1");
  assert.ok(
    state.totalSkips >= 3,
    `at least 3 skips expected over a hung tick (got ${state.totalSkips})`,
  );
  assert.equal(
    state.lastSkipReason,
    "previous_tick_still_running",
    `lastSkipReason should be 'previous_tick_still_running' (got ${state.lastSkipReason})`,
  );
  assert.ok(state.lastSkippedAt !== null, "lastSkippedAt should be set");

  // Release the hung tick. Subsequent intervals should now be able to
  // fire normally — meaning a *second* tick must start (proving the
  // in-flight guard was released by the late settle).
  resolvers.shift()!();
  await sleep(80);
  state = getSupervisedSamplerState(name)!;
  assert.ok(
    tickStarts >= 2,
    `after late settle a new tick must be allowed to start (tickStarts=${tickStarts})`,
  );
  assert.ok(
    state.totalSuccesses >= 1,
    `the resolved tick must have been recorded as a success (got ${state.totalSuccesses})`,
  );
  // (We do not assert lastSkipReason is null here: the *new* tick is
  // itself still hung in this synthetic test, so subsequent intervals
  // legitimately record more skips against it. The "fast tick clears
  // skip reason" path is covered by `testFastTicksDoNotProduceSkips`.)

  // Cleanup — release any remaining hung resolvers so the process can exit.
  resolvers.forEach((r) => r());
  stopSupervisedSampler(name);
  console.log(
    "✓ non-overlap holds under hung tick; structured skip reason recorded; in-flight released after late settle",
  );
}

async function testFastTicksDoNotProduceSkips() {
  const name = "test_fast_no_skips";
  startSupervisedSampler({
    name,
    intervalMs: 30,
    tickTimeoutMs: 10_000,
    tick: async () => {
      // Fast — completes well within the interval.
    },
  });

  await sleep(150);
  const state = getSupervisedSamplerState(name)!;
  assert.equal(
    state.lastSkipReason,
    null,
    "fast tick should not record a skip reason",
  );
  assert.equal(
    state.totalSkips,
    0,
    `fast ticks must not produce skip noise (totalSkips=${state.totalSkips})`,
  );
  assert.ok(state.totalSuccesses >= 2, "multiple ticks should have succeeded");
  stopSupervisedSampler(name);
  console.log("✓ fast ticks do not produce skip-reason noise");
}

async function testTimeoutLateSettleReleasesInFlight() {
  // Task #992 — regression: deterministic in-flight release across
  // every interleaving of (timeout fires, tick settles, outer finally
  // runs). The single-owner releaseInFlight() helper guarantees that
  // exactly one path releases, and that no path can leave inFlight
  // stuck true. We exercise the worst-case interleaving directly:
  //   1. Tick is hung past tickTimeoutMs → timeout fires, marks
  //      tickTimedOutPending=true, leaves inFlight=true.
  //   2. The next interval fires while still in flight → records a
  //      skip with the structured reason.
  //   3. The hung tick eventually settles (late) → its .finally()
  //      calls releaseInFlight() exactly once.
  //   4. The next interval may now start a fresh tick.
  const name = "test_timeout_late_settle_release";
  const resolvers: Array<() => void> = [];
  let tickStarts = 0;
  startSupervisedSampler({
    name,
    intervalMs: 30,
    tickTimeoutMs: 80,
    tick: () => {
      tickStarts++;
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    },
  });

  // Wait long enough for the first tick to start AND for it to time
  // out (tickTimeoutMs=80 < this sleep).
  await sleep(200);
  let state = getSupervisedSamplerState(name)!;
  assert.equal(tickStarts, 1, "exactly one tick should have started");
  assert.equal(
    state.tickTimedOutPending,
    true,
    "after timeout the pending-late-settle flag must be set",
  );
  assert.equal(
    state.inFlight,
    true,
    "inFlight must remain true while the late tick is still pending",
  );
  assert.ok(
    state.totalSkips >= 2,
    `intervals firing during the timed-out-but-pending window must record skips (got ${state.totalSkips})`,
  );

  // Now release the hung tick — its .finally() must release inFlight
  // exactly once even though the timeout already fired. Because the
  // schedule interval keeps firing, a *new* tick will capture inFlight
  // again immediately after the release. We therefore prove release
  // happened indirectly: a second tick starts (only possible if the
  // first inFlight slot was released) and the pending-late-settle
  // flag clears.
  resolvers.shift()!();
  // Sleep just long enough for the schedule to fire ONE more interval
  // (intervalMs=30) but well under the new tick's tickTimeoutMs=80,
  // so the new tick has not yet timed out and any tickTimedOutPending
  // we observe could only be a leak from the first tick.
  await sleep(50);
  state = getSupervisedSamplerState(name)!;
  assert.ok(
    tickStarts >= 2,
    `a fresh tick must be allowed to start after the late settle — proves inFlight was released (tickStarts=${tickStarts})`,
  );
  assert.equal(
    state.tickTimedOutPending,
    false,
    "tickTimedOutPending must be cleared by releaseInFlight after late settle (the new tick hasn't timed out yet)",
  );

  // Cleanup
  resolvers.forEach((r) => r());
  stopSupervisedSampler(name);
  console.log(
    "✓ timeout + late settle release inFlight exactly once via idempotent helper",
  );
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
(async () => {
  await testNonOverlapAndSkipReason();
  await testFastTicksDoNotProduceSkips();
  await testTimeoutLateSettleReleasesInFlight();
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
