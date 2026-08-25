// @db-pool-intent: worker
// @cross-instance-safe: the self-rescheduling setTimeout loops
// (scheduleNextCycle / scheduleNextFastPollCycle) only drive work_queue claims
// via FOR UPDATE SKIP LOCKED + lease ownership. The loops fire on every
// autoscale instance, but each queue row is leased to exactly one worker, so
// concurrent instances compete safely with no double-processing. (Task #2397)
import {
  workerDb,
  getDb,
  withDbHoldLabel,
  withDbAttribution,
  runWithWorkerDb,
  isApiPoolUnderPressure,
  getWorkerPoolSnapshot,
} from "../db";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";
import { workQueue } from "@shared/schema";
import type { WorkloadClass, WorkQueueJob } from "@shared/schema";
import { eq, and, lte, sql, asc, or, isNull, gte } from "drizzle-orm";
import { workerLog } from "./workerLogger";
import { acquireClassSlot, releaseClassSlot, getClassStatus, getSlotHoldMetrics, loadIngestionClassConcurrencyFromSettings } from "./workloadManager";
import {
  ensureFrontWarpSettingsLoaded,
  getFrontWarpSettings,
  FRONT_WARP_QUEUE_NAMES,
  isFrontWarpQueue,
  incrementFrontWarpGuard,
  isFrontRateLimitElevated,
} from "./frontWarpSettings";
import { recordHandlerDuration, incrementDedupeHits, recordApplyTargetDuration, getStaleLeaseExhaustionMetrics } from "./pipelineObservability";
import { pipelineLog } from "./pipelineLogger";
import { PERF } from "../perfConfig";
import { mapRowToJob as _mapRowToJob, enqueueToQueue, dequeueFromQueue, listEligibleQueueNamesForClass, recoverStaleLeases as sharedRecoverStaleLeases } from "./workQueueLease";
import { isQueuePaused, canDispatchQueueNow, recordQueueDispatch, ensureQueueDrainStateLoaded } from "./queueDrainControl";
import { getLeaseCutoffMs } from "./staleLeaseThresholds";
import { getQueueTimings, DEFAULT_QUEUE_TIMINGS } from "./queueTimingSettings";
import { classifyWorkQueueError } from "./workQueueErrorClassifier";
import { getMaxProcessingMs } from "./queueMaxProcessing";

import { randomUUID } from "crypto";
const BOOT_ID = randomUUID();
const LEASE_OWNER = `scheduler-${process.pid}-${BOOT_ID}`;

export { mapRowToJob } from "./workQueueLease";

type JobHandler = (job: WorkQueueJob) => Promise<{ cursor?: string } | void>;

const handlers = new Map<string, JobHandler>();
let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;
let isShuttingDown = false;
let lastSchedulerCycleAt: Date | null = null;
let schedulerCycleCount = 0;

// Task #1048: keyed by `${jobId}:${leasedAtMs}` ("lease key") rather
// than jobId alone. After a job's lease is reclaimed and the row is
// re-dequeued (potentially by this same scheduler instance) the new
// attempt has a fresh leasedAt and therefore a distinct key. Without
// this, the original handler's `trackJobEnd(jobId, ...)` would clear
// the new attempt's heartbeat timer and silently disable it.
const activeJobHeartbeats = new Map<string, ReturnType<typeof setTimeout>>();

function leaseKey(jobId: string, leasedAtMs: number): string {
  return `${jobId}:${leasedAtMs}`;
}

const consecutiveSkips: Record<WorkloadClass, number> = {
  interactive: 0,
  interactive_repair: 0,
  ingestion: 0,
  // Task #1829 — `front_ingestion` is owned by the fast-poll timer
  // (see `frontWarpFastPollCycle`), not the main scheduler loop. The
  // skip counter is kept in the map so `Record<WorkloadClass, number>`
  // stays exhaustive; the main loop never reads it.
  front_ingestion: 0,
  repair: 0,
  maintenance: 0,
};
const MAX_SKIP_CYCLES = 3;

const activeSchedulerJobs = new Set<string>();

const starvationWarningCooldowns = new Map<string, number>();
// Hardcoded: this controls log-noise dedup for starvation warnings, not job behavior.
// 5 minutes is comfortably below the starvation age threshold and not workload-sensitive.
const STARVATION_COOLDOWN_MS = 300_000;

const latestStarvationWarnings: Array<{ jobId: string; queueName: string; ageMs: number; detectedAt: number }> = [];

function tryAcquireSlot(cls: WorkloadClass): boolean {
  return acquireClassSlot(`scheduler:${cls}`);
}

function releaseSlot(cls: WorkloadClass): void {
  releaseClassSlot(`scheduler:${cls}`);
}

function trackJobStart(jobId: string): void {
  activeSchedulerJobs.add(jobId);
}

function trackJobEnd(jobId: string, cls: WorkloadClass): void {
  activeSchedulerJobs.delete(jobId);
  releaseSlot(cls);
  // Heartbeat timers are now cleared inside processJobInner's finally
  // block via stopHeartbeat(leaseKey) — see Task #1048 note above. We
  // intentionally do NOT touch activeJobHeartbeats here, because at this
  // point the row may already have been reclaimed and a NEW attempt may
  // be running with the same jobId (different leaseKey).
}

function stopHeartbeat(key: string): void {
  const timer = activeJobHeartbeats.get(key);
  if (timer) {
    clearTimeout(timer);
    activeJobHeartbeats.delete(key);
  }
}

async function performHeartbeatTick(
  jobId: string,
  queueName: string | undefined,
  heartbeatStartMs: number,
  key: string,
): Promise<{ aborted: boolean; reason?: string }> {
  // Task #913C: heartbeat ticks fire on a setTimeout chain that lives
  // outside the per-job `withDbAttribution` scope, so without a wrapper
  // every scheduler heartbeat lands as `unknown` on the worker pool.
  const heartbeatLabel = `worker:${queueName ?? "scheduler"}:heartbeat`;
  try {
    const [leaseCutoffMs, maxProcessingMs] = await Promise.all([
      getLeaseCutoffMs(),
      getMaxProcessingMs(queueName ?? ""),
    ]);
    const elapsedMs = Date.now() - heartbeatStartMs;
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
              eq(workQueue.leasedAt, new Date(heartbeatStartMs)),
            ),
          ),
      );
      workerLog({
        worker: "scheduler",
        event: "max_processing_exceeded",
        jobId,
        queueName: queueName ?? null,
        elapsedMs,
        maxProcessingMs,
      });
      // Stop heartbeating so the lease sweeper reclaims this row. The
      // handler may still be running in the background; the terminal
      // updates in processJobInner are now lease-guarded so they won't
      // clobber whatever the next attempt does with the row.
      stopHeartbeat(key);
      return { aborted: true, reason: "max_processing_exceeded" };
    }
    await withDbAttribution(heartbeatLabel, () =>
      workerDb.update(workQueue)
        .set({
          heartbeatAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + leaseCutoffMs),
        })
        .where(
          and(
            eq(workQueue.id, jobId),
            eq(workQueue.status, "processing"),
            eq(workQueue.leasedAt, new Date(heartbeatStartMs)),
          ),
        ),
    );
    workerLog({ worker: "scheduler", event: "job_heartbeat", jobId });
    return { aborted: false };
  } catch (err) {
    console.error(`[WorkScheduler] Heartbeat failed for job ${jobId}:`, err);
    return { aborted: false };
  }
}

function startHeartbeat(jobId: string, queueName?: string, leasedAtMs?: number): string {
  const heartbeatStartMs = leasedAtMs ?? Date.now();
  // Task #1048: every heartbeat lifecycle is keyed by lease attempt so
  // two attempts for the same jobId can coexist without clobbering each
  // other's timers.
  const key = leaseKey(jobId, heartbeatStartMs);
  // Task #1048: cap total processing time per queue so a hung handler whose
  // heartbeat keeps firing can no longer extend its lease forever. Once the
  // queue's max-processing window is exceeded we set lease_expires_at = now,
  // log `max_processing_exceeded`, and stop the heartbeat — the next
  // recoverStaleLeases sweep will reclaim the row.
  const tick = async () => {
    if (!activeJobHeartbeats.has(key)) return;
    const result = await performHeartbeatTick(jobId, queueName, heartbeatStartMs, key);
    if (result.aborted) return;
    if (!activeJobHeartbeats.has(key)) return;
    const { heartbeatIntervalMs } = await getQueueTimings();
    const timer = setTimeout(tick, heartbeatIntervalMs);
    activeJobHeartbeats.set(key, timer);
  };
  // Seed with a placeholder timer so stopHeartbeat's clearTimeout call is always valid.
  // The first real interval is read from current settings (with default fallback on error).
  const seed = setTimeout(async () => {
    let delay = DEFAULT_QUEUE_TIMINGS.heartbeatIntervalMs;
    try {
      delay = (await getQueueTimings()).heartbeatIntervalMs;
    } catch {}
    if (!activeJobHeartbeats.has(key)) return;
    const t = setTimeout(tick, delay);
    activeJobHeartbeats.set(key, t);
  }, 0);
  activeJobHeartbeats.set(key, seed);
  return key;
}

const recentCompletions: Array<{ jobId: string; queueName: string; workloadClass: string; completedAt: Date; durationMs: number; status: "completed" | "failed" }> = [];
const MAX_RECENT = 50;

/**
 * Test seams (Task #1056): expose the heartbeat-tick body and the
 * active-heartbeat map so the stuck-job recovery regression test can
 * deterministically exercise the "max_processing_exceeded" branch
 * without standing up the scheduler loop or waiting for the real
 * heartbeat interval (min 5s).
 */
export async function _performHeartbeatTickForTests(
  jobId: string,
  queueName: string | undefined,
  heartbeatStartMs: number,
  key: string,
): Promise<{ aborted: boolean; reason?: string }> {
  return performHeartbeatTick(jobId, queueName, heartbeatStartMs, key);
}

export function _seedActiveHeartbeatForTests(key: string): void {
  // The production tick aborts immediately if the key is missing from
  // the active map, so tests must seed a placeholder timer (cleared
  // either by stopHeartbeat on the abort branch or by the test cleanup).
  const placeholder = setTimeout(() => {}, 60_000);
  activeJobHeartbeats.set(key, placeholder);
}

export function _clearActiveHeartbeatForTests(key: string): void {
  const t = activeJobHeartbeats.get(key);
  if (t) clearTimeout(t);
  activeJobHeartbeats.delete(key);
}

export function _hasActiveHeartbeatForTests(key: string): boolean {
  return activeJobHeartbeats.has(key);
}

export function registerHandler(queueName: string, handler: JobHandler): void {
  handlers.set(queueName, handler);
}

export function isHandlerRegistered(queueName: string): boolean {
  return handlers.has(queueName);
}

export function getRegisteredHandlerNames(): string[] {
  return Array.from(handlers.keys()).sort();
}

/**
 * Test seam (Task #988 Phase 7): exposes the registered handler for a
 * queue name so regression tests can invoke real production handlers
 * directly (e.g. to verify the kill-switch abort cursor contract)
 * without standing up the full scheduler loop. Returns `undefined`
 * when no handler is registered for the queue.
 */
export function getRegisteredHandler(
  queueName: string,
): JobHandler | undefined {
  return handlers.get(queueName);
}

/**
 * Task #978 (Phase 1): startup safety check. Called from the bootstrap
 * path *before* `startScheduler()` so that if a required handler was
 * forgotten — typically from a deferred / dynamic-import registration
 * path — the operator sees a single loud error instead of a flood of
 * `No handler registered` failures as the scheduler starts claiming
 * jobs. This is intentionally a warn-and-continue (rather than a hard
 * `process.exit`) so a single missing handler does not take the whole
 * app down; the alert + zero-throughput on that queue is enough signal.
 */
