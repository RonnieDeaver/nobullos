import { openai } from "../routes/middleware";
import { CHEAP_MODEL } from "../aiModels";
import { sanitizePromptInput } from "./atsTypes";
import { isMissingDataSourceDerivedBody } from "./pdfImportParser";
import {
  type ConsultType,
  type SeverityBand,
  getSectionSeverityBand,
  getSectionTargetRate,
} from "@shared/commonIssuesSeverity";

/**
 * Task #2460 — optional performance context that scales the formatter's tone
 * with how the firm is actually performing against its conversion goal.
 * Intake tone is driven by the Lead-to-Consult rate vs the intake goal, Sales
 * tone by the Consult-to-Case rate vs the sales goal (free-vs-paid aware). When
 * omitted, the formatter keeps its original neutral, substance-only behavior.
 */
export interface CommonIssuesMetricContext {
  /** The section's conversion rate (Lead-to-Consult for intake, Consult-to-Case for sales). */
  rate: number;
  /** Client consult type — selects the free-vs-paid goal/threshold set. */
  consultType: ConsultType;
}

/**
 * Build the tone guidance appended to the formatter system prompt for a given
 * severity band. Returns "" when there is no context (neutral behavior).
 */
function buildToneGuidance(
  section: "intake" | "sales",
  ctx: CommonIssuesMetricContext | undefined,
): string {
  if (!ctx) return "";
  const metricLabel =
    section === "sales" ? "Consult-to-Case rate" : "Lead-to-Consult rate";
  const target = getSectionTargetRate(section, ctx.consultType);
  const band: SeverityBand = getSectionSeverityBand(
    section,
    ctx.rate,
    ctx.consultType,
  );

  const toneByBand: Record<SeverityBand, string> = {
    healthy: `This firm is AT OR ABOVE its goal (healthy). Set a gentle, encouraging tone: open the output with ONE brief sentence acknowledging the strong performance (no 🔴 prefix on that opening line), then present each issue. Reframe every Strategic Fix as a light, OPTIONAL suggestion for incremental improvement (e.g. "Consider…", "You might…") — never as a "must-fix" mandate or a crisis. Do NOT use alarming or damning language.`,
    issue: `This firm is slightly below goal (small miss). Set a mild, constructive tone: frame issues as clear opportunities to tighten up, with practical fixes. Be direct but not alarming.`,
    big_issue: `This firm is meaningfully below goal (bigger miss). Set a firm tone: make clear these issues are materially hurting results and the fixes should be prioritized. More pointed than constructive, but not yet a crisis.`,
    critical: `This firm is critically below goal. Set an urgent, direct, high-priority tone: make the cost of inaction explicit and the fixes non-negotiable must-fixes. This is the most severe band — be candid and unflinching.`,
  };

  return `

PERFORMANCE-AWARE TONE:
- This section's ${metricLabel} is ${ctx.rate} vs a goal of ${target} (${ctx.consultType} consults) → severity: ${band}.
- ${toneByBand[band]}
- IMPORTANT: Only the FRAMING/URGENCY changes with performance. PRESERVE the substance of every imported issue, impact, and fix — do not drop, invent, or change the meaning of any issue. Keep the exact 🔴 / ↳ / ➡️ structure described above (aside from the optional single positive opening line in the healthy case).`;
}

/**
 * Task #2389 — shared Common Issues formatter.
 *
 * Background:
 *   The 🔴 Issue / ↳ Impact / ➡️ Strategic Fix structure (Task #234) was only
 *   produced client-side, after an interactive import, by POST
 *   /api/ai/format-issues — and it silently fell back to the raw OCR blob when
 *   the AI call failed. The webhook auto-draft import stored the raw blob with
 *   no formatting at all. This module centralizes the formatting so EVERY
 *   import path can produce clean, scannable Common Issues by default.
 *
 * Two layers:
 *   1. `formatCommonIssuesWithAi` — the original AI prompt + missing-data-source
 *      guard, factored out so import code can call it.
 *   2. `deterministicFormatCommonIssues` — a non-AI fallback that fixes common
 *      OCR spacing artifacts and splits the blob on Issue / Impact / Strategic
 *      Fix markers so it never renders as a single wall-of-text paragraph. It
 *      never throws — worst case it returns the lightly-cleaned text.
 *
 *   `formatCommonIssuesContent` ties them together: it tries the AI formatter
 *   and, on any failure or empty result, degrades to the deterministic one.
 */

