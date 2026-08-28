// @cross-instance-safe: work_queue poller — claims rows with FOR UPDATE SKIP LOCKED; parallel polling across instances is intended.
// @db-pool-intent: worker
import { getDb, runWithWorkerDb, workerDb, withDbAttribution } from "../db";
import { workQueue } from "@shared/schema";
import type { WorkloadClass, WorkQueueJob } from "@shared/schema";
import { REPAIR_QUEUE_CLASSES } from "@shared/schema";
import { eq, and, lte, asc, or, isNull, inArray, sql } from "drizzle-orm";
import { workerLog } from "./workerLogger";
import { acquireClassSlot, releaseClassSlot } from "./workloadManager";
import { mapRowToJob, enqueueToQueue, dequeueFromQueue, recoverStaleLeases as sharedRecoverStaleLeases } from "./workQueueLease";
import { PERF } from "../perfConfig";
import { getMaxProcessingMs } from "./queueMaxProcessing";

type RepairQueueClass = "interactive_repair" | "repair" | "maintenance";

/** A bounded handoff queue; it never tries to alter a failing test itself. */
export const DEFERRED_FAILURE_REPAIR_QUEUE = "deferred_failure_repair";
/** A single nightly intake may create at most this many repair handoffs. */
export const DEFERRED_FAILURE_REPAIR_BATCH_MAX_ITEMS = 10;
/** A delayed/replayed report must not manufacture new repair work. */
export const DEFERRED_FAILURE_REPAIR_MAX_AGE_MS = 36 * 60 * 60 * 1_000;

/**
 * A bounded, non-executing handoff for a human-owned repair item. Deferred
 * verification dispatches this through the existing repair queue, but the
 * registered handler only records a manual handoff. It never turns a test
 * observation into an automatic source edit or a retry loop.
 */
export interface DeferredFailureRepairRequest {
  ownerFeedbackId: number | null;
  canonicalKey: string;
  classification: "task-caused" | "proven-inherited" | "recurring-intermittent" | "unresolved";
  evidenceCodes: string[];
  workloadClass: "repair";
  dispatch: "manual-triage";
  /** Present on normalized reports so the batch can reject delayed evidence. */
  observedAt?: string;
  source?: "post-merge" | "nightly" | "periodic";
}

export function buildDeferredFailureRepairRequest(input: {
  ownerFeedbackId: number | null;
  canonicalKey: string;
  classification: DeferredFailureRepairRequest["classification"];
  evidenceCodes: readonly string[];
  observedAt?: string;
  source?: DeferredFailureRepairRequest["source"];
}): DeferredFailureRepairRequest {
  return {
    ownerFeedbackId: input.ownerFeedbackId,
    canonicalKey: input.canonicalKey.slice(0, 255),
    classification: input.classification,
    evidenceCodes: [...new Set(input.evidenceCodes)].slice(0, 8),
    workloadClass: "repair",
    dispatch: "manual-triage",
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
    ...(input.source ? { source: input.source } : {}),
  };
}

export interface DeferredFailureRepairEnqueueResult {
  id: string | null;
  /** True only when this owner episode received its first durable handoff. */
  inserted: boolean;
  /** The authoritative batch day already consumed all bounded repair slots. */
  capacityExhausted: boolean;
}

function repairBatchDay(observedAt: string | undefined): string | null {
  const observedMs = observedAt ? Date.parse(observedAt) : Number.NaN;
  return Number.isFinite(observedMs)
    ? new Date(observedMs).toISOString().slice(0, 10)
    : null;
}

/**
 * Create exactly one repair-queue handoff for a feedback-owner episode.
 *
 * Queue-level dedupe intentionally releases after terminal completion, which
 * is right for normal retryable work but wrong for a human repair owner: a
 * later nightly observation must refresh its evidence, not re-open a completed
 * handoff. The transaction-scoped advisory lock makes the history check and
 * insert atomic across concurrent scheduler instances.
 */
