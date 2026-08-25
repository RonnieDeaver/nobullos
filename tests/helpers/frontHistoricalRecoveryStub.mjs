// Task #2022 — Fake `runHistoricalRecovery` used by the Front outbound
// gap-closer recovery-trigger tests. `runOutboundGapCloseTick` reaches
// the recovery pipeline via a dynamic
// `import("./frontHistoricalRecovery")`; the companion resolve hook
// (`frontGapCloserRecoveryLoader.mjs`) redirects that import to THIS
// module so the happy-path test never spawns a real Front recovery job
// (which would hit the Front API and the in-memory recovery registry).
//
// Both the tick (via the loader redirect) and the test file (via a
// direct import of this same path) resolve to one ESM singleton, so the
// recorded calls captured here are visible to the assertions — the same
// guarantee the Task #1980 prod-action drain stub relies on.

let calls = [];
let behavior = null;

export async function runHistoricalRecovery(options) {
  const index = calls.length;
  calls.push(options);
  if (typeof behavior === "function") {
    return behavior(options, index);
  }
  return `stub-recovery-job-${index + 1}`;
}

/**
 * Override the default success behavior. `fn(options, callIndex)` may
 * return a job id (resolved value) or throw to simulate a recovery
 * failure / concurrency-cap deferral.
 */
export function __setRecoveryBehavior(fn) {
  behavior = fn;
}

export function __getRecoveryCalls() {
  return calls.slice();
}

export function __resetRecovery() {
  calls = [];
  behavior = null;
}