export function assertRequiredHandlersRegistered(required: string[]): {
  ok: boolean;
  missing: string[];
  registered: string[];
} {
  const registered = getRegisteredHandlerNames();
  const missing = required.filter((q) => !handlers.has(q));
  if (missing.length > 0) {
    console.error(
      `[WorkScheduler] STARTUP ASSERT FAILED — required queue handlers not registered: ${missing.join(", ")}`,
    );
    console.error(
      `[WorkScheduler] Currently registered (${registered.length}): ${registered.join(", ")}`,
    );
    workerLog({
      worker: "scheduler",
      event: "required_handlers_missing",
      workloadClass: "maintenance",
      missing,
      registeredCount: registered.length,
    });
  } else {
    console.log(
      `[WorkScheduler] Required handlers registered (${required.length}/${required.length}): ${required.join(", ")}`,
    );
  }
  return { ok: missing.length === 0, missing, registered };
}

// Task #897 Phase 0: producer-side throttle for the missing-handler
// warning. A loud log on every enqueue would itself become noise during
// a feature-flag misconfiguration; one warning per queue per minute is
// enough to surface the problem without flooding logs.
const missingHandlerWarnCooldowns = new Map<string, number>();
const MISSING_HANDLER_WARN_COOLDOWN_MS = 60_000;

function warnMissingHandlerOnce(queueName: string): void {
  const now = Date.now();
  const last = missingHandlerWarnCooldowns.get(queueName);
  if (last && now - last < MISSING_HANDLER_WARN_COOLDOWN_MS) return;
  missingHandlerWarnCooldowns.set(queueName, now);
  console.warn(
    `[WorkScheduler] enqueueJob: queue "${queueName}" has no registered handler. ` +
    `Jobs will accumulate as failed at dequeue time. Check feature flags / handler wiring.`,
  );
  workerLog({
    worker: queueName,
    event: "enqueue_missing_handler",
  });
}

export async function enqueueJob(params: {
  queueName: string;
  workloadClass: WorkloadClass;
  priority?: number;
  payload?: Record<string, unknown>;
  cursor?: string;
  maxAttempts?: number;
  retryAt?: Date;
  dedupeKey?: string;
}): Promise<string> {
  // Task #897 Phase 0: containment guard. If the queue has no handler
  // registered (most common cause: a feature flag like
  // SEMRUSH_REPORT_REFRESH_ENABLED is false at boot but a producer is
  // still enqueueing), surface a throttled warning at enqueue time so
  // the misconfiguration is observable before the job pile grows. We
  // intentionally do NOT block the enqueue: the durable pipeline still
  // wants the work recorded and a flag flip can recover it.
  if (!handlers.has(params.queueName)) {
    warnMissingHandlerOnce(params.queueName);
  }

  // Task #1829 — Front pipeline warp-speed routing. When the master
  // switch is ON, route new enqueues for the three Front pipeline
  // queues to the dedicated `front_ingestion` workload class so the
  // fast-poll timer can multi-dispatch them. When OFF (the default),
  // the original `workloadClass` is preserved verbatim, so the deploy
  // is behavior-neutral. This is intentionally a non-throwing remap:
  // if the caller passes a non-front queue with class `front_ingestion`
  // we leave it alone (no validation), because the only writer of
  // `front_ingestion` is this remap.
  const effectiveParams =
    isFrontWarpQueue(params.queueName) &&
    isPoolEpicSwitchEnabled("front_warp_speed_enabled")
      ? { ...params, workloadClass: "front_ingestion" as WorkloadClass }
      : params;

  const result = await enqueueToQueue(effectiveParams);

  if (result.inserted) {
    workerLog({
      worker: params.queueName,
      event: "job_enqueued",
      workloadClass: effectiveParams.workloadClass,
      priority: params.priority ?? 100,
      jobId: result.id,
    });

    pipelineLog({
      event: "event_received",
      sourceSystem: params.queueName,
      sourceEventType: effectiveParams.workloadClass,
      dedupeKey: params.dedupeKey,
      sourceEventId: result.id,
    });
  } else if (params.dedupeKey) {
    incrementDedupeHits("workQueue");
    pipelineLog({
      event: "duplicate_ignored",
      sourceSystem: params.queueName,
      sourceEventType: effectiveParams.workloadClass,
      dedupeKey: params.dedupeKey,
      outcome: "dedupe_hit",
    });
  }

  return result.id;
}

/**
 * Task #986: per-queue fairness within a workload class. Without this,
 * `dequeueFromQueue` orders by `(priority ASC, created_at ASC)`, which
 * means a queue with 2,200 old pending jobs (e.g. retroactive_reprocess)
 * always wins over a sibling queue at the same priority/class with
 * fewer or newer jobs. We now:
 *   1. Cheaply enumerate the queue names with eligible work in this class.
 *   2. Filter out paused queues and queues over their per-minute rate cap (#987).
 *   3. Pick the queue with the oldest last-dispatch timestamp (round-robin).
 *   4. Dequeue scoped to that single queue name.
 * If the round-robin pick races with another worker and produces no
 * job, fall back to the unrestricted dequeue so we don't artificially
 * idle. The in-memory cursor map survives the process; on restart
 * everyone starts from epoch which is fine — no queue is *worse* off
 * than under the old behavior.
 */
const lastDispatchByQueue = new Map<string, number>();

/**
 * Task #986 (Phase 4 follow-up): operator-visible per-queue dispatch
 * counters. `cycleDispatchCounts` is reset at the end of every
 * scheduler cycle so the summary log line shows exactly what was
 * dispatched in that tick (typically 0–N where N is the number of
 * owned workload classes; the scheduler dispatches at most one job
 * per class per cycle). `windowDispatchCounts` accumulates over
 * `DISPATCH_SUMMARY_WINDOW_CYCLES` cycles so the metric surface in
 * `getSchedulerStatus` reflects a longer rolling view that operators
 * can use to verify that round-robin is actually rotating across
 * queues — a queue that never appears here under load is starving.
 */
const cycleDispatchCounts = new Map<string, number>();
const windowDispatchCounts = new Map<string, number>();
let windowDispatchCycleCount = 0;
const DISPATCH_SUMMARY_WINDOW_CYCLES = 60;
let lastWindowSnapshot: { capturedAt: string; cycleCount: number; counts: Record<string, number> } = {
  capturedAt: new Date(0).toISOString(),
  cycleCount: 0,
  counts: {},
};
/**
 * Task #1010: bounded ring buffer of the last
 * `RECENT_WINDOW_HISTORY_SIZE` completed window snapshots, used to
 * render a per-queue sparkline on the work-queue admin page so
 * intermittent starvation is easier to spot than a single
 * before/after pair.
 *
 * Task #1020: snapshots are also persisted to `system_settings` under
 * `dispatch_window_history` so the buffer survives a redeploy/restart
 * — operators investigating starvation right after a deploy still see
 * the prior ~10 windows of context instead of an empty sparkline.
 */
const RECENT_WINDOW_HISTORY_SIZE = 10;
const DISPATCH_WINDOW_HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
const DISPATCH_WINDOW_HISTORY_SETTING_KEY = "dispatch_window_history";
const recentWindowHistory: Array<{ capturedAt: string; cycleCount: number; counts: Record<string, number> }> = [];

interface PersistedDispatchWindowHistory {
  snapshots: Array<{ capturedAt: string; cycleCount: number; counts: Record<string, number> }>;
}

async function loadPersistedDispatchWindowHistory(): Promise<void> {
  try {
    const { storage } = await import("../storage");
    const row = await storage.getSystemSetting(DISPATCH_WINDOW_HISTORY_SETTING_KEY);
    if (!row?.value) return;
    let parsed: PersistedDispatchWindowHistory | null = null;
    try {
      parsed = JSON.parse(row.value) as PersistedDispatchWindowHistory;
    } catch (err: any) {
      console.warn(`[WorkScheduler] Failed to parse persisted dispatch window history: ${err?.message}`);
      return;
    }
    if (!parsed || !Array.isArray(parsed.snapshots)) return;
    const cutoff = Date.now() - DISPATCH_WINDOW_HISTORY_RETENTION_MS;
    const fresh: Array<{ capturedAt: string; cycleCount: number; counts: Record<string, number> }> = [];
    for (const s of parsed.snapshots) {
      if (!s || typeof s.capturedAt !== "string") continue;
      const t = Date.parse(s.capturedAt);
      if (!Number.isFinite(t) || t < cutoff) continue;
      const counts: Record<string, number> = {};
      if (s.counts && typeof s.counts === "object") {
        for (const [k, v] of Object.entries(s.counts)) {
          if (typeof v === "number" && Number.isFinite(v)) counts[k] = v;
        }
      }
      fresh.push({
        capturedAt: s.capturedAt,
        cycleCount: typeof s.cycleCount === "number" ? s.cycleCount : 0,
        counts,
      });
    }
    fresh.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
    const tail = fresh.slice(-RECENT_WINDOW_HISTORY_SIZE);
    recentWindowHistory.splice(0, recentWindowHistory.length, ...tail);
    if (tail.length > 0) {
      lastWindowSnapshot = tail[tail.length - 1]!;
    }
    workerLog({
      worker: "scheduler",
      event: "dispatch_window_history_hydrated",
      hydrated: tail.length,
    });
    // Task #1020 (review follow-up): if hydration filtered anything out
    // (stale snapshots beyond retention, malformed entries, etc.) write
    // the cleaned tail back so the persisted row matches the in-memory
    // buffer instead of carrying drift until the next window completes.
    if (tail.length !== parsed.snapshots.length) {
      void persistDispatchWindowHistory();
    }
  } catch (err: any) {
    console.warn(`[WorkScheduler] Failed to load dispatch window history: ${err?.message}`);
  }
}

// Task #1020 (review follow-up): serialize concurrent persist calls so
// a slow DB write can't be overtaken by a fresher one and clobber the
// row with stale data. `pendingPersist` chains writes; `persistQueued`
// collapses any number of requests that arrive while one write is in
// flight into a single follow-up write that captures the latest tail.
let pendingPersist: Promise<void> | null = null;
let persistQueued = false;

async function persistDispatchWindowHistory(): Promise<void> {
  if (pendingPersist) {
    persistQueued = true;
    return pendingPersist;
  }
  pendingPersist = (async () => {
    try {
      do {
        persistQueued = false;
        const { storage } = await import("../storage");
        const cutoff = Date.now() - DISPATCH_WINDOW_HISTORY_RETENTION_MS;
        const snapshots = recentWindowHistory
          .filter((s) => {
            const t = Date.parse(s.capturedAt);
            return Number.isFinite(t) && t >= cutoff;
          })
          .slice(-RECENT_WINDOW_HISTORY_SIZE)
          .map((s) => ({
            capturedAt: s.capturedAt,
            cycleCount: s.cycleCount,
            counts: { ...s.counts },
          }));
        const payload: PersistedDispatchWindowHistory = { snapshots };
        await storage.setSystemSetting(
          DISPATCH_WINDOW_HISTORY_SETTING_KEY,
          JSON.stringify(payload),
          // No updatedBy: this is a background-scheduler write, not a user
          // action. Passing a synthetic marker like "scheduler" violates
          // the system_settings.updated_by → users.id FK.
        );
      } while (persistQueued);
    } catch (err: any) {
      console.warn(`[WorkScheduler] Failed to persist dispatch window history: ${err?.message}`);
    } finally {
      pendingPersist = null;
    }
  })();
  return pendingPersist;
}

function recordCycleDispatch(queueName: string): void {
  cycleDispatchCounts.set(queueName, (cycleDispatchCounts.get(queueName) ?? 0) + 1);
  windowDispatchCounts.set(queueName, (windowDispatchCounts.get(queueName) ?? 0) + 1);
}

