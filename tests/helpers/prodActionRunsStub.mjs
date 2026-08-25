// Task #1980 — Fake `recordProdActionRun` used by the prod-action
// background-drain unit test. The drain helper imports
// `recordProdActionRun` from `server/storage/prodActionRuns`; the
// companion resolve hook (`prodActionDrainMockLoader.mjs`) redirects that
// import to THIS module so the test never touches the real
// `prod_action_runs` table / database.
//
// Both the drain helper (via the loader redirect) and the test file (via
// a direct import of this same path) resolve to one ESM singleton, so
// the recorded rows captured here are visible to the assertions.

const recordedRuns = [];

export async function recordProdActionRun(data) {
  const row = {
    id: `stub-${recordedRuns.length + 1}`,
    actionId: data.actionId,
    actionTitle: data.actionTitle,
    actorUserId: data.actorUserId ?? null,
    outcomeState: data.outcomeState,
    detail: data.detail ?? null,
    rowsAffected: data.rowsAffected ?? null,
    errorMessage: data.errorMessage ?? null,
    appliedAt: new Date(),
  };
  recordedRuns.push(row);
  return row;
}

export function __getRecordedRuns() {
  return recordedRuns.slice();
}

export function __resetRecordedRuns() {
  recordedRuns.length = 0;
}

// Additional named exports so consumers that import the WHOLE
// `server/storage/prodActionRuns` module (e.g. the prod-actions registry,
// pulled in by the Task #2156 all-windows re-arm e2e) can still resolve.
// They are not exercised by the re-arm drain path — the bulk status reader
// (`getProdActionStatuses`) uses them, but the e2e calls a single action's
// `status()` / `apply()` directly — so empty/no-op results are safe.
export async function ensureProdActionRunsTable() {
  /* no-op: the stub keeps rows in memory */
}

export async function listProdActionRuns(/* limit */) {
  return recordedRuns.slice();
}

export async function getLastProdActionRunsForActions(/* actionIds */) {
  return new Map();
}

export async function getLastSuccessfulProdActionRun(/* actionId */) {
  return null;
}
