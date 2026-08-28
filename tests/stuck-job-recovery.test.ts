/* test-registration
{
  "name": "Stuck-job recovery: max-processing window + heartbeat ceiling (Task #1056)",
  "tier": "small"
}
test-registration */
/**
 * Task #1056: regression coverage for the per-queue max-processing
 * "stuck job" protections introduced in Task #1048.
 *
 * Two complementary safety nets are exercised here:
 *
 *  1. `recoverStaleLeases` (server/services/workQueueLease.ts) reclaims
 *     a `processing` row whose `leased_at + max_processing_ms` has
 *     elapsed, even when `lease_expires_at` is still in the future
 *     (the "stuck-but-still-heartbeating" case). When attempts are
 *     exhausted the row is marked `failed` with
 *     `error_code = "max_processing_exhaustion"`; otherwise it is
 *     reset to `pending` with `attempt_count` incremented.
 *
 *  2. `startHeartbeat` (server/services/workScheduler.ts) — exercised
 *     through `_performHeartbeatTickForTests` — stops extending the
 *     lease, writes `lease_expires_at = now()`, and removes itself
 *     from the active-heartbeat map once the queue's ceiling is
 *     exceeded.
 *
 *  3. Operator overrides in `system_settings.work_queue_max_processing_ms`
 *     are honored by `getMaxProcessingMs()` and end-to-end by
 *     `recoverStaleLeases` (a job that exceeded the override is
 *     reclaimed even when the default ceiling would have left it alone).
 *
 * These code paths protect the system against the 2h+ stuck
 * `semrush_report_refresh` and 7m+ `retroactive_reprocess` jobs that
 * motivated #1048 — a regression here would silently re-introduce
 * stuck jobs, so the tests pin the observable contract.
 */
import assert from "node:assert/strict";
import { sql, eq } from "drizzle-orm";
import { workerDb } from "../server/db";
import { workQueue } from "@shared/schema";
import { recoverStaleLeases } from "../server/services/workQueueLease";
import {
  QUEUE_MAX_PROCESSING_KEY,
  getMaxProcessingMs,
  invalidateQueueMaxProcessingCache,
  DEFAULT_QUEUE_MAX_PROCESSING_MS,
} from "../server/services/queueMaxProcessing";
import {
  _performHeartbeatTickForTests,
  _seedActiveHeartbeatForTests,
  _clearActiveHeartbeatForTests,
  _hasActiveHeartbeatForTests,
} from "../server/services/workScheduler";
import { storage } from "../server/storage";

const MARKER = `t1056_${process.pid}_${Date.now()}`;
const Q_RECOVER = `${MARKER}_recover`;
const Q_EXHAUST = `${MARKER}_exhaust`;
const Q_HEARTBEAT = `${MARKER}_heartbeat`;
const Q_OVERRIDE = `${MARKER}_override`;
// Task #1085: queues for the expired-lease branch (the original
// pre-#1048 safety net — lease_expires_at < now()).
const Q_EXPIRED_RECOVER = `${MARKER}_expired_recover`;
const Q_EXPIRED_EXHAUST = `${MARKER}_expired_exhaust`;

async function cleanupRows(): Promise<void> {
  await workerDb.execute(
    sql`DELETE FROM work_queue WHERE queue_name LIKE ${MARKER + "_%"}`,
  );
}

/**
 * Insert a row in the `processing` state with a backdated `leased_at`.
 * `lease_expires_at` is intentionally set to far in the future so the
 * recoverStaleLeases path under test can ONLY fire via the
 * `leased_at + max_processing_ms < now()` branch — proving the new
 * #1048 protection (not the pre-existing expired-lease sweep) is what
 * reclaimed the row.
 */
