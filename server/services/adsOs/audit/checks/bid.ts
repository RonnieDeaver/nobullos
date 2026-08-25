/** BID checks — Bidding & Budget Efficiency (port of audit/checks/bid.py). */

import { Status, type CheckResult, type Evidence } from "../models";
import { loadWeights } from "../configLoader";
import type { AuditContext } from "../context";
import { round1, clamp } from "../scoring";
import { discrete, result } from "./base";

// primary_status_reasons (by name) that indicate the strategy is being held back.
const LIMITING_REASONS = new Set([
  "BUDGET_CONSTRAINED",
  "BIDDING_STRATEGY_LIMITED",
  "BIDDING_STRATEGY_CONSTRAINED",
  "SEARCH_VOLUME_LIMITED",
]);

/** Python str.title() over an underscore-expanded enum ("MANUAL_CPC" -> "Manual Cpc"). */
function titleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/(^|[^a-zA-Z])([a-z])/g, (_m, pre, ch) => pre + ch.toUpperCase());
}

/** BID-01: bid strategy not limited by budget/target/volume. */
export function bid01(ctx: AuditContext): CheckResult {
  const campaigns = [...ctx.campaigns.values()];
  if (!campaigns.length) return discrete("BID-01", Status.NA, "No enabled campaigns");
  const limited: Array<[(typeof campaigns)[number], string[]]> = [];
  for (const c of campaigns) {
    const hits = c.primary_status_reasons.filter((r) => LIMITING_REASONS.has(r));
    if (hits.length) limited.push([c, hits]);
  }
  if (limited.length) {
    const ev: Evidence[] = limited.map(([c, h]) => ({
      name: c.name,
      id: c.id,
      detail: [...h].sort().join(", ").toLowerCase(),
    }));
    return discrete(
      "BID-01",
      Status.BAD,
      `${limited.length} campaign(s) limited (budget/target/volume)`,
      ev,
    );
  }
  return discrete("BID-01", Status.GOOD, "No campaigns limited by budget/target/volume");
}

/**
 * BID-02 (continuous): Search IS lost to budget. s = (1 - budget_lost_IS)*100.
 *
 * Impression-weighted across campaigns. good <10%, okay 10-25%, bad >25%.
 */
export function bid02(ctx: AuditContext): CheckResult {
  const campaigns = [...ctx.campaigns.values()];
  const weighted = campaigns
    .filter((c) => c.impressions > 0)
    .map((c) => [c.budget_lost_is, c.impressions] as const);
  if (!weighted.length) {
    return result("BID-02", { status: Status.NA, score: null, value: "No impressions in window" });
  }
  const totalImpr = weighted.reduce((a, [, w]) => a + w, 0);
  const avgLost = weighted.reduce((a, [v, w]) => a + v * w, 0) / totalImpr;
  const score = clamp((1 - avgLost) * 100);
  let status: Status;
  if (avgLost < 0.1) status = Status.GOOD;
  else if (avgLost <= 0.25) status = Status.OKAY;
  else status = Status.BAD;

  const worst = campaigns
    .filter((c) => c.impressions > 0 && c.budget_lost_is > 0.1)
    .sort((a, b) => b.budget_lost_is - a.budget_lost_is)
    .slice(0, 5);
  const ev: Evidence[] = worst.map((c) => ({
    name: c.name,
    id: c.id,
    detail: `${(c.budget_lost_is * 100).toFixed(0)}% IS lost to budget`,
  }));
  return result("BID-02", {
    status,
    score: round1(score),
    value: `${(avgLost * 100).toFixed(0)}% search IS lost to budget`,
    evidence: ev,
  });
}

/** BID-03 (continuous): Search IS lost to rank. good <20%, okay 20-40%, bad >40%. */
export function bid03(ctx: AuditContext): CheckResult {
  const campaigns = [...ctx.campaigns.values()];
  const weighted = campaigns
    .filter((c) => c.impressions > 0)
    .map((c) => [c.rank_lost_is, c.impressions] as const);
  if (!weighted.length) {
    return result("BID-03", { status: Status.NA, score: null, value: "No impressions in window" });
  }
  const total = weighted.reduce((a, [, w]) => a + w, 0);
  const avgLost = weighted.reduce((a, [v, w]) => a + v * w, 0) / total;
  const score = clamp((1 - avgLost) * 100);
  let status: Status;
  if (avgLost < 0.2) status = Status.GOOD;
  else if (avgLost <= 0.4) status = Status.OKAY;
  else status = Status.BAD;
  const worst = campaigns
    .filter((c) => c.impressions > 0 && c.rank_lost_is > 0.2)
    .sort((a, b) => b.rank_lost_is - a.rank_lost_is)
    .slice(0, 5);
  const ev: Evidence[] = worst.map((c) => ({
    name: c.name,
    id: c.id,
    detail: `${(c.rank_lost_is * 100).toFixed(0)}% IS lost to rank`,
  }));
  return result("BID-03", {
    status,
    score: round1(score),
    value: `${(avgLost * 100).toFixed(0)}% search IS lost to rank`,
    evidence: ev,
  });
}

