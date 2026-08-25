/* test-registration
{
  "name": "Boot-time alert-probe audit (Task #1882)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1882 — boot-time alert-probe audit registry.
 *
 * Verifies:
 *   1. `registerAlertProbe` deduplicates by name.
 *   2. `runAlertProbeAudit` returns OK for a passing probe and BROKEN
 *      (with error message) for a throwing probe; one broken probe does
 *      not abort the rest.
 *   3. `runBootAlertProbeAudit` skips when disabled via env.
 *   4. The lease-churn module's registered probes actually exercise the
 *      column names they ship — so the next time a probe query is
 *      written with a typo'd column (the original `ai_processing_status`
 *      regression) it fails at boot instead of silently every tick.
 */
import assert from "node:assert/strict";
import {
  registerAlertProbe,
  listRegisteredAlertProbes,
  runAlertProbeAudit,
  runBootAlertProbeAudit,
  __testHelpers,
} from "../server/services/probeAudit";

async function test1_registerAndDedupe(): Promise<void> {
  __testHelpers.resetRegistryForTests();
  registerAlertProbe("a", async () => {});
  registerAlertProbe("b", async () => {});
  registerAlertProbe("a", async () => { throw new Error("should be ignored"); });
  const names = listRegisteredAlertProbes().map((p) => p.name);
  assert.deepEqual(names, ["a", "b"], "duplicates by name are ignored");
  console.log("  ok  Test 1 — register dedupes by name");
}

async function test2_okAndBroken(): Promise<void> {
  __testHelpers.resetRegistryForTests();
  registerAlertProbe("good", async () => {});
  registerAlertProbe("bad", async () => { throw new Error("column does not exist"); });
  registerAlertProbe("good2", async () => {});
  const results = await runAlertProbeAudit();
  assert.equal(results.length, 3);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error ?? "", /column does not exist/);
  assert.equal(results[2].ok, true, "one broken probe does not abort the rest");
  console.log("  ok  Test 2 — OK / BROKEN classification, no early exit");
}

async function test3_disabledViaEnv(): Promise<void> {
  __testHelpers.resetRegistryForTests();
  let ran = false;
  registerAlertProbe("any", async () => { ran = true; });
  const prev = process.env.ALERT_PROBE_AUDIT_ENABLED;
  process.env.ALERT_PROBE_AUDIT_ENABLED = "false";
  try {
    const out = await runBootAlertProbeAudit();
    assert.deepEqual(out, []);
    assert.equal(ran, false, "probes are not invoked when audit is disabled");
  } finally {
    if (prev === undefined) delete process.env.ALERT_PROBE_AUDIT_ENABLED;
    else process.env.ALERT_PROBE_AUDIT_ENABLED = prev;
  }
  console.log("  ok  Test 3 — disabled via ALERT_PROBE_AUDIT_ENABLED=false");
}

async function test4_leaseChurnProbesExerciseRealColumns(): Promise<void> {
  __testHelpers.resetRegistryForTests();
  await import("../server/services/leaseChurnAlerts");
  const names = listRegisteredAlertProbes().map((p) => p.name).sort();
  assert.deepEqual(
    names,
    [
      "leaseChurnAlerts.front_backlog",
      "leaseChurnAlerts.lease_churn",
      "leaseChurnAlerts.raw_communications_inverted",
      "leaseChurnAlerts.semrush_dlq",
    ],
    "leaseChurnAlerts registers all four probes on import",
  );
  const results = await runAlertProbeAudit();
  const broken = results.filter((r) => !r.ok);
  assert.deepEqual(
    broken.map((b) => `${b.name}: ${b.error}`),
    [],
    "every registered leaseChurnAlerts probe runs cleanly against the live schema",
  );
  console.log("  ok  Test 4 — leaseChurnAlerts probes pass real schema check");
}

async function main(): Promise<void> {
  console.log("Probe-audit registry tests (Task #1882)");
  await test1_registerAndDedupe();
  await test2_okAndBroken();
  await test3_disabledViaEnv();
  await test4_leaseChurnProbesExerciseRealColumns();
  console.log("All probe-audit tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
