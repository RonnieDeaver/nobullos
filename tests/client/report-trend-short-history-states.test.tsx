/* test-registration
{
  "name": "Report Historical Trends shared month axis + short-history states + §8.5 card spec — every metric's series spans the FULL trend window with null gaps for not-provided months (never a fake 0, %-clamp kept) so sibling charts always agree on the x-axis; classification keys off DATA month count (0 → 'No data', 1 → unlock card carrying the value incl. a real zero, ≥2 → chart), never axis length; delta chips compare the two most recent months WITH data (Tasks #4226/#4383); §8.5 residuals: 140px card floor on all three states, 2.5px stroke + 0.18→0.04 fill constants, first+last DATA-point value labels only, endpoint-anchored chip with VISIBLE '$-aware' baseline text, never title-only (Task #4274)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Tasks #4226/#4383/#4274: fast, pure SSR/unit contract of the client-facing TrendsSection + buildTrendMetricSeries; a drift here ships per-metric private axes (the exact reported 4-vs-2-vs-5-month glitch), fake 0 points, baseless or wrong-month delta chips, hover-only baselines ('↑100%' over a blank plot), mislabeled endpoints, url()-invalid gradient ids (the '(BETA)' solid-black-rectangle plot), or a no-data card over real zero measurements to paying clients.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Tasks #4226 + #4383 — Historical Trends: shared month axis + short-history
 * states.
 *
 * Task #4383 (bug report): each mini chart used to filter its metric's null
 * months away and build a PRIVATE x-axis from the survivors, so sibling
 * charts in one section disagreed on month count (# of Cases 4 months,
 * Consult→Case 2, Avg Case Value 5) and correct data read as glitched.
 * The contract now:
 *
 *   - buildTrendMetricSeries emits ONE point per month of the full trend
 *     window for every metric (axis equality), with value null for months
 *     the metric wasn't provided (a gap — never a fabricated 0, per Task
 *     #3688), keeping the Task #2680 %-clamp;
 *   - classification keys off the DATA month count, never the axis length:
 *     0 → "No data", 1 → "Trends unlock with next month's report" card
 *     carrying the value (a stored ZERO is a real measurement per report
 *     semantics — only null means "not provided"), ≥2 → chart card;
 *   - the delta chip compares the two most recent months WITH data (the
 *     builder's deltaPair), so trailing/interior gaps never produce a
 *     baseless or wrong-month chip, and no chip exists below 2 data months.
 *
 * Task #4274 (§8.5 trend-card spec residuals) adds: every card state (chart /
 * unlock / No data) holds the 140px min-height floor; the stroke width and
 * area-fill ramp are single-sourced constants pinned to the audited values
 * (2.5px, 0.18→0.04); first+last DATA points get in-chart value labels (gap
 * months and interior points never do); and the delta chip is anchored to the
 * chart endpoint with explicit VISIBLE baseline text ("46.3% vs 32.3% in
 * Jan") — never a hover-only title — with '$' formatted as a prefix unit.
 *
 * Uses react-dom/server renderToStaticMarkup — the classification paths
 * return plain divs before any recharts/DOM work, so no jsdom is needed;
 * axis/gap/delta assertions go through the exported pure builder. (The
 * recharts SVG itself doesn't render in SSR, so the in-chart label rule is
 * asserted through the exported pure trendEndpointLabelText the renderer
 * delegates to.)
 */

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TrendsSection,
  buildTrendMetricSeries,
  formatTrendValue,
  trendEndpointLabelText,
  trendGradientId,
  TREND_STROKE_WIDTH,
  TREND_FILL_TOP_OPACITY,
  TREND_FILL_BOTTOM_OPACITY,
} from "../../client/src/pages/PublicReport";

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// Undo the few HTML entities React emits in attributes/text so string
// assertions can use plain copy (e.g. "Jun '26" not "Jun &#x27;26").
function unescapeHtml(html: string): string {
  return html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

type MonthOverrides = {
  consults?: number | null;
  l2c?: number | null;
  cases?: number | null;
  c2c?: number | null;
  acv?: number | null;
};

// One full-window trend entry; every metric not overridden is null — the
// exact server shape from Task #3688 (null = "not provided that month").
const month = (m: string, p: MonthOverrides = {}) => ({
  month: m,
  intake: {
    totalConsults: p.consults ?? null,
    leadToConsultRate: p.l2c ?? null,
    missedCallRate: null,
    avgTimeToAnswer: null,
    qualityScore: null,
  },
  sales: {
    totalCases: p.cases ?? null,
    consultToCaseRate: p.c2c ?? null,
    avgCaseValue: p.acv ?? null,
    noShowRate: null,
    avgFollowUps: null,
    qualityScore: null,
  },
  marketing: { totalLeads: 0, totalReviews: 0, leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 } },
} as any);

