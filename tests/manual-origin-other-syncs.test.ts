/* test-registration
{
  "name": "Manual origin other syncs (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Verifies that the workload manager honors INGESTION_MANUAL_RESERVE for the
 * other user-triggered ingestion entry points besides local_dominance_sync:
 * zoom_sync (manual Zoom ingest / discover) and semrush_inventory_sync
 * (manual Semrush inventory refresh).
 *
 * Failure modes this test guards against:
 *   - A future change dropping the `origin: "user_manual"` annotation from
 *     these admin-triggered routes, allowing background ingestion backlog to
 *     starve them.
 *   - The new `semrush_inventory_sync` worker class registration being
 *     accidentally reverted to `maintenance` (which has no reserve).
 */

import {
  acquireClassSlot,
  releaseClassSlot,
  awaitClassSlot,
  getClassStatus,
  getWorkerClass,
} from "../server/services/workloadManager";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function runManualNotStarvedCase(manualWorker: string, label: string) {
  // Saturate the non-reserved ingestion budget with background acquires.
  // The ingestion class cap is live-tunable (Task #1816,
  // `workload_class_ingestion_max_concurrency`), so acquire until the
  // reserve rejects a background caller rather than assuming a fixed cap.
  let bgHeld = 0;
  const maxAttempts = 64;
  while (bgHeld < maxAttempts && acquireClassSlot("front_sync")) {
    bgHeld++;
  }
  assert(bgHeld >= 1, `${label}: bg front_sync should acquire non-reserved slot(s)`);
  assert(bgHeld < maxAttempts, `${label}: bg saturation loop must terminate`);

  // Another background acquire (any ingestion worker) must be rejected by
  // the reserve now that the non-reserved budget is saturated.
  const bgOver = acquireClassSlot("zoom_sync");
  assert(!bgOver, `${label}: extra bg ingestion must be rejected by reserve`);

  // The manual worker should still get the reserved slot promptly.
  const t0 = Date.now();
  await awaitClassSlot(manualWorker, { origin: "user_manual" });
  const waited = Date.now() - t0;
  assert(
    waited < 1000,
    `${label}: manual ${manualWorker} await should be fast under bg saturation (waited ${waited}ms)`,
  );

  releaseClassSlot(manualWorker);
  for (let i = 0; i < bgHeld; i++) {
    releaseClassSlot("front_sync");
  }
  assert(
    getClassStatus().ingestion.activeCount === 0,
    `${label}: ingestion.activeCount should drain to 0 after releases`,
  );
}

async function main() {
  // Sanity: semrush_inventory_sync must be registered as ingestion so the
  // reserve applies; if a future refactor demotes it back to maintenance,
  // the manual route would lose its starvation protection.
  assert(
    getWorkerClass("semrush_inventory_sync") === "ingestion",
    `semrush_inventory_sync must be classified as ingestion (got ${getWorkerClass("semrush_inventory_sync")})`,
  );
  assert(
    getWorkerClass("zoom_sync") === "ingestion",
    `zoom_sync must be classified as ingestion (got ${getWorkerClass("zoom_sync")})`,
  );

  await runManualNotStarvedCase("zoom_sync", "zoom manual ingest");
  await runManualNotStarvedCase("semrush_inventory_sync", "semrush manual inventory");

  // Bonus: a second manual zoom_sync acquire while the reserved slot is in
  // use AND background holds the other slot must be rejected. Manual is
  // protected from starvation but is NOT a class-cap bypass.
  let bgHeld = 0;
  while (bgHeld < 64 && acquireClassSlot("front_sync")) {
    bgHeld++;
  }
  assert(bgHeld >= 1, "bg front_sync should acquire");
  const m1 = acquireClassSlot("zoom_sync", { origin: "user_manual" });
  assert(m1, "first manual zoom_sync should fit into reserved slot");
  const m2 = acquireClassSlot("zoom_sync", { origin: "user_manual" });
  assert(!m2, "second manual zoom_sync must NOT exceed class cap");
  releaseClassSlot("zoom_sync");
  for (let i = 0; i < bgHeld; i++) {
    releaseClassSlot("front_sync");
  }

  console.log("manual-origin-other-syncs: all cases passed");
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
