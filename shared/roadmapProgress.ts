/**
 * Task #4215 — Quarter + progress math for the roadmap kanban boards.
 *
 * ONE pure shared module used by the server (deriving the legacy `timeframe`
 * label in the public payload) and every client surface (admin kanban, public
 * page, embed) so a percentage can never disagree between surfaces. Clients
 * re-render on a timer with `now = new Date()`; tests inject fixed instants.
 *
 * Progress model (read-time date math ONLY — deliberately no cron/job):
 *   - completed (status "shipped")     → 100%           stage "done"
 *   - no release quarter ("Later")     → null (no bar)  stage "unscheduled"
 *   - quarter hasn't started yet       → 0%             stage "scheduled"
 *   - during its quarter               → 1%…90% linear  stage "in_quarter"
 *   - quarter over, still not done     → holds at 90%   stage "held"
 *
 * Quarter keys are the sortable `YYYY-Qn` form (e.g. "2026-Q3"): zero-padded
 * year first means lexicographic order == chronological order, so keys sort
 * correctly in SQL and JS without parsing. Boundaries are UTC — "2026-Q3" =
 * [2026-07-01T00:00Z, 2026-10-01T00:00Z) — so every viewer, the server, and
 * report queries agree on when a quarter flips regardless of local timezone.
 */

export const QUARTER_KEY_RE = /^\d{4}-Q[1-4]$/;

/** Percent shown the instant a quarter starts (a sliver, not an empty bar). */
export const IN_QUARTER_MIN_PERCENT = 1;
/** Cap while incomplete: the last 10% is reserved for a human moving the card. */
export const IN_QUARTER_MAX_PERCENT = 90;

export function isQuarterKey(value: unknown): value is string {
  return typeof value === "string" && QUARTER_KEY_RE.test(value);
}

export interface QuarterParts {
  year: number;
  /** 1–4 */
  quarter: number;
}

export function parseQuarterKey(key: string): QuarterParts {
  if (!QUARTER_KEY_RE.test(key)) {
    throw new Error(`Invalid quarter key "${key}" — expected e.g. "2026-Q3"`);
  }
  return { year: Number(key.slice(0, 4)), quarter: Number(key.slice(6)) };
}

export function formatQuarterKey(year: number, quarter: number): string {
  if (!Number.isInteger(year) || year < 0 || year > 9999) {
    throw new Error(`Invalid quarter year ${year}`);
  }
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    throw new Error(`Invalid quarter number ${quarter}`);
  }
  return `${String(year).padStart(4, "0")}-Q${quarter}`;
}

/** Quarter key containing the given instant (UTC calendar). */
export function quarterKeyForDate(date: Date): string {
  return formatQuarterKey(date.getUTCFullYear(), Math.floor(date.getUTCMonth() / 3) + 1);
}

export function currentQuarterKey(now: Date): string {
  return quarterKeyForDate(now);
}

export function addQuarters(key: string, delta: number): string {
  const { year, quarter } = parseQuarterKey(key);
  const idx = year * 4 + (quarter - 1) + Math.trunc(delta);
  return formatQuarterKey(Math.floor(idx / 4), ((idx % 4) + 4) % 4 + 1);
}

export function nextQuarterKey(key: string): string {
  return addQuarters(key, 1);
}

export function previousQuarterKey(key: string): string {
  return addQuarters(key, -1);
}

/** "2026-Q3" → "Q3 2026" (human label; also the derived legacy `timeframe`). */
export function quarterLabel(key: string): string {
  const { year, quarter } = parseQuarterKey(key);
  return `Q${quarter} ${year}`;
}

/** [start, end) of the quarter in UTC. `end` is the first instant AFTER it. */
export function quarterBoundsUtc(key: string): { start: Date; end: Date } {
  const { year, quarter } = parseQuarterKey(key);
  const startMonth = (quarter - 1) * 3;
  return {
    start: new Date(Date.UTC(year, startMonth, 1)),
    // Date.UTC normalizes month overflow, so Q4's end lands on Jan 1 next year.
    end: new Date(Date.UTC(year, startMonth + 3, 1)),
  };
}

/** <0 / 0 / >0 comparator; quarter keys compare chronologically. */
export function compareQuarterKeys(a: string, b: string): number {
  const pa = parseQuarterKey(a);
  const pb = parseQuarterKey(b);
  return pa.year * 4 + pa.quarter - (pb.year * 4 + pb.quarter);
}

/** The `count` quarter keys starting at (and including) `now`'s quarter. */
export function upcomingQuarterKeys(now: Date, count: number): string[] {
  const current = quarterKeyForDate(now);
  return Array.from({ length: Math.max(0, count) }, (_, i) => addQuarters(current, i));
}

