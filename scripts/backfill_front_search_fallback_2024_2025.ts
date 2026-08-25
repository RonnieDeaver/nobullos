/**
 * Task #1892 — one-shot backfill of Front Analytics coverage for the
 * 14 months whose `front_analytics_monthly_coverage` row is either
 * stuck at `front_analytics_auth_failed (401)` (11 months: 2024-04..07,
 * 2024-10..2025-03) or missing entirely (3 months: 2025-04..06).
 *
 * Without a denominator the per-month verdict in
 * `docs/front-recovery-zero-ingest-2026-05-26.md` is "unknown — re-probe"
 * and the all-time applied-coverage dashboard can never reach 100%.
 *
 * The 401 may be plan-history (Analytics retention window) or a
 * token-scope issue (`analytics:read`). The search-API fallback is the
 * cheapest first try because it bypasses Analytics auth entirely and
 * is already wired into `refreshMonth` via `forceSearchFallback: true`.
 * On success `runSearchFallback` clears `unrecoverable=true`, clears
 * the `front_analytics_error`, stamps a `denominator_source =
 * search_conversations` row, and finalises the month — exactly the
 * state the "Done looks like" criteria require.
 *
 * Idempotent: re-running is safe; each month's row is upserted in
 * place. Operator can inspect results in /admin/integrations → Front
 * Analytics tile or via:
 *   SELECT month, front_total_messages, denominator_source,
 *          denominator_unit, front_analytics_status, unrecoverable
 *   FROM front_analytics_monthly_coverage
 *   WHERE month BETWEEN '2024-04' AND '2025-06'
 *   ORDER BY month;
 *
 * Usage:
 *   npx tsx scripts/backfill_front_search_fallback_2024_2025.ts
 *   DRY_RUN=1 npx tsx scripts/backfill_front_search_fallback_2024_2025.ts
 */
import { refreshMonth } from "../server/services/frontAnalyticsCoverage";

const TARGET_MONTHS: Array<{ label: string; year: number; mIdx: number }> = [
  // Stuck at front_analytics_auth_failed (401) — Analytics submit fails,
  // denominator was never written.
  { label: "2024-04", year: 2024, mIdx: 3 },
  { label: "2024-05", year: 2024, mIdx: 4 },
  { label: "2024-06", year: 2024, mIdx: 5 },
  { label: "2024-07", year: 2024, mIdx: 6 },
  { label: "2024-10", year: 2024, mIdx: 9 },
  { label: "2024-11", year: 2024, mIdx: 10 },
  { label: "2024-12", year: 2024, mIdx: 11 },
  { label: "2025-01", year: 2025, mIdx: 0 },
  { label: "2025-02", year: 2025, mIdx: 1 },
  { label: "2025-03", year: 2025, mIdx: 2 },
  // No `front_analytics_monthly_coverage` row at all — measurement
  // never ran for these months.
  { label: "2025-04", year: 2025, mIdx: 3 },
  { label: "2025-05", year: 2025, mIdx: 4 },
  { label: "2025-06", year: 2025, mIdx: 5 },
  // 2025-03 above closes the auth-failed band; 2025-04..06 closes the
  // no-row band. 14 months total.
];

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  const runId = `backfill_task_1892:${new Date().toISOString()}`;
  console.log(
    `[backfill-1892] starting ${dryRun ? "(DRY RUN) " : ""}runId=${runId} months=${TARGET_MONTHS.length}`,
  );

  let ok = 0;
  let err = 0;
  for (const { label, year, mIdx } of TARGET_MONTHS) {
    const monthStart = new Date(Date.UTC(year, mIdx, 1));
    const monthEnd = new Date(Date.UTC(year, mIdx + 1, 1));
    if (dryRun) {
      console.log(
        `[backfill-1892] would refresh month=${label} (${monthStart.toISOString()} → ${monthEnd.toISOString()})`,
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
        // Bypass Analytics submit entirely — these rows are stuck on
        // 401/no-row, and the search fallback does not require
        // analytics:read. Also bypasses the finalized-row short-circuit
        // so existing auth-failed rows actually re-run.
        forceSearchFallback: true,
      });
      const isErr = r.outcome === "front_error";
      if (isErr) err++;
      else ok++;
      console.log(
        `[backfill-1892] month=${label} outcome=${r.outcome} source=${r.denominatorSource ?? "n/a"} unit=${r.denominatorUnit ?? "n/a"} front_total=${r.frontTotalMessages ?? "n/a"} status=${r.frontAnalyticsStatus ?? "n/a"} err=${r.errorCode ?? ""}`,
      );
    } catch (e: any) {
      err++;
      console.error(
        `[backfill-1892] month=${label} unexpected throw: ${e?.message ?? e}`,
      );
    }
  }
  console.log(`[backfill-1892] done ok=${ok} err=${err}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-1892] fatal:", err);
    process.exit(1);
  });
