/**
 * Task #1836 — One-shot operator script.
 *
 * Re-queues `front_webhook_apply` work_queue rows that were dead-lettered
 * because of `apply_state` unique-constraint collisions
 * (`duplicate key value violates unique constraint "as_work_result_target_idx"`).
 *
 * Now that `upsertApplyState` is the canonical writer (Task #1836), these
 * jobs will succeed on retry — the conflict path is handled idempotently
 * via INSERT ... ON CONFLICT DO UPDATE.
 *
 * Usage:
 *   npx tsx scripts/requeue-apply-state-collision-dead-letters.ts          # dry-run
 *   npx tsx scripts/requeue-apply-state-collision-dead-letters.ts --apply  # commit
 *
 * Safety:
 *   - Dry-run by default; prints the count and a sample.
 *   - Only touches rows where:
 *       queue_name        = 'front_webhook_apply'
 *       status            IN ('dead_letter', 'failed')
 *       error_message    LIKE '%as_work_result_target_idx%'
 *   - Resets `status='pending'`, `attempt_count=0`, clears `error_*`, sets
 *     `retry_at=now()`. Does NOT delete rows or modify payload.
 *   - Limit defaults to 1000; override with --limit=N.
 */
import { workerDb } from "../server/db";
import { sql } from "drizzle-orm";

// Drizzle's `.execute()` historically returned the pg `QueryResult` (with
// `.rows`) but in some configurations returns the rows array directly.
// Normalize so downstream code never crashes on `[countRow] = ...`.
function rowsOf<T = any>(res: any): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && Array.isArray(res.rows)) return res.rows as T[];
  return [];
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : 1000;

  if (!Number.isFinite(limit) || limit <= 0) {
    console.error("Invalid --limit, must be a positive integer");
    process.exit(2);
  }

  const filterSql = sql`
    queue_name = 'front_webhook_apply'
    AND status IN ('dead_letter', 'failed')
    AND error_message LIKE '%as_work_result_target_idx%'
  `;

  const countRes = await workerDb.execute<{ count: string | number }>(
    sql`SELECT COUNT(*)::bigint AS count FROM work_queue WHERE ${filterSql}`,
  );
  const countRow = rowsOf<{ count: string | number }>(countRes)[0];
  const totalMatching = Number((countRow as any)?.count ?? 0);

  console.log(
    `Task #1836 requeue: ${totalMatching} matching work_queue row(s) ` +
      `(filter: front_webhook_apply + as_work_result_target_idx error).`,
  );

  if (totalMatching === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  const sampleRes = await workerDb.execute<{
    id: string;
    status: string;
    attempt_count: number;
    error_message: string;
  }>(
    sql`SELECT id, status, attempt_count, error_message
        FROM work_queue
        WHERE ${filterSql}
        ORDER BY updated_at DESC
        LIMIT 5`,
  );
  const sampleRows = rowsOf<{
    id: string;
    status: string;
    attempt_count: number;
    error_message: string;
  }>(sampleRes);
  console.log("\nSample (most recent 5):");
  for (const r of sampleRows) {
    console.log(
      `  - ${r.id}  status=${r.status}  attempt_count=${r.attempt_count}  err=${(r.error_message ?? "").slice(0, 80)}…`,
    );
  }

  if (!apply) {
    console.log(
      `\nDRY RUN — pass --apply to actually re-queue (capped at --limit=${limit}).`,
    );
    process.exit(0);
  }

  const result = await workerDb.execute<{ id: string }>(sql`
    WITH updated AS (
      UPDATE work_queue
      SET status         = 'pending',
          attempt_count  = 0,
          error_code     = NULL,
          error_message  = NULL,
          retry_at       = now(),
          updated_at     = now()
      WHERE id IN (
        SELECT id FROM work_queue
        WHERE ${filterSql}
        ORDER BY updated_at ASC
        LIMIT ${limit}
      )
      RETURNING id
    )
    SELECT id FROM updated
  `);

  const updatedRows = rowsOf<{ id: string }>(result);
  console.log(`\nRe-queued ${updatedRows.length} row(s).`);
  if (updatedRows.length < totalMatching) {
    console.log(
      `Note: ${totalMatching - updatedRows.length} additional matching row(s) remain ` +
        `(capped at --limit=${limit}). Re-run the script to drain the rest.`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("requeue failed:", err);
  process.exit(1);
});