async function insertProcessingJob(opts: {
  queueName: string;
  leasedAtMs: number;
  maxAttempts?: number;
  attemptCount?: number;
  leaseExpiresAtMs?: number;
}): Promise<string> {
  const leasedAt = new Date(opts.leasedAtMs);
  const [row] = await workerDb
    .insert(workQueue)
    .values({
      queueName: opts.queueName,
      jobType: opts.queueName,
      workloadClass: "ingestion",
      priority: 100,
      status: "processing",
      payload: {},
      maxAttempts: opts.maxAttempts ?? 3,
      leaseOwner: "test-owner",
    })
    .returning({ id: workQueue.id });
  await workerDb
    .update(workQueue)
    .set({
      leasedAt,
      // Default: far future so only the max-processing branch can match.
      // Callers (e.g. the Task #1085 expired-lease tests) can override
      // to backdate `lease_expires_at` past now while keeping `leased_at`
      // recent — that isolates the expired-lease branch instead.
      leaseExpiresAt: new Date(
        opts.leaseExpiresAtMs ?? opts.leasedAtMs + 24 * 60 * 60 * 1000,
      ),
      heartbeatAt: leasedAt,
      attemptCount: opts.attemptCount ?? 0,
    })
    .where(eq(workQueue.id, row.id));
  return row.id;
}

async function readJob(id: string) {
  const [row] = await workerDb
    .select()
    .from(workQueue)
    .where(eq(workQueue.id, id));
  return row;
}

async function testRecoverPastMaxProcessing(): Promise<void> {
  const defaultMs = DEFAULT_QUEUE_MAX_PROCESSING_MS.default;
  const past = Date.now() - defaultMs - 60_000;

  const recoverableId = await insertProcessingJob({
    queueName: Q_RECOVER,
    leasedAtMs: past,
    maxAttempts: 3,
    attemptCount: 0,
  });
  const exhaustedId = await insertProcessingJob({
    queueName: Q_EXHAUST,
    leasedAtMs: past,
    maxAttempts: 3,
    attemptCount: 2,
  });

  // High limit so our specific rows are guaranteed to be in the same
  // sweep as any other live `ingestion` rows that might happen to be
  // overdue at the moment — keeps the test deterministic against the
  // shared dev DB.
  await recoverStaleLeases({
    source: "scheduler",
    workloadClasses: ["ingestion"],
    limit: 10_000,
  });

  const recoverable = await readJob(recoverableId);
  assert.equal(
    recoverable.status,
    "pending",
    "recoverable job must be reset to pending",
  );
  assert.equal(
    recoverable.attemptCount,
    1,
    "recoverable job attempt_count must be incremented",
  );
  assert.equal(
    recoverable.leaseOwner,
    null,
    "recoverable job lease_owner must be cleared",
  );
  assert.equal(
    recoverable.leasedAt,
    null,
    "recoverable job leased_at must be cleared",
  );
  assert.equal(
    recoverable.leaseExpiresAt,
    null,
    "recoverable job lease_expires_at must be cleared",
  );

  const exhausted = await readJob(exhaustedId);
  assert.equal(
    exhausted.status,
    "failed",
    "exhausted job must be marked failed",
  );
  assert.equal(
    exhausted.attemptCount,
    3,
    "exhausted job attempt_count must reach max",
  );
  assert.equal(
    exhausted.errorCode,
    "max_processing_exhaustion",
    "exhausted job error_code must indicate max_processing_exhaustion (not stale_lease_exhaustion)",
  );
  assert.equal(
    exhausted.errorMessage,
    "max_processing_exhaustion",
    "exhausted job error_message must mirror the error_code",
  );
}

/**
 * Task #1085: regression coverage for the original pre-#1048
 * expired-lease branch of `recoverStaleLeases`. We backdate
 * `lease_expires_at` past now while keeping `leased_at` recent
 * (so `leased_at + max_processing_ms` is well in the future) — that
 * way only the `lease_expires_at < now` predicate of `stalePredicate`
 * can fire, and the `error_code` CASE expression must resolve to
 * `stale_lease_exhaustion` (NOT `max_processing_exhaustion`).
 */
