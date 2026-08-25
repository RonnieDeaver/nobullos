/**
 * Task #2893 — per-keyword report-date fallback for SEMrush heatmap fetches.
 *
 * SEMrush Map Rank Tracker (developer.semrush.com/api/v4/map-rank-tracker-2/)
 * requires a `reportDate` on the heatmap endpoint; valid values come from the
 * campaign's `reportDates` array and there is no "latest" wildcard. A keyword
 * added or re-collected on a different schedule can have NO collection at the
 * campaign-level date we picked, in which case SEMrush returns a non-retryable
 * 400 whose body says the keyword "wasn't collected" at that timestamp.
 *
 * That failure is per-keyword and per-date — other keywords at the same date
 * and the same keyword at other dates are unaffected. So instead of failing
 * the keyword outright, we retry it against a bounded set of OTHER campaign
 * report dates (nearest to the requested month first, newer first on ties).
 * If no date has data, we surface a plain-language "no collected data yet"
 * error instead of the raw SEMrush 400 body.
 */

/** Matches the SEMrush 400 body for a keyword with no collection at the requested date. */
const KEYWORD_NOT_COLLECTED_RE = /wasn'?t\s+collected|was\s+not\s+collected/i;

/**
 * True when an error thrown by the SEMrush API layer is the specific
 * "keyword wasn't collected at this report date" 400. Other API errors
 * (auth, rate-limit, timeouts, 404s, other 400s) must NOT trigger date
 * fallback — they are either retried elsewhere or genuinely terminal.
 */
export function isKeywordNotCollectedError(err: unknown): boolean {
  const msg = (err as any)?.message;
  if (typeof msg !== "string") return false;
  return KEYWORD_NOT_COLLECTED_RE.test(msg);
}

/** Machine-readable code attached to the terminal all-dates-failed error. */
export const KEYWORD_NO_DATA_CODE = "keyword_not_collected";

export class KeywordNoDataError extends Error {
  code = KEYWORD_NO_DATA_CODE;
  keywordName: string;
  attemptedDates: string[];
  constructor(keywordName: string, attemptedDates: string[]) {
    super(
      `Keyword "${keywordName}" has no collected heatmap data yet for any recent report date. ` +
      `It may have been added to the campaign recently — data should appear after SEMrush's next scheduled scan.`,
    );
    this.name = "KeywordNoDataError";
    this.keywordName = keywordName;
    this.attemptedDates = attemptedDates;
  }
}

/** Default cap on how many ALTERNATE dates we try after the selected one fails. */
export const DEFAULT_MAX_FALLBACK_DATES = 3;

/**
 * Build the ordered list of alternate report dates to try after
 * `selectedReportDate` failed with a "wasn't collected" 400.
 *
 * Ordering: closest to the requested month (end-of-month anchor) first;
 * on distance ties the NEWER date wins. When no reportMonth is given the
 * anchor is the selected date itself (so we try the temporally nearest
 * collections first). The selected date is excluded; the list is capped.
 */
export function buildFallbackReportDates(
  reportDates: string[] | null | undefined,
  selectedReportDate: string | null,
  reportMonth?: string | null,
  maxCandidates: number = DEFAULT_MAX_FALLBACK_DATES,
): string[] {
  if (!Array.isArray(reportDates) || reportDates.length === 0) return [];

  let anchorTs: number | null = null;
  if (reportMonth && /^\d{4}-\d{2}$/.test(reportMonth)) {
    const [year, month] = reportMonth.split("-").map(Number);
    anchorTs = new Date(year, month, 0, 23, 59, 59, 999).getTime();
  } else if (selectedReportDate) {
    const ts = new Date(selectedReportDate).getTime();
    if (!Number.isNaN(ts)) anchorTs = ts;
  }

  const selectedTs = selectedReportDate ? new Date(selectedReportDate).getTime() : NaN;

  const candidates = reportDates
    .map((d) => ({ date: d, ts: new Date(d).getTime() }))
    .filter((c) => !Number.isNaN(c.ts))
    // Exclude the already-tried selected date (by value OR by timestamp so
    // formatting differences like trailing "Z" don't sneak it back in).
    .filter((c) => c.date !== selectedReportDate && c.ts !== selectedTs);

  candidates.sort((a, b) => {
    if (anchorTs !== null) {
      const da = Math.abs(a.ts - anchorTs);
      const db = Math.abs(b.ts - anchorTs);
      if (da !== db) return da - db;
    }
    return b.ts - a.ts; // newer first
  });

  // Dedupe by timestamp (SEMrush occasionally lists equivalent dates).
  const seen = new Set<number>();
  const out: string[] = [];
  for (const c of candidates) {
    if (seen.has(c.ts)) continue;
    seen.add(c.ts);
    out.push(c.date);
    if (out.length >= Math.max(0, maxCandidates)) break;
  }
  return out;
}

/**
 * Run a heatmap fetch with bounded per-keyword report-date fallback.
 *
 * `fetchAtDate` is called first with `selectedReportDate`; if it throws the
 * specific "wasn't collected" 400, it is retried against the fallback dates
 * in order. Any OTHER error is rethrown immediately (no fallback). If every
 * candidate date also reports "wasn't collected", a `KeywordNoDataError`
 * with a plain-language message is thrown.
 */
export async function fetchHeatmapWithDateFallback<T>(args: {
  fetchAtDate: (reportDate: string) => Promise<T>;
  selectedReportDate: string;
  reportDates: string[] | null | undefined;
  reportMonth?: string | null;
  keywordName: string;
  maxFallbackDates?: number;
  onFallbackAttempt?: (reportDate: string) => void;
}): Promise<{ result: T; reportDateUsed: string; usedFallback: boolean }> {
  const {
    fetchAtDate,
    selectedReportDate,
    reportDates,
    reportMonth,
    keywordName,
    maxFallbackDates = DEFAULT_MAX_FALLBACK_DATES,
    onFallbackAttempt,
  } = args;

  try {
    const result = await fetchAtDate(selectedReportDate);
    return { result, reportDateUsed: selectedReportDate, usedFallback: false };
  } catch (err) {
    if (!isKeywordNotCollectedError(err)) throw err;

    const attempted: string[] = [selectedReportDate];
    const candidates = buildFallbackReportDates(
      reportDates,
      selectedReportDate,
      reportMonth,
      maxFallbackDates,
    );
    for (const candidate of candidates) {
      attempted.push(candidate);
      try {
        onFallbackAttempt?.(candidate);
        const result = await fetchAtDate(candidate);
        return { result, reportDateUsed: candidate, usedFallback: true };
      } catch (fallbackErr) {
        if (!isKeywordNotCollectedError(fallbackErr)) throw fallbackErr;
        // Not collected at this date either — try the next candidate.
      }
    }
    throw new KeywordNoDataError(keywordName, attempted);
  }
}
