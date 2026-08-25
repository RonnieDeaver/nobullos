/* test-registration
{
  "name": "Manual reserve auto-mute (Task #726)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #726: auto-mute manual-reserve alerts when a known backfill job starts.
 *
 * Verifies the precedence + ownership rules of
 *   setManualReserveMuteForBackfillJob / clearManualReserveMuteForBackfillJob:
 *
 *   1. Auto-mute installs a fresh mute (source=auto, jobId/jobLabel set)
 *      when nothing is currently muted.
 *   2. clearManualReserveMuteForBackfillJob(jobId) clears its OWN auto-mute.
 *   3. clearManualReserveMuteForBackfillJob(jobId) is a NO-OP for a manual
 *      mute (operator override is preserved).
 *   4. Auto-mute does NOT overwrite an existing manual mute (returns
 *      applied:false; existing manual state preserved verbatim).
 *   5. A second, longer auto-mute for a different jobId takes ownership and
 *      extends mutedUntil; the prior owner's clear becomes a no-op.
 *   6. Duration is hard-capped to MAX_MUTE_DURATION_MS (7d).
 */

delete process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID;

async function main() {
  const mod = await import("../server/services/manualReserveAlerts");

  await mod.clearManualReserveMute();

  // 1. Fresh auto-mute on empty state.
  const r1 = await mod.setManualReserveMuteForBackfillJob({
    jobId: "job-A",
    jobLabel: "semrush_inventory_sync",
    durationMs: 60 * 60_000,
  });
  assert(r1.applied === true, "auto-mute should apply on empty state");
  assert(r1.state.muted === true, "state.muted=true after auto-mute");
  assert(r1.state.source === "auto", "source=auto");
  assert(r1.state.jobId === "job-A", "jobId persisted");
  assert(r1.state.jobLabel === "semrush_inventory_sync", "jobLabel persisted");
  assert(
    typeof r1.state.reason === "string" && r1.state.reason.includes("semrush_inventory_sync"),
    "reason mentions job label",
  );

  // 2. Owning job clears its own auto-mute.
  const c1 = await mod.clearManualReserveMuteForBackfillJob("job-A");
  assert(c1.cleared === true, "owning job should clear its own auto-mute");
  const post1 = await mod.getManualReserveMuteState();
  assert(post1.muted === false, "state cleared");
  assert(post1.source === null, "source cleared");

  // 3. Clear is a no-op against a manual mute (operator override preserved).
  const opMute = await mod.setManualReserveMute({
    mutedUntil: Date.now() + 30 * 60_000,
    mutedBy: null,
    reason: "operator manual override",
  });
  assert(opMute.source === "manual", "default source for setManualReserveMute is manual");
  const c2 = await mod.clearManualReserveMuteForBackfillJob("job-A");
  assert(c2.cleared === false, "must not clear manual mute");
  const post2 = await mod.getManualReserveMuteState();
  assert(post2.muted === true && post2.source === "manual", "manual mute preserved");

  // 4. Auto-mute does NOT overwrite a live manual mute.
  const r2 = await mod.setManualReserveMuteForBackfillJob({
    jobId: "job-B",
    jobLabel: "semrush_inventory_sync",
    durationMs: 60 * 60_000,
  });
  assert(r2.applied === false, "auto-mute deferred when manual mute is active");
  assert(r2.state.source === "manual", "still manual after deferred auto-mute");
  assert(r2.state.reason === "operator manual override", "manual reason preserved");

  // Reset to test ownership transfer.
  await mod.clearManualReserveMute();

  // 5a. Owner A installs auto-mute.
  const a1 = await mod.setManualReserveMuteForBackfillJob({
    jobId: "owner-A",
    jobLabel: "worker_alpha",
    durationMs: 30 * 60_000,
  });
  const untilA = a1.state.mutedUntil!;
  // 5b. Longer auto-mute from owner B takes ownership and extends mutedUntil.
  const a2 = await mod.setManualReserveMuteForBackfillJob({
    jobId: "owner-B",
    jobLabel: "worker_beta",
    durationMs: 2 * 60 * 60_000,
  });
  assert(a2.applied === true, "second auto-mute applies");
  assert(a2.state.jobId === "owner-B", "ownership transferred to owner-B");
  assert(a2.state.mutedUntil! >= untilA, "mutedUntil never shrinks on transfer");
  // 5c. Original owner's clear is now a no-op (jobId mismatch).
  const cA = await mod.clearManualReserveMuteForBackfillJob("owner-A");
  assert(cA.cleared === false, "non-owning clear must be no-op");
  const stillB = await mod.getManualReserveMuteState();
  assert(stillB.muted === true && stillB.jobId === "owner-B", "owner-B mute still active");
  // 5d. Owner B can clear its own.
  const cB = await mod.clearManualReserveMuteForBackfillJob("owner-B");
  assert(cB.cleared === true, "owner-B clears its own mute");

  // 6. Duration cap (7d).
  const huge = await mod.setManualReserveMuteForBackfillJob({
    jobId: "job-C",
    jobLabel: "huge_backfill",
    durationMs: 365 * 24 * 60 * 60_000, // 1y
  });
  assert(huge.applied === true, "cap-test mute applied");
  const cap = 7 * 24 * 60 * 60_000;
  const remaining = (huge.state.mutedUntil ?? 0) - Date.now();
  assert(remaining > 0 && remaining <= cap + 5_000, `remaining=${remaining} should be within 7d cap`);
  await mod.clearManualReserveMuteForBackfillJob("job-C");

  // 7. Validation: missing fields are rejected.
  let threw = false;
  try {
    await mod.setManualReserveMuteForBackfillJob({
      jobId: "",
      jobLabel: "x",
      durationMs: 1000,
    });
  } catch {
    threw = true;
  }
  assert(threw, "empty jobId should throw");

  threw = false;
  try {
    await mod.setManualReserveMuteForBackfillJob({
      jobId: "x",
      jobLabel: "x",
      durationMs: 0,
    });
  } catch {
    threw = true;
  }
  assert(threw, "zero durationMs should throw");

  console.log("manual-reserve-auto-mute: all cases passed");
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
