// Task #2119 — Configurable stub for `runTargetedWindowBackfill` used by
// the single-window re-arm background-drain test. The drain path reaches
// the real Front walk via `reArmOneParkedWindow`'s dynamic
// `import("./frontHistoricalRecovery")`; the companion resolve hook
// (`oneWindowReArmDrainMockLoader.mjs`) redirects that import to THIS
// module so the test never makes real Front API calls.
//
// Both the consumer (via the loader redirect) and the test file (via a
// direct import of this same path) resolve to one ESM singleton, so the
// call count + configured checkpoint set here are visible to assertions.

// Default to a `still_empty`-classified checkpoint: a search-strategy
// page-cap dead run with 0 ingested keeps the window parked and stamps a
// terminal `reArmOutcome`, so the drain converges after a single pass.
const DEFAULT_CHECKPOINT = {
  windowLabel: "stub",
  afterTimestamp: 0,
  beforeTimestamp: 0,
  status: "partial",
  statusReason:
    "safety_max_pages_reached_resume_available scanned=25000 ingested=0",
  scanned: 25000,
  ingested: 0,
  skipped: 0,
  errors: [],
  pages: 1,
  lastPageUrl: "/conversations/search/after:1/before:2?page_token=abc",
  startedAt: null,
  completedAt: null,
};

let callCount = 0;
let nextCheckpoint = { ...DEFAULT_CHECKPOINT };
// Optional one-shot gate so a test can hold the Front walk mid-flight and
// observe a drain as "running" deterministically before letting it finish.
// Null by default → no gating, so existing suites are unaffected.
let gate = null;

export async function runTargetedWindowBackfill(window /* , options */) {
  callCount += 1;
  if (gate) await gate;
  return {
    ...nextCheckpoint,
    windowLabel: window?.label ?? nextCheckpoint.windowLabel,
    afterTimestamp: window?.afterTimestamp ?? nextCheckpoint.afterTimestamp,
    beforeTimestamp: window?.beforeTimestamp ?? nextCheckpoint.beforeTimestamp,
    completedAt: new Date().toISOString(),
  };
}

export function __setNextCheckpoint(cp) {
  nextCheckpoint = { ...nextCheckpoint, ...cp };
}

export function __getCallCount() {
  return callCount;
}

/**
 * Install a one-shot gate: the next `runTargetedWindowBackfill` call(s)
 * block on the returned barrier until the test calls the release fn. Once
 * released the gate is cleared (resolved), so any subsequent walks return
 * immediately.
 */
export function __installGate() {
  let release;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  return () => {
    gate = null;
    release();
  };
}

export function __resetStub() {
  callCount = 0;
  nextCheckpoint = { ...DEFAULT_CHECKPOINT };
  gate = null;
}
