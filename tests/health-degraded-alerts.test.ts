/* test-registration
{
  "name": "Health degraded sub-check alerts (Task #1073)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1073 regression tests: persistent-degraded health sub-check alerts.
 *
 * Stubs both the degraded-set evaluator and the dispatcher so no real
 * sub-check or Slack call is touched. Drives the watcher with synthetic
 * "now" values to exercise the per-key threshold, cooldown, and
 * auto-resolve behaviours.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import {
  checkDegradedSubChecks,
  __testHelpers,
  SETTING_ENABLED,
  SETTING_CRITICAL_MINUTES,
  SETTING_DEFAULT_MINUTES,
  SETTING_COOLDOWN_MINUTES,
  SETTING_PER_KEY_PREFIX,
  SETTING_PER_KEY_SUFFIX,
} from "../server/services/healthDegradedAlerts";
import { _resetDegradedTrackerForTests } from "../server/services/healthDegradedTracker";

const SETTINGS_TO_CLEAN = [
  SETTING_ENABLED,
  SETTING_CRITICAL_MINUTES,
  SETTING_DEFAULT_MINUTES,
  SETTING_COOLDOWN_MINUTES,
  `${SETTING_PER_KEY_PREFIX}scheduler_stale${SETTING_PER_KEY_SUFFIX}`,
];

async function cleanup(): Promise<void> {
  for (const k of SETTINGS_TO_CLEAN) {
    try { await storage.deleteSystemSetting(k); } catch {}
  }
  __testHelpers.resetLastAlertCache();
  __testHelpers.setDispatcherForTests(null);
  __testHelpers.setEvaluatorForTests(null);
  _resetDegradedTrackerForTests();
}

interface DispatchCall {
  text: string;
  metadata: Record<string, unknown>;
}

function installDispatcherStub(calls: DispatchCall[]): void {
  __testHelpers.setDispatcherForTests(async (_id, payload, opts) => {
    calls.push({ text: payload.text, metadata: (opts.metadata ?? {}) as Record<string, unknown> });
    return { delivered: true, status: "sent" };
  });
}

async function run(): Promise<void> {
  await cleanup();

  // Configure: critical 10m, default 30m, cooldown 60m.
  await storage.setSystemSetting(SETTING_ENABLED, "true", "system");
  await storage.setSystemSetting(SETTING_CRITICAL_MINUTES, "10", "system");
  await storage.setSystemSetting(SETTING_DEFAULT_MINUTES, "30", "system");
  await storage.setSystemSetting(SETTING_COOLDOWN_MINUTES, "60", "system");

  // ── Case 1: below threshold → no alert ────────────────────────────
  let degradedKeys: string[] = ["db"];
  __testHelpers.setEvaluatorForTests(async () => ({ degraded: degradedKeys }));

  const t0 = 1_700_000_000_000;
  const callsA: DispatchCall[] = [];
  installDispatcherStub(callsA);

  let r = await checkDegradedSubChecks(t0);
  assert.equal(r.alertsSent, 0, "first tick: episode just opened, below threshold");
  assert.equal(r.perKey[0]!.decision, "skipped_below_threshold");

  // 9 minutes later — still under the 10m critical threshold.
  r = await checkDegradedSubChecks(t0 + 9 * 60_000);
  assert.equal(r.alertsSent, 0, "9m elapsed: still below 10m critical threshold");
  assert.equal(callsA.length, 0);

  // ── Case 2: crosses critical threshold → fires once ───────────────
  r = await checkDegradedSubChecks(t0 + 11 * 60_000);
  assert.equal(r.alertsSent, 1, "11m elapsed: must fire critical alert");
  assert.equal(callsA.length, 1);
  assert.match(callsA[0]!.text, /db/);
  assert.match(callsA[0]!.text, /degraded/i);
  assert.equal(callsA[0]!.metadata.event, "firing");
  assert.equal(callsA[0]!.metadata.isCritical, true);

  // ── Case 3: cooldown suppresses re-fire ───────────────────────────
  r = await checkDegradedSubChecks(t0 + 30 * 60_000);
  assert.equal(r.alertsSent, 0, "still within 60m cooldown");
  assert.equal(r.perKey[0]!.decision, "skipped_cooldown");

  // ── Case 4: past cooldown, still degraded → re-fire ───────────────
  r = await checkDegradedSubChecks(t0 + 75 * 60_000);
  assert.equal(r.alertsSent, 1, "past cooldown: must re-alert");
  assert.equal(callsA.length, 2);

  // ── Case 5: auto-resolve when key drops out ───────────────────────
  degradedKeys = [];
  r = await checkDegradedSubChecks(t0 + 80 * 60_000);
  assert.equal(r.cleared, 1, "must send a cleared message");
  assert.equal(callsA.length, 3);
  assert.match(callsA[2]!.text, /recovered/i);
  assert.equal(callsA[2]!.metadata.event, "cleared");

  // After clear, a re-degradation must start a fresh episode (no
  // immediate alert because the new episode is < threshold).
  degradedKeys = ["db"];
  r = await checkDegradedSubChecks(t0 + 85 * 60_000);
  assert.equal(r.alertsSent, 0, "fresh episode starts below threshold");
  assert.equal(r.perKey[0]!.decision, "skipped_below_threshold");

  // ── Case 6: per-key override beats the soft default ───────────────
  await cleanup();
  await storage.setSystemSetting(SETTING_ENABLED, "true", "system");
  await storage.setSystemSetting(SETTING_DEFAULT_MINUTES, "30", "system");
  await storage.setSystemSetting(
    `${SETTING_PER_KEY_PREFIX}scheduler_stale${SETTING_PER_KEY_SUFFIX}`,
    "5",
    "system",
  );
  degradedKeys = ["scheduler_stale"];
  __testHelpers.setEvaluatorForTests(async () => ({ degraded: degradedKeys }));
  const callsB: DispatchCall[] = [];
  installDispatcherStub(callsB);

  // Open episode at t0; at t0+6m we're past the 5m override (would NOT
  // be past the 30m default).
  await checkDegradedSubChecks(t0);
  r = await checkDegradedSubChecks(t0 + 6 * 60_000);
  assert.equal(r.alertsSent, 1, "per-key override (5m) must take effect");
  assert.equal(callsB.length, 1);
  assert.equal(callsB[0]!.metadata.thresholdMin, 5);
  assert.equal(callsB[0]!.metadata.isCritical, false);

  // ── Case 7: kill switch suppresses everything ─────────────────────
  await cleanup();
  await storage.setSystemSetting(SETTING_ENABLED, "false", "system");
  degradedKeys = ["db"];
  __testHelpers.setEvaluatorForTests(async () => ({ degraded: degradedKeys }));
  const callsC: DispatchCall[] = [];
  installDispatcherStub(callsC);

  await checkDegradedSubChecks(t0);
  r = await checkDegradedSubChecks(t0 + 30 * 60_000);
  assert.equal(r.alertsSent, 0);
  assert.equal(callsC.length, 0);
  assert.equal(r.perKey[0]!.decision, "skipped_disabled");

  await cleanup();
  console.log("health-degraded-alerts.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {})
  .catch(async (err) => {
    console.error(err);
    try { await cleanup(); } catch {}
    process.exitCode = 1;
  });
