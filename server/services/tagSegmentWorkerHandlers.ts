// @db-pool-intent: worker
/**
 * Task #4329 — work-queue handler for the tags & segments reconciliation
 * sweep. Thin wrapper: all evaluation logic lives in tagSegmentEngine.ts
 * (ambient pool intent — here it inherits the scheduler's worker context).
 *
 * Queue: tag_segment_reconcile (workloadClass "maintenance"). Producers:
 *   - tagSegmentScheduler.ts periodic tick (deployment-gated, kill-switched)
 *   - POST /api/tags-segments/sweep (manual operator lever)
 * Both enqueue with a stable dedupeKey so at most one sweep is ever
 * pending/processing (partial unique index on work_queue.dedupe_key).
 *
 * No getDb() here — no @db-pool-intent header needed.
 */
import type { WorkQueueJob } from "@shared/schema";
import { workerLog } from "./workerLogger";
import { runTagSegmentReconciliation } from "./tagSegmentEngine";

export async function handleTagSegmentReconcile(_job: WorkQueueJob): Promise<void> {
  const summary = await runTagSegmentReconciliation();
  workerLog({
    worker: "tag_segment_reconcile",
    event: "sweep_completed",
    durationMs: summary.durationMs,
    tagsEvaluated: summary.tagsEvaluated,
    segmentsEvaluated: summary.segmentsEvaluated,
    tagRowsAdded: summary.tagRowsAdded,
    tagRowsRemoved: summary.tagRowsRemoved,
    membersAdded: summary.membersAdded,
    membersRemoved: summary.membersRemoved,
    orphansPruned: summary.orphansPruned,
    error: summary.errors.length > 0 ? summary.errors.join("; ") : undefined,
  });
  // Definition-level failures are recorded in the status setting and the
  // worker log line above, but a sweep that couldn't evaluate ANYTHING it
  // was asked to (all definitions errored) should count as a failed job so
  // the queue's retry/alerting machinery sees it.
  const attempted = summary.tagsEvaluated + summary.segmentsEvaluated + summary.errors.length;
  if (summary.errors.length > 0 && summary.tagsEvaluated + summary.segmentsEvaluated === 0 && attempted > 0) {
    throw new Error(`tag_segment_reconcile: all ${attempted} definitions failed — ${summary.errors[0]}`);
  }
}
