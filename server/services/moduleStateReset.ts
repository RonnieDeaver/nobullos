/**
 * Task #4097 — between-suite module-state reset registry.
 *
 * The batched test runner (tests/run-all-worker.mjs) hosts several suites
 * in ONE Node process, so module-global state (SWR caches, single-flight
 * maps, debounce timestamps…) survives from one suite to the next. A suite
 * that doesn't defensively call a module's `__reset…ForTest()` seam can see
 * a sibling's stale entry — Task #3824 fixed exactly one such flake
 * per-suite; this registry closes the class.
 *
 * Contract:
 *   - A module with cross-suite-poisonous module-global state calls
 *     `registerModuleStateResetForTest(name, fn)` at module load, right
 *     next to its existing `__reset…ForTest()` seam (usually passing that
 *     very function).
 *   - Registration is a no-op outside NODE_ENV=test, so production code
 *     paths carry zero cost and no global is ever created.
 *   - The registry lives on `globalThis` (not module state) so the plain
 *     .mjs batch worker can invoke it WITHOUT importing any TS module —
 *     importing e.g. server/db from the worker would warm pools for suites
 *     that never need them. Only modules a suite actually loaded are
 *     registered, so only their state is reset.
 *   - Keyed by name: the worker cache-busts suite ENTRY modules
 *     (?runAllSeq=…), but imported server modules stay in the ESM cache,
 *     so re-registration under the same name simply overwrites — no
 *     duplicate invocations.
 *
 * The batch worker calls `runRegisteredModuleStateResets()`'s logic
 * inline (it cannot import this TS file); keep the global's name and
 * shape (`Map<string, () => void>`) in sync with
 * tests/run-all-worker.mjs `restoreSharedGlobals()`.
 */

const REGISTRY_KEY = "__runAllModuleStateResets";

type ResetRegistry = Map<string, () => void>;

function getRegistry(): ResetRegistry {
  const g = globalThis as Record<string, unknown>;
  let reg = g[REGISTRY_KEY] as ResetRegistry | undefined;
  if (!(reg instanceof Map)) {
    reg = new Map();
    g[REGISTRY_KEY] = reg;
  }
  return reg;
}

/**
 * Register a synchronous reset function for a module's cross-suite
 * global state. No-op outside NODE_ENV=test.
 */
export function registerModuleStateResetForTest(name: string, fn: () => void): void {
  if (process.env.NODE_ENV !== "test") return;
  getRegistry().set(name, fn);
}

/**
 * Invoke every registered reset. Exposed for tests of the registry
 * itself; the batch worker duplicates this logic inline in .mjs.
 */
export function runRegisteredModuleStateResets(): string[] {
  const ran: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const reg = g[REGISTRY_KEY];
  if (!(reg instanceof Map)) return ran;
  for (const [name, fn] of reg as ResetRegistry) {
    try {
      fn();
      ran.push(name);
    } catch (err) {
      // A broken reset must not fail an unrelated suite — log loudly.
      console.error(`[moduleStateReset] reset "${name}" threw:`, err);
    }
  }
  return ran;
}
