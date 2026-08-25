/**
 * Task #1050: replay + classification cleanup for SEMrush dead-letters.
 *
 * Two operations, one script:
 *
 *   1. Backfill `work_queue.error_code` on existing dead-letter rows in
 *      the SEMrush queues where the freeform `error_message` is
 *      unambiguous (db connection timeouts, undici fetch failures,
 *      breaker-open). Rows that classify as `unknown` are left alone
 *      so we don't overwrite a future, more-specific classifier.
 *
 *   2. Replay recent transient dead-letters — rows whose (post-backfill)
 *      `error_code` is `db_connection_timeout` or `external_fetch_failed`
 *      and whose `completed_at` is within the last 30 days. We
 *      deliberately key the window on `completed_at` (the immutable
 *      timestamp set when the job dead-lettered) rather than
 *      `updated_at` so a backfill `UPDATE` cannot retroactively pull
 *      historical rows back into the replay window. Replay resets the
 *      row to `pending` with `attempt_count = 0`, mirroring
 *      `replayDeadLetteredJob` in workScheduler.ts so the scheduler
 *      picks it up on the next tick.
 *
 * Scope: queues `semrush_report_refresh` and `semrush_background_refresh`
 * only. Other queues are out of scope for #1050.
 *
 * Default mode is dry-run — prints counts and a sample. Pass `--apply`
 * to commit. Idempotent: re-running after `--apply` is a no-op once
 * dead-letter inflow stays flat.
 *
 * Usage:
 *   tsx scripts/replay-semrush-transient-dead-letters.ts            # dry-run
 *   tsx scripts/replay-semrush-transient-dead-letters.ts --apply    # commit
 */
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { bindArrayParam } from "../server/utils/sqlArray";
import {
  classifyWorkQueueErrorMessage,
  TRANSIENT_ERROR_CODES,
  type WorkQueueErrorCode,
} from "../server/services/workQueueErrorClassifier";

const APPLY = process.argv.includes("--apply");
const SEMRUSH_QUEUES = ["semrush_report_refresh", "semrush_background_refresh"] as const;
const REPLAY_WINDOW_DAYS = 30;

type DeadLetterRow = {
  id: string;
  queue_name: string;
  error_message: string | null;
  error_code: WorkQueueErrorCode | null;
  completed_at: Date | null;
};

function fmt(label: string, n: number): string {
  return `${label}=${n}`;
}

