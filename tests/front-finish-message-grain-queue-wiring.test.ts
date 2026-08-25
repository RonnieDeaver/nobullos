/* test-registration
{
  "name": "Front auto-finish message-grain queue wiring (Task #2559)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2559 — End-to-end coverage for the Front auto-finish message-grain
 * WORK-QUEUE WIRING that the Task #2529 driver unit test
 * (`front-finish-message-grain-driver.test.ts`) does NOT exercise.
 *
 * The unit test pins the tick GATING logic directly via the apply override
 * seam, but it stops short of the plumbing that actually gets a tick to run
 * in production:
 *
 *  A. The dedupe-keyed scheduled enqueue
 *     (`__frontFinishMessageGrainTestHelpers.enqueueScheduledTick`):
 *       1. a no-op while the master switch `front_finish_message_grain_enabled`
 *          is OFF (a default-OFF deploy must never pile up no-op jobs),
 *       2. a no-op while the queue is paused via `queue_drain_state`,
 *       3. exactly ONE dedupe-keyed `front_finish_message_grain` job per time
 *          bucket when enabled — a second enqueue in the same bucket collapses
 *          via `wq_dedupe_key_idx`. The enqueued row carries the expected
 *          workload class / priority / payload.
 *
 *  B. The registered handler path: `registerAllHandlers()` wires
 *     `front_finish_message_grain` → `handleFrontFinishMessageGrain`, and
 *     driving a job through that registered handler actually RUNS the tick
 *     (apply invoked once via the deterministic test seam, last-run summary
 *     persisted). Mirrors the sibling
 *     `front-message-grain-upgrade-trigger-route.test.ts` style where
 *     practical.
 *
 * A regression in any of those wiring points (handler registration removed,
 * the disabled / paused due-checks dropped, the dedupe key changed) would
 * pass the existing unit test but be caught here.
 *
 * The real apply path issues live Front HTTP traffic, so the deterministic
 * apply stand-in (the driver's test seam) is used throughout. Every mutated
 * system_setting / breaker / queue-pause is snapshotted and restored so the
 * shared dev DB is left exactly as we found it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

import { workerDb } from "../server/db";
import type { WorkQueueJob } from "@shared/schema";
import {
  setSystemSetting,
  getSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import {
  setQueuePause,
  _resetQueueDrainStateForTests,
} from "../server/services/queueDrainControl";
import { __resetFrontAuthBreakerForTest } from "../server/services/frontAuthBreaker";
import { PERF } from "../server/perfConfig";
import { registerAllHandlers } from "../server/services/workQueueHandlers";
import { getRegisteredHandler } from "../server/services/workScheduler";
import {
  QUEUE_NAME,
  SETTING_ENABLED,
  SETTING_LAST_RUN,
  TICK_INTERVAL_MS,
  readLastFinishMessageGrainRun,
  __frontFinishMessageGrainTestHelpers as H,
} from "../server/services/frontFinishMessageGrainDriver";

async function clearJobs(): Promise<void> {
  await workerDb.execute(
    sql`DELETE FROM work_queue WHERE queue_name = ${QUEUE_NAME}`,
  );
}

/** Count live (claimable / in-flight) rows for the queue — completed/failed
 * rows fall outside the dedupe predicate, so we restrict to the same set the
 * dedupe index guards. */
