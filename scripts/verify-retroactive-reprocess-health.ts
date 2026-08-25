/**
 * Task #1047: operational verification hooks for the
 * `retroactive_reprocess` queue. Run after the Task #1047 deploy
 * (schema drift fix + backlog collapse via
 * `scripts/collapse-retroactive-reprocess-backlog.ts --apply`) and
 * again 24h / 48h later to confirm the "Done looks like" outcomes.
 *
 * Reports:
 *   - pending count            (target: < 200, one per active client)
 *   - oldest pending age       (target: < 24h within 48h of collapse)
 *   - per-client pending top-N (any row above
 *                               RETROACTIVE_REPROCESS_PENDING_PER_CLIENT_MAX
 *                               means the producer ceiling regressed)
 *   - failure mix in last 24h  (target: zero
 *                               `column "pipeline_state" does not exist`)
 *   - stale processing rows    (rows held > STUCK_JOB_MAX_AGE_MS;
 *                               overlaps with the stale-lease task)
 *   - effective concurrency    (RETROACTIVE_REPROCESS_CONCURRENCY,
 *                               worker pool max, kill-switch state)
 *
 * Read-only — safe to run on production at any time.
 */
import { sql, type SQL } from "drizzle-orm";
import { workerDb } from "../server/db";
import { PERF } from "../server/perfConfig";
import { isKillSwitchEnabled } from "../server/services/killSwitches";

const QUEUE = "retroactive_reprocess";

interface StatusCountRow { status: string; count: number | string | null }
interface OldestRow { created_at: string | Date | null }
interface PerClientRow { client_id: string; count: number | string | null; oldest: string | Date | null }
interface FailureMixRow { error_message: string | null; count: number | string | null }
interface StaleProcessingRow { count: number | string | null }

function fmtAge(ms: number): string {
  const h = ms / 3_600_000;
  if (h >= 24) return `${(h / 24).toFixed(1)}d (${h.toFixed(1)}h)`;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function toDate(value: string | Date | null): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

async function rows<T>(query: SQL): Promise<T[]> {
  const result = await workerDb.execute(query);
  if (Array.isArray(result)) return result as T[];
  const maybeRows = (result as { rows?: T[] }).rows;
  return Array.isArray(maybeRows) ? maybeRows : [];
}

async function main(): Promise<void> {
  const now = Date.now();
  console.log(`[VerifyRetroactiveHealth] Queue: ${QUEUE}  @ ${new Date(now).toISOString()}`);

  const totals = await rows<StatusCountRow>(sql`
    SELECT status, COUNT(*)::int AS count
    FROM work_queue
    WHERE queue_name = ${QUEUE}
    GROUP BY status
    ORDER BY status ASC
  `);
  const totalsMap: Record<string, number> = {};
  for (const t of totals) totalsMap[t.status] = Number(t.count ?? 0);
  const pending = totalsMap.pending ?? 0;
  console.log(`[VerifyRetroactiveHealth] Status mix:`, totalsMap);
  console.log(
    `[VerifyRetroactiveHealth] Pending: ${pending} (target < 200; ` +
      `${pending < 200 ? "OK" : "OVER TARGET"})`,
  );

  const oldest = await rows<OldestRow>(sql`
    SELECT MIN(created_at) AS created_at
    FROM work_queue
    WHERE queue_name = ${QUEUE} AND status = 'pending'
  `);
  const oldestDate = toDate(oldest[0]?.created_at ?? null);
  if (oldestDate) {
    const ageMs = now - oldestDate.getTime();
    console.log(
      `[VerifyRetroactiveHealth] Oldest pending: ${oldestDate.toISOString()}  age=${fmtAge(ageMs)}` +
        `  (target < 24h within 48h of collapse; ${ageMs < 24 * 3_600_000 ? "OK" : "OVER TARGET"})`,
    );
  } else {
    console.log(`[VerifyRetroactiveHealth] Oldest pending: none`);
  }

  const ceiling = PERF.RETROACTIVE_REPROCESS_PENDING_PER_CLIENT_MAX;
  const perClient = await rows<PerClientRow>(sql`
    SELECT
      payload->>'clientId' AS client_id,
      COUNT(*)::int AS count,
      MIN(created_at) AS oldest
    FROM work_queue
    WHERE queue_name = ${QUEUE}
      AND status = 'pending'
      AND payload ? 'clientId'
    GROUP BY payload->>'clientId'
    ORDER BY count DESC, client_id ASC
    LIMIT 25
  `);
  console.log(`[VerifyRetroactiveHealth] Top per-client pending (ceiling=${ceiling}):`);
  let breaches = 0;
  for (const r of perClient) {
    const count = Number(r.count ?? 0);
    const breach = count > ceiling;
    if (breach) breaches++;
    const oldestStr = toDate(r.oldest)?.toISOString() ?? "n/a";
    console.log(
      `   client=${r.client_id}  pending=${count}  oldest=${oldestStr}` +
        `${breach ? "  ⚠ OVER PRODUCER CEILING" : ""}`,
    );
  }
  if (breaches > 0) {
    console.log(
      `[VerifyRetroactiveHealth] ⚠ ${breaches} client(s) above ceiling — producer dedupe (Task #1025) regressed.`,
    );
  }

  const since = new Date(now - 24 * 3_600_000);
  const failures = await rows<FailureMixRow>(sql`
    SELECT
      COALESCE(NULLIF(error_message, ''), '<null>') AS error_message,
      COUNT(*)::int AS count
    FROM work_queue
    WHERE queue_name = ${QUEUE}
      AND status = 'failed'
      AND completed_at >= ${since}
    GROUP BY error_message
    ORDER BY count DESC
    LIMIT 15
  `);
  console.log(`[VerifyRetroactiveHealth] Failure mix (last 24h):`);
  if (failures.length === 0) {
    console.log(`   (no failed rows in window)`);
  } else {
    for (const f of failures) {
      const message = f.error_message ?? "";
      const isDrift = message.includes(`column "pipeline_state" does not exist`);
      console.log(
        `   count=${Number(f.count ?? 0)}  ${isDrift ? "⚠ SCHEMA DRIFT — " : ""}${message.slice(0, 200)}`,
      );
    }
  }

  const stuckCutoff = new Date(now - PERF.STUCK_JOB_MAX_AGE_MS);
  const stuckProcessing = await rows<StaleProcessingRow>(sql`
    SELECT COUNT(*)::int AS count
    FROM work_queue
    WHERE queue_name = ${QUEUE}
      AND status = 'processing'
      AND leased_at IS NOT NULL
      AND leased_at <= ${stuckCutoff}
  `);
  const stuckCount = Number(stuckProcessing[0]?.count ?? 0);
  console.log(
    `[VerifyRetroactiveHealth] Stale processing (leased_at older than ${
      PERF.STUCK_JOB_MAX_AGE_MS / 3_600_000
    }h): ${stuckCount}  (stale-lease task owns reclaim — escalate if non-zero and growing)`,
  );

  console.log(
    `[VerifyRetroactiveHealth] Concurrency: RETROACTIVE_REPROCESS_CONCURRENCY=${
      PERF.RETROACTIVE_REPROCESS_CONCURRENCY
    }  workerPoolMax=7  killSwitchEngaged=${isKillSwitchEnabled(QUEUE)}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[VerifyRetroactiveHealth] Fatal:", err);
    process.exit(1);
  });
