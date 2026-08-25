/**
 * Task #1058 — Backfill `failure_reason` for call_analysis_jobs rows
 * that failed before Task #1049 shipped.
 *
 * Background
 * ----------
 * Task #1049 added the typed `failure_reason` column and started
 * populating it on every new failure via `classifyFailure()`. Rows
 * that failed before deploy still have NULL failure_reason, so the
 * Task #1049 dashboard / metrics under-report history. The
 * free-text `error_message` strings on those rows are the same
 * patterns `classifyFailure()` already handles, so re-running it
 * against the existing rows fills in the gap cleanly.
 *
 * Behaviour
 * ---------
 * Default mode is dry-run: it scans `call_analysis_jobs` for
 * status='failed' AND failure_reason IS NULL, runs `classifyFailure`
 * against each row's `errorMessage`, and prints the planned reason
 * distribution. `--apply` writes the reasons via UPDATE. Idempotent
 * — rows that already have a non-NULL `failure_reason` are skipped
 * by the WHERE clause, so re-runs are safe.
 *
 * Usage:
 *   tsx scripts/backfill-call-analysis-failure-reasons.ts
 *   tsx scripts/backfill-call-analysis-failure-reasons.ts --apply
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../server/db";
import { bindArrayParam } from "../server/utils/sqlArray";
import { callAnalysisJobs, type CallAnalysisFailureReason } from "@shared/schema";
import { classifyFailure } from "../server/services/callAnalysis";

type Args = { apply: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") {
      console.log("scripts/backfill-call-analysis-failure-reasons.ts [--apply]");
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

  const rows = await db
    .select({
      analysisId: callAnalysisJobs.analysisId,
      errorMessage: callAnalysisJobs.errorMessage,
    })
    .from(callAnalysisJobs)
    .where(
      and(
        eq(callAnalysisJobs.status, "failed"),
        isNull(callAnalysisJobs.failureReason),
      ),
    );

  if (rows.length === 0) {
    console.log(
      `[backfill-call-analysis-failure-reasons] No failed rows with NULL failure_reason. Nothing to do.`,
    );
    return;
  }

  console.log(
    `[backfill-call-analysis-failure-reasons] Found ${rows.length} failed row(s) with NULL failure_reason.`,
  );

  const counts = new Map<CallAnalysisFailureReason, number>();
  const planned: Array<{ analysisId: string; reason: CallAnalysisFailureReason }> = [];
  for (const r of rows) {
    const reason = classifyFailure({ message: r.errorMessage ?? "" });
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    planned.push({ analysisId: r.analysisId, reason });
  }

  console.log(`[backfill-call-analysis-failure-reasons] Planned reason distribution:`);
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sorted) {
    console.log(`  - ${reason}: ${count}`);
  }

  if (!args.apply) {
    console.log(
      `[backfill-call-analysis-failure-reasons] Dry-run. Re-run with --apply to write ${planned.length} row(s).`,
    );
    return;
  }

  // Group by reason and issue one UPDATE per reason using ANY($1::text[])
  // so we don't fire 1,641 individual statements at the DB.
  const byReason = new Map<CallAnalysisFailureReason, string[]>();
  for (const p of planned) {
    const list = byReason.get(p.reason) ?? [];
    list.push(p.analysisId);
    byReason.set(p.reason, list);
  }

  let written = 0;
  for (const [reason, ids] of byReason.entries()) {
    const updated = await db
      .update(callAnalysisJobs)
      .set({ failureReason: reason })
      .where(
        and(
          eq(callAnalysisJobs.status, "failed"),
          isNull(callAnalysisJobs.failureReason),
          sql`${callAnalysisJobs.analysisId} = ANY(${bindArrayParam(ids, "text")})`,
        ),
      )
      .returning({ analysisId: callAnalysisJobs.analysisId });
    const affected = updated.length;
    written += affected;
    console.log(
      `[backfill-call-analysis-failure-reasons] wrote reason=${reason} count=${affected}`,
    );
  }

  console.log(
    `[backfill-call-analysis-failure-reasons] Done. wrote=${written} of planned=${planned.length}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      `[backfill-call-analysis-failure-reasons] Fatal: ${err?.stack || err?.message || err}`,
    );
    process.exit(1);
  });
