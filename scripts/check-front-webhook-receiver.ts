/**
 * Front webhook receiver liveness check.
 *
 * Task #1602: the May 18 production study found that Front had stopped
 * delivering webhooks since May 15 01:58 UTC, but no operator noticed for
 * days because there was no standing receiver-staleness signal. This script
 * collapses the manual SQL investigation into one command.
 *
 * Default: reads the local workspace DB via `DATABASE_URL`. Useful during
 * dev and to verify Replit Auth / DB connectivity. For prod inspection,
 * paste the printed SQL into the read-only prod SQL tool.
 *
 * Usage:
 *   npx tsx scripts/check-front-webhook-receiver.ts
 *   npx tsx scripts/check-front-webhook-receiver.ts --print-sql
 */

import { Pool } from "pg";

const RECEIVER_SQL = `
  SELECT 'source_event_log front' AS what,
         MAX(received_at) AS last_at,
         COUNT(*) FILTER (WHERE received_at > now() - interval '1 hour') AS last_1h,
         COUNT(*) FILTER (WHERE received_at > now() - interval '24 hours') AS last_24h
    FROM source_event_log WHERE source_system='front'
  UNION ALL
  SELECT 'work_queue normalize enqueued',
         MAX(created_at),
         COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour'),
         COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')
    FROM work_queue WHERE queue_name='front_webhook_normalize'
  UNION ALL
  SELECT 'work_queue normalize completed',
         MAX(completed_at),
         COUNT(*) FILTER (WHERE completed_at > now() - interval '1 hour'),
         COUNT(*) FILTER (WHERE completed_at > now() - interval '24 hours')
    FROM work_queue WHERE queue_name='front_webhook_normalize'
  UNION ALL
  SELECT 'work_queue apply enqueued',
         MAX(created_at),
         COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour'),
         COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')
    FROM work_queue WHERE queue_name='front_webhook_apply'
  UNION ALL
  SELECT 'work_queue apply completed',
         MAX(completed_at),
         COUNT(*) FILTER (WHERE completed_at > now() - interval '1 hour'),
         COUNT(*) FILTER (WHERE completed_at > now() - interval '24 hours')
    FROM work_queue WHERE queue_name='front_webhook_apply'
`;

const BACKLOG_SQL = `
  SELECT queue_name, status, COUNT(*) AS n,
         MIN(created_at) AS oldest,
         MAX(updated_at) AS last_touched
    FROM work_queue
   WHERE queue_name IN ('front_webhook_normalize','front_webhook_apply')
   GROUP BY queue_name, status
   ORDER BY queue_name, status
`;

function fmtAge(d: Date | null): string {
  if (!d) return "(never)";
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

async function main(): Promise<void> {
  if (process.argv.includes("--print-sql")) {
    console.log("-- Front webhook receiver liveness --");
    console.log(RECEIVER_SQL.trim() + ";");
    console.log("\n-- Backlog by status --");
    console.log(BACKLOG_SQL.trim() + ";");
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set. Use --print-sql to dump the SQL for the prod read-only tool.");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const receiver = await pool.query<{
      what: string;
      last_at: Date | null;
      last_1h: string;
      last_24h: string;
    }>(RECEIVER_SQL);

    console.log("Front webhook pipeline liveness");
    console.log("-".repeat(78));
    for (const row of receiver.rows) {
      const ageNote = fmtAge(row.last_at);
      console.log(
        `  ${row.what.padEnd(34)} last=${row.last_at?.toISOString() ?? "(never)"}  (${ageNote})  1h=${row.last_1h}  24h=${row.last_24h}`,
      );
    }

    const backlog = await pool.query<{
      queue_name: string;
      status: string;
      n: string;
      oldest: Date | null;
      last_touched: Date | null;
    }>(BACKLOG_SQL);
    console.log("\nBacklog by status");
    console.log("-".repeat(78));
    if (backlog.rows.length === 0) {
      console.log("  (no rows)");
    } else {
      for (const row of backlog.rows) {
        console.log(
          `  ${row.queue_name.padEnd(24)} ${row.status.padEnd(14)} n=${String(row.n).padStart(6)}  oldest=${fmtAge(row.oldest)}  last_touched=${fmtAge(row.last_touched)}`,
        );
      }
    }

    const receiverRow = receiver.rows.find((r) => r.what === "source_event_log front");
    if (receiverRow && receiverRow.last_at) {
      const ageMs = Date.now() - receiverRow.last_at.getTime();
      console.log("");
      if (ageMs > 60 * 60 * 1000) {
        console.log(
          `WARN: last Front webhook received ${fmtAge(receiverRow.last_at)} — check Front dashboard webhook delivery log and verify webhook is enabled. See PROD_REMEDIATION.md § 1.`,
        );
        process.exitCode = 2;
      } else {
        console.log(`OK: Front receiver active (last ${fmtAge(receiverRow.last_at)}).`);
      }
    } else {
      console.log("\nWARN: source_event_log has no Front rows at all in this DB.");
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("check-front-webhook-receiver failed:", err);
  process.exit(1);
});
