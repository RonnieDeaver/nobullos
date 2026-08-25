/* test-registration
{
  "name": "Google Ads sync conversion-value + cost micros mapping (Task #2528)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2528 — Pin how the Google Ads sync PARSES + STORES money values from a
 * GAQL campaign response. Task #2509 pinned the query *text*; nothing covered
 * how the *response* is converted into the upsert payload, so a regression that
 * swapped the two money units would again silently corrupt reported numbers.
 *
 * The Google Ads API reports two DIFFERENT units on the same campaign row:
 *   - `metrics.cost_micros`, `metrics.average_cpc`, `campaign_budget.amount_micros`
 *     are integer MICROS (1_000_000 = 1 unit of account currency) → dollars = ÷1e6.
 *   - `metrics.conversions_value` is a DOUBLE already in the account currency
 *     (e.g. dollars), NOT micros. `metrics.conversions_value_micros` does not
 *     exist. So the micros column = value × 1e6 (rounded) and the dollar column
 *     is the raw double. Treating it as already-micros was the Task #2508 bug.
 *
 * Pure in-memory: drives the exported `mapCampaignRows` seam with fixed rows —
 * no DB, no network, no live sync.
 */
import { strict as assert } from "node:assert";

import { mapCampaignRows } from "../server/services/googleAdsIntegration";

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

const CUSTOMER_ID = "1234567890";

/** A single GAQL campaign row in the shape `gaqlSearchStream` yields (camelCase
 * field names, money as the API reports it). */
