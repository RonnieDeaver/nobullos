// @db-pool-intent: worker
/**
 * Task #4333 — work-queue handler for the deal/lead score recompute sweep.
 * Thin wrapper: all scoring logic lives in scoringEngine.ts (ambient pool
 * intent — here it inherits the scheduler's worker context).
 *
 * Queue: score_recompute (workloadClass "maintenance"). Sole producer is
 * the scoringScheduler.ts periodic tick (deployment-gated, kill-switched),
 * which enqueues with a stable dedupeKey so at most one sweep is ever
 * pending/processing (partial unique index on work_queue.dedupe_key).
 * The manual operator lever (POST /api/scoring/:entityType/recompute)
 * recomputes synchronously in the request instead of enqueueing.
 *
 * No getDb() here — no @db-pool-intent header needed.
 */
import type { WorkQueueJob } from "@shared/schema";
import { workerLog } from "./workerLogger";
import { runScoringSweep } from "./scoringEngine";

export async function handleScoreRecompute(_job: WorkQueueJob): Promise<void> {
  const summary = await runScoringSweep();
  workerLog({
    worker: "score_recompute",
    event: "sweep_completed",
    durationMs: summary.durationMs,
    recordsScored: summary.recordsScored,
    rowsWritten: summary.rowsWritten,
    orphansReaped: summary.orphansReaped,
    cleared: summary.cleared,
    notes: summary.notes.length > 0 ? summary.notes.join("; ") : undefined,
    error: summary.errors.length > 0 ? summary.errors.join("; ") : undefined,
  });
  // Per-entity-type failures are recorded in the status setting and the
  // worker log line above, but a sweep that scored NOTHING while errors
  // occurred should count as a failed job so the queue's retry/alerting
  // machinery sees it.
  if (summary.errors.length > 0 && summary.recordsScored === 0) {
    throw new Error(`score_recompute: sweep failed — ${summary.errors[0]}`);
  }
}