/** AI prompt is too long / risky to send — fall straight to deterministic. */
const MAX_AI_INPUT_CHARS = 5000;

/**
 * Curated OCR spacing fixes. PDF text extraction frequently glues a short
 * function word onto an adjacent word ("delivera" = "deliver a", "bya" =
 * "by a") or splits a word with a stray space ("of fers" = "offers"). A
 * generic rule (e.g. "split any word ending in 'a'") would corrupt real
 * words like "idea", so we only correct a curated, high-confidence set.
 */
const OCR_FIXES: Array<[RegExp, string]> = [
  [/\bof fers\b/gi, "offers"],
  [/\bef fectively\b/gi, "effectively"],
  [/\bef fective\b/gi, "effective"],
  [/\bfollow up\b/gi, "follow-up"],
  [/\bdelivera\b/gi, "deliver a"],
  [/\bcreatea\b/gi, "create a"],
  [/\bprovidea\b/gi, "provide a"],
  [/\bbya\b/gi, "by a"],
  [/\bofa\b/gi, "of a"],
  [/\btoa\b/gi, "to a"],
  [/\bina\b/gi, "in a"],
  [/\bona\b/gi, "on a"],
  [/\bisa\b/gi, "is a"],
  [/\bfora\b/gi, "for a"],
];

/** Apply the curated OCR fixes; preserves casing of surrounding text. */
function cleanOcrArtifacts(text: string): string {
  let out = text;
  for (const [re, replacement] of OCR_FIXES) {
    out = out.replace(re, replacement);
  }
  return out;
}

/** Build one structured 🔴 / ↳ / ➡️ block from a single issue body. */
function formatIssueBlock(body: string): string {
  let remaining = body.trim();
  let impactText = "";
  let fixText = "";

  const fixMatch = remaining.match(/Strategic\s*Fix\s*:\s*([\s\S]*)$/i);
  if (fixMatch) {
    fixText = fixMatch[1].trim();
    remaining = remaining.slice(0, fixMatch.index).trim();
  }

  const impactMatch = remaining.match(/Impact\s*:\s*([\s\S]*)$/i);
  if (impactMatch) {
    impactText = impactMatch[1].trim();
    remaining = remaining.slice(0, impactMatch.index).trim();
  }

  const issueText = remaining.trim();
  const lines: string[] = [];
  if (issueText) lines.push(`🔴 **Issue:** ${issueText}`);
  if (impactText) lines.push(`↳ **Impact:** ${impactText}`);
  if (fixText) lines.push(`> ➡️ **Strategic Fix:** ${fixText}`);
  return lines.join("\n");
}

/** Split prose into sentence-ish chunks for the no-marker fallback. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Task #3770 — canonical 🔴 / ↳ / ➡️ structure markers. Text bearing these is
 * (or claims to be) formatter output; the structure normalizer below only
 * ever touches marker-bearing text so arbitrary prose is never rewritten.
 */
const CANONICAL_STRUCTURE_MARKER_RE =
  /🔴[ \t]*\*\*Issue:|↳|➡️[ \t]*\*\*Strategic Fix:/u;

