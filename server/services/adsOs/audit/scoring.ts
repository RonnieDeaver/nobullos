/**
 * Ads OS — audit scoring engine (port of backend/app/audit/scoring.py).
 *
 * Impact-weighted, flat (no category-average dilution). The overall score is a
 * single weighted average of every applicable check, using each check's global
 * impact weight. A `critical`-impact check that is failing (status bad/critical)
 * caps the overall so the account can't read "Healthy".
 *
 * Pure functions over CheckResult lists + the weights config. No API calls.
 */

import {
  categoryName,
  dynamicCap,
  isCriticalImpact,
  loadWeights,
} from "./configLoader";
import {
  Status,
  type CategoryResult,
  type CheckResult,
  type GateTriggered,
} from "./models";

/** Python round(x, 1) equivalent (documented drift on exact .05 ties is acceptable). */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function statusToScore(status: Status): number | null {
  if (status === Status.NA) return null;
  return Number(loadWeights().status_scores[status as "good" | "okay" | "bad" | "critical"]);
}

export function clamp(value: number, lo = 0.0, hi = 100.0): number {
  return Math.max(lo, Math.min(hi, value));
}

/** Σ(wᵢ·sᵢ) / Σ(wᵢ) over applicable (non-NA) checks, by impact weight. */
function weightedAvg(checks: CheckResult[]): number {
  let num = 0;
  let den = 0;
  for (const chk of checks) {
    if (chk.score === null || chk.score === undefined || chk.status === Status.NA) continue;
    num += chk.weight * chk.score;
    den += chk.weight;
  }
  return den ? round1(num / den) : 0.0;
}

export function categoryScore(checks: CheckResult[]): number {
  return weightedAvg(checks);
}

export function buildCategories(checks: CheckResult[]): CategoryResult[] {
  const byCat = new Map<string, CheckResult[]>();
  for (const chk of checks) {
    const list = byCat.get(chk.category);
    if (list) list.push(chk);
    else byCat.set(chk.category, [chk]);
  }

  const totalW = checks.reduce((acc, c) => acc + c.weight, 0) || 1.0;
  const categories: CategoryResult[] = [];
  for (const [code, catChecks] of byCat) {
    const share = catChecks.reduce((acc, c) => acc + c.weight, 0) / totalW;
    categories.push({
      code,
      name: categoryName(code),
      weight: Math.round(share * 10000) / 10000, // category's share of total weight (display)
      score: categoryScore(catChecks),
      checks: catChecks,
    });
  }
  categories.sort((a, b) => a.score - b.score); // worst-first
  return categories;
}

/** Flat impact-weighted average over every applicable check. */
export function overallScore(checks: CheckResult[]): number {
  return weightedAvg(checks);
}

/**
 * Return [failing critical issues, effective cap].
 *
 * A `critical`-impact check failing (status bad/critical; "okay" does not
 * count) is an issue. The single effective cap scales with the number of
 * issues (see configLoader.dynamicCap). Each issue carries that same cap so
 * the report can show it. Cap is null if no issues.
 */
export function evaluateCaps(
  checksById: Map<string, CheckResult>,
): [GateTriggered[], number | null] {
  const failing: [string, CheckResult][] = [];
  for (const [cid, chk] of checksById) {
    if (isCriticalImpact(cid) && (chk.status === Status.BAD || chk.status === Status.CRITICAL)) {
      failing.push([cid, chk]);
    }
  }
  const cap = dynamicCap(failing.map(([cid]) => cid));
  const issues: GateTriggered[] = failing.map(([cid, chk]) => ({
    id: cid,
    source: cid,
    cap: cap ?? 0.0,
    reason: chk.value,
  }));
  // most severe / earliest category first for display
  issues.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  return [issues, cap];
}

export function applyCaps(rawScore: number, cap: number | null): number {
  return cap !== null ? round1(Math.min(rawScore, cap)) : round1(rawScore);
}

export function bandFor(score: number): [string, string] {
  for (const band of loadWeights().bands) {
    // ordered high->low
    if (score >= band.min) return [band.name, band.color];
  }
  return ["Critical", "red"];
}
