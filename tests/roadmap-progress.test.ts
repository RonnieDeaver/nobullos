/* test-registration
{
  "name": "Roadmap quarter/progress math — key parsing + arithmetic + UTC bounds, linear in-quarter percent (1–90 cap), scheduled/held/done stages, completion quarter derivation, report product-updates quarter-window selection (Tasks #4215/#4216)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4215: this ONE pure module computes every roadmap percentage rendered anywhere — admin kanban, public /roadmap page, third-party embeds — and derives the public payload's legacy timeframe label plus the completion-quarter bucketing the CEO report queries build on. Task #4216 adds the report 'Product updates' quarter-window selection (which items appear on client-facing CEO Pulse slides). A boundary bug here shows wrong numbers on the open internet with no server error to catch it. Pure date math with injected 'now': no DB, no network, milliseconds.",
  "tier": "small"
}
test-registration */
/**
 * Task #4215 — Unit tests for shared/roadmapProgress.ts.
 *
 * The progress model is read-time date math ONLY (deliberately no cron), so
 * these tests inject fixed `now` instants and pin the calendar edges where
 * off-by-one bugs live: quarter start/end instants (UTC, [start, end)), the
 * Q4→Q1 year rollover, the 1%-floor / 90%-cap contract, and the exact
 * midpoint rounding. All calendar-sensitive fixtures use absolute dates —
 * nothing here depends on the wall clock, so the suite is green on any day
 * it runs (memory: calendar-month fixture collisions).
 */

process.env.NODE_ENV = "test";

import {
  IN_QUARTER_MAX_PERCENT,
  IN_QUARTER_MIN_PERCENT,
  QUARTER_KEY_RE,
  addQuarters,
  compareQuarterKeys,
  completionQuarterKey,
  currentQuarterKey,
  formatQuarterKey,
  isQuarterKey,
  nextQuarterKey,
  parseQuarterKey,
  previousQuarterKey,
  quarterBoundsUtc,
  quarterKeyForDate,
  quarterLabel,
  roadmapProgress,
  roadmapProgressStageLabels,
  selectReportProductUpdates,
  upcomingQuarterKeys,
} from "../shared/roadmapProgress";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const utc = (
  y: number,
  m: number,
  d: number,
  h = 0,
  min = 0,
  s = 0,
  ms = 0,
): Date => new Date(Date.UTC(y, m, d, h, min, s, ms));

// ── Key predicate + parsing ──────────────────────────────────────────────────

for (const good of ["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4", "2031-Q1"]) {
  check(`isQuarterKey accepts ${good}`, isQuarterKey(good));
}
for (const bad of [
  "2026-Q5",
  "2026-Q0",
  "2026-q3", // lowercase q
  "26-Q1", // two-digit year
  "2026-3", // missing Q
  "2026-Q34", // trailing digit
  " 2026-Q3", // leading space
  "2026-Q3 ", // trailing space
  "2026_Q3",
  "Q3 2026", // the human label, not the key
  "",
]) {
  check(`isQuarterKey rejects ${JSON.stringify(bad)}`, !isQuarterKey(bad));
}
check("isQuarterKey rejects null", !isQuarterKey(null));
check("isQuarterKey rejects undefined", !isQuarterKey(undefined));
check("isQuarterKey rejects a number", !isQuarterKey(2026));

const parsed = parseQuarterKey("2026-Q3");
check(
  "parseQuarterKey('2026-Q3') → {2026, 3}",
  parsed.year === 2026 && parsed.quarter === 3,
  JSON.stringify(parsed),
);
check("parseQuarterKey throws on '2026-Q5'", throws(() => parseQuarterKey("2026-Q5")));
check("parseQuarterKey throws on 'garbage'", throws(() => parseQuarterKey("garbage")));

check("formatQuarterKey(2026, 3) → '2026-Q3'", formatQuarterKey(2026, 3) === "2026-Q3");
check(
  "formatQuarterKey zero-pads the year (sortability contract)",
  formatQuarterKey(7, 1) === "0007-Q1",
  formatQuarterKey(7, 1),
);
check("formatQuarterKey throws on quarter 0", throws(() => formatQuarterKey(2026, 0)));
check("formatQuarterKey throws on quarter 5", throws(() => formatQuarterKey(2026, 5)));
check("formatQuarterKey throws on fractional quarter", throws(() => formatQuarterKey(2026, 1.5)));
check("formatQuarterKey throws on negative year", throws(() => formatQuarterKey(-1, 1)));

