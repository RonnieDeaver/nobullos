/**
 * Pure derivation for the report matrix's action-first view (Task #4351,
 * design audit P0-4 / §3.6): classify each client of the matrix payload by
 * the report work an author owes them right now.
 *
 * Semantics — all relative to an injected `now`, never the wall clock, so
 * tests stay calendar-proof:
 *
 *   - The DUE month is the most recently completed calendar month (in
 *     August 2026 that is 2026-07). Every active client without any report
 *     for that month is due — including clients with zero reports.
 *   - MISSING months are the older completed months inside the lookback
 *     window where the client was ALREADY reporting (their earliest report
 *     predates the hole) but has no report. Months before a client's first
 *     report are pre-onboarding, not holes.
 *   - DRAFTS are every non-final report, newest month first — regardless of
 *     age. An unfinished draft is open work wherever it sits.
 *
 * A client needs action when any bucket is non-empty. Ordering puts due
 * clients first, then bigger backlogs, alphabetical within ties — the exact
 * order the action-first list renders.
 */

export type TriageReportCell = {
  id: string;
  status: string;
  shareToken: string | null;
  totalLeads: number;
  totalCases: number;
  updatedAt: string;
  /** Task #4537 — operator "Presented / Delivered" mark (ISO timestamp when
   * set, null/absent otherwise). Display-only on the matrix: it deliberately
   * plays NO part in the needs-action triage below. */
  presentedAt?: string | null;
};

/** Shape of one row of GET /api/reports/matrix, as the page consumes it. */
export type TriageInputRow = {
  clientId: string;
  firmName: string;
  clientCode: string | null;
  /** Task #4363 — demo-account marker (same flag as the "Demo Account"
   * badge), consumed by the global hide-demo filter before triage. */
  isDemo?: boolean;
  reports: Record<string, TriageReportCell>;
};

export type ClientTriage = {
  clientId: string;
  firmName: string;
  clientCode: string | null;
  /** The most recently completed month, when the client has no report for it. */
  dueMonth: string | null;
  /** Older completed lookback months with a real hole, newest first. */
  missingMonths: string[];
  /** Non-final reports, newest month first. */
  drafts: Array<{ month: string; report: TriageReportCell }>;
  /** The client's newest report of any status, for open actions. */
  latest: { month: string; report: TriageReportCell } | null;
  needsAction: boolean;
};

/** Completed months considered by the triage window (due month included). */
export const TRIAGE_LOOKBACK_MONTHS = 3;

/** YYYY-MM key of the month `offset` months away from `now` (0 = current). */
export function monthKeyOffset(now: Date, offset: number): string {
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Priority comparator: due clients first, then larger missing backlogs, then
 * more drafts, alphabetical tiebreak. Bucket counts saturate at 9 so a
 * pathological draft pile cannot outrank a due report.
 */
export function compareTriage(a: ClientTriage, b: ClientTriage): number {
  const score = (e: ClientTriage) =>
    (e.dueMonth ? 100 : 0) +
    Math.min(e.missingMonths.length, 9) * 10 +
    Math.min(e.drafts.length, 9);
  const diff = score(b) - score(a);
  if (diff !== 0) return diff;
  return a.firmName.localeCompare(b.firmName);
}

export function computeClientTriage(
  rows: TriageInputRow[],
  now: Date,
  lookbackMonths: number = TRIAGE_LOOKBACK_MONTHS,
): ClientTriage[] {
  const window = Math.max(1, lookbackMonths);
  const dueMonthKey = monthKeyOffset(now, -1);
  /** Older completed months, newest first: [-2, -3, …]. */
  const olderWindow: string[] = [];
  for (let i = 2; i <= window; i++) olderWindow.push(monthKeyOffset(now, -i));

  const entries = rows.map((row): ClientTriage => {
    // YYYY-MM keys sort correctly as strings.
    const reportMonths = Object.keys(row.reports).sort();
    const earliest = reportMonths.length > 0 ? reportMonths[0] : null;
    const latestMonth =
      reportMonths.length > 0 ? reportMonths[reportMonths.length - 1] : null;

    const dueMonth = row.reports[dueMonthKey] ? null : dueMonthKey;
    const missingMonths = olderWindow.filter(
      (m) => !row.reports[m] && earliest !== null && earliest < m,
    );
    const drafts = reportMonths
      .filter((m) => row.reports[m].status !== "final")
      .reverse()
      .map((m) => ({ month: m, report: row.reports[m] }));
    const latest =
      latestMonth !== null
        ? { month: latestMonth, report: row.reports[latestMonth] }
        : null;

    return {
      clientId: row.clientId,
      firmName: row.firmName,
      clientCode: row.clientCode,
      dueMonth,
      missingMonths,
      drafts,
      latest,
      needsAction:
        dueMonth !== null || missingMonths.length > 0 || drafts.length > 0,
    };
  });

  return entries.sort(compareTriage);
}
