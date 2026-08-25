/**
 * Task #1829 — Front warp-speed class backfill.
 *
 * Brings every existing Front-queue work_queue row up to the modern
 * `workload_class = 'front_ingestion'` standard so the fast-poll
 * loop drains all of them uniformly — even when the master
 * `front_warp_speed_enabled` switch is OFF (rollback mode), where
 * the loop is restricted to `workload_class = 'front_ingestion'`.
 *
 * Without this backfill, ~22k rows enqueued under the legacy
 * `workload_class = 'ingestion'` would only drain while the master
 * switch is ON. After this backfill there is no "legacy" tier —
 * every Front row sits in the modern class and rolls back safely.
 *
 * Scope:
 *   - Only updates rows where queue_name IN (
 *       'front_webhook_normalize',
 *       'front_webhook_apply',
 *       'front_reconciliation'
 *     )
 *     AND workload_class = 'ingestion'
 *     AND status IN ('pending', 'processing', 'leased', 'failed', 'dead_letter')
 *   - Terminal-cancelled / completed rows are LEFT ALONE — no point
 *     reclassifying history.
 *   - No payload, no priority, no dedupe_key, no attempt_count touched.
 *
 * Safety:
 *   - Dry-run by default (prints per-queue counts + sample). `--apply`
 *     runs the UPDATE inside one transaction.
 *   - Idempotent: re-running after `--apply` finds zero candidates.
 *   - Never deletes rows.
 *   - Runs on the worker pool (`getDb` under workerDb attribution
 *     would be ideal, but this is a one-shot operator script — `getDb`
 *     against the request pool is the established pattern for ops
 *     scripts in scripts/).
 *
 * Usage:
 *   npx tsx scripts/front-warp-class-backfill.ts
 *   npx tsx scripts/front-warp-class-backfill.ts --apply
 *
 * IMPORTANT — production: this script reads `DATABASE_URL` which in the
 * dev workspace points at Helium (NOT the deployed Neon prod DB). For
 * production, use the CEO action `front_warp_class_backfill` on
 * `/admin/prod-actions` instead — same SQL, batched 5k/iter with
 * FOR UPDATE SKIP LOCKED, runs against the live prod DB.
 */

import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

const FRONT_QUEUES = [
  "front_webhook_normalize",
  "front_webhook_apply",
  "front_reconciliation",
] as const;

const ELIGIBLE_STATUSES = [
  "pending",
  "processing",
  "leased",
  "failed",
  "dead_letter",
] as const;

type Args = { apply: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") {
      console.log("scripts/front-warp-class-backfill.ts [--apply]");
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const db = getDb();

  console.log("== Front warp-speed class backfill (Task #1829) ==");
  console.log(`Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log("");

  const candidates = await db.execute<{
    queue_name: string;
    status: string;
    n: number;
  }>(sql`
    SELECT queue_name, status, COUNT(*)::int AS n
    FROM work_queue
    WHERE queue_name IN (${sql.join(
      FRONT_QUEUES.map((q) => sql`${q}`),
      sql`, `,
    )})
      AND workload_class = 'ingestion'
      AND status IN (${sql.join(
        ELIGIBLE_STATUSES.map((s) => sql`${s}`),
        sql`, `,
      )})
    GROUP BY queue_name, status
    ORDER BY queue_name, status
  `);

  if (candidates.rows.length === 0) {
    console.log("Nothing to backfill — every Front row is already on");
    console.log("workload_class='front_ingestion'. Exiting cleanly.");
    process.exit(0);
  }

  console.log("Candidate rows (queue × status → count):");
  let total = 0;
  for (const r of candidates.rows) {
    const row = r as { queue_name: string; status: string; n: number };
    total += Number(row.n);
    console.log(
      `  ${row.queue_name.padEnd(30)} ${row.status.padEnd(12)} ${row.n}`,
    );
  }
  console.log(`  ${"".padEnd(30)} ${"TOTAL".padEnd(12)} ${total}`);
  console.log("");

  if (!args.apply) {
    console.log("Dry-run only. Re-run with --apply to commit.");
    process.exit(0);
  }

  console.log("Applying UPDATE inside a single transaction...");
  const updateResult = await db.execute(sql`
    UPDATE work_queue
    SET workload_class = 'front_ingestion',
        updated_at = NOW()
    WHERE queue_name IN (${sql.join(
      FRONT_QUEUES.map((q) => sql`${q}`),
      sql`, `,
    )})
      AND workload_class = 'ingestion'
      AND status IN (${sql.join(
        ELIGIBLE_STATUSES.map((s) => sql`${s}`),
        sql`, `,
      )})
  `);

  const updated = (updateResult as { rowCount?: number }).rowCount ?? 0;
  console.log(`Updated ${updated} row(s).`);
  console.log("");

  const after = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n
    FROM work_queue
    WHERE queue_name IN (${sql.join(
      FRONT_QUEUES.map((q) => sql`${q}`),
      sql`, `,
    )})
      AND workload_class = 'ingestion'
      AND status IN (${sql.join(
        ELIGIBLE_STATUSES.map((s) => sql`${s}`),
        sql`, `,
      )})
  `);
  const remaining = Number((after.rows[0] as { n: number } | undefined)?.n ?? 0);
  console.log(`Remaining legacy rows: ${remaining} (should be 0)`);

  if (remaining > 0) {
    console.error(
      "WARNING: backfill did not move every row. Re-run --apply or investigate.",
    );
    process.exit(1);
  }
  console.log("Backfill complete. Every Front row is now on the modern class.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[front-warp-class-backfill] FAILED:", err);
  process.exit(1);
});
