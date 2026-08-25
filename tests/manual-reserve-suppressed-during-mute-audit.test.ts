/* test-registration
{
  "name": "Manual reserve suppressed-during-mute audit (Task #1196)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1196 — pin behavior of the suppressed-during-mute audit path inside
 * `deliverManualReserveAlerts` (Task #725).
 *
 * When a mute is active, the function must short-circuit external dispatch
 * but still record an audit row so operators can see what *would* have been
 * sent and why. This test verifies:
 *   1. A muted dispatch lands in the dispatch buffer with the expected
 *      shape (eventType="muted", status="muted", mutedBy, muteReason,
 *      detail mentions "Dispatch suppressed by active mute").
 *   2. The per-key muted-audit cooldown (`lastMutedAuditAt` + COOLDOWN_MS)
 *      suppresses a second muted-audit row for the same (metric, severity)
 *      while the cooldown is active, but allows a fresh row once the
 *      cooldown is cleared (proxy for elapsed time).
 *   3. A different (metric, severity) key is *not* gated by another key's
 *      cooldown.
 */

delete process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID;

async function main(): Promise<void> {
  const mod = await import("../server/services/manualReserveAlerts");

  // Clean slate.
  await mod.clearManualReserveMute();
  mod.__resetManualReserveAlertDispatchesForTest();
  mod.__resetManualReserveAlertCooldownsForTest();

  // Force the DB-list helper to throw so getRecentManualReserveAlertDispatches
  // returns the in-memory ring buffer (newest-first). This lets us assert on
  // the same buffer that persistDispatches writes to synchronously.
  mod.__test_setListManualReserveAlertDispatchesOverride(async () => {
    throw new Error("force fallback");
  });

  try {
    // 1. Install a manual mute.
    const tenMin = Date.now() + 10 * 60_000;
    await mod.setManualReserveMute({
      mutedUntil: tenMin,
      mutedBy: null,
      reason: "ops investigation",
    });

    const p95Alert = {
      metric: "manual_wait_p95_ms" as const,
      value: 9999,
      threshold: 5000,
      severity: "critical" as const,
      message: "p95 critical breach",
    };
    const timeoutAlert = {
      metric: "manual_timeout_window" as const,
      value: 7,
      threshold: 3,
      severity: "critical" as const,
      message: "timeouts spiking",
    };

    // 2. Muted dispatch: result.muted=true, sent=false.
    const result = await mod.deliverManualReserveAlerts([p95Alert]);
    assert(result.sent === false, "expected sent=false while muted");
    assert(result.muted === true, "expected muted=true flag");

    // The buffer push happens synchronously inside persistDispatches before
    // the awaited DB write, so it's observable immediately on return.
    let history = await mod.getRecentManualReserveAlertDispatches(50);
    const mutedRows = history.filter((r) => r.eventType === "muted");
    assert(mutedRows.length === 1, `expected 1 muted row, got ${mutedRows.length}`);
    const row = mutedRows[0];
    assert(row.status === "muted", `expected status=muted, got ${row.status}`);
    assert(row.metric === "manual_wait_p95_ms", "metric forwarded");
    assert(row.severity === "critical", "severity forwarded");
    assert(row.value === 9999, "value forwarded");
    assert(row.threshold === 5000, "threshold forwarded");
    assert(row.mutedBy === null, `mutedBy forwarded (null), got ${row.mutedBy}`);
    assert(row.muteReason === "ops investigation", `muteReason forwarded, got ${row.muteReason}`);
    assert(
      typeof row.detail === "string" && row.detail.startsWith("Dispatch suppressed by active mute"),
      `detail should describe suppression, got ${row.detail}`,
    );
    assert(
      typeof row.detail === "string" && row.detail.includes("until "),
      "detail should include mute expiry",
    );

    // 3. Cooldown suppresses a second muted-audit row for the same key on
    //    the very next sampler tick.
    const result2 = await mod.deliverManualReserveAlerts([p95Alert]);
    assert(result2.muted === true, "still muted on second call");
    history = await mod.getRecentManualReserveAlertDispatches(50);
    const mutedRowsAfter = history.filter(
      (r) => r.eventType === "muted" && r.metric === "manual_wait_p95_ms",
    );
    assert(
      mutedRowsAfter.length === 1,
      `cooldown should suppress duplicate; got ${mutedRowsAfter.length} rows`,
    );

    // 4. A *different* (metric, severity) key has its own cooldown bucket
    //    and must produce its own muted-audit row on the same tick.
    await mod.deliverManualReserveAlerts([timeoutAlert]);
    history = await mod.getRecentManualReserveAlertDispatches(50);
    const timeoutMuted = history.filter(
      (r) => r.eventType === "muted" && r.metric === "manual_timeout_window",
    );
    assert(
      timeoutMuted.length === 1,
      `expected separate cooldown bucket for distinct key, got ${timeoutMuted.length}`,
    );

    // 5. After the cooldown elapses (simulated by clearing the cooldown
    //    map — the helper exists exactly for this kind of time-warp), a
    //    new muted-audit row for the same key is allowed.
    mod.__resetManualReserveAlertCooldownsForTest();
    await mod.deliverManualReserveAlerts([p95Alert]);
    history = await mod.getRecentManualReserveAlertDispatches(50);
    const p95MutedFinal = history.filter(
      (r) => r.eventType === "muted" && r.metric === "manual_wait_p95_ms",
    );
    assert(
      p95MutedFinal.length === 2,
      `post-cooldown call should add a new row; got ${p95MutedFinal.length} total`,
    );
  } finally {
    mod.__test_setListManualReserveAlertDispatchesOverride(null);
    mod.__resetManualReserveAlertDispatchesForTest();
    mod.__resetManualReserveAlertCooldownsForTest();
    await mod.clearManualReserveMute();
  }

  console.log("manual-reserve-suppressed-during-mute-audit: OK");
}

function assert(cond: unknown, msg: string): void {
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
