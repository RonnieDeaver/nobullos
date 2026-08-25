/* test-registration
{
  "name": "Review-velocity math \u2014 trailing average + sparse history (Task #2580)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Unit test for the review-velocity derivation extracted from the Public
 * Report's Review Generation panel (Task #2566 math, extracted + tested in
 * Task #2580).
 *
 * The helper builds a monthly reviews/month series from a trendData-shaped
 * payload, pins the latest series point to the panel total (so the headline
 * number and the latest trend point agree), computes the mean of the last
 * up-to-3 available months as the trailing average, and picks the
 * "Current month" vs "N-day trailing average" label based on how much history
 * is available.
 *
 * Fixtures cover:
 *  - 3+ months of history (full 90-day window + averaging across exactly the
 *    last 3 months, ignoring older months),
 *  - exactly 1 month (single point, "Current month" label),
 *  - exactly 2 months ("60-day trailing average" label),
 *  - empty history (no points, trailing average falls back to the panel total,
 *    "Current month" label),
 *  - the latest series point always equals the panel total (pinning),
 *  - missing/nullish marketing.totalReviews coerces to 0,
 *  - the trailing average is rounded to one decimal place.
 *
 * Task #4844 adds three fields (same fixtures, extended asserts): currentMonth
 * (the latest — pinned — series point, panel-total fallback with no history),
 * windowTotal (sum over the SAME up-to-3-month window the average divides,
 * panel-total fallback), and totalLabel ("90-day total" / "60-day total" /
 * "Current month" — the same sparse-history honesty rule as avgLabel).
 */

import {
  computeReviewVelocity,
  computeReviewVelocityChange,
  type ReviewVelocityPoint,
  type ReviewVelocityTrendInput,
} from "../../client/src/lib/reviewVelocity";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

function trend(month: string, totalReviews: number): ReviewVelocityTrendInput {
  return { month, marketing: { totalReviews } };
}

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("review-velocity math");

// --- 3+ months of history -------------------------------------------------
test("3+ months: averages exactly the last 3 months, ignoring older ones", () => {
  // 5 months; latest point gets pinned to panelTotal (40). The trailing
  // window is the last 3 points: [30, 35(prev month value), 40(pinned)].
  const data = [
    trend("2026-01", 10),
    trend("2026-02", 20),
    trend("2026-03", 30),
    trend("2026-04", 35),
    trend("2026-05", 99), // overwritten by panelTotal pin
  ];
  const result = computeReviewVelocity(data, 40);

  assertEqual(result.series.length, 5, "series has one point per trend month");
  assertEqual(result.monthsCount, 3, "trailing window caps at 3 months");
  // (30 + 35 + 40) / 3 = 35
  assertEqual(result.trailingAvg, 35, "mean of last 3 months");
  assertEqual(
    result.avgLabel,
    "90-day trailing average",
    "3-month window labelled 90-day",
  );
  // Task #4844 — current month is the latest (pinned) point; the window total
  // sums the SAME last-3-month window the average divides (30 + 35 + 40).
  assertEqual(result.currentMonth, 40, "current month = latest pinned point");
  assertEqual(result.windowTotal, 105, "window total sums the last 3 months");
  assertEqual(result.totalLabel, "90-day total", "3-month window total labelled 90-day");
  // older months excluded from the average but still present in the series
  assertEqual(result.series[0].value, 10, "oldest month preserved in series");
});

// --- exactly 1 month ------------------------------------------------------
test("exactly 1 month: single point, Current month label", () => {
  const result = computeReviewVelocity([trend("2026-05", 7)], 12);
  assertEqual(result.series.length, 1, "one series point");
  assertEqual(result.monthsCount, 1, "one month in window");
  assertEqual(result.trailingAvg, 12, "trailing avg equals the single pinned point");
  assertEqual(result.avgLabel, "Current month", "single month uses Current month label");
  // Task #4844 — with a 1-month window all three stats collapse to the same
  // pinned value and the total label honestly says "Current month", never 90-day.
  assertEqual(result.currentMonth, 12, "current month = the single pinned point");
  assertEqual(result.windowTotal, 12, "window total = the single pinned point");
  assertEqual(result.totalLabel, "Current month", "single month total labelled Current month");
});

