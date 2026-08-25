/* test-registration
{
  "name": "Manual reserve resend",
  "tier": "medium"
}
test-registration */
import assert from "node:assert/strict";
import {
  resendManualReserveAlert,
  __resetManualReserveAlertDispatchesForTest,
  __pushManualReserveDispatchForTest,
  type ManualReserveAlertDispatch,
} from "../server/services/manualReserveAlerts";
import { __resetAlertResendGuardForTest } from "../server/services/alertResendGuard";

function makeDispatch(overrides: Partial<ManualReserveAlertDispatch> = {}): ManualReserveAlertDispatch {
  return {
    timestamp: Date.now(),
    metric: "manual_reserve_failure_rate",
    severity: "warning",
    message: "test alert",
    value: 0.5,
    threshold: 0.3,
    status: "failed",
    detail: "seeded",
    ...overrides,
  };
}

async function run() {
  __resetManualReserveAlertDispatchesForTest();
  __resetAlertResendGuardForTest();

  // 1. not_found when no dispatch matches the timestamp
  const missing = await resendManualReserveAlert({
    timestamp: 999999,
    actorId: "u1",
    source: "admin_ui",
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "not_found");

  // 2. not_eligible when target dispatch is not in 'failed' state
  const sent = makeDispatch({ status: "sent" });
  __pushManualReserveDispatchForTest(sent);
  const ineligible = await resendManualReserveAlert({
    timestamp: sent.timestamp,
    metric: sent.metric,
    severity: sent.severity,
    actorId: "u1",
    source: "admin_ui",
  });
  assert.equal(ineligible.ok, false);
  if (!ineligible.ok) assert.equal(ineligible.reason, "not_eligible");

  // 3. metric+severity disambiguation: two dispatches share a timestamp;
  //    requesting a non-matching severity should yield not_found.
  __resetManualReserveAlertDispatchesForTest();
  __resetAlertResendGuardForTest();
  const sharedTs = Date.now() + 1000;
  __pushManualReserveDispatchForTest(makeDispatch({ timestamp: sharedTs, severity: "warning" }));
  __pushManualReserveDispatchForTest(makeDispatch({ timestamp: sharedTs, severity: "critical" }));
  const wrong = await resendManualReserveAlert({
    timestamp: sharedTs,
    severity: "warning",
    metric: "nonexistent_metric",
    actorId: "u1",
    source: "admin_ui",
  });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.reason, "not_found");

  console.log("manual-reserve-resend.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