async function main(): Promise<void> {
  console.log(
    `[ReplaySemrushDeadLetters] Mode: ${APPLY ? "APPLY" : "DRY-RUN"} ` +
      `(pass --apply to commit). Window: ${REPLAY_WINDOW_DAYS}d. ` +
      `Queues: ${SEMRUSH_QUEUES.join(", ")}`,
  );

  // Pull every dead-letter row in the two SEMrush queues. The total
  // population is small (hundreds, not millions) so we classify in JS
  // and avoid baking the regex taxonomy into SQL.
  const queryRes: any = await workerDb.execute(sql`
    SELECT id, queue_name, error_message, error_code, completed_at
    FROM work_queue
    WHERE status = 'dead_letter'
      AND queue_name = ANY(ARRAY['semrush_report_refresh', 'semrush_background_refresh'])
    ORDER BY completed_at DESC NULLS LAST
  `);
  const rows = (Array.isArray(queryRes) ? queryRes : queryRes.rows ?? []) as DeadLetterRow[];

  console.log(`[ReplaySemrushDeadLetters] Found ${rows.length} dead-lettered rows total.`);

  // ---- Step 1: backfill error_code where unambiguous ----
  const backfillByCode = new Map<WorkQueueErrorCode, string[]>();
  let alreadyClassified = 0;
  let stillUnknown = 0;
  for (const row of rows) {
    if (row.error_code && row.error_code !== "unknown") {
      alreadyClassified += 1;
      continue;
    }
    const classified = classifyWorkQueueErrorMessage(row.error_message);
    if (classified === "unknown") {
      stillUnknown += 1;
      continue;
    }
    if (!backfillByCode.has(classified)) backfillByCode.set(classified, []);
    backfillByCode.get(classified)!.push(row.id);
  }

  const backfillTotal = Array.from(backfillByCode.values()).reduce((s, a) => s + a.length, 0);
  console.log(
    `[ReplaySemrushDeadLetters] Backfill: ${fmt("alreadyClassified", alreadyClassified)} ` +
      `${fmt("stillUnknown", stillUnknown)} ${fmt("toBackfill", backfillTotal)}`,
  );
  for (const [code, ids] of backfillByCode.entries()) {
    console.log(`   error_code=${code} → ${ids.length} rows`);
  }

  if (APPLY && backfillTotal > 0) {
    for (const [code, ids] of backfillByCode.entries()) {
      // Chunk to keep the param array bounded.
      const chunkSize = 500;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        // Intentionally do NOT touch `updated_at` here. The replay
        // step below uses `completed_at` for the 30-day window, but a
        // future operator (or admin UI) might filter by `updated_at`
        // for "recently changed" rows; bumping it on every backfill
        // pass would muddle that signal for what is purely a
        // taxonomy-cleanup write.
        await workerDb.execute(sql`
          UPDATE work_queue
          SET error_code = ${code}
          WHERE id = ANY(${bindArrayParam(chunk, "varchar")})
            AND status = 'dead_letter'
        `);
      }
      console.log(`   ✓ backfilled error_code=${code} on ${ids.length} rows`);
    }
  }

  // ---- Step 2: replay transient dead-letters within window ----
  // Use the post-backfill view of error_code: a row is replay-eligible
  // if either (a) it already had a transient error_code, or (b) we just
  // identified it as transient in step 1.
  // Window is keyed on `completed_at` — set when the job dead-lettered
  // and never mutated afterward — so repeated runs can never pull
  // historical rows back into scope. Rows missing a `completed_at`
  // (shouldn't happen for status='dead_letter' but defensively
  // checked) are skipped rather than treated as recent.
  const cutoffMs = Date.now() - REPLAY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const replayIds: string[] = [];
  const replaySample: DeadLetterRow[] = [];
  for (const row of rows) {
    const completedAt = row.completed_at ? new Date(row.completed_at) : null;
    if (!completedAt || completedAt.getTime() < cutoffMs) continue;
    const effective: WorkQueueErrorCode =
      row.error_code && row.error_code !== "unknown"
        ? row.error_code
        : classifyWorkQueueErrorMessage(row.error_message);
    if (!TRANSIENT_ERROR_CODES.has(effective)) continue;
    replayIds.push(row.id);
    if (replaySample.length < 10) replaySample.push(row);
  }

  console.log(
    `[ReplaySemrushDeadLetters] Replay: ${fmt("eligible", replayIds.length)} ` +
      `(transient + within ${REPLAY_WINDOW_DAYS}d window)`,
  );
  for (const r of replaySample) {
    const code =
      r.error_code && r.error_code !== "unknown"
        ? r.error_code
        : classifyWorkQueueErrorMessage(r.error_message);
    const msg = (r.error_message ?? "").slice(0, 120).replace(/\s+/g, " ");
    console.log(`   ${r.id} queue=${r.queue_name} code=${code} msg="${msg}"`);
  }
  if (replayIds.length > replaySample.length) {
    console.log(`   …and ${replayIds.length - replaySample.length} more.`);
  }

  if (!APPLY) {
    console.log(
      "[ReplaySemrushDeadLetters] Dry-run complete. Re-run with --apply to commit.",
    );
    return;
  }

  if (replayIds.length === 0) {
    console.log("[ReplaySemrushDeadLetters] Nothing to replay.");
    return;
  }

  const chunkSize = 500;
  let replayed = 0;
  for (let i = 0; i < replayIds.length; i += chunkSize) {
    const chunk = replayIds.slice(i, i + chunkSize);
    const res: any = await workerDb.execute(sql`
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
          updated_at = NOW()
      WHERE id = ANY(${bindArrayParam(chunk, "varchar")})
        AND status = 'dead_letter'
      RETURNING id
    `);
    const updatedRows = (Array.isArray(res) ? res : res.rows ?? []) as Array<{ id: string }>;
    replayed += updatedRows.length;
  }
  console.log(`[ReplaySemrushDeadLetters] ✓ replayed ${replayed} dead-lettered jobs.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[ReplaySemrushDeadLetters] FAILED:", err);
    process.exit(1);
  });
