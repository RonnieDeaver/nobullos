/**
 * AST checks — Assets / Extensions (port of audit/checks/ast.py).
 *
 * Evaluated per campaign using EFFECTIVE counts. Google Ads serves assets from
 * three levels — account (customer), campaign, and ad group — and an ad
 * inherits account + campaign assets while ad-group assets add on top for that
 * ad group only. So the effective count for a campaign is campaign-level +
 * account-level PLUS the ad-group-level assets of its ad groups, scored on the
 * WORST-covered enabled ad group (min): a campaign is fully covered only if
 * every serving ad group is. Asset field_type enum names are matched via
 * predicates so a naming nuance doesn't silently zero a category.
 */

import { Status, type CheckResult, type Evidence } from "../models";
import type { AuditContext } from "../context";
import { round1 } from "../scoring";
import { result } from "./base";

type Match = (fieldType: string) => boolean;

function count(ctx: AuditContext, campaignId: string, match: Match): number {
  // campaign + account assets are inherited by every ad in the campaign.
  let base = 0;
  for (const [ft, n] of ctx.campaign_assets.get(campaignId) ?? []) {
    if (match(ft)) base += n;
  }
  for (const [ft, n] of ctx.account_assets) {
    if (match(ft)) base += n;
  }
  // ad-group-level assets serve only for their ad group, so a campaign is covered
  // only as well as its least-covered SERVING ad group (>=1 enabled ad — an ad-less
  // shell ad group serves nothing and must not drag the count down). No serving ad
  // groups -> just base. Never drops below the old campaign+account count (>= 0).
  const ags = [...(ctx.ad_group_ids_by_campaign.get(campaignId) ?? [])].filter((a) =>
    ctx.serving_ad_group_ids.has(a),
  );
  if (!ags.length) return base;
  let min = Infinity;
  for (const ag of ags) {
    let agCount = 0;
    for (const [ft, n] of ctx.ad_group_assets.get(ag) ?? []) {
      if (match(ft)) agCount += n;
    }
    min = Math.min(min, base + agCount);
  }
  return min;
}

const is = (name: string): Match => (ft) => ft === name;
const has = (sub: string): Match => (ft) => ft.includes(sub);

/** Good if every campaign has >=1 of the asset (campaign or account level). */
function discretePresence(ctx: AuditContext, checkId: string, match: Match, label: string): CheckResult {
  const campaigns = [...ctx.campaigns.values()];
  if (!campaigns.length) {
    return result(checkId, { status: Status.NA, score: null, value: "No enabled campaigns" });
  }
  const missing = campaigns.filter((c) => count(ctx, c.id, match) === 0);
  if (missing.length) {
    const ev: Evidence[] = missing.slice(0, 8).map((c) => ({
      name: c.name,
      id: c.id,
      detail: `no ${label}`,
    }));
    return result(checkId, {
      status: Status.BAD,
      score: null,
      value: `${missing.length} of ${campaigns.length} campaigns missing a ${label}`,
      evidence: ev,
    });
  }
  return result(checkId, {
    status: Status.GOOD,
    score: null,
    value: `All campaigns have a ${label}`,
  });
}

/** AST-01 (continuous): sitelinks. 0->20, 1-3->45, 4-5->70, 6+->100 (avg). */
export function ast01(ctx: AuditContext): CheckResult {
  const campaigns = [...ctx.campaigns.values()];
  if (!campaigns.length) {
    return result("AST-01", { status: Status.NA, score: null, value: "No enabled campaigns" });
  }

  const scoreFor = (n: number): number => {
    if (n >= 6) return 100.0;
    if (n >= 4) return 70.0;
    if (n >= 1) return 45.0;
    return 20.0;
  };

  const counts = new Map<string, number>();
  for (const c of campaigns) counts.set(c.id, count(ctx, c.id, is("SITELINK")));
  const values = [...counts.values()];
  const avg = values.reduce((a, n) => a + scoreFor(n), 0) / counts.size;
  const low = [...counts.entries()].filter(([, n]) => n < 6);
  let status: Status;
  if (avg >= 90) status = Status.GOOD;
  else if (avg >= 55) status = Status.OKAY;
  else status = Status.BAD;
  const ev: Evidence[] = low
    .sort((a, b) => a[1] - b[1])
    .slice(0, 8)
    .map(([cid, n]) => ({ name: ctx.campaignName(cid), id: cid, detail: `${n} sitelinks` }));
  const val = low.length
    ? `${low.length} of ${counts.size} campaign(s) under 6 sitelinks`
    : `all ${counts.size} campaigns have 6+ sitelinks`;
  return result("AST-01", { status, score: round1(avg), value: val, evidence: ev });
}

/** AST-02: call asset present. */
export function ast02(ctx: AuditContext): CheckResult {
  return discretePresence(ctx, "AST-02", is("CALL"), "call asset");
}

/**
 * AST-03: location asset present.
 *
 * Location assets are linked via Business Profile and don't show up as
 * customer/campaign asset field_types, so if no campaign-level location asset
 * is found we fall back to account-level location assets (asset.type LOCATION),
 * which apply account-wide.
 */
export function ast03(ctx: AuditContext): CheckResult {
  if (!ctx.campaigns.size) {
    return result("AST-03", { status: Status.NA, score: null, value: "No enabled campaigns" });
  }
  if (ctx.account_location_assets > 0) {
    return result("AST-03", {
      status: Status.GOOD,
      score: null,
      value: `${ctx.account_location_assets} account-level location asset(s) (applied account-wide)`,
    });
  }
  return discretePresence(ctx, "AST-03", has("LOCATION"), "location asset");
}

/** AST-04: structured snippet present. */
export function ast04(ctx: AuditContext): CheckResult {
  return discretePresence(ctx, "AST-04", is("STRUCTURED_SNIPPET"), "structured snippet");
}

/** AST-05: callout present. */
export function ast05(ctx: AuditContext): CheckResult {
  return discretePresence(ctx, "AST-05", is("CALLOUT"), "callout");
}

/** AST-06 (continuous): image assets. 0->20, 1-2->60, 3+->100 (avg). */
export function ast06(ctx: AuditContext): CheckResult {
  const campaigns = [...ctx.campaigns.values()];
  if (!campaigns.length) {
    return result("AST-06", { status: Status.NA, score: null, value: "No enabled campaigns" });
  }

  const scoreFor = (n: number): number => (n >= 3 ? 100.0 : n >= 1 ? 60.0 : 20.0);

  const counts = new Map<string, number>();
  for (const c of campaigns) counts.set(c.id, count(ctx, c.id, has("IMAGE")));
  const values = [...counts.values()];
  const avg = values.reduce((a, n) => a + scoreFor(n), 0) / counts.size;
  let status: Status;
  if (avg >= 90) status = Status.GOOD;
  else if (avg >= 55) status = Status.OKAY;
  else status = Status.BAD;
  const low = [...counts.entries()].filter(([, n]) => n < 3);
  const ev: Evidence[] = low
    .sort((a, b) => a[1] - b[1])
    .slice(0, 8)
    .map(([cid, n]) => ({ name: ctx.campaignName(cid), id: cid, detail: `${n} image assets` }));
  return result("AST-06", {
    status,
    score: round1(avg),
    value: `avg image-asset coverage across ${counts.size} campaigns`,
    evidence: ev,
  });
}

// AST-08 (asset approval) removed per the team's review — disapproved/limited
// assets now surface through the Account Alerts engine, not the hygiene audit.