// --- exactly 2 months -----------------------------------------------------
test("exactly 2 months: 60-day trailing average", () => {
  const data = [trend("2026-04", 10), trend("2026-05", 99)];
  const result = computeReviewVelocity(data, 20);
  assertEqual(result.monthsCount, 2, "two months in window");
  // (10 + 20) / 2 = 15
  assertEqual(result.trailingAvg, 15, "mean of the two months (latest pinned)");
  assertEqual(result.avgLabel, "60-day trailing average", "2-month window labelled 60-day");
  // Task #4844 — 2-month window: total sums both months, labelled 60-day.
  assertEqual(result.currentMonth, 20, "current month = latest pinned point");
  assertEqual(result.windowTotal, 30, "window total sums the two months");
  assertEqual(result.totalLabel, "60-day total", "2-month window total labelled 60-day");
});

// --- empty history --------------------------------------------------------
test("empty history: falls back to panel total, Current month label", () => {
  const result = computeReviewVelocity([], 25);
  assertEqual(result.series.length, 0, "no series points");
  assertEqual(result.monthsCount, 0, "no months in window");
  assertEqual(result.trailingAvg, 25, "trailing avg falls back to panel total");
  assertEqual(result.avgLabel, "Current month", "no history uses Current month label");
  // Task #4844 — no history: month + total fall back to the panel total
  // (mirroring trailingAvg's fallback), labelled Current month.
  assertEqual(result.currentMonth, 25, "current month falls back to panel total");
  assertEqual(result.windowTotal, 25, "window total falls back to panel total");
  assertEqual(result.totalLabel, "Current month", "no history total labelled Current month");
});

test("null/undefined trendData behaves like empty history", () => {
  for (const empty of [null, undefined]) {
    const result = computeReviewVelocity(empty, 5);
    assertEqual(result.series.length, 0, "no series points");
    assertEqual(result.trailingAvg, 5, "trailing avg falls back to panel total");
    assertEqual(result.avgLabel, "Current month", "Current month label");
    assertEqual(result.currentMonth, 5, "current month falls back to panel total");
    assertEqual(result.windowTotal, 5, "window total falls back to panel total");
    assertEqual(result.totalLabel, "Current month", "Current month total label");
  }
});

// --- latest point equals the panel total (pinning) ------------------------
test("latest series point always equals the panel total", () => {
  const data = [trend("2026-03", 1), trend("2026-04", 2), trend("2026-05", 3)];
  for (const panelTotal of [0, 3, 50]) {
    const result = computeReviewVelocity(data, panelTotal);
    const latest = result.series[result.series.length - 1];
    assertEqual(latest.value, panelTotal, `latest point pinned to panel total ${panelTotal}`);
    // Task #4844 — currentMonth IS that pinned latest point, so the "This
    // month" stat always agrees with the sparkline's latest point.
    assertEqual(result.currentMonth, panelTotal, `currentMonth pinned to panel total ${panelTotal}`);
    // non-latest points keep their own trend values
    assertEqual(result.series[0].value, 1, "non-latest point keeps its own value");
  }
});

// --- missing marketing data coerces to 0 ----------------------------------
test("missing/nullish marketing.totalReviews coerces to 0", () => {
  const data: ReviewVelocityTrendInput[] = [
    { month: "2026-03" }, // no marketing at all
    { month: "2026-04", marketing: null }, // null marketing
    { month: "2026-05", marketing: { totalReviews: 9 } }, // pinned anyway
  ];
  const result = computeReviewVelocity(data, 6);
  assertEqual(result.series[0].value, 0, "absent marketing → 0");
  assertEqual(result.series[1].value, 0, "null marketing → 0");
  // window = [0, 0, 6] → mean = 2
  assertEqual(result.trailingAvg, 2, "missing months counted as 0 in the average");
  // Task #4844 — the total counts the same zeros: 0 + 0 + 6 = 6.
  assertEqual(result.windowTotal, 6, "missing months counted as 0 in the total");
});

