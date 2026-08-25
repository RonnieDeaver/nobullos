// Shared budget-pacing thresholds for the colored pacing pills (every dashboard)
// and tiles (the GAds + LSA Budget Pacing tools), so the same account never shows a
// different color in two places. `pct` = + ahead of pace (overspending) / − behind:
//
//   green  (g):  −5% to 0%    — on pace (on-target through slightly behind)
//   yellow (w):  0% to +5% (over) OR −5% to −15% (behind) — slightly off pace
//   red    (b):  above +5% (over) OR worse than −15% (behind) — far off pace
//
// Boundaries: exactly 0% and exactly −5% are green; +5% and −15% are yellow. A
// value that is even a hair positive (e.g. +0.3%, which rounds to "+0%") is yellow,
// not green — only 0 or negative counts as on-target.
//
// "MBH" (monthly-budget-hit: MTD spend has reached the monthly budget) is decided
// separately by each caller and overrides these colors.
export type PaceClass = "g" | "w" | "b";

export function paceClass(pct: number): PaceClass {
  if (pct > 5 || pct < -15) return "b"; // more than 5% over, or more than 15% behind
  if (pct > 0 || pct < -5) return "w";  // 0–5% over, or 5–15% behind
  return "g";                            // on pace: 0% down to −5%
}

// Class + human label for the Budget Pacing tool tiles (which also handle the
// no-budget / too-early case). Colors stay consistent with `paceClass`.
//
// Task #3706: pass `ctx` to split the null-pct case — a real budget with ZERO
// scheduled days elapsed is the neutral "month hasn't started yet for this
// schedule" state (e.g. a weekday-only account on an Aug 1–2 weekend), not a
// data gap; without ctx (or with elapsed unknown) the generic label stands.
export function paceStatus(
  pct: number | null,
  ctx?: { budget?: number | null; scheduledDaysElapsed?: number | null },
): { cls: PaceClass | "n"; label: string } {
  if (pct == null) {
    if (ctx && ctx.budget != null && ctx.scheduledDaysElapsed === 0) {
      return { cls: "n", label: "no scheduled days elapsed yet" };
    }
    return { cls: "n", label: "no budget / too early" };
  }
  const label =
    pct > 0 ? "ahead of pace (overspending)"
    : pct < -15 ? "far behind pace (underspending)"
    : pct < -5 ? "behind pace (underspending)"
    : "on track";
  return { cls: paceClass(pct), label };
}
