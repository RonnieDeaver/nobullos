/** KWS checks — Keywords & Search-Term Hygiene (port of audit/checks/kws.py). */

import { Status, type CheckResult, type Evidence } from "../models";
import type { AuditContext, CampaignRow } from "../context";
import { round1, clamp } from "../scoring";
import { result } from "./base";

function statusFromScore(score: number, good: number, okay: number): Status {
  if (score >= good) return Status.GOOD;
  if (score >= okay) return Status.OKAY;
  return Status.BAD;
}

/** KWS-01 (continuous): average Quality Score. s = (avg_QS/10)*100. */
export function kws01(ctx: AuditContext): CheckResult {
  const scored = ctx.keywords.filter((k) => k.quality_score > 0).map((k) => k.quality_score);
  if (!scored.length) {
    return result("KWS-01", {
      status: Status.NA,
      score: null,
      value: "No keywords with a Quality Score",
    });
  }
  const avgQs = scored.reduce((a, b) => a + b, 0) / scored.length;
  const score = clamp((avgQs / 10) * 100);
  // good >=7 (->70), okay 5-6.9 (->50), bad <5
  const status = statusFromScore(avgQs, 7.0, 5.0);

  // Evidence: worst ad groups by average QS.
  const byAg = new Map<string, number[]>();
  for (const k of ctx.keywords) {
    if (k.quality_score > 0) {
      let list = byAg.get(k.ad_group_id);
      if (!list) {
        list = [];
        byAg.set(k.ad_group_id, list);
      }
      list.push(k.quality_score);
    }
  }
  const worst = [...byAg.entries()]
    .map(([ag, v]) => [ag, v.reduce((a, b) => a + b, 0) / v.length] as const)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 5);
  const ev: Evidence[] = worst
    .filter(([, q]) => q < 7)
    .map(([ag, q]) => ({ name: ctx.adGroupName(ag), id: ag, detail: `avg QS ${q.toFixed(1)}` }));
  return result("KWS-01", {
    status,
    score: round1(score),
    value: `avg QS ${avgQs.toFixed(1)} across ${scored.length} keywords`,
    evidence: ev,
  });
}

// QS component field -> human label (KWS-02).
const QS_COMPONENTS: Array<["ad_relevance" | "expected_ctr" | "landing_page", string]> = [
  ["ad_relevance", "Ad relevance"],
  ["expected_ctr", "Expected CTR"],
  ["landing_page", "Landing page experience"],
];

/**
 * KWS-02 (discrete): QS component health.
 *
 * Evidence shows above/avg/below totals for each of the three components
 * (ad relevance, expected CTR, landing page experience).
 */
export function kws02(ctx: AuditContext): CheckResult {
  const rated = ctx.keywords.filter((k) => k.qs_components > 0);
  if (!rated.length) {
    return result("KWS-02", { status: Status.NA, score: null, value: "No QS component data" });
  }

  const totalComponents = rated.reduce((a, k) => a + k.qs_components, 0);
  const below = rated.reduce((a, k) => a + k.qs_below_average, 0);
  const ratio = totalComponents ? below / totalComponents : 0;
  let status: Status;
  if (ratio < 0.1) status = Status.GOOD;
  else if (ratio <= 0.3) status = Status.OKAY;
  else status = Status.BAD;

  const ev: Evidence[] = [];
  for (const [attr, label] of QS_COMPONENTS) {
    const above = rated.filter((k) => k[attr] === "ABOVE_AVERAGE").length;
    const avg = rated.filter((k) => k[attr] === "AVERAGE").length;
    const bel = rated.filter((k) => k[attr] === "BELOW_AVERAGE").length;
    ev.push({ name: label, id: null, detail: `above ${above} · avg ${avg} · below ${bel}` });
  }
  return result("KWS-02", {
    status,
    score: null,
    value: `${below} of ${totalComponents} component ratings below average (${(ratio * 100).toFixed(0)}%)`,
    evidence: ev,
  });
}

// A campaign with this many negative keywords applied directly (campaign-level)
// or across its ad groups counts as well-covered, even without a shared list.
const NEG_KEYWORD_EQUIV = 50;

function hasNegativeCoverage(c: CampaignRow): boolean {
  return (
    c.has_negative_keyword_list ||
    c.campaign_neg_count >= NEG_KEYWORD_EQUIV ||
    c.adgroup_neg_count >= NEG_KEYWORD_EQUIV
  );
}

