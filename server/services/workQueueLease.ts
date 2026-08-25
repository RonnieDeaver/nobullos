// @db-pool-intent: worker
//
// Task #1878 — `enqueueToQueue` now routes through `getDb()` (wrapped
// in `runWithWorkerDb`) so the test-only schema sandbox in
// `tests/db-sandbox.ts` can redirect inserts to an isolated schema
// without the live `Start application` workers seeing the row. In
// production the explicit `runWithWorkerDb` wrap pins the insert to
// the worker pool, preserving the pre-existing tenancy (this code is
// background work; no API request should burn an `api` pool slot on
// it).
import { workerDb, getDb, runWithWorkerDb, withDbAttribution } from "../db";
import { workQueue } from "@shared/schema";
import type { WorkloadClass, WorkQueueJob } from "@shared/schema";
import { eq, and, or, sql, type SQL } from "drizzle-orm";
import { workerLog } from "./workerLogger";
import { pipelineLog } from "./pipelineLogger";
import { recordStaleLeaseExhaustion } from "./pipelineObservability";
import {
  DEFAULT_QUEUE_MAX_PROCESSING_MS,
  getEffectiveMaxProcessingMap,
} from "./queueMaxProcessing";

/**
 * Build a SQL CASE expression that resolves to each row's effective
 * max-processing duration (ms) keyed off `queue_name`. Used by
 * `recoverStaleLeases` so a stuck-but-still-heartbeating handler whose
 * lease keeps getting extended is reclaimed once it has been processing
 * longer than the queue's configured ceiling.
 */
async function buildMaxProcessingCaseSql() {
  const map = await getEffectiveMaxProcessingMap();
  const fallback = map.default ?? DEFAULT_QUEUE_MAX_PROCESSING_MS.default;
  const branches = Object.entries(map)
    .filter(([k]) => k !== "default")
    .map(([k, v]) => sql`WHEN ${k} THEN ${v}::bigint`);
  if (branches.length === 0) return sql`${fallback}::bigint`;
  return sql`(CASE queue_name ${sql.join(branches, sql` `)} ELSE ${fallback}::bigint END)`;
}

export function mapRowToJob(row: Record<string, unknown>): WorkQueueJob {
  return {
    id: row.id as string,
    queueName: (row.queue_name ?? row.queueName) as string,
    jobType: (row.job_type ?? row.jobType) as string,
    workloadClass: (row.workload_class ?? row.workloadClass) as string,
    priority: (row.priority as number) ?? 5,
    status: (row.status as string) ?? "pending",
    payload: (row.payload ?? null) as Record<string, unknown> | null,
    payloadJson: (row.payload_json ?? row.payloadJson ?? null) as Record<string, unknown> | null,
    dedupeKey: (row.dedupe_key ?? row.dedupeKey ?? null) as string | null,
    cursor: (row.cursor ?? null) as string | null,
    cursorJson: (row.cursor_json ?? row.cursorJson ?? null) as Record<string, unknown> | null,
    attemptCount: (row.attempt_count ?? row.attemptCount ?? 0) as number,
    maxAttempts: (row.max_attempts ?? row.maxAttempts ?? 3) as number,
    retryAt: row.retry_at ? new Date(row.retry_at as string) : (row.retryAt as Date | null) ?? null,
    leasedAt: row.leased_at ? new Date(row.leased_at as string) : (row.leasedAt as Date | null) ?? null,
    leaseOwner: (row.lease_owner ?? row.leaseOwner ?? null) as string | null,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at as string) : (row.leaseExpiresAt as Date | null) ?? null,
    heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at as string) : (row.heartbeatAt as Date | null) ?? null,
    errorCode: (row.error_code ?? row.errorCode ?? null) as string | null,
    errorMessage: (row.error_message ?? row.errorMessage ?? null) as string | null,
    createdAt: row.created_at ? new Date(row.created_at as string) : (row.createdAt as Date) ?? new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at as string) : (row.updatedAt as Date) ?? new Date(),
    completedAt: row.completed_at ? new Date(row.completed_at as string) : (row.completedAt as Date | null) ?? null,
  };
}

