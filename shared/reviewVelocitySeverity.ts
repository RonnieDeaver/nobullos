/**
 * Task #2579 — shared review-velocity goal/target band classification.
 *
 * Task #2566 added a 90-day trailing-average review velocity headline + trend
 * chart to the client-facing Review Generation panel, but it only shows the
 * *pace* with no sense of whether that pace is good or bad. This module turns a
 * velocity (reviews/month) plus an admin-set per-client monthly target into a
 * green/yellow/red band — the same self-explanatory coloring other report
 * sections use (cf. `shared/commonIssuesSeverity.ts`).
 *
 * Keeping the thresholds here (rather than inline in `PublicReport.tsx`) means
 * any future tuning or reuse stays in one place and the UI can't drift.
 */

/**
 * Velocity band ordered best → worst, plus a neutral `none` band used when no
 * target is set. `none` must render with neutral styling — never silent green.
 */
export type ReviewVelocityBand = "on_track" | "behind" | "off_track" | "none";

/**
 * Fraction of the monthly target at or above which a below-target velocity is
 * still considered "behind" (yellow) rather than "off track" (red).
 */
export const REVIEW_VELOCITY_BEHIND_RATIO = 0.7;

/**
 * Classify a review velocity (reviews/month) against an optional per-client
 * monthly target.
 *
 * - No target (undefined / null / <= 0) → `none` (neutral, no judgement).
 * - velocity >= target                  → `on_track` (green).
 * - velocity >= target * BEHIND_RATIO   → `behind` (yellow).
 * - otherwise                           → `off_track` (red).
 */
export function getReviewVelocityBand(
  velocity: number,
  target?: number | null,
): ReviewVelocityBand {
  if (target == null || !Number.isFinite(target) || target <= 0) return "none";
  if (!Number.isFinite(velocity) || velocity < 0) velocity = 0;
  if (velocity >= target) return "on_track";
  if (velocity >= target * REVIEW_VELOCITY_BEHIND_RATIO) return "behind";
  return "off_track";
}

/**
 * Task #2596 — resolve the effective monthly review target for a report.
 *
 * The report's review-velocity band needs a single monthly target. Precedence:
 *
 *   1. the per-report target (`reviewGeneration.monthlyTarget`) when set, else
 *   2. the per-client default target (`clients.monthlyReviewTarget`) when set, else
 *   3. no target → `null` (neutral band, never silent green/red).
 *
 * A value of `<= 0` (or non-finite / null / undefined) at either level is
 * treated as "no target set" so a stored 0 never wins over the client default
 * and never paints a judgement the firm never set.
 */
export function resolveReviewMonthlyTarget(
  perReportTarget?: number | null,
  clientTarget?: number | null,
): number | null {
  const valid = (v?: number | null): v is number =>
    v != null && Number.isFinite(v) && v > 0;
  if (valid(perReportTarget)) return perReportTarget;
  if (valid(clientTarget)) return clientTarget;
  return null;
}

/** Short, client-facing label for a velocity band. */
export function getReviewVelocityBandLabel(band: ReviewVelocityBand): string {
  switch (band) {
    case "on_track":
      return "On track";
    case "behind":
      return "Behind pace";
    case "off_track":
      return "Off track";
    default:
      return "No target set";
  }
}
