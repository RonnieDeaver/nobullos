/**
 * Task #1837 — one-off operator script. Walks every row in
 * `front_analytics_monthly_coverage`, recomputes the numerator
 * (distinct conversations) from local DB, and relabels both unit
 * columns onto `conversations_all`. For rows whose denominator is in
 * Analytics-messages units, calls Conversations Search to fetch a
 * units-comparable denominator (bounded by `--budget`, default 12).
 *
 * Usage:
 *   npx tsx scripts/recompute_front_analytics_units.ts            # dry-run summary
 *   npx tsx scripts/recompute_front_analytics_units.ts --apply    # actually write
 *   npx tsx scripts/recompute_front_analytics_units.ts --apply --budget 30
 *
 * Safe to re-run; idempotent. Honors the same `front_analytics_refresh_enabled`
 * kill switch as the worker via the admin endpoint when invoked through
 * the UI, but this script bypasses it (operator-only path).
 *
 * MEASUREMENT-ONLY: never writes to `front_sync_emails` or
 * `raw_communication_records`.
 */

// Environment bootstrap: none needed. Like every sibling operator script,
// this relies on the ambient Replit environment (DATABASE_URL etc.) and
// imports `../server/db` lazily below — `server/db.ts` throws loudly when
// DATABASE_URL is unset. (Task #4138 removed a dead `../server/loadEnv`
// import here; that module never existed and no dotenv-style bootstrap is
// used anywhere in this repository.)

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const budgetIdx = argv.indexOf("--budget");
  const frontPullsBudget =
    budgetIdx >= 0 && argv[budgetIdx + 1]
      ? Math.max(0, Math.floor(Number(argv[budgetIdx + 1]) || 0))
      : undefined;

  if (!apply) {
    console.log(
      "[recompute-front-analytics-units] dry-run mode (pass --apply to commit).",
    );
    console.log(
      "[recompute-front-analytics-units] Reading current row state...",
    );
    const { db } = await import("../server/db");
    const { frontAnalyticsMonthlyCoverage } = await import(
      "../shared/models/frontAnalyticsCoverage"
    );
    const rows = await db.select().from(frontAnalyticsMonthlyCoverage);
    let needRepull = 0;
    let needRelabel = 0;
    let alreadyOk = 0;
    for (const r of rows) {
      const denUnit = r.denominatorUnit ?? null;
      const numUnit = r.numeratorUnit ?? null;
      if (numUnit === "conversations_all" && denUnit === "conversations_all") {
        alreadyOk += 1;
      } else if (denUnit === "inbound_conversations" || denUnit === "conversations_all") {
        needRelabel += 1;
      } else {
        needRepull += 1;
      }
    }
    console.log(
      `[recompute-front-analytics-units] ${rows.length} total rows. Already comparable: ${alreadyOk}. Relabel-only: ${needRelabel}. Need Front pull: ${needRepull}.`,
    );
    console.log(
      "[recompute-front-analytics-units] Re-run with --apply to recompute.",
    );
    process.exit(0);
  }

  const { recomputeAllMonths } = await import(
    "../server/services/frontAnalyticsCoverage"
  );
  console.log(
    `[recompute-front-analytics-units] --apply with frontPullsBudget=${frontPullsBudget ?? 12}`,
  );
  const result = await recomputeAllMonths({ frontPullsBudget });
  const byOutcome = result.results.reduce<Record<string, number>>(
    (acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
      return acc;
    },
    {},
  );
  console.log(
    `[recompute-front-analytics-units] attempted=${result.attempted} pullsUsed=${result.frontPullsUsed}/${result.frontPullsBudget}`,
  );
  console.log(
    `[recompute-front-analytics-units] outcomes=${JSON.stringify(byOutcome)}`,
  );
  for (const r of result.results) {
    if (r.outcome === "error" || r.errorMessage) {
      console.log(
        `[recompute-front-analytics-units] ${r.month} ${r.outcome}${r.errorMessage ? ` — ${r.errorMessage}` : ""}`,
      );
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[recompute-front-analytics-units] FAILED:", err);
  process.exit(1);
});
