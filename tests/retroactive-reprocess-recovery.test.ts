/* test-registration
{
  "name": "Stuck retroactive_reprocess recovery (Task #836 P6)",
  "tier": "small"
}
test-registration */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../server/db";
import { workQueue } from "@shared/schema";
import { recoverStuckPendingJobs } from "../server/services/workScheduler";
import { PERF } from "../server/perfConfig";

async function run() {
  const now = Date.now();
  // `recoverStuckPendingJobs` selects the oldest 20 pending jobs
  // (`ORDER BY created_at ASC LIMIT 20`). On the shared dev DB there can
  // be ambient pending rows older than `STUCK_JOB_MAX_AGE_MS`; if 20+ of
  // them sort ahead of our fixture it would fall outside the window and
  // never get cleared (the contamination that made this suite flaky).
  // Backdate the fixture to an unambiguously ancient timestamp so it is
  // always the oldest pending row and therefore always inside the window.
  const olderThanMaxAge = new Date("2000-01-01T00:00:00.000Z");
  const farFutureRetry = new Date(now + 7 * 24 * 60 * 60 * 1000);
  const recentCreated = new Date(now - 60_000);

  const stuckRow = await db
    .insert(workQueue)
    .values({
      queueName: "retroactive_reprocess",
      jobType: "retroactive_reprocess",
      workloadClass: "repair",
      priority: 5,
      status: "pending",
      payload: { clientId: "test-stuck", maxItems: 1 },
      maxAttempts: 2,
      retryAt: farFutureRetry,
      // createdAt has defaultNow(); override below via raw update.
    } as any)
    .returning({ id: workQueue.id });
  const stuckId = stuckRow[0].id;

  const recentRow = await db
    .insert(workQueue)
    .values({
      queueName: "retroactive_reprocess",
      jobType: "retroactive_reprocess",
      workloadClass: "repair",
      priority: 5,
      status: "pending",
      payload: { clientId: "test-recent", maxItems: 1 },
      maxAttempts: 2,
      retryAt: farFutureRetry,
    } as any)
    .returning({ id: workQueue.id });
  const recentId = recentRow[0].id;

  // Backdate the stuck job past STUCK_JOB_MAX_AGE_MS, leave the recent
  // job at default (now). Both have retry_at far in the future, so only
  // the stuck one should be cleared.
  await db
    .update(workQueue)
    .set({ createdAt: olderThanMaxAge })
    .where(eq(workQueue.id, stuckId));
  await db
    .update(workQueue)
    .set({ createdAt: recentCreated })
    .where(eq(workQueue.id, recentId));

  try {
    await recoverStuckPendingJobs(now);

    const [stuckAfter] = await db
      .select({
        id: workQueue.id,
        retryAt: workQueue.retryAt,
        status: workQueue.status,
      })
      .from(workQueue)
      .where(eq(workQueue.id, stuckId));
    assert.ok(stuckAfter, "stuck row must still exist");
    assert.equal(
      stuckAfter.retryAt,
      null,
      "stuck job retry_at must be cleared to null",
    );
    assert.equal(
      stuckAfter.status,
      "pending",
      "stuck job status must remain pending (recovery only clears retry_at)",
    );

    const [recentAfter] = await db
      .select({
        id: workQueue.id,
        retryAt: workQueue.retryAt,
      })
      .from(workQueue)
      .where(eq(workQueue.id, recentId));
    assert.ok(recentAfter, "recent row must still exist");
    assert.ok(
      recentAfter.retryAt !== null,
      "recent job retry_at must NOT be cleared (under stuck threshold)",
    );

    // Calling recovery again immediately should be a no-op for the
    // same job (escalation cooldown), proving the throttle works and
    // we don't spam the log every cycle.
    await recoverStuckPendingJobs(now);
    const [stuckAgain] = await db
      .select({ retryAt: workQueue.retryAt })
      .from(workQueue)
      .where(eq(workQueue.id, stuckId));
    assert.equal(
      stuckAgain.retryAt,
      null,
      "second recovery pass must remain a no-op (idempotent)",
    );
  } finally {
    await db.delete(workQueue).where(eq(workQueue.id, stuckId));
    await db.delete(workQueue).where(eq(workQueue.id, recentId));
  }

  console.log("retroactive-reprocess-recovery.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(() => {}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