/**
 * KWS-03 (discrete): negative keyword coverage per campaign.
 *
 * Covered = a shared negative list is attached OR the campaign has 50+
 * campaign-level negatives OR 50+ ad-group-level negatives (in total).
 */
export function kws03(ctx: AuditContext): CheckResult {
  const campaigns = [...ctx.campaigns.values()];
  if (!campaigns.length) {
    return result("KWS-03", { status: Status.NA, score: null, value: "No enabled campaigns" });
  }
  const without = campaigns.filter((c) => !hasNegativeCoverage(c));
  const have = campaigns.length - without.length;
  let status: Status;
  if (have === 0) status = Status.BAD;
  else if (without.length) status = Status.OKAY;
  else status = Status.GOOD;
  const ev: Evidence[] = without.map((c) => ({
    name: c.name,
    id: c.id,
    detail: `no list · ${c.campaign_neg_count} campaign / ${c.adgroup_neg_count} ad-group negatives`,
  }));
  return result("KWS-03", {
    status,
    score: null,
    value: `${have} of ${campaigns.length} campaigns have negative-keyword coverage`,
    evidence: ev,
  });
}

// KWS-04 (staple legal negatives) removed per the team's review.

// Bidding strategies that make broad match safe (Smart Bidding).
const SMART_BIDDING = new Set([
  "TARGET_CPA",
  "TARGET_ROAS",
  "MAXIMIZE_CONVERSIONS",
  "MAXIMIZE_CONVERSION_VALUE",
]);

/** KWS-06 (discrete): broad-match keywords in campaigns without Smart Bidding. */
export function kws06(ctx: AuditContext): CheckResult {
  const broad = ctx.keywords.filter((k) => k.match_type === "BROAD");
  if (!ctx.keywords.length) {
    return result("KWS-06", { status: Status.NA, score: null, value: "No active keywords" });
  }
  const risky = broad.filter((k) => {
    const c = ctx.campaigns.get(k.campaign_id);
    return c !== undefined && !SMART_BIDDING.has(c.bidding_strategy_type);
  });
  if (risky.length) {
    const ev: Evidence[] = risky.slice(0, 8).map((k) => ({
      name: k.text,
      id: k.campaign_id,
      detail: "broad match without Smart Bidding",
    }));
    return result("KWS-06", {
      status: Status.BAD,
      score: null,
      value: `${risky.length} broad keyword(s) in non-Smart-Bidding campaigns`,
      evidence: ev,
    });
  }
  return result("KWS-06", {
    status: Status.GOOD,
    score: null,
    value: `${broad.length} broad keyword(s), all under Smart Bidding`,
  });
}

// KWS-07 (keywords per ad group) removed per the team's review.

/**
 * KWS-08 (discrete): duplicate keywords — same text AND match type in 2+ ad groups.
 *
 * Different match types of the same text (e.g. "u visa attorney" phrase vs
 * [u visa attorney] exact) are NOT duplicates. One evidence line per duplicated
 * keyword (with its match type), naming the ad groups it appears in.
 */
export function kws08(ctx: AuditContext): CheckResult {
  if (!ctx.keywords.length) {
    return result("KWS-08", { status: Status.NA, score: null, value: "No active keywords" });
  }
  const SEP = "\u0000";
  const byKey = new Map<string, Set<string>>(); // "text\0match" -> ad group ids
  const display = new Map<string, string>(); // "text\0match" -> original text
  for (const k of ctx.keywords) {
    const key = `${k.text.toLowerCase()}${SEP}${k.match_type}`;
    let ags = byKey.get(key);
    if (!ags) {
      ags = new Set<string>();
      byKey.set(key, ags);
    }
    ags.add(k.ad_group_id);
    display.set(key, k.text);
  }
  const dupes = [...byKey.entries()].filter(([, ags]) => ags.size > 1);
  const ratio = byKey.size ? dupes.length / byKey.size : 0;
  let status: Status;
  if (!dupes.length) status = Status.GOOD;
  else if (ratio <= 0.1) status = Status.OKAY;
  else status = Status.BAD;
  const ev: Evidence[] = dupes
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 10)
    .map(([key, ags]) => {
      const mt = key.split(SEP)[1] ?? "";
      return {
        name: `"${display.get(key)}" [${mt.toLowerCase()}]`,
        id: null,
        detail: [...ags]
          .map((ag) => ctx.adGroupName(ag))
          .sort()
          .join(", "),
      };
    });
  return result("KWS-08", {
    status,
    score: null,
    value: `${dupes.length} duplicated keyword(s) across ad groups`,
    evidence: ev,
  });
}
