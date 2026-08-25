/**
 * Ads OS — helpers shared by audit check modules
 * (port of backend/app/audit/checks/base.py).
 */

import { checkMeta, impactLevel, impactWeight } from "../configLoader";
import { Status, type CheckResult, type Evidence } from "../models";

// Discrete status -> sub-score (spec 2.1), mirrored from weights status_scores.
const DISCRETE: Record<Status, number | null> = {
  [Status.GOOD]: 100.0,
  [Status.OKAY]: 60.0,
  [Status.BAD]: 20.0,
  [Status.CRITICAL]: 0.0,
  [Status.NA]: null,
};

export interface ResultOpts {
  status: Status;
  score: number | null;
  value: string;
  evidence?: Evidence[];
}

/**
 * Build a CheckResult, filling name/category/recommendation from the check
 * catalog.
 *
 * If a discrete check passes score=null with a non-NA status, the score is
 * derived from the status map. Continuous checks pass an explicit score; NA
 * checks keep score null (excluded from scoring).
 */
export function result(checkId: string, opts: ResultOpts): CheckResult {
  let { score } = opts;
  if ((score === null || score === undefined) && opts.status !== Status.NA) {
    score = DISCRETE[opts.status];
  }
  const meta = checkMeta(checkId);
  return {
    id: checkId,
    category: meta?.category ?? checkId.split("-")[0],
    name: meta?.name ?? checkId,
    status: opts.status,
    score: score ?? null,
    weight: impactWeight(checkId),
    impact: impactLevel(checkId),
    value: opts.value,
    evidence: opts.evidence ?? [],
    recommendation: meta?.recommendation ?? "",
  };
}

/** Convenience for discrete checks: maps status to its fixed sub-score. */
export function discrete(
  checkId: string,
  status: Status,
  value: string,
  evidence?: Evidence[],
): CheckResult {
  return result(checkId, {
    status,
    score: DISCRETE[status],
    value,
    evidence,
  });
}