check(
  "round-trip: format(parse(key)) is identity",
  formatQuarterKey(parseQuarterKey("2029-Q4").year, parseQuarterKey("2029-Q4").quarter) ===
    "2029-Q4",
);

// ── Calendar → key (UTC boundaries) ─────────────────────────────────────────

check("Jan 1 00:00:00.000Z is Q1", quarterKeyForDate(utc(2026, 0, 1)) === "2026-Q1");
check(
  "Mar 31 23:59:59.999Z is still Q1",
  quarterKeyForDate(utc(2026, 2, 31, 23, 59, 59, 999)) === "2026-Q1",
);
check("Apr 1 00:00:00.000Z flips to Q2", quarterKeyForDate(utc(2026, 3, 1)) === "2026-Q2");
check("Jun 30 → Q2", quarterKeyForDate(utc(2026, 5, 30, 23, 59, 59, 999)) === "2026-Q2");
check("Jul 1 → Q3", quarterKeyForDate(utc(2026, 6, 1)) === "2026-Q3");
check("Oct 1 → Q4", quarterKeyForDate(utc(2026, 9, 1)) === "2026-Q4");
check(
  "Dec 31 23:59:59.999Z is Q4 (no rollover)",
  quarterKeyForDate(utc(2026, 11, 31, 23, 59, 59, 999)) === "2026-Q4",
);
check(
  "currentQuarterKey delegates to quarterKeyForDate",
  currentQuarterKey(utc(2026, 7, 10, 12)) === "2026-Q3",
);

// ── Quarter arithmetic (year wrap both directions) ──────────────────────────

check("addQuarters +1 wraps Q4→Q1 next year", addQuarters("2026-Q4", 1) === "2027-Q1");
check("addQuarters -1 wraps Q1→Q4 previous year", addQuarters("2026-Q1", -1) === "2025-Q4");
check("addQuarters 0 is identity", addQuarters("2026-Q2", 0) === "2026-Q2");
check("addQuarters +6 crosses years", addQuarters("2026-Q3", 6) === "2028-Q1");
check("addQuarters -5 crosses years backwards", addQuarters("2026-Q1", -5) === "2024-Q4");
check("nextQuarterKey('2026-Q4') → '2027-Q1'", nextQuarterKey("2026-Q4") === "2027-Q1");
check("previousQuarterKey('2026-Q1') → '2025-Q4'", previousQuarterKey("2026-Q1") === "2025-Q4");

check("quarterLabel('2026-Q3') → 'Q3 2026'", quarterLabel("2026-Q3") === "Q3 2026");

// ── UTC bounds ([start, end)) ────────────────────────────────────────────────

{
  const q3 = quarterBoundsUtc("2026-Q3");
  check(
    "Q3 2026 starts Jul 1 00:00Z",
    q3.start.getTime() === Date.UTC(2026, 6, 1),
    q3.start.toISOString(),
  );
  check(
    "Q3 2026 ends (exclusive) Oct 1 00:00Z",
    q3.end.getTime() === Date.UTC(2026, 9, 1),
    q3.end.toISOString(),
  );
  const q4 = quarterBoundsUtc("2026-Q4");
  check(
    "Q4 end rolls into Jan 1 of the NEXT year",
    q4.end.getTime() === Date.UTC(2027, 0, 1),
    q4.end.toISOString(),
  );
  const q1 = quarterBoundsUtc("2026-Q1");
  check(
    "Q1 bounds are Jan 1 → Apr 1",
    q1.start.getTime() === Date.UTC(2026, 0, 1) && q1.end.getTime() === Date.UTC(2026, 3, 1),
  );
  check(
    "adjacent quarters tile with no gap: Q3.end === Q4.start",
    q3.end.getTime() === q4.start.getTime(),
  );
}

// ── Ordering ─────────────────────────────────────────────────────────────────