function campaignRow(overrides: {
  campaignId?: string | number;
  date?: string;
  costMicros?: number | string;
  conversionsValue?: number | string;
  conversions?: number | string;
  averageCpc?: number | string;
  impressions?: number | string;
  clicks?: number | string;
  ctr?: number | string;
  budgetMicros?: number | string;
}): any {
  return {
    campaign: {
      id: overrides.campaignId ?? 111,
      name: "Test Campaign",
      status: "ENABLED",
      advertisingChannelType: "SEARCH",
      startDate: "2026-01-01",
      endDate: null,
      biddingStrategyType: "MAXIMIZE_CONVERSIONS",
    },
    campaignBudget: {
      amountMicros: overrides.budgetMicros ?? 50_000_000,
      name: "Daily Budget",
    },
    segments: { date: overrides.date ?? "2026-06-13" },
    metrics: {
      impressions: overrides.impressions ?? 1000,
      clicks: overrides.clicks ?? 50,
      costMicros: overrides.costMicros ?? 12_340_000,
      conversions: overrides.conversions ?? 5,
      conversionsValue: overrides.conversionsValue ?? 250.5,
      averageCpc: overrides.averageCpc ?? 246_800,
      ctr: overrides.ctr ?? 0.05,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. conversions_value is a DOUBLE in account currency → micros = value × 1e6.
// ---------------------------------------------------------------------------

test("conversions_value (a dollar DOUBLE) is converted to micros, not treated as already-micros", () => {
  const { campaignStats } = mapCampaignRows(
    [campaignRow({ conversionsValue: 250.5 })],
    CUSTOMER_ID,
  );
  assert.equal(campaignStats.length, 1, "expected one daily stat row");
  const stat = campaignStats[0];

  // $250.50 → 250_500_000 micros (NOT 250 or 250.5 micros).
  assert.equal(
    stat.conversionValueMicros,
    250_500_000,
    "conversion value dollars must be multiplied by 1e6 for the micros column",
  );
  // The dollar column is the raw double, unmodified.
  assert.equal(
    stat.conversionValueDollars,
    250.5,
    "conversion value dollar column must be the raw API double",
  );
});

test("conversion value micros are rounded (no fractional micros leak through)", () => {
  // A value that, ×1e6, lands on a fraction of a micro must round to an integer.
  const { campaignStats } = mapCampaignRows(
    [campaignRow({ conversionsValue: 0.0000005 })],
    CUSTOMER_ID,
  );
  const stat = campaignStats[0];
  assert.equal(
    stat.conversionValueMicros,
    1,
    "0.0000005 × 1e6 = 0.5 must round to 1 micro (integer column)",
  );
  assert.ok(
    Number.isInteger(stat.conversionValueMicros),
    "conversionValueMicros must be an integer",
  );
});

test("string-typed conversions_value from the API is coerced before conversion", () => {
  const { campaignStats } = mapCampaignRows(
    [campaignRow({ conversionsValue: "99.99" })],
    CUSTOMER_ID,
  );
  const stat = campaignStats[0];
  assert.equal(stat.conversionValueMicros, 99_990_000);
  assert.equal(stat.conversionValueDollars, 99.99);
});

test("missing/zero conversion value yields zero on both columns", () => {
  const { campaignStats } = mapCampaignRows(
    [campaignRow({ conversionsValue: 0 })],
    CUSTOMER_ID,
  );
  const stat = campaignStats[0];
  assert.equal(stat.conversionValueMicros, 0);
  assert.equal(stat.conversionValueDollars, 0);
});

// ---------------------------------------------------------------------------
// 2. Cost / CPC / budget ARE micros — must be DIVIDED, never multiplied.
//    This is the inverse direction from conversion value; swapping the two is
//    the exact regression this task guards.
// ---------------------------------------------------------------------------

test("cost_micros is stored as-is and divided (÷1e6) for the dollar column", () => {
  const { campaignStats } = mapCampaignRows(
    [campaignRow({ costMicros: 12_340_000 })],
    CUSTOMER_ID,
  );
  const stat = campaignStats[0];
  // Micros column is the raw API integer.
  assert.equal(stat.costMicros, 12_340_000, "cost micros stored unchanged");
  // Dollar column is micros ÷ 1e6 = $12.34.
  assert.equal(stat.costDollars, 12.34, "cost dollars must be micros ÷ 1e6");
});

test("average_cpc is micros → divided for its dollar column", () => {
  const { campaignStats } = mapCampaignRows(
    [campaignRow({ averageCpc: 246_800 })],
    CUSTOMER_ID,
  );
  const stat = campaignStats[0];
  assert.equal(stat.averageCpcMicros, 246_800);
  assert.equal(stat.averageCpcDollars, 0.25, "246_800 micros = $0.2468 → $0.25");
});

test("fractional average_cpc DOUBLE micros are rounded to an integer (Task #2902)", () => {
  // The live API returns `metrics.average_cpc` as a DOUBLE in micros (e.g.
  // "9051417.25"); the bigint stat column rejects fractional values with
  // "invalid input syntax for type bigint" — which killed whole customer syncs.
  const { campaignStats } = mapCampaignRows(
    [campaignRow({ averageCpc: 9_051_417.25 })],
    CUSTOMER_ID,
  );
  const stat = campaignStats[0];
  assert.equal(stat.averageCpcMicros, 9_051_417, "fractional micros must round");
  assert.ok(
    Number.isInteger(stat.averageCpcMicros),
    "averageCpcMicros must be an integer (bigint column)",
  );
});

test("the two money directions are not swapped: cost divides while conversion value multiplies", () => {
  // Same numeric magnitude on both fields proves the directions differ.
  const { campaignStats } = mapCampaignRows(
    [campaignRow({ costMicros: 1_000_000, conversionsValue: 1_000_000 })],
    CUSTOMER_ID,
  );
  const stat = campaignStats[0];
  // 1_000_000 micros of cost = $1.00.
  assert.equal(stat.costDollars, 1, "cost: 1_000_000 micros → $1");
  // $1_000_000 of conversion value = 1e12 micros (NOT $1).
  assert.equal(
    stat.conversionValueMicros,
    1_000_000_000_000,
    "conversion value: $1_000_000 → 1e12 micros",
  );
  assert.equal(stat.conversionValueDollars, 1_000_000);
});

test("budget amount_micros is converted like cost (÷1e6), not like conversion value", () => {
  const { campaignDefs } = mapCampaignRows(
    [campaignRow({ budgetMicros: 50_000_000 })],
    CUSTOMER_ID,
  );
  assert.equal(campaignDefs.length, 1);
  const def = campaignDefs[0];
  assert.equal(def.budgetMicros, 50_000_000);
  assert.equal(def.budgetDollars, 50, "budget 50_000_000 micros → $50");
});

// ---------------------------------------------------------------------------
// 3. Row-mapping plumbing the conversion path depends on.
// ---------------------------------------------------------------------------

test("other scalar metrics map straight through with correct rounding", () => {
  const { campaignStats } = mapCampaignRows(
    [campaignRow({ impressions: 1000, clicks: 50, conversions: 5, ctr: 0.05 })],
    CUSTOMER_ID,
  );
  const stat = campaignStats[0];
  assert.equal(stat.impressions, 1000);
  assert.equal(stat.clicks, 50);
  assert.equal(stat.conversions, 5);
  // ctr is stored in basis points: 0.05 × 10_000 = 500.
  assert.equal(stat.ctr, 500, "ctr 0.05 → 500 basis points");
  assert.equal(stat.customerId, CUSTOMER_ID);
  assert.equal(stat.campaignId, "111");
  assert.equal(stat.date, "2026-06-13");
});

test("campaign definitions are deduped while every dated row yields a stat", () => {
  const { campaignDefs, campaignStats } = mapCampaignRows(
    [
      campaignRow({ campaignId: 111, date: "2026-06-12", conversionsValue: 10 }),
      campaignRow({ campaignId: 111, date: "2026-06-13", conversionsValue: 20 }),
    ],
    CUSTOMER_ID,
  );
  // One campaign def (deduped by id), two daily stats (one per date).
  assert.equal(campaignDefs.length, 1, "duplicate campaign ids collapse to one def");
  assert.equal(campaignStats.length, 2, "each dated row produces a daily stat");
  assert.equal(campaignStats[0].conversionValueMicros, 10_000_000);
  assert.equal(campaignStats[1].conversionValueMicros, 20_000_000);
});

test("rows without a campaign id are skipped; rows without a date yield no stat", () => {
  const noId = { campaign: { id: null }, metrics: {}, segments: { date: "2026-06-13" } };
  const noDate = campaignRow({ campaignId: 222 });
  noDate.segments = {}; // def created, but no stat row without a date

  const { campaignDefs, campaignStats } = mapCampaignRows(
    [noId, noDate],
    CUSTOMER_ID,
  );
  assert.equal(campaignDefs.length, 1, "only the id'd row produces a def");
  assert.equal(campaignDefs[0].campaignId, "222");
  assert.equal(campaignStats.length, 0, "no dated metrics → no daily stat rows");
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(err instanceof Error ? err.stack : err);
  }
}

console.log(
  `\nGoogle Ads conversion-mapping tests: ${tests.length - failed}/${tests.length} passed`,
);
if (failed > 0) {
  process.exitCode = 1;
  throw new Error(`${failed} Google Ads conversion-mapping test(s) failed`);
}
