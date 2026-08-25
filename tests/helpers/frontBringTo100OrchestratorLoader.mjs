// Task #2705 — Node ESM resolve hook for the "Bring it to 100%" orchestration
// test. It redirects every module `startFrontBringTo100` reaches via dynamic
// import to a single in-memory stub (`frontBringTo100OrchestratorStub.mjs`) so
// the test stays off the real Front token / queue / recovery driver / prod-
// actions registry + database graph and can assert pure step wiring.
//
// Redirected specifiers (all dynamic imports inside frontBringTo100.ts):
//   • server/services/frontAuthBreaker        → frontAuthBreakerActive
//   • server/services/queueDrainControl       → isQueuePaused
//   • server/services/frontHistoricalRecovery → runHistoricalRecovery
//   • server/services/prodActionsRegistry     → the 4 convergent apply* drivers
//
// Registered via `--import ./tests/helpers/frontBringTo100OrchestratorSetup.mjs`
// so the hook is active before the test imports the orchestrator module graph.
// Mirrors the Task #2501 trigger-front-auto-closure-tick loader pattern.

const STUB = new URL("./frontBringTo100OrchestratorStub.mjs", import.meta.url)
  .href;

const REDIRECT = [
  /\/server\/services\/frontAuthBreaker\.[tj]s$/,
  /\/server\/services\/queueDrainControl\.[tj]s$/,
  /\/server\/services\/frontHistoricalRecovery\.[tj]s$/,
  /\/server\/services\/prodActionsRegistry\.[tj]s$/,
];

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved?.url && REDIRECT.some((re) => re.test(resolved.url))) {
    return { url: STUB, shortCircuit: true, format: "module" };
  }
  return resolved;
}