export async function enqueueToQueue(params: {
  queueName: string;
  workloadClass: WorkloadClass;
  priority?: number;
  payload?: Record<string, unknown>;
  cursor?: string;
  maxAttempts?: number;
  retryAt?: Date;
  dedupeKey?: string;
}): Promise<{ id: string; inserted: boolean }> {
  return runWithWorkerDb(() =>
    withDbAttribution("workQueueLease:enqueueToQueue", async () => {
      const handle = getDb();
      const [inserted] = await handle.insert(workQueue).values({
        queueName: params.queueName,
        jobType: params.queueName,
        workloadClass: params.workloadClass,
        priority: params.priority ?? 100,
        status: "pending",
        payload: params.payload ?? null,
        cursor: params.cursor ?? null,
        maxAttempts: params.maxAttempts ?? 3,
        retryAt: params.retryAt ?? null,
        dedupeKey: params.dedupeKey ?? null,
      }).onConflictDoNothing().returning({ id: workQueue.id });

      if (inserted) {
        return { id: inserted.id, inserted: true };
      }

      if (params.dedupeKey) {
        const [existing] = await handle
          .select({ id: workQueue.id })
          .from(workQueue)
          .where(
            and(
              eq(workQueue.dedupeKey, params.dedupeKey),
              or(
                eq(workQueue.status, "pending"),
                eq(workQueue.status, "leased"),
                eq(workQueue.status, "processing"),
              ),
            ),
          )
          .limit(1);

        if (existing) return { id: existing.id, inserted: false };
      }

      return { id: params.dedupeKey ?? "enqueue-conflict", inserted: false };
    }),
  );
}

type WorkQueueQueryExecutor = (
  query: SQL,
) => Promise<{ rows: Array<Record<string, unknown>> }>;

async function dequeueFromQueueUsing(
  execute: WorkQueueQueryExecutor,
  cls: WorkloadClass | string,
  leaseOwner: string,
  leaseMs: number,
  options: { excludeQueueNames?: string[]; queueName?: string } = {},
): Promise<WorkQueueJob | null> {
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + leaseMs);

  const excludeFilter =
    options.excludeQueueNames && options.excludeQueueNames.length > 0
      ? sql`AND queue_name NOT IN (${sql.join(options.excludeQueueNames.map((n) => sql`${n}`), sql`, `)})`
      : sql``;
  const queueFilter = options.queueName
    ? sql`AND queue_name = ${options.queueName}`
    : sql``;

  const result = await execute(sql`
    UPDATE work_queue
    SET
      status = 'leased',
      lease_owner = ${leaseOwner},
      lease_expires_at = ${leaseExpiry},
      heartbeat_at = ${now},
      leased_at = ${now},
      updated_at = ${now}
    WHERE id IN (
      SELECT id FROM work_queue
      WHERE workload_class = ${cls}
        ${queueFilter}
        ${excludeFilter}
        AND (
          (status = 'pending' AND (retry_at IS NULL OR retry_at <= ${now}))
          OR (status IN ('leased', 'processing') AND lease_expires_at < ${now})
        )
      ORDER BY
        CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
        priority ASC,
        created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `);

  const raw = result.rows[0] as Record<string, unknown> | undefined;
  if (!raw) return null;
  return mapRowToJob(raw);
}

export async function dequeueFromQueue(
  cls: WorkloadClass | string,
  leaseOwner: string,
  leaseMs: number,
  options: { excludeQueueNames?: string[]; queueName?: string } = {},
): Promise<WorkQueueJob | null> {
  return dequeueFromQueueUsing(
    (query) =>
      workerDb.execute(query) as Promise<{
        rows: Array<Record<string, unknown>>;
      }>,
    cls,
    leaseOwner,
    leaseMs,
    options,
  );
}

/**
 * TEST-ONLY: lease through the exact production dequeue query while honoring
 * the isolated-schema getDb override. Production always uses dequeueFromQueue.
 */
