// @db-pool-intent: ambient
/**
 * Task #4331 — deal stage automation queue plumbing.
 *
 * Queue: `deal_stage_automation` (workload class "interactive" — the
 * default poll loop dispatches within seconds, matching the "actions
 * visible seconds after a move" requirement without any new timer).
 *
 * Producers:
 *   - dealsStorage.createDeal / moveDealStage post-commit kick (the event
 *     ROW is written inside their transaction; the job is enqueued after
 *     commit via `kickDealStageAutomationJobSafe` — an enqueue failure
 *     never fails the user's move, recovery below picks it up);
 *   - the boot catch-up sweep + POST /api/deal-automation/events/requeue
 *     (both funnel through `requeuePendingDealStageEvents`).
 *
 * Exactly-once: jobs dedupe on `deal_stage_automation:<eventId>` while
 * pending/processing (work_queue partial unique index), and the handler
 * body (dealAutomationEngine.processDealStageEvent) no-ops on processed
 * events — a replayed or double-enqueued job never duplicates actions.
 *
 * Stuck-pending recovery: a post-commit enqueue can fail (process death
 * between commit and enqueue). Rather than a new always-on sweeper, a
 * ONE-SHOT boot catch-up (deployment-gated like the sibling schedulers;
 * autoscale deploys restart often enough) re-enqueues pending events older
 * than 2 minutes, and operators have a manual requeue lever on the admin
 * surface. Enqueue-after-catch-up is idempotent via the dedupe key.
 */
import { and, asc, eq, lt } from "drizzle-orm";
import { dealStageEvents, type WorkQueueJob } from "@shared/schema";
import { getDb, withDbAttribution, runWithWorkerDb } from "../db";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { enqueueJob } from "./workScheduler";
import { processDealStageEvent } from "./dealAutomationEngine";

export const DEAL_STAGE_AUTOMATION_QUEUE = "deal_stage_automation";

const BOOT_CATCHUP_DELAY_MS = 30_000;
const CATCHUP_MIN_AGE_MS = 2 * 60_000;
const CATCHUP_LIMIT = 200;

/** Enqueues processing for one emitted event (throws on failure). */
export async function enqueueDealStageAutomationJob(
  eventId: string,
): Promise<void> {
  await enqueueJob({
    queueName: DEAL_STAGE_AUTOMATION_QUEUE,
    workloadClass: "interactive",
    payload: { eventId },
    dedupeKey: `deal_stage_automation:${eventId}`,
    maxAttempts: 3,
  });
}

/**
 * Post-commit kick for the stage writers: never throws — the move already
 * committed and must not fail on queue hiccups. The event row stays
 * pending; boot catch-up / the admin requeue lever recover it.
 */
export async function kickDealStageAutomationJobSafe(
  eventId: string | null | undefined,
): Promise<void> {
  if (!eventId) return;
  try {
    await enqueueDealStageAutomationJob(eventId);
  } catch (err: any) {
    console.error(
      `[dealAutomation] enqueue failed for event ${eventId} — event stays pending; ` +
        `boot catch-up or the admin requeue lever will recover it:`,
      err?.message ?? err,
    );
  }
}

/** Work-queue handler. Infra errors propagate (queue retry machinery);
 * action-level failures are recorded on run rows + alerted by the engine
 * and do NOT fail the job. */
export async function handleDealStageAutomation(
  job: WorkQueueJob,
): Promise<void> {
  const payload = (job.payload ?? {}) as { eventId?: unknown };
  const eventId =
    typeof payload.eventId === "string" && payload.eventId.length > 0
      ? payload.eventId
      : null;
  if (!eventId) {
    // Malformed payload can never succeed on retry — drop with a loud log.
    console.error(
      `[dealAutomation] job ${job.id} dropped: payload has no eventId`,
    );
    return;
  }
  const summary = await processDealStageEvent(eventId);
  console.log(
    `[dealAutomation] event ${eventId}: ${summary.outcome} ` +
      `(rules=${summary.rulesMatched} ok=${summary.runsSucceeded} ` +
      `failed=${summary.runsFailed} skipped=${summary.runsSkipped})`,
  );
}

/**
 * Re-enqueues pending events that missed their post-commit kick. Shared by
 * the boot catch-up and the admin requeue route; enqueue dedupe makes it
 * safe against events whose jobs are still in flight.
 */
export async function requeuePendingDealStageEvents(opts?: {
  olderThanMs?: number;
  limit?: number;
}): Promise<{ scanned: number; requeued: number }> {
  const olderThanMs = opts?.olderThanMs ?? CATCHUP_MIN_AGE_MS;
  const limit = Math.min(Math.max(opts?.limit ?? CATCHUP_LIMIT, 1), 500);
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await withDbAttribution(
    "dealAutomation:requeuePendingScan",
    async () =>
      getDb()
        .select({ id: dealStageEvents.id })
        .from(dealStageEvents)
        .where(
          and(
            eq(dealStageEvents.status, "pending"),
            lt(dealStageEvents.createdAt, cutoff),
          ),
        )
        .orderBy(asc(dealStageEvents.createdAt))
        .limit(limit),
  );
  let requeued = 0;
  for (const row of rows) {
    await enqueueDealStageAutomationJob(row.id);
    requeued++;
  }
  return { scanned: rows.length, requeued };
}

let bootCatchupTimer: NodeJS.Timeout | null = null;

/**
 * One-shot, deployment-gated catch-up ~30s after boot (NOT an always-on
 * timer — see the module header for why that trade was made). Unref'd so
 * it never holds a process open; DB work runs on the worker pool.
 */
export function scheduleDealAutomationBootCatchup(): void {
  if (bootCatchupTimer) return;
  if (
    !isRunningInDeployment() &&
    process.env.DEAL_AUTOMATION_CATCHUP_FORCE !== "1"
  ) {
    return;
  }
  bootCatchupTimer = setTimeout(() => {
    void runWithWorkerDb(() =>
      requeuePendingDealStageEvents({
        olderThanMs: CATCHUP_MIN_AGE_MS,
        limit: CATCHUP_LIMIT,
      }),
    )
      .then((r) => {
        if (r.requeued > 0) {
          console.log(
            `[dealAutomation] boot catch-up requeued ${r.requeued} stale pending event(s)`,
          );
        }
      })
      .catch((err: any) => {
        console.warn(
          "[dealAutomation] boot catch-up scan failed (next deploy retries):",
          err?.message ?? err,
        );
      });
  }, BOOT_CATCHUP_DELAY_MS);
  bootCatchupTimer.unref?.();
}
