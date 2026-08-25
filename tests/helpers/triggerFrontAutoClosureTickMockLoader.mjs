// Task #2501 — Node ESM resolve hook for the
// `trigger_front_auto_closure_tick` prod-action status/apply safety-net test.
// It redirects two module imports so the test stays off the real database and
// the real Front gate evaluation:
//
//   • `server/storage/prodActionRuns`            → in-memory stub
//     (`prodActionRunsStub.mjs`), whose `getLastSuccessfulProdActionRun`
//     returns null so the action's recent-run (<90s) short-circuit never
//     fires and we exercise the real gate branch instead.
//   • `server/services/frontAutoClosureScheduler` → configurable stub
//     (`frontAutoClosureSchedulerStub.mjs`), so `evaluateFrontAutoClosureGates`
//     and `enqueueManualFrontAutoClosureTick` return controlled outcomes
//     instead of touching the queue / Front token.
//
// Registered via `--import ./tests/helpers/triggerFrontAutoClosureTickSetup.mjs`
// so both hooks are active before the test imports the registry's module graph.
// Mirrors the Task #1980 / #2119 drain loader pattern.

const PROD_ACTION_RUNS_STUB = new URL(
  "./prodActionRunsStub.mjs",
  import.meta.url,
).href;
const SCHEDULER_STUB = new URL(
  "./frontAutoClosureSchedulerStub.mjs",
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
    /\/server\/services\/frontAutoClosureScheduler\.[tj]s$/.test(resolved.url)
  ) {
    return { url: SCHEDULER_STUB, shortCircuit: true, format: "module" };
  }
  return resolved;
}
