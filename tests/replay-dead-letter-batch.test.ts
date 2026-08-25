/* test-registration
{
  "name": "Replay dead-letter batch (Task #1834)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1834 regression — `replayDeadLetteredJobsBatch` must drain a
 * dead-letter queue in bounded batches when the backlog exceeds
 * `MAX_BULK_REPLAY`. This pins the contract that motivated the new
 * helper: the original `bulkReplayDeadLetteredJobs` throws when
 * `matchCount > cap`, which makes it unusable for the prod-actions
 * panel button (Task #1834) that must drain a 17k-row backlog
 * one press at a time.
 *
 * Asserts:
 *   1. With backlog > cap, one apply replays exactly `cap` rows and
 *      leaves the rest in dead_letter.
 *   2. A second apply continues draining the next batch — proving
 *      idempotency at the row level (already-replayed rows are not
 *      re-touched because they no longer match `status='dead_letter'`).
 *   3. Replayed rows are reset to `pending` with `attempt_count=0`,
 *      lease fields cleared, and `error_*` nulled — so the scheduler
 *      can pick them up on the next tick.
 *   4. Other queues' dead-letter rows are NOT touched (per-queue
 *      filter holds).
 */
import assert from "node:assert/strict";
import { sql, eq, and } from "drizzle-orm";
import { workerDb } from "../server/db";
import { workQueue } from "@shared/schema";
import { replayDeadLetteredJobsBatch, MAX_BULK_REPLAY } from "../server/services/workScheduler";

const MARKER = `t1834_${process.pid}_${Date.now()}`;
const Q_TARGET = `${MARKER}_target`;
const Q_OTHER = `${MARKER}_other`;
const CAP = 50;
const BACKLOG = CAP * 2 + 7; // 107 rows, clearly > cap so multiple presses needed

async function cleanup(): Promise<void> {
  await workerDb.execute(
    sql`DELETE FROM work_queue WHERE queue_name LIKE ${MARKER + "_%"}`,
  );
}

async function seedDeadLetter(queueName: string, count: number): Promise<void> {
  const rows = Array.from({ length: count }).map((_, i) => ({
    queueName,
    jobType: queueName,
    workloadClass: "ingestion" as const,
    priority: 100,
    status: "dead_letter" as const,
    payload: { i },
    maxAttempts: 3,
    attemptCount: 3,
    errorMessage: "pre-existing failure",
    errorCode: "test_seed",
    leaseOwner: "expired-owner",
    leasedAt: new Date(Date.now() - 60_000),
    leaseExpiresAt: new Date(Date.now() - 30_000),
    heartbeatAt: new Date(Date.now() - 60_000),
    completedAt: new Date(Date.now() - 30_000),
    retryAt: new Date(Date.now() - 30_000),
  }));
  // Batch insert in chunks of 50 to keep statements small.
  for (let i = 0; i < rows.length; i += 50) {
    await workerDb.insert(workQueue).values(rows.slice(i, i + 50));
  }
}

async function countByStatus(queueName: string, status: string): Promise<number> {
  const [row] = await workerDb
    .select({ count: sql<number>`count(*)::int` })
    .from(workQueue)
    .where(and(eq(workQueue.queueName, queueName), eq(workQueue.status, status)));
  return row?.count ?? 0;
}