/**
 * Task #3770 — deterministic structure normalizer.
 *
 * The July 2026 Ackah import stored an AI reply whose canonical markers were
 * all on ONE line ("… calls ↳ **Impact:** … > ➡️ **Strategic Fix:** … --- 🔴
 * **Issue:** …"). Markdown only treats `---` as a divider and `>` as a
 * blockquote at line starts, so that row rendered as a wall of text with
 * literal `---`/`>` characters. This normalizer re-inserts the line structure
 * the markers imply:
 *   - a blank line + real divider line for each inline ` --- `,
 *   - a line break before each ↳ impact marker,
 *   - a line break before each `> ➡️ **Strategic Fix:**` (adding the missing
 *     `>` blockquote prefix when the AI dropped it),
 *   - a blank line before each subsequent `🔴 **Issue:**` block, and
 *   - blank lines around pre-existing `---` lines (a `---` directly under a
 *     text line would otherwise turn that line into a setext heading).
 *
 * Properties: pure, idempotent (normalize(normalize(x)) === normalize(x)),
 * and a no-op for text without the canonical markers AND for already
 * well-formed marker output. Applied to every formatter result before it is
 * returned/stored, and at serve time as a safety net for rows poisoned
 * before this shipped.
 */
export function normalizeCommonIssuesStructure(
  text: string | null | undefined,
): string {
  if (!text) return "";
  const src = String(text);
  if (!CANONICAL_STRUCTURE_MARKER_RE.test(src)) return src;

  let out = src;

  // Inline " --- " → a real divider line (blank lines on both sides).
  out = out.replace(/[ \t]+---(?=\s|$)/g, "\n\n---\n\n");

  // Line break before each ↳ impact marker not already at line start.
  out = out.replace(/([^\n])[ \t]*(?=↳)/gu, "$1\n");

  // Line break before an inline "> ➡️ **Strategic Fix:**" (keep the ">").
  out = out.replace(
    /([^\n])[ \t]*>[ \t]*(?=➡️[ \t]*\*\*Strategic)/gu,
    "$1\n> ",
  );
  // Same for a bare "➡️ **Strategic Fix:**" missing the blockquote prefix.
  out = out.replace(
    /([^>\n\s])[ \t]*(?=➡️[ \t]*\*\*Strategic)/gu,
    "$1\n> ",
  );

  // Blank line before each subsequent 🔴 **Issue:** block.
  out = out.replace(/([^\n])[ \t]*(?=🔴[ \t]*\*\*Issue)/gu, "$1\n\n");

  // Blank-line discipline around pre-existing `---` lines: "text\n---" is a
  // setext HEADING in markdown, not a divider.
  out = out.replace(/([^\n])\n---[ \t]*(?=\n|$)/g, "$1\n\n---");
  out = out.replace(/(^|\n)---[ \t]*\n(?!\n)/g, "$1---\n\n");

  // Cleanup: trim line edges, collapse blank-line runs, trim, and drop a
  // trailing divider (canonical format has no trailing ---).
  out = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  out = out.replace(/\n+---$/, "").trim();
  return out;
}

/**
 * Task #4227 — quality/length floor for Common Issues copy.
 *
 * A real finalized January 2026 report shipped "🔴 Issue: Being Bad →
 * Impact: Poor behavior…" to a paying law firm (and into its PDF). This
 * detector flags such thin/degenerate copy so (a) the formatter can refuse a
 * degenerate AI generation and fall back to the deterministic formatter on
 * the raw input, and (b) the finalize gate can force an explicit operator
 * confirm before a report carrying it reaches "Final".
 *
 * Heuristic (deliberately conservative — flags only clearly-embarrassing
 * copy, never healthy sentences):
 *   - Marker-formatted text: every `**Issue:**` / `**Impact:**` body must
 *     have ≥ 3 words AND ≥ 20 characters ("Being Bad" = 2 words / 9 chars,
 *     "Poor behavior" = 2 words / 13 chars — both fail; any real sentence
 *     passes).
 *   - Unmarked prose: the whole trimmed text must be ≥ 40 characters.
 *   - Empty / non-string input is NOT degenerate — an empty section renders
 *     the neutral "No issues identified", which is fine.
 */
export interface CommonIssuesQualityProblem {
  /** Which floor failed. */
  reason: "thin_issue" | "thin_impact" | "thin_text";
  /** The offending body text (trimmed), for operator-facing messages. */
  snippet: string;
}

