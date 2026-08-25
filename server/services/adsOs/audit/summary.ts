/**
 * Builds the tiered "Next steps" roadmap shown in the report
 * (port of backend/app/audit/summary.py).
 *
 * Tier assignment per check lives in SPECS, kept in sync with the team's
 * spreadsheet. A check fires a next-step when its status is in the listed set;
 * the detail is the check's own measured value. KWS-01 adds the QS factor
 * sub-points. The 'week' tier maps to the long_term field (labelled
 * 'Schedule for this week' in the UI).
 */

import { Status, type CheckResult, type NextStep, type NextSteps } from "./models";
import type { AuditContext } from "./context";

// [check_id, tier, fire-when-status-in, title].  tier: critical | easy | week.
// Tiers reflect the team's re-tiered hygiene spec (2026 review): serving/policy
// failures (disapproved ads/assets, account standing, limited entities) moved to the
// Account Alerts engine, so "Fix ASAP" now holds genuine structural failures only.
const SPECS: Array<[string, "critical" | "easy" | "week", Set<Status>, string]> = [
  // ---- Critical (Fix ASAP) ----
  ["GEO-01", "critical", new Set([Status.CRITICAL]), "Set location targeting"],
  ["GEO-02", "critical", new Set([Status.CRITICAL]), "Switch geo targeting to Presence"],
  ["GEO-04", "critical", new Set([Status.BAD]), "Set language targeting"],
  ["KWS-03", "critical", new Set([Status.BAD, Status.OKAY]), "Add negative-keyword coverage"],
  ["KWS-06", "critical", new Set([Status.BAD]), "Rein in risky broad-match keywords"],
  ["BID-01", "critical", new Set([Status.BAD]), "Lift bid-strategy limits (budget/target/volume)"],
  ["AST-02", "critical", new Set([Status.BAD]), "Add a call asset"],
  ["AST-03", "critical", new Set([Status.BAD]), "Add a location asset"],
  ["STR-01", "critical", new Set([Status.BAD, Status.OKAY]), "Turn off Search Partners / Display network"],
  // ---- Easy wins ----
  ["ADS-01", "easy", new Set([Status.BAD, Status.OKAY]), "Improve ad strength"],
  ["ADS-05", "easy", new Set([Status.BAD, Status.OKAY]), "Reduce RSA pinning"],
  ["ADS-07", "easy", new Set([Status.BAD]), "Replace deprecated ad formats"],
  ["KWS-08", "easy", new Set([Status.BAD, Status.OKAY]), "De-duplicate keywords across ad groups"],
  ["BID-04", "easy", new Set([Status.BAD]), "Move Max Clicks campaigns with 15+ conversions to Smart Bidding"],
  ["BID-05", "easy", new Set([Status.BAD]), "Fix starved tCPA/tROAS targets"],
  ["AST-01", "easy", new Set([Status.BAD, Status.OKAY]), "Add sitelinks (aim for 6+ per campaign)"],
  ["AST-04", "easy", new Set([Status.BAD]), "Add structured snippets"],
  ["AST-05", "easy", new Set([Status.BAD]), "Add callouts"],
  ["AST-06", "easy", new Set([Status.BAD]), "Add image assets"],
  ["OPT-01", "easy", new Set([Status.BAD, Status.OKAY]), "Raise optimization score"],
  // ---- Schedule for this week ----  (KWS-01 QS item added separately)
  ["BID-02", "week", new Set([Status.BAD]), "Raise budget where impression share is lost to budget"],
  ["BID-03", "week", new Set([Status.BAD]), "Recover impression share lost to rank"],
  ["ADS-02", "week", new Set([Status.BAD, Status.OKAY, Status.CRITICAL]), "Add ads to ad groups that have none"],
];

/** KWS-01/02 Quality Score item, broken down by its three factors. */
function qsStep(ctx: AuditContext): NextStep | null {
  const qs = ctx.keywords.filter((k) => k.quality_score > 0).map((k) => k.quality_score);
  if (!qs.length) return null;
  const avg = qs.reduce((a, b) => a + b, 0) / qs.length;
  if (avg >= 7) return null;
  const factors: Array<[string, number, string]> = [
    [
      "Landing page experience",
      ctx.keywords.filter((k) => k.landing_page === "BELOW_AVERAGE").length,
      "faster, more relevant, mobile-friendly landing pages that match the ad's promise",
    ],
    [
      "Expected CTR",
      ctx.keywords.filter((k) => k.expected_ctr === "BELOW_AVERAGE").length,
      "stronger headlines and CTAs; tighten keyword-to-ad match",
    ],
    [
      "Ad relevance",
      ctx.keywords.filter((k) => k.ad_relevance === "BELOW_AVERAGE").length,
      "align ad copy with keywords; split loosely-themed ad groups",
    ],
  ];
  const points = factors
    .sort((a, b) => b[1] - a[1])
    .filter(([, n]) => n > 0)
    .map(([name, n, how]) => `${name} — ${n} keyword(s) below average: ${how}`);
  return {
    title: `Raise Quality Score (avg ${avg.toFixed(1)}/10)`,
    detail: "Work the three QS factors, worst first:",
    source: "KWS-01 · KWS-02",
    points,
  };
}

export function buildNextSteps(checksById: Map<string, CheckResult>, ctx: AuditContext): NextSteps {
  const bins: Record<"critical" | "easy" | "week", NextStep[]> = {
    critical: [],
    easy: [],
    week: [],
  };
  for (const [cid, tier, fireWhen, title] of SPECS) {
    const c = checksById.get(cid);
    if (c && fireWhen.has(c.status)) {
      bins[tier].push({ title, detail: c.value, source: cid, points: [] });
    }
  }
  const qs = qsStep(ctx);
  if (qs) bins.week.unshift(qs);
  return { critical: bins.critical, easy_wins: bins.easy, long_term: bins.week };
}
