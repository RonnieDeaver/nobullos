/* test-registration
{
  "name": "Front auto-closure scheduler live re-cadence (Task #2574)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2574 — Direct unit coverage for the Front auto-closure scheduler's
 * LIVE re-cadence path.
 *
 * Task #2548 (`front-auto-closure-scheduler-interval.test.ts`) covered how the
 * admin-tunable interval value is parsed + range-validated by
 * `refreshIntervalMs()`. It did NOT cover what happens once an admin actually
 * changes that value while the loop is running: `scheduleNextTick()` is
 * supposed to notice the resolved interval changed and tear down + recreate the
 * underlying `setInterval` timer (re-timing the loop to the new cadence), and
 * to no-op — leaving the existing timer untouched — when the interval is
 * unchanged. A regression there (an inverted comparison, or always/never
 * recreating) would silently leave the self-heal loop running on a stale
 * cadence after an admin update, with nothing to catch it.
 *
 * This test drives the REAL `scheduleNextTick()` (via
 * `__frontAutoClosureSchedulerTestHelpers`) and inspects the module's exported
 * timer state (the resolved `currentTickMs` and the timer handle's identity) so
 * it depends on NO real wall-clock delays — it never waits for a tick to fire,
 * it only asserts the timer was (or was not) reset. It asserts:
 *   1. the first schedule arms a timer at the configured cadence;
 *   2. re-running with the SAME interval is a no-op — the exact same timer
 *      handle survives (no churn) and the cadence is unchanged;
 *   3. changing the interval re-times the loop — the cadence updates AND the
 *      timer handle is replaced (the old interval is torn down).
 *
 * Pins + restores the one shared `system_settings` row it reads
 * (`front_auto_closure_tick_interval_seconds`) per the shared-DB pin contract
 * (see `.agents/memory/test-global-setting-leak-from-sigkill.md`), and calls
 * `stopFrontAutoClosureScheduler()` in `finally` so the real `setInterval` it
 * arms is always cleared (a leaked ref'd timer would hang process exit and the
 * run-all harness would score the hang as a FAIL).
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2548 (the interval-resolution coverage this complements + style reference),
 *   #2514 (the scheduler gate coverage + pin/stop discipline reference),
 *   #2379 (shared-DB global-switch pin+restore contract).
 */
import assert from "node:assert/strict";

import { storage } from "../server/storage";
import {
  SCHEDULER_INTERVAL_SETTING,
  stopFrontAutoClosureScheduler,
  __frontAutoClosureSchedulerTestHelpers as helpers,
} from "../server/services/frontAutoClosureScheduler";

// Set the admin-tunable interval setting the way an admin update would.
const setInterval = (value: string): Promise<unknown> =>
  storage.setSystemSetting(SCHEDULER_INTERVAL_SETTING, value, "test");

// Re-cadence the loop the way the running scheduler does (the helper wraps its
// own setting read in runWithWorkerDb).
const reschedule = (): Promise<void> => helpers.scheduleNextTick();

// ── Back up the one shared switch we read so a SIGKILL'd sibling can't leave
// it dirty (and so we leave it as we found it). ───────────────────────────
const ORIG_INTERVAL =
  (await storage.getSystemSetting(SCHEDULER_INTERVAL_SETTING))?.value ?? null;

try {
  // Start from a clean timer state (no timer armed, no remembered cadence)
  // regardless of any leftover module state.
  stopFrontAutoClosureScheduler();
  assert.equal(helpers.getTickTimer(), null,
    "precondition: no timer is armed before the first schedule");
  assert.equal(helpers.getCurrentTickMs(), null,
    "precondition: no cadence is remembered before the first schedule");

  // ── 1. First schedule arms a timer at the configured cadence. ──────────
  await setInterval("120");
  await reschedule();
  const firstTimer = helpers.getTickTimer();
  assert.notEqual(firstTimer, null, "the first schedule arms a tick timer");
  assert.equal(helpers.getCurrentTickMs(), 120_000,
    "the armed timer runs at the configured 120s cadence");

  // ── 2. Unchanged interval is a no-op — same timer, same cadence. ───────
  await reschedule();
  assert.equal(helpers.getTickTimer(), firstTimer,
    "an unchanged interval keeps the EXACT same timer handle (no churn)");
  assert.equal(helpers.getCurrentTickMs(), 120_000,
    "an unchanged interval leaves the cadence untouched");

  // ── 3. Changed interval re-times the loop — new cadence, new timer. ────
  await setInterval("200");
  await reschedule();
  const secondTimer = helpers.getTickTimer();
  assert.equal(helpers.getCurrentTickMs(), 200_000,
    "changing the setting re-times the loop to the new 200s cadence");
  assert.notEqual(secondTimer, firstTimer,
    "changing the interval tears down the old timer and arms a fresh one");
  assert.notEqual(secondTimer, null,
    "a timer is still armed after the re-cadence");

  // ── 4. Re-running at the NEW interval is again a no-op (regression guard
  // that the no-op branch tracks the current cadence, not the original). ──
  await reschedule();
  assert.equal(helpers.getTickTimer(), secondTimer,
    "re-running at the new interval keeps the same timer handle (no churn)");
  assert.equal(helpers.getCurrentTickMs(), 200_000,
    "re-running at the new interval leaves the new cadence untouched");
} finally {
  // Always clear the real timer this test armed (a leaked ref'd setInterval
  // would hang process exit) and restore the switch we pinned.
  stopFrontAutoClosureScheduler();
  await setInterval(ORIG_INTERVAL ?? "");
}

console.log("front-auto-closure-scheduler-recadence.test.ts: OK");
