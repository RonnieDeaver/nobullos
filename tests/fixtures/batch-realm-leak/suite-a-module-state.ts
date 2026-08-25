/**
 * A module-global fixture that registers its cleanup through the canonical
 * module-state registry. The next suite must not observe this value.
 */
import { registerModuleStateResetForTest } from "../../../server/services/moduleStateReset";

const key = "__batchWorkerModuleStateFixture";
(globalThis as Record<string, unknown>)[key] = "dirty";
registerModuleStateResetForTest("batch-worker-module-state-fixture", () => {
  delete (globalThis as Record<string, unknown>)[key];
});

console.log("[suite-a-module-state] registered module-state reset");