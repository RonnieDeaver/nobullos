/** OPT checks — Optimization Score & Recommendations (port of audit/checks/opt.py). */

import { Status, type CheckResult, type Evidence } from "../models";
import type { AuditContext } from "../context";
import { round1 } from "../scoring";
import { result } from "./base";

/** OPT-01 (continuous): optimization score (0-1 from API -> 0-100). */
export function opt01(ctx: AuditContext): CheckResult {
  const score = ctx.customer_optimization_score * 100;
  if (ctx.customer_optimization_score <= 0) {
    return result("OPT-01", { status: Status.NA, score: null, value: "No optimization score" });
  }
  let status: Status;
  if (score >= 85) status = Status.GOOD;
  else if (score >= 70) status = Status.OKAY;
  else status = Status.BAD;
  // Worst campaigns by their own optimization score, for context.
  const low = [...ctx.campaigns.values()]
    .filter((c) => c.optimization_score > 0)
    .sort((a, b) => a.optimization_score - b.optimization_score)
    .slice(0, 5);
  const ev: Evidence[] = low
    .filter((c) => c.optimization_score * 100 < 85)
    .map((c) => ({
      name: c.name,
      id: c.id,
      detail: `${(c.optimization_score * 100).toFixed(0)}% opt score`,
    }));
  return result("OPT-01", {
    status,
    score: round1(score),
    value: `optimization score ${score.toFixed(0)}%`,
    evidence: ev,
  });
}

// OPT-02 (pending recommendations) removed per the 2026 team review. OPT-03
// (auto-apply settings) removed earlier — not readable via GAQL.