export async function __test_dequeueFromQueueUsingCurrentDb(
  cls: WorkloadClass | string,
  leaseOwner: string,
  leaseMs: number,
  options: { excludeQueueNames?: string[]; queueName?: string } = {},
): Promise<WorkQueueJob | null> {
  return runWithWorkerDb(() =>
    withDbAttribution("workQueueLease:testDequeue", () =>
      dequeueFromQueueUsing(
        (query) =>
          getDb().execute(query) as Promise<{
            rows: Array<Record<string, unknown>>;
          }>,
        cls,
        leaseOwner,
        leaseMs,
        options,
      ),
    ),
  );
}

/**
 * Task #986: list distinct queue names that currently have at least
 * one dequeue-eligible job in the given workload class. Used by the
 * scheduler's per-queue fairness path to pick the next queue in a
 * round-robin order across siblings, so a queue with thousands of
 * pending jobs (e.g. retroactive_reprocess) can't perpetually starve
 * sibling queues sharing the same class.
 */
export async function listEligibleQueueNamesForClass(
  cls: WorkloadClass | string,
  limit = 32,
): Promise<string[]> {
  const now = new Date();
  const result = await workerDb.execute<{ queue_name: string }>(sql`
    SELECT DISTINCT queue_name
    FROM work_queue
    WHERE workload_class = ${cls}
      AND (
        (status = 'pending' AND (retry_at IS NULL OR retry_at <= ${now}))
        OR (status IN ('leased', 'processing') AND lease_expires_at < ${now})
      )
    LIMIT ${limit}
  `);
  return (result.rows as Array<{ queue_name: string }>).map((r) => r.queue_name);
}

export interface RecoverStaleLeasesOptions {
  source: "scheduler" | "repairDispatcher";
  excludeJobIds?: string[];
  workloadClasses?: readonly string[];
  limit?: number;
  emitReleasedPipelineLog?: boolean;
}

export interface RecoverStaleLeasesResult {
  exhausted: number;
  recovered: number;
}

