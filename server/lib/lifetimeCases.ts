/**
 * Tasks #3687 + #4849 — lifetime-value case-signing accumulation.
 *
 * Shared by BOTH lifetime computations in server/routes/reports.ts (the
 * public/preview report-response builder and the demo report endpoint) so the
 * two paths cannot drift.
 *
 * Rules (owner directive, Task #4849: the deck must NEVER show a confirmed
 * "0 cases signed" — a numeral 0 there is never acceptable):
 * - The client `initialCases` baseline joins the running total ONLY when
 *   genuinely provided (> 0): the client edit forms coerce an absent baseline
 *   to 0 on save (a stored 0 means "never provided", not "confirmed zero
 *   signings"), and the schema does not forbid stored garbage — a NEGATIVE
 *   baseline must contribute nothing rather than silently subtract from (or
 *   zero out) confirmed monthly figures.
 * - A report month's sales `totalCases` counts as genuinely provided ONLY
 *   when it is an unflagged POSITIVE number. Report forms and the AI-parse
 *   path coerce absent case counts to 0 on save, so a stored unflagged 0 is
 *   indistinguishable from "never provided" and must not read as a confirmed
 *   figure (Task #4849 extends the baseline rule to monthly values — by
 *   construction `hasHardData` implies `totalCases > 0`, so a "confirmed 0"
 *   display is impossible). Months the operator flagged "No Data"
 *   (`noDataFlags.totalCases: true`, saved with a placeholder 0) never count
 *   either (Task #3687).
 * - Per-month provenance (Task #4849): every well-formed (YYYY-MM) report
 *   month fed to the accumulator is recorded, and `getLifetimeCaseCoverage`
 *   exposes the provided/missing month lists over the CALENDAR-COMPLETE
 *   observed span (first observed month → last observed month) — so calendar
 *   months with no report at all count as missing too.
 *
 * The public report's lifetime cases card renders the not-reported treatment
 * (or the clearly labeled "~N" benchmark estimate) when `hasHardData` stays
 * false, and an "Incomplete data — missing <months>" annotation when hard
 * data covers only part of the span.
 */

export interface LifetimeCaseAccumulator {
  /** Running confirmed-cases total (positive baseline + unflagged positive report months). */
  totalCases: number;
  /** True once any genuinely provided case figure has been seen (implies totalCases > 0). */
  hasHardData: boolean;
  /** Every well-formed (YYYY-MM) report month fed to the accumulator — the coverage span source. */
  observedMonths: Set<string>;
  /** Observed months whose case figure was genuinely provided (unflagged positive). */
  providedMonths: Set<string>;
}

/** Sales-section shape as stored in report_sections.data (shared/models/reports.ts). */
export interface SalesCaseData {
  totalCases?: number | null;
  noDataFlags?: Record<string, boolean> | null;
}

/** Per-month case-data provenance over the accumulation span (Task #4849). */
export interface LifetimeCaseCoverage {
  /** Months (YYYY-MM, ascending) whose case figure was genuinely provided. */
  providedMonths: string[];
  /**
   * Calendar months (YYYY-MM, ascending) inside the observed span that lack
   * genuinely provided case data — months with no report at all included.
   */
  missingMonths: string[];
}

/**
 * Only well-formed report months join the coverage span — reports.reportMonth
 * is "YYYY-MM" by convention, but this is the same defensive validation the
 * deck's trend axis applies (client/src/pages/publicReport/TrendsSection.tsx):
 * a malformed value must never derail the calendar walk. Its sales data still
 * accumulates normally; it just cannot be placed on the calendar.
 */
const REPORT_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Hard bound on the calendar walk (100 years). A well-formed but corrupt year
 * typo (e.g. "2062-01" for "2026-01") widens the span; the cap guarantees the
 * serve path stays O(centuries-not-infinity) instead of looping on garbage.
 */
const MAX_COVERAGE_SPAN_MONTHS = 1200;

export function createLifetimeCaseAccumulator(
  initialCases: number | null | undefined,
): LifetimeCaseAccumulator {
  // Only a genuinely provided (positive) baseline enters the total. Adding a
  // stored negative here while hasHardData comes from a later positive month
  // would break the `hasHardData ⇒ totalCases > 0` invariant (and undercount
  // confirmed cases), so non-positive baselines contribute nothing.
  const baseline =
    typeof initialCases === "number" && Number.isFinite(initialCases) && initialCases > 0
      ? initialCases
      : 0;
  return {
    totalCases: baseline,
    hasHardData: baseline > 0,
    observedMonths: new Set<string>(),
    providedMonths: new Set<string>(),
  };
}

export function addReportCasesToLifetime(
  acc: LifetimeCaseAccumulator,
  salesData: SalesCaseData | null | undefined,
  /**
   * The report's month ("YYYY-MM") — required so every caller feeds the
   * per-month provenance; null/malformed values accumulate totals but stay
   * off the calendar (they cannot honestly name a gap month).
   */
  reportMonth: string | null | undefined,
): void {
  const monthKey =
    typeof reportMonth === "string" && REPORT_MONTH_RE.test(reportMonth)
      ? reportMonth
      : null;
  if (monthKey) acc.observedMonths.add(monthKey);
  // Operator explicitly marked the month "No Data" — the saved totalCases (0)
  // is a placeholder, not a confirmed figure. Skip it entirely: don't add it,
  // don't mark hard data, don't mark the month provided.
  if (salesData?.noDataFlags?.totalCases) return;
  // Only an unflagged POSITIVE totalCases is genuinely provided: forms and
  // the AI-parse path coerce absent case counts to 0, so an unflagged 0 (or
  // stored garbage like a negative) must never count as a confirmed figure.
  if (typeof salesData?.totalCases === "number" && salesData.totalCases > 0) {
    acc.totalCases += salesData.totalCases;
    acc.hasHardData = true;
    if (monthKey) acc.providedMonths.add(monthKey);
  }
}

/** "2026-12" → "2027-01" (input pre-validated by REPORT_MONTH_RE). */
function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * Calendar-complete provided/missing month lists over the observed span.
 * Empty span (no well-formed months observed) → both lists empty; the card
 * then has no annotation to render, which is correct because there is no
 * span to be incomplete over.
 */
export function getLifetimeCaseCoverage(
  acc: LifetimeCaseAccumulator,
): LifetimeCaseCoverage {
  const providedMonths = [...acc.providedMonths].sort();
  const observed = [...acc.observedMonths].sort();
  const missingMonths: string[] = [];
  if (observed.length > 0) {
    const last = observed[observed.length - 1];
    let cursor = observed[0];
    // Zero-padded "YYYY-MM" strings compare correctly lexicographically; the
    // iteration cap (not the comparison) is the loop's safety guarantee.
    for (let i = 0; i < MAX_COVERAGE_SPAN_MONTHS && cursor <= last; i++) {
      if (!acc.providedMonths.has(cursor)) missingMonths.push(cursor);
      cursor = nextMonth(cursor);
    }
  }
  return { providedMonths, missingMonths };
}