check("compare: 2025-Q4 < 2026-Q1", compareQuarterKeys("2025-Q4", "2026-Q1") < 0);
check("compare: 2026-Q3 > 2026-Q1", compareQuarterKeys("2026-Q3", "2026-Q1") > 0);
check("compare: equal keys → 0", compareQuarterKeys("2026-Q2", "2026-Q2") === 0);
{
  const shuffled = ["2027-Q1", "2026-Q3", "2025-Q4", "2026-Q1"];
  const byComparator = [...shuffled].sort(compareQuarterKeys);
  const lexicographic = [...shuffled].sort();
  check(
    "comparator order == chronological order",
    JSON.stringify(byComparator) === JSON.stringify(["2025-Q4", "2026-Q1", "2026-Q3", "2027-Q1"]),
    JSON.stringify(byComparator),
  );
  check(
    "lexicographic sort agrees (the key format's design point — SQL ORDER BY works)",
    JSON.stringify(lexicographic) === JSON.stringify(byComparator),
    JSON.stringify(lexicographic),
  );
}

check(
  "upcomingQuarterKeys(mid-Q3, 4) starts at the current quarter",
  JSON.stringify(upcomingQuarterKeys(utc(2026, 7, 10), 4)) ===
    JSON.stringify(["2026-Q3", "2026-Q4", "2027-Q1", "2027-Q2"]),
  JSON.stringify(upcomingQuarterKeys(utc(2026, 7, 10), 4)),
);
check("upcomingQuarterKeys count 0 → []", upcomingQuarterKeys(utc(2026, 7, 10), 0).length === 0);
check(
  "upcomingQuarterKeys negative count → []",
  upcomingQuarterKeys(utc(2026, 7, 10), -3).length === 0,
);

// ── Progress model ───────────────────────────────────────────────────────────

const NOW_IN_Q3 = utc(2026, 7, 10, 12); // 2026-08-10T12:00Z, inside 2026-Q3

check("constants pin the 1%-floor / 90%-cap contract", IN_QUARTER_MIN_PERCENT === 1 && IN_QUARTER_MAX_PERCENT === 90);

{
  const p = roadmapProgress({ status: "shipped", releaseQuarter: "2026-Q3" }, NOW_IN_Q3);
  check("shipped → done / 100", p.stage === "done" && p.percent === 100, JSON.stringify(p));
}
{
  const p = roadmapProgress({ status: "shipped", releaseQuarter: null }, NOW_IN_Q3);
  check(
    "shipped WITHOUT a quarter is still done / 100",
    p.stage === "done" && p.percent === 100,
    JSON.stringify(p),
  );
}
{
  const p = roadmapProgress({ status: "planned", releaseQuarter: null }, NOW_IN_Q3);
  check(
    "no quarter → unscheduled, NO bar (percent null)",
    p.stage === "unscheduled" && p.percent === null,
    JSON.stringify(p),
  );
}
{
  const p = roadmapProgress({ status: "planned", releaseQuarter: "Q3 2026" }, NOW_IN_Q3);
  check(
    "invalid stored key degrades to unscheduled (render-path guard, no throw)",
    p.stage === "unscheduled" && p.percent === null,
    JSON.stringify(p),
  );
}
{
  const p = roadmapProgress({ status: "planned", releaseQuarter: "2026-Q4" }, NOW_IN_Q3);
  check(
    "future quarter → scheduled / 0",
    p.stage === "scheduled" && p.percent === 0,
    JSON.stringify(p),
  );
}
{
  const p = roadmapProgress({ status: "in_progress", releaseQuarter: "2027-Q2" }, NOW_IN_Q3);
  check(
    "status other than shipped does not matter: future quarter is scheduled/0 even when in_progress",
    p.stage === "scheduled" && p.percent === 0,
    JSON.stringify(p),
  );
}