export async function recoverStaleLeases(
  options: RecoverStaleLeasesOptions,
): Promise<RecoverStaleLeasesResult> {
  const {
    source,
    excludeJobIds = [],
    workloadClasses,
    limit = 50,
    emitReleasedPipelineLog = false,
  } = options;

  const now = new Date();
  const ownedFilter = excludeJobIds.length > 0
    ? sql`AND id NOT IN (${sql.join(excludeJobIds.map(id => sql`${id}`), sql`, `)})`
    : sql``;
  const classFilter = workloadClasses && workloadClasses.length > 0
    ? sql`AND workload_class IN (${sql.join(workloadClasses.map(c => sql`${c}`), sql`, `)})`
    : sql``;

  // Task #1048: a hung handler whose heartbeat keeps firing extends
  // `lease_expires_at` past `now()` indefinitely. The two reclaim
  // queries below also match rows whose `leased_at + max_processing_ms`
  // (per queue) is in the past — that catches the stuck-but-pinging
  // case even when the heartbeat-side cap fails (e.g. handler is in a
  // different process, or the heartbeat itself is stuck).
  const maxProcessingCase = await buildMaxProcessingCaseSql();
  const overrunPredicate = sql`(leased_at IS NOT NULL AND leased_at + (${maxProcessingCase} || ' milliseconds')::interval < ${now})`;
  const stalePredicate = sql`(lease_expires_at < ${now} OR ${overrunPredicate})`;

  const exhaustedResult = await workerDb.execute(sql`
    UPDATE work_queue
    SET
      status = 'failed',
      error_message = CASE WHEN lease_expires_at < ${now}
        THEN 'stale_lease_exhaustion'
        ELSE 'max_processing_exhaustion' END,
      error_code = CASE WHEN lease_expires_at < ${now}
        THEN 'stale_lease_exhaustion'
        ELSE 'max_processing_exhaustion' END,
      attempt_count = attempt_count + 1,
      completed_at = ${now},
      updated_at = ${now}
    WHERE id IN (
      SELECT id FROM work_queue
      WHERE status IN ('leased', 'processing')
        AND ${stalePredicate}
        AND attempt_count + 1 >= max_attempts
        ${classFilter}
        ${ownedFilter}
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING id, queue_name, workload_class, attempt_count, max_attempts, error_code
  `);

  const exhaustedRows = exhaustedResult.rows as {
    id: string;
    queue_name: string;
    workload_class: string;
    attempt_count: number;
    max_attempts: number;
    error_code: string;
  }[];

  for (const row of exhaustedRows) {
    // Task #1048: distinguish overrun-driven exhaustion from
    // expired-lease exhaustion so on-call can tell which protection
    // fired (and tune the per-queue max-processing override accordingly).
    const reason = row.error_code === "max_processing_exhaustion"
      ? "max_processing_exhaustion"
      : "stale_lease_exhaustion";
    workerLog({
      worker: source,
      event: "stale_lease_exhausted",
      jobId: row.id,
      queueName: row.queue_name,
      workloadClass: row.workload_class,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      reason,
    });
    pipelineLog({
      event: "failed",
      sourceSystem: source,
      sourceEventType: row.workload_class,
      sourceEventId: row.id,
      outcome: reason,
      errorMessage: reason,
    });
    recordStaleLeaseExhaustion({
      jobId: row.id,
      queueName: row.queue_name,
      workloadClass: row.workload_class,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      source,
    });
  }

  const recoveredResult = await workerDb.execute(sql`
    UPDATE work_queue
    SET
      status = 'pending',
      leased_at = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      heartbeat_at = NULL,
      attempt_count = attempt_count + 1,
      updated_at = ${now}
    WHERE id IN (
      SELECT id FROM work_queue
      WHERE status IN ('leased', 'processing')
        AND ${stalePredicate}
        AND attempt_count + 1 < max_attempts
        ${classFilter}
        ${ownedFilter}
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING id, workload_class, attempt_count, max_attempts
  `);

  const recoveredRows = recoveredResult.rows as {
    id: string;
    workload_class: string;
    attempt_count: number;
    max_attempts: number;
  }[];

  for (const row of recoveredRows) {
    workerLog({
      worker: source,
      event: "job_released",
      jobId: row.id,
      workloadClass: row.workload_class,
      reason: "stale_lease_recovered",
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
    });
    if (emitReleasedPipelineLog) {
      pipelineLog({
        event: "replayed",
        sourceSystem: source,
        sourceEventType: row.workload_class,
        sourceEventId: row.id,
        outcome: "stale_lease_recovered",
      });
    }
  }

  return { exhausted: exhaustedRows.length, recovered: recoveredRows.length };
}

export interface ForceReclaimJobOptions {
  operatorId: string;
  operatorUsername: string;
}

export interface ForceReclaimJobResult {
  jobId: string;
  queueName: string;
  workloadClass: string;
  outcome: "recovered" | "exhausted";
  previousLeaseOwner: string | null;
  previousLeasedAt: Date | null;
  previousLeaseExpiresAt: Date | null;
  attemptCount: number;
  maxAttempts: number;
}

export class ForceReclaimNotEligibleError extends Error {
  reason: string;
  currentStatus?: string;
  constructor(reason: string, currentStatus?: string) {
    super(reason);
    this.name = "ForceReclaimNotEligibleError";
    this.reason = reason;
    this.currentStatus = currentStatus;
  }
}

/**
 * Operator-initiated single-row reclaim. Mirrors recoverStaleLeases
 * bookkeeping (attempt_count + 1, exhaust at max_attempts, otherwise
 * release back to pending and clear lease fields) but targets one job
 * by id without waiting for the next stale-lease sweep.
 *
 * Throws ForceReclaimNotEligibleError if the job no longer exists or
 * has already left the leased/processing state (e.g. it finished or
 * was reclaimed by the sweep between the operator's read and click).
 */
