/* test-registration
{
  "name": "Report trend x-axis month labels — multi-year datasets get a 2-digit year suffix on EVERY tick so labels stay unique (never 'Feb Feb'), single-year datasets keep bare month names; the exact formatTrendMonth/trendSpansMultipleYears mapping TrendMiniChart applies (Task #4265)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4265: pure, DB-free, millisecond helper test; a drift here silently ships duplicate month ticks ('Feb Feb') on prospect-facing report trend charts — the exact Task #4258 bug this locks in.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4265 — lock the year-aware trend x-axis label contract from Task
 * #4258. TrendMiniChart (and the inline trend maps in PublicReport) derive
 * every tick via:
 *
 *   const includeYear = trendSpansMultipleYears(data.map(d => d.month));
 *   label = formatTrendMonth(d.month, includeYear);
 *
 * This test exercises the exported helpers through that exact pipeline:
 *   (A) a multi-year dataset yields year-suffixed ("Feb '26" / "Feb '27"),
 *       pairwise-unique labels — never the duplicate "Feb Feb" axis;
 *   (B) a single-year dataset yields bare month names (no apostrophe-year);
 *   (C) malformed/missing months degrade without throwing and never force
 *       year mode on their own.
 */

import assert from "node:assert/strict";
import {
  formatTrendMonth,
  trendSpansMultipleYears,
} from "../../client/src/pages/PublicReport";

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// The exact mapping TrendMiniChart applies to its data prop.
function deriveLabels(months: Array<string | undefined | null>): string[] {
  const includeYear = trendSpansMultipleYears(months);
  return months.map((m) => formatTrendMonth(m, includeYear));
}

// (A) Multi-year dataset: same calendar month across two years — the Task
// #4258 regression case that rendered "Feb Feb".
{
  const labels = deriveLabels(["2026-02", "2026-08", "2027-02"]);
  assert.deepEqual(labels, ["Feb '26", "Aug '26", "Feb '27"]);
  assert.equal(new Set(labels).size, labels.length, "labels must be unique");
  for (const l of labels) {
    assert.match(l, /^[A-Z][a-z]{2} '\d{2}$/, `expected year suffix on "${l}"`);
  }
  ok("multi-year dataset: every tick year-suffixed, all labels unique (no 'Feb Feb')");
}

// (A2) Year boundary with distinct months still suffixes every tick — the
// span check is dataset-wide, not per-point.
{
  const labels = deriveLabels(["2026-11", "2026-12", "2027-01"]);
  assert.deepEqual(labels, ["Nov '26", "Dec '26", "Jan '27"]);
  ok("year-boundary dataset: all ticks suffixed, not just the duplicated ones");
}

// (B) Single-year dataset: bare month names, no year suffix anywhere.
{
  const labels = deriveLabels(["2026-01", "2026-02", "2026-03"]);
  assert.deepEqual(labels, ["Jan", "Feb", "Mar"]);
  for (const l of labels) {
    assert.doesNotMatch(l, /'/, `unexpected year suffix on "${l}"`);
  }
  ok("single-year dataset: bare month names with no year suffix");
}

// (C) Degenerate inputs: null/undefined/malformed months never throw and
// never count as a distinct "year" that flips the whole axis into year mode.
{
  assert.equal(trendSpansMultipleYears(["2026-01", null, undefined, ""]), false);
  // Malformed strings must not count as a distinct "year" either — only
  // well-formed YYYY-MM months participate in the span check.
  assert.equal(trendSpansMultipleYears(["2026-01", "malformed"]), false);
  assert.equal(trendSpansMultipleYears(["2026-01", "foo-02"]), false);
  assert.equal(trendSpansMultipleYears(["2026-01", "2026-13"]), false);
  // Suffix-malformed values with a plausible YYYY-MM prefix must not count
  // either — only an exact YYYY-MM month participates in the span check.
  assert.equal(trendSpansMultipleYears(["2026-01", "2027-02-invalid"]), false);
  assert.equal(trendSpansMultipleYears(["2026-01", "2026-01-garbage"]), false);
  const labels = deriveLabels(["2026-01", null, undefined, "", "malformed", "foo-02", "2026-13"]);
  assert.equal(labels[0], "Jan", "the valid month must stay a bare month name");
  assert.doesNotMatch(labels[0], /'/);
  // Malformed entries degrade to some non-crashing string.
  for (const l of labels) assert.equal(typeof l, "string");
  // And a genuinely multi-year set still flips year mode with junk present.
  assert.equal(trendSpansMultipleYears(["2026-01", "garbage", "2027-01"]), true);
  ok("null/malformed/out-of-range months degrade safely and never force (or suppress) year mode");
}

console.log(`\nReport trend month-label uniqueness: ${passed} checks passed`);