export async function enqueueDeferredFailureRepairRequest(
  request: DeferredFailureRepairRequest,
): Promise<DeferredFailureRepairEnqueueResult> {
  if (request.ownerFeedbackId == null || request.classification === "unresolved") {
    return { id: null, inserted: false, capacityExhausted: false };
  }

  const batchDay = repairBatchDay(request.observedAt);
  if (!batchDay) return { id: null, inserted: false, capacityExhausted: false };
  const dedupeKey = `deferred-failure-repair:${request.ownerFeedbackId}`;
  return runWithWorkerDb(() =>
    withDbAttribution("deferredFailureRepair:enqueue", () =>
      getDb().transaction(async (tx) => {
        // Take the day lock before the owner lock everywhere. That keeps the
        // count + insert atomic across instances and avoids lock-order cycles.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${"deferred-failure-repair-day:" + batchDay}, 42))`,
        );
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${dedupeKey}, 42))`,
        );

        // Intentionally include terminal rows. A completed handoff remains the
        // owner episode's durable "already sent" marker until feedback recovery
        // creates a new owner id.
        const [existing] = await tx
          .select({ id: workQueue.id })
          .from(workQueue)
          .where(eq(workQueue.dedupeKey, dedupeKey))
          .limit(1);
        if (existing) return { id: existing.id, inserted: false, capacityExhausted: false };

        // Queue history is the durable daily budget. It includes terminal rows
        // so failed/cancelled handoffs cannot be replaced by an unbounded
        // follow-up burst, and uses the report day rather than clock time so
        // a delayed but still-fresh run cannot spill into a new batch.
        const capacity = await tx.execute(sql`
          SELECT count(*)::int AS count
          FROM work_queue
          WHERE queue_name = ${DEFERRED_FAILURE_REPAIR_QUEUE}
            AND payload->>'batchDay' = ${batchDay}
        `);
        const used = Number((capacity.rows?.[0] as any)?.count ?? 0);
        if (used >= DEFERRED_FAILURE_REPAIR_BATCH_MAX_ITEMS) {
          return { id: null, inserted: false, capacityExhausted: true };
        }

        const [inserted] = await tx
          .insert(workQueue)
          .values({
            queueName: DEFERRED_FAILURE_REPAIR_QUEUE,
            jobType: DEFERRED_FAILURE_REPAIR_QUEUE,
            workloadClass: "repair",
            priority: 100,
            status: "pending",
            payload: {
              ownerFeedbackId: request.ownerFeedbackId,
              canonicalKey: request.canonicalKey,
              classification: request.classification,
              evidenceCodes: request.evidenceCodes,
              dispatch: request.dispatch,
              observedAt: request.observedAt ?? null,
              batchDay,
            },
            maxAttempts: PERF.REPAIR_DISPATCHER_MAX_ATTEMPTS,
            dedupeKey,
          })
          .returning({ id: workQueue.id });

        return inserted
          ? { id: inserted.id, inserted: true, capacityExhausted: false }
          : { id: null, inserted: false, capacityExhausted: false };
      }),
    ),
  );
}

const LEASE_OWNER = `repair-dispatcher-${process.pid}`;

type JobHandler = (job: WorkQueueJob) => Promise<{ cursor?: string } | void>;

const handlers = new Map<string, JobHandler>();
let dispatcherTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let isShuttingDown = false;

// Task #1048: heartbeat timers are keyed by `${jobId}:${leasedAtMs}`
// (lease key) so that if a row gets reclaimed mid-flight and a new
// attempt for the same jobId starts up, the old attempt's lifecycle
// hooks can't clobber the new attempt's heartbeat timer.
const activeJobHeartbeats = new Map<string, ReturnType<typeof setTimeout>>();
const activeDispatcherJobs = new Set<string>();

function leaseKey(jobId: string, leasedAtMs: number): string {
  return `${jobId}:${leasedAtMs}`;
}

function stopHeartbeat(key: string): void {
  const timer = activeJobHeartbeats.get(key);
  if (timer) {
    clearTimeout(timer);
    activeJobHeartbeats.delete(key);
  }
}

const consecutiveSkips: Record<RepairQueueClass, number> = {
  interactive_repair: 0,
  repair: 0,
  maintenance: 0,
};

export function registerRepairHandler(queueName: string, handler: JobHandler): void {
  handlers.set(queueName, handler);
}

function tryAcquireSlot(cls: RepairQueueClass): boolean {
  return acquireClassSlot(`repair-dispatch:${cls}`);
}

function releaseSlot(cls: RepairQueueClass): void {
  releaseClassSlot(`repair-dispatch:${cls}`);
}

function trackJobStart(jobId: string): void {
  activeDispatcherJobs.add(jobId);
}

function trackJobEnd(jobId: string, cls: RepairQueueClass): void {
  activeDispatcherJobs.delete(jobId);
  releaseSlot(cls);
  // Task #1048: heartbeat timers are now cleared inside processJobInner's
  // finally block via stopHeartbeat(leaseKey). Do NOT touch the map here:
  // by the time we land in trackJobEnd the row may already have been
  // reclaimed and a new attempt may be running with the same jobId
  // (different leaseKey) — clearing by jobId would silently disable that
  // new attempt's heartbeat.
}

function startHeartbeat(jobId: string, queueName: string, leasedAtMs: number): string {
  // Task #913C: heartbeat ticks fire outside the per-job
  // `withDbAttribution` scope, so they need their own attribution
  // wrapper. Otherwise every repair-job heartbeat would land on the
  // worker pool as `unknown`.
  // Task #1048: switched from setInterval to a setTimeout chain so we
  // can enforce per-queue max processing duration and stop firing once
  // the cap is hit. Heartbeat is keyed by lease attempt so two
  // attempts for the same jobId can coexist safely.
  const heartbeatLabel = `worker:${queueName}:heartbeat`;
  const key = leaseKey(jobId, leasedAtMs);

  const tick = async () => {
    if (!activeJobHeartbeats.has(key)) return;
    try {
      const maxProcessingMs = await getMaxProcessingMs(queueName);
      const elapsedMs = Date.now() - leasedAtMs;
      if (elapsedMs >= maxProcessingMs) {
        await withDbAttribution(heartbeatLabel, () =>
          workerDb.update(workQueue)
            .set({
              heartbeatAt: new Date(),
              leaseExpiresAt: new Date(),
            })
            .where(
              and(
                eq(workQueue.id, jobId),
                eq(workQueue.status, "processing"),
                eq(workQueue.leasedAt, new Date(leasedAtMs)),
              ),
            ),
        );
        workerLog({
          worker: "repairDispatcher",
          event: "max_processing_exceeded",
          jobId,
          queueName,
          elapsedMs,
          maxProcessingMs,
        });
        // Stop heartbeating so the lease sweeper reclaims this row.
        // Terminal updates in processJobInner are lease-guarded, so a
        // still-running handler can't clobber the reclaimed row.
        stopHeartbeat(key);
        return;
      }
      await withDbAttribution(heartbeatLabel, () =>
        workerDb.update(workQueue)
          .set({
            heartbeatAt: new Date(),
            leaseExpiresAt: new Date(Date.now() + PERF.REPAIR_DISPATCHER_LEASE_MS),
          })
          .where(
            and(
              eq(workQueue.id, jobId),
              eq(workQueue.status, "processing"),
              eq(workQueue.leasedAt, new Date(leasedAtMs)),
            ),
          ),
      );
      workerLog({ worker: "repairDispatcher", event: "job_heartbeat", jobId });
    } catch (err) {
      console.error(`[RepairDispatcher] Heartbeat failed for job ${jobId}:`, err);
    }
    if (!activeJobHeartbeats.has(key)) return;
    const timer = setTimeout(tick, PERF.REPAIR_DISPATCHER_HEARTBEAT_MS);
    activeJobHeartbeats.set(key, timer);
  };

  const seed = setTimeout(tick, PERF.REPAIR_DISPATCHER_HEARTBEAT_MS);
  activeJobHeartbeats.set(key, seed);
  return key;
}

const recentCompletions: Array<{
  jobId: string;
  queueName: string;
  workloadClass: string;
  completedAt: Date;
  durationMs: number;
  status: "completed" | "failed" | "dead_letter";
}> = [];
const MAX_RECENT = 50;

function trackCompletion(
  job: WorkQueueJob,
  durationMs: number,
  status: "completed" | "failed" | "dead_letter",
): void {
  recentCompletions.push({
    jobId: job.id,
    queueName: job.queueName,
    workloadClass: job.workloadClass,
    completedAt: new Date(),
    durationMs,
    status,
  });
  if (recentCompletions.length > MAX_RECENT) {
    recentCompletions.splice(0, recentCompletions.length - MAX_RECENT);
  }
}

async function recoverStaleLeases(): Promise<void> {
  await sharedRecoverStaleLeases({
    source: "repairDispatcher",
    // Task #1048: heartbeat map is keyed by `${jobId}:${leasedAtMs}`,
    // so exclude by jobId portion. We intentionally do NOT also union
    // activeDispatcherJobs — a hung handler stays in that set forever
    // and would block the very reclamation this task introduces.
    excludeJobIds: [
      ...new Set([...activeJobHeartbeats.keys()].map((k) => k.split(":")[0])),
    ],
    workloadClasses: ["interactive_repair", "repair", "maintenance"],
  });
}

async function dequeueForClass(cls: RepairQueueClass): Promise<WorkQueueJob | null> {
  const job = await dequeueFromQueue(cls, LEASE_OWNER, PERF.REPAIR_DISPATCHER_LEASE_MS);
  if (job) {
    workerLog({
      worker: job.queueName,
      event: "job_leased",
      jobId: job.id,
      workloadClass: cls,
    });
  }
  return job;
}

async function processJob(job: WorkQueueJob): Promise<void> {
  // Task #913C: mirror the workScheduler pattern — wrap the entire
  // dispatcher-side execution of a repair job (lease update,
  // heartbeats, completion update, handler) in a stable per-queue DB
  // hold label. Inner handlers are still free to refine via their own
  // `withDbAttribution("…:substep", …)` wrapper.
  return withDbAttribution(`worker:${job.queueName}`, () => processJobInner(job));
}

async function processJobInner(job: WorkQueueJob): Promise<void> {
  const handler = handlers.get(job.queueName);
  if (!handler) {
    await workerDb.update(workQueue)
      .set({
        status: "failed",
        errorMessage: `No handler registered for queue "${job.queueName}"`,
        completedAt: new Date(),
      })
      .where(eq(workQueue.id, job.id));

    workerLog({
      worker: job.queueName,
      event: "job_failed",
      jobId: job.id,
      error: `No handler registered for queue "${job.queueName}"`,
    });
    return;
  }

  const procNow = new Date();
  await workerDb.update(workQueue)
    .set({
      status: "processing",
      leasedAt: procNow,
      leaseOwner: LEASE_OWNER,
      leaseExpiresAt: new Date(procNow.getTime() + PERF.REPAIR_DISPATCHER_LEASE_MS),
      heartbeatAt: procNow,
    })
    .where(eq(workQueue.id, job.id));

  const heartbeatKey = startHeartbeat(job.id, job.queueName, procNow.getTime());

  // Task #1048: lease-ownership guard for all terminal updates so a
  // stale, overrun handler can't clobber a row that was already
  // reclaimed and reattempted (would otherwise silently drop the new
  // attempt's progress / retry).
  const leaseGuard = and(
    eq(workQueue.id, job.id),
    eq(workQueue.status, "processing"),
    eq(workQueue.leaseOwner, LEASE_OWNER),
    eq(workQueue.leasedAt, procNow),
  );

  const startTime = Date.now();

  try {
    const result = await handler(job);
    const durationMs = Date.now() - startTime;

    const updated = await workerDb.update(workQueue)
      .set({
        status: "completed",
        completedAt: new Date(),
        cursor: result?.cursor ?? job.cursor,
      })
      .where(leaseGuard)
      .returning({ id: workQueue.id });

    if (updated.length === 0) {
      workerLog({
        worker: job.queueName,
        event: "job_completion_stale_lease_ignored",
        jobId: job.id,
        durationMs,
        outcome: "completed",
        workloadClass: job.workloadClass,
      });
      return;
    }

    workerLog({
      worker: job.queueName,
      event: "job_completed",
      jobId: job.id,
      durationMs,
      workloadClass: job.workloadClass,
    });
    trackCompletion(job, durationMs, "completed");
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    const nextAttempt = (job.attemptCount ?? 0) + 1;
    const maxAttempts = job.maxAttempts || PERF.REPAIR_DISPATCHER_MAX_ATTEMPTS;

    if (nextAttempt >= maxAttempts) {
      const updated = await workerDb.update(workQueue)
        .set({
          status: "dead_letter",
          errorMessage: errMsg,
          attemptCount: nextAttempt,
          completedAt: new Date(),
        })
        .where(leaseGuard)
        .returning({ id: workQueue.id });

      if (updated.length === 0) {
        workerLog({
          worker: job.queueName,
          event: "job_completion_stale_lease_ignored",
          jobId: job.id,
          durationMs,
          outcome: "dead_letter",
          error: errMsg,
          workloadClass: job.workloadClass,
        });
        return;
      }

      workerLog({
        worker: job.queueName,
        event: "job_dead_lettered",
        jobId: job.id,
        durationMs,
        error: errMsg,
        attemptCount: nextAttempt,
        maxAttempts,
        workloadClass: job.workloadClass,
      });
      trackCompletion(job, durationMs, "dead_letter");
    } else {
      const backoff = Math.min(
        PERF.REPAIR_DISPATCHER_BASE_BACKOFF_MS * Math.pow(2, nextAttempt - 1),
        PERF.REPAIR_DISPATCHER_MAX_BACKOFF_MS,
      );
      const jitter = Math.floor(Math.random() * Math.min(backoff * 0.1, 5_000));
      const retryAt = new Date(Date.now() + backoff + jitter);

      const updated = await workerDb.update(workQueue)
        .set({
          status: "pending",
          errorMessage: errMsg,
          attemptCount: nextAttempt,
          retryAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        })
        .where(leaseGuard)
        .returning({ id: workQueue.id });

      if (updated.length === 0) {
        workerLog({
          worker: job.queueName,
          event: "job_completion_stale_lease_ignored",
          jobId: job.id,
          durationMs,
          outcome: "retry",
          error: errMsg,
          workloadClass: job.workloadClass,
        });
        return;
      }

      workerLog({
        worker: job.queueName,
        event: "job_retrying",
        jobId: job.id,
        attemptCount: nextAttempt,
        retryAt: retryAt.toISOString(),
        workloadClass: job.workloadClass,
      });
    }
  } finally {
    // Task #1048: clear THIS attempt's heartbeat by lease key. Any new
    // attempt for the same jobId already lives under a different key
    // and is left untouched.
    stopHeartbeat(heartbeatKey);
  }
}

function buildFairClassOrder(): RepairQueueClass[] {
  const baseOrder: RepairQueueClass[] = ["interactive_repair", "repair", "maintenance"];
  const maxSkip = PERF.REPAIR_DISPATCHER_MAX_SKIP_CYCLES;

  const starvedClasses = baseOrder.filter(cls => consecutiveSkips[cls] >= maxSkip);
  if (starvedClasses.length === 0) return baseOrder;

  const promoted = starvedClasses.sort((a, b) => consecutiveSkips[b] - consecutiveSkips[a]);
  const remaining = baseOrder.filter(cls => !starvedClasses.includes(cls));
  return [...promoted, ...remaining];
}

async function dispatcherCycleImpl(): Promise<void> {
  if (isRunning || isShuttingDown) return;
  isRunning = true;

  try {
    await recoverStaleLeases();

    const classOrder = buildFairClassOrder();

    for (const cls of classOrder) {
      if (!tryAcquireSlot(cls)) {
        consecutiveSkips[cls]++;
        continue;
      }

      const job = await dequeueForClass(cls);
      if (!job) {
        releaseSlot(cls);
        consecutiveSkips[cls]++;
        continue;
      }

      trackJobStart(job.id);
      consecutiveSkips[cls] = 0;

      // fire-and-forget: concurrent dispatch by design; processJob marks the
      // job failed/completed itself and never rejects past its own handling.
      void processJob(job).finally(() => {
        trackJobEnd(job.id, cls);
      });
    }

    // Task #1025: per-cycle drain-extra pass for `retroactive_reprocess`.
    // The base fair-class loop above dispatches at most one job per
    // class per cycle. With a 91k-row backlog that throughput (1 job
    // every poll interval) is far too slow. The class budget for
    // `repair` is now `RETROACTIVE_REPROCESS_CONCURRENCY`, so as long
    // as slots are available we drain additional pending
    // retroactive_reprocess rows in this same cycle. Same-client
    // safety is enforced by the consumer's in-process
    // `activeReprocesses` Set + 30s cooldown, so a cycle that picks
    // up two rows for the same client simply no-ops the duplicate.
    // Task #1575 (Track E, F-11) — leave a one-slot reservation for
    // sibling repair queues so a deep `retroactive_reprocess` backlog
    // cannot drain the entire repair class budget for the lifetime of
    // its (potentially long-running) jobs. Without this, when
    // RETROACTIVE_REPROCESS_CONCURRENCY equals the class budget, every
    // slot can be held by long-running retro jobs across cycles and
    // sibling queues starve. We previously drained
    // `CONCURRENCY - 1` extra rows (`CONCURRENCY` total including the
    // base fair-class pick); we now drain `CONCURRENCY - 2` extra
    // (`CONCURRENCY - 1` total) so at least one repair-class slot is
    // always reachable by a sibling queue on the next cycle.
    const extra = Math.max(0, PERF.RETROACTIVE_REPROCESS_CONCURRENCY - 2);
    for (let i = 0; i < extra; i++) {
      if (!tryAcquireSlot("repair")) break;
      const job = await dequeueFromQueue(
        "repair",
        LEASE_OWNER,
        PERF.REPAIR_DISPATCHER_LEASE_MS,
        { queueName: "retroactive_reprocess" },
      );
      if (!job) {
        releaseSlot("repair");
        break;
      }
      trackJobStart(job.id);
      void processJob(job).finally(() => trackJobEnd(job.id, "repair")); // fire-and-forget dispatch
    }
  } catch (err) {
    console.error("[RepairDispatcher] Dispatch cycle error:", err);
  } finally {
    isRunning = false;
  }
}

// Task #913C: wrap the repeating poll cycle in `scheduler:` attribution
// so the lease-recovery sweep + dequeue-class scan are not recorded as
// `unknown` worker holds.
function dispatcherCycle(): Promise<void> {
  return withDbAttribution("scheduler:repair-dispatcher", dispatcherCycleImpl);
}

export function startRepairDispatcher(): void {
  if (dispatcherTimer) return;

  if (!PERF.REPAIR_DISPATCHER_ENABLED) {
    console.log("[RepairDispatcher] Not starting — REPAIR_DISPATCHER_ENABLED is false");
    return;
  }

  workerLog({ worker: "repairDispatcher", event: "dispatcher_started" });
  console.log(`[RepairDispatcher] Starting dispatcher (poll every ${PERF.REPAIR_DISPATCHER_POLL_MS}ms)`);
  dispatcherTimer = setInterval(dispatcherCycle, PERF.REPAIR_DISPATCHER_POLL_MS);
}

export function stopRepairDispatcher(): void {
  isShuttingDown = true;
  if (dispatcherTimer) {
    clearInterval(dispatcherTimer);
    dispatcherTimer = null;
    workerLog({ worker: "repairDispatcher", event: "dispatcher_stopped" });
    console.log("[RepairDispatcher] Dispatcher stopped");
  }
}

export function getRepairDispatcherStatus(): {
  activeJobs: string[];
  consecutiveSkips: Record<RepairQueueClass, number>;
  recentCompletions: typeof recentCompletions;
} {
  return {
    activeJobs: [...activeDispatcherJobs],
    consecutiveSkips: { ...consecutiveSkips },
    recentCompletions: [...recentCompletions].reverse().slice(0, 20),
  };
}

export async function enqueueRepairJob(params: {
  queueName: string;
  workloadClass: "interactive_repair" | "repair" | "maintenance";
  priority?: number;
  payload?: Record<string, unknown>;
  cursor?: string;
  maxAttempts?: number;
  retryAt?: Date;
  dedupeKey?: string;
}): Promise<string> {
  const result = await enqueueToQueue({
    ...params,
    maxAttempts: params.maxAttempts ?? PERF.REPAIR_DISPATCHER_MAX_ATTEMPTS,
  });

  if (result.inserted) {
    workerLog({
      worker: params.queueName,
      event: "job_enqueued",
      workloadClass: params.workloadClass,
      priority: params.priority ?? 100,
      jobId: result.id,
    });
  }

  return result.id;
}

export async function isJobActiveInQueue(queueName: string): Promise<boolean> {
  const [active] = await workerDb
    .select({ id: workQueue.id })
    .from(workQueue)
    .where(
      and(
        eq(workQueue.queueName, queueName),
        or(
          eq(workQueue.status, "pending"),
          eq(workQueue.status, "leased"),
          eq(workQueue.status, "processing"),
        ),
      ),
    )
    .limit(1);
  return !!active;
}

export async function getRepairJobById(jobId: string): Promise<WorkQueueJob | null> {
  const [row] = await workerDb
    .select()
    .from(workQueue)
    .where(eq(workQueue.id, jobId))
    .limit(1);
  return row ?? null;
}
