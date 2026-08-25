import PDFParser from "pdf2json";

function extractTextFromPdf(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser();
    
    pdfParser.on("pdfParser_dataError", (errData: any) => {
      reject(new Error(errData.parserError));
    });
    
    pdfParser.on("pdfParser_dataReady", (pdfData: any) => {
      let text = "";
      if (pdfData.Pages) {
        for (const page of pdfData.Pages) {
          if (page.Texts) {
            for (const textItem of page.Texts) {
              if (textItem.R) {
                for (const r of textItem.R) {
                  if (r.T) {
                    try {
                      text += decodeURIComponent(r.T) + " ";
                    } catch (e) {
                      text += r.T.replace(/%/g, ' ') + " ";
                    }
                  }
                }
              }
            }
          }
          text += "\n";
        }
      }
      resolve(text);
    });
    
    pdfParser.parseBuffer(buffer);
  });
}

function normalizeType3Text(text: string): string {
  let result = text;
  result = result.replace(/(?:^|\s)([A-Z]\s){3,}/gm, ' ');
  result = result.replace(/\b([A-Z])\s+([a-z]{2,})/g, '$1$2');
  result = result.replace(/\b([a-z]{2,})\s+([a-z])\b/g, '$1$2');
  result = result.replace(/\b(1)\s+(\d{2}(?:\.\d+)?)\b/g, (match, d1, d2, offset) => {
    const before = result.substring(Math.max(0, offset - 15), offset);
    if (/[\$,]/.test(before)) return match;
    const after = result.substring(offset + match.length, offset + match.length + 5);
    if (/^\d/.test(after)) return match;
    const combined = d1 + d2;
    const num = parseFloat(combined);
    if (!isNaN(num) && num < 10000) return combined;
    return match;
  });
  result = result.replace(/\s*[▲▼]\s*/g, ' ');
  result = result.replace(/\s*<\s*>\s*/g, ' ');
  result = result.replace(/\d+\s*-\s*\d+\s*\/\s*\d+/g, ' ');
  result = result.replace(/arrow_drop_down/g, '');
  result = result.replace(/\s{2,}/g, ' ');
  return result.trim();
}

function normalizeLocationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeFullAddress(name: string): boolean {
  return /\d{2,}\s+\w/.test(name) || /\b\d{5}\b/.test(name) || name.split(/\s+/).length > 7;
}