async function run(): Promise<void> {
  await cleanup();
  try {
    await seedDeadLetter(Q_TARGET, BACKLOG);
    await seedDeadLetter(Q_OTHER, 25);

    assert.equal(await countByStatus(Q_TARGET, "dead_letter"), BACKLOG, "seed: target dead_letter count");
    assert.equal(await countByStatus(Q_OTHER, "dead_letter"), 25, "seed: other dead_letter count");

    // Press 1: replay exactly CAP rows.
    const press1 = await replayDeadLetteredJobsBatch({
      queueName: Q_TARGET,
      cap: CAP,
      operatorId: "test",
      operatorUsername: "test",
    });
    assert.equal(press1.replayedCount, CAP, "press 1 replays exactly cap");
    assert.equal(press1.cap, CAP, "press 1 reports cap");
    assert.equal(press1.remainingCount, BACKLOG - CAP, "press 1 reports remaining");
    assert.equal(press1.replayedIds.length, CAP, "press 1 returns replayed ids");
    assert.equal(await countByStatus(Q_TARGET, "dead_letter"), BACKLOG - CAP, "target dead_letter shrinks by cap");
    assert.equal(await countByStatus(Q_TARGET, "pending"), CAP, "target pending grows by cap");

    // Verify column reset on a replayed row.
    const [sample] = await workerDb
      .select()
      .from(workQueue)
      .where(eq(workQueue.id, press1.replayedIds[0]));
    assert.equal(sample.status, "pending", "replayed row is pending");
    assert.equal(sample.attemptCount, 0, "attempt_count reset");
    assert.equal(sample.errorMessage, null, "error_message cleared");
    assert.equal(sample.errorCode, null, "error_code cleared");
    assert.equal(sample.completedAt, null, "completed_at cleared");
    assert.equal(sample.leasedAt, null, "leased_at cleared");
    assert.equal(sample.leaseOwner, null, "lease_owner cleared");
    assert.equal(sample.leaseExpiresAt, null, "lease_expires_at cleared");
    assert.equal(sample.heartbeatAt, null, "heartbeat_at cleared");
    assert.equal(sample.retryAt, null, "retry_at cleared");

    // Press 2: continues draining (proves idempotency — first batch's
    // pending rows are not re-touched).
    const press2 = await replayDeadLetteredJobsBatch({
      queueName: Q_TARGET,
      cap: CAP,
      operatorId: "test",
      operatorUsername: "test",
    });
    assert.equal(press2.replayedCount, CAP, "press 2 replays the next cap rows");
    assert.equal(press2.remainingCount, BACKLOG - 2 * CAP, "press 2 reports remaining");
    assert.equal(await countByStatus(Q_TARGET, "dead_letter"), BACKLOG - 2 * CAP, "target dead_letter shrunk again");
    assert.equal(await countByStatus(Q_TARGET, "pending"), 2 * CAP, "target pending grew again");

    // Press 3: drains the last partial batch (< cap).
    const press3 = await replayDeadLetteredJobsBatch({
      queueName: Q_TARGET,
      cap: CAP,
      operatorId: "test",
      operatorUsername: "test",
    });
    assert.equal(press3.replayedCount, BACKLOG - 2 * CAP, "press 3 replays the partial tail");
    assert.equal(press3.remainingCount, 0, "press 3 leaves zero remaining");
    assert.equal(await countByStatus(Q_TARGET, "dead_letter"), 0, "target fully drained");
    assert.equal(await countByStatus(Q_TARGET, "pending"), BACKLOG, "all target rows now pending");

    // Press 4 on an empty queue is a no-op.
    const press4 = await replayDeadLetteredJobsBatch({
      queueName: Q_TARGET,
      cap: CAP,
      operatorId: "test",
      operatorUsername: "test",
    });
    assert.equal(press4.replayedCount, 0, "press 4 on empty queue replays 0");
    assert.equal(press4.remainingCount, 0, "press 4 reports zero remaining");

    // Other queue MUST be untouched throughout.
    assert.equal(await countByStatus(Q_OTHER, "dead_letter"), 25, "other queue dead_letter untouched");
    assert.equal(await countByStatus(Q_OTHER, "pending"), 0, "other queue pending unchanged");

    // Cap clamp: requested cap > MAX_BULK_REPLAY is clamped.
    const clampProbe = await replayDeadLetteredJobsBatch({
      queueName: Q_OTHER,
      cap: MAX_BULK_REPLAY * 10,
      operatorId: "test",
      operatorUsername: "test",
    });
    assert.equal(clampProbe.cap, MAX_BULK_REPLAY, "cap is clamped to MAX_BULK_REPLAY");
    assert.equal(clampProbe.replayedCount, 25, "other queue drained in one press (25 < cap)");

    // Missing queueName is rejected.
    await assert.rejects(
      () => replayDeadLetteredJobsBatch({ queueName: "" } as any),
      /requires a queueName/,
      "empty queueName is rejected",
    );

    console.log("PASS — replayDeadLetteredJobsBatch drains backlog in bounded batches.");
  } finally {
    await cleanup();
  }
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once run() settles — no manual process.exit() (Task #2084).
run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
