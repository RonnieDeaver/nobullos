/**
 * Task #1025: one-shot collapse of the duplicate `retroactive_reprocess`
 * pending backlog.
 *
 * Background: a version-stamped dedupe key on the periodic sweep
 * (`periodic:retroactive_reprocess:v${version}:${clientId}`) caused
 * each sweep to insert a fresh pending row per active client whenever
 * the consumer ran slower than the sweep. Production grew to ~91k
 * pending rows across 57 clients before the producer fix landed.
 *
 * Collapse strategy: for every clientId with pending
 * `retroactive_reprocess` rows, keep the OLDEST pending row (it
 * represents the work the consumer already had in line) and cancel
 * the rest with audit reason
 * `collapsed_duplicate_periodic_enqueue_task_1025` written to
 * `error_message`. The cancelled rows transition to status
 * `cancelled` with `completed_at = now()`.
 *
 * Idempotency: re-running is safe — the next pass picks up only the
 * clients whose pending count regressed back to >= 2 (which the
 * producer ceiling now prevents from happening).
 *
 * Default mode is dry-run: prints the per-client kill counts but
 * makes no writes. Pass `--apply` to actually cancel the rows.
 */
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";

const APPLY = process.argv.includes("--apply");
const REASON = "collapsed_duplicate_periodic_enqueue_task_1025";

async function main(): Promise<void> {
  console.log(
    `[CollapseRetroactiveBacklog] Mode: ${APPLY ? "APPLY" : "DRY-RUN"} (pass --apply to commit)`,
  );

  const summaryRows = await workerDb.execute(sql`
    SELECT
      payload->>'clientId' AS client_id,
      COUNT(*)::int AS pending_count
    FROM work_queue
    WHERE queue_name = 'retroactive_reprocess'
      AND status = 'pending'
      AND payload ? 'clientId'
    GROUP BY payload->>'clientId'
    ORDER BY pending_count DESC, client_id ASC
  `);
  const summary = (Array.isArray(summaryRows) ? summaryRows : (summaryRows as any).rows ?? []) as Array<{
    client_id: string;
    pending_count: number;
  }>;

  const totalPending = summary.reduce((s, r) => s + Number(r.pending_count ?? 0), 0);
  const collapsibleClients = summary.filter((r) => Number(r.pending_count) > 1);
  const collapsibleRows = collapsibleClients.reduce(
    (s, r) => s + (Number(r.pending_count) - 1),
    0,
  );
  console.log(
    `[CollapseRetroactiveBacklog] ${summary.length} clients, ${totalPending} pending rows total. ` +
      `${collapsibleClients.length} clients have duplicates → would cancel ${collapsibleRows} rows.`,
  );
  for (const row of collapsibleClients.slice(0, 25)) {
    console.log(
      `   client=${row.client_id} pending=${row.pending_count} → keep 1, cancel ${Number(row.pending_count) - 1}`,
    );
  }
  if (collapsibleClients.length > 25) {
    console.log(`   …and ${collapsibleClients.length - 25} more clients.`);
  }

  if (!APPLY) {
    console.log("[CollapseRetroactiveBacklog] Dry-run complete. Re-run with --apply to commit.");
    return;
  }

  if (collapsibleRows === 0) {
    console.log("[CollapseRetroactiveBacklog] Nothing to cancel.");
    return;
  }

  // Single CTE: rank pending rows per clientId by created_at, cancel
  // every row except rn=1 (the oldest). `error_message` records the
  // audit reason. `completed_at` is set so cancelled rows fall out of
  // pending counts immediately.
  const result = await workerDb.execute(sql`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY payload->>'clientId'
          ORDER BY created_at ASC, id ASC
        ) AS rn
      FROM work_queue
      WHERE queue_name = 'retroactive_reprocess'
        AND status = 'pending'
        AND payload ? 'clientId'
    )
    UPDATE work_queue wq
    SET status = 'cancelled',
        error_message = ${REASON},
        completed_at = NOW()
    FROM ranked r
    WHERE wq.id = r.id
      AND r.rn > 1
    RETURNING wq.id
  `);
  const updated = Array.isArray(result) ? result : (result as any).rows ?? [];
  console.log(`[CollapseRetroactiveBacklog] Cancelled ${updated.length} duplicate rows.`);

  const after = await workerDb.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM work_queue
    WHERE queue_name = 'retroactive_reprocess' AND status = 'pending'
  `);
  const afterRows = Array.isArray(after) ? after : (after as any).rows ?? [];
  console.log(
    `[CollapseRetroactiveBacklog] Remaining pending after collapse: ${afterRows[0]?.count ?? "?"}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[CollapseRetroactiveBacklog] Fatal:", err);
    process.exit(1);
  });
