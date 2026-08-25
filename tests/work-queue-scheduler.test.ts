/* test-registration
{
  "name": "Work-queue scheduler stability (Tasks #978/#986/#987/#988)",
  "tier": "medium"
}
test-registration */
/**
 * Task #988: regression tests for the work-queue scheduler stability
 * surface — covers the bug fixed in #978 (handler registration race),
 * #986 (per-queue fairness within a workload class), #987 (operator
 * drain control: pause/resume + per-minute rate cap + bulk cancel),
 * and the producer-side missing-handler enqueue alert.
 *
 * The tests run against the real worker DB (the project's existing
 * test runner pattern), prefix all queue names with a per-process
 * marker so concurrent tests can't collide, and clean up at the end.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { workQueue } from "@shared/schema";
import { eq } from "drizzle-orm";

import {
  registerHandler,
  isHandlerRegistered,
  getRegisteredHandlerNames,
  assertRequiredHandlersRegistered,
  enqueueJob,
} from "../server/services/workScheduler";
import {
  listEligibleQueueNamesForClass,
  dequeueFromQueue,
} from "../server/services/workQueueLease";
import {
  setQueuePause,
  setQueueRateLimit,
  isQueuePaused,
  canDispatchQueueNow,
  recordQueueDispatch,
  cancelPendingJobs,
  getDrainStateSnapshot,
  ensureQueueDrainStateLoaded,
  _resetQueueDrainStateForTests,
} from "../server/services/queueDrainControl";

const MARKER = `t988_${process.pid}_${Date.now()}`;
const Q_FAIR_A = `${MARKER}_fair_a`;
const Q_FAIR_B = `${MARKER}_fair_b`;
const Q_DRAIN = `${MARKER}_drain`;
const Q_RATE = `${MARKER}_rate`;
const Q_CANCEL = `${MARKER}_cancel`;
const Q_MISSING = `${MARKER}_missing`;
const Q_REQUIRED = `${MARKER}_required_present`;

async function cleanup(): Promise<void> {
  await workerDb.execute(sql`DELETE FROM work_queue WHERE queue_name LIKE ${MARKER + "_%"}`);
}

async function pendingCount(queueName: string): Promise<number> {
  const r = await workerDb
    .select({ id: workQueue.id })
    .from(workQueue)
    .where(eq(workQueue.queueName, queueName));
  return r.length;
}

async function run(): Promise<void> {
  await cleanup();
  _resetQueueDrainStateForTests();
  await ensureQueueDrainStateLoaded();

  // ── #978 startup assertion ────────────────────────────────────────
  // 1. Register the "present" handler; the assertion must pass for it
  //    and fail for the missing one.
  registerHandler(Q_REQUIRED, async () => {});
  assert.equal(isHandlerRegistered(Q_REQUIRED), true);
  const namesBefore = getRegisteredHandlerNames();
  assert.ok(namesBefore.includes(Q_REQUIRED), "handler list must include registered queue");

  const okPath = assertRequiredHandlersRegistered([Q_REQUIRED]);
  assert.equal(okPath.ok, true);
  assert.equal(okPath.missing.length, 0);

  const failPath = assertRequiredHandlersRegistered([Q_REQUIRED, Q_MISSING]);
  assert.equal(failPath.ok, false);
  assert.deepEqual(failPath.missing, [Q_MISSING]);
  assert.ok(failPath.registered.includes(Q_REQUIRED));

  // ── enqueueJob dedupe collapses duplicate keys ─────────────────────
  const dedupeKey = `${MARKER}_dedupe_key`;
  const id1 = await enqueueJob({
    queueName: Q_REQUIRED,
    workloadClass: "ingestion",
    payload: { n: 1 },
    dedupeKey,
  });
  const id2 = await enqueueJob({
    queueName: Q_REQUIRED,
    workloadClass: "ingestion",
    payload: { n: 2 },
    dedupeKey,
  });
  assert.equal(id1, id2, "dedupe key must collapse to the same job id");
  const dedupedRows = await workerDb
    .select({ id: workQueue.id })
    .from(workQueue)
    .where(eq(workQueue.dedupeKey, dedupeKey));
  assert.equal(dedupedRows.length, 1, "dedupe key must produce exactly one row");

  // ── #986 per-queue fairness ───────────────────────────────────────
  // Insert 5 jobs into A and 1 into B, all in workload class
  // "ingestion". Old behavior: B never wins because A always has
  // older rows. New behavior: listEligibleQueueNamesForClass returns
  // both, and the scheduler can dispatch to B independently.
  for (let i = 0; i < 5; i++) {
    await enqueueJob({
      queueName: Q_FAIR_A,
      workloadClass: "ingestion",
      payload: { i },
      dedupeKey: `${MARKER}_a_${i}`,
    });
  }
  await enqueueJob({
    queueName: Q_FAIR_B,
    workloadClass: "ingestion",
    payload: { only: true },
    dedupeKey: `${MARKER}_b_only`,
  });

  const eligible = await listEligibleQueueNamesForClass("ingestion");
  assert.ok(eligible.includes(Q_FAIR_A), "A must be eligible");
  assert.ok(eligible.includes(Q_FAIR_B), "B must be eligible");

  // Scoped dequeue: pick from B explicitly. This is exactly what the
  // scheduler's round-robin path does after sorting by oldest dispatch.
  const jobB = await dequeueFromQueue(
    "ingestion",
    `test-owner-${MARKER}`,
    60_000,
    { queueName: Q_FAIR_B },
  );
  assert.ok(jobB, "scoped dequeue from B must return B's job");
  assert.equal(jobB!.queueName, Q_FAIR_B);

  // Exclude path: dequeue ingestion but exclude A → must never return
  // an A job. The live scheduler in this same process may be enqueueing
  // real ingestion rows (e.g. `front_webhook_normalize`) concurrently,
  // so we can't assert null — only that nothing from THIS test's marker
  // namespace leaked through (those are the rows this assertion guards).
  // If a non-marker prod row is leased, immediately release its lease
  // back to the pool so we don't hold a 60s lease on real prod work.
  const jobNotA = await dequeueFromQueue(
    "ingestion",
    `test-owner-${MARKER}`,
    60_000,
    { excludeQueueNames: [Q_FAIR_A, Q_REQUIRED, Q_DRAIN, Q_RATE, Q_CANCEL, Q_MISSING] },
  );
  if (jobNotA) {
    assert.ok(
      !jobNotA.queueName.startsWith(MARKER),
      `marker-scoped job leaked through exclude path: ${jobNotA.queueName}`,
    );
    // Release the leased prod row immediately so the real scheduler can
    // pick it up again instead of waiting 60s for our lease to expire.
    await workerDb.execute(
      sql`UPDATE work_queue SET status='pending', lease_owner=NULL, lease_expires_at=NULL, leased_at=NULL WHERE id=${jobNotA.id}`,
    );
  }

  // Scoped dequeue from A returns an A job specifically.
  const jobA = await dequeueFromQueue(
    "ingestion",
    `test-owner-${MARKER}`,
    60_000,
    { queueName: Q_FAIR_A },
  );
  assert.ok(jobA, "scoped dequeue from A must return an A job");
  assert.equal(jobA!.queueName, Q_FAIR_A);

  // ── #987 pause / resume ──────────────────────────────────────────
  await enqueueJob({
    queueName: Q_DRAIN,
    workloadClass: "ingestion",
    payload: {},
    dedupeKey: `${MARKER}_drain_1`,
  });

  assert.equal(isQueuePaused(Q_DRAIN), false, "queue starts unpaused");
  await setQueuePause(Q_DRAIN, true, "test-actor");
  assert.equal(isQueuePaused(Q_DRAIN), true, "pause must take effect");
  await setQueuePause(Q_DRAIN, false, "test-actor");
  assert.equal(isQueuePaused(Q_DRAIN), false, "resume must lift pause");

  // ── #987 rate-limit accounting ───────────────────────────────────
  await setQueueRateLimit(Q_RATE, 3, "test-actor");
  assert.equal(canDispatchQueueNow(Q_RATE), true, "1st dispatch allowed");
  recordQueueDispatch(Q_RATE);
  recordQueueDispatch(Q_RATE);
  assert.equal(canDispatchQueueNow(Q_RATE), true, "3rd dispatch still allowed (under cap)");
  recordQueueDispatch(Q_RATE);
  assert.equal(
    canDispatchQueueNow(Q_RATE),
    false,
    "4th dispatch must be denied — cap is 3/min",
  );
  // Lifting the cap clears the rolling window.
  await setQueueRateLimit(Q_RATE, null, "test-actor");
  assert.equal(canDispatchQueueNow(Q_RATE), true, "lifting cap re-enables dispatch");

  // ── #987 bulk cancel ─────────────────────────────────────────────
  for (let i = 0; i < 4; i++) {
    await enqueueJob({
      queueName: Q_CANCEL,
      workloadClass: "ingestion",
      payload: { i },
      dedupeKey: `${MARKER}_cancel_${i}`,
    });
  }
  assert.equal(await pendingCount(Q_CANCEL), 4);
  const cancelResult = await cancelPendingJobs(Q_CANCEL, 10, "test-actor");
  assert.equal(cancelResult.cancelled, 4, "all 4 pending must be cancelled");
  // None should remain in 'pending' state.
  const remainingPending = await workerDb.execute<{ cnt: number }>(sql`
    SELECT COUNT(*)::int AS cnt FROM work_queue
    WHERE queue_name = ${Q_CANCEL} AND status = 'pending'
  `);
  assert.equal(Number(remainingPending.rows[0]!.cnt), 0);

  // ── snapshot endpoint shape ──────────────────────────────────────
  const snapshot = await getDrainStateSnapshot();
  const drainEntry = snapshot.find((s) => s.queueName === Q_DRAIN);
  assert.ok(drainEntry, "snapshot must include the drain queue");
  assert.equal(typeof drainEntry!.paused, "boolean");
  assert.equal(typeof drainEntry!.pendingJobs, "number");
  assert.equal(typeof drainEntry!.recentDispatches, "number");

  await cleanup();
  _resetQueueDrainStateForTests();
  console.log("work-queue-scheduler.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(() => {}).catch(async (err) => {
  console.error(err);
  try { await cleanup(); } catch {}
  process.exitCode = 1;
});
