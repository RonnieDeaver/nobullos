// Task #2228 — Node ESM resolve hook for the re-arm unpark-race drain
// test. It redirects three module imports so the test stays off the real
// Front API and prod_action_runs table while still using the real
// auto-closure state read/write path (so the unpark race is exercised):
//
//   • `server/storage/prodActionRuns`           → in-memory stub
//     (`prodActionRunsStub.mjs`), so the drain's finalize-audit never
//     writes the real `prod_action_runs` table.
//   • `server/services/frontHistoricalRecovery` → configurable stub
//     (`frontHistoricalRecoveryReArmStub.mjs`), so any Front walk that
//     DID run would be observable via the call counter (it must stay 0
//     on the null/skipped path).
//   • `server/storage/settingsStorage`          → transparent wrapper
//     (`settingsStorageReArmRaceStub.mjs`) that can strip a parked
//     window from a SETTING_STATE read to simulate a concurrent unpark.
//     The wrapper's OWN import of the real settingsStorage is left
//     un-redirected (parentURL guard) so there is no redirect loop.
//
// Registered via `--import ./tests/helpers/reArmRaceDrainSetup.mjs` so
// all hooks are active before the test dynamically imports the real
// module graph. Mirrors the Task #2119 one-window drain loader pattern.

const PROD_ACTION_RUNS_STUB = new URL(
  "./prodActionRunsStub.mjs",
  import.meta.url,
).href;
const FRONT_RECOVERY_STUB = new URL(
  "./frontHistoricalRecoveryReArmStub.mjs",
  import.meta.url,
).href;
const SETTINGS_STORAGE_STUB = new URL(
  "./settingsStorageReArmRaceStub.mjs",
  import.meta.url,
).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  const url = resolved?.url ?? "";

  // Never redirect the wrapper stub's own import of the REAL
  // settingsStorage, or we'd loop forever.
  const fromRaceStub = context.parentURL?.includes(
    "settingsStorageReArmRaceStub.mjs",
  );
  if (
    !fromRaceStub &&
    /\/server\/storage\/settingsStorage\.[tj]s$/.test(url)
  ) {
    return {
      url: SETTINGS_STORAGE_STUB,
      shortCircuit: true,
      format: "module",
    };
  }
  if (/\/server\/storage\/prodActionRuns\.[tj]s$/.test(url)) {
    return { url: PROD_ACTION_RUNS_STUB, shortCircuit: true, format: "module" };
  }
  if (/\/server\/services\/frontHistoricalRecovery\.[tj]s$/.test(url)) {
    return { url: FRONT_RECOVERY_STUB, shortCircuit: true, format: "module" };
  }
  return resolved;
}