export type RoadmapProgressStage =
  | "done"
  | "unscheduled"
  | "scheduled"
  | "in_quarter"
  | "held";

export const roadmapProgressStageLabels: Record<RoadmapProgressStage, string> = {
  done: "Done",
  unscheduled: "Later",
  scheduled: "Scheduled",
  in_quarter: "In progress",
  held: "Wrapping up",
};

export interface RoadmapProgress {
  stage: RoadmapProgressStage;
  /** 0–100, or null when there is no bar at all ("Later" items). */
  percent: number | null;
}

/**
 * The single progress function every surface renders from.
 *
 * `status` is the roadmap status ("shipped" = completed — the kanban Done
 * column reuses the existing status value rather than adding a parallel
 * one, so existing `statuses=` embed filters stay meaningful). An invalid
 * stored quarter key degrades to "unscheduled" rather than throwing: write
 * paths regex-validate the key, so this guard only shields the public
 * render path from legacy or hand-edited rows.
 */
export function roadmapProgress(
  item: { status: string; releaseQuarter: string | null | undefined },
  now: Date,
): RoadmapProgress {
  if (item.status === "shipped") return { stage: "done", percent: 100 };
  if (!isQuarterKey(item.releaseQuarter)) return { stage: "unscheduled", percent: null };
  const { start, end } = quarterBoundsUtc(item.releaseQuarter);
  const t = now.getTime();
  if (t < start.getTime()) return { stage: "scheduled", percent: 0 };
  if (t >= end.getTime()) return { stage: "held", percent: IN_QUARTER_MAX_PERCENT };
  const fraction = (t - start.getTime()) / (end.getTime() - start.getTime());
  const raw = Math.round(
    IN_QUARTER_MIN_PERCENT + (IN_QUARTER_MAX_PERCENT - IN_QUARTER_MIN_PERCENT) * fraction,
  );
  return {
    stage: "in_quarter",
    percent: Math.min(IN_QUARTER_MAX_PERCENT, Math.max(IN_QUARTER_MIN_PERCENT, raw)),
  };
}

/** Quarter key an item completed in (from `completedAt`), for display. */
export function completionQuarterKey(
  completedAt: string | Date | null | undefined,
): string | null {
  if (!completedAt) return null;
  const d = completedAt instanceof Date ? completedAt : new Date(completedAt);
  if (Number.isNaN(d.getTime())) return null;
  return quarterKeyForDate(d);
}

// ── Report "Product updates" quarter-window selection (Task #4216) ──────────

/** What the CEO Pulse "Product updates" block shows for `now`'s quarter. */
export interface ReportProductUpdatesWindow<T> {
  /** Quarter key of `now` — the window the block reports on. */
  quarterKey: string;
  /** Product-board items released this quarter and not yet shipped (input order). */
  upcoming: T[];
  /** Product-board items completed this or last quarter, newest completion first. */
  completed: T[];
}

/**
 * The single quarter-window selection rule for the report block, shared by
 * the server payload builders and their tests (which inject fixed `now`
 * instants so nothing goes red on a calendar schedule).
 *
 * Rules (Task #4216):
 *   - product board ONLY — company-board items never reach a client report,
 *     even if a caller forgets to pre-filter its query;
 *   - "upcoming"  = releaseQuarter equals `now`'s quarter AND not shipped.
 *     Past-quarter unfinished ("held") items are deliberately absent — the
 *     block promises what ships THIS quarter, not a backlog;
 *   - "completed" = shipped AND `completedAt` falls in `now`'s quarter or the
 *     one before it. A shipped row without a parseable completion stamp
 *     (legacy pre-#4215 rows were not backfilled) is excluded — recency
 *     cannot be proven. Input order is preserved for upcoming (operator
 *     kanban order); completed sorts newest-first.
 */
export function selectReportProductUpdates<
  T extends {
    board: string;
    status: string;
    releaseQuarter: string | null;
    completedAt: string | Date | null;
  },
>(items: readonly T[], now: Date): ReportProductUpdatesWindow<T> {
  const quarterKey = quarterKeyForDate(now);
  const previousKey = previousQuarterKey(quarterKey);
  const upcoming: T[] = [];
  const completed: Array<{ item: T; at: number }> = [];
  for (const item of items) {
    if (item.board !== "product") continue;
    if (item.status === "shipped") {
      const key = completionQuarterKey(item.completedAt);
      if (key === quarterKey || key === previousKey) {
        const at =
          item.completedAt instanceof Date
            ? item.completedAt.getTime()
            : Date.parse(String(item.completedAt));
        completed.push({ item, at });
      }
    } else if (item.releaseQuarter === quarterKey) {
      upcoming.push(item);
    }
  }
  completed.sort((a, b) => b.at - a.at);
  return { quarterKey, upcoming, completed: completed.map((c) => c.item) };
}