const MIN_BODY_WORDS = 3;
const MIN_BODY_CHARS = 20;
const MIN_UNMARKED_CHARS = 40;

function bodyIsThin(body: string): boolean {
  const words = body.split(/\s+/).filter(Boolean);
  return words.length < MIN_BODY_WORDS || body.length < MIN_BODY_CHARS;
}

/**
 * Task #4543 — exported thin-body predicate (the exact floor the finalize
 * gate applies to `**Issue:**` / `**Impact:**` bodies), so the degenerate-
 * copy repair backfill judges individual lines with the gate's own rule.
 */
export function isThinCommonIssuesBody(body: string): boolean {
  return bodyIsThin(body.trim());
}

export function findDegenerateCommonIssues(
  value: unknown,
): CommonIssuesQualityProblem[] {
  if (typeof value !== "string") return [];
  const text = normalizeCommonIssuesStructure(value).trim();
  if (!text) return [];

  const problems: CommonIssuesQualityProblem[] = [];

  if (CANONICAL_STRUCTURE_MARKER_RE.test(text)) {
    for (const line of text.split("\n")) {
      const issueMatch = line.match(/\*\*Issue:\*\*\s*(.*)$/u);
      if (issueMatch) {
        const body = issueMatch[1].trim();
        if (bodyIsThin(body)) {
          problems.push({ reason: "thin_issue", snippet: body });
        }
        continue;
      }
      const impactMatch = line.match(/\*\*Impact:\*\*\s*(.*)$/u);
      if (impactMatch) {
        const body = impactMatch[1].trim();
        if (bodyIsThin(body)) {
          problems.push({ reason: "thin_impact", snippet: body });
        }
      }
    }
    return problems;
  }

  if (text.length < MIN_UNMARKED_CHARS) {
    problems.push({ reason: "thin_text", snippet: text });
  }
  return problems;
}

/** Convenience boolean wrapper over `findDegenerateCommonIssues`. */
export function isDegenerateCommonIssues(value: unknown): boolean {
  return findDegenerateCommonIssues(value).length > 0;
}

/**
 * Task #3770 — detector for the stored malformed shape: canonical markers
 * present but NO line breaks at all, where normalization would actually
 * change the text. Used by the reformat backfill to revive stamped-but-
 * poisoned rows; the `normalize !== text` clause keeps the revival
 * self-extinguishing (a legitimately short single-line block that the
 * normalizer leaves alone is NOT flagged, so it can never re-arm the action
 * forever).
 */
export function needsCommonIssuesStructureRepair(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  if (value.includes("\n")) return false;
  if (!CANONICAL_STRUCTURE_MARKER_RE.test(value)) return false;
  return normalizeCommonIssuesStructure(value) !== value;
}

/**
 * Task #4054 — single storage gate for Common Issues text: every write path
 * that persists an intake/sales `commonIssues` value AND stamps it with the
 * reformat-backfill convergence marker must run the text through this first.
 *
 * It (1) normalizes the structure on write (the same idempotent
 * `normalizeCommonIssuesStructure` the formatter and serve path use), and
 * (2) reports whether the RESULT is actually well-formed — i.e. the stored
 * malformed-shape detector (`needsCommonIssuesStructureRepair`) no longer
 * flags it. Callers stamp the section as formatted ONLY when `stampable` is
 * true, so a section can never again be born "stamped but malformed" and get
 * caught days later by the backfill's revival arm (the #3533-era feeder).
 * Empty / non-string input finalizes to "" and is stampable (nothing to
 * repair). Because normalize is idempotent and the detector only flags text
 * normalize would change, `stampable` is false only for text the normalizer
 * genuinely cannot fix — which then stays unstamped and is picked up by the
 * regular reformat backfill instead of the late revival arm.
 */
export function finalizeCommonIssuesForStorage(value: unknown): {
  text: string;
  stampable: boolean;
} {
  const raw = typeof value === "string" ? value : "";
  const text = normalizeCommonIssuesStructure(raw);
  return { text, stampable: !needsCommonIssuesStructureRepair(text) };
}

