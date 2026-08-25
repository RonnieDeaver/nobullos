/* test-registration
{
  "name": "Manual reserve mute (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * Verifies that the manual-reserve alert mute control:
 *   - persists state across reads (system_settings backed)
 *   - causes deliverManualReserveAlerts to short-circuit while active
 *   - expires automatically once mutedUntil is in the past
 *   - rejects invalid inputs (past timestamp, non-finite, > 7d cap)
 *
 * Alerts must still appear in the in-memory currentAlerts list — only the
 * external dispatch is silenced — but that path is already covered by
 * tests/manual-reserve-alerts.test.ts; here we focus on the mute helpers.
 */

delete process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID;

async function main() {
  const mod = await import("../server/services/manualReserveAlerts");
  const settings = await import("../server/storage/settingsStorage");

  // Clean slate: remove any pre-existing mute row from previous runs.
  await mod.clearManualReserveMute();

  // 1. Initial state: not muted.
  let state = await mod.getManualReserveMuteState();
  assert(state.muted === false, "expected not muted initially");
  assert(state.mutedUntil === null, "mutedUntil should be null initially");
  assert((await mod.isManualReserveAlertMuted()) === false, "isMuted should be false");

  // 2. Set a mute for ~10 minutes.
  const tenMin = Date.now() + 10 * 60_000;
  state = await mod.setManualReserveMute({
    mutedUntil: tenMin,
    mutedBy: null,
    reason: "scheduled semrush_inventory_sync backfill",
  });
  assert(state.muted === true, "expected muted=true after set");
  assert(state.mutedUntil === Math.floor(tenMin), "mutedUntil should match input");
  assert(state.reason === "scheduled semrush_inventory_sync backfill", "reason persisted");

  // 3. Persistence: re-read via storage layer directly.
  const row = await settings.getSystemSetting("manual_reserve_alert_mute");
  assert(!!row && !!row.value, "system_settings row should exist");
  const parsed = JSON.parse(row!.value!);
  assert(parsed.mutedUntil === Math.floor(tenMin), "stored mutedUntil should match");

  // 4. deliverManualReserveAlerts short-circuits with muted: true.
  const fakeAlerts = [
    {
      metric: "manual_wait_p95_ms" as const,
      value: 9999,
      threshold: 5000,
      severity: "critical" as const,
      message: "synthetic",
    },
  ];
  const result = await mod.deliverManualReserveAlerts(fakeAlerts);
  assert(result.sent === false, "expected sent=false while muted");
  assert(result.muted === true, "expected muted=true flag in delivery result");

  // 5. Expired mute: set in the past via direct write, then verify.
  await settings.setSystemSetting(
    "manual_reserve_alert_mute",
    JSON.stringify({
      mutedUntil: Date.now() - 1000,
      mutedAt: Date.now() - 60_000,
      mutedBy: null,
      reason: null,
    }),
  );
  state = await mod.getManualReserveMuteState();
  assert(state.muted === false, "expired mute should report muted=false");
  assert((await mod.isManualReserveAlertMuted()) === false, "expired mute should not block");

  // 6. Validation: past timestamp rejected.
  let threw = false;
  try {
    await mod.setManualReserveMute({ mutedUntil: Date.now() - 1, mutedBy: null });
  } catch {
    threw = true;
  }
  assert(threw, "expected past mutedUntil to be rejected");

  // 7. Validation: > 7d cap rejected.
  threw = false;
  try {
    await mod.setManualReserveMute({
      mutedUntil: Date.now() + 30 * 24 * 60 * 60_000,
      mutedBy: null,
    });
  } catch {
    threw = true;
  }
  assert(threw, "expected mute beyond 7d cap to be rejected");

  // 8. Validation: non-finite rejected.
  threw = false;
  try {
    await mod.setManualReserveMute({ mutedUntil: Number.NaN, mutedBy: null });
  } catch {
    threw = true;
  }
  assert(threw, "expected NaN mutedUntil to be rejected");

  // 9. Clear leaves a clean state.
  await mod.clearManualReserveMute();
  state = await mod.getManualReserveMuteState();
  assert(state.muted === false, "after clear, muted=false");
  assert(state.mutedUntil === null, "after clear, mutedUntil=null");

  console.log("manual-reserve-mute: all cases passed");
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
