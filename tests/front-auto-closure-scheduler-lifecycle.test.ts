/* test-registration
{
  "name": "Front auto-closure scheduler start/stop lifecycle (Task #2586)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2586 — Direct unit coverage for the Front auto-closure scheduler's
 * start/stop LIFECYCLE.
 *
 * Task #2574 (`front-auto-closure-scheduler-recadence.test.ts`) drove the live
 * re-cadence path (`scheduleNextTick`) directly, but the surrounding
 * start/stop lifecycle in `server/services/frontAutoClosureScheduler.ts` had
 * no direct test:
 *   - `startFrontAutoClosureScheduler()` must arm BOTH timers — the tick timer
 *     (via `scheduleNextTick`) AND the 60s reschedule-check timer — set the
 *     `started` re-entrancy flag, and respect that flag so a double start can't
 *     arm duplicate timers (a leaked timer hangs process exit; a duplicate
 *     reschedule loop double-drives the cadence check).
 *   - It must honor the PERF flag: when `FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED`
 *     is off, start arms nothing and leaves `started` false.
 *   - `stopFrontAutoClosureScheduler()` must tear BOTH timers down and reset
 *     `currentTickMs` / `started` so a later start cleanly re-arms.
 *
 * This test drives the REAL start/stop functions and inspects the module's
 * exported timer + flag state (the tick timer handle, the reschedule timer
 * handle, `currentTickMs`, and `started`) so it depends on NO real wall-clock
 * delays — it never waits for a tick to fire, it only asserts the timers were
 * (or were not) armed/cleared. Because `start()` arms the tick timer via the
 * async `scheduleNextTick()`, it polls (bounded) for that timer to appear
 * rather than racing it.
 *
 * Pins + restores the PERF flag it flips and the one shared `system_settings`
 * row `scheduleNextTick` reads (`front_auto_closure_tick_interval_seconds`)
 * per the shared-DB pin contract (see
 * `.agents/memory/test-global-setting-leak-from-sigkill.md`), and calls
 * `stopFrontAutoClosureScheduler()` in `finally` so the real `setInterval`
 * timers it arms are always cleared (a leaked ref'd timer would hang process
 * exit and the run-all harness would score the hang as a FAIL).
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2574 (the live re-cadence coverage this complements + helper-inspection
 *   style reference), #2514 (the scheduler gate coverage + pin/stop discipline
 *   reference), #2379 (shared-DB global-switch pin+restore contract).
 */
import assert from "node:assert/strict";

import { storage } from "../server/storage";
import { PERF } from "../server/perfConfig";
import {
  SCHEDULER_INTERVAL_SETTING,
  startFrontAutoClosureScheduler,
  stopFrontAutoClosureScheduler,
  __frontAutoClosureSchedulerTestHelpers as helpers,
} from "../server/services/frontAutoClosureScheduler";

const setIntervalSetting = (value: string): Promise<unknown> =>
  storage.setSystemSetting(SCHEDULER_INTERVAL_SETTING, value, "test");

// `start()` arms the tick timer via the async `scheduleNextTick()`, so poll
// (bounded) for it instead of racing the await chain. Pure microtask/short
// timer waits — never a real cadence tick.
async function waitForTickTimer(): Promise<void> {
  // Generous budget (~10s) so transient dev-DB latency in scheduleNextTick's
  // setting read can't flake this under contention; the timer normally arms
  // within a microtask once that read resolves.
  for (let i = 0; i < 1000; i++) {
    if (helpers.getTickTimer() !== null) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("tick timer was not armed within the poll window");
}

// ── Back up the shared state we touch so a SIGKILL'd sibling can't leave it
// dirty (and so we leave it as we found it). ───────────────────────────────
const ORIG_PERF_FLAG = PERF.FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED;
const ORIG_INTERVAL =
  (await storage.getSystemSetting(SCHEDULER_INTERVAL_SETTING))?.value ?? null;

try {
  // Deterministic cadence + start from a clean timer state regardless of any
  // leftover module state.
  await setIntervalSetting("120");
  stopFrontAutoClosureScheduler();
  assert.equal(helpers.getTickTimer(), null,
    "precondition: no tick timer is armed before start");
  assert.equal(helpers.getRescheduleTimer(), null,
    "precondition: no reschedule timer is armed before start");
  assert.equal(helpers.getStarted(), false,
    "precondition: started is false before start");
  assert.equal(helpers.getCurrentTickMs(), null,
    "precondition: no cadence is remembered before start");

  // ── 1. start() arms BOTH timers, sets started + currentTickMs. ──────────
  PERF.FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED = true;
  startFrontAutoClosureScheduler();
  assert.equal(helpers.getStarted(), true, "start sets the started flag");
  assert.notEqual(helpers.getRescheduleTimer(), null,
    "start arms the 60s reschedule-check timer synchronously");
  await waitForTickTimer();
  const firstTick = helpers.getTickTimer();
  const firstReschedule = helpers.getRescheduleTimer();
  assert.notEqual(firstTick, null, "start arms the tick timer");
  assert.equal(helpers.getCurrentTickMs(), 120_000,
    "the tick timer runs at the configured 120s cadence");

  // ── 2. A double start is a no-op — no duplicate timers armed. ───────────
  startFrontAutoClosureScheduler();
  assert.equal(helpers.getTickTimer(), firstTick,
    "double start keeps the EXACT same tick timer (no duplicate armed)");
  assert.equal(helpers.getRescheduleTimer(), firstReschedule,
    "double start keeps the EXACT same reschedule timer (no duplicate loop)");
  assert.equal(helpers.getStarted(), true, "double start leaves started true");

  // ── 3. stop() tears BOTH timers down and resets state. ──────────────────
  stopFrontAutoClosureScheduler();
  assert.equal(helpers.getTickTimer(), null, "stop clears the tick timer");
  assert.equal(helpers.getRescheduleTimer(), null,
    "stop clears the reschedule timer");
  assert.equal(helpers.getStarted(), false, "stop resets the started flag");
  assert.equal(helpers.getCurrentTickMs(), null,
    "stop clears the remembered cadence so a later start re-arms cleanly");

  // ── 4. PERF flag off → start arms nothing and leaves started false. ─────
  PERF.FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED = false;
  startFrontAutoClosureScheduler();
  assert.equal(helpers.getStarted(), false,
    "start with the PERF flag off does not set started");
  assert.equal(helpers.getTickTimer(), null,
    "start with the PERF flag off arms no tick timer");
  assert.equal(helpers.getRescheduleTimer(), null,
    "start with the PERF flag off arms no reschedule timer");
  assert.equal(helpers.getCurrentTickMs(), null,
    "start with the PERF flag off remembers no cadence");
} finally {
  // Always clear any real timers this test armed (a leaked ref'd setInterval
  // would hang process exit) and restore the state we pinned.
  stopFrontAutoClosureScheduler();
  PERF.FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED = ORIG_PERF_FLAG;
  await setIntervalSetting(ORIG_INTERVAL ?? "");
}

console.log("front-auto-closure-scheduler-lifecycle.test.ts: OK");
