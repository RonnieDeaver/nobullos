/* test-registration
{
  "name": "Alert resend guard",
  "tier": "small"
}
test-registration */
import assert from "node:assert/strict";
import {
  attemptResend,
  getLastResend,
  listRecentResends,
  __resetAlertResendGuardForTest,
  ALERT_RESEND_GUARD_DEFAULT_COOLDOWN_MS,
} from "../server/services/alertResendGuard";

async function run() {
  __resetAlertResendGuardForTest();

  // 1. Basic execution + history + actor recording.
  let executions = 0;
  const ok = await attemptResend({
    alertType: "test_alert",
    alertId: "alert-1",
    destinations: ["slack", "email"],
    actor: { userId: "user-1", source: "admin_ui" },
    execute: async () => {
      executions++;
      return {
        channels: [
          { destination: "slack", status: "sent" as const },
          { destination: "email", status: "sent" as const },
        ],
      };
    },
  });
  assert.equal(ok.status, "executed", "first attempt should execute");
  assert.equal(executions, 1);
  if (ok.status === "executed") {
    assert.equal(ok.actor.userId, "user-1");
    assert.equal(ok.actor.source, "admin_ui");
  }

  const last = getLastResend("test_alert", "alert-1");
  assert.ok(last, "history entry should be recorded");
  assert.equal(last!.actor.userId, "user-1");
  assert.equal(last!.destinations.length, 2);

  const recent = listRecentResends({ alertType: "test_alert", limit: 5 });
  assert.equal(recent.length, 1);

  // 2. Cooldown blocks a second attempt to same alert/destination.
  const cooled = await attemptResend({
    alertType: "test_alert",
    alertId: "alert-1",
    destinations: ["slack"],
    actor: { userId: "user-2", source: "admin_ui" },
    execute: async () => {
      executions++;
      return { channels: [{ destination: "slack", status: "sent" as const }] };
    },
  });
  assert.equal(cooled.status, "cooldown", "second immediate attempt should cooldown");
  assert.equal(executions, 1, "execute() must not run during cooldown");
  if (cooled.status === "cooldown") {
    assert.deepEqual(cooled.blockedDestinations, ["slack"]);
    assert.ok(cooled.cooldownRemainingMs > 0);
    assert.ok(
      cooled.cooldownRemainingMs <= ALERT_RESEND_GUARD_DEFAULT_COOLDOWN_MS,
      "remaining cooldown must not exceed default",
    );
  }

  // 3. Different (alertType, alertId, destination) is independent.
  const independent = await attemptResend({
    alertType: "other_alert",
    alertId: "alert-1",
    destinations: ["slack"],
    actor: { userId: "user-3", source: "admin_ui" },
    execute: async () => {
      executions++;
      return { channels: [{ destination: "slack", status: "sent" as const }] };
    },
  });
  assert.equal(independent.status, "executed");
  assert.equal(executions, 2);

  // 4. Concurrent attempts collapse to a single execution (in_flight).
  __resetAlertResendGuardForTest();
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const p1 = attemptResend({
    alertType: "race_alert",
    alertId: "r1",
    destinations: ["slack"],
    actor: { userId: "user-1", source: "admin_ui" },
    execute: async () => {
      runs++;
      await gate;
      return { channels: [{ destination: "slack", status: "sent" as const }] };
    },
  });
  // give p1 a moment to register inFlight
  await new Promise((r) => setTimeout(r, 5));
  const p2 = attemptResend({
    alertType: "race_alert",
    alertId: "r1",
    destinations: ["slack"],
    actor: { userId: "user-2", source: "admin_ui" },
    execute: async () => {
      runs++;
      return { channels: [{ destination: "slack", status: "sent" as const }] };
    },
  });
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(runs, 1, "concurrent execute must run only once");
  assert.equal(r1.status, "executed");
  assert.equal(r2.status, "in_flight");

  // 5. Errors thrown in execute are returned as structured 'error' outcome.
  __resetAlertResendGuardForTest();
  const errOutcome = await attemptResend({
    alertType: "boom_alert",
    alertId: "b1",
    destinations: ["slack"],
    actor: { userId: "user-1", source: "admin_ui" },
    execute: async () => {
      throw new Error("boom!");
    },
  });
  assert.equal(errOutcome.status, "error");
  if (errOutcome.status === "error") {
    assert.match(errOutcome.error, /boom/);
  }

  // 6. Empty destinations rejected.
  const empty = await attemptResend({
    alertType: "x",
    alertId: "y",
    destinations: [],
    actor: { userId: null, source: "admin_ui" },
    execute: async () => ({ channels: [] }),
  });
  assert.equal(empty.status, "error");

  console.log("alert-resend-guard.test.ts: OK");
}

run().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
