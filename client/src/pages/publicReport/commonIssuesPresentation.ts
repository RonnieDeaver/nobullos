/**
 * commonIssuesPresentation — Task #4279 (audit §8.7-6).
 *
 * Pure parser that turns a stored Common Issues markdown blob (canonical
 * 🔴 **Issue:** / ↳ **Impact:** / > ➡️ **Strategic Fix:** blocks, written by
 * server/services/commonIssuesFormatter.ts — Task #234/#3770) into an
 * editorial presentation model the deep-dive slides can render as max-3
 * clean bullets at a 68ch measure.
 *
 * Deliberately presentation-only:
 *   - Severity/tone classification stays single-sourced in
 *     `@shared/commonIssuesSeverity` (Task #2460) — nothing here classifies.
 *   - CONTENT quality gating stays server-side at finalize (Task #4227
 *     degenerate-content gate; Task #4254 owns copy quality) — this module
 *     never rewrites, drops, or invents issue substance, it only slices
 *     structure out of the stored markdown.
 *   - The max-3 cap is applied by the SLIDES via PUBLIC_COMMON_ISSUES_MAX so
 *     the parser stays a faithful structural read of what is stored.
 *
 * Legacy/free-form blobs (no 🔴 markers) fall back to `kind: "prose"` and the
 * slides render them as markdown, capped to the same 68ch measure.
 */

/** §8.7-6 — the public deep-dive slides show at most this many issue bullets. */
export const PUBLIC_COMMON_ISSUES_MAX = 3;

export interface ParsedCommonIssue {
  issue: string;
  impact: string | null;
  fix: string | null;
}

export type CommonIssuesPresentation =
  | { kind: "empty" }
  | { kind: "prose"; markdown: string }
  | {
      kind: "structured";
      /**
       * Healthy-band reports open with one positive sentence (no 🔴 prefix —
       * commonIssuesFormatter tone guidance); rendered as a lead-in line.
       */
      intro: string | null;
      issues: ParsedCommonIssue[];
      /** Pre-cap count — callers slice to PUBLIC_COMMON_ISSUES_MAX. */
      totalCount: number;
    };

/**
 * Flatten a markdown fragment to plain editorial text: strips bold markers,
 * blockquote `>` prefixes, divider lines, and collapses whitespace. Body
 * substance is preserved verbatim otherwise.
 */
function cleanFragment(fragment: string): string {
  return fragment
    .replace(/^[ \t]*-{3,}[ \t]*$/gm, "") // markdown dividers between blocks
    .replace(/\*\*/g, "")
    .replace(/^[ \t]*>[ \t]?/gm, "") // blockquote prefix on fix lines
    .replace(/\s+/g, " ")
    .trim()
    // In one-line smears the `>` blockquote marker sits INLINE before the ➡️
    // fix marker, so it survives the line-anchored strip above and ends up
    // trailing the impact fragment — drop it (issue/impact prose never
    // legitimately ends with a bare `>`).
    .replace(/(?:\s*>\s*)+$/, "");
}

/** Strip a leading "Issue:" / "Impact:" / "Strategic Fix:" style label. */
function stripLabel(text: string, labels: string[]): string {
  for (const label of labels) {
    const re = new RegExp(`^\\s*${label}\\s*:\\s*`, "i");
    if (re.test(text)) return text.replace(re, "").trim();
  }
  return text.trim();
}

export function parseCommonIssuesForPresentation(
  raw: string | null | undefined,
): CommonIssuesPresentation {
  const text = (raw || "").trim();
  if (!text) return { kind: "empty" };

  // Legacy / free-form content without the canonical issue marker renders as
  // prose — never guess structure that isn't there.
  if (!text.includes("🔴")) return { kind: "prose", markdown: text };

  const chunks = text.split("🔴");
  const intro = cleanFragment(chunks[0] ?? "");

  const issues: ParsedCommonIssue[] = [];
  for (const chunk of chunks.slice(1)) {
    // Canonical block order: issue text → ↳ impact → ➡️ fix. Stored rows can
    // carry these inline on one line (pre-#3770 smears), so boundaries are
    // marker positions, not line breaks.
    const impactIdx = chunk.indexOf("↳");
    const fixIdx = chunk.indexOf("➡️");
    const issueEnd = Math.min(
      impactIdx === -1 ? chunk.length : impactIdx,
      fixIdx === -1 ? chunk.length : fixIdx,
    );

    const issueText = stripLabel(cleanFragment(chunk.slice(0, issueEnd)), ["Issue"]);
    let impactText: string | null = null;
    if (impactIdx !== -1) {
      const impactEnd = fixIdx > impactIdx ? fixIdx : chunk.length;
      impactText = stripLabel(cleanFragment(chunk.slice(impactIdx + 1, impactEnd)), ["Impact"]);
    }
    let fixText: string | null = null;
    if (fixIdx !== -1) {
      fixText = stripLabel(cleanFragment(chunk.slice(fixIdx + "➡️".length)), [
        "Strategic Fix",
        "Fix",
      ]);
    }

    if (!issueText && !impactText && !fixText) continue;
    issues.push({
      // A block that somehow lost its issue sentence still shows its impact
      // rather than an empty bullet.
      issue: issueText || impactText || fixText || "",
      impact: issueText ? impactText || null : null,
      fix: fixText || null,
    });
  }

  if (issues.length === 0) {
    // Markers present but nothing parseable — fall back to prose rather than
    // rendering an empty block.
    return intro
      ? { kind: "structured", intro, issues: [], totalCount: 0 }
      : { kind: "prose", markdown: text };
  }

  return {
    kind: "structured",
    intro: intro || null,
    issues,
    totalCount: issues.length,
  };
}