async function dequeueForClass(cls: WorkloadClass): Promise<WorkQueueJob | null> {
  const leaseCutoffMs = await getLeaseCutoffMs();
  const eligible = await listEligibleQueueNamesForClass(cls);
  const allowed: string[] = [];
  const drainedSkips: string[] = [];
  for (const name of eligible) {
    if (isQueuePaused(name) || !canDispatchQueueNow(name)) {
      drainedSkips.push(name);
      continue;
    }
    allowed.push(name);
  }

  // Surface drain decisions so operators can correlate "queue paused"
  // with "no jobs running". One log per cycle per skipped queue is
  // bounded — eligibleQueues is capped at 32.
  for (const name of drainedSkips) {
    workerLog({
      worker: `scheduler:${cls}`,
      event: "queue_dispatch_skipped_drain",
      workloadClass: cls,
      queueName: name,
      reason: isQueuePaused(name) ? "paused" : "rate_limited",
    });
  }

  let job: WorkQueueJob | null = null;
  if (allowed.length > 0) {
    allowed.sort((a, b) => {
      const aT = lastDispatchByQueue.get(a) ?? 0;
      const bT = lastDispatchByQueue.get(b) ?? 0;
      return aT - bT;
    });
    const pick = allowed[0]!;
    job = await dequeueFromQueue(cls, LEASE_OWNER, leaseCutoffMs, { queueName: pick });
    if (job) {
      lastDispatchByQueue.set(pick, Date.now());
      recordQueueDispatch(pick);
      recordCycleDispatch(pick);
      workerLog({
        worker: `scheduler:${cls}`,
        event: "queue_fairness_dispatched",
        workloadClass: cls,
        queueName: pick,
        jobId: job.id,
        eligibleCount: allowed.length,
      });
    }
  }

  // Fallback: if the per-queue pick raced and lost, do an unrestricted
  // dequeue but still honor drain skips by excluding paused/rate-capped
  // queues. This keeps throughput up under contention without
  // bypassing the operator drain controls.
  if (!job) {
    job = await dequeueFromQueue(cls, LEASE_OWNER, leaseCutoffMs, {
      excludeQueueNames: drainedSkips,
    });
    if (job) {
      lastDispatchByQueue.set(job.queueName, Date.now());
      recordQueueDispatch(job.queueName);
      recordCycleDispatch(job.queueName);
    }
  }

  if (job) {
    workerLog({ worker: `scheduler:${cls}`, event: "job_leased", jobId: job.id, workloadClass: cls });
  }
  return job;
}

async function processJob(job: WorkQueueJob): Promise<void> {
  // Task #897 Phase 4: wrap the entire scheduler-side execution of a job
  // in a stable per-queue DB hold label. Previously the lease update,
  // heartbeats, completion update, and any DB checkout the handler
  // performs without its own `withDbHoldLabel` wrapper inherited the
  // ambient `unknown` label — which made `unknown` the dominant top
  // hold offender on the worker pool. Inner handlers are still free to
  // refine the label via `withDbHoldLabel("…:substep", …)` for
  // sub-attribution; the substep label takes precedence inside its scope.
  return withDbHoldLabel(`worker:${job.queueName}`, () => processJobInner(job));
}

async function processJobInner(job: WorkQueueJob): Promise<void> {
  const handler = handlers.get(job.queueName);
  if (!handler) {
    const errMsg = `No handler registered for queue "${job.queueName}"`;
    await workerDb.update(workQueue)
      .set({ status: "failed", errorMessage: errMsg, completedAt: new Date() })
      .where(eq(workQueue.id, job.id));
    workerLog({ worker: job.queueName, event: "job_failed", jobId: job.id, error: errMsg, workloadClass: job.workloadClass });
    return;
  }

  const procNow = new Date();
  const leaseCutoffMs = await getLeaseCutoffMs();
  await workerDb.update(workQueue)
    .set({
      status: "processing",
      leasedAt: procNow,
      leaseOwner: LEASE_OWNER,
      leaseExpiresAt: new Date(procNow.getTime() + leaseCutoffMs),
      heartbeatAt: procNow,
    })
    .where(eq(workQueue.id, job.id));

  const heartbeatKey = startHeartbeat(job.id, job.queueName, procNow.getTime());

  workerLog({ worker: job.queueName, event: "job_leased", jobId: job.id, workloadClass: job.workloadClass });
  pipelineLog({
    event: "ready_to_apply",
    sourceSystem: job.queueName,
    sourceEventType: job.workloadClass,
    sourceEventId: job.id,
  });
  const startTime = Date.now();

  // Task #1048: lease-ownership guard for all terminal updates. If
  // `startHeartbeat` aborted us due to `max_processing_exceeded` (or
  // any other reclaim path fired), the row's lease_owner / leased_at
  // will have moved on. Guarding every terminal write prevents a stale,
  // overrun handler from clobbering a row that was already requeued
  // (which would silently drop the new attempt's progress / retry).
  const leaseGuard = and(
    eq(workQueue.id, job.id),
    eq(workQueue.status, "processing"),
    eq(workQueue.leaseOwner, LEASE_OWNER),
    eq(workQueue.leasedAt, procNow),
  );

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

    workerLog({ worker: job.queueName, event: "job_completed", jobId: job.id, durationMs });
    recordHandlerDuration(job.queueName, durationMs);
    recordApplyTargetDuration(job.queueName, durationMs);
    pipelineLog({
      event: "applied",
      sourceSystem: job.queueName,
      sourceEventType: job.workloadClass,
      sourceEventId: job.id,
      durationMs,
      outcome: "success",
    });
    trackCompletion(job, durationMs, "completed");
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    const nextAttempt = (job.attemptCount ?? 0) + 1;

    // Task #1050: classify the failure into a small enum so dead-letter
    // rows can be triaged without re-reading every freeform message.
    // Stored on `work_queue.error_code`; populated for both retries and
    // dead-letter terminal transitions so the rolling failure mix is
    // queryable per queue.
    const errorCode = classifyWorkQueueError(err);

    if (nextAttempt >= job.maxAttempts) {
      const updated = await workerDb.update(workQueue)
        .set({
          status: "dead_letter",
          errorMessage: errMsg,
          errorCode,
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
          errorCode,
          workloadClass: job.workloadClass,
        });
        return;
      }

      workerLog({ worker: job.queueName, event: "job_failed", jobId: job.id, durationMs, error: errMsg, errorCode, attemptCount: nextAttempt, workloadClass: job.workloadClass });
      recordHandlerDuration(job.queueName, durationMs);
      pipelineLog({
        event: "failed",
        sourceSystem: job.queueName,
        sourceEventType: job.workloadClass,
        sourceEventId: job.id,
        durationMs,
        outcome: "dead_lettered",
        errorMessage: errMsg,
      });
      workerLog({ worker: job.queueName, event: "job_dead_lettered", jobId: job.id, durationMs, error: errMsg, errorCode, attemptCount: nextAttempt, maxAttempts: job.maxAttempts });
      trackCompletion(job, durationMs, "failed");
    } else {
      const { baseBackoffMs, maxBackoffMs } = await getQueueTimings();
      const backoff = Math.min(baseBackoffMs * Math.pow(2, nextAttempt - 1), maxBackoffMs);
      const retryAt = new Date(Date.now() + backoff);

      const updated = await workerDb.update(workQueue)
        .set({
          status: "pending",
          errorMessage: errMsg,
          errorCode,
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
          errorCode,
          workloadClass: job.workloadClass,
        });
        return;
      }

      workerLog({ worker: job.queueName, event: "job_failed", jobId: job.id, durationMs, error: errMsg, errorCode, attemptCount: nextAttempt, workloadClass: job.workloadClass });
      recordHandlerDuration(job.queueName, durationMs);
      pipelineLog({
        event: "failed",
        sourceSystem: job.queueName,
        sourceEventType: job.workloadClass,
        sourceEventId: job.id,
        durationMs,
        outcome: "retrying",
        errorMessage: errMsg,
      });
      workerLog({ worker: job.queueName, event: "job_retrying", jobId: job.id, errorCode, attemptCount: nextAttempt, retryAt: retryAt.toISOString() });
    }
  } finally {
    // Task #1048: clear THIS attempt's heartbeat by lease key. If the
    // row was reclaimed mid-flight and a new attempt is already running
    // with the same jobId, that new attempt's heartbeat lives under a
    // different key and is left untouched.
    stopHeartbeat(heartbeatKey);
  }
}

function trackCompletion(job: WorkQueueJob, durationMs: number, status: "completed" | "failed"): void {
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
    source: "scheduler",
    // Task #1048: only exclude jobs that still have an active heartbeat
    // lease key. We deliberately do NOT union activeSchedulerJobs here:
    // a hung handler stays in activeSchedulerJobs forever (it's only
    // cleared when the handler returns), which would prevent stale-lease
    // recovery for the very case this task exists to fix. Once the
    // heartbeat is stopped (either on max_processing_exceeded or any
    // other completion path), the job becomes eligible for reclaim — and
    // the lease-guarded terminal writes in processJobInner ensure a
    // still-running handler can't clobber the reclaimed row's state.
    excludeJobIds: [
      ...new Set([...activeJobHeartbeats.keys()].map((k) => k.split(":")[0])),
    ],
    emitReleasedPipelineLog: true,
  });
}

function getSchedulerOwnedClasses(): WorkloadClass[] {
  if (PERF.REPAIR_DISPATCHER_ENABLED) {
    return ["interactive", "ingestion"];
  }
  return ["interactive", "ingestion", "interactive_repair", "repair", "maintenance"];
}

function buildFairClassOrder(): WorkloadClass[] {
  const baseOrder = getSchedulerOwnedClasses();

  const starvedClasses = baseOrder.filter(cls => consecutiveSkips[cls] >= MAX_SKIP_CYCLES);
  if (starvedClasses.length === 0) return baseOrder;

  const promoted = starvedClasses.sort((a, b) => consecutiveSkips[b] - consecutiveSkips[a]);
  const remaining = baseOrder.filter(cls => !starvedClasses.includes(cls));
  return [...promoted, ...remaining];
}

async function checkStarvation(): Promise<void> {
  try {
    const thresholdMs = PERF.STARVATION_AGE_THRESHOLD_MS;
    const cutoff = new Date(Date.now() - thresholdMs);
    const starvedJobs = await workerDb
      .select({
        id: workQueue.id,
        queueName: workQueue.queueName,
        createdAt: workQueue.createdAt,
      })
      .from(workQueue)
      .where(
        and(
          eq(workQueue.workloadClass, "repair"),
          eq(workQueue.status, "pending"),
          lte(workQueue.createdAt, cutoff),
          or(
            isNull(workQueue.retryAt),
            lte(workQueue.retryAt, new Date()),
          ),
        ),
      )
      .orderBy(asc(workQueue.createdAt))
      .limit(10);

    const now = Date.now();
    latestStarvationWarnings.length = 0;
    for (const j of starvedJobs) {
      const ageMs = now - j.createdAt.getTime();
      latestStarvationWarnings.push({ jobId: j.id, queueName: j.queueName, ageMs, detectedAt: now });

      const lastWarned = starvationWarningCooldowns.get(j.id);
      if (!lastWarned || now - lastWarned >= STARVATION_COOLDOWN_MS) {
        workerLog({
          worker: j.queueName,
          event: "starvation_warning",
          jobId: j.id,
          ageMs,
          thresholdMs,
          workloadClass: "repair",
        });
        starvationWarningCooldowns.set(j.id, now);
      }
    }

    for (const [jobId, ts] of starvationWarningCooldowns) {
      if (now - ts > STARVATION_COOLDOWN_MS * 2) {
        starvationWarningCooldowns.delete(jobId);
      }
    }

    // Task #836 Phase 6: stuck-job recovery for `retroactive_reprocess`
    // and any other repair queue. Pending jobs older than
    // `STUCK_JOB_MAX_AGE_MS` (default 24h) are considered abandoned —
    // they are typically the result of a `retry_at` clock that drifted
    // far into the future after a transient error or a scheduler
    // restart that interrupted exponential backoff bookkeeping. We
    // null out `retry_at` to make the job immediately re-eligible for
    // dequeue and emit an escalation log line at most once per
    // `STUCK_JOB_ESCALATION_INTERVAL_MS` per job so operators see a
    // bounded, actionable signal instead of a continuous spam.
    await recoverStuckPendingJobs(now);
  } catch (err) {
    console.error("[WorkScheduler] Starvation check error:", err);
  }
}

