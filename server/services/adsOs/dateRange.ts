/**
 * Ads OS — dashboard date windows (port of backend/app/date_range.py).
 *
 * Every dashboard metric compares a CURRENT window against a BASELINE:
 *   - window:  7 | 14 | 30 days, always ending YESTERDAY (today is partial).
 *   - compare: "previous" — the window immediately before the current one, or
 *              "average"  — a trailing multi-period average normalized to one
 *                           window (7d → 28d/4, 14d → 56d/4, 30d → 90d/3).
 *
 * The baseline range is [base_start, base_end] where base_end = cur_start − 1;
 * `divisor` normalizes the summed baseline back to one window's worth.
 */

export type DashWindow = 7 | 14 | 30;
export type DashCompare = "previous" | "average";

export const WINDOWS: ReadonlySet<number> = new Set([7, 14, 30]);
export const COMPARES: ReadonlySet<string> = new Set(["previous", "average"]);

/** Trailing days used for the "average" baseline, per window. */
export const AVG_DAYS: Record<DashWindow, number> = { 7: 28, 14: 56, 30: 90 };

/** Clamp arbitrary query params to a valid (window, compare) pair. */
export function normalizeRange(window: unknown, compare: unknown): [DashWindow, DashCompare] {
  const w = Number(window);
  const win: DashWindow = WINDOWS.has(w) ? (w as DashWindow) : 30;
  const cmp: DashCompare = COMPARES.has(String(compare)) ? (String(compare) as DashCompare) : "previous";
  return [win, cmp];
}

/** A calendar date without time, in the server's local timezone (like Python's date). */
export interface PlainDate {
  y: number;
  m: number; // 1-based
  d: number;
}

export function plainToday(): PlainDate {
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

export function addDays(p: PlainDate, days: number): PlainDate {
  const dt = new Date(p.y, p.m - 1, p.d + days);
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
}

export function isoDate(p: PlainDate): string {
  const mm = String(p.m).padStart(2, "0");
  const dd = String(p.d).padStart(2, "0");
  return `${p.y}-${mm}-${dd}`;
}

/** Compare "YYYY-MM-DD" strings — lexicographic order == chronological order. */
export function isoGte(a: string, b: string): boolean {
  return a >= b;
}

export interface RangeBounds {
  curStart: PlainDate;
  curEnd: PlainDate;
  baseStart: PlainDate;
  baseEnd: PlainDate;
  /** Divide summed baseline values by this to normalize to one window. */
  divisor: number;
}

/**
 * Date bounds for the selected window + comparison (mirrors range_bounds()).
 * Current window always ends yesterday.
 */
export function rangeBounds(window: unknown, compare: unknown): RangeBounds {
  const [win, cmp] = normalizeRange(window, compare);
  const curEnd = addDays(plainToday(), -1); // yesterday
  const curStart = addDays(curEnd, -(win - 1));
  const baseEnd = addDays(curStart, -1);
  let baseStart: PlainDate;
  let divisor: number;
  if (cmp === "average") {
    const n = AVG_DAYS[win];
    baseStart = addDays(curStart, -n);
    divisor = n / win;
  } else {
    baseStart = addDays(curStart, -win);
    divisor = 1;
  }
  return { curStart, curEnd, baseStart, baseEnd, divisor };
}