const q3 = quarterBoundsUtc("2026-Q3");
{
  const p = roadmapProgress({ status: "in_progress", releaseQuarter: "2026-Q3" }, q3.start);
  check(
    "quarter start INSTANT → in_quarter / 1 (sliver, never an empty bar)",
    p.stage === "in_quarter" && p.percent === IN_QUARTER_MIN_PERCENT,
    JSON.stringify(p),
  );
}
{
  const mid = new Date((q3.start.getTime() + q3.end.getTime()) / 2);
  const p = roadmapProgress({ status: "in_progress", releaseQuarter: "2026-Q3" }, mid);
  check(
    "quarter midpoint → 46 (round(1 + 89·0.5) = round(45.5))",
    p.stage === "in_quarter" && p.percent === 46,
    JSON.stringify(p),
  );
}
{
  const lastMs = new Date(q3.end.getTime() - 1);
  const p = roadmapProgress({ status: "in_progress", releaseQuarter: "2026-Q3" }, lastMs);
  check(
    "1ms before quarter end → in_quarter / 90 (cap, not 91)",
    p.stage === "in_quarter" && p.percent === IN_QUARTER_MAX_PERCENT,
    JSON.stringify(p),
  );
}
{
  const p = roadmapProgress({ status: "in_progress", releaseQuarter: "2026-Q3" }, q3.end);
  check(
    "quarter end INSTANT (exclusive bound) → held / 90",
    p.stage === "held" && p.percent === IN_QUARTER_MAX_PERCENT,
    JSON.stringify(p),
  );
}
{
  const p = roadmapProgress(
    { status: "planned", releaseQuarter: "2026-Q1" },
    NOW_IN_Q3, // two quarters later
  );
  check(
    "long-past quarter, still not done → holds at 90 forever",
    p.stage === "held" && p.percent === IN_QUARTER_MAX_PERCENT,
    JSON.stringify(p),
  );
}

check(
  "every stage has a human label (UI renders these directly)",
  roadmapProgressStageLabels.done === "Done" &&
    roadmapProgressStageLabels.unscheduled === "Later" &&
    roadmapProgressStageLabels.scheduled === "Scheduled" &&
    roadmapProgressStageLabels.in_quarter === "In progress" &&
    roadmapProgressStageLabels.held === "Wrapping up",
  JSON.stringify(roadmapProgressStageLabels),
);

// ── Completion quarter (report bucketing) ────────────────────────────────────

check("completionQuarterKey(null) → null", completionQuarterKey(null) === null);
check("completionQuarterKey(undefined) → null", completionQuarterKey(undefined) === null);
check(
  "completionQuarterKey(Date in Aug 2026) → '2026-Q3'",
  completionQuarterKey(utc(2026, 7, 10)) === "2026-Q3",
);
check(
  "completionQuarterKey(ISO string) works (JSON payloads arrive as strings)",
  completionQuarterKey("2026-01-01T00:00:00.000Z") === "2026-Q1",
);
check(
  "completionQuarterKey boundary: Jun 30 23:59:59.999Z → Q2",
  completionQuarterKey("2026-06-30T23:59:59.999Z") === "2026-Q2",
);
check(
  "completionQuarterKey boundary: Jul 1 00:00Z → Q3",
  completionQuarterKey("2026-07-01T00:00:00.000Z") === "2026-Q3",
);
check("completionQuarterKey('not-a-date') → null", completionQuarterKey("not-a-date") === null);

check("QUARTER_KEY_RE is anchored (no substring matches)", !QUARTER_KEY_RE.test("x2026-Q3y"));

// ── Report "Product updates" quarter-window selection (Task #4216) ──────────
// The selection rule the CEO Pulse block is built from. All fixtures use
// absolute dates with injected `now` so nothing here can go red on a
// calendar schedule.

type SelItem = {
  id: string;
  board: string;
  status: string;
  releaseQuarter: string | null;
  completedAt: string | Date | null;
};
const selItem = (id: string, over: Partial<Omit<SelItem, "id">> = {}): SelItem => ({
  id,
  board: "product",
  status: "in_progress",
  releaseQuarter: "2026-Q3",
  completedAt: null,
  ...over,
});
const ids = (items: Array<{ id: string }>): string => items.map((i) => i.id).join(",");

