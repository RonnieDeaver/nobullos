// Node ESM resolve hook for the ads-os-dashboard-paused-chip test (Task #4865).
//
// The test needs TSX_TSCONFIG_PATH so the React JSX transform resolves.
// No module redirects needed — the test seeds the status-check doc in the
// isolated DB and controls the ClickUp response via the fetch stub, following
// the same approach as ads-os-lsa-dashboard-schedule.test.ts (Task #3681).
export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}
