/**
 * Task #4273 — per-slide verdict sentence system (audit §8.1-1).
 *
 * One plain-language verdict sentence per major report slide ("Intake is
 * leaking ~$18K/mo — answer speed is the fix."), authored in the report
 * editor (operators may invoke the per-slide "Draft with AI" helper there —
 * human in the loop; Task #4902 removed the finalize-time auto-drafting),
 * stored in ONE report_sections row under an internal key (see
 * server/services/slideVerdicts.ts) and served on the share/preview/demo
 * payloads as a `slideVerdicts` map.
 *
 * This module is the single source of truth shared by client and server for:
 *   - the slide-key set (the audit §8.7 slides the queued redesign tasks
 *     adopt verdicts on) — listed in DECK order (Engine Health → Marketing →
 *     Intake → Sales → Revenue Leak; Tasks #4522/#4538) since the editor's
 *     Verdicts tab and the AI-draft prompt enumerate in array order,
 *   - the length/quality floor (finalize gate + AI-output filter + editor
 *     inline hint all call the SAME `findDegenerateVerdict`),
 *   - the focused zod schema for the section write path.
 */
import { z } from "zod";

// Task #4902 — `lifetimeValue` retired by owner decision: the Lifetime Value
// slide carries NO verdict line at all (not even operator-written). Removing
// the key here retires every key-set-driven surface at once (editor tab slot,
// finalize floor gate, draft-endpoint validation) and makes the zod schema +
// sanitizeSlideVerdictMap strip legacy stored `lifetimeValue` entries from
// editor saves and served share/preview/demo payloads.
export const SLIDE_VERDICT_KEYS = [
  "marketContext",
  "engineHealth",
  "marketing",
  "intake",
  "sales",
  "revenueLeak",
  "next30Days",
] as const;

export type SlideVerdictKey = (typeof SLIDE_VERDICT_KEYS)[number];

/** Sparse map: only slides with an authored/generated verdict carry a key. */
export type SlideVerdictMap = Partial<Record<SlideVerdictKey, string>>;

export const SLIDE_VERDICT_LABELS: Record<SlideVerdictKey, string> = {
  marketContext: "Market Context",
  engineHealth: "Engine Health",
  revenueLeak: "Revenue Leak",
  intake: "Intake",
  sales: "Sales",
  marketing: "Marketing",
  next30Days: "Next 30 Days",
};

/**
 * Quality floor (publish bar, enforced at finalize + on AI output — NOT on
 * draft saves, which must stay friction-free mid-edit; #4227 precedent).
 * The reference verdict "Intake is leaking ~$18K/mo — answer speed is the
 * fix." is 53 chars / 10 words.
 */
export const VERDICT_MIN_CHARS = 20;
export const VERDICT_MAX_CHARS = 240;
export const VERDICT_MIN_WORDS = 4;
/** Save-time hard shape cap (abuse guard only — floor is checked at finalize). */
export const VERDICT_SHAPE_MAX_CHARS = 500;

export type VerdictProblemReason =
  | "too_short"
  | "too_long"
  | "too_few_words"
  | "repetitive"
  | "placeholder";

export type VerdictProblem = { reason: VerdictProblemReason; snippet: string };

const PLACEHOLDER_EXACT = new Set([
  "tbd",
  "tba",
  "todo",
  "to do",
  "n/a",
  "na",
  "none",
  "null",
  "test",
  "testing",
  "placeholder",
  "verdict",
  "verdict here",
  "verdict goes here",
  "coming soon",
  "fill in",
  "fill this in",
  "fixme",
  "xxx",
]);

function snippetOf(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/**
 * Returns the first quality-floor violation for a verdict sentence, or null
 * when the text passes. Empty/absent input is NOT degenerate — a cleared
 * verdict simply means the slide renders without one (never embarrassing).
 * Never throws.
 */
export function findDegenerateVerdict(text: unknown): VerdictProblem | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const snippet = snippetOf(trimmed);
  const lower = trimmed.toLowerCase();
  const bareLower = lower.replace(/[.!?…\s]+$/g, "");
  if (PLACEHOLDER_EXACT.has(bareLower) || lower.includes("lorem ipsum")) {
    return { reason: "placeholder", snippet };
  }
  if (trimmed.length < VERDICT_MIN_CHARS) {
    return { reason: "too_short", snippet };
  }
  if (trimmed.length > VERDICT_MAX_CHARS) {
    return { reason: "too_long", snippet };
  }
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < VERDICT_MIN_WORDS) {
    return { reason: "too_few_words", snippet };
  }
  const uniqueWords = new Set(words.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}$%~-]+/gu, "")));
  uniqueWords.delete("");
  if (uniqueWords.size < 3) {
    return { reason: "repetitive", snippet };
  }
  return null;
}

/** Operator-facing phrasing for a floor violation (editor hint + 422 body). */
export function verdictProblemLabel(reason: VerdictProblemReason): string {
  switch (reason) {
    case "too_short":
      return `shorter than ${VERDICT_MIN_CHARS} characters`;
    case "too_long":
      return `longer than ${VERDICT_MAX_CHARS} characters — a verdict is one sentence`;
    case "too_few_words":
      return `fewer than ${VERDICT_MIN_WORDS} words`;
    case "repetitive":
      return "repeats the same word instead of saying something";
    case "placeholder":
      return "placeholder text";
  }
}

/**
 * Narrow unknown input to a clean sparse verdict map: known slide keys only,
 * strings trimmed, empties dropped. Used by the stored-row reader and after
 * the section-write parse. Never throws.
 */
export function sanitizeSlideVerdictMap(input: unknown): SlideVerdictMap {
  const out: SlideVerdictMap = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  const record = input as Record<string, unknown>;
  for (const key of SLIDE_VERDICT_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    out[key] = trimmed;
  }
  return out;
}

/**
 * Focused write schema for the slideVerdicts section PUT branch
 * (persistence-write-boundary rules: unknown keys strip, 400 on issues).
 * Values are shape-capped, not quality-floored — drafts may be mid-edit;
 * the floor bites at finalize.
 */
export const slideVerdictsSectionSchema = z
  .object({
    verdicts: z
      .object(
        Object.fromEntries(
          SLIDE_VERDICT_KEYS.map((key) => [
            key,
            z.string().max(VERDICT_SHAPE_MAX_CHARS).optional(),
          ]),
        ) as Record<SlideVerdictKey, z.ZodOptional<z.ZodString>>,
      )
      .default({}),
  })
  .strip();

export type SlideVerdictsSectionWrite = z.infer<typeof slideVerdictsSectionSchema>;
