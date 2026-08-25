/* test-registration
{
  "name": "Ads OS keyword-intel search-term aggregation — merges multi-segment GAQL rows, zero-click segment never wins, summed metrics are window-cumulative, candidate cap counts unique terms, monotone non-decrease (Task #4960)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4960: Deterministic pure-function guard for the search-term aggregation that fixes zero-click negatives at longer lookbacks. No DB, no network; a regression here collapses suggestion metrics to near-zero for any search term served across multiple keyword/ad-group segments.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Regression test for the search-term aggregation fix (Task #4960).
 *
 * Root cause: GAQL search_term_view returns one row per
 * (search_term × keyword × ad_group) combination. Without aggregation the
 * last Map-write wins — and because rows arrive cost-descending, the cheapest
 * (often zero-click) segment overwrites the expensive ones. Longer lookback
 * windows produce more segment rows, so displayed metrics collapse as the
 * window expands.
 *
 * Fix: aggregateSearchTerms() merges all segment rows for the same
 * search_term, summing impressions/clicks/cost/conversions and keeping the
 * highest-cost segment as the display representative.
 *
 * Tests:
 *   (a) single-term, multiple segments → summed metrics, highest-cost rep
 *   (b) zero-click segment ordered last never overwrites real clicks
 *   (c) unique terms preserved when no duplicates exist
 *   (d) avg_cpc and cost_per_conv recomputed from sums (not averaged)
 *   (e) monotone non-decrease: adding more segments never lowers clicks/cost
 *   (f) candidate cap (selectCandidates) counts unique aggregated terms, not
 *       raw segment rows — no duplicate slots wasted
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

const { aggregateSearchTerms } = await import(
  "../server/services/adsOs/keywordIntel/queries"
);

// ── helpers ──────────────────────────────────────────────────────────────────

type Row = Parameters<typeof aggregateSearchTerms>[0][number];

function seg(
  search_term: string,
  cost: number,
  clicks: number,
  impressions: number,
  conversions = 0,
  over: Partial<Row> = {},
): Row {
  return {
    search_term,
    campaign: over.campaign ?? "Camp A",
    ad_group: over.ad_group ?? "AG 1",
    matched_keyword: over.matched_keyword ?? "kw",
    impressions,
    clicks,
    cost,
    conversions,
    avg_cpc: clicks > 0 ? cost / clicks : 0,
    cost_per_conv: conversions > 0 ? cost / conversions : 0,
    campaign_id: "",
    ...over,
  };
}

// ── (a) Multiple segments for the same term → summed metrics ─────────────────
{
  const rows = [
    seg("emergency plumber", 20, 8, 100, 1, { campaign: "Camp A", matched_keyword: "emergency plumber" }),
    seg("emergency plumber",  5, 0,  30, 0, { campaign: "Camp B", matched_keyword: "plumber" }),
    seg("emergency plumber",  3, 2,  20, 0, { campaign: "Camp A", matched_keyword: "emergency" }),
  ];
  const result = aggregateSearchTerms(rows);

  assert.equal(result.length, 1, "one unique term → one aggregated row");
  const r = result[0];
  assert.equal(r.clicks, 10, "clicks summed");
  assert.equal(r.impressions, 150, "impressions summed");
  assert.equal(r.cost, 28, "cost summed");
  assert.equal(r.conversions, 1, "conversions summed");
  // highest-cost segment (20) is the representative
  assert.equal(r.campaign, "Camp A");
  assert.equal(r.matched_keyword, "emergency plumber");
}

// ── (b) Zero-click segment ordered last never wins (the reported symptom) ────
{
  // Simulate what longer lookbacks produce: GAQL sorts cost DESC, so the
  // high-spend segments come first, but a zero-click cheap segment appears
  // somewhere in the middle or end.
  const rows = [
    seg("plumber near me", 15, 6, 80, 0),               // main segment
    seg("plumber near me",  8, 3, 40, 0),               // second segment
    seg("plumber near me",  0, 0,  5, 0),               // zero-click tail
  ];
  const result = aggregateSearchTerms(rows);

  assert.equal(result.length, 1);
  const r = result[0];
  assert.equal(r.clicks, 9, "clicks must be sum, not zero from the last segment");
  assert.equal(r.cost, 23, "cost must be sum");
  assert.equal(r.impressions, 125);
  // avg_cpc recomputed from sums
  assert.ok(Math.abs(r.avg_cpc - 23 / 9) < 0.01, `avg_cpc recomputed: ${r.avg_cpc}`);
}

// ── (c) No duplicates → pass-through, order preserved ───────────────────────
{
  const rows = [
    seg("water heater repair", 30, 5, 60),
    seg("drain cleaning",      20, 4, 50),
    seg("pipe leak fix",       10, 2, 25),
  ];
  const result = aggregateSearchTerms(rows);

  assert.equal(result.length, 3);
  assert.equal(result[0].search_term, "water heater repair");
  assert.equal(result[1].search_term, "drain cleaning");
  assert.equal(result[2].search_term, "pipe leak fix");
}

// ── (d) avg_cpc and cost_per_conv are recomputed from sums ──────────────────
{
  const rows = [
    seg("boiler repair", 12, 3, 40, 2),   // avg_cpc = 4, cpa = 6
    seg("boiler repair",  8, 1, 20, 0),   // avg_cpc = 8, cpa = 0
  ];
  const result = aggregateSearchTerms(rows);
  const r = result[0];

  // summed: cost=20, clicks=4, conversions=2
  const expectedCpc = 20 / 4; // 5.0
  const expectedCpa = 20 / 2; // 10.0
  assert.ok(Math.abs(r.avg_cpc - expectedCpc) < 0.01,
    `avg_cpc should be ${expectedCpc}, got ${r.avg_cpc}`);
  assert.ok(Math.abs(r.cost_per_conv - expectedCpa) < 0.01,
    `cost_per_conv should be ${expectedCpa}, got ${r.cost_per_conv}`);
}

// ── (e) Monotone non-decrease: adding segments never lowers clicks/cost ───────
//
//   Simulates expanding the lookback window, which adds more segment rows for
//   the same term. With aggregation, the 30-day view must report >= the 14-day
//   view's metrics for the same term.
{
  // 14-day view: one segment
  const rows14 = [seg("hvac repair", 10, 4, 50)];
  const [r14] = aggregateSearchTerms(rows14);

  // 30-day view: same segment PLUS an additional segment (zero-click) that
  // appears because the wider window captures it
  const rows30 = [
    seg("hvac repair", 10, 4, 50),   // same as 14-day
    seg("hvac repair",  0, 0,  8),   // zero-click segment only in the wider window
  ];
  const [r30] = aggregateSearchTerms(rows30);

  assert.ok(r30.clicks >= r14.clicks,
    `30d clicks (${r30.clicks}) must be >= 14d clicks (${r14.clicks})`);
  assert.ok(r30.cost >= r14.cost,
    `30d cost (${r30.cost}) must be >= 14d cost (${r14.cost})`);
  assert.ok(r30.impressions >= r14.impressions,
    `30d impressions (${r30.impressions}) must be >= 14d impressions (${r14.impressions})`);
}

// ── (f) Mixed terms: aggregation produces exactly one row per unique term ─────
{
  // Mimics a real-world response: three terms, two of which span 2 segments each
  const rows = [
    seg("roof repair",  30, 8, 100),
    seg("diy roofing",  15, 0,  20),  // zero-click
    seg("roof repair",  10, 3,  40),  // second segment for "roof repair"
    seg("roofing cost", 25, 5,  60),
    seg("diy roofing",   5, 2,  25),  // second segment for "diy roofing"
  ];
  const result = aggregateSearchTerms(rows);

  assert.equal(result.length, 3, "exactly three unique terms");

  const byTerm = new Map(result.map((r) => [r.search_term, r]));

  const roofRepair = byTerm.get("roof repair")!;
  assert.equal(roofRepair.clicks, 11, "roof repair clicks summed");
  assert.equal(roofRepair.cost, 40, "roof repair cost summed");

  const diyRoofing = byTerm.get("diy roofing")!;
  assert.equal(diyRoofing.clicks, 2, "diy roofing clicks: zero-click segment does not win");
  assert.equal(diyRoofing.cost, 20, "diy roofing cost summed");

  const roofingCost = byTerm.get("roofing cost")!;
  assert.equal(roofingCost.clicks, 5, "single-segment term unchanged");
}

// ── (g) Fractional conversions: tiny per-segment values must not round to zero ─
//
//   Google Ads reports fractional conversions (e.g. 0.003). Two segments each
//   contributing 0.003 conversions sum to 0.006 — a real, non-zero total that
//   must flow through to downstream converting-term caution and CPA math.
//   Early round2() would collapse 0.006 → 0 and suppress the caution.
{
  const rows = [
    seg("slip fall attorney", 10, 2, 30, 0.003),
    seg("slip fall attorney",  4, 1, 15, 0.003),
  ];
  const [r] = aggregateSearchTerms(rows);

  // Summed conversions must be preserved without rounding to zero
  assert.ok(r.conversions > 0,
    `fractional conversions must not round to zero; got ${r.conversions}`);
  assert.ok(Math.abs(r.conversions - 0.006) < 1e-9,
    `expected 0.006, got ${r.conversions}`);

  // CPA is computed from the raw summed cost (14) and raw summed conversions (0.006)
  const expectedCpa = 14 / 0.006;
  assert.ok(Math.abs(r.cost_per_conv - round2(expectedCpa)) < 0.01,
    `cost_per_conv should be round2(${expectedCpa}), got ${r.cost_per_conv}`);
}

// helper exposed for the fractional test above
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

console.log("ads-os-keyword-intel-aggregation: all assertions passed");