function render(
  trendData: any[],
  section: "intake" | "sales",
  metrics: Array<{ key: string; label: string; unit?: string }>,
): string {
  return unescapeHtml(
    renderToStaticMarkup(
      <TrendsSection trendData={trendData} section={section} metrics={metrics} />,
    ),
  );
}

// ————————————————————————————————————————————————————————————————————————
// The reported presence pattern: history 2025-12 → 2026-07 (multi-year
// window), consults + lead→consult with 4 data months (Apr–Jul), # of Cases
// 4 (Apr–Jul), Consult→Case 2 (Jun–Jul), Avg Case Value 5 (Mar–Jul).
// Synthetic values; only the null/presence matrix mirrors the report.
// ————————————————————————————————————————————————————————————————————————
const reportedWindow = [
  month("2025-12"),
  month("2026-01"),
  month("2026-02"),
  month("2026-03", { acv: 8000 }),
  month("2026-04", { consults: 10, l2c: 20, cases: 3, acv: 9000 }),
  month("2026-05", { consults: 12, l2c: 25, cases: 4, acv: 8500 }),
  month("2026-06", { consults: 11, l2c: 22, cases: 2, c2c: 40, acv: 9500 }),
  month("2026-07", { consults: 14, l2c: 30, cases: 5, c2c: 50, acv: 12000 }),
];
const fullWindowMonths = reportedWindow.map((m: any) => m.month);