export async function forceReclaimJob(
  jobId: string,
  options: ForceReclaimJobOptions,
): Promise<ForceReclaimJobResult> {
  const now = new Date();

  const [existing] = await workerDb
    .select()
    .from(workQueue)
    .where(eq(workQueue.id, jobId))
    .limit(1);

  if (!existing) {
    throw new ForceReclaimNotEligibleError(`Job ${jobId} not found`);
  }
  if (existing.status !== "leased" && existing.status !== "processing") {
    throw new ForceReclaimNotEligibleError(
      `Job ${jobId} is not leased or processing (current status: ${existing.status})`,
      existing.status,
    );
  }

  const previousLeaseOwner = existing.leaseOwner;
  const previousLeasedAt = existing.leasedAt;
  const previousLeaseExpiresAt = existing.leaseExpiresAt;
  const willExhaust = existing.attemptCount + 1 >= existing.maxAttempts;

  interface ReclaimReturningRow {
    id: string;
    queue_name: string;
    workload_class: string;
    attempt_count: number;
    max_attempts: number;
  }

  if (willExhaust) {
    const exhaustedResult = await workerDb.execute(sql`
      UPDATE work_queue
      SET
        status = 'failed',
        error_message = 'force_reclaim_exhaustion',
        error_code = 'force_reclaim_exhaustion',
        attempt_count = attempt_count + 1,
        completed_at = ${now},
        updated_at = ${now}
      WHERE id = ${jobId}
        AND status IN ('leased', 'processing')
      RETURNING id, queue_name, workload_class, attempt_count, max_attempts
    `);
    const row = (exhaustedResult.rows as unknown as ReclaimReturningRow[])[0];
    if (!row) {
      throw new ForceReclaimNotEligibleError(
        `Job ${jobId} was modified concurrently — retry`,
      );
    }
    workerLog({
      worker: "forceReclaim",
      event: "stale_lease_exhausted",
      jobId,
      queueName: row.queue_name,
      workloadClass: row.workload_class,
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      reason: "force_reclaim_exhaustion",
      operatorId: options.operatorId,
      operatorUsername: options.operatorUsername,
      previousLeaseOwner,
    });
    pipelineLog({
      event: "failed",
      sourceSystem: "forceReclaim",
      sourceEventType: row.workload_class,
      sourceEventId: jobId,
      outcome: "force_reclaim_exhaustion",
      errorMessage: "force_reclaim_exhaustion",
      operatorId: options.operatorId,
      operatorUsername: options.operatorUsername,
    });
    recordStaleLeaseExhaustion({
      jobId,
      queueName: row.queue_name,
      workloadClass: row.workload_class,
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      source: "repairDispatcher",
    });
    return {
      jobId,
      queueName: row.queue_name,
      workloadClass: row.workload_class,
      outcome: "exhausted",
      previousLeaseOwner,
      previousLeasedAt,
      previousLeaseExpiresAt,
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
    };
  }

  const recoveredResult = await workerDb.execute(sql`
    UPDATE work_queue
    SET
      status = 'pending',
      leased_at = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      heartbeat_at = NULL,
      attempt_count = attempt_count + 1,
      updated_at = ${now}
    WHERE id = ${jobId}
      AND status IN ('leased', 'processing')
    RETURNING id, queue_name, workload_class, attempt_count, max_attempts
  `);
  const row = (recoveredResult.rows as unknown as ReclaimReturningRow[])[0];
  if (!row) {
    throw new ForceReclaimNotEligibleError(
      `Job ${jobId} was modified concurrently — retry`,
    );
  }
  workerLog({
    worker: "forceReclaim",
    event: "job_released",
    jobId,
    queueName: row.queue_name,
    workloadClass: row.workload_class,
    reason: "force_reclaim",
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    operatorId: options.operatorId,
    operatorUsername: options.operatorUsername,
    previousLeaseOwner,
  });
  pipelineLog({
    event: "replayed",
    sourceSystem: "forceReclaim",
    sourceEventType: row.workload_class,
    sourceEventId: jobId,
    outcome: "force_reclaim",
    operatorId: options.operatorId,
    operatorUsername: options.operatorUsername,
  });
  return {
    jobId,
    queueName: row.queue_name,
    workloadClass: row.workload_class,
    outcome: "recovered",
    previousLeaseOwner,
    previousLeasedAt,
    previousLeaseExpiresAt,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
  };
}