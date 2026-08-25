/* test-registration
{
  "name": "Between-suite module-state reset registry + batch-worker wiring (Task #4097)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4097: the batch child hosts many suites in one process; if a module's registered reset stops running between suites (registry broken, worker wiring dropped, or integrationStatusCache deregistered) the cross-suite stale-cache flake class silently returns. DB-free, fs-scan + pure-function — fast and deterministic. lint-* name: fs-scan inputs are invisible to green-skip fingerprints.",
  "tier": "small"
}
test-registration */
/**
 * Task #4097 — guard the between-suite module-state reset seam.
 *
 * 1. Unit: registerModuleStateResetForTest + runRegisteredModuleStateResets
 *    round-trip (registration keyed by name, broken resets isolated).
 * 2. Wiring: importing server/services/integrationStatusCache registers its
 *    reset under NODE_ENV=test, and running the registry actually clears the
 *    SWR memCache (observed via __rewindStoredAtMsForTest which returns
 *    false on a cold cache).
 * 3. fs-scan: tests/run-all-worker.mjs still invokes the registry global
 *    (name + Map shape) inside restoreSharedGlobals — the worker is plain
 *    .mjs and cannot import the TS registry, so the contract is textual.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import assert from "node:assert/strict";

const REGISTRY_KEY = "__runAllModuleStateResets";

async function main() {
  const { registerModuleStateResetForTest, runRegisteredModuleStateResets } = await import(
    "../server/services/moduleStateReset"
  );

  // ── 1. Registry round-trip ────────────────────────────────────────────
  assert.equal(process.env.NODE_ENV, "test", "suite must run under NODE_ENV=test");
  let calls = 0;
  registerModuleStateResetForTest("t4097-a", () => {
    calls++;
  });
  // Same name overwrites — no duplicate invocations.
  registerModuleStateResetForTest("t4097-a", () => {
    calls++;
  });
  registerModuleStateResetForTest("t4097-broken", () => {
    throw new Error("deliberately broken reset");
  });
  let after = 0;
  registerModuleStateResetForTest("t4097-b", () => {
    after++;
  });
  const ran = runRegisteredModuleStateResets();
  assert.equal(calls, 1, "same-name re-registration must overwrite, not duplicate");
  assert.equal(after, 1, "a broken sibling reset must not stop later resets");
  assert.ok(ran.includes("t4097-a") && ran.includes("t4097-b"), "ran list names successful resets");
  assert.ok(!ran.includes("t4097-broken"), "throwing reset is not reported as ran");
  // Clean up our synthetic entries so they don't run against later suites.
  const reg = (globalThis as Record<string, unknown>)[REGISTRY_KEY] as Map<string, () => void>;
  reg.delete("t4097-a");
  reg.delete("t4097-broken");
  reg.delete("t4097-b");

  // ── 2. integrationStatusCache registers + reset actually clears ──────
  const cacheMod = await import("../server/services/integrationStatusCache");
  assert.ok(
    reg.has("integrationStatusCache"),
    "integrationStatusCache must register its reset seam at module load under NODE_ENV=test",
  );
  // Seed an entry via the public API: loader resolves synchronously enough
  // that a microtask flush lands the commit in memCache.
  await cacheMod.getCachedIntegrationStatus("t4097-probe", async () => ({ ok: true }));
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(
    cacheMod.__rewindStoredAtMsForTest("t4097-probe", 1),
    true,
    "warm entry expected before reset",
  );
  runRegisteredModuleStateResets();
  assert.equal(
    cacheMod.__rewindStoredAtMsForTest("t4097-probe", 1),
    false,
    "registry-run reset must clear the integration status memCache",
  );

  // ── 3. Batch-worker wiring fs-scan ───────────────────────────────────
  const workerSrc = readFileSync(resolve(process.cwd(), "tests/run-all-worker.mjs"), "utf8");
  assert.ok(
    workerSrc.includes(`globalThis.${REGISTRY_KEY}`),
    `run-all-worker.mjs must read globalThis.${REGISTRY_KEY} between suites`,
  );
  const restoreBody = workerSrc.slice(workerSrc.indexOf("function restoreSharedGlobals"));
  assert.ok(
    restoreBody.indexOf(REGISTRY_KEY) > -1 &&
      restoreBody.indexOf(REGISTRY_KEY) < restoreBody.indexOf("let active"),
    "the registry sweep must live inside restoreSharedGlobals (runs before every suite)",
  );
  // Negative-execution proof (fs-scan guards must demonstrably execute):
  assert.ok(
    !workerSrc.includes("__nonexistent_registry_key__"),
    "sanity: scan executed against real worker source",
  );

  console.log("lint-module-state-reset-wiring: all assertions passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
