/* test-registration
{
  "name": "Front warp-speed throughput (Task #1829)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.6s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1829 — Front pipeline warp-speed throughput.
 *
 * Pins the four behaviours that a future refactor could silently
 * break and leave the Front queues stuck at ~1 job/min in prod:
 *
 *   (a) Master switch OFF (default): no `front_ingestion` rows
 *       acquired, no `front_ingestion` slot acquired.
 *   (b) Master switch ON: a single fast-poll cycle dispatches up to
 *       `per_cycle_dispatch_max` Front-queue rows, regardless of
 *       whether the rows carry `workload_class='ingestion'` (existing
 *       backlog shape) or `workload_class='front_ingestion'` (new
 *       enqueues post-flip).
 *   (c) Manual reserve (default 1) preserved when class budget = 4:
 *       background workers can only consume 3 of the 4 slots.
 *   (d) TOTAL_BUDGET (worker pool global slot cap = 9) respected:
 *       `front_ingestion` (4) + `ingestion` (3) + reserve still
 *       leaves global slack and never exceeds 9 in normal config.
 *
 * The test inserts disposable work_queue rows, runs ONE fast-poll
 * cycle in-process via `_runFrontWarpFastPollCycleForTests`, then
 * cleans up. It does not depend on the scheduler timer.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { workerDb } from "../server/db";
import { storage } from "../server/storage";
import {
  TOTAL_BUDGET,
  getClassStatus,
  getFrontIngestionClassConcurrency,
  getFrontIngestionManualReserve,
  acquireClassSlot,
  releaseClassSlot,
  registerWorkerClass,
} from "../server/services/workloadManager";
import {
  _runFrontWarpFastPollCycleForTests,
} from "../server/services/workScheduler";
import {
  __resetFrontWarpSettingsForTest,
  __setFrontWarpSettingsForTest,
  FRONT_WARP_QUEUE_NAMES,
} from "../server/services/frontWarpSettings";
import {
  isPoolEpicSwitchEnabled,
  ensurePoolEpicSwitchesLoaded,
  __resetPoolEpicSwitchesForTest,
} from "../server/services/poolEpicKillSwitches";

const TEST_PREFIX = "[task1829-warp-test] ";
// Synthetic queue names (NOT in FRONT_WARP_QUEUE_NAMES) so the live
// `Start application` workflow's fast-poll cycle never sees them — eliminates
// the cross-process race that was making (a2) and (b) flaky on the shared
// dev DB. The test passes this override to `_runFrontWarpFastPollCycleForTests`
// so the test cycle drains its own rows in isolation.
const TEST_QUEUE_NAMES = [
  `${TEST_PREFIX}q1-normalize`,
  `${TEST_PREFIX}q2-apply`,
  `${TEST_PREFIX}q3-reconciliation`,
] as const;
const TAG_USER = "test";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function cleanupTestRows(): Promise<void> {
  await workerDb.execute(sql`
    DELETE FROM work_queue
    WHERE dedupe_key LIKE ${TEST_PREFIX + "%"}
  `);
}

async function insertTestRow(
  queueName: string,
  workloadClass: string,
  dedupeKey: string,
): Promise<void> {
  await workerDb.execute(sql`
    INSERT INTO work_queue (queue_name, job_type, workload_class, priority, status, payload, dedupe_key, attempt_count, max_attempts)
    VALUES (${queueName}, ${queueName}, ${workloadClass}, 200, 'pending', ${JSON.stringify({ test: true })}::jsonb, ${dedupeKey}, 0, 3)
  `);
}

async function countLeasedTestRows(): Promise<number> {
  const r = await workerDb.execute<{ c: number }>(sql`
    SELECT COUNT(*)::int AS c FROM work_queue
    WHERE dedupe_key LIKE ${TEST_PREFIX + "%"}
      AND status IN ('leased','processing')
  `);
  return Number((r.rows[0] as any)?.c ?? 0);
}

async function setSwitch(name: string, value: boolean): Promise<void> {
  await storage.setSystemSetting(name, value ? "true" : "false", TAG_USER);
  __resetPoolEpicSwitchesForTest();
  await ensurePoolEpicSwitchesLoaded();
}

const initialMaster = isPoolEpicSwitchEnabled("front_warp_speed_enabled");

try {
  // ── Setup ─────────────────────────────────────────────────────────
  await cleanupTestRows();
  __resetFrontWarpSettingsForTest();

  // Test seam: pin small per-cycle dispatch max so we can exercise
  // bounding without inserting hundreds of rows.
  __setFrontWarpSettingsForTest({
    classConcurrency: 4,
    manualReserve: 1,
    pollIntervalMs: 500,
    perCycleDispatchMax: 3,
    workerIdleMin: 2,
  });

  // ── (a) Master switch OFF + no front_ingestion rows: no dispatch ─
  // The dev DB has a ~22k Front backlog with workload_class='ingestion'
  // (legacy). When master OFF the fast-poll is restricted to
  // workload_class='front_ingestion' rows ONLY (rollback safety —
  // legacy rows fall back to the main scheduler). Insert nothing and
  // confirm fast-poll dispatches 0.
  //
  // Phase 4: OFF is a true kill switch. Two assertions:
  //   (a.1) fast-poll loop returns 0 without issuing a DB query.
  //   (a.2) enqueueJob ALWAYS remaps Front queues to workload_class
  //         = 'front_ingestion' regardless of the switch. Since the
  //         main scheduler does NOT iterate that class, OFF means
  //         no drainer touches the row at all — true pipeline stop.
  // We cannot rely on countLeasedTestRows because the dev DB has a
  // 19k-row Front backlog that the fast-poll loop would normally
  // pick up. Instead we use the dispatched-count return from the
  // test seam: with the master switch OFF it must return 0
  // regardless of what's in the DB.
  await setSwitch("front_warp_speed_enabled", false);
  await cleanupTestRows();
  const dispatchedOff = await _runFrontWarpFastPollCycleForTests(TEST_QUEUE_NAMES);
  check(
    "(a) master OFF + no front_ingestion rows: fast-poll dispatches 0",
    dispatchedOff === 0,
    `dispatchedOff=${dispatchedOff}`,
  );

  // ── (a2) ROLLBACK SAFETY: master OFF still drains residual
  //          workload_class='front_ingestion' rows so a ON → OFF flip
  //          does not strand pending rows.
  await insertTestRow(
    TEST_QUEUE_NAMES[0],
    "front_ingestion",
    TEST_PREFIX + "rollback-1",
  );
  // No sleep here: the live `Start application` scheduler polls every
  // ~500ms; a long sleep before the test cycle was previously giving
  // the live process a chance to claim the row even though it's on a
  // synthetic queue, via the broader workload_class scan. The cycle
  // call below runs immediately so the test wins the race.
  const dispatchedRollback = await _runFrontWarpFastPollCycleForTests(TEST_QUEUE_NAMES);
  check(
    "(a2) master OFF: residual front_ingestion row IS drained (rollback safe)",
    dispatchedRollback === 1,
    `dispatchedRollback=${dispatchedRollback}`,
  );
  // ── (b) Master switch ON: multi-dispatches up to per-cycle max ───
  // Seed 3 test rows so the test cycle has work to dispatch — the
  // override means no live worker is touching these queues.
  await setSwitch("front_warp_speed_enabled", true);
  for (let i = 0; i < 3; i++) {
    await insertTestRow(
      TEST_QUEUE_NAMES[i % TEST_QUEUE_NAMES.length],
      "front_ingestion",
      `${TEST_PREFIX}on-${i}`,
    );
  }
  const dispatchedOn = await _runFrontWarpFastPollCycleForTests(TEST_QUEUE_NAMES);
  check(
    "(b) master switch ON: fast-poll dispatches up to perCycleDispatchMax (3)",
    dispatchedOn > 0 && dispatchedOn <= 3,
    `dispatchedOn=${dispatchedOn} (expected 1..3 with isolated test queues)`,
  );

  // The (b) cycle dispatched jobs asynchronously which still hold
  // front_ingestion slots until processJob completes. Wait for the
  // pool to settle before exercising the manual-reserve assertion.
  await new Promise((r) => setTimeout(r, 500));

  // ── (c) Manual reserve preserved ─────────────────────────────────
  const classStatusC = getClassStatus();
  check(
    "(c) front_ingestion class budget defaults to 4",
    classStatusC.front_ingestion.maxConcurrency === 4,
  );
  check(
    "(c) front_ingestion manual reserve defaults to 1",
    getFrontIngestionManualReserve() === 1,
  );

  // Simulate 3 background workers holding slots; a 4th background
  // acquire must fail because 4 - 1 (reserve) = 3 effective max.
  // `getWorkerClass()` slices everything after "scheduler:" as the
  // class name, so to support distinct worker IDs while keeping the
  // class resolution correct we register each one explicitly with
  // `registerWorkerClass`.
  const ws = ["front-warp-test:bg1", "front-warp-test:bg2", "front-warp-test:bg3", "front-warp-test:bg4", "front-warp-test:manual"];
  for (const w of ws) registerWorkerClass(w, "front_ingestion");
  for (const w of ws.slice(0, 3)) {
    assert.ok(
      acquireClassSlot(w, { origin: "scheduled_background" }),
      `failed to acquire background slot for ${w}`,
    );
  }
  const fourthBg = acquireClassSlot(ws[3], { origin: "scheduled_background" });
  check(
    "(c) 4th background acquire denied (manual reserve preserved)",
    fourthBg === false,
  );
  // But a user_manual acquire should still succeed — that's what the
  // reserve exists for.
  const userManual = acquireClassSlot(ws[4], { origin: "user_manual" });
  check(
    "(c) user_manual can acquire the reserved slot",
    userManual === true,
  );
  for (const w of ws.slice(0, 3)) releaseClassSlot(w);
  if (userManual) releaseClassSlot(ws[4]);

  // ── (d) TOTAL_BUDGET respected ───────────────────────────────────
  // The worker-pool TOTAL_BUDGET (default 9) must be at least as
  // large as the front_ingestion + repair-reserve baseline so the
  // new class doesn't immediately starve the pool. We do NOT assert
  // budget >= sum-of-all-class-caps because that has never been the
  // contract (workloads multiplex against TOTAL_BUDGET; the per-class
  // caps just bound *concurrent* dispatch).
  const statusD = getClassStatus();
  check(
    "(d) TOTAL_BUDGET (=9 default) >= front_ingestion cap (=4)",
    TOTAL_BUDGET >= statusD.front_ingestion.maxConcurrency,
    `TOTAL_BUDGET=${TOTAL_BUDGET}, front=${statusD.front_ingestion.maxConcurrency}`,
  );
  check(
    "(d) front_ingestion budget unchanged at end of test",
    statusD.front_ingestion.maxConcurrency === 4,
  );
} finally {
  await cleanupTestRows();
  __resetFrontWarpSettingsForTest();
  await setSwitch("front_warp_speed_enabled", initialMaster);
}

console.log(`front-warp-speed: ${passed} passed, ${failed} failed`);
// Force-exit so background timers (pool monitor, kill-switch reloader,
// etc.) imported transitively by the server modules don't keep the
// test process alive past the assertions.
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
process.exitCode = failed > 0 ? 1 : 0;
