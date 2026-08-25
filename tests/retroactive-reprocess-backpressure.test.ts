/* test-registration
{
  "name": "Retroactive reprocess backpressure (Task #1025)",
  "tier": "medium"
}
test-registration */
/**
 * Task #1025 regression: verifies the retroactive_reprocess
 * backpressure surface.
 *
 *   1. Periodic dedupe key is version-agnostic — re-enqueueing for
 *      the same client with a different `producerVersion` payload
 *      MUST collapse to a single pending row, not two.
 *   2. The per-client pending ceiling
 *      (RETROACTIVE_REPROCESS_PENDING_PER_CLIENT_MAX) refuses extra
 *      enqueues from the safe helper once the ceiling is reached.
 *   3. The collapse SQL keeps the oldest pending row per client and
 *      cancels the rest with the audit reason
 *      `collapsed_duplicate_periodic_enqueue_task_1025`.
 */
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../server/db";
import { workQueue } from "@shared/schema";
import { PERF } from "../server/perfConfig";
import {
  enqueueRetroactiveReprocessSafe,
  getPendingCountForClient,
  getPendingCountsByClient,
  periodicDedupeKey,
  RETROACTIVE_REPROCESS_QUEUE,
} from "../server/services/retroactiveReprocessControl";
import { enqueueRepairJob } from "../server/services/repairDispatcher";

const TEST_CLIENT_PREFIX = "task1025-test-";

async function cleanupTestRows(): Promise<void> {
  await db.execute(sql`
    DELETE FROM work_queue
    WHERE queue_name = ${RETROACTIVE_REPROCESS_QUEUE}
      AND payload->>'clientId' LIKE ${TEST_CLIENT_PREFIX + "%"}
  `);
}

async function testPeriodicDedupeIsVersionAgnostic(): Promise<void> {
  const clientId = TEST_CLIENT_PREFIX + "dedupe";
  const dedupeKey = periodicDedupeKey(clientId);

  // First enqueue — producerVersion 1.
  await enqueueRepairJob({
    queueName: RETROACTIVE_REPROCESS_QUEUE,
    workloadClass: "repair",
    payload: { clientId, producerVersion: 1 },
    dedupeKey,
  });

  // Second enqueue with producerVersion 2 but the SAME stable
  // dedupe key. With the Task #1025 fix the dedupe key dropped its
  // version segment, so this MUST be a dedupe hit (no second row).
  await enqueueRepairJob({
    queueName: RETROACTIVE_REPROCESS_QUEUE,
    workloadClass: "repair",
    payload: { clientId, producerVersion: 2 },
    dedupeKey,
  });

  const pending = await getPendingCountForClient(clientId);
  assert.equal(
    pending,
    1,
    `version-agnostic dedupe must collapse second enqueue (got ${pending} pending rows)`,
  );
}

async function testPerClientCeilingRefusesExtras(): Promise<void> {
  const clientId = TEST_CLIENT_PREFIX + "ceiling";
  const ceiling = PERF.RETROACTIVE_REPROCESS_PENDING_PER_CLIENT_MAX;

  // Pre-fill ceiling rows with distinct dedupe keys so they all
  // count toward the per-client pending count.
  for (let i = 0; i < ceiling; i++) {
    await enqueueRepairJob({
      queueName: RETROACTIVE_REPROCESS_QUEUE,
      workloadClass: "interactive_repair",
      payload: { clientId, fillerIndex: i },
      dedupeKey: `task1025-test-fill:${clientId}:${i}`,
    });
  }
  const beforeExtra = await getPendingCountForClient(clientId);
  assert.equal(beforeExtra, ceiling, `expected ${ceiling} pre-filled rows`);

  // The safe helper MUST refuse the next enqueue.
  const blocked = await enqueueRetroactiveReprocessSafe({
    clientId,
    source: "manual_route",
    workloadClass: "interactive_repair",
  });
  assert.equal(blocked.enqueued, false, "safe helper must refuse past ceiling");
  assert.equal(blocked.reason, "per_client_ceiling");
  assert.equal(blocked.pendingCount, ceiling);

  const afterExtra = await getPendingCountForClient(clientId);
  assert.equal(
    afterExtra,
    ceiling,
    "no new row should have been inserted by the refused enqueue",
  );
}