// Task #836 Phase 6: per-job escalation log throttle.
const stuckEscalationCooldowns = new Map<string, number>();

// Exported for tests (Task #836 Phase 6) so the recovery logic can be
// exercised against the test sandbox without spinning the full
// scheduler loop.
export async function recoverStuckPendingJobs(now: number): Promise<void> {
  try {
    const maxAgeMs = PERF.STUCK_JOB_MAX_AGE_MS;
    const escalationIntervalMs = PERF.STUCK_JOB_ESCALATION_INTERVAL_MS;
    const cutoff = new Date(now - maxAgeMs);

    const stuckJobs = await workerDb
      .select({
        id: workQueue.id,
        queueName: workQueue.queueName,
        workloadClass: workQueue.workloadClass,
        createdAt: workQueue.createdAt,
        retryAt: workQueue.retryAt,
      })
      .from(workQueue)
      .where(
        and(
          eq(workQueue.status, "pending"),
          lte(workQueue.createdAt, cutoff),
        ),
      )
      .orderBy(asc(workQueue.createdAt))
      .limit(20);

    for (const j of stuckJobs) {
      const ageMs = now - j.createdAt.getTime();
      const lastEscalated = stuckEscalationCooldowns.get(j.id);
      if (lastEscalated && now - lastEscalated < escalationIntervalMs) continue;

      // Only auto-clear `retry_at` when it is set far in the future.
      // A null retry_at means the job is dequeue-eligible already and
      // the issue is elsewhere (e.g. slot starvation, kill switch).
      const retryAt = j.retryAt ? j.retryAt.getTime() : null;
      const retryFarFuture = retryAt !== null && retryAt - now > 60_000;
      if (retryFarFuture) {
        try {
          await workerDb
            .update(workQueue)
            .set({ retryAt: null })
            .where(eq(workQueue.id, j.id));
          workerLog({
            worker: j.queueName,
            event: "stuck_job_requeued",
            jobId: j.id,
            ageMs,
            workloadClass: j.workloadClass,
            previousRetryAt: j.retryAt?.toISOString(),
          });
        } catch (err) {
          console.error("[WorkScheduler] Failed to clear retry_at for stuck job", j.id, err);
        }
      }

      workerLog({
        worker: j.queueName,
        event: "stuck_job_escalation",
        jobId: j.id,
        ageMs,
        workloadClass: j.workloadClass,
        retryAtClearedToNull: retryFarFuture,
      });
      stuckEscalationCooldowns.set(j.id, now);
    }

    // Trim stale entries so the map can't grow unbounded.
    for (const [id, ts] of stuckEscalationCooldowns) {
      if (now - ts > escalationIntervalMs * 4) stuckEscalationCooldowns.delete(id);
    }
  } catch (err) {
    console.error("[WorkScheduler] Stuck job recovery failed:", err);
  }
}

async function schedulerCycle(): Promise<void> {
  // Task #913C: wrap the entire scheduler tick in a `scheduler:` label
  // so the lease-recovery sweep, starvation check, and per-class
  // dequeue probes don't accumulate as `unknown` worker holds.
  //
  // Task #1729 Phase 2.1 — when tenancy enforcement is on, additionally
  // pin the whole tick to the worker pool. Default OFF preserves the
  // historical (api-pool-default) behavior.
  const run = () =>
    withDbAttribution("scheduler:work-scheduler", schedulerCycleImpl);
  if (isPoolEpicSwitchEnabled("db_pool_tenancy_enforcement_enabled")) {
    return runWithWorkerDb(run);
  }
  return run();
}

async function schedulerCycleImpl(): Promise<void> {
  if (isRunning || isShuttingDown) return;
  isRunning = true;

  try {
    await recoverStaleLeases();
    await checkStarvation();

    const classOrder = buildFairClassOrder();
    const processedClasses = new Set<WorkloadClass>();

    for (const cls of classOrder) {
      const wc = cls as WorkloadClass;
      if (!tryAcquireSlot(wc)) {
        consecutiveSkips[cls]++;
        processedClasses.add(wc);
        continue;
      }

      const job = await dequeueForClass(wc);
      if (!job) {
        releaseSlot(wc);
        consecutiveSkips[cls]++;
        processedClasses.add(wc);
        continue;
      }

      trackJobStart(job.id);
      consecutiveSkips[cls] = 0;
      processedClasses.add(wc);

      // fire-and-forget: concurrent dispatch by design; processJob marks the
      // job failed/completed itself and never rejects past its own handling.
      void processJob(job).finally(() => {
        trackJobEnd(job.id, wc);
      });
    }

    // Task #1025: per-cycle drain-extra pass for `retroactive_reprocess`.
    // Mirrors the equivalent block in the repair dispatcher. Only runs
    // when the scheduler owns the `repair` class (i.e.
    // REPAIR_DISPATCHER_ENABLED=false) — otherwise the dispatcher is
    // already draining and a parallel scheduler drain would
    // double-count slots. See `getSchedulerOwnedClasses()` for the
    // ownership rule.
    if (!PERF.REPAIR_DISPATCHER_ENABLED) {
      const leaseCutoffMs = await getLeaseCutoffMs();
      const extra = Math.max(0, PERF.RETROACTIVE_REPROCESS_CONCURRENCY - 1);
      for (let i = 0; i < extra; i++) {
        if (!tryAcquireSlot("repair")) break;
        const job = await dequeueFromQueue(
          "repair",
          LEASE_OWNER,
          leaseCutoffMs,
          { queueName: "retroactive_reprocess" },
        );
        if (!job) {
          releaseSlot("repair");
          break;
        }
        trackJobStart(job.id);
        recordCycleDispatch(job.queueName);
        void processJob(job).finally(() => trackJobEnd(job.id, "repair")); // fire-and-forget dispatch
      }
    }
  } catch (err) {
    console.error("[WorkScheduler] Scheduler cycle error:", err);
  } finally {
    isRunning = false;
    lastSchedulerCycleAt = new Date();
    schedulerCycleCount++;
    emitDispatchCountersForCycle();
  }
}

/**
 * Task #986 (Phase 4 follow-up): emit per-cycle dispatch summary +
 * roll the windowed counters. Per-cycle log fires only when at least
 * one queue dispatched in the tick (otherwise the log is pure noise
 * during idle windows). The windowed snapshot resets every
 * DISPATCH_SUMMARY_WINDOW_CYCLES cycles regardless, so the metric
 * surface in `getSchedulerStatus` shows a fresh rolling window even
 * when activity is sparse.
 */
function emitDispatchCountersForCycle(): void {
  windowDispatchCycleCount++;
  if (cycleDispatchCounts.size > 0) {
    const counts: Record<string, number> = {};
    let total = 0;
    for (const [q, n] of cycleDispatchCounts) {
      counts[q] = n;
      total += n;
    }
    workerLog({
      worker: "scheduler",
      event: "scheduler_cycle_dispatch_summary",
      cycleCount: schedulerCycleCount,
      total,
      perQueue: counts,
    });
    cycleDispatchCounts.clear();
  }
  if (windowDispatchCycleCount >= DISPATCH_SUMMARY_WINDOW_CYCLES) {
    const counts: Record<string, number> = {};
    for (const [q, n] of windowDispatchCounts) counts[q] = n;
    lastWindowSnapshot = {
      capturedAt: new Date().toISOString(),
      cycleCount: windowDispatchCycleCount,
      counts,
    };
    recentWindowHistory.push(lastWindowSnapshot);
    if (recentWindowHistory.length > RECENT_WINDOW_HISTORY_SIZE) {
      recentWindowHistory.splice(0, recentWindowHistory.length - RECENT_WINDOW_HISTORY_SIZE);
    }
    windowDispatchCounts.clear();
    windowDispatchCycleCount = 0;
    // Task #1020: persist the updated ring buffer asynchronously so the
    // sparkline survives a restart. Fire-and-forget — failures are
    // logged inside the helper and must never block scheduler progress.
    void persistDispatchWindowHistory();
  }
}

/**
 * Task #986: operator-facing rolling per-queue dispatch counters.
 * Returns the in-progress window plus the most recently completed
 * window so a snapshot endpoint can show "what's happening now" and
 * "what just finished" without waiting up to a full window for the
 * first datapoint.
 */
export function getDispatchCountersSnapshot(): {
  currentWindow: { cycleCount: number; counts: Record<string, number> };
  lastWindow: { capturedAt: string; cycleCount: number; counts: Record<string, number> };
  recentWindows: Array<{ capturedAt: string; cycleCount: number; counts: Record<string, number> }>;
} {
  const current: Record<string, number> = {};
  for (const [q, n] of windowDispatchCounts) current[q] = n;
  return {
    currentWindow: { cycleCount: windowDispatchCycleCount, counts: current },
    lastWindow: lastWindowSnapshot,
    recentWindows: recentWindowHistory.map((w) => ({
      capturedAt: w.capturedAt,
      cycleCount: w.cycleCount,
      counts: { ...w.counts },
    })),
  };
}

async function ensureWorkQueueTable(): Promise<boolean> {
  try {
    await workerDb.execute(sql`SELECT 1 FROM work_queue LIMIT 0`);
    return true;
  } catch (err: any) {
    if (err?.code !== "42P01") throw err;
  }

  console.log("[WorkScheduler] work_queue table not found — creating...");
  try {
    const { sql: rawSql } = await import("drizzle-orm");
    await workerDb.execute(rawSql`
      CREATE TABLE IF NOT EXISTS work_queue (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        queue_name VARCHAR NOT NULL,
        job_type VARCHAR NOT NULL,
        workload_class VARCHAR NOT NULL,
        priority INTEGER NOT NULL DEFAULT 5,
        status VARCHAR NOT NULL DEFAULT 'pending',
        payload JSONB,
        payload_json JSONB,
        dedupe_key VARCHAR,
        cursor TEXT,
        cursor_json JSONB,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        retry_at TIMESTAMP,
        leased_at TIMESTAMP,
        lease_owner VARCHAR,
        lease_expires_at TIMESTAMP,
        heartbeat_at TIMESTAMP,
        error_code VARCHAR,
        error_message TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP
      )
    `);
    await workerDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_work_queue_status_class ON work_queue (status, workload_class)`);
    await workerDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_work_queue_queue_name ON work_queue (queue_name)`);
    await workerDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_work_queue_retry_at ON work_queue (retry_at)`);
    await workerDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_work_queue_priority ON work_queue (priority)`);
    await workerDb.execute(rawSql`CREATE INDEX IF NOT EXISTS idx_work_queue_lease_expires ON work_queue (lease_expires_at)`);
    await workerDb.execute(rawSql`CREATE UNIQUE INDEX IF NOT EXISTS wq_dedupe_key_idx ON work_queue (dedupe_key) WHERE dedupe_key IS NOT NULL AND status NOT IN ('completed', 'failed', 'dead_letter', 'cancelled')`);
    await workerDb.execute(rawSql`CREATE INDEX IF NOT EXISTS wq_status_retry_at_idx ON work_queue (status, retry_at)`);
    await workerDb.execute(rawSql`CREATE INDEX IF NOT EXISTS wq_class_status_priority_created_idx ON work_queue (workload_class, status, priority, created_at)`);
    console.log("[WorkScheduler] work_queue table created successfully");
    return true;
  } catch (createErr) {
    console.error("[WorkScheduler] Failed to create work_queue table:", createErr);
    return false;
  }
}

