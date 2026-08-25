/* test-registration
{
  "name": "Ads OS pyramid rules — baseline trust ladder, kw pause tiers + $25 floor + watch band + QS annotation, paused-keeps-flags, ag tiers, campaign pause/throttle(-30%)/scale clamp 10-50 + tCPA variant + rank-limited + single-campaign skip, sufficiency floors, safeDiv (Task #3601)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3601: Ads OS Pyramid Breakdown deterministic rules — every pause/ throttle/scale threshold, the $25/5-click sufficiency floors, and the baseline trust ladder the AI stages are guarded against. Pure functions, DB-free, network-free, fast; a drift here silently changes which campaigns/keywords the review tells the team to pause.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Ads OS Phase 5 — Pyramid Breakdown deterministic rules engine (Task #3601).
 *
 * Pure unit tests against hand-computed fixtures: baseline trust ladder
 * (own CPL at >=3 conv, else account CPL at >=3, else disabled), the three
 * keyword pause tiers + the $25 floor + the watch band + the QS<=3 annotation,
 * paused-keeps-flags/action-none, ad-group pause/watch tiers, campaign
 * pause/throttle(-30%)/scale rules (CPL <= 0.85x account AND >=3 conv AND
 * lost-IS-budget >= 10%, recommending +lost-IS% clamped 10-50%), the tCPA
 * scale variant, rank-limited annotation, single-campaign degeneracy skip,
 * sufficiency floors, and safeDiv. Thresholds constructed directly (the
 * engine's thresholdsFromConfig is config-glue, exercised in the engine test).
 *
 * Fixture values avoid .5 rounding boundaries per TASK_PREFLIGHT.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

import {
  computeBaselines,
  flagAdGroup,
  flagCampaign,
  flagKeyword,
  safeDiv,
  type Baselines,
  type Thresholds,
} from "../server/services/adsOs/pyramid/rules";
import type { AdGroupPull, CampaignPull, KeywordPull } from "../server/services/adsOs/pyramid/queries";

const TH: Thresholds = {
  min_conv_for_baseline: 3,
  kw_zero_conv_mult: 2,
  kw_one_conv_mult: 3,
  kw_high_cpl_mult: 2,
  ag_zero_conv_mult: 2,
  ag_high_cpl_mult: 2,
  camp_throttle_mult: 2,
  camp_pause_mult: 3,
  camp_high_cpl_mult: 2,
  scale_cpl_ratio: 0.85,
  scale_lost_is_budget_pct: 10,
  rank_limited_is_pct: 20,
  min_spend_for_call: 25,
  min_clicks_for_call: 5,
  throttle_reduction_pct: 30,
};

function camp(over: Partial<CampaignPull> = {}): CampaignPull {
  return {
    id: "c1",
    name: "Camp",
    status: "ENABLED",
    primary_status: "ELIGIBLE",
    channel_type: "SEARCH",
    bidding_strategy_type: "MAXIMIZE_CONVERSIONS",
    budget: 50,
    target_cpa: null,
    cost: 0,
    conversions: 0,
    clicks: 0,
    impressions: 0,
    search_is: null,
    lost_is_budget: null,
    lost_is_rank: null,
    top_is: null,
    ...over,
  };
}

function ag(over: Partial<AdGroupPull> = {}): AdGroupPull {
  return {
    id: "g1",
    name: "AG",
    status: "ENABLED",
    campaign_id: "c1",
    cost: 0,
    conversions: 0,
    clicks: 0,
    impressions: 0,
    ...over,
  };
}

function kw(over: Partial<KeywordPull> = {}): KeywordPull {
  return {
    criterion_id: "k1",
    ad_group_id: "g1",
    campaign_id: "c1",
    text: "kw",
    match_type: "EXACT",
    status: "ENABLED",
    quality_score: 7,
    cost: 0,
    conversions: 0,
    clicks: 0,
    impressions: 0,
    ...over,
  };
}

function bl(over: Partial<Baselines> = {}): Baselines {
  return {
    account_cost: 2000,
    account_conversions: 20,
    account_cpl: 100,
    campaign_baseline: new Map(),
    campaign_baseline_source: new Map(),
    single_campaign: false,
    ...over,
  };
}

let failures = 0;
function t(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}\n    ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
console.log("safeDiv");
// ---------------------------------------------------------------------------

t("null on zero denominator", () => assert.equal(safeDiv(10, 0), null));
t("null on negative denominator", () => assert.equal(safeDiv(10, -2), null));
t("null on 0/0", () => assert.equal(safeDiv(0, 0), null));
t("plain division rounds to 2dp", () => {
  assert.equal(safeDiv(10, 4), 2.5);
  assert.equal(safeDiv(100, 3), 33.33);
});

// ---------------------------------------------------------------------------
console.log("computeBaselines");
// ---------------------------------------------------------------------------

t("own CPL trusted at >=3 conv, else account CPL", () => {
  const b = computeBaselines(
    new Map([
      ["c1", camp({ id: "c1", cost: 1000, conversions: 10 })],
      ["c2", camp({ id: "c2", cost: 500, conversions: 1 })],
    ]),
    TH,
  );
  assert.equal(b.account_cost, 1500);
  assert.equal(b.account_conversions, 11);
  assert.equal(b.account_cpl, 136.36); // 1500/11
  assert.equal(b.campaign_baseline.get("c1"), 100);
  assert.equal(b.campaign_baseline_source.get("c1"), "campaign");
  assert.equal(b.campaign_baseline.get("c2"), 136.36);
  assert.equal(b.campaign_baseline_source.get("c2"), "account");
  assert.equal(b.single_campaign, false);
});

t("account below the conversion floor disables all CPL baselines", () => {
  const b = computeBaselines(new Map([["c1", camp({ cost: 100, conversions: 2 })]]), TH);
  assert.equal(b.account_cpl, null);
  assert.equal(b.campaign_baseline.get("c1"), null);
  assert.equal(b.campaign_baseline_source.get("c1"), "none");
});

t("single_campaign counts only campaigns with spend", () => {
  const b = computeBaselines(
    new Map([
      ["c1", camp({ id: "c1", cost: 100, conversions: 5 })],
      ["c2", camp({ id: "c2", cost: 0, conversions: 0 })],
    ]),
    TH,
  );
  assert.equal(b.single_campaign, true);
  assert.equal(b.account_cpl, 20);
});

t("fractional conversions round to 2dp", () => {
  const b = computeBaselines(
    new Map([
      ["c1", camp({ id: "c1", cost: 100, conversions: 10.123 })],
      ["c2", camp({ id: "c2", cost: 50, conversions: 0.456 })],
    ]),
    TH,
  );
  assert.equal(b.account_conversions, 10.58);
});

// ---------------------------------------------------------------------------
console.log("flagKeyword — pause tiers, floor, watch band, QS, status");
// ---------------------------------------------------------------------------

t("tier a: 0 conv & spend > 2x baseline -> pause", () => {
  const f = flagKeyword(kw({ cost: 250, conversions: 0, clicks: 30 }), 100, TH);
  assert.deepEqual(f.flags, ["KW_PAUSE_ZERO_CONV"]);
  assert.equal(f.suggested_action, "pause");
  assert.deepEqual(f.notes, [
    "$250 spent with 0 conversions vs a $100 baseline CPL (over 2x)",
  ]);
});

t("tier b: <=1 conv & spend > 3x baseline -> pause", () => {
  const f = flagKeyword(kw({ cost: 350, conversions: 1, clicks: 30 }), 100, TH);
  assert.deepEqual(f.flags, ["KW_PAUSE_ONE_CONV"]);
  assert.equal(f.suggested_action, "pause");
  assert.deepEqual(f.notes, [
    "$350 spent for only 1 conversion vs a $100 baseline CPL (over 3x)",
  ]);
});

t("tier c: converting but CPL > 2x baseline -> pause", () => {
  const f = flagKeyword(kw({ cost: 450, conversions: 2, clicks: 40 }), 100, TH);
  assert.deepEqual(f.flags, ["KW_PAUSE_HIGH_CPL"]);
  assert.equal(f.suggested_action, "pause");
  assert.deepEqual(f.notes, ["CPL $225 is over 2x the $100 baseline"]);
});

t("$25 floor blocks a tier-a pause on a tiny baseline; watch band catches it", () => {
  // 20 > 2x5 would pause, but cost < $25 floor; clicks >= 5 keeps it out of
  // the thin gate and inside the watch band (cost > baseline).
  const f = flagKeyword(kw({ cost: 20, conversions: 0, clicks: 10 }), 5, TH);
  assert.deepEqual(f.flags, ["KW_WATCH_SPEND"]);
  assert.equal(f.suggested_action, "watch");
  assert.deepEqual(f.notes, [
    "$20 spent with 0 conversions — approaching the pause line ($10)",
  ]);
});

t("floor is inclusive: exactly $25 can pause", () => {
  const f = flagKeyword(kw({ cost: 25, conversions: 0, clicks: 0 }), 10, TH);
  assert.deepEqual(f.flags, ["KW_PAUSE_ZERO_CONV"]);
  assert.equal(f.suggested_action, "pause");
});

t("watch band: over baseline but under the pause line", () => {
  const f = flagKeyword(kw({ cost: 150, conversions: 0, clicks: 12 }), 100, TH);
  assert.deepEqual(f.flags, ["KW_WATCH_SPEND"]);
  assert.equal(f.suggested_action, "watch");
  assert.deepEqual(f.notes, [
    "$150 spent with 0 conversions — approaching the pause line ($200)",
  ]);
});

t("QS<=3 is an annotation, never alone a pause", () => {
  const f = flagKeyword(kw({ cost: 60, conversions: 3, clicks: 20, quality_score: 3 }), 100, TH);
  assert.deepEqual(f.flags, ["KW_LOW_QS"]);
  assert.equal(f.suggested_action, "keep");
  assert.deepEqual(f.notes, ["quality score 3/10"]);
});

t("QS annotation stacks onto a pause tier", () => {
  const f = flagKeyword(kw({ cost: 250, conversions: 0, clicks: 30, quality_score: 2 }), 100, TH);
  assert.deepEqual(f.flags, ["KW_PAUSE_ZERO_CONV", "KW_LOW_QS"]);
  assert.equal(f.suggested_action, "pause");
});

t("QS 0 (not reported) is not annotated", () => {
  const f = flagKeyword(kw({ cost: 60, conversions: 3, clicks: 20, quality_score: 0 }), 100, TH);
  assert.deepEqual(f.flags, []);
});

t("thin keyword -> insufficient, no call", () => {
  const f = flagKeyword(kw({ cost: 10, conversions: 0, clicks: 2 }), 100, TH);
  assert.deepEqual(f.flags, ["KW_INSUFFICIENT"]);
  assert.equal(f.insufficient_data, true);
  assert.equal(f.suggested_action, "keep");
  assert.deepEqual(f.notes, ["below the data floor ($10 spend, 2 clicks)"]);
});

t("thin gate needs BOTH floors broken (24.99/4 thin; 24.99/5 not)", () => {
  const thin = flagKeyword(kw({ cost: 24.99, conversions: 0, clicks: 4 }), 100, TH);
  assert.deepEqual(thin.flags, ["KW_INSUFFICIENT"]);
  const notThin = flagKeyword(kw({ cost: 24.99, conversions: 0, clicks: 5 }), 10, TH);
  assert.deepEqual(notThin.flags, ["KW_WATCH_SPEND"]); // floor still blocks the pause
});

t("no baseline -> insufficient regardless of spend", () => {
  const f = flagKeyword(kw({ cost: 500, conversions: 0, clicks: 50 }), null, TH);
  assert.deepEqual(f.flags, ["KW_INSUFFICIENT"]);
  assert.equal(f.insufficient_data, true);
  assert.deepEqual(f.notes, ["no trustworthy CPL baseline for this campaign yet"]);
});

t("paused keyword keeps its flags but the action is none", () => {
  const f = flagKeyword(kw({ status: "PAUSED", cost: 250, conversions: 0, clicks: 30 }), 100, TH);
  assert.deepEqual(f.flags, ["KW_PAUSE_ZERO_CONV"]);
  assert.equal(f.suggested_action, "none");
});

// ---------------------------------------------------------------------------
console.log("flagAdGroup — pause/watch tiers, floors, status");
// ---------------------------------------------------------------------------

t("zero-conv over 2x -> pause", () => {
  const f = flagAdGroup(ag({ cost: 250, conversions: 0, clicks: 30 }), 100, TH);
  assert.deepEqual(f.flags, ["AG_PAUSE_ZERO_CONV"]);
  assert.equal(f.suggested_action, "pause");
  assert.deepEqual(f.notes, [
    "$250 spent with 0 conversions vs a $100 baseline CPL — redirect this budget to converting ad groups",
  ]);
});

t("high CPL -> watch, never pause on CPL alone", () => {
  const f = flagAdGroup(ag({ cost: 450, conversions: 2, clicks: 40 }), 100, TH);
  assert.deepEqual(f.flags, ["AG_HIGH_CPL"]);
  assert.equal(f.suggested_action, "watch");
  assert.deepEqual(f.notes, ["CPL $225 is over 2x the $100 baseline"]);
});

t("watch band under the pause line", () => {
  const f = flagAdGroup(ag({ cost: 150, conversions: 0, clicks: 12 }), 100, TH);
  assert.deepEqual(f.flags, ["AG_WATCH_SPEND"]);
  assert.equal(f.suggested_action, "watch");
});

t("thin ad group -> insufficient", () => {
  const f = flagAdGroup(ag({ cost: 12, conversions: 0, clicks: 3 }), 100, TH);
  assert.deepEqual(f.flags, ["AG_INSUFFICIENT"]);
  assert.equal(f.insufficient_data, true);
});

t("no baseline -> insufficient", () => {
  const f = flagAdGroup(ag({ cost: 400, conversions: 0, clicks: 50 }), null, TH);
  assert.deepEqual(f.flags, ["AG_INSUFFICIENT"]);
});

t("paused ad group keeps flags, action none", () => {
  const f = flagAdGroup(ag({ status: "PAUSED", cost: 250, conversions: 0, clicks: 30 }), 100, TH);
  assert.deepEqual(f.flags, ["AG_PAUSE_ZERO_CONV"]);
  assert.equal(f.suggested_action, "none");
});

// ---------------------------------------------------------------------------
console.log("flagCampaign — scale/throttle/pause, tCPA, rank, single-campaign");
// ---------------------------------------------------------------------------

t("scale: CPL <= 0.85x account, >=3 conv, lost-IS-budget >= 10%", () => {
  const f = flagCampaign(
    camp({ cost: 500, conversions: 10, clicks: 100, lost_is_budget: 37.4 }),
    bl(),
    TH,
  );
  assert.deepEqual(f.flags, ["CAMP_SCALE"]);
  assert.equal(f.suggested_action, "scale");
  assert.equal(f.scale_candidate, true);
  assert.equal(f.recommended_budget_change_pct, 37);
  assert.deepEqual(f.notes, [
    "CPL $50 beats the 0.85x account CPL bar and 37% of impression share is lost to budget — " +
      "raising budget ~37% buys real headroom",
  ]);
});

t("scale recommendation clamps to 10-50%", () => {
  const low = flagCampaign(
    camp({ cost: 500, conversions: 10, clicks: 100, lost_is_budget: 10 }),
    bl(),
    TH,
  );
  assert.equal(low.recommended_budget_change_pct, 10);
  const high = flagCampaign(
    camp({ cost: 500, conversions: 10, clicks: 100, lost_is_budget: 88 }),
    bl(),
    TH,
  );
  assert.equal(high.recommended_budget_change_pct, 50);
});

t("lost-IS-budget below 10% -> no scale", () => {
  const f = flagCampaign(
    camp({ cost: 500, conversions: 10, clicks: 100, lost_is_budget: 9.9 }),
    bl(),
    TH,
  );
  assert.equal(f.scale_candidate, false);
  assert.deepEqual(f.flags, []);
});

t("tCPA scale variant works on a single-campaign account (own bar, <=0.9x tCPA inclusive)", () => {
  const f = flagCampaign(
    camp({ cost: 720, conversions: 10, clicks: 150, target_cpa: 80, lost_is_budget: 15 }),
    bl({ single_campaign: true, account_cpl: 120 }),
    TH,
  );
  // cpl 72 == 0.9 * 80 exactly — inclusive bar.
  assert.deepEqual(f.flags, ["CAMP_SCALE_TCPA"]);
  assert.equal(f.suggested_action, "scale");
  assert.equal(f.recommended_budget_change_pct, 15);
  assert.match(f.notes[0], /target CPA \$80/);
});

t("rank-limited annotation on an otherwise healthy campaign", () => {
  const f = flagCampaign(camp({ cost: 200, conversions: 3, clicks: 50, lost_is_rank: 25 }), bl(), TH);
  assert.deepEqual(f.flags, ["CAMP_RANK_LIMITED"]);
  assert.equal(f.suggested_action, "keep");
  assert.deepEqual(f.notes, [
    "25% of impression share is lost to RANK — that headroom needs bid/quality work, budget won't buy it",
  ]);
});

t("scale candidate can also be rank-limited (both surface)", () => {
  const f = flagCampaign(
    camp({ cost: 500, conversions: 10, clicks: 100, lost_is_budget: 30, lost_is_rank: 22 }),
    bl(),
    TH,
  );
  assert.deepEqual(f.flags, ["CAMP_SCALE", "CAMP_RANK_LIMITED"]);
  assert.equal(f.suggested_action, "scale");
});

t("pause: 0 conv & spend > 3x account CPL", () => {
  const f = flagCampaign(camp({ cost: 350, conversions: 0, clicks: 80 }), bl(), TH);
  assert.deepEqual(f.flags, ["CAMP_PAUSE_ZERO_CONV"]);
  assert.equal(f.suggested_action, "pause");
  assert.deepEqual(f.notes, [
    "$350 spent with 0 conversions vs a $100 account CPL — reallocate this budget to converting campaigns",
  ]);
});

t("throttle: 0 conv & spend > 2x (but not 3x) account CPL -> -30%", () => {
  const f = flagCampaign(camp({ cost: 250, conversions: 0, clicks: 60 }), bl(), TH);
  assert.deepEqual(f.flags, ["CAMP_THROTTLE_ZERO_CONV"]);
  assert.equal(f.suggested_action, "throttle");
  assert.equal(f.recommended_budget_change_pct, -30);
  assert.deepEqual(f.notes, [
    "$250 spent with 0 conversions — cut the daily budget ~30% while it proves itself",
  ]);
});

t("throttle: converting but CPL > 2x account CPL -> -30%", () => {
  const f = flagCampaign(camp({ cost: 900, conversions: 4, clicks: 200 }), bl(), TH);
  assert.deepEqual(f.flags, ["CAMP_THROTTLE_HIGH_CPL"]);
  assert.equal(f.suggested_action, "throttle");
  assert.equal(f.recommended_budget_change_pct, -30);
  assert.deepEqual(f.notes, [
    "CPL $225 is over 2x the $100 account CPL — cut the daily budget ~30% and shift spend to the efficient campaigns",
  ]);
});

t("single-campaign account skips the degenerate campaign-vs-account comparison", () => {
  const f = flagCampaign(
    camp({ cost: 350, conversions: 0, clicks: 80 }),
    bl({ single_campaign: true }),
    TH,
  );
  assert.deepEqual(f.flags, []);
  assert.equal(f.suggested_action, "keep");
  assert.deepEqual(f.notes, [
    "single-campaign account — campaign-vs-account CPL comparisons don't apply",
  ]);
});

t("no account baseline -> insufficient", () => {
  const f = flagCampaign(
    camp({ cost: 350, conversions: 0, clicks: 80 }),
    bl({ account_cpl: null }),
    TH,
  );
  assert.deepEqual(f.flags, ["CAMP_INSUFFICIENT"]);
  assert.equal(f.insufficient_data, true);
  assert.deepEqual(f.notes, [
    "account has too few conversions for a trustworthy CPL baseline",
  ]);
});

t("thin campaign -> insufficient", () => {
  const f = flagCampaign(camp({ cost: 20, conversions: 0, clicks: 4 }), bl(), TH);
  assert.deepEqual(f.flags, ["CAMP_INSUFFICIENT"]);
  assert.equal(f.insufficient_data, true);
});

t("non-ENABLED campaign keeps flags but action none, budget rec cleared", () => {
  const f = flagCampaign(camp({ status: "PAUSED", cost: 350, conversions: 0, clicks: 80 }), bl(), TH);
  assert.deepEqual(f.flags, ["CAMP_PAUSE_ZERO_CONV"]);
  assert.equal(f.suggested_action, "none");
  assert.equal(f.recommended_budget_change_pct, null);
});

t("non-ENABLED scale candidate is fully de-fanged", () => {
  const f = flagCampaign(
    camp({ status: "PAUSED", cost: 500, conversions: 10, clicks: 100, lost_is_budget: 30 }),
    bl(),
    TH,
  );
  assert.deepEqual(f.flags, ["CAMP_SCALE"]);
  assert.equal(f.suggested_action, "none");
  assert.equal(f.scale_candidate, false);
  assert.equal(f.recommended_budget_change_pct, null);
});

// ---------------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll pyramid rules tests passed");
