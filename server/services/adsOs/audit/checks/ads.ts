/** ADS checks — Ads & Creative (port of audit/checks/ads.py). */

import { Status, type CheckResult, type Evidence } from "../models";
import type { AuditContext } from "../context";
import { round1 } from "../scoring";
import { result } from "./base";

// Ad strength enum name -> sub-score (spec ADS-01).
const STRENGTH_SCORE: Record<string, number> = {
  EXCELLENT: 100.0,
  GOOD: 85.0,
  AVERAGE: 55.0,
  POOR: 20.0,
};

/** ADS-01 (continuous): ad-weighted average ad strength of active ads. */
export function ads01(ctx: AuditContext): CheckResult {
  const scores = ctx.ads
    .filter((a) => a.ad_strength in STRENGTH_SCORE)
    .map((a) => STRENGTH_SCORE[a.ad_strength]);
  if (!scores.length) {
    return result("ADS-01", {
      status: Status.NA,
      score: null,
      value: "No ads with an ad-strength rating",
    });
  }
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  let status: Status;
  if (avg >= 85) status = Status.GOOD;
  else if (avg >= 55) status = Status.OKAY;
  else status = Status.BAD;

  const weak = ctx.ads.filter((a) => a.ad_strength === "POOR" || a.ad_strength === "AVERAGE");
  const ev: Evidence[] = weak.slice(0, 8).map((a) => ({
    name: `Ad ${a.ad_id}`,
    id: a.ad_group_id,
    detail: a.ad_strength.charAt(0) + a.ad_strength.slice(1).toLowerCase(),
  }));
  const counts: Record<string, number> = {};
  for (const a of ctx.ads) {
    if (a.ad_strength in STRENGTH_SCORE) counts[a.ad_strength] = (counts[a.ad_strength] ?? 0) + 1;
  }
  const summary = Object.entries(counts)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, n]) => `${n} ${k.toLowerCase()}`)
    .join(", ");
  return result("ADS-01", {
    status,
    score: round1(avg),
    value: `avg ad strength ${avg.toFixed(0)}/100 (${summary})`,
    evidence: ev,
  });
}

/** ADS-02 (continuous): active ads per ad group. 0->0, 1->60, 2+->100, averaged. */
export function ads02(ctx: AuditContext): CheckResult {
  if (!ctx.enabled_ad_group_ids.size) {
    return result("ADS-02", { status: Status.NA, score: null, value: "No enabled ad groups" });
  }
  const perAg = new Map<string, number>();
  for (const ag of ctx.enabled_ad_group_ids) perAg.set(ag, 0);
  for (const a of ctx.ads) {
    if (perAg.has(a.ad_group_id)) perAg.set(a.ad_group_id, (perAg.get(a.ad_group_id) ?? 0) + 1);
  }

  const agScore = (n: number): number => (n === 0 ? 0.0 : n === 1 ? 60.0 : 100.0);

  const counts = [...perAg.values()];
  const avg = counts.reduce((a, n) => a + agScore(n), 0) / perAg.size;
  const empty = [...perAg.entries()].filter(([, n]) => n === 0).map(([ag]) => ag);
  const single = [...perAg.entries()].filter(([, n]) => n === 1).map(([ag]) => ag);
  // Worst case present drives the status band.
  let status: Status;
  if (empty.length) status = Status.CRITICAL;
  else if (single.length) status = Status.OKAY;
  else status = Status.GOOD;

  const ev: Evidence[] = empty.slice(0, 8).map((ag) => ({
    name: ctx.adGroupName(ag),
    id: ag,
    detail: "0 active ads",
  }));
  ev.push(
    ...single.slice(0, 8).map((ag) => ({
      name: ctx.adGroupName(ag),
      id: ag,
      detail: "only 1 active ad",
    })),
  );
  return result("ADS-02", {
    status,
    score: round1(avg),
    value: `${empty.length} ad groups with 0 ads, ${single.length} with 1 (of ${perAg.size})`,
    evidence: ev,
  });
}

// ADS-03 (>=1 RSA per ad group) removed per team review — overlaps ADS-02.
// ADS-04 (RSA asset utilization) removed per the 2026 team review.

/** ADS-05 (discrete): over-pinning (most assets pinned caps strength/learning). */
export function ads05(ctx: AuditContext): CheckResult {
  const rsas = ctx.ads.filter((a) => a.is_rsa && a.headline_count + a.description_count > 0);
  if (!rsas.length) {
    return result("ADS-05", { status: Status.NA, score: null, value: "No RSAs" });
  }
  const over = rsas.filter((a) => a.pinned_count >= 0.5 * (a.headline_count + a.description_count));
  if (over.length) {
    const ev: Evidence[] = over.slice(0, 8).map((a) => ({
      name: `Ad ${a.ad_id}`,
      id: a.ad_group_id,
      detail: `${a.pinned_count} of ${a.headline_count + a.description_count} assets pinned`,
    }));
    const status = over.length / rsas.length > 0.3 ? Status.BAD : Status.OKAY;
    return result("ADS-05", {
      status,
      score: null,
      value: `${over.length} of ${rsas.length} RSAs heavily pinned`,
      evidence: ev,
    });
  }
  return result("ADS-05", { status: Status.GOOD, score: null, value: "No over-pinned RSAs" });
}

// ADS-06 (final URL present) removed per the team's review.

// Deprecated ad formats that should no longer be present.
const DEPRECATED_TYPES = new Set(["CALL_ONLY_AD", "EXPANDED_TEXT_AD", "GMAIL_AD"]);

/** ADS-07 (discrete): no deprecated ad formats. */
export function ads07(ctx: AuditContext): CheckResult {
  if (!ctx.ads.length) {
    return result("ADS-07", { status: Status.NA, score: null, value: "No active ads" });
  }
  const legacy = ctx.ads.filter((a) => DEPRECATED_TYPES.has(a.ad_type));
  if (legacy.length) {
    const ev: Evidence[] = legacy.slice(0, 8).map((a) => ({
      name: `Ad ${a.ad_id}`,
      id: a.ad_group_id,
      detail: a.ad_type,
    }));
    return result("ADS-07", {
      status: Status.BAD,
      score: null,
      value: `${legacy.length} deprecated-format ad(s)`,
      evidence: ev,
    });
  }
  return result("ADS-07", { status: Status.GOOD, score: null, value: "No deprecated ad formats" });
}