/**
 * Deterministic, never-throws fallback formatter. Cleans common OCR spacing
 * artifacts and breaks the blob into separate issues/lines so it never renders
 * as a single run-on paragraph. Returns "" for empty/placeholder input.
 */
export function deterministicFormatCommonIssues(
  raw: string | null | undefined,
): string {
  try {
    if (!raw || !String(raw).trim()) return "";
    if (isMissingDataSourceDerivedBody(raw)) {
      return "";
    }

    let text = cleanOcrArtifacts(String(raw));
    text = text.replace(/\s+/g, " ").trim();

    // Task #3770 — input already bearing the canonical 🔴/↳/➡️ markers (e.g.
    // a stored malformed single-line AI reply being re-formatted) is repaired
    // by re-inserting line structure. The generic "Issue N:" split below
    // would mangle it ("**Issue:**" matches the split regex and shreds the
    // bold markers into broken fragments).
    if (CANONICAL_STRUCTURE_MARKER_RE.test(text)) {
      const normalized = normalizeCommonIssuesStructure(text);
      if (normalized.trim()) return normalized;
    }

    const hasIssueMarkers = /Issue\s*\d*\s*:/i.test(text);
    if (hasIssueMarkers) {
      const parts = text
        .split(/(?=Issue\s*\d*\s*:)/i)
        .map((p) => p.replace(/^Issue\s*\d*\s*:\s*/i, "").trim())
        .filter(Boolean);
      const blocks = parts.map(formatIssueBlock).filter(Boolean);
      if (blocks.length > 0) return blocks.join("\n\n---\n\n");
    }

    // No "Issue N:" markers, but Impact:/Strategic Fix: present → one block.
    if (/(Impact|Strategic\s*Fix)\s*:/i.test(text)) {
      const block = formatIssueBlock(text);
      if (block) return block;
    }

    // No markers at all — break a run-on paragraph into a bullet list so it is
    // at least scannable. Single-sentence input is returned lightly cleaned.
    const sentences = splitSentences(text);
    if (sentences.length > 1) {
      return sentences.map((s) => `- ${s}`).join("\n");
    }
    return text;
  } catch {
    // Absolute last resort: never throw from the fallback.
    return raw ? String(raw).replace(/\s+/g, " ").trim() : "";
  }
}

/**
 * Calls OpenAI to format the raw Common Issues text into the canonical
 * 🔴 Issue / ↳ Impact / ➡️ Strategic Fix markdown. Throws on API failure so
 * callers can decide whether to degrade. Returns "" when the body is an empty
 * / "missing data source" placeholder (Task #1267 guard preserved).
 */
