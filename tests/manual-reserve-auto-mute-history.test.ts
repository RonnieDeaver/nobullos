/* test-registration
{
  "name": "Manual reserve auto-mute history (Task #1200)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1200: auto-mute install/release transitions are written to the
 * manual-reserve alert dispatch history so operators can distinguish a
 * backfill-induced quiet period from an operator-initiated mute.
 *
 * Verifies:
 *   1. setManualReserveMuteForBackfillJob writes an `auto_muted` row
 *      stamped with jobLabel (mutedBy) and jobId (detail).
 *   2. clearManualReserveMuteForBackfillJob writes an `auto_unmuted` row.
 *   3. Ownership-transfer (a longer auto-mute from a different jobId
 *      while another auto-mute is active) writes BOTH an `auto_unmuted`
 *      for the prior owner and an `auto_muted` for the new owner.
 *   4. Manual setManualReserveMute / clearManualReserveMute do NOT write
 *      auto_muted/auto_unmuted rows (they remain operator-driven and
 *      surface via the existing setting flow).
 *   5. Deferred auto-mute (when a manual override is active) does NOT
 *      write a transition row.
 */

delete process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID;

import {
  setManualReserveMute,
  clearManualReserveMute,
  setManualReserveMuteForBackfillJob,
  clearManualReserveMuteForBackfillJob,
  __resetManualReserveAlertDispatchesForTest,
  __pushManualReserveDispatchForTest,
  __test_setListManualReserveAlertDispatchesOverride,
  getRecentManualReserveAlertDispatches,
} from "../server/services/manualReserveAlerts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function readBuffer(): Promise<any[]> {
  // Force the DB-list helper to throw so getRecent...Dispatches falls back
  // to the in-memory ring buffer (which is populated synchronously by
  // persistDispatches before the async DB write).
  __test_setListManualReserveAlertDispatchesOverride(async () => {
    throw new Error("simulated DB unavailable");
  });
  try {
    return await getRecentManualReserveAlertDispatches(200);
  } finally {
    __test_setListManualReserveAlertDispatchesOverride(null);
  }
}

async function reset(): Promise<void> {
  __resetManualReserveAlertDispatchesForTest();
  await clearManualReserveMute();
}

async function testFreshAutoMuteAndRelease(): Promise<void> {
  await reset();

  const r1 = await setManualReserveMuteForBackfillJob({
    jobId: "job-A",
    jobLabel: "semrush_inventory_sync",
    durationMs: 60 * 60_000,
  });
  assert(r1.applied === true, "auto-mute should apply");

  let rows = await readBuffer();
  const installed = rows.find((r) => r.eventType === "auto_muted");
  assert(installed, "auto_muted row should be present after install");
  assert(
    installed.mutedBy === "semrush_inventory_sync",
    `auto_muted.mutedBy should carry jobLabel; got ${installed.mutedBy}`,
  );
  assert(
    typeof installed.detail === "string" && installed.detail.includes("jobId=job-A"),
    `auto_muted.detail should encode jobId; got ${installed.detail}`,
  );
  assert(
    installed.message === "Auto-muted by semrush_inventory_sync",
    `auto_muted.message wrong: ${installed.message}`,
  );
  assert(installed.status === "transition", "status should be transition");
  assert(installed.severity === "info", "severity should be info");
  assert(installed.metric === "auto_mute_installed", "metric should be auto_mute_installed");

  const c1 = await clearManualReserveMuteForBackfillJob("job-A");
  assert(c1.cleared === true, "owning job should clear");

  rows = await readBuffer();
  const released = rows.find((r) => r.eventType === "auto_unmuted");
  assert(released, "auto_unmuted row should be present after release");
  assert(
    released.mutedBy === "semrush_inventory_sync",
    `auto_unmuted.mutedBy should carry jobLabel; got ${released.mutedBy}`,
  );
  assert(
    typeof released.detail === "string" && released.detail.includes("jobId=job-A"),
    `auto_unmuted.detail should encode jobId; got ${released.detail}`,
  );
  assert(
    released.metric === "auto_mute_released",
    "metric should be auto_mute_released",
  );
}