// Hardcoded: only consulted by one-shot startup cleanup to distinguish
// "zombie" leases (no heartbeat in 10min) from "recent orphan" leases.
// 10min sits comfortably above the default 5min lease cutoff and is not workload-sensitive.
const STALE_HEARTBEAT_THRESHOLD_MS = 10 * 60 * 1000;

export async function cleanupStaleJobsOnStartup(): Promise<void> {
  console.log(`[Bootstrap] Startup stale job cleanup — current owner: ${LEASE_OWNER}`);
  const now = new Date();
  const staleHeartbeatCutoff = new Date(now.getTime() - STALE_HEARTBEAT_THRESHOLD_MS);

  const zombieResult = await workerDb.execute(sql`
    WITH zombies AS (
      SELECT id, queue_name, workload_class, lease_owner AS prev_owner, heartbeat_at, attempt_count, max_attempts
      FROM work_queue
      WHERE status IN ('leased', 'processing')
        AND (lease_owner IS DISTINCT FROM ${LEASE_OWNER})
        AND (heartbeat_at IS NULL OR heartbeat_at < ${staleHeartbeatCutoff})
      FOR UPDATE SKIP LOCKED
    )
    UPDATE work_queue wq
    SET
      status = CASE WHEN zombies.attempt_count + 1 >= zombies.max_attempts THEN 'dead_letter' ELSE 'failed' END,
      error_message = 'startup_stale_recovery',
      error_code = 'startup_stale_recovery',
      attempt_count = zombies.attempt_count + 1,
      completed_at = ${now},
      updated_at = ${now}
    FROM zombies
    WHERE wq.id = zombies.id
    RETURNING zombies.id, zombies.queue_name, zombies.workload_class, zombies.prev_owner, zombies.heartbeat_at, zombies.attempt_count, zombies.max_attempts
  `);

  const zombies = zombieResult.rows as Array<{ id: string; queue_name: string; workload_class: string; prev_owner: string | null; heartbeat_at: string | null; attempt_count: number; max_attempts: number }>;
  if (zombies.length > 0) {
    const deadLettered = zombies.filter(z => z.attempt_count + 1 >= z.max_attempts);
    const failed = zombies.filter(z => z.attempt_count + 1 < z.max_attempts);
    console.log(`[Bootstrap] Marked ${zombies.length} zombie job(s) as terminal (${deadLettered.length} dead_letter, ${failed.length} failed; heartbeat older than ${STALE_HEARTBEAT_THRESHOLD_MS / 1000}s or missing):`);
    for (const job of zombies) {
      const terminalStatus = job.attempt_count + 1 >= job.max_attempts ? "dead_letter" : "failed";
      console.log(`  - job=${job.id} queue=${job.queue_name} class=${job.workload_class} prev_owner=${job.prev_owner ?? "(null)"} heartbeat=${job.heartbeat_at ?? "null"} attempts=${job.attempt_count} status=${terminalStatus}`);
      workerLog({ worker: "bootstrap", event: terminalStatus === "dead_letter" ? "zombie_job_dead_lettered" : "zombie_job_failed", jobId: job.id, queueName: job.queue_name, workloadClass: job.workload_class, reason: "startup_stale_recovery" });
      pipelineLog({
        event: "failed",
        sourceSystem: "bootstrap",
        sourceEventType: job.workload_class,
        sourceEventId: job.id,
        outcome: terminalStatus === "dead_letter" ? "startup_stale_dead_lettered" : "startup_stale_recovery",
        errorMessage: "startup_stale_recovery",
      });
    }
  }

  const recentResult = await workerDb.execute(sql`
    WITH recent_orphans AS (
      SELECT id, queue_name, workload_class, lease_owner AS prev_owner
      FROM work_queue
      WHERE status IN ('leased', 'processing')
        AND (lease_owner IS DISTINCT FROM ${LEASE_OWNER})
        AND heartbeat_at >= ${staleHeartbeatCutoff}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE work_queue wq
    SET
      status = 'pending',
      leased_at = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      heartbeat_at = NULL,
      updated_at = ${now}
    FROM recent_orphans
    WHERE wq.id = recent_orphans.id
    RETURNING recent_orphans.id, recent_orphans.queue_name, recent_orphans.workload_class, recent_orphans.prev_owner
  `);

  const recentOrphans = recentResult.rows as Array<{ id: string; queue_name: string; workload_class: string; prev_owner: string | null }>;
  if (recentOrphans.length > 0) {
    console.log(`[Bootstrap] Reset ${recentOrphans.length} recently-active orphan job(s) to pending:`);
    for (const job of recentOrphans) {
      console.log(`  - job=${job.id} queue=${job.queue_name} class=${job.workload_class} prev_owner=${job.prev_owner ?? "(null)"}`);
      workerLog({ worker: "bootstrap", event: "stale_job_reset", jobId: job.id, queueName: job.queue_name, workloadClass: job.workload_class, reason: "startup_recent_orphan_reset" });
    }
  }

  if (zombies.length === 0 && recentOrphans.length === 0) {
    console.log("[Bootstrap] No stale jobs found from previous process(es)");
  }
}

/**
 * Task #1829 — Front pipeline warp-speed fast-poll cycle.
 *
 * This is a SECOND scheduler loop, separate from the main
 * `schedulerCycle` tick. It exists because the main loop polls every
 * `pollIntervalMs` (default 1000 ms) and dispatches AT MOST ONE job
 * per workload class per tick — combined with the original
 * `ingestion` class budget that effectively caps the three Front
 * queues at ~1 job/sec each in production despite handlers that
 * complete in <100 ms.
 *
 * Behavior:
 *   - The timer is ALWAYS scheduled at boot (not gated on the master
 *     switch) so flipping the switch later does not require a process
 *     restart. The per-tick implementation decides what to dispatch.
 *   - Master `front_warp_speed_enabled` = ON: drains by
 *     `queue_name IN (front_webhook_normalize, front_webhook_apply,
 *     front_reconciliation)` regardless of workload_class, so the
 *     existing ~22k legacy-class backlog drains immediately and new
 *     enqueues land on `front_ingestion` via the enqueueJob remap.
 *   - Master = OFF (rollback): drains only rows whose workload_class
 *     is already `front_ingestion` (residual rows enqueued while ON).
 *     Legacy `ingestion`-class Front rows fall back to the main
 *     scheduler — preventing a ON→OFF flip from stranding rows or
 *     racing the main scheduler.
 *   - Polls every `front_ingestion_poll_interval_ms` (default 500 ms).
 *   - Round-robin across the three Front queues: each rotation tries
 *     to dispatch ONE job from each queue before starting the next
 *     rotation. This prevents a deep `front_webhook_normalize`
 *     backlog from starving `front_webhook_apply` or
 *     `front_reconciliation`. The starting queue of the rotation
 *     advances each cycle so no queue is permanently last.
 *   - Stops the cycle when ANY of these limits is hit: class budget
 *     full, global worker budget full, per-cycle dispatch ceiling
 *     reached, or every queue is empty/paused/throttled.
 *
 * Pre-dispatch guards (each suppresses dispatch AND increments a
 * counter surfaced via `getFrontWarpGuardCounters`):
 *   1. Worker-pool idle headroom: skip cycle if
 *      `worker_pool_idle_count + worker_pool_max - worker_pool_total
 *      < front_ingestion_worker_idle_min` (i.e. the pool has no
 *      spare connections it could hand out without growing).
 *   2. API-pool waiter backoff (apply queue only, gated by
 *      `front_ingestion_api_waiter_backoff_enabled`): skip
 *      `front_webhook_apply` dispatch when `isApiPoolUnderPressure`
 *      reports waiters or sustained slow-acquire pressure. The
 *      apply path runs DB-heavy work and its shared helpers
 *      occasionally hit the api pool, so this is the highest-risk
 *      queue for back-pressuring user requests.
 *   3. Front API rate-limit guard (gated by
 *      `front_ingestion_front_rate_limit_guard_enabled`): if the
 *      Front 429 ring shows >= 3 hits in the last 60 s, skip this
 *      cycle entirely. The webhook ingestion path records each 429
 *      via `recordFront429Hit`.
 *   4. DB-hold throttle: if the api pool is under pressure for
 *      `recent_slow_acquires` reasons (a leading indicator of long
 *      holds), halve the per-cycle dispatch ceiling. This keeps
 *      multi-dispatch from piling onto a struggling DB.
 *
 * Other invariants:
 *   - Drains by `queue_name IN (front_webhook_normalize,
 *     front_webhook_apply, front_reconciliation)` regardless of
 *     `workload_class`, so the existing ~22k pending backlog rows
 *     (which still carry `workload_class = 'ingestion'`) drain
 *     immediately after the master switch is flipped. New enqueues
 *     after the flip land directly on `front_ingestion` via the
 *     `enqueueJob` remap above.
 *   - Honors per-queue pause and dispatch rate caps (existing
 *     `isQueuePaused` / `canDispatchQueueNow`).
 *   - Honors the `db_pool_tenancy_enforcement_enabled` switch and
 *     pins the tick to the worker pool when on (mirrors the main
 *     cycle).
 */
let fastPollTimer: ReturnType<typeof setTimeout> | null = null;
let fastPollIsRunning = false;
let fastPollLastCycleAt: Date | null = null;
let fastPollCycleCount = 0;