// Conversion-based strategies appropriate for lead gen.
const WEAK_STRATEGIES = new Set(["MANUAL_CPC", "MANUAL_CPC_ENHANCED", "MAXIMIZE_CLICKS", "TARGET_SPEND"]);

/**
 * BID-04 (discrete): manual-bid campaigns with enough conversions move to Smart Bidding.
 *
 * A campaign on Manual CPC / Max Clicks is flagged once it has generated at least
 * `min_conversions` conversions in the lookback window (30 days by default) — a
 * single flat bar, regardless of account spend. Threshold lives in
 * weights config -> bid_04_smart_bidding.min_conversions.
 */
export function bid04(ctx: AuditContext): CheckResult {
  const campaigns = [...ctx.campaigns.values()];
  if (!campaigns.length) {
    return result("BID-04", { status: Status.NA, score: null, value: "No enabled campaigns" });
  }

  const threshold = loadWeights().bid_04_smart_bidding?.min_conversions ?? 15;

  const manual = campaigns.filter((c) => WEAK_STRATEGIES.has(c.bidding_strategy_type));
  const mature = manual.filter((c) => c.conversions >= threshold);
  if (mature.length) {
    const ev: Evidence[] = [...mature]
      .sort((a, b) => b.conversions - a.conversions)
      .map((c) => ({
        name: c.name,
        id: c.id,
        detail: `${c.conversions.toFixed(0)} conv · ${titleCase(c.bidding_strategy_type)}`,
      }));
    return result("BID-04", {
      status: Status.BAD,
      score: null,
      value:
        `${mature.length} campaign(s) with ≥${threshold.toFixed(0)} conversions on ` +
        "Manual CPC/Max Clicks — move to conversion-based Smart Bidding",
      evidence: ev,
    });
  }
  // Manual campaigns below the bar are correctly left on manual for now.
  const immature = manual.length - mature.length;
  const note = immature
    ? ` (${immature} manual campaign(s) below the ${threshold.toFixed(0)}-conv bar — not yet ready)`
    : "";
  return result("BID-04", {
    status: Status.GOOD,
    score: null,
    value: `Bid strategies fit each campaign's conversion volume${note}`,
  });
}

/**
 * BID-05 (discrete): tCPA target sane vs actual cost/conversion.
 *
 * Best-effort: only campaigns with a tCPA target AND recorded conversions are
 * judged. Flags a target set far below actual (starving delivery).
 */
export function bid05(ctx: AuditContext): CheckResult {
  const judged = [...ctx.campaigns.values()].filter(
    (c) => c.target_cpa_micros > 0 && c.conversions > 0 && c.cost_per_conversion_micros > 0,
  );
  if (!judged.length) {
    return result("BID-05", {
      status: Status.NA,
      score: null,
      value: "No tCPA targets with conversion data",
    });
  }
  const starved = judged.filter((c) => c.target_cpa_micros < 0.4 * c.cost_per_conversion_micros);
  if (starved.length) {
    const ev: Evidence[] = starved.map((c) => ({
      name: c.name,
      id: c.id,
      detail: `target ${(c.target_cpa_micros / 1e6).toFixed(0)} vs actual ${(
        c.cost_per_conversion_micros / 1e6
      ).toFixed(0)}`,
    }));
    return result("BID-05", {
      status: Status.BAD,
      score: null,
      value: `${starved.length} campaign(s) with tCPA far below actual CPA`,
      evidence: ev,
    });
  }
  return result("BID-05", {
    status: Status.GOOD,
    score: null,
    value: `${judged.length} tCPA target(s) within a sane band`,
  });
}

// BID-06 (budget present) and BID-07 (learning status) removed per the team's review.
