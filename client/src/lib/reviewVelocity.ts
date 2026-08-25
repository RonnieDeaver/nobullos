// Review-velocity derivation (extracted from PublicReport.tsx, Task #2566).
//
// The Review Generation panel shows a 90-day trailing review-velocity headline
// plus a small trend sparkline. The math was originally computed inline in JSX
// with no test coverage; it lives here as a pure helper so it can be unit
// tested and reused without behavior change.

export type ReviewVelocityTrendInput = {
  month: string;
  marketing?: { totalReviews?: number } | null;
};

export type ReviewVelocityPoint = {
  month: string;
  value: number;
};

export type ReviewVelocityResult = {
  // Per-month velocity series (reviews/month). The latest point is pinned to
  // the panel total so the headline number and the latest trend point agree.
  series: ReviewVelocityPoint[];
  // Number of months folded into the trailing average (up to 3).
  monthsCount: number;
  // Mean of the last up-to-3 months, rounded to one decimal place.
  trailingAvg: number;
  // "Current month" when there is one (or zero) month of history, otherwise an
  // "N-day trailing average" label (30 days per month in the window).
  avgLabel: string;
  // Task #4844 — current-month review count: the latest series point (which is
  // pinned to the panel total), falling back to the panel total when there is
  // no history at all. Always agrees with the sparkline's latest point.
  currentMonth: number;
  // Task #4844 — total reviews summed over the SAME up-to-3-month window the
  // trailing average divides, so total and average can never disagree about
  // the window. Falls back to the panel total when there is no history
  // (mirroring trailingAvg's fallback).
  windowTotal: number;
  // Task #4844 — window-aware label for the total stat: "90-day total" /
  // "60-day total" with sparse history, "Current month" when the window holds
  // at most one month — the same honesty rule as avgLabel, so short history
  // never claims a 90-day window it doesn't have.
  totalLabel: string;
};

/**
 * Build the monthly review-velocity series, trailing average, and label from a
 * trendData-shaped payload.
 *
 * @param trendData ordered oldest→newest monthly trend points
 * @param panelTotal the Review Generation panel headline total, used to pin the
 *   latest series point so the headline and trend agree
 */
export function computeReviewVelocity(
  trendData: ReviewVelocityTrendInput[] | null | undefined,
  panelTotal: number,
): ReviewVelocityResult {
  const series: ReviewVelocityPoint[] = (trendData || []).map((d, idx, arr) => ({
    month: d.month,
    value: idx === arr.length - 1 ? panelTotal : (d.marketing?.totalReviews ?? 0),
  }));

  // 90-day trailing average = mean of the last up-to-3 available months.
  // The window TOTAL is the same sum the average divides (Task #4844), so the
  // two stats always describe the same trailing window.
  const window = series.slice(-3);
  const monthsCount = window.length;
  const windowSum = window.reduce((s, p) => s + p.value, 0);
  const currentMonth = series.length > 0 ? series[series.length - 1].value : panelTotal;
  const windowTotal = monthsCount > 0 ? windowSum : panelTotal;
  const avgRaw = monthsCount > 0 ? windowSum / monthsCount : panelTotal;
  const trailingAvg = Math.round(avgRaw * 10) / 10;
  const avgLabel = monthsCount <= 1
    ? "Current month"
    : `${monthsCount * 30}-day trailing average`;
  const totalLabel = monthsCount <= 1
    ? "Current month"
    : `${monthsCount * 30}-day total`;

  return { series, monthsCount, trailingAvg, avgLabel, currentMonth, windowTotal, totalLabel };
}

export type ReviewVelocityChange = {
  // Latest series point value (current month).
  current: number;
  // Previous series point value (month before current).
  prev: number;
  // current - prev (signed).
  delta: number;
  // Month-over-month percent change, rounded to a whole number. Guarded against
  // divide-by-zero: when prev is 0 the percent is 0.
  pct: number;
  // Whether the small up/down change badge should render at all. Hidden when
  // the delta is exactly 0 (no change) OR the previous month is 0 (no
  // meaningful percent baseline — avoids a "↑ 0%" badge off a zero base).
  show: boolean;
  // Direction of the change for badge styling/glyph; null when hidden.
  direction: "up" | "down" | null;
};

/**
 * Derive the month-over-month up/down change badge (current vs previous series
 * point, signed delta, percent change, and the "hide when delta is 0" rule)
 * from a review-velocity series. Extracted from PublicReport.tsx so the badge
 * math can be unit tested without behavior change.
 *
 * @param series the per-month velocity series from {@link computeReviewVelocity}
 */
export function computeReviewVelocityChange(
  series: ReviewVelocityPoint[],
): ReviewVelocityChange {
  const current = series[series.length - 1]?.value ?? 0;
  const prev = series[series.length - 2]?.value ?? 0;
  const delta = current - prev;
  const pct = prev !== 0 ? Math.round((delta / prev) * 100) : 0;
  const show = delta !== 0 && prev !== 0;
  const direction = show ? (delta > 0 ? "up" : "down") : null;
  return { current, prev, delta, pct, show, direction };
}
