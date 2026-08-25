/**
 * Shared department-matching helper for Service Desk request types.
 *
 * This module is pure string logic (no DB, no network) so it can be consumed
 * by both the Node.js server (auto-match endpoint, import flow) and the
 * browser client (create-ticket form filter).
 *
 * Naming conventions in production data:
 *   - Departments: "Group – Label"  e.g. "Fulfillment – GBP / Local SEO"
 *                  possibly prefixed with "Option N" artifact from ClickUp
 *   - Request types: "Prefix – Short Label"  e.g. "GBP / Local SEO – Citation Cleanup"
 *
 * Matching algorithm (same order as the CEO auto-match endpoint):
 *   1. Extract prefix from RT name (text before first " – " / " - " / " — ").
 *   2. Strip "Option N" from department names.
 *   3. Parse dept name into group + label.
 *   4. For each dept candidate try in score order:
 *      a. Exact label match (normalised, lower-case).       score 100
 *      b. Label contains prefix OR prefix contains label.   score 80
 *      c. Full dept name contains prefix.                   score 60
 *   5. Multiple candidates at the same top score → "ambiguous" (not matched).
 *   6. Zero candidates → null (no match).
 */

export interface SdDeptLike {
  id: string;
  name: string;
}

/** Strip a leading "Option N" artifact (e.g. "Option 1Fulfillment – GBP / Local SEO"). */
export function stripOptPrefix(name: string): string {
  return name.replace(/^Option\s*\d+\s*/i, "").trim();
}

/** Normalise: lower-case, collapse whitespace. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Extract the label portion from a department name of the form "Group – Label".
 * Returns null for names with no recognisable separator.
 */
export function extractDeptLabel(deptName: string): string | null {
  const clean = stripOptPrefix(deptName);
  const m = clean.match(/^.+?\s+[–—\-]\s+(.+)$/);
  return m ? m[1].trim() : null;
}

/**
 * Extract the prefix from a request-type name of the form "Prefix – Short Label".
 * Falls back to the whole name if no separator is found.
 */
export function extractRtPrefix(rtName: string): string {
  const m = rtName.match(/^(.+?)\s+[–—\-]\s+.+$/);
  return m ? m[1].trim() : rtName.trim();
}

export type MatchResult =
  | { kind: "matched"; deptId: string; reason: string }
  | { kind: "ambiguous" }
  | { kind: "no_match" };

/**
 * Find the best-matching department for a given request-type name prefix.
 *
 * Returns:
 *   { kind: "matched", deptId, reason }  — one clear winner
 *   { kind: "ambiguous" }                — multiple equally-good candidates
 *   { kind: "no_match" }                 — nothing matched
 */
export function matchDeptForPrefix(prefix: string, departments: SdDeptLike[]): MatchResult {
  const p = norm(prefix);
  const candidates: { dept: SdDeptLike; score: number; reason: string }[] = [];

  for (const dept of departments) {
    const fullNorm = norm(stripOptPrefix(dept.name));
    const label = extractDeptLabel(dept.name);
    const labelNorm = label ? norm(label) : null;

    if (labelNorm && labelNorm === p) {
      candidates.push({ dept, score: 100, reason: "label exact" });
      continue;
    }
    if (labelNorm && (labelNorm.includes(p) || p.includes(labelNorm))) {
      candidates.push({ dept, score: 80, reason: "label contains" });
      continue;
    }
    if (fullNorm.includes(p)) {
      candidates.push({ dept, score: 60, reason: "full name contains" });
      continue;
    }
  }

  if (candidates.length === 0) return { kind: "no_match" };

  const best = candidates.sort((a, b) => b.score - a.score)[0];
  const topScore = best.score;
  const topMatches = candidates.filter((c) => c.score === topScore);
  if (topMatches.length > 1) return { kind: "ambiguous" };

  return { kind: "matched", deptId: best.dept.id, reason: best.reason };
}

/**
 * Resolve the effective department ID for a request type, using:
 *   1. The stored departmentId if already set.
 *   2. Name-prefix matching against the provided departments list.
 *
 * Returns null when neither the stored ID nor the prefix match resolves.
 * Returns "ambiguous" when the name prefix matches multiple departments at the
 * same confidence level (caller may choose to treat this the same as null).
 */
export function resolveRequestTypeDept(
  rt: { departmentId?: string | null; name: string },
  departments: SdDeptLike[],
): string | null | "ambiguous" {
  if (rt.departmentId) return rt.departmentId;
  const prefix = extractRtPrefix(rt.name);
  const result = matchDeptForPrefix(prefix, departments);
  if (result.kind === "matched") return result.deptId;
  if (result.kind === "ambiguous") return "ambiguous";
  return null;
}