// --- rounding to one decimal place ----------------------------------------
test("trailing average is rounded to one decimal place", () => {
  // window = [1, 2, 2] → mean = 1.6667 → rounds to 1.7
  const data = [trend("2026-03", 1), trend("2026-04", 2), trend("2026-05", 99)];
  const result = computeReviewVelocity(data, 2);
  assertEqual(result.trailingAvg, 1.7, "1.6667 rounds to 1.7");
  // Task #4844 — the total is an exact integer sum, never rounded: 1 + 2 + 2.
  assertEqual(result.windowTotal, 5, "window total is the exact sum (no rounding)");
});

// --- month-over-month change badge (Task #2598) ---------------------------
function point(value: number): ReviewVelocityPoint {
  return { month: "m", value };
}

console.log("\nreview-velocity change badge");

test("increase: positive delta, up direction, badge shown", () => {
  // prev 20 → current 25 = +5 (+25%)
  const c = computeReviewVelocityChange([point(10), point(20), point(25)]);
  assertEqual(c.current, 25, "current is last point");
  assertEqual(c.prev, 20, "prev is second-to-last point");
  assertEqual(c.delta, 5, "delta is current - prev");
  assertEqual(c.pct, 25, "percent change rounded");
  assertEqual(c.show, true, "badge shown on increase");
  assertEqual(c.direction, "up", "direction up on increase");
});

test("decrease: negative delta, down direction, badge shown", () => {
  // prev 40 → current 30 = -10 (-25%)
  const c = computeReviewVelocityChange([point(40), point(30)]);
  assertEqual(c.delta, -10, "negative delta on decrease");
  assertEqual(c.pct, -25, "negative percent change (sign preserved)");
  assertEqual(c.show, true, "badge shown on decrease");
  assertEqual(c.direction, "down", "direction down on decrease");
});

test("no change: delta 0, badge hidden", () => {
  const c = computeReviewVelocityChange([point(15), point(15)]);
  assertEqual(c.delta, 0, "delta is zero when equal");
  assertEqual(c.pct, 0, "percent is zero");
  assertEqual(c.show, false, "badge hidden when delta is 0");
  assertEqual(c.direction, null, "no direction when hidden");
});

test("previous month = 0: no divide-by-zero, badge hidden (no zero baseline)", () => {
  // prev 0 → current 8: delta is +8 but percent guards to 0 (no Infinity/NaN);
  // the badge is hidden because there is no meaningful percent baseline.
  const c = computeReviewVelocityChange([point(0), point(8)]);
  assertEqual(c.prev, 0, "prev is zero");
  assertEqual(c.delta, 8, "delta still reflects the increase");
  assertEqual(c.pct, 0, "percent guarded to 0 when prev is 0 (no divide-by-zero)");
  assert(Number.isFinite(c.pct), "percent is finite, never Infinity/NaN");
  assertEqual(c.show, false, "badge hidden when prev is 0 (no baseline)");
  assertEqual(c.direction, null, "no direction when hidden");
});

test("previous month = 0 and no change: delta 0, badge hidden", () => {
  const c = computeReviewVelocityChange([point(0), point(0)]);
  assertEqual(c.delta, 0, "delta zero");
  assertEqual(c.pct, 0, "percent zero");
  assertEqual(c.show, false, "badge hidden when both zero");
  assertEqual(c.direction, null, "no direction");
});

test("fewer than two points: missing prev coerces to 0", () => {
  const single = computeReviewVelocityChange([point(5)]);
  assertEqual(single.current, 5, "current is the only point");
  assertEqual(single.prev, 0, "missing prev coerces to 0");
  assertEqual(single.delta, 5, "delta is current - 0");
  assertEqual(single.show, false, "badge hidden (prev coerces to 0, no baseline)");

  const empty = computeReviewVelocityChange([]);
  assertEqual(empty.current, 0, "empty current coerces to 0");
  assertEqual(empty.prev, 0, "empty prev coerces to 0");
  assertEqual(empty.delta, 0, "empty delta is 0");
  assertEqual(empty.show, false, "badge hidden on empty series");
});

test("percent change rounds to a whole number", () => {
  // prev 3 → current 4 = +33.33% → rounds to 33
  const c = computeReviewVelocityChange([point(3), point(4)]);
  assertEqual(c.pct, 33, "33.33% rounds to 33");
});

console.log(`\nreview-velocity math: ${passed} test(s) passed`);