async function countLiveJobs(): Promise<number> {
  const rows = await workerDb.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM work_queue
    WHERE queue_name = ${QUEUE_NAME}
      AND status NOT IN ('completed', 'failed', 'dead_letter', 'cancelled')
  `);
  return Number(rows.rows[0]?.n ?? 0) || 0;
}

async function selectJobsForBucket(
  bucket: number,
): Promise<Array<Record<string, any>>> {
  const dedupeKey = `${QUEUE_NAME}:scheduled:${bucket}`;
  const rows = await workerDb.execute(sql`
    SELECT id, queue_name, workload_class, priority, payload, dedupe_key, status
    FROM work_queue
    WHERE dedupe_key = ${dedupeKey}
  `);
  return (rows as any).rows ?? (rows as unknown as any[]);
}

test("Task #2559 finish-message-grain queue wiring (enqueue + handler)", async (t) => {
  H.setApplyOverride(null);
  __resetFrontAuthBreakerForTest();
  _resetQueueDrainStateForTests();

  // Snapshot + restore every setting / global this test mutates.
  const saved: Record<string, string | undefined> = {};
  for (const k of [SETTING_ENABLED, SETTING_LAST_RUN]) {
    saved[k] = (await getSystemSetting(k).catch(() => null))?.value;
  }
  const savedKillSwitch = (
    PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean }
  ).KILL_SWITCH_NON_CRITICAL_SWEEPS;

  await clearJobs();

  t.after(async () => {
    H.setApplyOverride(null);
    __resetFrontAuthBreakerForTest();
    await setQueuePause(QUEUE_NAME, false, "system").catch(() => {});
    _resetQueueDrainStateForTests();
    (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
      .KILL_SWITCH_NON_CRITICAL_SWEEPS = savedKillSwitch;
    await clearJobs();
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) await deleteSystemSetting(k);
      else await setSystemSetting(k, v, "system");
    }
  });

  // ── A1. Disabled (default) → enqueue is a no-op. ─────────────────────
  await t.test("disabled → no job enqueued", async () => {
    await setSystemSetting(SETTING_ENABLED, "false", "system");
    await setQueuePause(QUEUE_NAME, false, "system");
    _resetQueueDrainStateForTests();
    await clearJobs();

    await H.enqueueScheduledTick();
    assert.equal(
      await countLiveJobs(),
      0,
      "a default-OFF driver must not enqueue scheduled jobs",
    );
  });

  // ── A2. Enabled but queue paused → enqueue is a no-op. ───────────────
  await t.test("paused → no job enqueued", async () => {
    await setSystemSetting(SETTING_ENABLED, "true", "system");
    await clearJobs();
    await setQueuePause(QUEUE_NAME, true, "system");

    await H.enqueueScheduledTick();
    assert.equal(
      await countLiveJobs(),
      0,
      "a paused queue must not enqueue scheduled jobs",
    );

    await setQueuePause(QUEUE_NAME, false, "system");
    _resetQueueDrainStateForTests();
  });

  // ── A3. Enabled + unpaused → exactly one dedupe-keyed job per bucket. ─
  await t.test("enabled → exactly one dedupe-keyed job per bucket", async () => {
    await setSystemSetting(SETTING_ENABLED, "true", "system");
    await setQueuePause(QUEUE_NAME, false, "system");
    _resetQueueDrainStateForTests();
    await clearJobs();

    const bucket = Math.floor(Date.now() / TICK_INTERVAL_MS);

    // Two enqueues in the same time bucket must collapse to one row.
    await H.enqueueScheduledTick();
    await H.enqueueScheduledTick();

    const rows = await selectJobsForBucket(bucket);
    assert.equal(
      rows.length,
      1,
      "two enqueues in one bucket must dedupe to a single job",
    );

    const job = rows[0];
    assert.equal(job.queue_name, QUEUE_NAME, "job is on the finish queue");
    assert.equal(
      job.workload_class,
      "maintenance",
      "scheduled tick runs in the maintenance workload class",
    );
    assert.equal(Number(job.priority), 200, "scheduled tick priority");
    assert.equal(
      job.dedupe_key,
      `${QUEUE_NAME}:scheduled:${bucket}`,
      "dedupe key is bucketed per time window",
    );
    assert.equal(
      job.payload?.trigger,
      "scheduled",
      "payload marks the trigger as scheduled",
    );
    assert.equal(
      Number(job.payload?.bucket),
      bucket,
      "payload carries the time bucket",
    );

    await clearJobs();
  });

  // ── B. Registered handler runs the tick end-to-end. ──────────────────
  await t.test("registered handler drives the tick", async () => {
    registerAllHandlers();
    const handler = getRegisteredHandler(QUEUE_NAME);
    assert.ok(
      handler,
      `handleFrontFinishMessageGrain must be registered for ${QUEUE_NAME}`,
    );

    await setSystemSetting(SETTING_ENABLED, "true", "system");
    await setQueuePause(QUEUE_NAME, false, "system");
    _resetQueueDrainStateForTests();
    __resetFrontAuthBreakerForTest();
    (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean })
      .KILL_SWITCH_NON_CRITICAL_SWEEPS = false;

    let calls = 0;
    H.setApplyOverride(async (actorId) => {
      calls += 1;
      assert.equal(actorId, null, "handler runs the tick as the system actor");
      return { state: "applied" as const, detail: "wired", rowsAffected: 3 };
    });

    const job = {
      id: "task-2559-job",
      queueName: QUEUE_NAME,
      workloadClass: "maintenance",
      priority: 200,
      payload: { trigger: "scheduled", bucket: 0 },
      maxAttempts: 2,
    } as unknown as WorkQueueJob;

    // Must not throw — the handler is non-throwing by contract.
    await handler!(job);

    assert.equal(calls, 1, "the registered handler invokes the tick exactly once");

    const last = await readLastFinishMessageGrainRun();
    assert.equal(last.status, "ok", "handler tick persisted a last-run summary");
    assert.ok(
      last.lastRun &&
        last.lastRun.applied === true &&
        last.lastRun.outcomeState === "applied" &&
        last.lastRun.rowsAffected === 3,
      "last-run summary reflects the handler-driven tick outcome",
    );

    H.setApplyOverride(null);
  });
});