// (1) Axis equality: metrics with divergent presence patterns all get the
// identical full-window month axis.
{
  const series = {
    consults: buildTrendMetricSeries(reportedWindow, "intake", { key: "totalConsults" }),
    l2c: buildTrendMetricSeries(reportedWindow, "intake", { key: "leadToConsultRate", unit: "%" }),
    cases: buildTrendMetricSeries(reportedWindow, "sales", { key: "totalCases" }),
    c2c: buildTrendMetricSeries(reportedWindow, "sales", { key: "consultToCaseRate", unit: "%" }),
    acv: buildTrendMetricSeries(reportedWindow, "sales", { key: "avgCaseValue", unit: "$" }),
  };
  for (const [key, s] of Object.entries(series)) {
    assert.deepEqual(
      s.points.map((p) => p.month),
      fullWindowMonths,
      `series "${key}" must span the full shared window`,
    );
  }
  assert.equal(series.consults.dataCount, 4);
  assert.equal(series.l2c.dataCount, 4);
  assert.equal(series.cases.dataCount, 4);
  assert.equal(series.c2c.dataCount, 2);
  assert.equal(series.acv.dataCount, 5);
  ok("divergent presence patterns (4/4/4/2/5 data months) share the identical full-window axis");

  // (2) Not-provided months stay null gaps — never a fabricated 0.
  assert.deepEqual(
    series.c2c.points.map((p) => p.value),
    [null, null, null, null, null, null, 40, 50],
  );
  assert.deepEqual(
    series.acv.points.map((p) => p.value),
    [null, null, null, 8000, 9000, 8500, 9500, 12000],
  );
  assert.deepEqual(
    series.cases.points.map((p) => p.value),
    [null, null, null, null, 3, 4, 2, 5],
  );
  ok("not-provided months stay null gaps on the shared axis (no fake 0 points)");

  // (3) Delta pair = the two most recent months WITH data.
  assert.deepEqual(series.c2c.deltaPair, {
    previous: { month: "2026-06", value: 40 },
    current: { month: "2026-07", value: 50 },
  });
  assert.deepEqual(series.acv.deltaPair, {
    previous: { month: "2026-06", value: 9500 },
    current: { month: "2026-07", value: 12000 },
  });
  ok("delta pair compares the two most recent data months");

  // (4) Render: all three divergent sales metrics take the chart path on the
  // shared axis — none degrade to 'No data'/unlock — and the 2-data-month
  // Consult→Case chip compares Jul vs Jun with year-aware labels (the
  // window spans 2025→2026; the Task #4265 uniqueness contract).
  const html = render(reportedWindow, "sales", [
    { key: "totalCases", label: "Cases", unit: "" },
    { key: "consultToCaseRate", label: "Consults→Cases", unit: "%" },
    { key: "avgCaseValue", label: "Avg Case Value", unit: "$" },
  ]);
  assert.doesNotMatch(html, /No data/i);
  assert.doesNotMatch(html, /Trends unlock/);
  assert.match(html, /50% vs 40% in Jun '26/);
  ok("reported-pattern render: every chart takes the chart path; the 2-month metric's chip reads Jul-vs-Jun with year-aware labels");
}

// (5) Trailing gaps: a metric whose data STOPS mid-window keeps an honest
// chip — the two most recent months WITH data, not the last axis slots.
{
  const data = [
    month("2026-01", { consults: 5 }),
    month("2026-02", { consults: 8 }),
    month("2026-03"),
    month("2026-04"),
  ];
  const s = buildTrendMetricSeries(data, "intake", { key: "totalConsults" });
  assert.deepEqual(s.points.map((p) => p.value), [5, 8, null, null]);
  assert.deepEqual(s.deltaPair, {
    previous: { month: "2026-01", value: 5 },
    current: { month: "2026-02", value: 8 },
  });
  const html = render(data, "intake", [{ key: "totalConsults", label: "Consults", unit: "" }]);
  assert.match(html, /8 vs 5 in Jan/);
  assert.doesNotMatch(html, /Trends unlock/);
  ok("trailing-gap metric: chart path with the chip comparing the last two DATA months (Feb vs Jan)");
}

// (6) An interior gap still takes the chart path; the chip skips the null
// month.
{
  const data = [
    month("2026-01", { consults: 4 }),
    month("2026-02"),
    month("2026-03", { consults: 6 }),
  ];
  const s = buildTrendMetricSeries(data, "intake", { key: "totalConsults" });
  assert.deepEqual(s.points.map((p) => p.value), [4, null, 6]);
  assert.deepEqual(s.deltaPair, {
    previous: { month: "2026-01", value: 4 },
    current: { month: "2026-03", value: 6 },
  });
  const html = render(data, "intake", [{ key: "totalConsults", label: "Consults", unit: "" }]);
  assert.doesNotMatch(html, /Trends unlock/);
  assert.doesNotMatch(html, /No data/i);
  assert.match(html, /6 vs 4 in Jan/);
  ok("interior gap: chart path with the chip skipping the null month (Mar vs Jan)");
}

// (7) The Task #2680 %-clamp survives in the builder: a legacy absurd
// persisted rate plots at 100, never raw.
{
  const s = buildTrendMetricSeries(
    [month("2026-01", { l2c: 5300 }), month("2026-02", { l2c: 40 })],
    "intake",
    { key: "leadToConsultRate", unit: "%" },
  );
  assert.deepEqual(s.points.map((p) => p.value), [100, 40]);
  ok("%-unit series keep the 0–100 clamp (legacy 5,300% plots as 100)");
}

// (8) Classification keys off DATA months, not axis length: 1 data month on
// an 8-month multi-year axis → unlock card with the value (year-aware month
// label), no chip, never 'No data'.
{
  const oneData = [
    month("2025-12"),
    month("2026-01"),
    month("2026-02"),
    month("2026-03", { consults: 9 }),
    month("2026-04"),
    month("2026-05"),
    month("2026-06"),
    month("2026-07"),
  ];
  const s = buildTrendMetricSeries(oneData, "intake", { key: "totalConsults" });
  assert.equal(s.dataCount, 1);
  assert.equal(s.deltaPair, null);
  const html = render(oneData, "intake", [{ key: "totalConsults", label: "Consults", unit: "" }]);
  assert.match(html, /Trends unlock with next month/);
  assert.match(html, /9 in Mar '26/);
  assert.doesNotMatch(html, /No data/i);
  assert.doesNotMatch(html, /[↑↓]/);
  ok("single data month on a multi-month multi-year axis: unlock card (value + year-aware month), no chip, never 'No data'");
}

// (9 — kept from #4226) A single stored-ZERO measurement is data: unlock
// card with "0 in Feb", never 'No data' (only null means "not provided").
{
  const html = render([month("2026-02", { consults: 0 })], "intake", [
    { key: "totalConsults", label: "Consults", unit: "" },
  ]);
  assert.match(html, /Trends unlock with next month/);
  assert.match(html, /0 in Feb/);
  assert.doesNotMatch(html, /No data/i);
  ok("a single stored-zero measurement renders the unlock card (zero is data, only null is 'not provided')");
}

// (10 — extended from #4226) A metric null in EVERY window month renders
// 'No data' even though the shared axis is long (sibling intake data keeps
// the window multi-month).
{
  const html = render(
    [
      month("2026-01", { consults: 4 }),
      month("2026-02", { consults: 6 }),
      month("2026-03", { consults: 5 }),
    ],
    "sales",
    [{ key: "totalCases", label: "Cases", unit: "" }],
  );
  assert.match(html, /No data/);
  assert.doesNotMatch(html, /Trends unlock/);
  ok("a metric with zero data months renders 'No data' regardless of axis length");
}

// ————————————————————————————————————————————————————————————————————————
// Task #4274 — §8.5 trend-card spec residuals: 140px card floor, 2.5px
// stroke + 0.18→0.04 fill constants, first+last point value labels, delta
// chip anchored to the endpoint with explicit VISIBLE baseline text.
// ————————————————————————————————————————————————————————————————————————

// (11) Spec constants lockstep — the component's only stroke/fill source
// (used directly in the Area/linearGradient props), pinned to §8.5.
{
  assert.equal(TREND_STROKE_WIDTH, 2.5);
  assert.equal(TREND_FILL_TOP_OPACITY, 0.18);
  assert.equal(TREND_FILL_BOTTOM_OPACITY, 0.04);
  ok("§8.5 constants: 2.5px stroke, 0.18→0.04 area fill ramp");
}

// (12) formatTrendValue — '$' is a PREFIX unit with thousands separators
// (never "12000$"); every other unit appends; bare numbers pass through.
{
  assert.equal(formatTrendValue(12000, "$"), "$12,000");
  assert.equal(formatTrendValue(46.3, "%"), "46.3%");
  assert.equal(formatTrendValue(11, "s"), "11s");
  // Task #4287 — seconds normalize to whole values on display: entered data
  // like 10.99 must render "11s", one precision convention deck-wide.
  assert.equal(formatTrendValue(10.99, "s"), "11s");
  assert.equal(formatTrendValue(0, ""), "0");
  ok("formatTrendValue: $-prefix with separators, suffix units append, seconds round whole, zero passes through");
}

// (13) Endpoint value labels render ONLY at the first and last data indexes
// on the shared axis — interior points, null gap slots, and undefined
// recharts callback args all suppress (axis shape: [gap, 4, 7, gap, 9, gap]).
{
  const first = 1;
  const last = 4;
  assert.equal(trendEndpointLabelText(1, 4, first, last, ""), "4");
  assert.equal(trendEndpointLabelText(4, 9, first, last, ""), "9");
  assert.equal(trendEndpointLabelText(2, 7, first, last, ""), null, "interior data point must not label");
  assert.equal(trendEndpointLabelText(0, null, first, last, ""), null, "null gap slot must not label");
  assert.equal(trendEndpointLabelText(5, undefined, first, last, ""), null);
  assert.equal(trendEndpointLabelText(undefined, 9, first, last, ""), null);
  assert.equal(trendEndpointLabelText(4, 12000, first, last, "$"), "$12,000");
  assert.equal(trendEndpointLabelText(1, 46.3, first, last, "%"), "46.3%");
  ok("endpoint value labels: first+last DATA indexes only; gaps, interior points, and undefined args suppress");
}

// (14) The delta chip is anchored to the endpoint row with explicit VISIBLE
// baseline text — element text, never a hover-only title attribute — and the
// $-metric baseline goes through the $ formatter.
{
  const html = render(reportedWindow, "sales", [
    { key: "consultToCaseRate", label: "Consults→Cases", unit: "%" },
    { key: "avgCaseValue", label: "Avg Case Value", unit: "$" },
  ]);
  assert.match(html, />50% vs 40% in Jun '26</, "baseline must be visible element text");
  assert.match(html, />\$12,000 vs \$9,500 in Jun '26</, "$-metric baseline must be $-formatted visible text");
  assert.doesNotMatch(html, /title="[^"]*vs[^"]*"/, "baseline must never be a hover-only title");
  assert.match(html, /data-testid="trend-endpoint-Consults→Cases"/);
  assert.match(html, /data-testid="trend-endpoint-AvgCaseValue"/);
  ok("delta chip: endpoint-anchored row with visible (never title-only) baseline text, $-aware");
}

// (15) Every §8.5 card state holds the 140px floor — chart cards, the unlock
// card, and the explicit-absence 'No data' card; the pre-spec 120px floor is
// gone.
{
  const chartHtml = render(reportedWindow, "sales", [
    { key: "totalCases", label: "Cases", unit: "" },
    { key: "avgCaseValue", label: "Avg Case Value", unit: "$" },
  ]);
  assert.equal((chartHtml.match(/min-h-\[140px\]/g) || []).length, 2, "every chart card carries the 140px floor");
  const unlockHtml = render([month("2026-02", { consults: 0 })], "intake", [
    { key: "totalConsults", label: "Consults", unit: "" },
  ]);
  assert.match(unlockHtml, /min-h-\[140px\]/);
  const noDataHtml = render(
    [month("2026-01", { consults: 4 }), month("2026-02", { consults: 6 })],
    "sales",
    [{ key: "totalCases", label: "Cases", unit: "" }],
  );
  assert.match(noDataHtml, /min-h-\[140px\]/);
  for (const [state, h] of [["chart", chartHtml], ["unlock", unlockHtml], ["no-data", noDataHtml]] as const) {
    assert.doesNotMatch(h, /min-h-\[120px\]/, `${state} state must not keep the pre-spec 120px floor`);
  }
  ok("all three card states (chart / unlock / No data) hold the §8.5 140px min-height floor");
}

// (16) Gradient ids must be valid SVG url(#id) references: characters like
// '()' in a metric label ("Pipeline Momentum (BETA)") once produced an
// invalid paint reference that rendered the area as a SOLID BLACK rectangle.
{
  assert.equal(trendGradientId("light", "Pipeline Momentum (BETA)"), "gradient-light-PipelineMomentumBETA");
  assert.equal(trendGradientId("dark", "Consults→Cases"), "gradient-dark-ConsultsCases");
  assert.match(trendGradientId("light", "Avg. Time to Human-Answer (p50)"), /^[A-Za-z0-9-]+$/);
  ok("gradient ids sanitize to url()-safe alphanumerics (the (BETA) black-rectangle regression)");
}

console.log(`\nReport trend shared-axis + short-history states: ${passed} checks passed`);
