/**
 * The sibling assertion for suite-a-module-state.ts. This starts in the same
 * worker, so a failure proves the worker skipped canonical module resets.
 */
if ((globalThis as Record<string, unknown>).__batchWorkerModuleStateFixture !== undefined) {
  throw new Error("module-state reset did not run before the next batched suite");
}

console.log("[suite-b-module-state] no sibling module state survived");