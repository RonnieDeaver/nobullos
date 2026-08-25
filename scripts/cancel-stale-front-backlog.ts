/**
 * Task #1787 Stage 2 — Cancel stale Front backlog rows (failed + dead_letter)
 * across the four Front queues. Pending and processing rows are NEVER
 * touched (those are live Conversation Hub work).
 *
 * Behaviour
 * ---------
 * Default mode is dry-run: counts how many rows would be cancelled per
 * queue × status, and prints a small sample. `--apply` runs the actual
 * UPDATE inside a transaction. The error_message gets the prefix
 * `[backlog-flush 2026-05] ` so the cancellation is auditable. Rows are
 * never deleted.
 *
 * Idempotent: re-running after `--apply` finds zero candidates.
 *
 * Usage:
 *   tsx scripts/cancel-stale-front-backlog.ts
 *   tsx scripts/cancel-stale-front-backlog.ts --apply
 */

import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
import { bindArrayParam } from "../server/utils/sqlArray";

const FRONT_QUEUES = [
  "front_sync_reprocess",
  "front_webhook_apply",
  "front_webhook_normalize",
  "front_analytics_coverage_refresh",
] as const;

const CANCELLABLE_STATUSES = ["failed", "dead_letter"] as const;
const PREFIX = "[backlog-flush 2026-05] ";

type Args = { apply: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") {
      console.log("scripts/cancel-stale-front-backlog.ts [--apply]");
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

  console.log("== Cancel stale Front backlog ==");
  console.log(`Mode: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log("");

  const beforeRows = await db.execute(sql`
    SELECT queue_name, status, COUNT(*)::int AS n
    FROM work_queue
    WHERE queue_name = ANY(${bindArrayParam([...FRONT_QUEUES], "text")})
      AND status = ANY(${bindArrayParam([...CANCELLABLE_STATUSES], "text")})
    GROUP BY queue_name, status
    ORDER BY queue_name, status
  `);
  console.log("Cancellation candidates (failed + dead_letter only):");
  let total = 0;
  for (const r of beforeRows.rows as any[]) {
    console.log(`  ${r.queue_name} / ${r.status}: ${r.n}`);
    total += Number(r.n);
  }
  console.log(`  TOTAL: ${total}`);
  console.log("");

  if (total === 0) {
    console.log("Nothing to cancel — exiting.");
    return;
  }

  // Small sample so operators can eyeball before applying.
  const sample = await db.execute(sql`
    SELECT id, queue_name, status, attempts, error_code,
           LEFT(COALESCE(error_message, ''), 120) AS error_message_snippet,
           created_at, updated_at
    FROM work_queue
    WHERE queue_name = ANY(${bindArrayParam([...FRONT_QUEUES], "text")})
      AND status = ANY(${bindArrayParam([...CANCELLABLE_STATUSES], "text")})
    ORDER BY updated_at DESC
    LIMIT 5
  `);
  console.log("Sample (newest 5 by updated_at):");
  for (const r of sample.rows as any[]) {
    console.log(
      `  [${r.queue_name}/${r.status}] id=${r.id} attempts=${r.attempts} ` +
        `error_code=${r.error_code ?? "—"} updated=${r.updated_at} msg="${r.error_message_snippet}"`,
    );
  }
  console.log("");

  if (!args.apply) {
    console.log("Dry-run complete. Re-run with --apply to perform the cancellation.");
    return;
  }

  // Transactional apply
  await db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE work_queue
      SET status = 'cancelled',
          error_message = CASE
            WHEN error_message IS NULL OR error_message = ''
              THEN ${PREFIX} || status
            ELSE ${PREFIX} || error_message
          END,
          updated_at = NOW()
      WHERE queue_name = ANY(${bindArrayParam([...FRONT_QUEUES], "text")})
        AND status = ANY(${bindArrayParam([...CANCELLABLE_STATUSES], "text")})
      RETURNING queue_name
    `);
    const tally: Record<string, number> = {};
    for (const r of updated.rows as any[]) {
      tally[r.queue_name] = (tally[r.queue_name] ?? 0) + 1;
    }
    console.log("Cancelled per queue:");
    for (const [q, n] of Object.entries(tally)) {
      console.log(`  ${q}: ${n}`);
    }
    console.log(`  TOTAL cancelled: ${updated.rowCount}`);
  });

  const after = await db.execute(sql`
    SELECT queue_name, status, COUNT(*)::int AS n
    FROM work_queue
    WHERE queue_name = ANY(${bindArrayParam([...FRONT_QUEUES], "text")})
    GROUP BY queue_name, status
    ORDER BY queue_name, status
  `);
  console.log("");
  console.log("Post-apply counts (all statuses):");
  for (const r of after.rows as any[]) {
    console.log(`  ${r.queue_name} / ${r.status}: ${r.n}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
  });
