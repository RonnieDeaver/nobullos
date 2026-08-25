/**
 * Task #2460 — shared section severity classification for Common Issues tone.
 *
 * The Public Report UI classifies a report section into severity bands
 * (healthy / issue / big_issue / critical) from its conversion rate vs the
 * section goal, gated on the client's consult type (free vs paid). The server
 * Common Issues formatter (`commonIssuesFormatter.ts`) needs the EXACT same
 * classification so the imported issue tone can scale with how the firm is
 * actually performing. Extracting the thresholds here keeps the UI and the
 * formatter from drifting apart.
 *
 * Thresholds mirror, verbatim, the band logic that previously lived inline in
 * `client/src/pages/PublicReport.tsx`:
 *   - Intake → Lead-to-Consult rate vs the intake goal (`getLeadToConsultStatus`).
 *   - Sales  → Consult-to-Case rate vs the sales goal (`getConsultToCaseStatus`).
 *
 * The bands themselves are NOT re-tuned here (Task #2460 out-of-scope) — this
 * module only relocates the existing thresholds to a single source of truth.
 */

export type ConsultType = "free" | "paid";

/** Section severity ordered weakest → most severe. */
export type SeverityBand = "healthy" | "issue" | "big_issue" | "critical";

/**
 * Intake (Lead-to-Consult) goal by consult type. Paid consults convert at a
 * lower expected rate, so the goal is lower.
 */
export function getIntakeTargetRate(consultType: ConsultType): number {
  return consultType === "paid" ? 45 : 65;
}

/**
 * Sales (Consult-to-Case) "healthy" floor by consult type — the rate at or
 * above which the section is considered at goal.
 */
export function getSalesTargetRate(consultType: ConsultType): number {
  return consultType === "paid" ? 35 : 30;
}

/**
 * Intake severity band from a Lead-to-Consult rate vs the intake goal.
 * Mirrors `getLeadToConsultStatus` in PublicReport.tsx.
 */
export function getIntakeSeverityBand(
  rate: number,
  consultType: ConsultType,
): SeverityBand {
  const target = getIntakeTargetRate(consultType);
  if (rate < target - 20) return "critical";
  if (rate < target - 10) return "big_issue";
  if (rate < target) return "issue";
  return "healthy";
}

/**
 * Sales severity band from a Consult-to-Case rate vs the sales goal.
 * Mirrors `getConsultToCaseStatus` in PublicReport.tsx (note: free uses `<=`
 * at the critical floor, paid likewise — preserved exactly).
 */
export function getSalesSeverityBand(
  rate: number,
  consultType: ConsultType,
): SeverityBand {
  if (consultType === "free") {
    if (rate <= 15) return "critical";
    if (rate < 20) return "big_issue";
    if (rate < 30) return "issue";
    return "healthy";
  }
  if (rate <= 20) return "critical";
  if (rate < 25) return "big_issue";
  if (rate < 35) return "issue";
  return "healthy";
}

/** Section-keyed convenience wrapper over the two band functions above. */
export function getSectionSeverityBand(
  section: "intake" | "sales",
  rate: number,
  consultType: ConsultType,
): SeverityBand {
  return section === "sales"
    ? getSalesSeverityBand(rate, consultType)
    : getIntakeSeverityBand(rate, consultType);
}

/** The goal/target rate for a section (intake target, or sales healthy floor). */
export function getSectionTargetRate(
  section: "intake" | "sales",
  consultType: ConsultType,
): number {
  return section === "sales"
    ? getSalesTargetRate(consultType)
    : getIntakeTargetRate(consultType);
}
