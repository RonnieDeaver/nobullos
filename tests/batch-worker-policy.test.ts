/* test-registration
{
  "name": "Batch worker compatibility and recycle policy (Task #5137)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast DB-free policy guard for the runner's process-sharing boundary: it preserves solo isolation for process-start hooks while proving redundant runner-injected environments can reuse a worker and health recycling cannot remove the hard cap.",
  "scanPaths": ["tests/batchWorkerPolicy.ts"],
  "tier": "small",
  "tierReason": "The source-count heuristic sees multiple policy branches, but this DB-free deterministic assertion set completes in under one second and is intentionally a small routine-gate guard."
}
test-registration */

import assert from "node:assert/strict";
import {
  batchCompatibilityForSuite,
  recycleAfterResult,
  recycleBeforeDispatch,
} from "./batchWorkerPolicy";

const plain = batchCompatibilityForSuite({ file: "tests/plain.test.ts" });
assert.equal(plain.batchable, true);
if (!plain.batchable) throw new Error("plain suite unexpectedly incompatible");

const redundantNodeEnv = batchCompatibilityForSuite({
  file: "tests/redundant-node-env.test.ts",
  extraEnv: { NODE_ENV: "test" },
});
assert.equal(redundantNodeEnv.batchable, true);
if (!redundantNodeEnv.batchable) throw new Error("redundant NODE_ENV unexpectedly incompatible");
assert.equal(
  redundantNodeEnv.key,
  plain.key,
  "NODE_ENV=test is injected by both runner paths and must share the default worker",
);

const tsxDefault = batchCompatibilityForSuite({ file: "tests/client/plain.test.tsx" });
const tsxExplicitConfig = batchCompatibilityForSuite({
  file: "tests/client/explicit.test.tsx",
  extraEnv: { TSX_TSCONFIG_PATH: "./tsconfig.tests.json" },
});
assert.equal(tsxDefault.batchable, true);
assert.equal(tsxExplicitConfig.batchable, true);
if (!tsxDefault.batchable || !tsxExplicitConfig.batchable) {
  throw new Error("tsx suites unexpectedly incompatible");
}
assert.equal(
  tsxExplicitConfig.key,
  tsxDefault.key,
  "the worker already derives the TSX test config, so its redundant declaration may reuse",
);

const distinctEnvironment = batchCompatibilityForSuite({
  file: "tests/sandbox.test.ts",
  extraEnv: { CLICKUP_ROLE_PROJECTION_ENVIRONMENT: "sandbox" },
});
assert.equal(distinctEnvironment.batchable, true);
if (!distinctEnvironment.batchable) throw new Error("sandbox environment unexpectedly incompatible");
assert.notEqual(
  distinctEnvironment.key,
  plain.key,
  "a behavior-changing environment remains in a distinct process-sharing class",
);

assert.deepEqual(
  batchCompatibilityForSuite({
    file: "tests/module-mocking.test.ts",
    extraNodeArgs: ["--import", "./tests/helpers/mock-setup.mjs"],
  }),
  { batchable: false, reason: "process-start-arguments" },
  "loader/import hooks remain solo until their owning module-mocking task proves a shared contract",
);

assert.equal(recycleBeforeDispatch(29, 30), null);
assert.equal(recycleBeforeDispatch(30, 30), "hard-cap");
assert.equal(recycleAfterResult(false), null);
assert.equal(recycleAfterResult(true), "resource-pressure");

console.log("✓ batch-worker policy preserves safe reuse and conservative recycling");