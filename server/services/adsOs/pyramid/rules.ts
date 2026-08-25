/**
 * Deterministic rules for the Pyramid Breakdown — the team's checklist as math
 * (port of backend/app/pyramid/rules.py).
 *
 * Pure functions, no I/O, no config import (the engine builds a `Thresholds`
 * from config once). Every division goes through `safeDiv`; every null
 * baseline / thin entity degrades to `insufficient_data` instead of a call —
 * "no hasty calls on thin data" is enforced here, not left to the model.
 *
 * The AI stages run ON TOP of these flags: they may add judgment (sequencing,
 * reallocation, fix-vs-pause) but the engine's post-guards never let them
 * contradict the arithmetic (see engine's guarded merge).
 *
 * Format notes (Python -> TS): `:.0f` -> toFixed(0); `:g` -> String(x) — our
 * thresholds are plain floats so both render "2"/"0.85" the same way.
 */

import type { AdGroupPull, CampaignPull, KeywordPull } from "./queries";

export interface Thresholds {
  min_conv_for_baseline: number;
  kw_zero_conv_mult: number;
  kw_one_conv_mult: number;
  kw_high_cpl_mult: number;
  ag_zero_conv_mult: number;
  ag_high_cpl_mult: number;
  camp_throttle_mult: number;
  camp_pause_mult: number;
  camp_high_cpl_mult: number;
  scale_cpl_ratio: number;
  scale_lost_is_budget_pct: number;
  rank_limited_is_pct: number;
  min_spend_for_call: number;
  min_clicks_for_call: number;
  throttle_reduction_pct: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Python `f"{x:.0f}"` equivalent for the note strings. */
function fmt0(n: number): string {
  return n.toFixed(0);
}

/** Python `f"{x:g}"` equivalent for our plain-float thresholds. */
function fmtG(n: number): string {
  return String(n);
}

/** The only division path in the pyramid: null when the denominator is <= 0. */
export function safeDiv(num: number, den: number): number | null {
  return den && den > 0 ? round2(num / den) : null;
}

export interface Baselines {
  account_cost: number;
  account_conversions: number;
  account_cpl: number | null; // null -> account-relative rules disabled
  campaign_baseline: Map<string, number | null>;
  campaign_baseline_source: Map<string, string>; // campaign|account|none
  single_campaign: boolean; // exactly one campaign with spend
}

/**
 * Account CPL + per-campaign effective baseline (own CPL when trusted, else
 * account CPL, else null). A campaign's own CPL is trusted only with at least
 * `min_conv_for_baseline` conversions — a 1-conversion 'baseline' is noise.
 */
export function computeBaselines(
  campaigns: Map<string, CampaignPull>,
  th: Thresholds,
): Baselines {
  const values = [...campaigns.values()];
  const accountCost = round2(values.reduce((s, c) => s + c.cost, 0));
  const accountConv = values.reduce((s, c) => s + c.conversions, 0);
  const accountCpl =
    accountConv >= th.min_conv_for_baseline ? safeDiv(accountCost, accountConv) : null;
  const b: Baselines = {
    account_cost: accountCost,
    account_conversions: round2(accountConv),
    account_cpl: accountCpl,
    campaign_baseline: new Map(),
    campaign_baseline_source: new Map(),
    single_campaign: values.filter((c) => c.cost > 0).length === 1,
  };
  for (const [cid, c] of campaigns) {
    const own = safeDiv(c.cost, c.conversions);
    if (c.conversions >= th.min_conv_for_baseline && own !== null) {
      b.campaign_baseline.set(cid, own);
      b.campaign_baseline_source.set(cid, "campaign");
    } else if (accountCpl !== null) {
      b.campaign_baseline.set(cid, accountCpl);
      b.campaign_baseline_source.set(cid, "account");
    } else {
      b.campaign_baseline.set(cid, null);
      b.campaign_baseline_source.set(cid, "none");
    }
  }
  return b;
}

export interface EntityFlags {
  flags: string[];
  suggested_action: string; // pause|throttle|watch|keep|scale|none
  insufficient_data: boolean;
  scale_candidate: boolean;
  notes: string[]; // deterministic rationale fragments
  recommended_budget_change_pct: number | null;
}

export function newEntityFlags(): EntityFlags {
  return {
    flags: [],
    suggested_action: "keep",
    insufficient_data: false,
    scale_candidate: false,
    notes: [],
    recommended_budget_change_pct: null,
  };
}

function thin(cost: number, clicks: number, th: Thresholds): boolean {
  return cost < th.min_spend_for_call && clicks < th.min_clicks_for_call;
}

/**
 * The team's killer-keyword rules, verbatim: (a) 0 conv & spend > 2x baseline
 * CPL; (b) <=1 conv & spend > 3x; (c) converting but CPL > 2x.
 */
export function flagKeyword(
  kw: KeywordPull,
  baseline: number | null | undefined,
  th: Thresholds,
): EntityFlags {
  const out = newEntityFlags();
  if (baseline === null || baseline === undefined) {
    out.insufficient_data = true;
    out.flags.push("KW_INSUFFICIENT");
    out.notes.push("no trustworthy CPL baseline for this campaign yet");
    return finalizeStatus(out, kw.status);
  }
  if (thin(kw.cost, kw.clicks, th)) {
    out.insufficient_data = true;
    out.flags.push("KW_INSUFFICIENT");
    out.notes.push(`below the data floor ($${fmt0(kw.cost)} spend, ${kw.clicks} clicks)`);
    return finalizeStatus(out, kw.status);
  }

  const cpl = safeDiv(kw.cost, kw.conversions);
  if (
    kw.conversions <= 0 &&
    kw.cost > th.kw_zero_conv_mult * baseline &&
    kw.cost >= th.min_spend_for_call
  ) {
    out.flags.push("KW_PAUSE_ZERO_CONV");
    out.suggested_action = "pause";
    out.notes.push(
      `$${fmt0(kw.cost)} spent with 0 conversions vs a $${fmt0(baseline)} baseline CPL ` +
        `(over ${fmtG(th.kw_zero_conv_mult)}x)`,
    );
  } else if (
    kw.conversions > 0 &&
    kw.conversions <= 1 &&
    kw.cost > th.kw_one_conv_mult * baseline &&
    kw.cost >= th.min_spend_for_call
  ) {
    out.flags.push("KW_PAUSE_ONE_CONV");
    out.suggested_action = "pause";
    out.notes.push(
      `$${fmt0(kw.cost)} spent for only ${fmtG(kw.conversions)} conversion vs a ` +
        `$${fmt0(baseline)} baseline CPL (over ${fmtG(th.kw_one_conv_mult)}x)`,
    );
  } else if (
    kw.conversions > 1 &&
    cpl !== null &&
    cpl > th.kw_high_cpl_mult * baseline &&
    kw.cost >= th.min_spend_for_call
  ) {
    out.flags.push("KW_PAUSE_HIGH_CPL");
    out.suggested_action = "pause";
    out.notes.push(
      `CPL $${fmt0(cpl)} is over ${fmtG(th.kw_high_cpl_mult)}x the $${fmt0(baseline)} baseline`,
    );
  } else if (kw.conversions <= 0 && kw.cost > baseline && kw.clicks >= th.min_clicks_for_call) {
    out.flags.push("KW_WATCH_SPEND");
    out.suggested_action = "watch";
    out.notes.push(
      `$${fmt0(kw.cost)} spent with 0 conversions — approaching the pause line ` +
        `($${fmt0(th.kw_zero_conv_mult * baseline)})`,
    );
  }
  if (kw.quality_score >= 1 && kw.quality_score <= 3) {
    out.flags.push("KW_LOW_QS"); // annotation only, never alone a pause
    out.notes.push(`quality score ${kw.quality_score}/10`);
  }
  return finalizeStatus(out, kw.status);
}

export function flagAdGroup(
  ag: AdGroupPull,
  baseline: number | null | undefined,
  th: Thresholds,
): EntityFlags {
  const out = newEntityFlags();
  if (baseline === null || baseline === undefined) {
    out.insufficient_data = true;
    out.flags.push("AG_INSUFFICIENT");
    out.notes.push("no trustworthy CPL baseline for this campaign yet");
    return finalizeStatus(out, ag.status);
  }
  if (thin(ag.cost, ag.clicks, th)) {
    out.insufficient_data = true;
    out.flags.push("AG_INSUFFICIENT");
    out.notes.push(`below the data floor ($${fmt0(ag.cost)} spend, ${ag.clicks} clicks)`);
    return finalizeStatus(out, ag.status);
  }

  const cpl = safeDiv(ag.cost, ag.conversions);
  if (
    ag.conversions <= 0 &&
    ag.cost > th.ag_zero_conv_mult * baseline &&
    ag.cost >= th.min_spend_for_call
  ) {
    out.flags.push("AG_PAUSE_ZERO_CONV");
    out.suggested_action = "pause";
    out.notes.push(
      `$${fmt0(ag.cost)} spent with 0 conversions vs a $${fmt0(baseline)} baseline CPL — ` +
        "redirect this budget to converting ad groups",
    );
  } else if (
    ag.conversions > 0 &&
    cpl !== null &&
    cpl > th.ag_high_cpl_mult * baseline &&
    ag.cost >= th.min_spend_for_call
  ) {
    out.flags.push("AG_HIGH_CPL");
    out.suggested_action = "watch"; // AI may escalate with relevancy evidence
    out.notes.push(
      `CPL $${fmt0(cpl)} is over ${fmtG(th.ag_high_cpl_mult)}x the $${fmt0(baseline)} baseline`,
    );
  } else if (ag.conversions <= 0 && ag.cost > baseline && ag.clicks >= th.min_clicks_for_call) {
    out.flags.push("AG_WATCH_SPEND");
    out.suggested_action = "watch";
    out.notes.push(
      `$${fmt0(ag.cost)} spent with 0 conversions — approaching the pause line ` +
        `($${fmt0(th.ag_zero_conv_mult * baseline)})`,
    );
  }
  return finalizeStatus(out, ag.status);
}

export function flagCampaign(c: CampaignPull, b: Baselines, th: Thresholds): EntityFlags {
  const out = newEntityFlags();
  const cpl = safeDiv(c.cost, c.conversions);

  // Scaling first — a scale candidate can also be rank-limited (both surface).
  // Budget-lost IS is literally the headroom a budget raise buys.
  const lostB = c.lost_is_budget || 0.0;
  if (
    cpl !== null &&
    b.account_cpl !== null &&
    c.conversions >= th.min_conv_for_baseline &&
    cpl <= th.scale_cpl_ratio * b.account_cpl &&
    lostB >= th.scale_lost_is_budget_pct &&
    !b.single_campaign
  ) {
    out.flags.push("CAMP_SCALE");
    out.scale_candidate = true;
  } else if (
    cpl !== null &&
    c.target_cpa &&
    c.conversions >= th.min_conv_for_baseline &&
    cpl <= 0.9 * c.target_cpa &&
    lostB >= th.scale_lost_is_budget_pct
  ) {
    // Works even for a single-campaign account: the bar is the campaign's own
    // target CPA, not a cross-campaign comparison.
    out.flags.push("CAMP_SCALE_TCPA");
    out.scale_candidate = true;
  }
  if (out.scale_candidate) {
    out.suggested_action = "scale";
    out.recommended_budget_change_pct = Math.min(50, Math.max(10, Math.round(lostB)));
    const bar = out.flags.includes("CAMP_SCALE")
      ? `${fmtG(th.scale_cpl_ratio)}x account CPL`
      : `target CPA $${fmt0(c.target_cpa as number)}`;
    out.notes.push(
      `CPL $${fmt0(cpl as number)} beats the ${bar} bar and ${fmt0(lostB)}% of impression share ` +
        `is lost to budget — raising budget ~${fmt0(out.recommended_budget_change_pct)}% buys real headroom`,
    );
  }

  if ((c.lost_is_rank || 0.0) >= th.rank_limited_is_pct) {
    out.flags.push("CAMP_RANK_LIMITED");
    out.notes.push(
      `${fmt0(c.lost_is_rank as number)}% of impression share is lost to RANK — that headroom ` +
        "needs bid/quality work, budget won't buy it",
    );
  }

  if (out.scale_candidate) {
    return finalizeStatus(out, c.status);
  }

  // Under-performance vs the ACCOUNT baseline. With a single campaign the
  // comparison is degenerate (campaign == account), so it self-disables.
  if (b.account_cpl === null) {
    out.insufficient_data = true;
    out.flags.push("CAMP_INSUFFICIENT");
    out.notes.push("account has too few conversions for a trustworthy CPL baseline");
    return finalizeStatus(out, c.status);
  }
  if (thin(c.cost, c.clicks, th)) {
    out.insufficient_data = true;
    out.flags.push("CAMP_INSUFFICIENT");
    out.notes.push(`below the data floor ($${fmt0(c.cost)} spend, ${c.clicks} clicks)`);
    return finalizeStatus(out, c.status);
  }
  if (b.single_campaign) {
    out.notes.push("single-campaign account — campaign-vs-account CPL comparisons don't apply");
    return finalizeStatus(out, c.status);
  }

  if (
    c.conversions <= 0 &&
    c.cost > th.camp_pause_mult * b.account_cpl &&
    c.cost >= th.min_spend_for_call
  ) {
    out.flags.push("CAMP_PAUSE_ZERO_CONV");
    out.suggested_action = "pause";
    out.notes.push(
      `$${fmt0(c.cost)} spent with 0 conversions vs a $${fmt0(b.account_cpl)} account CPL — ` +
        "reallocate this budget to converting campaigns",
    );
  } else if (
    c.conversions <= 0 &&
    c.cost > th.camp_throttle_mult * b.account_cpl &&
    c.cost >= th.min_spend_for_call
  ) {
    out.flags.push("CAMP_THROTTLE_ZERO_CONV");
    out.suggested_action = "throttle";
    out.recommended_budget_change_pct = -th.throttle_reduction_pct;
    out.notes.push(
      `$${fmt0(c.cost)} spent with 0 conversions — cut the daily budget ` +
        `~${fmt0(th.throttle_reduction_pct)}% while it proves itself`,
    );
  } else if (
    cpl !== null &&
    cpl > th.camp_high_cpl_mult * b.account_cpl &&
    c.cost >= th.min_spend_for_call
  ) {
    out.flags.push("CAMP_THROTTLE_HIGH_CPL");
    out.suggested_action = "throttle";
    out.recommended_budget_change_pct = -th.throttle_reduction_pct;
    out.notes.push(
      `CPL $${fmt0(cpl)} is over ${fmtG(th.camp_high_cpl_mult)}x the $${fmt0(b.account_cpl)} ` +
        `account CPL — cut the daily budget ~${fmt0(th.throttle_reduction_pct)}% and ` +
        "shift spend to the efficient campaigns",
    );
  }
  return finalizeStatus(out, c.status);
}

/**
 * A non-ENABLED entity is context, not a target — flags stay visible but the
 * action is 'none' (you can't pause what's already paused).
 */
function finalizeStatus(out: EntityFlags, status: string): EntityFlags {
  if (status !== "ENABLED") {
    out.suggested_action = "none";
    out.recommended_budget_change_pct = null;
    out.scale_candidate = false;
  }
  return out;
}
