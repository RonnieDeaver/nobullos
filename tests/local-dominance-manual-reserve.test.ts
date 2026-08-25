/* test-registration
{
  "name": "Local dominance manual reserve",
  "tier": "medium"
}
test-registration */
/**
 * Verifies that the workload manager honors INGESTION_MANUAL_RESERVE so that
 * background ingestion jobs (semrush_report_refresh, front_sync, zoom_sync,
 * background local_dominance_sync) cannot consume the slot capacity reserved
 * for user-triggered manual ingestion.
 *
 * Failure modes this test guards against:
 *   - Reserve being silently dropped at the workload-manager admission layer.
 *   - Manual sync starvation when background ingestion is at saturation.
 *   - A future change accidentally introducing a "manual always proceeds"
 *     bypass that ignores total class capacity.
 */

import {
  acquireClassSlot,
  releaseClassSlot,
  awaitClassSlot,
  getClassStatus,
  getWorkloadOriginMetrics,
} from "../server/services/workloadManager";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function main() {
  // Sanity: ingestion class budget must be 3 (Task #1787 Stage 4 bumped
  // ingestion 2 → 3 so the Front recovery ingest path can ramp concurrency
  // 1 → 2 → 3 while still leaving headroom). Reserve math still works
  // because INGESTION_MANUAL_RESERVE scales relative to maxConcurrency.
  const status = getClassStatus();
  assert(
    status.ingestion.maxConcurrency === 3,
    `expected ingestion.maxConcurrency=3, got ${status.ingestion.maxConcurrency}`,
  );

  // Case 1: a single background ingestion job acquires fine.
  const bg1 = acquireClassSlot("front_sync");
  assert(bg1, "first background ingestion acquire should succeed");
  assert(
    getClassStatus().ingestion.activeCount === 1,
    "ingestion.activeCount should be 1 after first bg acquire",
  );

  // Case 2: a SECOND background ingestion job acquires fine — with cap=3
  // and reserve=1 the non-reserved budget for background is 2.
  const bg2 = acquireClassSlot("zoom_sync");
  assert(bg2, "second background ingestion acquire should succeed (bg cap = max - reserve = 2)");

  // Case 2b: a THIRD background ingestion job must NOT be able to take the
  // reserved slot — background is capped at maxConcurrency - reserve = 2.
  const bg3 = acquireClassSlot("zoom_sync");
  assert(
    !bg3,
    "third background ingestion acquire must be rejected (reserve must protect manual capacity)",
  );

  // Case 3: a manual user-triggered local_dominance_sync MUST still acquire
  // even with background at the non-reserved budget.
  const manual = acquireClassSlot("local_dominance_sync", { origin: "user_manual" });
  assert(
    manual,
    "manual user-triggered ingestion must acquire reserved slot under background load",
  );

  // Case 4: total ingestion is now at full cap (2 bg + 1 manual = 3). A
  // further manual acquire must be rejected — reserve protects manual but
  // does not bypass the class cap.
  const manualOver = acquireClassSlot("local_dominance_sync", { origin: "user_manual" });
  assert(
    !manualOver,
    "manual must not exceed class maxConcurrency (no broad 'manual bypass')",
  );

  // And background obviously still cannot fit either.
  const bgOver = acquireClassSlot("zoom_sync");
  assert(!bgOver, "background still rejected when class is at full cap");

  releaseClassSlot("local_dominance_sync");
  releaseClassSlot("zoom_sync");
  releaseClassSlot("front_sync");

  assert(
    getClassStatus().ingestion.activeCount === 0,
    "ingestion.activeCount should drain to 0 after releases",
  );

  // Case 5: awaitClassSlot for manual returns quickly under saturated bg load
  // and increments the reserve metrics + manualAcquires counter.
  const beforeMetrics = getWorkloadOriginMetrics();
  const bgHold = acquireClassSlot("front_sync");
  assert(bgHold, "bg should be able to grab non-reserved slot again");
  // Saturate the full non-reserved bg budget so manual is forced through
  // the reserved slot — that's the only path that bumps the "delayed by
  // background" counter. With cap=3 and reserve=1, bg needs 2 holds.
  const bgHold2 = acquireClassSlot("zoom_sync");
  assert(bgHold2, "bg should be able to grab the second non-reserved slot");

  const t0 = Date.now();
  await awaitClassSlot("local_dominance_sync", { origin: "user_manual" });
  const waited = Date.now() - t0;
  // Should be near-instant (under 250ms) because the reserved slot is free.
  assert(waited < 1000, `manual await should be fast under bg saturation (waited ${waited}ms)`);

  const afterMetrics = getWorkloadOriginMetrics();
  assert(
    afterMetrics.manualAcquires === beforeMetrics.manualAcquires + 1,
    "manualAcquires counter must increment on manual acquisition",
  );
  assert(
    afterMetrics.manualDelayedByBackgroundCount ===
      beforeMetrics.manualDelayedByBackgroundCount + 1,
    "manualDelayedByBackgroundCount must increment when bg occupied non-reserved slot",
  );

  releaseClassSlot("local_dominance_sync");
  releaseClassSlot("zoom_sync");
  releaseClassSlot("front_sync");

  // Case 6: with no background pressure, manual still works and is NOT counted
  // as "delayed by background".
  const beforeClean = getWorkloadOriginMetrics();
  await awaitClassSlot("local_dominance_sync", { origin: "user_manual" });
  const afterClean = getWorkloadOriginMetrics();
  assert(
    afterClean.manualAcquires === beforeClean.manualAcquires + 1,
    "manualAcquires should still increment under clean load",
  );
  assert(
    afterClean.manualDelayedByBackgroundCount === beforeClean.manualDelayedByBackgroundCount,
    "manualDelayedByBackgroundCount must NOT increment when no bg pressure existed",
  );
  releaseClassSlot("local_dominance_sync");

  console.log("local-dominance-manual-reserve: all cases passed");
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
