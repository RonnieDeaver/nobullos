// Task #1980 — Node ESM resolve hook that redirects the drain helper's
// import of `server/storage/prodActionRuns` to the in-memory stub
// (`prodActionRunsStub.mjs`). Registered via
// `--import ./tests/helpers/prodActionDrainSetup.mjs` so it is active
// before `tests/prod-action-background-drain.test.ts` dynamically imports
// the helper. This keeps the drain unit test off the real database
// without per-test monkey-patching of an ESM named export (which is
// immutable and cannot be reassigned at runtime).

const STUB_URL = new URL("./prodActionRunsStub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved?.url &&
    /\/server\/storage\/prodActionRuns\.[tj]s$/.test(resolved.url)
  ) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return resolved;
}