async function testRecoverExpiredLease(): Promise<void> {
  const nowMs = Date.now();
  // Recent — well within the per-queue max-processing ceiling, so the
  // overrun branch cannot match.
  const recentLeasedAt = nowMs - 5_000;
  // Past — so the expired-lease branch IS the only thing that matches.
  const pastLeaseExpiresAt = nowMs - 60_000;

  const recoverableId = await insertProcessingJob({
    queueName: Q_EXPIRED_RECOVER,
    leasedAtMs: recentLeasedAt,
    leaseExpiresAtMs: pastLeaseExpiresAt,
    maxAttempts: 3,
    attemptCount: 0,
  });
  const exhaustedId = await insertProcessingJob({
    queueName: Q_EXPIRED_EXHAUST,
    leasedAtMs: recentLeasedAt,
    leaseExpiresAtMs: pastLeaseExpiresAt,
    maxAttempts: 3,
    attemptCount: 2,
  });

  await recoverStaleLeases({
    source: "scheduler",
    workloadClasses: ["ingestion"],
    limit: 10_000,
  });

  const recoverable = await readJob(recoverableId);
  assert.equal(
    recoverable.status,
    "pending",
    "expired-lease recoverable job must be reset to pending",
  );
  assert.equal(
    recoverable.attemptCount,
    1,
    "expired-lease recoverable job attempt_count must be incremented",
  );
  assert.equal(
    recoverable.leaseOwner,
    null,
    "expired-lease recoverable job lease_owner must be cleared",
  );
  assert.equal(
    recoverable.leasedAt,
    null,
    "expired-lease recoverable job leased_at must be cleared",
  );
  assert.equal(
    recoverable.leaseExpiresAt,
    null,
    "expired-lease recoverable job lease_expires_at must be cleared",
  );

  const exhausted = await readJob(exhaustedId);
  assert.equal(
    exhausted.status,
    "failed",
    "expired-lease exhausted job must be marked failed",
  );
  assert.equal(
    exhausted.attemptCount,
    3,
    "expired-lease exhausted job attempt_count must reach max",
  );
  assert.equal(
    exhausted.errorCode,
    "stale_lease_exhaustion",
    "expired-lease exhausted job error_code must be stale_lease_exhaustion (not max_processing_exhaustion)",
  );
  assert.equal(
    exhausted.errorMessage,
    "stale_lease_exhaustion",
    "expired-lease exhausted job error_message must mirror the error_code",
  );
}

async function testHeartbeatStopsExtendingPastCeiling(): Promise<void> {
  const defaultMs = DEFAULT_QUEUE_MAX_PROCESSING_MS.default;
  const past = Date.now() - defaultMs - 60_000;
  const jobId = await insertProcessingJob({
    queueName: Q_HEARTBEAT,
    leasedAtMs: past,
  });

  const key = `${jobId}:${past}`;
  _seedActiveHeartbeatForTests(key);
  let aborted = false;
  try {
    const result = await _performHeartbeatTickForTests(
      jobId,
      Q_HEARTBEAT,
      past,
      key,
    );
    aborted = result.aborted;
    assert.equal(
      result.aborted,
      true,
      "tick must abort when elapsedMs >= maxProcessingMs",
    );
    assert.equal(
      result.reason,
      "max_processing_exceeded",
      "abort reason must be max_processing_exceeded",
    );
  } finally {
    // If the production code path didn't already remove the placeholder
    // (e.g. the assertion above failed), make sure we don't leave a
    // dangling 60s timer that keeps the test process alive.
    if (!aborted) _clearActiveHeartbeatForTests(key);
  }

  assert.equal(
    _hasActiveHeartbeatForTests(key),
    false,
    "active-heartbeat map must no longer contain the key after max_processing_exceeded",
  );

  const row = await readJob(jobId);
  const leaseExpiresAt = row.leaseExpiresAt as Date;
  assert.ok(leaseExpiresAt, "lease_expires_at must be set");
  const drift = Math.abs(leaseExpiresAt.getTime() - Date.now());
  assert.ok(
    drift < 5_000,
    `lease_expires_at must be set to ~now (drift ${drift}ms, expected < 5000ms)`,
  );
  // Status must remain 'processing' — the heartbeat path does NOT
  // change status on its own; the next recoverStaleLeases sweep is
  // what will actually requeue or fail the row.
  assert.equal(
    row.status,
    "processing",
    "heartbeat must NOT change status — that's the lease-sweeper's job",
  );
}

