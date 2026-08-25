// Task #2705 — shared stub for the "Bring it to 100%" orchestration test.
//
// The resolve hook in `frontBringTo100OrchestratorLoader.mjs` redirects every
// module `startFrontBringTo100` dynamically imports to THIS file, so the
// orchestration test exercises the step wiring (order + inclusion of the new
// `4.recover_plan_limited` step) without touching the real Front token, queue,
// recovery driver, or prod-actions registry / database graph.
//
// Each driver records its label into `globalThis.__frontBringTo100Calls` in the
// exact order the orchestrator invokes it, so the test can assert ordering. The
// two gate inputs (`frontAuthBreakerActive`, `isQueuePaused`) read controllable
// globals so the test can drive the blocked / recovery-paused branches too.

function record(label) {
  if (!Array.isArray(globalThis.__frontBringTo100Calls)) {
    globalThis.__frontBringTo100Calls = [];
  }
  globalThis.__frontBringTo100Calls.push(label);
}

// ── frontAuthBreaker ─────────────────────────────────────────────────────────
export function frontAuthBreakerActive() {
  return globalThis.__frontStubAuthBlocked === true;
}

// ── queueDrainControl ────────────────────────────────────────────────────────
export function isQueuePaused(_queue) {
  return globalThis.__frontStubRecoveryPaused === true;
}

// ── frontHistoricalRecovery ──────────────────────────────────────────────────
export async function runHistoricalRecovery(_opts) {
  record("runHistoricalRecovery");
  if (globalThis.__frontStubRecoveryConcurrencyCap === true) {
    const err = new Error("a recovery run is already in progress");
    err.name = "RecoveryConcurrencyCapError";
    throw err;
  }
}

// ── prodActionsRegistry (the four convergent drivers) ────────────────────────
export async function applyFinishFrontMessageGrainCoverage(_actorId) {
  record("applyFinishFrontMessageGrainCoverage");
  return { state: "applied", detail: "stub finish grain" };
}

export async function applyReachFrontCoverageFull(_actorId) {
  record("applyReachFrontCoverageFull");
  return { state: "applied", detail: "stub reach full" };
}

export async function applyRecoverFrontPlanLimitedMessages(_actorId) {
  record("applyRecoverFrontPlanLimitedMessages");
  return { state: "applied", detail: "stub recover plan-limited" };
}

export async function applyBackfillFrontMessageAttribution(_actorId) {
  record("applyBackfillFrontMessageAttribution");
  return { state: "applied", detail: "stub attribution backfill" };
}