async function testOwnershipTransferEmitsBothRows(): Promise<void> {
  await reset();

  const a1 = await setManualReserveMuteForBackfillJob({
    jobId: "owner-A",
    jobLabel: "worker_alpha",
    durationMs: 30 * 60_000,
  });
  assert(a1.applied === true, "owner-A install ok");

  // Take a snapshot count so we only inspect rows added by the transfer.
  const before = (await readBuffer()).length;

  const a2 = await setManualReserveMuteForBackfillJob({
    jobId: "owner-B",
    jobLabel: "worker_beta",
    durationMs: 2 * 60 * 60_000,
  });
  assert(a2.applied === true, "owner-B takes ownership");

  const rows = await readBuffer();
  const newRows = rows.slice(0, rows.length - before);
  // newRows is newest-first; expect at least one auto_unmuted (for owner-A)
  // and one auto_muted (for owner-B).
  const releasedA = newRows.find(
    (r) =>
      r.eventType === "auto_unmuted" &&
      typeof r.detail === "string" &&
      r.detail.includes("jobId=owner-A"),
  );
  const installedB = newRows.find(
    (r) =>
      r.eventType === "auto_muted" &&
      typeof r.detail === "string" &&
      r.detail.includes("jobId=owner-B"),
  );
  assert(releasedA, "ownership transfer should release prior owner-A");
  assert(installedB, "ownership transfer should install owner-B");
  assert(
    releasedA.mutedBy === "worker_alpha",
    `prior label preserved: ${releasedA.mutedBy}`,
  );
  assert(
    installedB.mutedBy === "worker_beta",
    `new label set: ${installedB.mutedBy}`,
  );

  await clearManualReserveMuteForBackfillJob("owner-B");
}

async function testManualMuteEmitsNoAutoTransition(): Promise<void> {
  await reset();

  await setManualReserveMute({
    mutedUntil: Date.now() + 5 * 60_000,
    mutedBy: null,
    reason: "operator override",
  });
  await clearManualReserveMute();

  const rows = await readBuffer();
  const autoRows = rows.filter(
    (r) => r.eventType === "auto_muted" || r.eventType === "auto_unmuted",
  );
  assert(
    autoRows.length === 0,
    `manual mute path must not write auto_* rows; got ${autoRows.length}`,
  );
}

async function testDeferredAutoMuteEmitsNoTransition(): Promise<void> {
  await reset();

  // Operator install a manual override.
  await setManualReserveMute({
    mutedUntil: Date.now() + 30 * 60_000,
    mutedBy: null,
    reason: "manual override",
  });
  __resetManualReserveAlertDispatchesForTest();

  const r = await setManualReserveMuteForBackfillJob({
    jobId: "job-deferred",
    jobLabel: "worker_deferred",
    durationMs: 60 * 60_000,
  });
  assert(r.applied === false, "auto-mute should be deferred under manual override");

  const rows = await readBuffer();
  const autoRows = rows.filter(
    (r) => r.eventType === "auto_muted" || r.eventType === "auto_unmuted",
  );
  assert(
    autoRows.length === 0,
    `deferred auto-mute must not write transition rows; got ${autoRows.length}`,
  );

  await clearManualReserveMute();
}

async function testNonOwningClearEmitsNoTransition(): Promise<void> {
  await reset();

  await setManualReserveMuteForBackfillJob({
    jobId: "owner-A",
    jobLabel: "worker_alpha",
    durationMs: 30 * 60_000,
  });
  __resetManualReserveAlertDispatchesForTest();

  const c = await clearManualReserveMuteForBackfillJob("not-the-owner");
  assert(c.cleared === false, "non-owning clear is no-op");

  const rows = await readBuffer();
  const autoRows = rows.filter(
    (r) => r.eventType === "auto_muted" || r.eventType === "auto_unmuted",
  );
  assert(
    autoRows.length === 0,
    `non-owning clear must not write transition rows; got ${autoRows.length}`,
  );

  await clearManualReserveMuteForBackfillJob("owner-A");
}

async function main(): Promise<void> {
  await testFreshAutoMuteAndRelease();
  await testOwnershipTransferEmitsBothRows();
  await testManualMuteEmitsNoAutoTransition();
  await testDeferredAutoMuteEmitsNoTransition();
  await testNonOwningClearEmitsNoTransition();
  console.log("manual-reserve auto-mute history: all cases passed");
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
