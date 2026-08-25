// Task #2119 — Node ESM resolve hook for the single-window re-arm
// background-drain test. It redirects two module imports so the test
// stays off the real database and the real Front API:
//
//   • `server/storage/prodActionRuns`        → in-memory stub
//     (`prodActionRunsStub.mjs`), so the drain's finalize-audit never
//     writes the real `prod_action_runs` table.
//   • `server/services/frontHistoricalRecovery` → configurable stub
//     (`frontHistoricalRecoveryReArmStub.mjs`), so `reArmOneParkedWindow`
//     returns a controlled checkpoint instead of walking Front.
//
// Registered via `--import ./tests/helpers/oneWindowReArmDrainSetup.mjs`
// so both hooks are active before the test dynamically imports the real
// module graph. Mirrors the Task #1980 drain loader pattern.

const PROD_ACTION_RUNS_STUB = new URL(
  "./prodActionRunsStub.mjs",
  import.meta.url,
).href;
const FRONT_RECOVERY_STUB = new URL(
  "./frontHistoricalRecoveryReArmStub.mjs",
  import.meta.url,
).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved?.url &&
    /\/server\/storage\/prodActionRuns\.[tj]s$/.test(resolved.url)
  ) {
    return { url: PROD_ACTION_RUNS_STUB, shortCircuit: true, format: "module" };
  }
  if (
    resolved?.url &&
    /\/server\/services\/frontHistoricalRecovery\.[tj]s$/.test(resolved.url)
  ) {
    return { url: FRONT_RECOVERY_STUB, shortCircuit: true, format: "module" };
  }
  return resolved;
}
