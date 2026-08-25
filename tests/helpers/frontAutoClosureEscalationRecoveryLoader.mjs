// Task #2120 — Node ESM resolve hook that redirects the auto-closure
// tick's dynamic `import("./frontHistoricalRecovery")` to the in-memory
// stub (`frontAutoClosureEscalationRecoveryStub.mjs`). Registered via
// `--import ./tests/helpers/frontAutoClosureEscalationRecoverySetup.mjs`
// so it is active before
// `tests/front-auto-closure-escalation-e2e.test.ts` drives the tick.
// This keeps the end-to-end escalation suite off the real Front API /
// recovery registry without per-test monkey-patching of an ESM named
// export (which is immutable and cannot be reassigned at runtime).

const STUB_URL = new URL(
  "./frontAutoClosureEscalationRecoveryStub.mjs",
  import.meta.url,
).href;

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
