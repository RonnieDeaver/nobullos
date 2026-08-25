/**
 * Task #1681 — one-shot backfill of Front Analytics coverage for
 * July–October 2025 via the search-API fallback.
 *
 * Front's Analytics Reports API returns 403 "plan does not give you
 * access to that time period" for these months on the current
 * workspace plan, leaving them stuck at front_total_messages=0. This
 * script invokes the standard `refreshMonth` path which now falls
 * back to `/conversations/search/:query` and persists
 * `denominator_source='search_conversations'`.
 *
 * Idempotent: re-running is safe; each month's row is upserted in
 * place. Honors `KILL_SWITCH_NON_CRITICAL_SWEEPS`. Operator can
 * inspect results in `/admin/integrations` → Front Analytics tile or
 * via `SELECT month, front_total_messages, denominator_source,
 * denominator_unit FROM front_analytics_monthly_coverage WHERE month
 * BETWEEN '2025-07' AND '2025-10';`.
 *
 * Usage:
 *   npx tsx scripts/backfill_front_search_fallback_2025.ts
 *   DRY_RUN=1 npx tsx scripts/backfill_front_search_fallback_2025.ts
 */
import { refreshMonth } from "../server/services/frontAnalyticsCoverage";

const TARGET_MONTHS: Array<{ label: string; mIdx: number }> = [
  { label: "2025-07", mIdx: 6 },
  { label: "2025-08", mIdx: 7 },
  { label: "2025-09", mIdx: 8 },
  { label: "2025-10", mIdx: 9 },
];

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  const runId = `backfill_task_1681:${new Date().toISOString()}`;
  console.log(
    `[backfill-1681] starting ${dryRun ? "(DRY RUN)" : ""} runId=${runId}`,
  );

  for (const { label, mIdx } of TARGET_MONTHS) {
    const monthStart = new Date(Date.UTC(2025, mIdx, 1));
    const monthEnd = new Date(Date.UTC(2025, mIdx + 1, 1));
    if (dryRun) {
      console.log(
        `[backfill-1681] would refresh month=${label} (${monthStart.toISOString()} → ${monthEnd.toISOString()})`,
      );
      continue;
    }
    try {
      const r = await refreshMonth({
        month: label,
        monthStart,
        monthEnd,
        isCurrentMonth: false,
        runId,
      });
      console.log(
        `[backfill-1681] month=${label} outcome=${r.outcome} source=${r.denominatorSource ?? "n/a"} unit=${r.denominatorUnit ?? "n/a"} front_total=${r.frontTotalMessages ?? "n/a"} err=${r.errorCode ?? ""}`,
      );
    } catch (err: any) {
      console.error(
        `[backfill-1681] month=${label} unexpected throw: ${err?.message ?? err}`,
      );
    }
  }
  console.log("[backfill-1681] done");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-1681] fatal:", err);
    process.exit(1);
  });
