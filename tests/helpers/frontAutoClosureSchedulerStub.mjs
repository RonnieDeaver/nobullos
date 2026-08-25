// Task #2501 — Configurable stub for `server/services/frontAutoClosureScheduler`
// used by the `trigger_front_auto_closure_tick` prod-action status/apply
// safety-net test. The action reaches the scheduler ONLY via dynamic
// `import("./frontAutoClosureScheduler")` inside its `status()` / `apply()`
// (it destructures `evaluateFrontAutoClosureGates` and
// `enqueueManualFrontAutoClosureTick` respectively), so the companion resolve
// hook (`triggerFrontAutoClosureTickMockLoader.mjs`) can redirect the whole
// module to THIS stub without breaking any static-import consumer.
//
// Both the action (via the loader redirect) and the test file (via a direct
// import of this same path) resolve to one ESM singleton, so the gate /
// enqueue outcomes configured here are exactly what the action observes.

// Default: gates OPEN — the Task #2499 settled-state branch (status →
// not-needed while apply still fires one tick) is the headline regression.
let nextGate = { open: true };
// Default enqueue outcome: a successful manual enqueue.
let nextEnqueueOutcome = { enqueued: true, bucket: 12345, trigger: "manual" };

let gateCallCount = 0;
let enqueueCallCount = 0;

export async function evaluateFrontAutoClosureGates(/* trigger */) {
  gateCallCount += 1;
  return nextGate;
}

export async function enqueueManualFrontAutoClosureTick() {
  enqueueCallCount += 1;
  return nextEnqueueOutcome;
}

export function __setNextGate(gate) {
  nextGate = gate;
}

export function __setNextEnqueueOutcome(outcome) {
  nextEnqueueOutcome = outcome;
}

export function __getGateCallCount() {
  return gateCallCount;
}

export function __getEnqueueCallCount() {
  return enqueueCallCount;
}

export function __resetStub() {
  nextGate = { open: true };
  nextEnqueueOutcome = { enqueued: true, bucket: 12345, trigger: "manual" };
  gateCallCount = 0;
  enqueueCallCount = 0;
}