async function testOverridesHonored(): Promise<void> {
  const previous = await storage.getSystemSetting(QUEUE_MAX_PROCESSING_KEY);
  const previousValue = previous?.value ?? null;

  // 60s — comfortably above the 30s minimum the parser enforces, and
  // far below the 15min default so the test can prove the override
  // (not the default) is what triggered reclamation.
  const overrideMs = 60_000;
  const merged: Record<string, number> = previousValue
    ? (() => {
        try {
          const obj = JSON.parse(previousValue);
          return obj && typeof obj === "object" && !Array.isArray(obj) ? { ...obj } : {};
        } catch {
          return {};
        }
      })()
    : {};
  merged[Q_OVERRIDE] = overrideMs;
  // Pass "system" so the storage layer coerces updated_by to NULL
  // (the column has a FK to users; a literal test id would 23503).
  await storage.setSystemSetting(
    QUEUE_MAX_PROCESSING_KEY,
    JSON.stringify(merged),
    "system",
  );
  invalidateQueueMaxProcessingCache();

  try {
    const got = await getMaxProcessingMs(Q_OVERRIDE);
    assert.equal(
      got,
      overrideMs,
      `override must be honored: expected ${overrideMs}, got ${got}`,
    );

    // End-to-end: a job that exceeded the OVERRIDE (but would NOT have
    // exceeded the much larger default ceiling) must still be reclaimed.
    const past = Date.now() - overrideMs - 30_000;
    const id = await insertProcessingJob({
      queueName: Q_OVERRIDE,
      leasedAtMs: past,
      maxAttempts: 3,
      attemptCount: 0,
    });
    await recoverStaleLeases({
      source: "scheduler",
      workloadClasses: ["ingestion"],
      limit: 10_000,
    });
    const row = await readJob(id);
    assert.equal(
      row.status,
      "pending",
      "job past override must be reclaimed to pending",
    );
    assert.equal(row.attemptCount, 1, "attempt_count must be incremented");
  } finally {
    if (previousValue !== null) {
      await storage.setSystemSetting(
        QUEUE_MAX_PROCESSING_KEY,
        previousValue,
        "system",
      );
    } else {
      await storage.deleteSystemSetting(QUEUE_MAX_PROCESSING_KEY);
    }
    invalidateQueueMaxProcessingCache();
  }
}

async function run(): Promise<void> {
  await cleanupRows();
  try {
    await testRecoverPastMaxProcessing();
    console.log(
      "  ✓ recoverStaleLeases reclaims jobs past per-queue max-processing window (recovered + exhausted paths)",
    );
    await testRecoverExpiredLease();
    console.log(
      "  ✓ recoverStaleLeases reclaims jobs past lease_expires_at — error_code = stale_lease_exhaustion (Task #1085)",
    );
    await testHeartbeatStopsExtendingPastCeiling();
    console.log(
      "  ✓ startHeartbeat tick stops extending the lease and writes lease_expires_at = now once the ceiling is exceeded",
    );
    await testOverridesHonored();
    console.log(
      "  ✓ system_settings.work_queue_max_processing_ms overrides are honored end-to-end",
    );
  } finally {
    await cleanupRows();
  }
  console.log("stuck-job-recovery.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {})
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanupRows();
    } catch {}
    process.exitCode = 1;
  });
