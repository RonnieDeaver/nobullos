/* test-registration
{
  "name": "Work-queue db-pool-saturation defer/re-enqueue (Task #2578)",
  "tier": "small"
}
test-registration */
/**
 * Task #2578: regression test for the shared db-pool-saturation defer/
 * re-enqueue branch used by every worker-queue handler.
 *
 * Many handlers wrap their work in `try { ... } catch (err) { if (await
 * deferIfDbPoolSaturated(job, err, queueName)) return; throw err; }`. When
 * the pg pool is saturated, the helper must re-enqueue exactly one bounded,
 * dedupe-keyed deferred copy (60s + jitter backoff, preserving payload +
 * workloadClass) and return true; for any non-saturation error — or a job
 * whose `workloadClass` is outside the canonical set — it must return false
 * so the caller rethrows and the attempt counts.
 *
 * This logic is shared and load-bearing across the whole worker pool, so a
 * regression (wrong classifier, lost payload, missing dedupe key) would
 * silently change retry behavior under DB pressure. The Task #2559 wiring
 * test could not reach it because `runFinishMessageGrainTick` is non-
 * throwing by contract, so the handler's catch never fires.
 *
 * Hermetic conventions mirror tests/work-queue-scheduler.test.ts: real
 * worker DB, marker-prefixed identifiers so concurrent runs can't collide,
 * and cleanup in finally.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import type { WorkQueueJob } from "@shared/schema";
import { deferIfDbPoolSaturated } from "../server/services/workQueueHandlers";

const MARKER = `t2578_${process.pid}_${Date.now()}`;
// The helper forces the enqueued copy onto one of the canonical queue-name
// literals, so the deferred row's `queue_name` is NOT marker-prefixed. We
// therefore key cleanup off the dedupe key, which embeds `job.id` (which we
// DO marker-prefix). semrush_background_refresh runs under `ingestion` and
// is not a Front warp queue, so enqueueJob won't remap its workload class.
const QUEUE = "semrush_background_refresh" as const;

async function cleanup(): Promise<void> {
  await workerDb.execute(
    sql`DELETE FROM work_queue WHERE dedupe_key LIKE ${"db_pool_partial:%:" + MARKER + "_%"}`,
  );
}

function makeJob(id: string, overrides: Partial<WorkQueueJob> = {}): WorkQueueJob {
  return {
    id,
    queueName: `${MARKER}_src`,
    jobType: `${MARKER}_src`,
    workloadClass: "ingestion",
    priority: 42,
    status: "processing",
    payload: { marker: MARKER, foo: "bar", n: 7 },
    payloadJson: null,
    dedupeKey: null,
    cursor: null,
    cursorJson: null,
    attemptCount: 1,
    maxAttempts: 5,
    retryAt: null,
    leasedAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...overrides,
  } as WorkQueueJob;
}

async function deferredRowsForJob(jobId: string): Promise<
  Array<{
    queue_name: string;
    workload_class: string;
    status: string;
    priority: number;
    max_attempts: number;
    payload: Record<string, unknown> | null;
    dedupe_key: string;
    retry_at: string | null;
  }>
> {
  const r = await workerDb.execute<{
    queue_name: string;
    workload_class: string;
    status: string;
    priority: number;
    max_attempts: number;
    payload: Record<string, unknown> | null;
    dedupe_key: string;
    retry_at: string | null;
  }>(sql`
    SELECT queue_name, workload_class, status, priority, max_attempts,
           payload, dedupe_key, retry_at
    FROM work_queue
    WHERE dedupe_key LIKE ${"db_pool_partial:%:" + jobId + ":%"}
  `);
  return r.rows;
}

async function run(): Promise<void> {
  await cleanup();
  try {
    // ── 1. pg-pool saturation → exactly one deferred, dedupe-keyed copy ──
    const satJobId = `${MARKER}_sat`;
    const satJob = makeJob(satJobId);
    const before = Date.now();
    const satErr = new Error(
      "timeout exceeded when trying to connect", // matches isDbPoolSaturationError
    );
    const deferred = await deferIfDbPoolSaturated(satJob, satErr, QUEUE);
    assert.equal(deferred, true, "saturation error must be deferred (return true)");

    const rows = await deferredRowsForJob(satJobId);
    assert.equal(rows.length, 1, "exactly one deferred copy must be enqueued");
    const row = rows[0]!;
    assert.equal(row.queue_name, QUEUE, "deferred copy keeps the same queue");
    assert.equal(
      row.workload_class,
      "ingestion",
      "deferred copy preserves workloadClass",
    );
    assert.equal(row.status, "pending", "deferred copy is pending");
    assert.equal(row.priority, 42, "deferred copy preserves priority");
    assert.equal(row.max_attempts, 5, "deferred copy preserves maxAttempts");
    assert.deepEqual(
      row.payload,
      { marker: MARKER, foo: "bar", n: 7 },
      "deferred copy preserves the original payload verbatim",
    );
    assert.ok(
      row.dedupe_key.startsWith(`db_pool_partial:${QUEUE}:${satJobId}:`),
      `dedupe key must be (job, minute)-scoped, got ${row.dedupe_key}`,
    );
    assert.ok(row.retry_at, "deferred copy must carry a retryAt");
    const retryAtMs = new Date(row.retry_at as string).getTime();
    // Bounded backoff: 60s base + up to 30s jitter.
    assert.ok(
      retryAtMs >= before + 60_000,
      "retryAt must be at least 60s in the future",
    );
    assert.ok(
      retryAtMs <= before + 90_000 + 5_000,
      "retryAt must stay within the bounded 60s+jitter window",
    );

    // ── 2. non-saturation error → return false (caller rethrows) ────────
    const plainJobId = `${MARKER}_plain`;
    const plainJob = makeJob(plainJobId);
    const plainErr = new Error("some unrelated application error");
    const notDeferred = await deferIfDbPoolSaturated(plainJob, plainErr, QUEUE);
    assert.equal(
      notDeferred,
      false,
      "non-saturation error must NOT be deferred (return false)",
    );
    assert.equal(
      (await deferredRowsForJob(plainJobId)).length,
      0,
      "non-saturation error must not enqueue any deferred copy",
    );

    // ── 3. workloadClass outside the canonical set → return false ───────
    const badJobId = `${MARKER}_badclass`;
    const badJob = makeJob(badJobId, {
      workloadClass: "not_a_real_class" as WorkQueueJob["workloadClass"],
    });
    const badDeferred = await deferIfDbPoolSaturated(badJob, satErr, QUEUE);
    assert.equal(
      badDeferred,
      false,
      "a job with an unknown workloadClass must not be deferred (return false)",
    );
    assert.equal(
      (await deferredRowsForJob(badJobId)).length,
      0,
      "an unknown-workloadClass job must not push a malformed deferred copy",
    );

    console.log("work-queue-db-pool-defer.test.ts: OK");
  } finally {
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit().
run()
  .then(() => {})
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {}
    process.exitCode = 1;
  });