{
  // NOW_IN_Q3 = 2026-08-10T12:00Z → current window 2026-Q3, previous 2026-Q2.
  const sel = selectReportProductUpdates(
    [
      selItem("up-planned", { status: "planned" }),
      selItem("up-progress", { status: "in_progress" }),
      selItem("done-cur", { status: "shipped", completedAt: utc(2026, 6, 15) }),
      selItem("done-prev", { status: "shipped", completedAt: "2026-05-20T09:00:00.000Z" }),
      selItem("done-old", { status: "shipped", completedAt: utc(2026, 2, 1) }), // Q1 — too old
      selItem("done-undated", { status: "shipped", completedAt: null }), // legacy, no stamp
      selItem("done-garbage", { status: "shipped", completedAt: "not-a-date" }),
      selItem("company-up", { board: "company" }),
      selItem("company-done", { board: "company", status: "shipped", completedAt: utc(2026, 7, 1) }),
      selItem("later", { releaseQuarter: null }),
      selItem("future", { releaseQuarter: "2026-Q4" }),
      selItem("past-held", { releaseQuarter: "2026-Q2" }), // unfinished backlog — not "upcoming"
      selItem("bad-key", { releaseQuarter: "Q3 2026" }), // garbage never equals a real key
    ],
    NOW_IN_Q3,
  );
  check("selection window is now's quarter", sel.quarterKey === "2026-Q3", sel.quarterKey);
  check(
    "upcoming = current-quarter product items not yet shipped, input order kept",
    ids(sel.upcoming) === "up-planned,up-progress",
    ids(sel.upcoming),
  );
  check(
    "completed = shipped with a stamp in the current or previous quarter, newest first",
    ids(sel.completed) === "done-cur,done-prev",
    ids(sel.completed),
  );
  check(
    "company-board items can never appear in either list",
    !ids(sel.upcoming).includes("company") && !ids(sel.completed).includes("company"),
  );
  check(
    "undated/garbage completion stamps are excluded (recency unprovable)",
    !ids(sel.completed).includes("done-undated") && !ids(sel.completed).includes("done-garbage"),
  );
  check(
    "past-quarter unfinished items are NOT upcoming (block shows this quarter, not backlog)",
    !ids(sel.upcoming).includes("past-held") && !ids(sel.upcoming).includes("bad-key"),
  );
}

{
  // Completed ordering + Date-vs-ISO-string equivalence: three stamps out of
  // insertion order sort newest-first regardless of representation.
  const sel = selectReportProductUpdates(
    [
      selItem("d2", { status: "shipped", completedAt: "2026-07-02T00:00:00.000Z" }),
      selItem("d3", { status: "shipped", completedAt: utc(2026, 7, 9) }),
      selItem("d1", { status: "shipped", completedAt: utc(2026, 4, 1) }),
    ],
    NOW_IN_Q3,
  );
  check("completed sorts newest completion first", ids(sel.completed) === "d3,d2,d1", ids(sel.completed));
}

{
  // Boundary instants: previous-quarter start is IN (2026-Q2 begins Apr 1);
  // 1ms earlier lands in Q1 (two quarters back) and is OUT. The current
  // quarter's last millisecond is IN.
  const sel = selectReportProductUpdates(
    [
      selItem("prev-start", { status: "shipped", completedAt: utc(2026, 3, 1) }),
      selItem("q1-last-ms", { status: "shipped", completedAt: utc(2026, 2, 31, 23, 59, 59, 999) }),
      selItem("cur-last-ms", { status: "shipped", completedAt: utc(2026, 8, 30, 23, 59, 59, 999) }),
    ],
    NOW_IN_Q3,
  );
  check(
    "window boundaries: [prev-quarter start, current-quarter end] inclusive by quarter bucketing",
    ids(sel.completed) === "cur-last-ms,prev-start",
    ids(sel.completed),
  );
}

{
  // Q1 year wrap: now in Q1 2027 → previous window is 2026-Q4. A Q3 2026
  // completion is out; upcoming keys match the new year's quarter.
  const nowQ1 = utc(2027, 0, 15, 8);
  const sel = selectReportProductUpdates(
    [
      selItem("wrap-up", { releaseQuarter: "2027-Q1", status: "planned" }),
      selItem("wrap-done-dec", { status: "shipped", completedAt: utc(2026, 11, 20) }),
      selItem("wrap-done-sep", { status: "shipped", completedAt: utc(2026, 8, 10) }),
    ],
    nowQ1,
  );
  check("year wrap: window is 2027-Q1", sel.quarterKey === "2027-Q1", sel.quarterKey);
  check(
    "year wrap: Dec (prev Q4) completion in, Sep (Q3, two back) out; new-year quarter upcoming",
    ids(sel.upcoming) === "wrap-up" && ids(sel.completed) === "wrap-done-dec",
    `up=${ids(sel.upcoming)} done=${ids(sel.completed)}`,
  );
}

{
  const sel = selectReportProductUpdates([], NOW_IN_Q3);
  check(
    "empty input → empty lists but the window is still derived",
    sel.upcoming.length === 0 && sel.completed.length === 0 && sel.quarterKey === "2026-Q3",
  );
}

console.log(`\nroadmap-progress: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
