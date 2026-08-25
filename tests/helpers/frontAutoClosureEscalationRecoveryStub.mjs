// Task #2120 — Fake `frontHistoricalRecovery` module used by the
// end-to-end auto-park search-escalation suite
// (tests/front-auto-closure-escalation-e2e.test.ts).
//
// `runFrontAutoClosureTick` reaches the recovery pipeline through a
// dynamic `import("./frontHistoricalRecovery")`; the companion resolve
// hook (`frontAutoClosureEscalationRecoveryLoader.mjs`) redirects that
// import to THIS module so the e2e tick never spawns a real Front
// recovery job (which would hit the Front API and the in-memory
// recovery registry).
//
// Both the tick (via the loader redirect) and the test file (via a
// direct import of this same path) resolve to one ESM singleton, so the
// `runHistoricalRecovery` calls captured here are visible to the
// assertions.
//
// The tick dynamically imports SIX symbols from frontHistoricalRecovery
// across its various paths; all six MUST be exported here or the
// redirected import throws. `runHistoricalRecovery` is the one the
// escalation / normal-enqueue paths actually call; the rest return
// inert values so the surrounding tick logic (cap check, poisoned-
// checkpoint sweep, dedupe-close path) is a no-op.

let calls = [];
let behavior = null;
let maxConcurrent = 100000;
let runningJobs = [];

export async function runHistoricalRecovery(options) {
  const index = calls.length;
  calls.push(options);
  if (typeof behavior === "function") {
    return behavior(options, index);
  }
  return `stub-recovery-job-${index + 1}`;
}

export async function listRecoveryJobs() {
  return runningJobs.slice();
}

export async function getMaxConcurrentRecoveryJobsForAutoClosure() {
  return maxConcurrent;
}

export async function tryAutoUnblockPoisonedCheckpoints() {
  return { scanned: 0, unblocked: 0, probeOutcome: "skipped" };
}

export async function getRecoveryCumulative() {
  return { months: {} };
}

export async function runTargetedWindowBackfill(options) {
  calls.push({ targetedBackfill: true, options });
  return { status: "complete", statusReason: null, ingested: 0 };
}

/**
 * Override the default success behavior. `fn(options, callIndex)` may
 * return a job id (resolved value) or throw to simulate a recovery
 * failure / concurrency-cap deferral.
 */
export function __setRecoveryBehavior(fn) {
  behavior = fn;
}

/** Drive the cap-check seam: what `listRecoveryJobs` reports. */
export function __setRunningJobs(jobs) {
  runningJobs = Array.isArray(jobs) ? jobs.slice() : [];
}

/** Drive the cap seam: what the tick reads as the concurrency ceiling. */
export function __setMaxConcurrent(n) {
  maxConcurrent = n;
}

export function __getRecoveryCalls() {
  return calls.slice();
}

export function __resetRecovery() {
  calls = [];
  behavior = null;
  maxConcurrent = 100000;
  runningJobs = [];
}
