// Task #2022 — Node ESM resolve hook that redirects the gap-closer
// tick's dynamic `import("./frontHistoricalRecovery")` to the in-memory
// stub (`frontHistoricalRecoveryStub.mjs`). Registered via
// `--import ./tests/helpers/frontGapCloserRecoverySetup.mjs` so it is
// active before `tests/front-outbound-gap-closer.test.ts` runs the
// enabled "happy path" tick. This keeps the recovery-trigger unit test
// off the real Front API / recovery registry without per-test
// monkey-patching of an ESM named export (which is immutable and cannot
// be reassigned at runtime).

const STUB_URL = new URL("./frontHistoricalRecoveryStub.mjs", import.meta.url)
  .href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved?.url &&
    /\/server\/services\/frontHistoricalRecovery\.[tj]s$/.test(resolved.url)
  ) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return resolved;
}