async function testCollapseSqlKeepsOldestPerClient(): Promise<void> {
  const clientId = TEST_CLIENT_PREFIX + "collapse";

  // Insert 3 pending rows for the same client with monotonically
  // increasing createdAt so the "oldest" is unambiguous.
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const created = new Date(Date.now() - (10 - i) * 60_000);
    const row = await db
      .insert(workQueue)
      .values({
        queueName: RETROACTIVE_REPROCESS_QUEUE,
        jobType: RETROACTIVE_REPROCESS_QUEUE,
        workloadClass: "repair",
        priority: 100,
        status: "pending",
        payload: { clientId, idx: i },
        maxAttempts: 2,
      } as any)
      .returning({ id: workQueue.id });
    const id = row[0].id;
    await db.update(workQueue).set({ createdAt: created }).where(eq(workQueue.id, id));
    ids.push(id);
  }
  // ids[0] is the oldest (created 10 minutes ago).

  // Run the same collapse statement as the one-shot script.
  await db.execute(sql`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY payload->>'clientId'
               ORDER BY created_at ASC, id ASC
             ) AS rn
      FROM work_queue
      WHERE queue_name = ${RETROACTIVE_REPROCESS_QUEUE}
        AND status = 'pending'
        AND payload->>'clientId' = ${clientId}
    )
    UPDATE work_queue wq
    SET status = 'cancelled',
        error_message = 'collapsed_duplicate_periodic_enqueue_task_1025',
        completed_at = NOW()
    FROM ranked r
    WHERE wq.id = r.id AND r.rn > 1
  `);

  const rows = await db
    .select({ id: workQueue.id, status: workQueue.status, errorMessage: workQueue.errorMessage })
    .from(workQueue)
    .where(
      and(
        eq(workQueue.queueName, RETROACTIVE_REPROCESS_QUEUE),
        sql`${workQueue.payload}->>'clientId' = ${clientId}`,
      ),
    );

  const oldest = rows.find((r) => r.id === ids[0])!;
  const newer = rows.filter((r) => r.id !== ids[0]);

  assert.equal(oldest.status, "pending", "oldest row must remain pending");
  for (const r of newer) {
    assert.equal(r.status, "cancelled", `row ${r.id} must be cancelled`);
    assert.equal(
      r.errorMessage,
      "collapsed_duplicate_periodic_enqueue_task_1025",
      `row ${r.id} must record the audit reason`,
    );
  }

  const remaining = await getPendingCountForClient(clientId);
  assert.equal(remaining, 1, "exactly one pending row must remain after collapse");
}

async function testCeilingIsPerClientNotGlobal(): Promise<void> {
  // Two distinct clients must each be allowed to fill their own
  // ceiling independently — proving the per-client ceiling does
  // not act as a global throttle that would block one client when
  // another is already saturated.
  const ceiling = PERF.RETROACTIVE_REPROCESS_PENDING_PER_CLIENT_MAX;
  const a = TEST_CLIENT_PREFIX + "parallel-a";
  const b = TEST_CLIENT_PREFIX + "parallel-b";

  // Saturate client A.
  for (let i = 0; i < ceiling; i++) {
    await enqueueRepairJob({
      queueName: RETROACTIVE_REPROCESS_QUEUE,
      workloadClass: "repair",
      payload: { clientId: a, idx: i },
      dedupeKey: `task1025-test-parallel-a:${i}`,
    });
  }
  const aBlocked = await enqueueRetroactiveReprocessSafe({
    clientId: a,
    source: "manual_route",
    workloadClass: "repair",
  });
  assert.equal(aBlocked.enqueued, false, "client A should be at ceiling");
  assert.equal(aBlocked.reason, "per_client_ceiling");

  // Client B must still be accepted despite A being saturated.
  const bAccepted = await enqueueRetroactiveReprocessSafe({
    clientId: b,
    source: "manual_route",
    workloadClass: "repair",
  });
  assert.equal(
    bAccepted.enqueued,
    true,
    "client B must not be blocked when client A is at ceiling",
  );

  const aCount = await getPendingCountForClient(a);
  const bCount = await getPendingCountForClient(b);
  assert.equal(aCount, ceiling, "client A pending count unchanged");
  assert.equal(bCount, 1, "client B got its own pending row");
}

async function testPendingCountsByClientAggregates(): Promise<void> {
  const a = TEST_CLIENT_PREFIX + "agg-a";
  const b = TEST_CLIENT_PREFIX + "agg-b";
  await enqueueRepairJob({
    queueName: RETROACTIVE_REPROCESS_QUEUE,
    workloadClass: "repair",
    payload: { clientId: a },
    dedupeKey: `task1025-test-agg:${a}`,
  });
  await enqueueRepairJob({
    queueName: RETROACTIVE_REPROCESS_QUEUE,
    workloadClass: "repair",
    payload: { clientId: b },
    dedupeKey: `task1025-test-agg:${b}:1`,
  });
  await enqueueRepairJob({
    queueName: RETROACTIVE_REPROCESS_QUEUE,
    workloadClass: "repair",
    payload: { clientId: b },
    dedupeKey: `task1025-test-agg:${b}:2`,
  });

  const rows = await getPendingCountsByClient();
  const ra = rows.find((r) => r.clientId === a);
  const rb = rows.find((r) => r.clientId === b);
  assert.ok(ra, "client a must appear in counts");
  assert.equal(ra!.pendingCount, 1);
  assert.ok(rb, "client b must appear in counts");
  assert.equal(rb!.pendingCount, 2);
}

async function run(): Promise<void> {
  await cleanupTestRows();
  try {
    await testPeriodicDedupeIsVersionAgnostic();
    await testPerClientCeilingRefusesExtras();
    await testCeilingIsPerClientNotGlobal();
    await testCollapseSqlKeepsOldestPerClient();
    await testPendingCountsByClientAggregates();
  } finally {
    await cleanupTestRows();
  }
  console.log("retroactive-reprocess-backpressure.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