function fuzzyLocationMatch(name1: string, name2: string): boolean {
  const n1 = normalizeLocationName(name1);
  const n2 = normalizeLocationName(name2);
  if (n1 === n2) return true;
  const shorter = n1.length <= n2.length ? n1 : n2;
  const longer = n1.length <= n2.length ? n2 : n1;
  if (shorter.length >= 6 && longer.includes(shorter) && shorter.length / longer.length >= 0.7) return true;
  if (n1.length >= 6 && n2.length >= 6) {
    const distance = levenshteinDistance(n1, n2);
    const maxLen = Math.max(n1.length, n2.length);
    if (distance <= Math.max(2, Math.floor(maxLen * 0.2))) return true;
  }
  return false;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export type FieldConfidence = "high" | "medium" | "low" | "none";

export interface ParsedField<T> {
  value: T;
  confidence: FieldConfidence;
  source?: string;
}

/**
 * Reusable normalization for extracted section bodies before placeholder
 * detection. Folds whitespace, normalizes various Unicode dash characters
 * down to a plain hyphen, and trims.
 *
 * NOTE: This intentionally does not change letter casing — callers that
 * need a case-insensitive comparison should lowercase explicitly. Keeping
 * the original casing here lets callers preserve real values when the
 * body turns out to be content.
 */
export function normalizeExtractedSectionText(text: string | null | undefined): string {
  if (text == null) return "";
  return String(text)
    // Hyphen / dash variants (figure dash, en/em dash, horizontal bar, minus)
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    // Non-breaking spaces / bullets that some PDFs sprinkle in
    .replace(/[\u00A0\u2022]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fold letter-spaced PDF artifacts like "N a m e   C l e a n ( 1 )" →
 * "NameClean( 1 )". Conservative: collapses runs of single letters separated
 * by single whitespace characters into one word; normal prose is unchanged.
 * (Hoisted from isAiRewrittenMissingDataSourceFinding so the raw placeholder
 * gate can reuse the exact same folding — Task #3769.)
 */
function collapseSpacedLetters(s: string): string {
  return s.replace(/(?:\b[A-Za-z]\s){2,}[A-Za-z]\b/g, (m) => m.replace(/\s+/g, ""));
}
/**
 * True if the section body is empty after subtracting the known
 * "missing data source" placeholder family. Handles line breaks,
 * extra spaces, em-dash vs hyphen, casing, and the placeholder text
 * being split across lines.
 *
 * Task #3769 — also subtracts a trailing "Name_Clean (N): <client>" source
 * artifact (underscored / spaced / collapsed / letter-spaced) so the raw
 * Looker placeholder with its source-name tail still counts as placeholder-
 * only. The tail strip happens BEFORE punctuation removal so its "no
 * sentence punctuation in the tail" guard keeps real trailing findings safe.
 */
export function isMissingDataSourcePlaceholder(text: string | null | undefined): boolean {
  const preNormalized = normalizeExtractedSectionText(text).toLowerCase();
  if (!preNormalized) return false;

  const normalized = stripNameCleanArtifactTail(preNormalized)
    .replace(/[.,;:!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;

  const phrases = [
    "missing data source",
    "there is no data source associated with this component",
    "see details",
  ];

  let stripped = normalized;
  for (const phrase of phrases) {
    stripped = stripped.split(phrase).join(" ");
  }
  // Anything left should be only whitespace, dashes, or stray separators
  // (e.g. " - " between phrase chunks).
  stripped = stripped.replace(/[-\s]+/g, "").trim();
  return stripped === "";
}

/**
 * Task #1267 — Detector for the AI-rewritten "Missing data source" finding.
 *
 * Background:
 *   Task #830 stopped the PDF parser from writing the literal "Missing data
 *   source - There is no data source associated with this component. See
 *   details" placeholder into report_sections.data.commonIssues. Task #831
 *   cleared rows whose stored value was the literal placeholder. A follow-up
 *   production survey found a second class: rows where a downstream AI pass
 *   (`POST /api/ai/format-issues`) rewrote the placeholder into one or more
 *   structured "🔴 **Issue:** Missing data source. … ➡️ **Strategic Fix:** …"
 *   blocks (sometimes stacked, sometimes with a trailing letter-spaced
 *   PDF artifact tail like "N a m e   C l e a n ( 1 ) : …"). These are still
 *   spurious findings derived from the same placeholder and should be cleared.
 *
 * Returns true when EVERY 🔴 block in the input is the AI-rewritten
 * placeholder finding (and any remaining text outside those blocks is just
 * separators, whitespace, or a recognised PDF letter-spacing artifact tail).
 * Rows that mix in genuinely different findings return false and are left
 * untouched.
 *
 * Task #3901 — extended to the junk-fed fabricated class: when the broken
 * Looker component's capture swallowed trailing dashboard text ("Registrants
 * 0 Attended No data … Google Ads Spend $6,430.99 …"), the AI formatter
 * fabricated additional plausible-looking 🔴 blocks FROM that junk (e.g.
 * "Registrants count missing", "Delayed data updates"). A value whose first
 * substantive block is the missing-data-source finding and whose remaining
 * blocks are all placeholder-derived or junk-fabricated is placeholder-
 * derived end to end. Any block with genuine operator content still returns
 * false (this predicate gates destructive cleanup and serve-time
 * suppression, so false negatives stay the safe direction).
 */

/**
 * Task #3901 — dashboard component labels that trail the Common Issues
 * components in the source Looker PDF layout (verified against production
 * webhook_import_logs raw text). Used to recognise 🔴 blocks the AI
 * fabricated from swallowed dashboard junk — only in combination with
 * JUNK_DATA_ABSENCE_RE, so a real finding that merely mentions e.g. "missed
 * call follow-ups" is never matched by the label alone.
 */
const JUNK_COMPONENT_LABEL_RE = new RegExp(
  [
    String.raw`\bregistrants?\b`,
    String.raw`\battend(?:ed|ance)\b`,
    String.raw`\bshow\s+rate\b`,
    String.raw`\bmissed\s+calls?\b`,
    String.raw`\bblog\s+post\s+url\b`,
    String.raw`\bgbp\b`,
    String.raw`\bwebinar\b`,
    String.raw`\breviews?\b`,
    String.raw`\breiews\b`, // the source dashboard's own "Reiews Responded" typo
    String.raw`\bposts?\s*\/?\s*q\s*&?\s*a\b`,
    String.raw`\bgoogle\s+ads\b`,
    String.raw`\bpaid\s+ads\b`,
    String.raw`\blsa\s+leads?\b`,
    String.raw`\b(?:avg\.?|average)\s+time\s+to\s+answer\b`,
    String.raw`\bnot\s+quotable\b`,
    String.raw`\bhot\s+transfers?\b`,
    String.raw`\bsee\s+details\b`,
    String.raw`\bdata\s+set\b`,
    String.raw`\bdata\s+studio\b`,
    String.raw`\bocr\b`,
  ].join("|"),
  "i",
);

/**
 * Task #3901 — "the metric is absent/broken" phrasing the AI used when
 * fabricating findings from dashboard junk labels. Deliberately narrow verb
 * forms so real coaching prose ("reps are not asking for reviews") never
 * matches.
 */
const JUNK_DATA_ABSENCE_RE = new RegExp(
  [
    String.raw`\bmissing\b`,
    String.raw`\bno\s+data\b`,
    String.raw`\bzero\b`,
    String.raw`\bincomplete\b`,
    String.raw`\bdisconnected\b`,
    String.raw`\bambiguous\b`,
    String.raw`\bmalformed\b`,
    String.raw`\bbroken\b`,
    String.raw`\bplaceholders?\b`,
    String.raw`\bartifacts?\b`,
    String.raw`\bconfiguration\s+error\b`,
    String.raw`\bcannot\s+connect\b`,
    String.raw`\bunknown\b`,
    String.raw`\bnot\s+(?:fully\s+)?(?:populated|populating|reflected|verified|recorded|tracked|connected|displaying|rendering)\b`,
    String.raw`\b(?:shows?|showing|reporting|reports?|appears?)\s+(?:as\s+)?(?:0|zero|blank|empty)\b`,
    String.raw`\braw\s+document\s+link\b`,
    String.raw`\bno\s+(?:leads?|reviews?|counts?)\s+(?:reported|recorded|populated|ingested|generated)\b`,
    String.raw`\b(?:leads?|reviews?|counts?)\s+0\b`,
    String.raw`\bwithout\s+(?:any\s+)?(?:context|detail|data|counts?|verification)\b`,
    String.raw`\bunlabeled\b`,
    String.raw`\bnot\s+available\b`,
    String.raw`\bunavailable\b`,
  ].join("|"),
  "i",
);

/**
 * Task #3901 — generic data-plumbing hallucinations the AI fabricated when
 * the junk gave it nothing concrete (observed verbatim across the 2026-03
 * production rows): "Incomplete data entries", "Delayed data updates",
 * "Inconsistent reporting formats", "Lack of user training", … These are
 * phrase-level patterns, never bare words, so real findings that merely say
 * "data" or "reporting" somewhere do not match.
 */
const FABRICATED_DATA_PLUMBING_RE = new RegExp(
  [
    String.raw`\bdata\s+(?:entry|entries|updates?|update\s+delays?|reporting|formats?|quality|accuracy|integrity|discrepanc\w+|duplication|inconsistenc\w+|visualization|connectivity|collection|management|analysis|analytics|tools?|systems?|sources?|sets?|flow|feeds?|pipelines?|sync\w*)\b`,
    String.raw`\b(?:incomplete|inconsistent|inaccurate|outdated|delayed|duplicate[ds]?|poor|unreliable)\s+(?:\S+\s+){0,2}?(?:data|reporting|records?|entries|figures|metrics|software|formats?)\b`,
    String.raw`\boutdated\s+(?:information|software|systems?)\b`,
    String.raw`\buser\s+(?:training|engagement\s+metrics|access)\b`,
    String.raw`\btraining\s+on\s+data\b`,
    String.raw`\black\s+of\s+(?:data|training|user|visibility\s+into\s+data)\b`,
    String.raw`\baccess\s+(?:restrictions?|issues?)\b`,
    String.raw`\bsystem\s+performance\b`,
    String.raw`\bengagement\s+metrics\b`,
    String.raw`\breporting\s+(?:formats?|delays?|errors?)\b`,
    String.raw`\bmanual\s+data\b`,
  ].join("|"),
  "i",
);

/**
 * Task #3901 — vocabulary that marks a sentence as data-source-remediation
 * boilerplate (used for the residue of blocks carrying a mid-text
 * "Name_Clean (N): <client>" marker). A residual sentence with none of
 * these is treated as genuine operator prose and protects the whole value.
 */
const PLUMBING_SEGMENT_RE =
  /(?:data|source|component|connect|link|associat|verif|validat|populat|restor|recreat|studio|dashboard|deploy|integrat|configur|missing|placeholder)/i;

/** Mid-text "Name_Clean (N): <name>" marker with a BOUNDED payload (≤4
 * name tokens, stopping at any sentence punctuation) — strips the artifact
 * without ever swallowing a following operator sentence. */
const NAME_CLEAN_MIDTEXT_MARKER_RE =
  /name[\s_]*clean[\s…]*\(\s*\d+\s*\)\s*:?\s*(?:[^\s.!?,;:()]+(?:\s+[^\s.!?,;:()]+){0,3})?/gi;

function nameCleanResidualIsPlumbing(lowerBlock: string): boolean {
  const residual = lowerBlock
    .replace(NAME_CLEAN_MIDTEXT_MARKER_RE, " ")
    .replace(/missing\s+data\s+source/g, " ")
    .replace(/there\s+is\s+no\s+data\s+source\s+associated\s+with\s+this\s+component/g, " ")
    .replace(/no\s+data\s+source\s+associated\s+with\s+this\s+component/g, " ")
    .replace(/see\s+details/g, " ")
    .replace(/(?:issue|impact|strategic\s*fix)\s*:/g, " ")
    .replace(/[*_`>↳]+/g, " ")
    .replace(/➡️|➡/g, " ");
  const segments = residual
    .split(/[.!?;()]+/)
    .map((s) => s.replace(/[-–—]+/g, " ").trim())
    .filter((s) => s.split(/\s+/).filter(Boolean).length >= 3);
  return segments.every((s) => PLUMBING_SEGMENT_RE.test(s));
}

type FindingBlockClass = "degenerate" | "placeholder" | "fabricated_junk" | "real";

/** A 🔴 block with no alphanumeric substance once markdown scaffolding and
 * the Issue/Impact/Strategic Fix labels are stripped (e.g. the literal
 * `🔴 **Issue:** 🔴 **` shapes stored for Dellutri/Wagner 2026-03). */
function isDegenerateFindingBlock(block: string): boolean {
  const substance = block
    .replace(/-{3,}/g, " ")
    .replace(/(?:issue|impact|strategic\s*fix)\s*:/gi, " ")
    .replace(/➡️|➡/g, " ")
    .replace(/[*_`>↳\-–—\s]+/g, "");
  return !/[a-z0-9]/i.test(substance);
}

function classifyFindingBlock(block: string): FindingBlockClass {
  if (isDegenerateFindingBlock(block)) return "degenerate";
  const lower = block.toLowerCase();
  const mentionsPlaceholder =
    lower.includes("missing data source") ||
    lower.includes("no data source associated with this component") ||
    /data\s+studio\s+cannot\s+connect/i.test(lower);
  const fabricated =
    (JUNK_COMPONENT_LABEL_RE.test(lower) && JUNK_DATA_ABSENCE_RE.test(lower)) ||
    FABRICATED_DATA_PLUMBING_RE.test(lower);
  // A surviving mid-text "Name_Clean (N)" marker: acceptable only when the
  // block is otherwise placeholder/junk AND everything around the marker is
  // data-source-remediation boilerplate. Any real residual sentence makes
  // the block (and thus the whole value) genuine mixed content.
  if (/(?:^|[\s_(>*:])name[\s_]*clean[\s…]*\(\s*\d+\s*\)/i.test(block)) {
    if ((mentionsPlaceholder || fabricated) && nameCleanResidualIsPlumbing(lower)) {
      return mentionsPlaceholder ? "placeholder" : "fabricated_junk";
    }
    return "real";
  }
  if (mentionsPlaceholder) return "placeholder";
  if (fabricated) return "fabricated_junk";
  return "real";
}

/** How an AI-rewritten placeholder-derived value was recognised (Task #3901
 * — surfaced separately by the cleanup action's per-kind counts). */
export type AiRewrittenMissingDataSourceClass =
  | "placeholder_only"
  | "junk_fabricated";

/**
 * Classifying core behind isAiRewrittenMissingDataSourceFinding: returns
 * which class the value falls into, or null when it is not placeholder-
 * derived (genuine or mixed content).
 */
export function classifyAiRewrittenMissingDataSourceFinding(
  text: string | null | undefined,
): AiRewrittenMissingDataSourceClass | null {
  if (text == null) return null;
  const raw = String(text);
  if (!raw.trim()) return null;

  // Fold letter-spaced PDF artifacts like "N a m e   C l e a n ( 1 )" → "NameClean(1)"
  // before we look for issue blocks (shared module-level helper — collapses
  // runs of single letters separated by single spaces into a single word,
  // preserving normal prose unchanged).
  const folded = collapseSpacedLetters(raw);

  // Strip a trailing letter-spacing-derived parser artifact like
  // "NameClean(1): …" or "NameClean (1): …" at the end of the field. This
  // tail is itself a PDF extraction artifact, never a real finding.
  // Task #3769 — also accept the underscored ("Name_Clean") and spaced
  // ("Name Clean") spellings seen in stored AI-rewritten rows, with the
  // colon optional. The tail after the marker is BOUNDED exactly like
  // NAME_CLEAN_ARTIFACT_TAIL_RE (≤10 words, no sentence punctuation apart
  // from one optional trailing period) so a real operator sentence written
  // after the artifact is never swallowed into "placeholder-only".
  const withoutArtifactTail = folded.replace(
    /(?:^|\s)Name[\s_]*Clean[\s…]*\(\s*\d+\s*\)\s*:?\s*(?:[^\s.!?]+(?:\s+[^\s.!?]+){0,9})?\.?\s*$/i,
    "",
  );

  // Split on the red-circle marker that the AI prompt prefixes to every
  // issue. The first chunk is anything before the first 🔴 (usually empty).
  const parts = withoutArtifactTail.split("🔴");
  const prefix = (parts[0] || "")
    .replace(/[-\s>*_`]+/g, "")
    .trim();
  // If there is meaningful text before the first 🔴 block, don't treat the
  // whole field as the AI-rewritten placeholder.
  if (prefix.length > 0) return null;

  const blocks = parts.slice(1);
  if (blocks.length === 0) return null;

  const classes = blocks
    .map(classifyFindingBlock)
    .filter((c) => c !== "degenerate");
  if (classes.length === 0) return null;
  // The FIRST substantive block must be the missing-data-source finding
  // itself — fabricated-junk vocabulary alone never condemns a value.
  if (classes[0] !== "placeholder") return null;
  if (classes.some((c) => c === "real")) return null;
  return classes.every((c) => c === "placeholder")
    ? "placeholder_only"
    : "junk_fabricated";
}

export function isAiRewrittenMissingDataSourceFinding(
  text: string | null | undefined,
): boolean {
  return classifyAiRewrittenMissingDataSourceFinding(text) !== null;
}

/**
 * Task #3901 — detector for the junk-tailed RAW literal class: the stored
 * value starts with the literal placeholder text and everything after it is
 * only swallowed dashboard junk (component labels, numbers/currency,
 * "No data", "See details" runs, Name_Clean artifacts). No 🔴 blocks — this
 * is the shape stored when the poisoned capture skipped the AI formatter.
 * A single word of real prose in the tail keeps the value untouched.
 */
const DASHBOARD_JUNK_WORDS = new Set(
  (
    "see details no data registrants attended attendance show rate missed call calls " +
    "blog post url gbp locations location leads lead reviews reiews review webinar webinars " +
    "other list responded posts q a count google ads spend paid lsa avg average time to " +
    "answer sec not quotable hot transfers ht schedules schedule set configuration error " +
    "studio cannot connect your good name clean client total platform quality generation"
  ).split(/\s+/),
);

export function isJunkTailedLiteralPlaceholder(
  text: string | null | undefined,
): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  if (text.includes("🔴")) return false;
  const collapsed = collapseSpacedLetters(normalizeExtractedSectionText(text))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const lead = collapsed.match(MISSING_DATA_SOURCE_LEAD_RE);
  if (!lead) return false;
  const rest = collapsed
    .slice(lead[0].length)
    .replace(NAME_CLEAN_MIDTEXT_MARKER_RE, " ")
    .replace(/\$[\d,]+(?:\.\d+)?/g, " ")
    .replace(/\b\d+(?:[.,]\d+)?%?\b/g, " ")
    .replace(/[().,;:!?/&|×xX*_`↳>–—-]+/g, " ");
  const words = rest.split(/\s+/).filter(Boolean);
  return words.every((w) => DASHBOARD_JUNK_WORDS.has(w));
}

/**
 * True when an extracted section body should be treated as having no real
 * content: missing, blank, whitespace-only, or one of the known
 * "missing data source" placeholder variants.
 */
export function isEmptySectionBody(text: string | null | undefined): boolean {
  if (text == null) return true;
  const normalized = normalizeExtractedSectionText(text);
  if (!normalized) return true;
  // Body is just dashes/separators with no words → empty.
  const stripped = normalized.replace(/[-\s]+/g, "").trim();
  if (stripped === "") return true;
  // Task #3769 — a body that is ONLY the "Name_Clean (N): <client>" source
  // artifact (no placeholder phrases around it) is still an extraction
  // artifact, never real content.
  const artifactStripped = stripNameCleanArtifactTail(normalized.toLowerCase())
    .replace(/[-\s]+/g, "")
    .trim();
  if (artifactStripped === "") return true;
  return isMissingDataSourcePlaceholder(text);
}

/**
 * Task #3901 — the placeholder LEAD: "Missing data source" immediately
 * followed by "There is no data source associated with this component"
 * (dash/period/whitespace variants; `\s*` between words also matches the
 * fully-collapsed letter-spaced form). Anchored at the start.
 */
const MISSING_DATA_SOURCE_LEAD_RE =
  /^missing\s*data\s*source[\s.,;:!?–—-]*there\s*is\s*no\s*data\s*source\s*associated\s*with\s*this\s*component\b/i;

/**
 * Task #3901 — true when a captured section body BEGINS with the
 * missing-data-source placeholder family, regardless of what trailing
 * dashboard junk follows. Safe as an import-time emptiness signal: the
 * placeholder lead is machine-generated by Looker for a broken component —
 * operators never author findings that open with it — so anything after it
 * is swallowed neighbouring-component text, not real content.
 */
export function startsWithMissingDataSourcePlaceholder(
  text: string | null | undefined,
): boolean {
  const collapsed = collapseSpacedLetters(normalizeExtractedSectionText(text))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return false;
  return MISSING_DATA_SOURCE_LEAD_RE.test(collapsed);
}

/**
 * Task #3901 — body-level predicate for "this Common Issues body is empty or
 * derived from the missing-data-source placeholder": blank/artifact-only,
 * the literal placeholder family, the AI-rewritten finding classes
 * (placeholder-only or junk-fabricated), or the junk-tailed raw literal.
 * Shared by the AI formatter guards, the reformat backfill, and (via
 * isPlaceholderOnlyCommonIssues) the serve-time suppressor + cleanup so the
 * call sites can never drift.
 */
export function isMissingDataSourceDerivedBody(
  text: string | null | undefined,
): boolean {
  return (
    isEmptySectionBody(text) ||
    isAiRewrittenMissingDataSourceFinding(text) ||
    isJunkTailedLiteralPlaceholder(text)
  );
}

/**
 * Task #3769 — single predicate for "this stored Common Issues value is
 * placeholder-only": the literal "missing data source" placeholder family
 * (with or without a trailing "Name_Clean (N): <client>" artifact), a
 * blank/dashes-only body, or the AI-rewritten placeholder finding (Task
 * #3901: including the junk-fabricated multi-block class and the
 * junk-tailed raw literal). Shared by the serve-time suppressor
 * (buildReportResponse), the cleanup script, and the CEO production action
 * so the three can never drift.
 *
 * Empty / absent / non-string values return false — there is nothing stored
 * to suppress or clear.
 */
export function isPlaceholderOnlyCommonIssues(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  return isMissingDataSourceDerivedBody(value);
}
export interface ExtractedCommonIssues {
  value: string;
  isEmpty: boolean;
  /** Why the body was treated as empty — surfaced to operators. */
  emptyReason?: "no_section_match" | "blank_body" | "missing_data_source_placeholder";
  /** Confidence + source for the field_confidence map. */
  confidence: { confidence: FieldConfidence; source: string };
}

/**
 * Task #3901 — value-anchored dashboard component-label runs that mark the
 * END of a Common Issues body when the source component is broken and the
 * capture would otherwise run into neighbouring dashboard components
 * (verified against production webhook_import_logs raw text). Each label is
 * anchored to its rendered VALUE (a digit or "No data") or is a phrase that
 * never occurs in findings prose, so real sentences like "missed call
 * follow-ups are slow" can never terminate a genuine body.
 */
const TRAILING_COMPONENT_LABEL_RUN_SRC = [
  String.raw`See\s+details\s+See\s+details`,
  String.raw`Registrants\s+(?:\d|No\s+data)`,
  String.raw`Attended\s+(?:\d|No\s+data)`,
  String.raw`Show\s+Rate\s+(?:[\d.]+%?|No\s+data)`,
  String.raw`Missed\s+Calls?\s+(?:\d|No\s+data)`,
  String.raw`Blog\s+Post\s+URL`,
  String.raw`GBP\s+Locations?\s+(?:Leads|Reviews)`,
  String.raw`Google\s+Ads\s+Spend`,
  String.raw`LSA\s+Leads`,
  String.raw`Data\s+Set\s+Configuration\s+Error`,
  String.raw`Not\s+Quotable\s+(?:\d|No\s+data)`,
  String.raw`Avg\.?\s+Time\s+to\s+Answer`,
  // Trailing source-name artifact in its underscored / collapsed /
  // letter-spaced spellings (never plain "name clean", which could occur in
  // prose), and the Total-Leads stat tile (already a sales terminator; the
  // Integrity Law 2026-07 layout renders it after the INTAKE body too).
  String.raw`Name_Clean|NameClean\s*[…(]|N\s+a\s+m\s+e\s+[_\s]*C\s+l\s+e\s+a\s+n`,
  String.raw`Total\s*Leads\s+\d`,
].join("|");

// Intake stops at the Sales headings (as before) and additionally at any
// trailing component-label run; Sales stops at the client table markers (as
// before), at the INTAKE heading (so a re-ordered layout can never swallow
// the intake section into the sales capture — the "Intake duplicated into
// Sales" symptom), and at the component-label runs.
const INTAKE_COMMON_ISSUES_BODY_RE = new RegExp(
  String.raw`Intake\s*Common\s*Issues\s+([\s\S]*?)(?=Sales\s*Common\s*Issues|Sales\s*Cases|${TRAILING_COMPONENT_LABEL_RUN_SRC}|$)`,
  "i",
);
const SALES_COMMON_ISSUES_BODY_RE = new RegExp(
  String.raw`Sales\s*Common\s*Issues\s+([\s\S]*?)(?=C\s+l\s+i\s+e\s+n\s+t|Client\s*\(|Total\s*Leads\s+\d|Intake\s*Common\s*Issues|${TRAILING_COMPONENT_LABEL_RUN_SRC}|$)`,
  "i",
);

/**
 * Extracts the body of an Intake or Sales Common Issues section from the
 * already-normalized full text. Returns a structured result so callers
 * (parser + tests) can distinguish "real content" from placeholder/empty.
 *
 * Real body content is preserved verbatim (after collapsing whitespace).
 * Placeholder-only or whitespace-only bodies surface a `none` confidence
 * with a human-readable reason.
 */
export function extractCommonIssuesFromText(
  fullText: string,
  kind: "intake" | "sales",
): ExtractedCommonIssues {
  const sectionLabel = kind === "intake" ? "Intake Common Issues" : "Sales Common Issues";
  const re = kind === "intake" ? INTAKE_COMMON_ISSUES_BODY_RE : SALES_COMMON_ISSUES_BODY_RE;

  const match = fullText.match(re);
  if (!match) {
    return {
      value: "",
      isEmpty: true,
      emptyReason: "no_section_match",
      confidence: { confidence: "none", source: `empty: ${sectionLabel} section not found` },
    };
  }

  const rawBody = match[1] || "";
  const normalizedBody = normalizeExtractedSectionText(rawBody);

  if (isMissingDataSourcePlaceholder(rawBody)) {
    return {
      value: "",
      isEmpty: true,
      emptyReason: "missing_data_source_placeholder",
      confidence: { confidence: "none", source: "empty: missing data source placeholder" },
    };
  }

  // Task #3901 — a body that BEGINS with the placeholder is placeholder-fed
  // no matter what trailing dashboard junk the capture swallowed. Without
  // this, a broken component whose capture ran past the section (e.g. into
  // "Registrants 0 Attended No data … Google Ads Spend $6,430.99") stored
  // the junk at high confidence and the AI formatter fabricated findings
  // from it (Wanta Thome 2026-07).
  if (startsWithMissingDataSourcePlaceholder(rawBody)) {
    return {
      value: "",
      isEmpty: true,
      emptyReason: "missing_data_source_placeholder",
      confidence: { confidence: "none", source: "empty: missing data source placeholder" },
    };
  }

  if (isEmptySectionBody(rawBody)) {
    return {
      value: "",
      isEmpty: true,
      emptyReason: "blank_body",
      confidence: { confidence: "none", source: `empty: ${sectionLabel} body was blank` },
    };
  }

  return {
    value: normalizedBody,
    isEmpty: false,
    confidence: { confidence: "high", source: `${sectionLabel} section` },
  };
}

/**
 * Re-import write rule for Common Issues fields:
 *   existing has any string + parsed empty   → preserve existing value as-is
 *   existing empty/missing  + parsed empty   → remain empty
 *   new report              + parsed empty   → initialize as empty string
 *   any                     + parsed real    → use parsed
 *
 * IMPORTANT: even when the existing value is itself a "missing data source"
 * placeholder, a parsed empty re-import must NOT clear it. Cleaning up bad
 * historical values is handled exclusively by the explicit data correction
 * step (see scripts/clear-grace-legal-sales-common-issues.ts and follow-up
 * cleanup work). A parsed empty body is never treated as proof that the
 * existing stored value should be replaced.
 */
export function resolveCommonIssuesOnReimport(
  parsedValue: string | null | undefined,
  existingValue: string | null | undefined,
): string {
  const parsedEmpty = isEmptySectionBody(parsedValue);
  if (!parsedEmpty) {
    return normalizeExtractedSectionText(parsedValue);
  }
  // parsed is empty/placeholder — preserve any existing non-empty string,
  // including placeholder text (cleanup is a separate explicit step).
  if (typeof existingValue === "string" && existingValue.length > 0) {
    return existingValue;
  }
  return "";
}

export interface ParsedReportData {
  clientName?: string;
  reportMonth?: string;
  intake: {
    totalConsults: number;
    missedCallRate: number;
    avgTimeToAnswer: number;
    qualityScore: number;
    commonIssues: string;
  };
  sales: {
    totalCases: number;
    averageCaseValue: number;
    noShowRate: number;
    avgFollowUps: number;
    qualityScore: number;
    commonIssues: string;
    revenue: number;
    dealTouchDensity: number;
    avgAgeOpenMatters: number;
    pipelineMomentumScore: number;
  };
  marketing: {
    totalLeads: number;
    leadQuality: {
      good: number;
      notQuotable: number;
      missedCalls: number;
      noData: number;
    };
    gbpLocations: Array<{
      name: string;
      uniqueLeads: number;
      reviewsGenerated: number;
      reviewsRespondedTo: number;
      postsQaCount: number;
      leadQuality: {
        good: number;
        notQuotable: number;
        missedCalls: number;
        noData: number;
      };
    }>;
    googleAds: {
      uniqueLeads: number;
      adSpend: number;
      leadQuality: {
        good: number;
        notQuotable: number;
        missedCalls: number;
        noData: number;
      };
    };
    lsa: {
      uniqueLeads: number;
      adSpend: number;
      leadQuality: {
        good: number;
        notQuotable: number;
        missedCalls: number;
        noData: number;
      };
    };
    webinar: {
      registrants: number;
      attendees: number;
      leads: number;
      showRate: number;
      htScheduleRate: number;
      hotTransfers: number;
      leadQuality: { good: number; notQuotable: number; missedCalls: number; noData: number };
    };
    reviewGeneration: {
      listContacted: number;
      listReviews: number;
      webinarReviews: number;
      otherCount: number;
      totalReviews: number;
    };
    otherLeads: {
      socialMedia: number;
      directCalls: number;
      referrals: number;
      total: number;
      leadQuality: { good: number; notQuotable: number; missedCalls: number; noData: number };
    };
    blogPostUrl?: string;
  };
  fieldConfidence: Record<string, { confidence: FieldConfidence; source: string; }>;
}

function parseNumber(text: string): number {
  if (!text) return 0;
  const cleaned = text.replace(/[$,%K]/gi, "").replace(/,/g, "").trim();
  let num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  if (text.toLowerCase().includes("k")) {
    num *= 1000;
  }
  return Math.round(num * 100) / 100;
}

// ===========================================================================
// Task #2555 — split-digit-safe numeric capture
//
// PDF text extractors frequently render a multi-digit number such as `11` as
// two space-separated tokens (`1 1`). A naive `(\d+)` capture then stores only
// the first digit (`1`). The fix is to capture the whole digit-token run
// (digits + intra-number spaces) and strip the internal spaces before
// `parseNumber`. The capture spans only `[\d\s]`, so it naturally halts at the
// next label (letters) or a symbol such as `$` / `%`, which keeps genuinely
// separate, label-delimited numbers apart.
//
// These helpers centralize that logic so every numeric extraction site uses
// the same, regression-pinned technique instead of inlining ad-hoc regex
// tweaks. They mirror the already-proven idiom used by the robust top-line
// Total Leads / Consults / Cases capture: `(\d[\d\s]*\d|\d+)` + `.replace(/\s/g,'')`.
// ===========================================================================

/**
 * Regex source fragment matching a single integer that may have been split
 * into space-separated digit tokens by a PDF extractor (e.g. `11` → `1 1`).
 * Use it inside a capturing group in a larger pattern and feed the captured
 * group to {@link reassembleSplitDigits}.
 */
const SPLIT_DIGIT_INT_SOURCE = String.raw`\d[\d\s]*\d|\d+`;

/**
 * Regex source fragment matching a single decimal whose INTEGER part may have
 * been split into space-separated digit tokens (e.g. `11.5` → `1 1.5`). The
 * fractional part is never split because the `.` blocks the extractor's
 * tokenizer. Feed the captured group to {@link reassembleSplitDigits}.
 */
const SPLIT_DIGIT_DECIMAL_SOURCE = String.raw`\d[\d\s]*\d(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+`;

/**
 * Given text captured by {@link SPLIT_DIGIT_INT_SOURCE} /
 * {@link SPLIT_DIGIT_DECIMAL_SOURCE} (or any digit-token run that may contain
 * intra-number spaces), strip the internal spaces and return the intended
 * number.
 *
 * @returns `{ value, reassembled }` where `reassembled` is true when at least
 *   one internal space was removed — i.e. the value WOULD have been corrupted
 *   by a naive `(\d+)`/`([\d.]+)` capture. Callers use the flag to annotate the
 *   field's confidence/source so operators can audit reassembled values.
 */
export function reassembleSplitDigits(
  captured: string | null | undefined,
): { value: number; reassembled: boolean } {
  const raw = (captured ?? "").trim();
  const reassembled = /\d\s+\d/.test(raw);
  return { value: parseNumber(raw.replace(/\s+/g, "")), reassembled };
}

/**
 * Thin wrapper for the common "label + count" single-field capture where the
 * count may be split into space-separated digit tokens.
 *
 * @param text          the haystack to search.
 * @param labelPattern  a regex SOURCE string for the label (e.g. `"Registrants"`
 *                      or `String.raw`Local\s*Service\s*Ads\s*Leads``).
 * @param opts.sep      separator source between label and number (default `\s+`).
 * @param opts.countSource  the count capture source (default integer; pass
 *                      {@link SPLIT_DIGIT_DECIMAL_SOURCE} for decimals).
 * @param opts.trailingGuard  appended after the capture group, e.g.
 *                      `String.raw`(?!\.\d)`` to avoid grabbing the integer part
 *                      of a following decimal rate.
 * @param opts.flags    regex flags (default `"i"`).
 * @returns `{ value, reassembled, raw }` or null when the label is not found.
 */
export function captureLabeledCount(
  text: string,
  labelPattern: string,
  opts: {
    sep?: string;
    countSource?: string;
    trailingGuard?: string;
    flags?: string;
  } = {},
): { value: number; reassembled: boolean; raw: string } | null {
  const sep = opts.sep ?? String.raw`\s+`;
  const countSource = opts.countSource ?? SPLIT_DIGIT_INT_SOURCE;
  const trailing = opts.trailingGuard ?? "";
  const re = new RegExp(
    `${labelPattern}${sep}(${countSource})${trailing}`,
    opts.flags ?? "i",
  );
  const m = text.match(re);
  if (!m) return null;
  const { value, reassembled } = reassembleSplitDigits(m[1]);
  return { value, reassembled, raw: m[1] };
}

/**
 * Cross-check a per-source lead count taken from the (split-digit-vulnerable)
 * spend section against the checksum-validated Platform Lead Quality total for
 * the same platform. When they disagree, the quality-table total is the more
 * trustworthy value (its breakdown sums to the total), so we adopt it and drop
 * confidence to "medium" with an audit note.
 *
 * @returns the value to store plus a confidence + human note suffix.
 */
export function crossCheckLeadCount(
  spendValue: number,
  qualityTotal: number | undefined,
): { value: number; confidence: FieldConfidence; note: string } {
  if (qualityTotal === undefined || qualityTotal === spendValue) {
    return { value: spendValue, confidence: "high", note: "" };
  }
  return {
    value: qualityTotal,
    confidence: "medium",
    note: ` (reconciled to Lead Quality total ${qualityTotal}; spend section read ${spendValue})`,
  };
}

/**
 * Task #2753 — decide whether a parsed "Total Leads" figure is trustworthy
 * against the per-source lead evidence, and compute the corrected total when
 * it is not.
 *
 * Background: the Task #2555 guardrail clamps any single source that exceeds
 * the parsed Total Leads (a split-digit misread inflates ONE source). But when
 * the parsed total itself is the misread value (e.g. "Total Leads 1" on a
 * report whose lead-quality tables clearly show ~595 platform leads), that
 * clamp crushes EVERY well-supported source down to the bad total.
 *
 * Discriminator: a genuine single-source overshoot leaves the REMAINING
 * sources fitting comfortably inside the total — so the total is unreliable
 * only when the per-source evidence EXCLUDING the single largest source still
 * exceeds the parsed total. In that case multiple independent sources
 * contradict the total, and the total (one number, one regex capture) is the
 * far more likely misread. Each GBP location counts as its own source so one
 * corrupted location can't flip the verdict.
 *
 * @param totalLeads   parsed Total Leads (0/negative → nothing to reconcile)
 * @param sourceCounts per-source lead counts (each GBP location separately,
 *                     Google Ads, LSA, Webinar)
 * @param otherLeads   parsed Other-leads total (added to the corrected total)
 * @returns unreliable=false to keep the parsed total (existing #2555 clamp
 *          still applies); unreliable=true with the recomputed total when the
 *          per-source evidence wins.
 */
export function reconcileTotalLeadsAgainstSources(
  totalLeads: number,
  sourceCounts: number[],
  otherLeads: number,
): { unreliable: boolean; correctedTotal: number; sourceSum: number; supportExcludingLargest: number } {
  const counts = sourceCounts.filter((n) => Number.isFinite(n) && n > 0);
  const sourceSum = counts.reduce((a, b) => a + b, 0);
  const largest = counts.length > 0 ? Math.max(...counts) : 0;
  const supportExcludingLargest = sourceSum - largest;
  const other = Number.isFinite(otherLeads) && otherLeads > 0 ? otherLeads : 0;
  const unreliable =
    totalLeads > 0 &&
    sourceSum > totalLeads &&
    supportExcludingLargest > totalLeads;
  return {
    unreliable,
    correctedTotal: unreliable ? sourceSum + other : totalLeads,
    sourceSum,
    supportExcludingLargest,
  };
}

/**
 * Attempt to recover a 5-column lead-quality row (`total good notQuotable
 * missedCalls noData`) whose digits a PDF extractor may have split into extra
 * tokens, by validating breakdown-sums-to-total. Given the raw integer tokens
 * (already split on whitespace) and the expected count of columns, it merges
 * adjacent tokens until either the column count and checksum are satisfied.
 *
 * Returns the reassembled integer array (length === `targetLen`) or null when
 * no merge satisfies the checksum. Shared by the new- and legacy-format
 * Platform Lead Quality tables so a split digit in either is corrected
 * identically.
 */
export function reassembleQualityRow(
  nums: number[],
  targetLen: number,
  expectedTotal?: number,
  depth = 0,
): number[] | null {
  if (depth > 8) return null;
  if (nums.length === targetLen && checksumOk(nums)) return nums;
  // Merging (which reduces token count) is the primary recovery for split digits.
  const merged = nums.length === targetLen ? null : tryMerge(nums, depth);
  if (merged) return merged;
  // Merge-based recovery exhausted. A count-PRESERVING smear ("11 28"
  // extracted as "1 128") or a token FUSION ("11 28" → "1128") keeps the
  // digit stream intact while moving digits across token boundaries — states
  // merging can never reach. At the top level only, attempt a
  // checksum-validated re-partition of the digit stream. It accepts an
  // unambiguous reading only, so it never guesses between plausible rows.
  if (depth === 0) return repartitionQualityRow(nums, targetLen, expectedTotal);
  return null;

  function checksumOk(arr: number[]): boolean {
    if (arr.length !== targetLen) return false;
    const total = arr[0];
    if (expectedTotal !== undefined && total !== expectedTotal) return false;
    const breakdown = arr.slice(1).reduce((a, b) => a + b, 0);
    return breakdown === total;
  }
  function tryMerge(arr: number[], d: number): number[] | null {
    for (let i = 0; i < arr.length - 1; i++) {
      const merged = [...arr];
      const combined = parseInt(String(arr[i]) + String(arr[i + 1]), 10);
      merged.splice(i, 2, combined);
      const res = reassembleQualityRow(merged, targetLen, expectedTotal, d + 1);
      if (res) return res;
    }
    return null;
  }
}

/**
 * Recover a quality row whose digit STREAM survived extraction but whose token
 * boundaries did not — the count-preserving smear class ("11 28" extracted as
 * "1 128"), token fusions ("11 28" → "1128"), and smeared totals ("56" →
 * "5 6"). Merging adjacent tokens cannot undo any of these, because merging
 * only ever concatenates whole tokens.
 *
 * Concatenates the digits of the first `take` tokens (take = targetLen, plus
 * up to two junk-tolerance extras — trailing fragments like the "2" that a
 * "28.21" score cell sheds under the decimal lookahead) and enumerates every
 * contiguous re-partition into exactly `targetLen` numbers, keeping those that
 * satisfy the row checksum (col0 === sum of the rest, plus the optional
 * `expectedTotal` pin). Parts with leading zeros are rejected ("05" is an
 * extraction artifact, not a count).
 *
 * Feedback #46 (2026-07 client report): "GBP 56 11 28 14 3" extracted as
 * "GBP 56 1 128 14 3" — 5 tokens, checksum 1+128+14+3 = 146 ≠ 56, merge-proof
 * — dropped the row and imported ALL 56 GBP leads as "No Data". The stream
 * "561128143" re-partitions uniquely back to [56, 11, 28, 14, 3].
 *
 * Returns the row ONLY when the reading is unambiguous: a single valid
 * partition, or a strict winner among several when ranked by how many
 * original token boundaries each preserves. Ties return null, and so does
 * cross-prefix ambiguity (valid readings arising at MORE THAN ONE
 * junk-tolerant prefix — the helper cannot know whether the extra token is
 * junk or row data). Fabricating a wrong breakdown into a client report is
 * worse than leaving the row unparsed.
 */
export function repartitionQualityRow(
  nums: number[],
  targetLen: number,
  expectedTotal?: number,
): number[] | null {
  const MAX_STREAM_DIGITS = 18;
  const MAX_PART_DIGITS = 9;
  const MAX_SOLUTIONS = 24;
  const maxTake = Math.min(nums.length, targetLen + 2);
  // One winning reading per prefix length; more than one entry after the scan
  // is cross-prefix ambiguity (readings at different prefixes always differ —
  // a partition consumes its whole stream, so extra digits change the values).
  const candidates: number[][] = [];
  for (let take = Math.min(targetLen, nums.length); take <= maxTake; take++) {
    const tokenStrs = nums.slice(0, take).map(String);
    const stream = tokenStrs.join("");
    if (stream.length > MAX_STREAM_DIGITS) break;
    if (stream.length < targetLen) continue;

    const solutions: number[][] = [];
    let overflowed = false;
    const walk = (pos: number, acc: number[]): void => {
      if (overflowed) return;
      const remainingCols = targetLen - acc.length;
      if (remainingCols === 0) {
        if (pos !== stream.length) return;
        const total = acc[0];
        if (expectedTotal !== undefined && total !== expectedTotal) return;
        if (acc.slice(1).reduce((a, b) => a + b, 0) !== total) return;
        if (solutions.length >= MAX_SOLUTIONS) {
          overflowed = true;
          return;
        }
        solutions.push([...acc]);
        return;
      }
      const remainingDigits = stream.length - pos;
      if (remainingDigits < remainingCols) return;
      const maxLen = Math.min(MAX_PART_DIGITS, remainingDigits - (remainingCols - 1));
      for (let len = 1; len <= maxLen; len++) {
        const piece = stream.slice(pos, pos + len);
        // Longer pieces at this position share the leading zero — stop.
        if (piece.length > 1 && piece.startsWith("0")) break;
        walk(pos + len, [...acc, parseInt(piece, 10)]);
        if (overflowed) return;
      }
    };
    walk(0, []);
    if (overflowed) return null;
    if (solutions.length === 0) continue;
    if (solutions.length === 1) {
      candidates.push(solutions[0]);
      continue;
    }

    // Multiple checksum-valid partitions at this prefix: prefer the one
    // preserving the most original token boundaries; a tie is genuine
    // ambiguity — refuse to guess.
    const originalCuts = new Set<number>();
    let cum = 0;
    for (let i = 0; i < tokenStrs.length - 1; i++) {
      cum += tokenStrs[i].length;
      originalCuts.add(cum);
    }
    let best: number[] | null = null;
    let bestScore = -1;
    let tied = false;
    for (const sol of solutions) {
      let score = 0;
      let c = 0;
      for (let i = 0; i < sol.length - 1; i++) {
        c += String(sol[i]).length;
        if (originalCuts.has(c)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = sol;
        tied = false;
      } else if (score === bestScore) {
        tied = true;
      }
    }
    if (tied || !best) return null;
    candidates.push(best);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Parse a single legacy Platform Lead Quality row that may have split digits.
 * Captures the whole digit-token run after the platform label, then uses
 * {@link reassembleQualityRow}'s checksum (col0 === sum of the remaining
 * columns) to recover the intended `targetLen`-column values. Falls back to the
 * first `targetLen` raw tokens (legacy behavior) when no checksum-valid merge
 * exists, so a row that never balanced before still parses the same way.
 *
 * @returns `{ cols, reassembled }` or null when the label/row is not present.
 */
export function parseLegacyQualityRow(
  text: string,
  labelPattern: string,
  targetLen: number,
  expectedTotal?: number,
): { cols: number[]; reassembled: boolean } | null {
  const re = new RegExp(`${labelPattern}\\s+((?:\\d+\\s+){${targetLen - 1},}\\d+)`, "i");
  const m = text.match(re);
  if (!m) return null;
  const tokens = m[1].trim().split(/\s+/).map((t) => parseInt(t, 10)).filter((n) => !Number.isNaN(n));
  if (tokens.length < targetLen) return null;
  const balanced = reassembleQualityRow(tokens, targetLen, expectedTotal);
  if (balanced) {
    // Value-diff, not length-diff: a count-preserving repartition ("1 128" →
    // "11 28") changes values without changing the token count.
    const reassembled =
      balanced.length !== tokens.length || balanced.some((v, i) => v !== tokens[i]);
    return { cols: balanced, reassembled };
  }
  // No checksum-valid merge — preserve legacy behavior (first targetLen tokens).
  return { cols: tokens.slice(0, targetLen), reassembled: false };
}

export async function parseReportPdf(buffer: Buffer): Promise<ParsedReportData & { _extractedText?: string }> {
  const rawText = await extractTextFromPdf(buffer);

  const lines = rawText.split("\n").map((l: string) => l.trim()).filter((l: string) => l.length > 0);
  return parseReportText(lines.join(" "));
}

/**
 * Task #3772 — the entire text-stage parse, split out of `parseReportPdf` so
 * tests can drive it with REAL extracted-text fixtures (no PDF buffer needed).
 * `parseReportPdf` is PDF extraction + this call; behavior is unchanged.
 *
 * CONTRACT: every numeric metric defaults to 0 and `fieldConfidence` gets a
 * `"<section>.<field>"` key ONLY when a label actually matched in the text.
 * Key PRESENCE (never the 0 value) is how import surfaces distinguish
 * "parsed 0" from "defaulted 0" — see `shared/importMetricPresence.ts` and
 * `buildImportedSectionNoDataFlags` in `server/services/importWritePolicy.ts`.
 */
export function parseReportText(rawFullText: string): ParsedReportData & { _extractedText?: string } {
  const fullText = normalizeType3Text(rawFullText);

  const confidence: Record<string, { confidence: FieldConfidence; source: string }> = {};

  const result: ParsedReportData = {
    intake: {
      totalConsults: 0,
      missedCallRate: 0,
      avgTimeToAnswer: 0,
      qualityScore: 0,
      commonIssues: "",
    },
    sales: {
      totalCases: 0,
      averageCaseValue: 0,
      noShowRate: 0,
      avgFollowUps: 0,
      qualityScore: 0,
      commonIssues: "",
      revenue: 0,
      dealTouchDensity: 0,
      avgAgeOpenMatters: 0,
      pipelineMomentumScore: 0,
    },
    marketing: {
      totalLeads: 0,
      leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
      gbpLocations: [],
      googleAds: {
        uniqueLeads: 0,
        adSpend: 0,
        leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
      },
      lsa: {
        uniqueLeads: 0,
        adSpend: 0,
        leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
      },
      webinar: {
        registrants: 0,
        attendees: 0,
        leads: 0,
        showRate: 0,
        htScheduleRate: 0,
        hotTransfers: 0,
        leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
      },
      reviewGeneration: {
        listContacted: 0,
        listReviews: 0,
        webinarReviews: 0,
        otherCount: 0,
        totalReviews: 0,
      },
      otherLeads: {
        socialMedia: 0,
        directCalls: 0,
        referrals: 0,
        total: 0,
        leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
      },
    },
    fieldConfidence: {},
  };

  // === REPORT DATE ===
  const dateMatch = fullText.match(/(\w+\s+\d+,\s+\d{4})\s*-\s*(\w+\s+\d+,\s+\d{4})/);
  if (dateMatch) {
    const endDate = new Date(dateMatch[2]);
    const year = endDate.getFullYear();
    const month = String(endDate.getMonth() + 1).padStart(2, "0");
    result.reportMonth = `${year}-${month}`;
    confidence["reportMonth"] = { confidence: "high", source: `Date range: ${dateMatch[0]}` };
  } else {
    const monthYearMatch = fullText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+\d{4}/i);
    if (monthYearMatch) {
      const d = new Date(monthYearMatch[0]);
      if (!isNaN(d.getTime())) {
        result.reportMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        confidence["reportMonth"] = { confidence: "medium", source: `Single date found: ${monthYearMatch[0]}` };
      }
    }
  }

  // === CLIENT NAME ===
  const clientMatch = fullText.match(/(?:Revenue\s+Engineering\s+Analysis|Revenue\s+Engine\s+Review)\s+([\w\s]+?)(?=Total\s*Leads|Marketing|Intake|Overall)/i);
  if (clientMatch) {
    result.clientName = clientMatch[1].trim();
    confidence["clientName"] = { confidence: "medium", source: `Extracted after title: "${result.clientName}"` };
  }

  // === TOTAL LEADS, CONSULTS, CASES ===
  const topLineMatch = fullText.match(/Total\s*Leads\s+(\d[\d\s]*\d|\d+)\s+Consults\s+(\d[\d\s]*\d|\d+)\s+Cases\s+(\d[\d\s]*\d|\d+)/i);
  const altTopLineMatch = fullText.match(/\bLeads\s+(\d[\d\s]*\d|\d+)\s+Consults\s+(\d[\d\s]*\d|\d+)\s+Cases\s+(\d[\d\s]*\d|\d+)/i);
  const overallMatch = fullText.match(/Overall\s*Results[\s\S]*?Leads\s+(\d[\d\s]*\d|\d+)[\s\S]*?Consults\s+(\d[\d\s]*\d|\d+)[\s\S]*?Cases\s+(\d[\d\s]*\d|\d+)/i);
  
  const mainMatch = topLineMatch || altTopLineMatch || overallMatch;
  if (mainMatch) {
    result.marketing.totalLeads = parseNumber(mainMatch[1].replace(/\s/g, ''));
    result.intake.totalConsults = parseNumber(mainMatch[2].replace(/\s/g, ''));
    result.sales.totalCases = parseNumber(mainMatch[3].replace(/\s/g, ''));
    const src = topLineMatch ? "Total Leads/Consults/Cases row" : altTopLineMatch ? "Leads/Consults/Cases row" : "Overall Results section";
    confidence["marketing.totalLeads"] = { confidence: "high", source: src };
    confidence["intake.totalConsults"] = { confidence: "high", source: src };
    confidence["sales.totalCases"] = { confidence: "high", source: src };
  } else {
    const totalLeadsMatch = fullText.match(/Total\s*Leads\s+(\d[\d\s]*\d|\d+)/i);
    if (totalLeadsMatch) {
      result.marketing.totalLeads = parseNumber(totalLeadsMatch[1].replace(/\s/g, ''));
      confidence["marketing.totalLeads"] = { confidence: "medium", source: "Standalone Total Leads pattern" };
    }
    // Task #2555 — `\d[\d\s]*\d` recovers a split count ("1 1"); the `\d{2,}`
    // alternative preserves the original single-digit exclusion for these
    // ambiguous standalone fallbacks.
    const consultsMatch = fullText.match(/Consults\s+(\d[\d\s]*\d|\d{2,})/i);
    if (consultsMatch) {
      const c = reassembleSplitDigits(consultsMatch[1]);
      result.intake.totalConsults = c.value;
      confidence["intake.totalConsults"] = { confidence: "medium", source: `Standalone Consults pattern${c.reassembled ? " (reassembled from split digits)" : ""}` };
    }
    const casesMatch = fullText.match(/Cases\s+(\d[\d\s]*\d|\d{2,})/i);
    if (casesMatch) {
      const c = reassembleSplitDigits(casesMatch[1]);
      result.sales.totalCases = c.value;
      confidence["sales.totalCases"] = { confidence: "medium", source: `Standalone Cases pattern${c.reassembled ? " (reassembled from split digits)" : ""}` };
    }
  }

  // === OVERALL LEAD QUALITY (summary row) ===
  // Task #2555 — split-digit-safe; missedCalls keeps its `(?!\.\d)` guard so it
  // does not grab the integer part of a following decimal rate.
  const goodMatch = captureLabeledCount(fullText, String.raw`Good`);
  const notQuotableMatch = captureLabeledCount(fullText, String.raw`Not\s*Quotable`);
  const missedCallsMatch = captureLabeledCount(fullText, String.raw`Missed\s*Call(?:s)?`, { trailingGuard: String.raw`(?!\s*\.\d)` });
  const noDataMatch = captureLabeledCount(fullText, String.raw`No\s*Data`);
  if (goodMatch || notQuotableMatch || missedCallsMatch || noDataMatch) {
    if (goodMatch) result.marketing.leadQuality.good = goodMatch.value;
    if (notQuotableMatch) result.marketing.leadQuality.notQuotable = notQuotableMatch.value;
    if (missedCallsMatch) result.marketing.leadQuality.missedCalls = missedCallsMatch.value;
    if (noDataMatch) result.marketing.leadQuality.noData = noDataMatch.value;
    const anyReassembled = [goodMatch, notQuotableMatch, missedCallsMatch, noDataMatch].some(m => m?.reassembled);
    confidence["marketing.leadQuality"] = { confidence: "high", source: `Lead quality summary labels${anyReassembled ? " (some values reassembled from split digits)" : ""}` };
  }

  // === REVENUE ===
  const revenueMatch = fullText.match(/Revenue\s+\$?([\d,.]+K?)/i);
  if (revenueMatch) {
    result.sales.revenue = parseNumber(revenueMatch[1]);
    if (result.sales.totalCases > 0) {
      result.sales.averageCaseValue = Math.round(result.sales.revenue / result.sales.totalCases);
      confidence["sales.averageCaseValue"] = { confidence: "medium", source: `Calculated: Revenue ${revenueMatch[1]} / ${result.sales.totalCases} cases` };
    }
    confidence["sales.revenue"] = { confidence: "high", source: `Revenue: ${revenueMatch[0]}` };
  }

  // === INTAKE DATA ===
  // Task #2555 — rates/scores tolerate a split INTEGER part ("1 1.5%" → 11.5%).
  // The fractional part is never split because the "." blocks the tokenizer.
  const decimalCount = { sep: String.raw`\s*`, countSource: SPLIT_DIGIT_DECIMAL_SOURCE };
  const leadsToConsultMatch = captureLabeledCount(fullText, String.raw`Leads\s*to\s*Consult\s*Rate`, decimalCount);
  if (leadsToConsultMatch) {
    confidence["intake.leadsToConsultRate"] = { confidence: "high", source: `Leads to Consult Rate: ${leadsToConsultMatch.value}%${leadsToConsultMatch.reassembled ? " (reassembled)" : ""}` };
  }

  const missedCallRateMatch = captureLabeledCount(fullText, String.raw`Missed\s*Call\s*(?:Rate|%)`, decimalCount)
    || captureLabeledCount(fullText, String.raw`Missed\s*Call`, { sep: String.raw`\s+`, countSource: String.raw`\d[\d\s]*\d\.\d+|\d+\.\d+` });
  if (missedCallRateMatch) {
    result.intake.missedCallRate = missedCallRateMatch.value;
    confidence["intake.missedCallRate"] = { confidence: "high", source: `Missed Call Rate: ${missedCallRateMatch.value}%${missedCallRateMatch.reassembled ? " (reassembled)" : ""}` };
  }

  // Task #3772 — newer "REA Data Export" PDFs (June 2026+: Ackah Law, Jurist
  // Law Group, Shields & Boris) label this metric "Time to Human Answer"
  // (optionally "Avg"/"Avg." prefixed, optionally "(s)"/"(sec)" suffixed)
  // instead of the legacy "Avg Time to Answer". Real extracted shape:
  //   "See details Time to Human Answer 8.45 See details" (Ackah 2026-07).
  // Both label variants record the SAME high-confidence entry; a "No data"
  // body after the label correctly yields no match (absent stays absent).
  const avgTimeMatch = captureLabeledCount(fullText, String.raw`Avg\.?\s*Time\s*to\s*Answer\s*(?:\(s(?:ec)?\))?`, decimalCount);
  const humanAnswerMatch = avgTimeMatch
    ? null
    : captureLabeledCount(fullText, String.raw`(?:Avg\.?\s*)?Time\s*to\s*Human\s*Answer\s*(?:\(s(?:ec)?\))?`, decimalCount);
  const timeToAnswerMatch = avgTimeMatch || humanAnswerMatch;
  if (timeToAnswerMatch) {
    result.intake.avgTimeToAnswer = timeToAnswerMatch.value;
    confidence["intake.avgTimeToAnswer"] = { confidence: "high", source: `${avgTimeMatch ? "Avg Time to Answer" : "Time to Human Answer"}: ${timeToAnswerMatch.value}${timeToAnswerMatch.reassembled ? " (reassembled)" : ""}` };
  }

  const intakeQualityMatch = captureLabeledCount(fullText, String.raw`Intake\s*(?:Raw\s*)?Quality\s*Score`, decimalCount);
  if (intakeQualityMatch) {
    result.intake.qualityScore = intakeQualityMatch.value;
    confidence["intake.qualityScore"] = { confidence: "high", source: `Intake Quality Score: ${intakeQualityMatch.value}${intakeQualityMatch.reassembled ? " (reassembled)" : ""}` };
  }

  // === INTAKE COMMON ISSUES ===
  // Hardened: placeholder-only / whitespace-only / missing bodies are
  // treated as empty and surfaced as `confidence: "none"` so operators can
  // see why the field was skipped.
  {
    const extracted = extractCommonIssuesFromText(fullText, "intake");
    if (!extracted.isEmpty && extracted.value.length > 20) {
      result.intake.commonIssues = extracted.value;
      confidence["intake.commonIssues"] = extracted.confidence;
    } else {
      // Empty / placeholder / too-short body — never mark high confidence.
      confidence["intake.commonIssues"] = extracted.isEmpty
        ? extracted.confidence
        : { confidence: "none", source: "empty: Intake Common Issues body too short" };
    }
  }

  // === SALES DATA ===
  // Task #2555 — same split-INTEGER-part tolerance as the intake rates above.
  const consultToCaseMatch = captureLabeledCount(fullText, String.raw`Consult[\s-]*to[\s-]*Case\s*Rate`, decimalCount);
  if (consultToCaseMatch) {
    confidence["sales.consultToCaseRate"] = { confidence: "high", source: `Consult-to-Case Rate: ${consultToCaseMatch.value}%${consultToCaseMatch.reassembled ? " (reassembled)" : ""}` };
  }

  const noShowMatch = captureLabeledCount(fullText, String.raw`(?:Sales\s*)?No[\s-]*Show\s*Rate`, decimalCount);
  if (noShowMatch) {
    result.sales.noShowRate = noShowMatch.value;
    confidence["sales.noShowRate"] = { confidence: "high", source: `No-Show Rate: ${noShowMatch.value}%${noShowMatch.reassembled ? " (reassembled)" : ""}` };
  }

  const followUpMatch = captureLabeledCount(fullText, String.raw`(?:Avg\.?\s*)?Follow[\s-]*Up\s*Touches`, decimalCount);
  if (followUpMatch) {
    result.sales.avgFollowUps = followUpMatch.value;
    confidence["sales.avgFollowUps"] = { confidence: "high", source: `Avg Follow-Up Touches: ${followUpMatch.value}${followUpMatch.reassembled ? " (reassembled)" : ""}` };
  }

  const salesQualityMatch = captureLabeledCount(fullText, String.raw`Sales\s*(?:Raw\s*)?Quality\s*Score`, decimalCount);
  if (salesQualityMatch) {
    result.sales.qualityScore = salesQualityMatch.value;
    confidence["sales.qualityScore"] = { confidence: "high", source: `Sales Quality Score: ${salesQualityMatch.value}${salesQualityMatch.reassembled ? " (reassembled)" : ""}` };
  }

  const dealTouchMatch = captureLabeledCount(fullText, String.raw`(?:Active\s*)?Deal\s*Touch\s*Density`, decimalCount);
  if (dealTouchMatch) {
    result.sales.dealTouchDensity = dealTouchMatch.value;
    confidence["sales.dealTouchDensity"] = { confidence: "high", source: `Deal Touch Density: ${dealTouchMatch.value}${dealTouchMatch.reassembled ? " (reassembled)" : ""}` };
  }

  const avgAgeMatch = captureLabeledCount(fullText, String.raw`Average\s*Age\s*(?:of\s*)?Open\s*Matters`, decimalCount);
  if (avgAgeMatch) {
    result.sales.avgAgeOpenMatters = avgAgeMatch.value;
    confidence["sales.avgAgeOpenMatters"] = { confidence: "high", source: `Avg Age of Open Matters: ${avgAgeMatch.value}${avgAgeMatch.reassembled ? " (reassembled)" : ""}` };
  }

  const pipelineMomentumMatch = captureLabeledCount(fullText, String.raw`Pipeline\s*Momentum\s*Score`, decimalCount);
  if (pipelineMomentumMatch) {
    result.sales.pipelineMomentumScore = pipelineMomentumMatch.value;
    confidence["sales.pipelineMomentumScore"] = { confidence: "high", source: `Pipeline Momentum Score: ${pipelineMomentumMatch.value}${pipelineMomentumMatch.reassembled ? " (reassembled)" : ""}` };
  }

  // === SALES COMMON ISSUES ===
  // Hardened: placeholder-only / whitespace-only / missing bodies are
  // treated as empty and surfaced as `confidence: "none"` so operators can
  // see why the field was skipped.
  {
    const extracted = extractCommonIssuesFromText(fullText, "sales");
    if (!extracted.isEmpty && extracted.value.length > 20) {
      result.sales.commonIssues = extracted.value;
      confidence["sales.commonIssues"] = extracted.confidence;
    } else {
      confidence["sales.commonIssues"] = extracted.isEmpty
        ? extracted.confidence
        : { confidence: "none", source: "empty: Sales Common Issues body too short" };
    }
  }

  // === GBP LOCATIONS TABLE ===
  let gbpTableMatch = fullText.match(/(?:GBP\s*Profile\s*Data|Google\s*Business\s*Profile\s*Data|GBP\s*Data)[\s\S]*?(?:Location|Name)\s+(?:Unique\s*)?Leads\s+(?:Reviews?\s*Generated|New\s*reviews)\s+(?:Reviews?\s*Responded(?:\s*To)?|Replied)\s+(?:Posts\/Q&A\s*Count|Posts)([\s\S]*?)(?:Paid\s*Search|Platform\s*Lead|Lead\s*Quality|Webinar|\d+\s*-\s*\d+|$)/i);
  if (!gbpTableMatch) {
    gbpTableMatch = fullText.match(/(?:Location)\s+(?:Unique\s*)?Leads\s+(?:New\s*reviews|Reviews?\s*Generated)\s+(?:Posts|Posts\/Q&A\s*Count)\s+(?:Replied|Reviews?\s*Responded)([\s\S]*?)(?:Paid\s*Search|platform|Platform\s*Lead|Lead\s*Quality|Webinar|$)/i);
  }
  if (gbpTableMatch) {
    const tableContent = normalizeType3Text(gbpTableMatch[1]);
    // Task #2555 — each numeric column tolerates ONE split digit via the same
    // `(\d+(?:\s\d(?!\d))?)` idiom the GBP Leads path below already uses: the
    // trailing `(?!\d)` keeps it from swallowing the next column's value.
    const GBP_COL = String.raw`\d+(?:\s\d(?!\d))?`;
    const rowRe = new RegExp(`([A-Za-z][A-Za-z\\s.,']+?)\\s+(${GBP_COL})\\s+(${GBP_COL})\\s+(${GBP_COL})\\s+(${GBP_COL})`, 'g');
    const locationRows = tableContent.match(rowRe);
    result.marketing.gbpLocations = [];
    if (locationRows) {
      for (const row of locationRows) {
        const parts = row.match(new RegExp(`([A-Za-z][A-Za-z\\s.,']+?)\\s+(${GBP_COL})\\s+(${GBP_COL})\\s+(${GBP_COL})\\s+(${GBP_COL})`));
        if (parts) {
          const name = parts[1].trim();
          if (name.match(/^Paid|^Lead|^Webinar|^Platform|^Location/i)) {
            console.log(`[PDF Parser] GBP combined table: skipping row "${name}" (matched header/label filter)`);
            continue;
          }
          const leads = reassembleSplitDigits(parts[2]);
          result.marketing.gbpLocations.push({
            name,
            uniqueLeads: leads.value,
            reviewsGenerated: reassembleSplitDigits(parts[3]).value,
            reviewsRespondedTo: reassembleSplitDigits(parts[4]).value,
            postsQaCount: reassembleSplitDigits(parts[5]).value,
            leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: leads.value },
          });
        }
      }
    }
    if (result.marketing.gbpLocations.length > 0) {
      confidence["marketing.gbpLocations"] = { confidence: "high", source: `GBP table: ${result.marketing.gbpLocations.length} locations parsed` };
    }
  }

  if (result.marketing.gbpLocations.length === 0) {
    const gbpLeadsSection = fullText.match(/GBP\s*Loca(?:tions?)?\s*Leads([\s\S]*?)(?:GBP\s*Loca(?:tions?)?\s*Reviews|Platform\s*Lead|Blog|$)/i);
    let gbpReviewsSection = fullText.match(/GBP\s*Loca(?:tions?)?\s*Reviews[\s\S]*?Posts[\s\S]{0,20}Count([\s\S]*?)(?:Blog|LSA\s|Google\s*Ads\s*Spend|Platform\s*Lead|List\s*Reviews|$)/i);
    if (!gbpReviewsSection) {
      gbpReviewsSection = fullText.match(/GBP\s*Loca(?:tions?)?\s*Reviews[\s\S]*?(?:Responded|Replied|Reiews\s*Responded)([\s\S]*?)(?:Blog|LSA\s|Google\s*Ads\s*Spend|Platform\s*Lead|List\s*Reviews|$)/i);
    }
    if (!gbpReviewsSection) {
      gbpReviewsSection = fullText.match(/GBP\s*Loca(?:tions?)?\s*Reviews[\s\S]*?(?:Generated|New\s*reviews)([\s\S]*?)(?:Blog|LSA\s|Google\s*Ads\s*Spend|Platform\s*Lead|List\s*Reviews|Paid\s*Search|$)/i);
    }
    if (!gbpReviewsSection) {
      gbpReviewsSection = fullText.match(/(?:Reviews?\s*Generated|New\s*reviews)[\s\S]{0,40}(?:Responded|Replied|Posts)([\s\S]*?)(?:Blog|LSA\s|Google\s*Ads\s*Spend|Platform\s*Lead|List\s*Reviews|Paid\s*Search|$)/i);
    }
    if (!gbpReviewsSection) {
      gbpReviewsSection = fullText.match(/GBP\s*Loca(?:tions?)?\s*Reviews([\s\S]*?)(?:Blog|Platform\s*Lead|Paid|List\s*Contacted|Review\s*Generation|Intake|$)/i);
    }

    if (gbpLeadsSection) {
      let leadsText = normalizeType3Text(gbpLeadsSection[1]);
      leadsText = leadsText.replace(/GBP\s*Loca[\s\S]*?Leads\s+/i, '');
      leadsText = leadsText.replace(/Campaign\s+Leads\s*/gi, '');
      leadsText = leadsText.replace(/Location\s+(?:Unique\s*)?Leads\s*/gi, '');
      const leadsRows = leadsText.match(/([A-Za-z][A-Za-z\s.,']+?)\s+(\d+(?:\s\d(?!\d))?)/g);
      const locMap: Record<string, { uniqueLeads: number; reviewsGenerated: number; reviewsRespondedTo: number; postsQaCount: number }> = {};
      if (leadsRows) {
        for (const row of leadsRows) {
          const parts = row.match(/([A-Za-z][A-Za-z\s.,']+?)\s+(\d+(?:\s\d(?!\d))?)/);

          if (parts) {
            const name = parts[1].trim();
            if (name.match(/^GBP|^Loca|^Leads|^Platform|^Blog|^Review|^Other\s|^Webinar|^Campaign|^Medium|^Total|^Paid|^Source|^Channel|^No\s*Data/i)) {
              console.log(`[PDF Parser] GBP leads: skipping row "${name}" (matched header/label filter)`);
              continue;
            }
            if (looksLikeFullAddress(name)) {
              console.log(`[PDF Parser] GBP leads: skipping row "${name}" (looks like full address)`);
              continue;
            }
            locMap[name.toLowerCase()] = { uniqueLeads: parseNumber(parts[2].replace(/\s/g, '')), reviewsGenerated: 0, reviewsRespondedTo: 0, postsQaCount: 0 };
          }
        }
      }

      if (gbpReviewsSection) {
        let reviewsText = normalizeType3Text(gbpReviewsSection[1]);
        reviewsText = reviewsText.replace(/Posts?\s*\/?\s*Q\s*&?\s*A\s*Count/gi, '');
        reviewsText = reviewsText.replace(/Location\s+Reviews?\s*/gi, '');
        reviewsText = reviewsText.replace(/Reiews\s+Responded/gi, '');
        reviewsText = reviewsText.replace(/Reviews?\s+Responded/gi, '');
        // Task #2555 — single-split-digit tolerance per column (same idiom as
        // the GBP Leads/Profile paths).
        const GBP_RCOL = String.raw`\d+(?:\s\d(?!\d))?`;
        const reviewRowRe = new RegExp(`([A-Za-z][A-Za-z\\s.,']+?)\\s+(${GBP_RCOL})\\s+(${GBP_RCOL})\\s+(${GBP_RCOL})`, 'g');
        const reviewRows = reviewsText.match(reviewRowRe);
        if (reviewRows) {
          for (const row of reviewRows) {
            const parts = row.match(new RegExp(`([A-Za-z][A-Za-z\\s.,']+?)\\s+(${GBP_RCOL})\\s+(${GBP_RCOL})\\s+(${GBP_RCOL})`));
            if (parts) {
              const name = parts[1].trim().toLowerCase();
              if (name.match(/^gbp|^loca|^review|^platform|^blog|^count|^reiews|^responded|^posts|^no\s*data/i)) {
                console.log(`[PDF Parser] GBP reviews: skipping row "${name}" (matched header/label filter)`);
                continue;
              }
              if (looksLikeFullAddress(name)) {
                console.log(`[PDF Parser] GBP reviews: skipping row "${name}" (looks like full address)`);
                continue;
              }
              const rGen = reassembleSplitDigits(parts[2]).value;
              const rResp = reassembleSplitDigits(parts[3]).value;
              const rPosts = reassembleSplitDigits(parts[4]).value;
              const existingKey = Object.keys(locMap).find(k => fuzzyLocationMatch(k, name));
              if (existingKey) {
                locMap[existingKey].reviewsGenerated = rGen;
                locMap[existingKey].reviewsRespondedTo = rResp;
                locMap[existingKey].postsQaCount = rPosts;
              } else {
                locMap[name] = { uniqueLeads: 0, reviewsGenerated: rGen, reviewsRespondedTo: rResp, postsQaCount: rPosts };
              }
            }
          }
        }
      }

      result.marketing.gbpLocations = Object.entries(locMap).map(([name, data]) => ({
        name: name.replace(/\b\w/g, c => c.toUpperCase()),
        ...data,
        leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: data.uniqueLeads },
      }));

      if (result.marketing.gbpLocations.length > 0) {
        confidence["marketing.gbpLocations"] = { confidence: "high", source: `GBP split tables: ${result.marketing.gbpLocations.length} locations parsed` };
      }
    }
  }

  // === BLOG POST URL ===
  // Use rawFullText (before normalizeType3Text) to avoid uppercase mangling in URLs
  const blogUrlMatch = rawFullText.match(/Blog\s*Post\s*URL\s*(https?:\/\/\S+(?:\s+\S+)*?)\s+\d+\s*-\s*\d+/i);
  if (blogUrlMatch) {
    let url = blogUrlMatch[1].replace(/\s+/g, '').trim();
    if (url.match(/^https?:\/\/.{10,}/)) {
      result.marketing.blogPostUrl = url;
      confidence["marketing.blogPostUrl"] = { confidence: "high", source: `Blog Post URL: ${url.substring(0, 50)}...` };
    }
  }

  // === PLATFORM LEAD QUALITY TABLE (new format) ===
  // Columns: Platform | Leads | Good | Not Quotable | Missed Call | No Data
  // The normalizer may merge adjacent small numbers (e.g. "1 14" → "114"),
  // so we try 5-number match first, then 4-number with smart splitting.
  const platformLqNewMatch = fullText.match(
    /Platform\s*Lead\s*Quality[\s\S]*?No\s*Data([\s\S]*?)(?:Good\s+\d+|Webinar\s*s\s+List|Review\s*Generation|Intake\s*Common)/i
  );

  let platformLqParsed = false;
  // Task #2555 — robust per-platform lead totals harvested from the
  // checksum-validated Platform Lead Quality table. Used to cross-check the
  // vulnerable spend-section Google Ads / LSA lead counts (which can lose a
  // split digit) — the quality-table total is already reassembly-protected.
  const platformQualityTotal: { googleAds?: number; lsa?: number } = {};
  if (platformLqNewMatch) {
    const tableText = platformLqNewMatch[1];

    const tryReassembleNumbers = (nums: number[], expectedTotal: number, depth = 0): number[] | null => {
      if (nums.length < 5 || depth > 5) return null;
      for (let i = 0; i < nums.length - 1; i++) {
        const merged = [...nums];
        const combined = parseInt(String(nums[i]) + String(nums[i + 1]), 10);
        merged.splice(i, 2, combined);
        if (merged.length === 5) {
          const [total, good, nq, missed, nd] = merged;
          if (total === expectedTotal && good + nq + missed + nd === total) {
            return merged;
          }
        }
        if (merged.length > 5) {
          const result = tryReassembleNumbers(merged, expectedTotal, depth + 1);
          if (result) return result;
        }
      }
      return null;
    };

    type PlatformQualityRow = {
      total: number;
      good: number;
      notQuotable: number;
      missedCalls: number;
      noData: number;
      reassembled?: boolean;
    };
    const parsePlatformRow = (namePattern: string, searchTexts?: string[]): PlatformQualityRow | null => {
      const textsToSearch = [tableText, ...(searchTexts || [])];
      for (const text of textsToSearch) {
        const re5 = new RegExp(namePattern + '\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)', 'i');
        const m5 = text.match(re5);
        if (m5) {
          const total = parseNumber(m5[1]);
          const good = parseNumber(m5[2]);
          const nq = parseNumber(m5[3]);
          const missed = parseNumber(m5[4]);
          const nd = parseNumber(m5[5]);
          const breakdown = good + nq + missed + nd;
          if (breakdown === total) {
            return { total, good, notQuotable: nq, missedCalls: missed, noData: nd };
          }
        }

        const reAll = new RegExp(namePattern + '((?:\\s+\\d+(?!\\.\\d))+)', 'i');
        const mAll = text.match(reAll);
        if (mAll) {
          const allNums = mAll[1].trim().split(/\s+/).map(n => parseInt(n, 10));
          if (allNums.length > 5) {
            const expectedTotal = allNums[0];
            const reassembled = tryReassembleNumbers(allNums, expectedTotal);
            if (reassembled) {
              const [total, good, nq, missed, nd] = reassembled;
              return { total, good, notQuotable: nq, missedCalls: missed, noData: nd };
            }
          }
          if (allNums.length === 6) {
            const total = allNums[0];
            const nums5 = allNums.slice(1, 6);
            if (nums5[0] + nums5[1] + nums5[2] + nums5[3] === total) {
              return { total, good: nums5[0], notQuotable: nums5[1], missedCalls: nums5[2], noData: nums5[3] };
            }
          }
          // Feedback #46 — count-preserving smear: "11 28" extracted as
          // "1 128" keeps the token count while breaking the checksum, and the
          // trailing score cell can shed a junk fragment ("28.21" → "2").
          // Merge-based recovery cannot re-split digits, so re-partition the
          // digit stream (checksum-validated, unambiguous-solution-only,
          // junk-tolerant via token prefixes).
          if (allNums.length >= 5) {
            const rep = repartitionQualityRow(allNums, 5);
            if (rep) {
              const [total, good, nq, missed, nd] = rep;
              return { total, good, notQuotable: nq, missedCalls: missed, noData: nd, reassembled: true };
            }
          }
        }

        const re4 = new RegExp(namePattern + '\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)', 'i');
        const m4 = text.match(re4);
        if (m4) {
          const total = parseNumber(m4[1]);
          const v1 = parseNumber(m4[2]);
          const v2 = parseNumber(m4[3]);
          const v3 = parseNumber(m4[4]);
          if (v3 > total) continue;
          const remainder = total - v1 - v2;
          if (remainder >= 0 && v3 <= remainder) {
            const noData = remainder - v3;
            if (noData <= total && v3 <= total && v1 <= total && v2 <= total) {
              return { total, good: v1, notQuotable: v2, missedCalls: v3, noData };
            }
          }
          if (remainder >= 0 && v3 > remainder) {
            const v3str = String(v3);
            for (let split = 1; split < v3str.length; split++) {
              const missed = parseInt(v3str.substring(0, split), 10);
              const nd = parseInt(v3str.substring(split), 10);
              if (v1 + v2 + missed + nd === total) {
                return { total, good: v1, notQuotable: v2, missedCalls: missed, noData: nd };
              }
            }
          }
        }
      }
      return null;
    };

    const fallbackTexts = [fullText];
    const gbpRow = parsePlatformRow('GBP');
    const otherRow = parsePlatformRow('Other', fallbackTexts);
    const googleAdsRow = parsePlatformRow('Google\\s*Ads', fallbackTexts);
    const webinarRow = parsePlatformRow('Webinar');
    const lsaRow = parsePlatformRow('LSA');

    if (googleAdsRow && googleAdsRow.total > 0) platformQualityTotal.googleAds = googleAdsRow.total;
    if (lsaRow && lsaRow.total > 0) platformQualityTotal.lsa = lsaRow.total;

    if (gbpRow || googleAdsRow || lsaRow || otherRow || webinarRow) {
      platformLqParsed = true;

      if (googleAdsRow) {
        result.marketing.googleAds.leadQuality = { good: googleAdsRow.good, notQuotable: googleAdsRow.notQuotable, missedCalls: googleAdsRow.missedCalls, noData: googleAdsRow.noData };
        confidence["marketing.googleAds.leadQuality"] = { confidence: "high", source: `Google Ads quality: ${googleAdsRow.good}G/${googleAdsRow.missedCalls}M/${googleAdsRow.notQuotable}NQ${googleAdsRow.reassembled ? " (reassembled)" : ""}` };
      }

      if (lsaRow) {
        result.marketing.lsa.leadQuality = { good: lsaRow.good, notQuotable: lsaRow.notQuotable, missedCalls: lsaRow.missedCalls, noData: lsaRow.noData };
        confidence["marketing.lsa.leadQuality"] = { confidence: "high", source: `LSA quality: ${lsaRow.good}G/${lsaRow.missedCalls}M/${lsaRow.notQuotable}NQ${lsaRow.reassembled ? " (reassembled)" : ""}` };
        if (result.marketing.lsa.uniqueLeads === 0 && lsaRow.total > 0) {
          result.marketing.lsa.uniqueLeads = lsaRow.total;
          confidence["marketing.lsa.uniqueLeads"] = { confidence: "medium", source: `LSA uniqueLeads set from quality table total: ${lsaRow.total}` };
        }
      }

      if (gbpRow) {
        const gbpQuality = { good: gbpRow.good, notQuotable: gbpRow.notQuotable, missedCalls: gbpRow.missedCalls, noData: gbpRow.noData };
        confidence["marketing.gbp.leadQuality"] = { confidence: "high", source: `GBP quality: ${gbpRow.good}G/${gbpRow.missedCalls}M/${gbpRow.notQuotable}NQ${gbpRow.reassembled ? " (reassembled)" : ""}` };

        const distributeWithLargestRemainder = (total: number, ratios: number[]): number[] => {
          if (ratios.length === 0) return [];
          const raw = ratios.map(r => total * r);
          const floored = raw.map(v => Math.floor(v));
          let remainder = total - floored.reduce((a, b) => a + b, 0);
          const remainders = raw.map((v, i) => ({ index: i, frac: v - floored[i] }));
          remainders.sort((a, b) => b.frac - a.frac);
          for (let i = 0; i < remainder; i++) {
            floored[remainders[i].index]++;
          }
          return floored;
        };

        const distributeQualityToLocations = (locations: typeof result.marketing.gbpLocations, totalLeads: number) => {
          const ratios = locations.map(loc => totalLeads > 0 ? loc.uniqueLeads / totalLeads : 1 / locations.length);
          const goods = distributeWithLargestRemainder(gbpQuality.good, ratios);
          const nqs = distributeWithLargestRemainder(gbpQuality.notQuotable, ratios);
          const misseds = distributeWithLargestRemainder(gbpQuality.missedCalls, ratios);
          const nds = distributeWithLargestRemainder(gbpQuality.noData, ratios);
          for (let i = 0; i < locations.length; i++) {
            locations[i].leadQuality = { good: goods[i], notQuotable: nqs[i], missedCalls: misseds[i], noData: nds[i] };
          }
        };

        if (result.marketing.gbpLocations.length > 0) {
          const totalGbpLeads = result.marketing.gbpLocations.reduce((sum, loc) => sum + loc.uniqueLeads, 0);
          if (totalGbpLeads > 0) {
            distributeQualityToLocations(result.marketing.gbpLocations, totalGbpLeads);
          } else if (gbpRow.total > 0) {
            if (result.marketing.gbpLocations.length === 1) {
              result.marketing.gbpLocations[0].uniqueLeads = gbpRow.total;
              result.marketing.gbpLocations[0].leadQuality = gbpQuality;
            } else {
              const evenShare = Math.floor(gbpRow.total / result.marketing.gbpLocations.length);
              const remainder = gbpRow.total - evenShare * result.marketing.gbpLocations.length;
              for (let i = 0; i < result.marketing.gbpLocations.length; i++) {
                result.marketing.gbpLocations[i].uniqueLeads = evenShare + (i < remainder ? 1 : 0);
              }
              distributeQualityToLocations(result.marketing.gbpLocations, gbpRow.total);
            }
            confidence["marketing.gbpLocations.uniqueLeads"] = { confidence: "medium", source: `GBP uniqueLeads set from quality table total: ${gbpRow.total}` };
          }
        } else if (gbpRow.total > 0) {
          result.marketing.gbpLocations = [{
            name: "All Locations",
            uniqueLeads: gbpRow.total,
            reviewsGenerated: 0,
            reviewsRespondedTo: 0,
            postsQaCount: 0,
            leadQuality: gbpQuality,
          }];
          confidence["marketing.gbpLocations"] = { confidence: "medium", source: `GBP location created from quality table total: ${gbpRow.total}` };
        }
      }

      if (lsaRow) {
        result.marketing.lsa.leadQuality = { good: lsaRow.good, notQuotable: lsaRow.notQuotable, missedCalls: lsaRow.missedCalls, noData: lsaRow.noData };
        confidence["marketing.lsa.leadQuality"] = { confidence: "high", source: `LSA quality: ${lsaRow.good}G/${lsaRow.missedCalls}M/${lsaRow.notQuotable}NQ${lsaRow.reassembled ? " (reassembled)" : ""}` };
        if (result.marketing.lsa.uniqueLeads === 0 && lsaRow.total > 0) {
          result.marketing.lsa.uniqueLeads = lsaRow.total;
          confidence["marketing.lsa.uniqueLeads"] = { confidence: "medium", source: `LSA uniqueLeads set from quality table total: ${lsaRow.total}` };
        }
      }

      if (googleAdsRow && result.marketing.googleAds.uniqueLeads === 0 && googleAdsRow.total > 0) {
        result.marketing.googleAds.uniqueLeads = googleAdsRow.total;
        confidence["marketing.googleAds.uniqueLeads"] = { confidence: "medium", source: `Google Ads uniqueLeads set from quality table total: ${googleAdsRow.total}` };
      }

      if (otherRow) {
        result.marketing.otherLeads.total = otherRow.total;
        result.marketing.otherLeads.leadQuality = { good: otherRow.good, notQuotable: otherRow.notQuotable, missedCalls: otherRow.missedCalls, noData: otherRow.noData };
        confidence["marketing.otherLeads.leadQuality"] = { confidence: "high", source: `Other quality: ${otherRow.good}G/${otherRow.missedCalls}M/${otherRow.notQuotable}NQ${otherRow.reassembled ? " (reassembled)" : ""}` };
      }

      if (webinarRow) {
        if (result.marketing.webinar.leads === 0) {
          result.marketing.webinar.leads = webinarRow.total;
        }
        result.marketing.webinar.leadQuality = {
          good: webinarRow.good,
          notQuotable: webinarRow.notQuotable,
          missedCalls: webinarRow.missedCalls,
          noData: webinarRow.noData,
        };
        confidence["marketing.webinar.leadQuality"] = { confidence: "high", source: `Webinar quality: ${webinarRow.good}G/${webinarRow.missedCalls}M/${webinarRow.notQuotable}NQ/${webinarRow.noData}ND${webinarRow.reassembled ? " (reassembled)" : ""}` };
      }

      if (!googleAdsRow && result.marketing.googleAds.uniqueLeads > 0) {
        console.log(`[PDF Parser] Warning: Google Ads has ${result.marketing.googleAds.uniqueLeads} leads but lead quality row not matched in platform quality table`);
      }
      if (!otherRow && result.marketing.otherLeads.total > 0) {
        console.log(`[PDF Parser] Warning: Other leads has ${result.marketing.otherLeads.total} total but quality row not matched in platform quality table`);
      }
      if (!lsaRow && result.marketing.lsa.uniqueLeads > 0) {
        console.log(`[PDF Parser] Warning: LSA has ${result.marketing.lsa.uniqueLeads} leads but lead quality row not matched in platform quality table`);
      }
    }
  }

  // === PAID SEARCH SPEND TABLE ===
  // Scope spend extraction to paid search table sections to prevent matching template boilerplate.
  // Stand-alone spend labels (e.g., "LSA Spend $X") are only matched within a detected section.
  // Structured row patterns ("Local Service Ads 4 $1,234.56") require leads+spend together.
  let paidSearchSection = fullText.match(/(?:Paid\s*Search|Paid\s*Media|Ad\s*Spend|Campaign\s*Performance)[\s\S]*?(?:Platform|Source|Channel)\s+(?:Leads|Clicks)\s+(?:Spend|Cost|Budget)([\s\S]*?)(?:Platform\s*Lead\s*Quality|Lead\s*Quality|Webinar|Review\s*Generation|Intake|$)/i);
  if (!paidSearchSection) {
    paidSearchSection = fullText.match(/Paid\s*Ads([\s\S]*?)(?:Webinar|Review\s*Generation|Intake|$)/i);
  }
  const spendSectionText = paidSearchSection ? paidSearchSection[0] : '';
  const hasSpendSection = spendSectionText.length > 0;

  // Task #2555 — the leads count tolerates a split digit ("1 1" → 11). The
  // capture spans only [\d\s] so it still halts at the "$" before the spend.
  let lsaRowMatch = hasSpendSection
    ? spendSectionText.match(/Local\s*Service\s*Ads\s+(\d[\d\s]*\d|\d+)\s+\$([\d,]+(?:\s\d+)?(?:\.\d+)?)/i)
    : fullText.match(/Local\s*Service\s*Ads\s+(\d[\d\s]*\d|\d+)\s+\$([\d,]+(?:\s\d+)?(?:\.\d+)?)/i);
  if (!lsaRowMatch) {
    const flexLsaPattern = /Local\s*Service\s*Ads\s+(\d[\d\s]*\d|\d+)\s[\s\S]{0,30}?\$([\d,]+(?:\s\d+)?(?:\.\d+)?)/i;
    lsaRowMatch = hasSpendSection
      ? spendSectionText.match(flexLsaPattern)
      : fullText.match(flexLsaPattern);
  }
  if (lsaRowMatch) {
    const leads = reassembleSplitDigits(lsaRowMatch[1]);
    const crossChecked = crossCheckLeadCount(leads.value, platformQualityTotal.lsa);
    result.marketing.lsa.uniqueLeads = crossChecked.value;
    result.marketing.lsa.adSpend = parseNumber(lsaRowMatch[2].replace(/\s/g, ''));
    confidence["marketing.lsa"] = {
      confidence: crossChecked.confidence,
      source: `LSA: ${crossChecked.value} leads, $${lsaRowMatch[2]} spend${leads.reassembled ? " (lead count reassembled from split digits)" : ""}${crossChecked.note}`,
    };
  } else {
    const lsaLeadsLabel = fullText.match(/LSA\s*Leads\s+(\d+)/i);
    if (lsaLeadsLabel) {
      result.marketing.lsa.uniqueLeads = parseNumber(lsaLeadsLabel[1]);
      confidence["marketing.lsa"] = { confidence: "high", source: `LSA Leads: ${lsaLeadsLabel[1]}` };
    }
    {
      const spendSearchText = hasSpendSection ? spendSectionText : fullText;
      let lsaSpendLabel = spendSearchText.match(/LSA\s*Spend\s+\$?([\d,]+(?:\s\d+)?(?:\.\d+)?)/i);
      if (!lsaSpendLabel && hasSpendSection) {
        lsaSpendLabel = fullText.match(/LSA\s*Spend\s+\$?([\d,]+(?:\s\d+)?(?:\.\d+)?)/i);
      }
      if (lsaSpendLabel) {
        result.marketing.lsa.adSpend = parseNumber(lsaSpendLabel[1].replace(/\s/g, ''));
        if (!lsaLeadsLabel) confidence["marketing.lsa"] = { confidence: "medium", source: `LSA Spend: $${lsaSpendLabel[1]}` };
      }
    }
    if (!lsaLeadsLabel) {
      const lsaLeadsFallback = fullText.match(/Leads\s*from\s*LSA\s+(\d+)/i);
      if (lsaLeadsFallback) {
        result.marketing.lsa.uniqueLeads = parseNumber(lsaLeadsFallback[1]);
        confidence["marketing.lsa"] = { confidence: "medium", source: `LSA leads only: ${lsaLeadsFallback[1]}` };
      }
    }
  }

  // Task #2555 — split-digit-safe leads capture + cross-check (the originally
  // reported bug: Oscar Mendoza's 11 Google Ads leads imported as 1).
  let googleAdsRowMatch = hasSpendSection
    ? spendSectionText.match(/Google\s*Ads\s+(\d[\d\s]*\d|\d+)\s+\$([\d,]+(?:\s\d+)?(?:\.\d+)?)/i)
    : fullText.match(/Google\s*Ads\s+(\d[\d\s]*\d|\d+)\s+\$([\d,]+(?:\s\d+)?(?:\.\d+)?)/i);
  if (!googleAdsRowMatch) {
    const flexPattern = /Google\s*Ads\s+(\d[\d\s]*\d|\d+)\s[\s\S]{0,30}?\$([\d,]+(?:\s\d+)?(?:\.\d+)?)/i;
    googleAdsRowMatch = hasSpendSection
      ? spendSectionText.match(flexPattern)
      : fullText.match(flexPattern);
  }
  if (googleAdsRowMatch) {
    const leads = reassembleSplitDigits(googleAdsRowMatch[1]);
    const crossChecked = crossCheckLeadCount(leads.value, platformQualityTotal.googleAds);
    result.marketing.googleAds.uniqueLeads = crossChecked.value;
    result.marketing.googleAds.adSpend = parseNumber(googleAdsRowMatch[2].replace(/\s/g, ''));
    confidence["marketing.googleAds"] = {
      confidence: crossChecked.confidence,
      source: `Google Ads: ${crossChecked.value} leads, $${googleAdsRowMatch[2]} spend${leads.reassembled ? " (lead count reassembled from split digits)" : ""}${crossChecked.note}`,
    };
  } else {
    const gadsLeadsLabel = fullText.match(/Google\s*Ads\s*Leads\s+(\d+)/i);
    if (gadsLeadsLabel) {
      result.marketing.googleAds.uniqueLeads = parseNumber(gadsLeadsLabel[1]);
      confidence["marketing.googleAds"] = { confidence: "high", source: `Google Ads Leads: ${gadsLeadsLabel[1]}` };
    }
    {
      const spendSearchText = hasSpendSection ? spendSectionText : fullText;
      let gadsSpendLabel = spendSearchText.match(/Google\s*Ads\s*Spend\s+\$?([\d,]+(?:\s\d+)?(?:\.\d+)?)/i);
      if (!gadsSpendLabel && hasSpendSection) {
        gadsSpendLabel = fullText.match(/Google\s*Ads\s*Spend\s+\$?([\d,]+(?:\s\d+)?(?:\.\d+)?)/i);
      }
      if (gadsSpendLabel) {
        result.marketing.googleAds.adSpend = parseNumber(gadsSpendLabel[1].replace(/\s/g, ''));
        if (!gadsLeadsLabel) confidence["marketing.googleAds"] = { confidence: "medium", source: `Google Ads Spend: $${gadsSpendLabel[1]}` };
      }
    }
    if (result.marketing.googleAds.adSpend === 0) {
      const standaloneSpend = fullText.match(/Google\s*Ads\s*Spend[\s\S]{0,80}?\$([\d,]+(?:\s\d+)?(?:\.\d+)?)/i);
      if (standaloneSpend) {
        result.marketing.googleAds.adSpend = parseNumber(standaloneSpend[1].replace(/\s/g, ''));
        confidence["marketing.googleAds.adSpend"] = { confidence: "medium", source: `Google Ads standalone spend: $${standaloneSpend[1]}` };
      }
    }
    if (!gadsLeadsLabel) {
      const googleAdsFallback = fullText.match(/Leads\s*from\s*Google\s*Ads\s+(\d+)/i);
      if (googleAdsFallback) {
        result.marketing.googleAds.uniqueLeads = parseNumber(googleAdsFallback[1]);
        confidence["marketing.googleAds"] = { confidence: "medium", source: `Google Ads leads only: ${googleAdsFallback[1]}` };
      }
    }
  }

  if (result.marketing.lsa.uniqueLeads === 0 && result.marketing.lsa.adSpend > 0) {
    console.log(`[PDF Parser] Zeroing phantom LSA ad spend ($${result.marketing.lsa.adSpend}) - no LSA leads found`);
    result.marketing.lsa.adSpend = 0;
  }
  if (result.marketing.googleAds.uniqueLeads === 0 && result.marketing.googleAds.adSpend > 0) {
    console.log(`[PDF Parser] Zeroing phantom Google Ads ad spend ($${result.marketing.googleAds.adSpend}) - no Google Ads leads found`);
    result.marketing.googleAds.adSpend = 0;
  }

  // === PLATFORM LEAD QUALITY TABLE (legacy format) ===
  let platformLqSection = !platformLqParsed ? fullText.match(/Platform\s*Lead\s*Quality[\s\S]*?Platform\s+Leads\s+(?:Good\s+)?(?:Missed\s+)?(?:Not\s*Quotable\s+)?(?:Missed\s+)?([\s\S]*?)(?:Good\s+\d+|Webinars?|Review\s*Generation|$)/i) : null;
  if (!platformLqSection && !platformLqParsed) {
    platformLqSection = fullText.match(/Platform\s+Leads\s+(?:Good\s+)?Missed\s+Not\s*Quotable\s+Missed\s+([\s\S]*?)$/i);
  }
  if (!platformLqSection && !platformLqParsed) {
    platformLqSection = fullText.match(/Lead\s*Quality\s*Data[\s\S]*?Platform([\s\S]*?)$/i);
  }
  if (platformLqSection) {
    const lqText = platformLqSection[1] || platformLqSection[0];
    
    // Task #2555 — legacy Lead Quality rows are split-digit-safe via a checksum
    // (total == good + missed + notQuotable + noData). The new format carries 5
    // columns (total good missed notQuotable noData); the old format 4 (total
    // missed notQuotable good). We try 5-col first, then 4-col, exactly as the
    // original `\d+`-based patterns did, but now tolerant of split digits.
    const lsaQualityNewFormat = parseLegacyQualityRow(lqText, String.raw`LSA`, 5);
    const lsaQualityOldFormat = parseLegacyQualityRow(lqText, String.raw`LSA`, 4);
    
    if (lsaQualityNewFormat) {
      const [total, good, missed, notQuotable] = lsaQualityNewFormat.cols;
      result.marketing.lsa.leadQuality = { good, notQuotable, missedCalls: missed, noData: Math.max(0, total - good - missed - notQuotable) };
      confidence["marketing.lsa.leadQuality"] = { confidence: "high", source: `LSA quality: ${good}G/${missed}M/${notQuotable}NQ${lsaQualityNewFormat.reassembled ? " (reassembled)" : ""}` };
    } else if (lsaQualityOldFormat) {
      const [total, missed, notQuotable] = lsaQualityOldFormat.cols;
      result.marketing.lsa.leadQuality = {
        good: Math.max(0, total - missed - notQuotable),
        notQuotable, missedCalls: missed, noData: 0,
      };
      confidence["marketing.lsa.leadQuality"] = { confidence: "medium", source: `LSA quality (old format): good calculated${lsaQualityOldFormat.reassembled ? " (reassembled)" : ""}` };
    }

    const googleQualityNewFormat = parseLegacyQualityRow(lqText, String.raw`Google\s*Ads`, 5);
    const googleQualityOldFormat = parseLegacyQualityRow(lqText, String.raw`Google\s*Ads`, 4);
    
    if (googleQualityNewFormat) {
      const [total, good, missed, notQuotable] = googleQualityNewFormat.cols;
      result.marketing.googleAds.leadQuality = { good, notQuotable, missedCalls: missed, noData: Math.max(0, total - good - missed - notQuotable) };
      confidence["marketing.googleAds.leadQuality"] = { confidence: "high", source: `Google Ads quality: ${good}G/${missed}M/${notQuotable}NQ${googleQualityNewFormat.reassembled ? " (reassembled)" : ""}` };
    } else if (googleQualityOldFormat) {
      const [total, missed, notQuotable] = googleQualityOldFormat.cols;
      result.marketing.googleAds.leadQuality = {
        good: Math.max(0, total - missed - notQuotable),
        notQuotable, missedCalls: missed, noData: 0,
      };
      confidence["marketing.googleAds.leadQuality"] = { confidence: "medium", source: `Google Ads quality (old format): good calculated${googleQualityOldFormat.reassembled ? " (reassembled)" : ""}` };
    }

    const gbpQualityNewFormat = parseLegacyQualityRow(lqText, String.raw`GBP`, 5);
    const gbpQualityOldFormat = parseLegacyQualityRow(lqText, String.raw`GBP`, 4);
    
    let gbpQuality = { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };
    if (gbpQualityNewFormat) {
      const [total, good, missed, notQuotable] = gbpQualityNewFormat.cols;
      gbpQuality = { good, notQuotable, missedCalls: missed, noData: Math.max(0, total - good - missed - notQuotable) };
      confidence["marketing.gbp.leadQuality"] = { confidence: "high", source: `GBP quality: ${good}G/${missed}M/${notQuotable}NQ${gbpQualityNewFormat.reassembled ? " (reassembled)" : ""}` };
    } else if (gbpQualityOldFormat) {
      const [total, missed, notQuotable] = gbpQualityOldFormat.cols;
      gbpQuality = { good: Math.max(0, total - missed - notQuotable), notQuotable, missedCalls: missed, noData: 0 };
      confidence["marketing.gbp.leadQuality"] = { confidence: "medium", source: `GBP quality (old format): good calculated${gbpQualityOldFormat.reassembled ? " (reassembled)" : ""}` };
    }

    if (gbpQuality.good > 0 || gbpQuality.missedCalls > 0 || gbpQuality.notQuotable > 0) {
      if (result.marketing.gbpLocations.length > 0) {
        const totalGbpLeads = result.marketing.gbpLocations.reduce((sum, loc) => sum + loc.uniqueLeads, 0);
        if (totalGbpLeads > 0) {
          for (const loc of result.marketing.gbpLocations) {
            const ratio = loc.uniqueLeads / totalGbpLeads;
            loc.leadQuality = {
              good: Math.round(gbpQuality.good * ratio),
              notQuotable: Math.round(gbpQuality.notQuotable * ratio),
              missedCalls: Math.round(gbpQuality.missedCalls * ratio),
              noData: 0,
            };
          }
        }
      } else {
        const gbpTotal = gbpQuality.good + gbpQuality.notQuotable + gbpQuality.missedCalls + gbpQuality.noData;
        result.marketing.gbpLocations = [{
          name: "All Locations",
          uniqueLeads: gbpTotal,
          reviewsGenerated: 0,
          reviewsRespondedTo: 0,
          postsQaCount: 0,
          leadQuality: gbpQuality,
        }];
      }
    }
  } else {
    const leadQualitySection = fullText.match(/Lead\s*Quality\s*Data[\s\S]*?(Platform[\s\S]*?)(?:\d+\s*-\s*\d+\s*\/\s*\d+|$)/i);
    if (leadQualitySection) {
      const lqText = leadQualitySection[1];

      // Task #2555 — split-digit-safe 4-column (total missed notQuotable good)
      // checksum reassembly, same as the primary legacy branch above.
      const lsaQM = parseLegacyQualityRow(lqText, String.raw`LSA`, 4);
      if (lsaQM) {
        const [total, missed, notQuotable] = lsaQM.cols;
        result.marketing.lsa.leadQuality = {
          good: Math.max(0, total - missed - notQuotable), notQuotable, missedCalls: missed, noData: 0,
        };
      }

      const googleQM = parseLegacyQualityRow(lqText, String.raw`Google\s*Ads`, 4);
      if (googleQM) {
        const [total, missed, notQuotable] = googleQM.cols;
        result.marketing.googleAds.leadQuality = {
          good: Math.max(0, total - missed - notQuotable), notQuotable, missedCalls: missed, noData: 0,
        };
      }

      const gbpQM = parseLegacyQualityRow(lqText, String.raw`GBP`, 4);
      if (gbpQM) {
        const [total, missed, notQuotable] = gbpQM.cols;
        const gbpQuality = {
          good: Math.max(0, total - missed - notQuotable), notQuotable, missedCalls: missed, noData: 0,
        };
        if (result.marketing.gbpLocations.length > 0) {
          const totalGbpLeads = result.marketing.gbpLocations.reduce((sum, loc) => sum + loc.uniqueLeads, 0);
          if (totalGbpLeads > 0) {
            for (const loc of result.marketing.gbpLocations) {
              const ratio = loc.uniqueLeads / totalGbpLeads;
              loc.leadQuality = {
                good: Math.round(gbpQuality.good * ratio),
                notQuotable: Math.round(gbpQuality.notQuotable * ratio),
                missedCalls: Math.round(gbpQuality.missedCalls * ratio),
                noData: 0,
              };
            }
          }
        }
      }
    }
  }

  // === AGGREGATE LEAD QUALITY (if not already set from summary labels) ===
  if (result.marketing.leadQuality.good === 0 && result.marketing.leadQuality.missedCalls === 0) {
    let totalGood = 0, totalNotQuotable = 0, totalMissed = 0;
    totalGood += result.marketing.googleAds.leadQuality.good;
    totalNotQuotable += result.marketing.googleAds.leadQuality.notQuotable;
    totalMissed += result.marketing.googleAds.leadQuality.missedCalls;
    totalGood += result.marketing.lsa.leadQuality.good;
    totalNotQuotable += result.marketing.lsa.leadQuality.notQuotable;
    totalMissed += result.marketing.lsa.leadQuality.missedCalls;
    for (const loc of result.marketing.gbpLocations) {
      totalGood += loc.leadQuality.good;
      totalNotQuotable += loc.leadQuality.notQuotable;
      totalMissed += loc.leadQuality.missedCalls;
    }
    result.marketing.leadQuality = {
      good: totalGood,
      notQuotable: totalNotQuotable,
      missedCalls: totalMissed,
      noData: Math.max(0, result.marketing.totalLeads - totalGood - totalNotQuotable - totalMissed),
    };
    if (totalGood > 0) {
      confidence["marketing.leadQuality"] = { confidence: "medium", source: "Aggregated from platform lead quality tables" };
    }
  }

  // === WEBINAR DATA ===
  // Task #2555 — split-digit-safe counts; show rate keeps its `No`-lookbehind.
  const webinarRegistrantsMatch = captureLabeledCount(fullText, String.raw`Registrants`);
  const webinarAttendeesMatch = captureLabeledCount(fullText, String.raw`Attend(?:ees|ed)`);
  const webinarShowRateMatch = captureLabeledCount(fullText, String.raw`(?<!No[\s-]?)Show\s*Rate`, { sep: String.raw`\s+`, countSource: SPLIT_DIGIT_DECIMAL_SOURCE });
  const webinarHotTransfersMatch = captureLabeledCount(fullText, String.raw`(?:Hot\s*Transfers|HT\s*\/\s*Schedules?)`);
  const webinarLeadsMatch = captureLabeledCount(fullText, String.raw`Leads\s*from\s*Webinar`);

  if (webinarRegistrantsMatch) {
    result.marketing.webinar.registrants = webinarRegistrantsMatch.value;
    confidence["marketing.webinar.registrants"] = { confidence: "high", source: `Registrants: ${webinarRegistrantsMatch.value}${webinarRegistrantsMatch.reassembled ? " (reassembled)" : ""}` };
  }
  if (webinarAttendeesMatch) {
    result.marketing.webinar.attendees = webinarAttendeesMatch.value;
    confidence["marketing.webinar.attendees"] = { confidence: "high", source: `Attendees: ${webinarAttendeesMatch.value}${webinarAttendeesMatch.reassembled ? " (reassembled)" : ""}` };
  }
  if (webinarShowRateMatch) {
    result.marketing.webinar.showRate = webinarShowRateMatch.value;
    confidence["marketing.webinar.showRate"] = { confidence: "high", source: `Show Rate: ${webinarShowRateMatch.value}%${webinarShowRateMatch.reassembled ? " (reassembled)" : ""}` };
  }
  if (webinarHotTransfersMatch) {
    result.marketing.webinar.hotTransfers = webinarHotTransfersMatch.value;
    confidence["marketing.webinar.hotTransfers"] = { confidence: "high", source: `Hot Transfers: ${webinarHotTransfersMatch.value}${webinarHotTransfersMatch.reassembled ? " (reassembled)" : ""}` };
  }
  if (webinarLeadsMatch) {
    result.marketing.webinar.leads = webinarLeadsMatch.value;
    confidence["marketing.webinar.leads"] = { confidence: "high", source: `Leads from Webinar: ${webinarLeadsMatch.value}${webinarLeadsMatch.reassembled ? " (reassembled)" : ""}` };
  }
  
  if (result.marketing.webinar.hotTransfers === 0 && result.marketing.webinar.leads > 0) {
    result.marketing.webinar.hotTransfers = result.marketing.webinar.leads;
    confidence["marketing.webinar.hotTransfers"] = { confidence: "medium", source: "Set from webinar leads (assumed = hot transfers)" };
  }

  const htRateMatch = captureLabeledCount(fullText, String.raw`(?:HT|Hot\s*Transfers)\s*\/\s*(?:Schedule\s*Rate|Schedules?\s*Rate|Total\s*Leads)`, { sep: String.raw`\s+`, countSource: SPLIT_DIGIT_DECIMAL_SOURCE });
  if (htRateMatch) {
    result.marketing.webinar.htScheduleRate = htRateMatch.value;
    confidence["marketing.webinar.htScheduleRate"] = { confidence: "high", source: `HT Rate: ${htRateMatch.value}%${htRateMatch.reassembled ? " (reassembled)" : ""}` };
  }

  // === REVIEW GENERATION ===
  // Task #2555 — split-digit-safe review counts.
  const listContactedMatch = captureLabeledCount(fullText, String.raw`List\s*Contacted`);
  const listReviewsMatch = captureLabeledCount(fullText, String.raw`List\s*Reviews`);
  const webinarReviewsMatch = captureLabeledCount(fullText, String.raw`Webinar\s*Reviews`);
  const otherReviewsMatch = captureLabeledCount(fullText, String.raw`Other\s*Reviews`);

  const totalReviewsMatch = fullText.match(/(?:Reviews|Reiews)\s+(\d[\d\s]*\d|\d+)\s+(?:W\s*ebinar|Webinar)\s*Reviews/i);

  if (listContactedMatch) {
    result.marketing.reviewGeneration.listContacted = listContactedMatch.value;
    confidence["marketing.reviewGeneration.listContacted"] = { confidence: "high", source: `List Contacted: ${listContactedMatch.value}${listContactedMatch.reassembled ? " (reassembled)" : ""}` };
  }
  if (listReviewsMatch) {
    result.marketing.reviewGeneration.listReviews = listReviewsMatch.value;
    confidence["marketing.reviewGeneration.listReviews"] = { confidence: "high", source: `List Reviews: ${listReviewsMatch.value}${listReviewsMatch.reassembled ? " (reassembled)" : ""}` };
  }
  if (webinarReviewsMatch) {
    result.marketing.reviewGeneration.webinarReviews = webinarReviewsMatch.value;
    confidence["marketing.reviewGeneration.webinarReviews"] = { confidence: "high", source: `Webinar Reviews: ${webinarReviewsMatch.value}${webinarReviewsMatch.reassembled ? " (reassembled)" : ""}` };
  }
  if (otherReviewsMatch) {
    result.marketing.reviewGeneration.otherCount = otherReviewsMatch.value;
    confidence["marketing.reviewGeneration.otherCount"] = { confidence: "high", source: `Other Reviews: ${otherReviewsMatch.value}${otherReviewsMatch.reassembled ? " (reassembled)" : ""}` };
  }
  if (totalReviewsMatch) {
    const tr = reassembleSplitDigits(totalReviewsMatch[1]);
    result.marketing.reviewGeneration.totalReviews = tr.value;
    confidence["marketing.reviewGeneration.totalReviews"] = { confidence: "high", source: `Reviews (total): ${tr.value}${tr.reassembled ? " (reassembled)" : ""}` };
  }

  // === OTHER LEADS ===
  // Task #2555 — split-digit-safe other-source lead counts.
  const socialMediaMatch = captureLabeledCount(fullText, String.raw`So(?:c?i|i?c)al\s*Media\s*Leads`);
  const directCallMatch = captureLabeledCount(fullText, String.raw`Direct\s*Call\s*Leads`);
  const referralMatch = captureLabeledCount(fullText, String.raw`Referral\s*Leads`);

  if (socialMediaMatch) {
    result.marketing.otherLeads.socialMedia = socialMediaMatch.value;
    confidence["marketing.otherLeads.socialMedia"] = { confidence: "high", source: `Social Media Leads: ${socialMediaMatch.value}${socialMediaMatch.reassembled ? " (reassembled)" : ""}` };
  }
  if (directCallMatch) {
    result.marketing.otherLeads.directCalls = directCallMatch.value;
    confidence["marketing.otherLeads.directCalls"] = { confidence: "high", source: `Direct Call Leads: ${directCallMatch.value}${directCallMatch.reassembled ? " (reassembled)" : ""}` };
  }
  if (referralMatch) {
    result.marketing.otherLeads.referrals = referralMatch.value;
    confidence["marketing.otherLeads.referrals"] = { confidence: "high", source: `Referral Leads: ${referralMatch.value}${referralMatch.reassembled ? " (reassembled)" : ""}` };
  }
  const otherLeadsSum = result.marketing.otherLeads.socialMedia + result.marketing.otherLeads.directCalls + result.marketing.otherLeads.referrals;
  if (otherLeadsSum > 0 || result.marketing.otherLeads.total === 0) {
    result.marketing.otherLeads.total = otherLeadsSum;
  }

  if (result.marketing.otherLeads.total === 0) {
    const otherLeadsTotalMatch = fullText.match(/Other\s*(?:Leads|Sources)\s+(\d+)/i)
      || fullText.match(/Other\s+(\d+)(?!\s*[%.$])/i);
    if (otherLeadsTotalMatch) {
      result.marketing.otherLeads.total = parseNumber(otherLeadsTotalMatch[1]);
      confidence["otherLeads"] = { confidence: "medium", source: `Other leads total fallback: ${otherLeadsTotalMatch[1]}` };
    }
  }

  // === Task #2753 — Total-Leads reliability reconciliation ==================
  // Runs BEFORE the Other-residual math and the Task #2555 per-source clamp
  // below, because both use totalLeads as the trustworthy ceiling. When the
  // per-source evidence (each GBP location, Google Ads, LSA, Webinar) minus
  // its single largest member still exceeds the parsed total, the total —
  // not the sources — is the misread value (e.g. "Total Leads 1" vs ~595
  // platform leads on the June 2026 Jones Law Firm report). Recompute the
  // total from the summed sources (+ Other) instead of letting the clamp
  // crush every source down to the bad total. A genuine single-source
  // split-digit overshoot of a trustworthy total is NOT affected: excluding
  // that one source the remainder fits inside the total, so the #2555 clamp
  // below still handles it.
  {
    const sourceCounts = [
      ...result.marketing.gbpLocations.map((loc) => loc.uniqueLeads),
      result.marketing.googleAds.uniqueLeads,
      result.marketing.lsa.uniqueLeads,
      result.marketing.webinar.leads,
    ];
    const rec = reconcileTotalLeadsAgainstSources(
      result.marketing.totalLeads,
      sourceCounts,
      result.marketing.otherLeads.total,
    );
    if (rec.unreliable) {
      console.log(
        `[PDF Parser] Total Leads (${result.marketing.totalLeads}) is implausibly small vs per-source evidence ` +
        `(sum=${rec.sourceSum}, support excluding largest=${rec.supportExcludingLargest}); ` +
        `recomputing total from sources → ${rec.correctedTotal} (Task #2753 — parsed total treated as misread, sources preserved).`,
      );
      confidence["marketing.totalLeads"] = {
        confidence: "medium",
        source: `Recomputed from per-source sum ${rec.sourceSum} + Other ${result.marketing.otherLeads.total} — parsed total ${result.marketing.totalLeads} contradicted by multiple sources (Task #2753)`,
      };
      result.marketing.totalLeads = rec.correctedTotal;
    }
  }

  if (result.marketing.otherLeads.total === 0 && result.marketing.totalLeads > 0) {
    const gbpLeads = result.marketing.gbpLocations.reduce((sum, loc) => sum + loc.uniqueLeads, 0);
    const knownPlatformLeads = gbpLeads
      + result.marketing.googleAds.uniqueLeads
      + result.marketing.lsa.uniqueLeads
      + result.marketing.webinar.leads;
    const residual = result.marketing.totalLeads - knownPlatformLeads;
    if (residual > 0) {
      result.marketing.otherLeads.total = residual;
      confidence["otherLeads"] = { confidence: "low", source: `Other leads residual: ${result.marketing.totalLeads} total - ${knownPlatformLeads} known = ${residual}` };
    }
  }

  if (result.marketing.otherLeads.total > 0 && result.marketing.totalLeads > 0) {
    const gbpLeads = result.marketing.gbpLocations.reduce((sum, loc) => sum + loc.uniqueLeads, 0);
    const knownPlatformLeads = gbpLeads
      + result.marketing.googleAds.uniqueLeads
      + result.marketing.lsa.uniqueLeads
      + result.marketing.webinar.leads;
    const maxOther = result.marketing.totalLeads - knownPlatformLeads;
    if (maxOther < 0) {
      console.log(`[PDF Parser] Known platform leads (${knownPlatformLeads}) exceed total (${result.marketing.totalLeads}), zeroing Other leads`);
      result.marketing.otherLeads.total = 0;
    } else if (result.marketing.otherLeads.total > maxOther) {
      console.log(`[PDF Parser] Capping Other leads from ${result.marketing.otherLeads.total} to ${maxOther} to avoid double-counting (total=${result.marketing.totalLeads}, known=${knownPlatformLeads})`);
      result.marketing.otherLeads.total = maxOther;
    }
  }

  // === Task #2555 — per-source sanity guardrail =============================
  // A split-digit reassembly that went wrong (e.g. "1 1 5" merged into 115)
  // would inflate one source above the report's own Total Leads. No single
  // source can legitimately exceed the total, so clamp it and annotate the
  // confidence so a reviewer sees the correction rather than a silent bad value.
  if (result.marketing.totalLeads > 0) {
    const total = result.marketing.totalLeads;
    const clampSource = (current: number, key: string, label: string): number => {
      if (current > total) {
        console.log(`[PDF Parser] ${label} leads (${current}) exceed Total Leads (${total}); clamping.`);
        confidence[key] = { confidence: "low", source: `${label} leads ${current} exceeded total ${total} — clamped (possible split-digit misread)` };
        return total;
      }
      return current;
    };
    result.marketing.googleAds.uniqueLeads = clampSource(result.marketing.googleAds.uniqueLeads, "marketing.googleAds.uniqueLeads", "Google Ads");
    result.marketing.lsa.uniqueLeads = clampSource(result.marketing.lsa.uniqueLeads, "marketing.lsa.uniqueLeads", "LSA");
    result.marketing.webinar.leads = clampSource(result.marketing.webinar.leads, "marketing.webinar.leads", "Webinar");
    for (const loc of result.marketing.gbpLocations) {
      if (loc.uniqueLeads > total) {
        console.log(`[PDF Parser] GBP location "${loc.name}" leads (${loc.uniqueLeads}) exceed Total Leads (${total}); clamping.`);
        loc.uniqueLeads = total;
      }
    }
  }

  result.fieldConfidence = confidence;

  (result as ParsedReportData & { _extractedText?: string })._extractedText = fullText;

  return result as ParsedReportData & { _extractedText?: string };
}

/**
 * Task #3769 — trailing source-name artifact that Looker appends after the
 * "missing data source" placeholder, e.g. "Name_Clean (1): Ackah Law".
 * Matches the underscored ("Name_Clean"), spaced ("Name Clean"), and
 * collapsed ("NameClean") spellings; letter-spaced variants are folded by
 * collapseSpacedLetters before this regex runs. Two guards keep a genuinely
 * mixed body (real findings after the artifact) from being swallowed:
 *   1. the tail after "(N):" is capped at 10 words, and
 *   2. it must contain NO sentence punctuation (. ! ?) apart from one
 *      optional trailing period — real findings are sentences.
 * Runs against lowercased, whitespace-collapsed, dash-normalized text
 * BEFORE punctuation is stripped (so guard 2 can see the punctuation).
 */
const NAME_CLEAN_ARTIFACT_TAIL_RE =
  /(?:^|[\s-])name[\s_]*clean[\s…]*\(\s*\d+\s*\)\s*:?\s*(?:[^\s.!?]+(?:\s+[^\s.!?]+){0,9})?\.?\s*$/i;

/**
 * Strip one trailing "Name_Clean (N): <source name>" artifact (all known
 * spellings, letter-spaced included). Exported for tests.
 */
export function stripNameCleanArtifactTail(normalizedLower: string): string {
  return collapseSpacedLetters(normalizedLower).replace(NAME_CLEAN_ARTIFACT_TAIL_RE, " ");
}
