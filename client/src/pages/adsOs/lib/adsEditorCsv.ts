// Google Ads Editor CSV export helpers.
//
// "Criterion Type" is Editor's canonical name for the column (it also accepts the
// alias "Match Type"). That single column is polymorphic — it carries the match
// type for positive keywords, but the negative marker for negatives. The two
// files use different column sets:
//   • New keywords (positive) at AD-GROUP level → Campaign, Ad Group, Keyword,
//     Criterion Type. Campaign + Ad Group filled, Keyword bare,
//     Criterion Type = Broad | Phrase | Exact.
//   • Negatives are ALWAYS campaign-level, so their file OMITS the Ad Group
//     column entirely → Campaign, Keyword, Criterion Type. Criterion Type =
//     "Campaign negative"; the match type can't also live in that column, so it
//     rides in the keyword text (broad = plain, "phrase" quoted, [exact]
//     bracketed) — the paste-ready format we already produce. RFC-4180 quoting
//     handles the phrase-match double quotes.
// UTF-8, no BOM (a BOM can corrupt Editor's first-column header auto-mapping).
// Refs: support.google.com/google-ads/editor/answer/57747 ("Enter Campaign
// negative to specify a campaign-level negative"), .../47635 (match-type text).

export type MatchType = "broad" | "phrase" | "exact";

/** Header row for the new-keywords file — positive keywords at ad-group level. */
export const KEYWORD_CSV_HEADERS = ["Campaign", "Ad Group", "Keyword", "Criterion Type"];

/** Header row for the negatives file — campaign-level only, so no Ad Group column. */
export const NEGATIVE_CSV_HEADERS = ["Campaign", "Keyword", "Criterion Type"];

/** Criterion Type value that marks a row as a campaign-level negative keyword. */
export const CAMPAIGN_NEGATIVE = "Campaign negative";

const LABEL: Record<MatchType, string> = { broad: "Broad", phrase: "Phrase", exact: "Exact" };

/** Editor Criterion Type value for a positive keyword — "Broad"/"Phrase"/"Exact". */
export function matchTypeLabel(mt: string): string {
  return LABEL[mt.trim().toLowerCase() as MatchType] ?? "Broad";
}

/**
 * Strip the paste-ready formatting (`[exact]`, `"phrase"`) back to the bare
 * keyword text, so the Keyword column pairs cleanly with a Broad/Phrase/Exact
 * Criterion Type. Broad is already bare. Keyed on match_type so we never strip
 * legitimate brackets/quotes from a broad term.
 */
export function bareKeyword(formatted: string, mt: string): string {
  const t = (formatted ?? "").trim();
  const m = mt.trim().toLowerCase();
  if (m === "exact" && t.startsWith("[") && t.endsWith("]")) return t.slice(1, -1).trim();
  if (m === "phrase" && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).trim();
  return t;
}

/** RFC-4180 field quoting: wrap on comma/quote/newline, escape quotes by doubling. */
function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Serialize a header row + data rows into a CSV string (CRLF line endings). */
export function serializeCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n");
}

/** Trigger a browser download of `csv` as `filename`. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Filename-safe slug from an account name (falls back to "account"). */
export function slug(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "account";
}