export async function formatCommonIssuesWithAi(
  text: string,
  section: "intake" | "sales",
  metricContext?: CommonIssuesMetricContext,
): Promise<string> {
  if (isMissingDataSourceDerivedBody(text)) {
    return "";
  }
  const sectionLabel = section === "sales" ? "Sales" : "Intake";
  const toneGuidance = buildToneGuidance(section, metricContext);
  const response = await openai.chat.completions.create({
    model: CHEAP_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a formatting assistant for law firm performance reports. Format the following raw ${sectionLabel} common issues text into clean, visually distinct markdown. Use this exact format for each issue:

🔴 **Issue:** [Root behavior or problem ONLY — what is being done wrong, with NO mention of consequences or results]
↳ **Impact:** [Downstream consequence or result of the issue]
> ➡️ **Strategic Fix:** [Actionable recommendation]

---

Rules:
- Each issue gets a red circle emoji (🔴) prefix
- The Issue line must contain ONLY the root behavior or problem — the thing being done wrong. Do NOT include any consequences, results, or "which leads to..." language on the Issue line.
- Immediately after the Issue line, add an Impact line starting with "↳ **Impact:**" that explains the downstream consequence or result of that issue.
- Each strategic fix goes on a new line as a blockquote (>) with an arrow emoji (➡️)
- Add a horizontal rule (---) between each issue-fix group for clear visual separation
- Fix any OCR artifacts (e.g., "ofa" → "of a", "ef fectively" → "effectively", "createa" → "create a")
- Keep the substance exactly as written — do not add new analysis or change meanings
- Keep it concise and professional
- Do NOT add a trailing --- after the last item
- Return ONLY the formatted issues, no preamble or closing text${toneGuidance}`,
      },
      { role: "user", content: sanitizePromptInput(text) },
    ],
    reasoning_effort: "minimal",
    // Task #3770 — CHEAP_MODEL is a reasoning model whose thinking tokens
    // count against max_completion_tokens. The July 2026 Ackah import hit the
    // old 3000 cap with only ~320 tokens of visible output (the rest went to
    // reasoning), storing a mid-sentence-truncated reply. Roomier budget so
    // reasoning can never starve the visible formatted text.
    max_completion_tokens: 8000,
  });
  const choice = response.choices[0];
  // Task #3770 — a length-capped reply is malformed by construction (cut off
  // mid-sentence, and historically also stripped of its line breaks). Treat
  // truncation as a formatter failure so formatCommonIssuesContent degrades
  // to the deterministic fallback on the RAW input — same contract as the
  // Ads OS OpenAI helper's finish_reason=length check.
  if (choice?.finish_reason === "length") {
    throw new Error("ai_truncated");
  }
  // Task #3770 — never return a marker-bearing single-line reply: re-insert
  // the line structure the markers imply (no-op for well-formed output).
  return normalizeCommonIssuesStructure(choice?.message?.content || "");
}

export interface FormatCommonIssuesResult {
  /** The formatted markdown (may be "" for empty/placeholder input). */
  formatted: string;
  /** True when the AI formatter was unavailable and we used the fallback. */
  degraded: boolean;
  /** Short machine-readable reason when degraded. */
  reason?: string;
}

/**
 * Shared entry point: format Common Issues with the AI formatter, degrading to
 * the deterministic fallback on any failure or empty AI result. Never throws.
 */
export async function formatCommonIssuesContent(
  text: string | null | undefined,
  section: "intake" | "sales",
  metricContext?: CommonIssuesMetricContext,
): Promise<FormatCommonIssuesResult> {
  if (!text || !String(text).trim()) {
    return { formatted: "", degraded: false };
  }
  // Empty / "missing data source" placeholder (any derived class, Task
  // #3901 included) → store nothing (Task #1267).
  if (isMissingDataSourceDerivedBody(text)) {
    return { formatted: "", degraded: false };
  }

  if (String(text).length > MAX_AI_INPUT_CHARS) {
    return {
      formatted: deterministicFormatCommonIssues(text),
      degraded: true,
      reason: "too_long_for_ai",
    };
  }

  try {
    const aiFormatted = await formatCommonIssuesWithAi(
      String(text),
      section,
      metricContext,
    );
    if (aiFormatted && aiFormatted.trim()) {
      // Task #4227 — refuse a degenerate AI generation when the raw input
      // has real substance: the deterministic formatter (which preserves the
      // source text verbatim) then wins. When the RAW input is itself
      // degenerate ("Being Bad"), both paths are thin — the finalize gate is
      // the backstop that names it to the operator.
      if (
        isDegenerateCommonIssues(aiFormatted) &&
        !isDegenerateCommonIssues(deterministicFormatCommonIssues(text))
      ) {
        return {
          formatted: deterministicFormatCommonIssues(text),
          degraded: true,
          reason: "ai_degenerate",
        };
      }
      return { formatted: aiFormatted, degraded: false };
    }
    return {
      formatted: deterministicFormatCommonIssues(text),
      degraded: true,
      reason: "ai_empty",
    };
  } catch (error: any) {
    return {
      formatted: deterministicFormatCommonIssues(text),
      degraded: true,
      reason: error?.message || "ai_error",
    };
  }
}
