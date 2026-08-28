/* test-registration
{
  "name": "GAds/LSA pacing GAQL status filter excludes REMOVED, never ENABLED-only (Task #5327)",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/googleAdsHygieneGaqlSetup.mjs"
  ],
  "smoke": true,
  "smokeReason": "Pure in-memory unit test against a stubbed gaqlSearchStream (no DB, no network); fast and deterministic, so it earns a routine-gate slot guarding a real production bug class (paused-but-spending campaigns silently zeroed out of MTD spend).",
  "tier": "small",
  "tierReason": "Deliberately small, overriding the unmeasured default of medium: the suite is pure in-process logic against a fetch stub, with no database, browser, child process, or external network."
}
test-registration */
/**
 * Task #5327 (Ads OS QA sweep) — regression test for a real defect found and
 * fixed: `computeBudgetPacing` and `fetchLsaDashboard` in
 * `googleAdsHygieneService.ts` used to filter their campaign GAQL query with
 * `campaign.status = 'ENABLED'`, which silently excludes any campaign that
 * has been paused mid-month after already spending — a common real-world
 * case (budget exhausted, manual pause, end-of-campaign wind-down). The
 * admin Google Ads Hygiene Budget Pacing / LSA tabs then disagreed with the
 * dedicated ads-os pacing tools (which already used the correct filter),
 * showing understated or $0 month-to-date spend for accounts with a paused
 * campaign.
 *
 * Fix: both queries now filter `campaign.status != 'REMOVED'`, which counts
 * spend from ENABLED and PAUSED campaigns alike (only genuinely deleted
 * campaigns are excluded), matching `pacingEngine.ts`'s established
 * behavior.
 *
 * This suite pins both the query TEXT (never regress to `= 'ENABLED'`, never
 * drop the REMOVED exclusion entirely) and the BEHAVIOR (a paused campaign's
 * cost contributes to the account-level actual spend total) via a stubbed
 * `gaqlSearchStream` (resolve-hook redirect — see
 * `tests/helpers/googleAdsHygieneGaqlStub.mjs`), so a future change can't
 * silently regress to the ENABLED-only filter without breaking a test.
 */
import assert from "node:assert/strict";

import {
  computeBudgetPacing,
  fetchLsaDashboard,
} from "../server/services/googleAdsHygieneService";
import {
  __setGaqlImpl,
  __resetGaqlImpl,
} from "./helpers/googleAdsHygieneGaqlStub.mjs";

type TestFn = () => Promise<void> | void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function gadsCampaignRow(opts: {
  id: string;
  name: string;
  channelType: string;
  budgetMicros: number;
  costMicros: number;
}) {
  return {
    campaign: {
      id: opts.id,
      name: opts.name,
      advertisingChannelType: opts.channelType,
    },
    campaignBudget: { amountMicros: opts.budgetMicros },
    metrics: { costMicros: opts.costMicros },
  };
}

function lsaCampaignRow(opts: {
  id: string;
  name: string;
  budgetMicros: number;
  costMicros: number;
  impressions?: number;
  clicks?: number;
  conversions?: number;
}) {
  return {
    campaign: { id: opts.id, name: opts.name },
    campaignBudget: { amountMicros: opts.budgetMicros },
    metrics: {
      impressions: opts.impressions ?? 0,
      clicks: opts.clicks ?? 0,
      costMicros: opts.costMicros,
      conversions: opts.conversions ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Query text: != 'REMOVED', never = 'ENABLED'-only.
// ---------------------------------------------------------------------------

test("budget pacing query filters campaign.status != 'REMOVED', never = 'ENABLED'", async () => {
  let capturedQuery = "";
  __setGaqlImpl(async (_cid: string, query: string) => {
    capturedQuery = query;
    return [];
  });
  await computeBudgetPacing("1112223333");
  assert.match(
    capturedQuery,
    /campaign\.status\s*!=\s*'REMOVED'/,
    `budget pacing query must exclude REMOVED campaigns, got: ${capturedQuery}`,
  );
  assert.doesNotMatch(
    capturedQuery,
    /campaign\.status\s*=\s*'ENABLED'/,
    `budget pacing query must NOT filter to ENABLED-only (excludes paused-but-spending campaigns): ${capturedQuery}`,
  );
});

test("LSA dashboard query filters campaign.status != 'REMOVED', never = 'ENABLED'", async () => {
  let capturedQuery = "";
  __setGaqlImpl(async (_cid: string, query: string) => {
    capturedQuery = query;
    return [];
  });
  await fetchLsaDashboard("1112223333");
  assert.match(
    capturedQuery,
    /campaign\.status\s*!=\s*'REMOVED'/,
    `LSA dashboard query must exclude REMOVED campaigns, got: ${capturedQuery}`,
  );
  assert.doesNotMatch(
    capturedQuery,
    /campaign\.status\s*=\s*'ENABLED'/,
    `LSA dashboard query must NOT filter to ENABLED-only (excludes paused-but-spending campaigns): ${capturedQuery}`,
  );
});

// ---------------------------------------------------------------------------
// 2. Behavior: a paused (non-removed) campaign's spend counts toward the
//    account total — the actual regression, not just the query text.
// ---------------------------------------------------------------------------

test("budget pacing counts a PAUSED campaign's spend toward account actual spend", async () => {
  __setGaqlImpl(async () => [
    gadsCampaignRow({
      id: "1",
      name: "Always-on Search",
      channelType: "SEARCH",
      budgetMicros: 10_000_000, // $10/day
      costMicros: 5_000_000, // $5
    }),
    gadsCampaignRow({
      id: "2",
      name: "Paused mid-month after spending",
      channelType: "SEARCH",
      budgetMicros: 20_000_000, // $20/day
      costMicros: 15_000_000, // $15 — real spend from before the pause
    }),
  ]);
  const result = await computeBudgetPacing("1112223333");
  assert.equal(result.campaigns.length, 2, "both campaigns must be present (server never filters on status client-side)");
  assert.equal(
    result.accountActualSpend,
    20,
    `account actual spend must include the paused campaign's $15 (5 + 15 = 20), got ${result.accountActualSpend}`,
  );
});

test("LSA dashboard counts a PAUSED campaign's spend toward total spend", async () => {
  __setGaqlImpl(async () => [
    lsaCampaignRow({
      id: "10",
      name: "Always-on LSA",
      budgetMicros: 10_000_000,
      costMicros: 4_000_000, // $4
      conversions: 2,
    }),
    lsaCampaignRow({
      id: "11",
      name: "Paused LSA after spending",
      budgetMicros: 10_000_000,
      costMicros: 6_000_000, // $6 — real spend from before the pause
      conversions: 1,
    }),
  ]);
  const result = await fetchLsaDashboard("1112223333");
  assert.equal(result.hasLsaCampaigns, true);
  assert.equal(result.campaigns.length, 2);
  assert.equal(
    result.totalSpendDollars,
    10,
    `LSA total spend must include the paused campaign's $6 (4 + 6 = 10), got ${result.totalSpendDollars}`,
  );
  assert.equal(result.totalConversions, 3);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(err instanceof Error ? err.stack : err);
    } finally {
      __resetGaqlImpl();
    }
  }

  console.log(
    `\nGAds/LSA pacing status-filter tests: ${tests.length - failed}/${tests.length} passed`,
  );
  if (failed > 0) {
    process.exitCode = 1;
    throw new Error(`${failed} GAds/LSA pacing status-filter test(s) failed`);
  }
}

await run();
