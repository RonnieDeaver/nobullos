/**
 * Task #1047: defensive boot-time collapse of duplicate
 * `retroactive_reprocess` pending rows.
 *
 * The producer-side ceiling shipped in Task #1025
 * (`enqueueRetroactiveReprocessSafe`) prevents NEW duplicates from
 * accumulating, and the one-shot script
 * `scripts/collapse-retroactive-reprocess-backlog.ts` is the
 * operator-driven path for collapsing an existing backlog. This
 * module runs the same idempotent CTE at server boot, gated by a
 * threshold, so a deploy onto an environment that still carries
 * pre-#1025 duplicates self-heals without an operator having to run
 * the script by hand.
 *
 * Strategy (must match the script byte-for-byte): for every clientId
 * with pending `retroactive_reprocess` rows, keep the OLDEST pending
 * row and cancel the rest with
 * `error_message='collapsed_duplicate_periodic_enqueue_task_1025'`
 * and `completed_at = now()`. The audit reason is shared with the
 * script so downstream queries treat both code paths uniformly.
 *
 * Idempotent: when no clientId has more than one pending row this is
 * a no-op. Safe to run on every boot.
 */
import { sql } from "drizzle-orm";
import { workerDb } from "../db";

const QUEUE = "retroactive_reprocess";
const COLLAPSE_REASON = "collapsed_duplicate_periodic_enqueue_task_1025";

// Only run the collapse if the total pending count is meaningfully
// over the per-client ceiling × known-active-clients. A handful of
// duplicates can appear briefly during normal operation (between the
// producer ceiling check and the insert); waiting until the backlog
// is non-trivial avoids touching the work_queue every boot for a
// no-op pass.
const COLLAPSE_TRIGGER_PENDING_COUNT = 200;

export interface BootCollapseResult {
  ranAt: string;
  pendingBefore: number;
  pendingAfter: number;
  cancelled: number;
  triggered: boolean;
}

interface PendingCountRow {
  count: number | string | null;
}

interface CancelledIdRow {
  id: string;
}

async function readPendingCount(): Promise<number> {
  const result = await workerDb.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM work_queue
    WHERE queue_name = ${QUEUE} AND status = 'pending'
  `);
  const list = (Array.isArray(result) ? result : (result as unknown as { rows?: PendingCountRow[] }).rows ?? []) as PendingCountRow[];
  return Number(list[0]?.count ?? 0);
}

export async function collapseRetroactiveReprocessBacklogOnBoot(): Promise<BootCollapseResult> {
  const ranAt = new Date().toISOString();
  const pendingBefore = await readPendingCount();

  if (pendingBefore < COLLAPSE_TRIGGER_PENDING_COUNT) {
    return { ranAt, pendingBefore, pendingAfter: pendingBefore, cancelled: 0, triggered: false };
  }

  const cancelResult = await workerDb.execute(sql`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY payload->>'clientId'
          ORDER BY created_at ASC, id ASC
        ) AS rn
      FROM work_queue
      WHERE queue_name = ${QUEUE}
        AND status = 'pending'
        AND payload ? 'clientId'
    )
    UPDATE work_queue wq
    SET status = 'cancelled',
        error_message = ${COLLAPSE_REASON},
        completed_at = NOW()
    FROM ranked r
    WHERE wq.id = r.id
      AND r.rn > 1
    RETURNING wq.id
  `);
  const cancelledList = (Array.isArray(cancelResult)
    ? cancelResult
    : (cancelResult as unknown as { rows?: CancelledIdRow[] }).rows ?? []) as CancelledIdRow[];
  const cancelled = cancelledList.length;
  const pendingAfter = await readPendingCount();
  return { ranAt, pendingBefore, pendingAfter, cancelled, triggered: true };
}