async function dequeueFrontWarpJob(
  excludeQueueNames: string[],
  frontIngestionClassOnly: boolean,
  queueNamesOverride?: readonly string[],
): Promise<WorkQueueJob | null> {
  const now = new Date();
  const leaseMs = await getLeaseCutoffMs();
  const leaseExpiry = new Date(now.getTime() + leaseMs);
  const baseQueueList = queueNamesOverride ?? (FRONT_WARP_QUEUE_NAMES as readonly string[]);
  const allowedQueues = baseQueueList.filter(
    (q) => !excludeQueueNames.includes(q),
  );
  if (allowedQueues.length === 0) return null;

  // Rollback-safety: when master switch is OFF the fast-poll keeps
  // running BUT only drains rows whose workload_class is already
  // 'front_ingestion' (i.e. rows enqueued while warp was ON). Legacy
  // 'ingestion'-class Front rows in that case fall back to the main
  // scheduler — preventing dispatch races and stranded rows after a
  // ON → OFF flip.
  const classClause = frontIngestionClassOnly
    ? sql`AND workload_class = 'front_ingestion'`
    : sql``;

  const result = await workerDb.execute(sql`
    UPDATE work_queue
    SET
      status = 'leased',
      lease_owner = ${LEASE_OWNER},
      lease_expires_at = ${leaseExpiry},
      heartbeat_at = ${now},
      leased_at = ${now},
      updated_at = ${now}
    WHERE id IN (
      SELECT id FROM work_queue
      WHERE queue_name IN (${sql.join(allowedQueues.map((n) => sql`${n}`), sql`, `)})
        ${classClause}
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
  return _mapRowToJob(raw);
}

async function frontWarpFastPollCycleImpl(
  queueNamesOverride?: readonly string[],
): Promise<number> {
  if (fastPollIsRunning || isShuttingDown) return 0;
  const warpEnabled = isPoolEpicSwitchEnabled("front_warp_speed_enabled");
  if (!warpEnabled) {
    incrementFrontWarpGuard("masterSwitchOff");
    // NOTE: We intentionally do NOT short-circuit here. When master is
    // OFF the loop still runs but is restricted to draining residual
    // `workload_class='front_ingestion'` rows so that a ON → OFF
    // rollback never strands the rows that were enqueued while warp
    // was ON. enqueueJob remap is the gated piece.
  }
  fastPollIsRunning = true;
  let dispatched = 0;
  try {
    await ensureFrontWarpSettingsLoaded();
    const cfg = getFrontWarpSettings();

    // Test seam discipline: when a `queueNamesOverride` is provided the
    // caller is `_runFrontWarpFastPollCycleForTests` running with
    // synthetic queue names that the live scheduler will never see. The
    // Phase 4 pool/rate-limit guards are deliberately bypassed in that
    // mode so tests don't have to mock pool snapshots or the Front 429
    // ring — guards are always-on in prod (override is undefined).
    const isTestOverride = queueNamesOverride !== undefined;

    const queuesToCheck = queueNamesOverride ?? FRONT_WARP_QUEUE_NAMES;

    // ---------------- Phase 4 pre-dispatch guards ----------------
    // Each guard increments its own counter (visible in the validator +
    // admin trends panel) so operators can see whether a throttle is
    // active. Guards fail closed: if the pool is unsafe we do not
    // dispatch this cycle.

    // Guard A — Front API 429 burst. The webhook ingestion path calls
    // `recordFront429Hit` on every 429 response; if ≥ FRONT_429_THRESHOLD
    // hits in the last 60 s we back off the whole cycle so multi-dispatch
    // cannot create a 429 storm. Gated by the registered kill switch so
    // operators can disable it independently of warp speed.
    if (
      !isTestOverride &&
      warpEnabled &&
      isPoolEpicSwitchEnabled("front_ingestion_front_rate_limit_guard_enabled") &&
      isFrontRateLimitElevated()
    ) {
      incrementFrontWarpGuard("frontRateLimit");
      workerLog({
        worker: "scheduler:front_ingestion",
        event: "front_warp_guard_triggered",
        workloadClass: "front_ingestion",
        guard: "front_rate_limit",
      });
      return 0;
    }

    // Guard B — Worker-pool idle headroom. "Headroom" = currently-idle
    // pg connections + room left to grow the pool before hitting max.
    // If headroom < workerIdleMin we don't multi-dispatch this cycle —
    // the pool is too busy to safely take on more work. Per spec the
    // legacy 1-per-tick scheduler keeps running; we only suppress the
    // fast-poll burst.
    if (!isTestOverride && warpEnabled) {
      const ws = getWorkerPoolSnapshot();
      const headroom = ws.idle + Math.max(0, ws.max - ws.total);
      if (headroom < cfg.workerIdleMin) {
        incrementFrontWarpGuard("workerIdle");
        workerLog({
          worker: "scheduler:front_ingestion",
          event: "front_warp_guard_triggered",
          workloadClass: "front_ingestion",
          guard: "worker_idle",
          headroom,
          required: cfg.workerIdleMin,
        });
        return 0;
      }
    }

    // Per-queue exclude set: paused or rate-capped. Mirrors the main
    // scheduler's drain-control behavior.
    const excludeQueueNames: string[] = [];
    for (const name of queuesToCheck) {
      if (isQueuePaused(name) || !canDispatchQueueNow(name)) {
        excludeQueueNames.push(name);
        incrementFrontWarpGuard("queuePaused");
      }
    }

    // Guard C — API-pool waiter backoff for `front_webhook_apply` only.
    // The apply handler runs DB-heavy work and its shared helpers can
    // occasionally hit the api pool; if user-request waiters are queued
    // we exclude apply from this tick so multi-dispatch can't back-
    // pressure user requests. Normalize/reconciliation remain eligible.
    // The `recent_slow_acquires` signal from `isApiPoolUnderPressure`
    // is checked below as Guard D so we share one snapshot here.
    const apiSnapshot = !isTestOverride
      ? isApiPoolUnderPressure()
      : { underPressure: false, reasons: [], utilizationPct: 0, waitingCount: 0, recentSlowAcquires: 0 };
    const apiWaiterGuardEnabled =
      !isTestOverride &&
      warpEnabled &&
      isPoolEpicSwitchEnabled("front_ingestion_api_waiter_backoff_enabled");
    let excludeApplyForApiBackoff = false;
    if (apiWaiterGuardEnabled && apiSnapshot.waitingCount > 0) {
      excludeApplyForApiBackoff = true;
      if (!excludeQueueNames.includes("front_webhook_apply")) {
        excludeQueueNames.push("front_webhook_apply");
      }
      incrementFrontWarpGuard("apiPoolWaiter");
      workerLog({
        worker: "scheduler:front_ingestion",
        event: "front_warp_guard_triggered",
        workloadClass: "front_ingestion",
        guard: "api_pool_waiter",
        waitingCount: apiSnapshot.waitingCount,
      });
    }

    // Guard D — DB-hold throttle. Sustained slow api-pool acquires are
    // the leading indicator of >10 s DB holds (Task #836 Phase 2 ring).
    // When the signal is present we halve the per-cycle ceiling so
    // multi-dispatch can't pile onto a struggling DB. The check is on
    // top of (not instead of) the long-hold alerter — this is the
    // pre-dispatch lever; the alerter is the post-hoc canary.
    let effectiveDispatchMax = cfg.perCycleDispatchMax;
    if (!isTestOverride && warpEnabled && apiSnapshot.recentSlowAcquires > 0) {
      effectiveDispatchMax = Math.max(1, Math.floor(cfg.perCycleDispatchMax / 2));
      incrementFrontWarpGuard("dbHoldThrottle");
    }

    // ---------------- Intra-class fairness ----------------
    // Round-robin across the 3 Front queues by `lastDispatchByQueue`
    // (same pattern as `dequeueForClass`). Without this, a 22k-row
    // normalize backlog at the same priority would starve apply /
    // reconciliation because the global ORDER BY priority,created_at
    // would always pick normalize first. We pick the oldest-dispatched
    // queue per iteration; the fallback unrestricted dequeue keeps
    // throughput up if the per-queue pick races and loses.
    const allowedQueues = queuesToCheck.filter(
      (q) => !excludeQueueNames.includes(q),
    );
    if (allowedQueues.length === 0) {
      return 0;
    }

    for (let i = 0; i < effectiveDispatchMax; i++) {
      if (!tryAcquireSlot("front_ingestion")) {
        incrementFrontWarpGuard("classCapReached");
        break;
      }

      const orderedQueues = [...allowedQueues].sort((a, b) => {
        const at = lastDispatchByQueue.get(a) ?? 0;
        const bt = lastDispatchByQueue.get(b) ?? 0;
        return at - bt;
      });

      let job: WorkQueueJob | null = null;
      for (const pick of orderedQueues) {
        job = await dequeueFrontWarpJob(excludeQueueNames, !warpEnabled, [pick]);
        if (job) break;
      }
      if (!job) {
        // Fallback: all per-queue picks raced and lost. Try one
        // unrestricted dequeue across the allowed set so the cycle
        // doesn't waste a slot acquisition.
        job = await dequeueFrontWarpJob(excludeQueueNames, !warpEnabled, queueNamesOverride);
      }
      if (!job) {
        releaseSlot("front_ingestion");
        break;
      }
      trackJobStart(job.id);
      lastDispatchByQueue.set(job.queueName, Date.now());
      recordQueueDispatch(job.queueName);
      recordCycleDispatch(job.queueName);
      dispatched++;
      workerLog({
        worker: "scheduler:front_ingestion",
        event: "front_warp_dispatched",
        workloadClass: "front_ingestion",
        queueName: job.queueName,
        jobId: job.id,
      });
      void processJob(job).finally(() => trackJobEnd(job.id, "front_ingestion")); // fire-and-forget dispatch
    }

    if (dispatched >= effectiveDispatchMax) {
      incrementFrontWarpGuard("perCycleMaxReached");
    }

    if (dispatched > 0) {
      workerLog({
        worker: "scheduler:front_ingestion",
        event: "front_warp_cycle_summary",
        workloadClass: "front_ingestion",
        dispatched,
        perCycleMax: effectiveDispatchMax,
        applyBackoffActive: excludeApplyForApiBackoff,
      });
    }
  } catch (err) {
    console.error("[WorkScheduler] Front warp fast-poll cycle error:", err);
  } finally {
    fastPollIsRunning = false;
    fastPollLastCycleAt = new Date();
    fastPollCycleCount++;
  }
  return dispatched;
}

async function frontWarpFastPollCycle(): Promise<number> {
  const run = () =>
    withDbAttribution("scheduler:front-warp-fast-poll", frontWarpFastPollCycleImpl);
  if (isPoolEpicSwitchEnabled("db_pool_tenancy_enforcement_enabled")) {
    return runWithWorkerDb(run);
  }
  return run();
}

function scheduleNextFastPollCycle(): void {
  if (isShuttingDown) return;
  let intervalMs = 500;
  try {
    intervalMs = getFrontWarpSettings().pollIntervalMs;
  } catch {
    /* keep default */
  }
  fastPollTimer = setTimeout(async () => {
    try {
      await frontWarpFastPollCycle();
    } finally {
      void scheduleNextFastPollCycle();
    }
  }, intervalMs);
}

export function getFrontWarpSchedulerStatus(): {
  running: boolean;
  enabled: boolean;
  lastCycleAt: string | null;
  cycleCount: number;
  pollIntervalMs: number;
} {
  return {
    running: fastPollTimer !== null,
    enabled: isPoolEpicSwitchEnabled("front_warp_speed_enabled"),
    lastCycleAt: fastPollLastCycleAt?.toISOString() ?? null,
    cycleCount: fastPollCycleCount,
    pollIntervalMs: getFrontWarpSettings().pollIntervalMs,
  };
}

// Test seam — directly invoke one fast-poll cycle without standing up
// the timer (used by `tests/front-warp-speed.test.ts`). Returns the
// number of jobs dispatched on this tick so tests can validate
// behavior independent of which DB rows existed at the moment.
export async function _runFrontWarpFastPollCycleForTests(
  queueNamesOverride?: readonly string[],
): Promise<number> {
  return frontWarpFastPollCycleImpl(queueNamesOverride);
}

async function scheduleNextCycle(): Promise<void> {
  if (isShuttingDown) return;
  let pollIntervalMs = DEFAULT_QUEUE_TIMINGS.pollIntervalMs;
  try {
    pollIntervalMs = (await getQueueTimings()).pollIntervalMs;
  } catch (err) {
    console.error("[WorkScheduler] Failed to read queue timings; using default poll interval:", err);
  }
  lastEffectivePollIntervalMs = pollIntervalMs;
  schedulerTimer = setTimeout(async () => {
    try {
      await schedulerCycle();
    } finally {
      void scheduleNextCycle();
    }
  }, pollIntervalMs);
}

export async function startScheduler(): Promise<void> {
  if (schedulerTimer) return;

  const ready = await ensureWorkQueueTable();
  if (!ready) {
    console.warn("[WorkScheduler] Scheduler disabled — work_queue table could not be created");
    return;
  }

  // Task #1816: hydrate the live ingestion-class cap from
  // `system_settings.workload_class_ingestion_max_concurrency` so a
  // previous CEO ramp survives a redeploy. Best-effort: a settings
  // read failure here keeps the in-code default (3) and does not
  // block scheduler startup.
  await loadIngestionClassConcurrencyFromSettings();

  // Task #1020: hydrate the in-memory dispatch-window ring buffer from
  // the persisted snapshot so the work-queue admin sparkline shows
  // recent history immediately after a redeploy/restart instead of
  // waiting ~10 minutes for the first window to complete.
  await loadPersistedDispatchWindowHistory();

  const ownedClasses = getSchedulerOwnedClasses();
  const initial = await getQueueTimings();
  console.log(`[WorkScheduler] Starting scheduler (poll every ${initial.pollIntervalMs}ms, owned classes: ${ownedClasses.join(", ")})`);
  void scheduleNextCycle();

  // Task #1829 — start the Front pipeline warp-speed fast-poll timer
  // regardless of whether the master switch is currently ON. The
  // timer's per-cycle implementation no-ops when the switch is OFF, so
  // starting it is a no-cost behavior-neutral wiring step. We
  // intentionally do NOT gate the start itself on the switch so an
  // operator who flips the switch later does not need to restart the
  // process for the fast-poll loop to begin draining.
  await ensureFrontWarpSettingsLoaded();
  const warpCfg = getFrontWarpSettings();
  console.log(
    `[WorkScheduler] Starting Front warp-speed fast-poll timer ` +
    `(poll every ${warpCfg.pollIntervalMs}ms, dispatchMax=${warpCfg.perCycleDispatchMax}, ` +
    `classCap=${warpCfg.classConcurrency}, dormant until front_warp_speed_enabled=true)`,
  );
  void scheduleNextFastPollCycle();
}

export async function getJobById(jobId: string): Promise<WorkQueueJob | null> {
  const [row] = await workerDb
    .select()
    .from(workQueue)
    .where(eq(workQueue.id, jobId))
    .limit(1);
  return row ?? null;
}

export function stopScheduler(): void {
  isShuttingDown = true;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
    console.log("[WorkScheduler] Scheduler stopped");
  }
  // Task #1829 — also tear down the Front warp-speed fast-poll timer
  // so the shutdown path doesn't leak a setTimeout chain.
  if (fastPollTimer) {
    clearTimeout(fastPollTimer);
    fastPollTimer = null;
    console.log("[WorkScheduler] Front warp-speed fast-poll timer stopped");
  }
}

/**
 * Task #1676 — graceful release of in-flight leases owned by THIS
 * scheduler process during SIGTERM/SIGINT shutdown.
 *
 * Without this, every deploy/restart leaves the rows this process was
 * actively processing in `status='leased'`/`processing` with our
 * `lease_owner`. On the next boot, those rows trip the
 * `cleanupStaleJobsOnStartup` zombie/orphan path — heartbeats stop the
 * moment the process exits, so within ~10 min they're classified as
 * `startup_stale_recovery` (failed or dead_letter on max attempts) or
 * reset to pending after an extra delay. Under autoscale that fires on
 * every redeploy, which is the dominant source of cross-queue
 * `startup_stale_recovery` and downstream `stale_lease_exhaustion`
 * noise reported in the May 20 production health check.
 *
 * The fix is intentionally narrow: only rows owned by THIS process's
 * `LEASE_OWNER` are reset, and only when the row is still in a leased
 * status. The terminal-write lease guard in `processJobInner` already
 * prevents a still-running handler from clobbering the row after it's
 * been requeued, so this is safe even if a handler is mid-await when
 * shutdown begins. Heartbeats are also stopped here to prevent a
 * late tick from re-extending a lease we just released.
 */
export async function releaseInFlightLeasesOnShutdown(): Promise<void> {
  // Stop every active heartbeat timer immediately so no straggling
  // tick re-extends a lease we're about to clear.
  for (const key of [...activeJobHeartbeats.keys()]) {
    stopHeartbeat(key);
  }

  try {
    const now = new Date();
    const result = await workerDb.execute(sql`
      UPDATE work_queue
      SET status = 'pending',
          leased_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          updated_at = ${now}
      WHERE lease_owner = ${LEASE_OWNER}
        AND status IN ('leased', 'processing')
      RETURNING id, queue_name, workload_class
    `);
    const rows = result.rows as Array<{ id: string; queue_name: string; workload_class: string }>;
    if (rows.length > 0) {
      console.log(
        `[Shutdown] Released ${rows.length} in-flight lease(s) owned by ${LEASE_OWNER}; rows reset to pending`,
      );
      for (const r of rows) {
        workerLog({
          worker: "shutdown",
          event: "in_flight_lease_released",
          jobId: r.id,
          queueName: r.queue_name,
          workloadClass: r.workload_class,
          reason: "graceful_shutdown",
        });
      }
    } else {
      console.log("[Shutdown] No in-flight leases to release");
    }
  } catch (err: any) {
    // Best-effort. Even if this fails the next boot's
    // cleanupStaleJobsOnStartup will still recover the rows — we just
    // wanted to avoid the noisy zombie/orphan classification path.
    console.warn(
      `[Shutdown] Failed to release in-flight leases: ${err?.message ?? err}`,
    );
  }
}

export function isSchedulerShuttingDown(): boolean {
  return isShuttingDown;
}

let lastEffectivePollIntervalMs: number = DEFAULT_QUEUE_TIMINGS.pollIntervalMs;

export function getSchedulerStatus(): {
  running: boolean;
  shuttingDown: boolean;
  lastCycleAt: string | null;
  cycleCount: number;
  pollIntervalMs: number;
} {
  return {
    running: schedulerTimer !== null,
    shuttingDown: isShuttingDown,
    lastCycleAt: lastSchedulerCycleAt?.toISOString() ?? null,
    cycleCount: schedulerCycleCount,
    pollIntervalMs: lastEffectivePollIntervalMs,
  };
}

interface RecentTerminalJob {
  jobId: string;
  queueName: string;
  workloadClass: string;
  status: string;
  completedAt: Date;
  attemptCount: number;
  errorMessage: string | null;
  leaseDurationMs: number | null;
}

export async function getQueueStatus(): Promise<{
  depths: Record<string, number>;
  depthsByClass: Record<string, number>;
  activeLeasedByClass: Record<string, number>;
  activeByClass: Record<string, { active: number; max: number; activeWorkers: string[] }>;
  recentCompletions: RecentTerminalJob[];
  recentFailures: RecentTerminalJob[];
  recentDeadLettered: RecentTerminalJob[];
  staleJobs: number;
  oldestPendingAgeMs: number | null;
  averageLeaseDurationMs: number | null;
  retryDistribution: Record<number, number>;
  starvationWarnings: Array<{ jobId: string; queueName: string; ageMs: number }>;
  slotHoldMetrics: ReturnType<typeof getSlotHoldMetrics>;
  staleLeaseExhaustion: ReturnType<typeof getStaleLeaseExhaustionMetrics>;
}> {
  const depthRows = await workerDb
    .select({
      queueName: workQueue.queueName,
      count: sql<number>`count(*)::int`,
    })
    .from(workQueue)
    .where(eq(workQueue.status, "pending"))
    .groupBy(workQueue.queueName);

  const depths: Record<string, number> = {};
  for (const row of depthRows) {
    depths[row.queueName] = row.count;
  }

  const depthByClassRows = await workerDb
    .select({
      workloadClass: workQueue.workloadClass,
      count: sql<number>`count(*)::int`,
    })
    .from(workQueue)
    .where(eq(workQueue.status, "pending"))
    .groupBy(workQueue.workloadClass);

  const depthsByClass: Record<string, number> = {};
  for (const row of depthByClassRows) {
    depthsByClass[row.workloadClass] = row.count;
  }

  const activeLeasedRows = await workerDb
    .select({
      workloadClass: workQueue.workloadClass,
      count: sql<number>`count(*)::int`,
    })
    .from(workQueue)
    .where(
      or(
        eq(workQueue.status, "leased"),
        eq(workQueue.status, "processing"),
      ),
    )
    .groupBy(workQueue.workloadClass);

  const activeLeasedByClass: Record<string, number> = {};
  for (const row of activeLeasedRows) {
    activeLeasedByClass[row.workloadClass] = row.count;
  }

  const classStatus = getClassStatus();
  const activeByClass: Record<string, { active: number; max: number; activeWorkers: string[] }> = {};
  for (const [cls, info] of Object.entries(classStatus)) {
    activeByClass[cls] = {
      active: info.activeCount,
      max: info.maxConcurrency,
      activeWorkers: info.activeWorkers,
    };
  }

  const leaseCutoffMs = await getLeaseCutoffMs();
  const staleThreshold = new Date(Date.now() - leaseCutoffMs);
  const [staleResult] = await workerDb
    .select({ count: sql<number>`count(*)::int` })
    .from(workQueue)
    .where(
      and(
        or(
          eq(workQueue.status, "leased"),
          eq(workQueue.status, "processing"),
        ),
        lte(workQueue.leasedAt, staleThreshold),
      ),
    );

  const [oldestPendingRow] = await workerDb
    .select({ createdAt: workQueue.createdAt })
    .from(workQueue)
    .where(eq(workQueue.status, "pending"))
    .orderBy(asc(workQueue.createdAt))
    .limit(1);

  const oldestPendingAgeMs = oldestPendingRow
    ? Date.now() - oldestPendingRow.createdAt.getTime()
    : null;

  const [avgLeaseRow] = await workerDb
    .select({
      avgMs: sql<number>`COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - leased_at)) * 1000))::int, 0)`,
    })
    .from(workQueue)
    .where(
      and(
        eq(workQueue.status, "completed"),
        gte(workQueue.completedAt, new Date(Date.now() - 3600_000)),
      ),
    );

  const averageLeaseDurationMs = avgLeaseRow?.avgMs ?? null;

  const retryRows = await workerDb
    .select({
      attemptCount: workQueue.attemptCount,
      count: sql<number>`count(*)::int`,
    })
    .from(workQueue)
    .where(
      or(
        eq(workQueue.status, "pending"),
        eq(workQueue.status, "leased"),
        eq(workQueue.status, "processing"),
      ),
    )
    .groupBy(workQueue.attemptCount);

  const retryDistribution: Record<number, number> = {};
  for (const row of retryRows) {
    retryDistribution[row.attemptCount] = row.count;
  }

  const recentWindow = new Date(Date.now() - 3600_000);

  const recentTerminalRows = await workerDb
    .select({
      id: workQueue.id,
      queueName: workQueue.queueName,
      workloadClass: workQueue.workloadClass,
      status: workQueue.status,
      completedAt: workQueue.completedAt,
      attemptCount: workQueue.attemptCount,
      maxAttempts: workQueue.maxAttempts,
      errorMessage: workQueue.errorMessage,
      leasedAt: workQueue.leasedAt,
    })
    .from(workQueue)
    .where(
      and(
        or(
          eq(workQueue.status, "completed"),
          eq(workQueue.status, "failed"),
          eq(workQueue.status, "dead_letter"),
        ),
        gte(workQueue.completedAt, recentWindow),
      ),
    )
    .orderBy(sql`completed_at DESC`)
    .limit(50);

  function toTerminalJob(row: typeof recentTerminalRows[number]): RecentTerminalJob {
    const leaseDurationMs = row.completedAt && row.leasedAt
      ? row.completedAt.getTime() - row.leasedAt.getTime()
      : null;
    return {
      jobId: row.id,
      queueName: row.queueName,
      workloadClass: row.workloadClass,
      status: row.status,
      completedAt: row.completedAt!,
      attemptCount: row.attemptCount,
      errorMessage: row.errorMessage,
      leaseDurationMs,
    };
  }

  const recentCompletions = recentTerminalRows
    .filter(r => r.status === "completed")
    .map(toTerminalJob);

  const recentFailures = recentTerminalRows
    .filter(r => r.status === "failed")
    .map(toTerminalJob);

  const recentDeadLettered = recentTerminalRows
    .filter(r => r.status === "dead_letter")
    .map(toTerminalJob);

  const starvationWarnings = latestStarvationWarnings.map(w => ({
    jobId: w.jobId,
    queueName: w.queueName,
    ageMs: w.ageMs,
  }));

  return {
    depths,
    depthsByClass,
    activeLeasedByClass,
    activeByClass,
    recentCompletions,
    recentFailures,
    recentDeadLettered,
    staleJobs: staleResult?.count ?? 0,
    oldestPendingAgeMs,
    averageLeaseDurationMs,
    retryDistribution,
    starvationWarnings,
    slotHoldMetrics: getSlotHoldMetrics(),
    staleLeaseExhaustion: getStaleLeaseExhaustionMetrics(),
  };
}

export async function getDeadLetterQueueNames(): Promise<string[]> {
  const rows = await workerDb
    .selectDistinct({ queueName: workQueue.queueName })
    .from(workQueue)
    .where(eq(workQueue.status, "dead_letter"))
    .orderBy(asc(workQueue.queueName));
  return rows.map((r) => r.queueName);
}

export async function getDeadLetteredJobs(options?: {
  limit?: number;
  offset?: number;
  queueName?: string;
}): Promise<{ jobs: WorkQueueJob[]; total: number }> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const conditions = [eq(workQueue.status, "dead_letter")];
  if (options?.queueName) {
    conditions.push(eq(workQueue.queueName, options.queueName));
  }

  const [countResult] = await workerDb
    .select({ count: sql<number>`count(*)::int` })
    .from(workQueue)
    .where(and(...conditions));

  const jobs = await workerDb
    .select()
    .from(workQueue)
    .where(and(...conditions))
    .orderBy(sql`completed_at DESC NULLS LAST`)
    .limit(limit)
    .offset(offset);

  return { jobs, total: countResult?.count ?? 0 };
}

export async function replayDeadLetteredJob(jobId: string, options?: { operatorId?: string; operatorUsername?: string }): Promise<WorkQueueJob> {
  const [job] = await workerDb
    .select()
    .from(workQueue)
    .where(and(eq(workQueue.id, jobId), eq(workQueue.status, "dead_letter")))
    .limit(1);

  if (!job) {
    throw new Error(`Job ${jobId} not found or is not in dead_letter status`);
  }

  const now = new Date();
  const [updated] = await workerDb
    .update(workQueue)
    .set({
      status: "pending",
      attemptCount: 0,
      errorMessage: null,
      errorCode: null,
      completedAt: null,
      leasedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      retryAt: null,
      updatedAt: now,
    })
    .where(and(eq(workQueue.id, jobId), eq(workQueue.status, "dead_letter")))
    .returning();

  if (!updated) {
    throw new Error(`Failed to replay job ${jobId} — it may have been modified concurrently`);
  }

  workerLog({ worker: job.queueName, event: "job_replayed_from_dead_letter", jobId: job.id, workloadClass: job.workloadClass, operatorId: options?.operatorId ?? "unknown", operatorUsername: options?.operatorUsername ?? "unknown" });
  pipelineLog({
    event: "replayed",
    sourceSystem: job.queueName,
    sourceEventType: job.workloadClass,
    sourceEventId: job.id,
    outcome: "dead_letter_replay",
    operatorId: options?.operatorId ?? "unknown",
    operatorUsername: options?.operatorUsername ?? "unknown",
  });

  return updated;
}

export const MAX_BULK_REPLAY = 500;

/**
 * Task #1834 — bounded-batch sibling of `bulkReplayDeadLetteredJobs`.
 *
 * The original helper refuses to act when `matchCount > cap`, which
 * is the right safety posture for the ad-hoc "Replay All" admin UI
 * (an operator clicking that surface should be forced to narrow the
 * filter). For the prod-actions panel button that intentionally
 * drains a known queue's backlog in repeated presses, that throw is
 * the wrong shape — we want each press to replay at most `cap` rows
 * and leave the rest for the next press.
 *
 * Semantics:
 *   - Targets `status='dead_letter'` rows in the given `queueName`
 *     only. `queueName` is REQUIRED (no global drain — the caller
 *     must opt into a specific queue).
 *   - Replays at most `cap` rows per call via
 *     `UPDATE work_queue SET status='pending' ... WHERE id IN
 *      (SELECT id FROM work_queue WHERE ... ORDER BY completed_at
 *       ASC LIMIT cap FOR UPDATE SKIP LOCKED)`.
 *   - Idempotent at the row level: once a row is reset to `pending`
 *     it no longer matches the dead-letter filter, so a follow-up
 *     call selects fresh rows.
 *   - Same column-reset shape (`attempt_count`, `error_*`,
 *     `completed_at`, lease fields, `retry_at`) as the existing
 *     helper, so the scheduler picks them up on the next tick.
 *   - Same logging shape (`job_replayed_from_dead_letter` +
 *     `bulk_dead_letter_replay`) for audit parity.
 */
export async function replayDeadLetteredJobsBatch(options: {
  queueName: string;
  cap?: number;
  operatorId?: string;
  operatorUsername?: string;
}): Promise<{
  replayedCount: number;
  remainingCount: number;
  cap: number;
  replayedIds: string[];
}> {
  if (!options.queueName) {
    throw new Error("replayDeadLetteredJobsBatch requires a queueName");
  }
  const requestedCap = options.cap ?? MAX_BULK_REPLAY;
  const cap = Math.max(1, Math.min(Math.floor(requestedCap), MAX_BULK_REPLAY));
  const queueName = options.queueName;

  const now = new Date();
  // getDb() (not the bare `workerDb`) so the isolated-schema test harness
  // can redirect this drain to its sandbox; in production the only caller
  // is the prod-action background drain, which runs inside
  // `runWithWorkerDb(...)` so getDb() resolves to the worker pool exactly
  // as before.
  const updateResult = await withDbAttribution(
    "worker:replay-dead-letter-batch-update",
    () => getDb().execute(sql`
    UPDATE work_queue
    SET status = 'pending',
        attempt_count = 0,
        error_message = NULL,
        error_code = NULL,
        completed_at = NULL,
        leased_at = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        retry_at = NULL,
        updated_at = ${now}
    WHERE id IN (
      SELECT id FROM work_queue
      WHERE queue_name = ${queueName}
        AND status = 'dead_letter'
      ORDER BY completed_at ASC NULLS LAST, id ASC
      LIMIT ${cap}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, queue_name, workload_class
  `),
  );

  const replayedRows = (updateResult.rows ?? []) as Array<{
    id: string;
    queue_name: string;
    workload_class: string;
  }>;

  for (const job of replayedRows) {
    workerLog({
      worker: job.queue_name,
      event: "job_replayed_from_dead_letter",
      jobId: job.id,
      workloadClass: job.workload_class,
      operatorId: options.operatorId ?? "unknown",
      operatorUsername: options.operatorUsername ?? "unknown",
    });
    pipelineLog({
      event: "replayed",
      sourceSystem: job.queue_name,
      sourceEventType: job.workload_class,
      sourceEventId: job.id,
      outcome: "dead_letter_bulk_replay",
      operatorId: options.operatorId ?? "unknown",
      operatorUsername: options.operatorUsername ?? "unknown",
    });
  }

  workerLog({
    worker: "bulk_replay",
    event: "bulk_dead_letter_replay",
    jobId: "bulk",
    queueName,
    replayedCount: replayedRows.length,
    operatorId: options.operatorId ?? "unknown",
    operatorUsername: options.operatorUsername ?? "unknown",
  });

  // Count remaining dead-letter rows for the same queue so the caller
  // can report progress (e.g. "Replayed 500, 17305 remain — re-press").
  const [remainingRow] = await withDbAttribution(
    "worker:replay-dead-letter-batch-remaining",
    () => getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(workQueue)
      .where(and(eq(workQueue.queueName, queueName), eq(workQueue.status, "dead_letter"))),
  );

  return {
    replayedCount: replayedRows.length,
    remainingCount: remainingRow?.count ?? 0,
    cap,
    replayedIds: replayedRows.map((r) => r.id),
  };
}

export class BulkReplayCapExceededError extends Error {
  matchCount: number;
  cap: number;
  constructor(matchCount: number, cap: number) {
    super(
      `Bulk dead-letter replay would affect ${matchCount} jobs, which exceeds the safety cap of ${cap}. ` +
      `Filter by queueName or replay individual jobs.`,
    );
    this.name = "BulkReplayCapExceededError";
    this.matchCount = matchCount;
    this.cap = cap;
  }
}

export async function bulkReplayDeadLetteredJobs(options?: {
  queueName?: string;
  dryRun?: boolean;
  operatorId?: string;
  operatorUsername?: string;
  cap?: number;
  maxBatchSize?: number;
}): Promise<{
  count: number;
  replayedIds: string[];
  cap: number;
  sample?: Array<{ id: string; queueName: string; workloadClass: string; errorMessage: string | null; completedAt: Date | null }>;
  wouldExceedCap?: boolean;
  warning?: string;
}> {
  const requestedCap = options?.maxBatchSize ?? options?.cap ?? MAX_BULK_REPLAY;
  const cap = Math.max(1, Math.min(Math.floor(requestedCap), MAX_BULK_REPLAY));
  const conditions = [eq(workQueue.status, "dead_letter")];
  if (options?.queueName) {
    conditions.push(eq(workQueue.queueName, options.queueName));
  }

  const [countResult] = await workerDb
    .select({ count: sql<number>`count(*)::int` })
    .from(workQueue)
    .where(and(...conditions));

  const matchCount = countResult?.count ?? 0;

  if (options?.dryRun) {
    const sample = await workerDb
      .select({
        id: workQueue.id,
        queueName: workQueue.queueName,
        workloadClass: workQueue.workloadClass,
        errorMessage: workQueue.errorMessage,
        completedAt: workQueue.completedAt,
      })
      .from(workQueue)
      .where(and(...conditions))
      .orderBy(asc(workQueue.completedAt))
      .limit(20);

    const wouldExceedCap = matchCount > cap;
    return {
      count: matchCount,
      replayedIds: [],
      cap,
      sample,
      wouldExceedCap,
      warning: wouldExceedCap
        ? `Matched ${matchCount} dead-lettered jobs, which exceeds the safety cap of ${cap}. ` +
          `Replay will be refused unless you narrow the filter (e.g. by queueName) or replay individual jobs.`
        : undefined,
    };
  }

  if (matchCount > cap) {
    throw new BulkReplayCapExceededError(matchCount, cap);
  }

  if (matchCount === 0) {
    return { count: 0, replayedIds: [], cap };
  }

  const now = new Date();
  const replayed = await workerDb
    .update(workQueue)
    .set({
      status: "pending",
      attemptCount: 0,
      errorMessage: null,
      errorCode: null,
      completedAt: null,
      leasedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      retryAt: null,
      updatedAt: now,
    })
    .where(and(...conditions))
    .returning({ id: workQueue.id, queueName: workQueue.queueName, workloadClass: workQueue.workloadClass });

  for (const job of replayed) {
    workerLog({ worker: job.queueName, event: "job_replayed_from_dead_letter", jobId: job.id, workloadClass: job.workloadClass, operatorId: options?.operatorId ?? "unknown", operatorUsername: options?.operatorUsername ?? "unknown" });
    pipelineLog({
      event: "replayed",
      sourceSystem: job.queueName,
      sourceEventType: job.workloadClass,
      sourceEventId: job.id,
      outcome: "dead_letter_bulk_replay",
      operatorId: options?.operatorId ?? "unknown",
      operatorUsername: options?.operatorUsername ?? "unknown",
    });
  }

  workerLog({
    worker: "bulk_replay",
    event: "bulk_dead_letter_replay",
    jobId: "bulk",
    queueName: options?.queueName ?? "all",
    replayedCount: replayed.length,
    operatorId: options?.operatorId ?? "unknown",
    operatorUsername: options?.operatorUsername ?? "unknown",
  });

  return { count: replayed.length, replayedIds: replayed.map(j => j.id), cap };
}
