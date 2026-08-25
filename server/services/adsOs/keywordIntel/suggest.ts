/**
 * OpenAI review: propose negative keywords for the flagged search terms
 * (port of backend/app/keyword_intel/suggest.py — prompt texts verbatim).
 *
 * The model reasons per term (intent_summary -> verdict) and proposes negatives
 * with a per-negative confidence; `safety.enforceSafety` is what decides what's
 * actually surfaced (asymmetric confidence floors + the deterministic
 * protected-word/geo guard). The model is called with OpenAI Structured Outputs
 * (a strict json_schema mirroring the bundle's Pydantic models), so a malformed
 * shape or a non-numeric confidence can't silently slip a bad suggestion
 * through — a parse failure becomes a warning.
 */

import { KI_BATCH_SIZE } from "../config";
import { adsOsStructuredCall, AdsOsOpenAiNotConfigured, type JsonSchema } from "../openAiHelper";
import { isOpenAiConfigured } from "../config";
import type { ClientCriteria } from "../criteriaService";
import { mapPool } from "../singleflight";
import type { RawTermSuggestion } from "./safety";
import type { SearchTermRow } from "./queries";

// --- Structured-output schema the model must fill (strict; all fields required).
//     Field order mirrors the bundle's _TermResult: intent_summary comes before
//     verdict, so the model reasons first and decides second. ---
const REVIEW_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          search_term: { type: "string" },
          intent_summary: { type: "string" }, // <=12 words; written BEFORE the verdict
          verdict: { type: "string" }, // keep | negate
          category: { type: "string" }, // taxonomy label, or "" for keep
          reason: { type: "string" }, // short why, or "" for keep
          negatives: {
            type: "array", // [] for keep
            items: {
              type: "object",
              properties: {
                text: { type: "string" }, // the word(s) only — no quotes/brackets
                match_type: { type: "string" }, // broad | phrase | exact
                confidence: { type: "number" }, // 0-1, this negative's confidence
              },
              required: ["text", "match_type", "confidence"],
              additionalProperties: false,
            },
          },
        },
        required: ["search_term", "intent_summary", "verdict", "category", "reason", "negatives"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

interface ReviewResponse {
  results: {
    search_term: string;
    intent_summary: string;
    verdict: string;
    category: string;
    reason: string;
    negatives: { text: string; match_type: string; confidence: number }[];
  }[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, size);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

// Prompt text ported VERBATIM from the bundle (keyword_intel/suggest.py _SYSTEM).
const SYSTEM_PROMPT =
  "You are a senior Google Ads analyst for a law-firm marketing agency. You review the search " +
  "terms that triggered a client's ads and decide which are WASTE worth blocking with a NEGATIVE " +
  "keyword. Your bar is high: blocking a real potential client is FAR more costly than letting a " +
  "junk term through, so when in doubt you KEEP.\n\n" +

  "REASON FIRST, DECIDE SECOND. For EVERY search term in the batch, emit one result object whose " +
  "FIRST field is \"intent_summary\": at most 12 words naming WHO is searching and WHAT they want. " +
  "Only after writing it do you set \"verdict\" to \"keep\" or \"negate\". Never output a verdict " +
  "before its intent_summary.\n\n" +

  "THE KEEP TEST (judge the WHOLE term, not single words): is this plausibly someone who could hire " +
  "this firm for one of its PRACTICE AREAS or ACTIVELY TARGETED KEYWORDS (both listed below)? " +
  "Phrasings like \"<practice> lawyer/attorney\", \"lawyer/attorney for <subject>\", \"<subject> " +
  "lawyer\", \"<practice> near me\", or \"<practice> attorney <city>\" are REAL CLIENTS describing " +
  "the matter they need help with — the subject word is NOT a reason to negate. For a " +
  "criminal-defense firm, \"criminal lawyer\" and \"lawyer for criminals\" are real clients (the " +
  "word names the need, not a wrong intent). Treat grammatical variants as the same intent " +
  "(defense/defending/defendant). Modifiers like \"near me\", \"best\", \"top\", \"affordable\", " +
  "\"reviews\", \"cost\", \"consultation\", or an in-area city do NOT make a relevant term junk. If " +
  "a term passes the KEEP test, set verdict=keep and emit nothing else for it.\n\n" +

  "WHEN TO NEGATE: only for terms that clearly FAIL the KEEP test — not a potential client for ANY " +
  "of this firm's practice areas. Set verdict=negate, choose ONE category, give a short reason, set " +
  "confidence 0-1, and list the negative(s).\n\n" +

  "CATEGORIES (pick the single best fit):\n" +
  "  - competitor: names a different law firm, attorney, or brand.\n" +
  "  - wrong_service: explicitly about a service in the client's SERVICES NOT OFFERED list. Do NOT " +
  "use this for a term that is WITHIN or ADJACENT to the firm's practice areas — e.g. for an " +
  "employment-law firm \"attorneys for unemployment\" is adjacent to employment law, so KEEP it. If " +
  "SERVICES NOT OFFERED is empty, be very reluctant to use this category at all.\n" +
  "  - wrong_geo: a location the client does NOT serve (outside PROTECTED_GEO).\n" +
  "  - job_seeker: employment intent — jobs, hiring, careers, salary, \"how much do lawyers make\".\n" +
  "  - wrong_intent: not hiring a lawyer at all — DIY/forms/templates, \"do it yourself\", " +
  "school/degree/study (non-employment).\n" +
  "  - informational: research with no hiring intent — \"what is\", \"how does\", definitions, news, " +
  "statistics, penalty/sentence lookups.\n" +
  "  - other: clearly irrelevant, none of the above (e.g. a different profession — doctor, plumber).\n\n" +

  "CHOOSING THE NEGATIVE (most efficient that is SAFE):\n" +
  "1. Prefer ONE-WORD BROAD negatives — a broad word blocks every future query containing it. But " +
  "BROAD SELF-TEST first: before emitting a broad word, try to name ONE realistic query a real " +
  "client for THIS firm could type that contains that word. If you can think of even one, do NOT use " +
  "broad — emit the whole search term as PHRASE instead. (Never broad \"accident\"/\"injury\" for an " +
  "injury firm, \"criminal\"/\"defense\" for a defense firm, \"estate\"/\"will\" for an estate firm.)\n" +
  "2. Competitor or person names: emit one broad negative per name word — neither word appears in a " +
  "real query for this client (e.g. \"neena wiora\" -> broad \"neena\" AND broad \"wiora\").\n" +
  "3. Clear junk words (salary, jobs, hiring, diy, template, study, school): emit the broad word.\n" +
  "4. SERVICES NOT OFFERED: emit a PHRASE of the offending phrase, NOT broad — those words can still " +
  "appear in valid cross-practice queries.\n" +
  "5. NEVER emit as broad any word in PROTECTED_WORDS, or any word that could plausibly appear in a " +
  "real query for this client. If the only distinguishing words are protected, emit ONE negative = " +
  "the full search term as PHRASE (or EXACT if it is a fixed phrase).\n" +
  "6. GEO SAFETY (hard rule): never emit ANY negative — broad, phrase, or exact — that is, or is " +
  "made up entirely of, a city, neighborhood, county, or state inside this client's service area " +
  "(PROTECTED_GEO). State abbreviations and full names are the same place (MD = Maryland). For " +
  "wrong_geo, you SHOULD emit a BROAD negative on the out-of-area location word(s) — e.g. \"trust " +
  "attorney maryland\" -> broad \"maryland\" — one broad per out-of-area location token. An " +
  "out-of-area location can never appear in a real in-area client query, so it passes the broad " +
  "self-test; broad is the efficient choice. Only fall back to a phrase when the place is multi-word " +
  "and you cannot cleanly isolate the out-of-area token.\n" +
  "7. LOCAL INTENT: \"near me\", \"nearby\", \"in <city>\", or an area name is HIGH intent when " +
  "paired with a relevant service — NEVER negate a term just for a location. Only negate a local " +
  "term when the REST of it is itself irrelevant (e.g. \"law school near me\", \"accountant near me\").\n" +
  "8. When unsure whether a term relates to a practice area, KEEP it and use a lower confidence — " +
  "missing a negative is far cheaper than blocking a client.\n\n" +

  "EXAMPLES (adapt to the client's actual practice areas & geo):\n" +
  "  \"criminal lawyer\" -> keep (real client naming their matter)\n" +
  "  \"dui attorney near me\" -> keep\n" +
  "  \"best personal injury law firm\" -> keep (\"best\" is not junk)\n" +
  "  \"personal injury lawyer reviews\" -> keep (researching a hire)\n" +
  "  \"criminal lawyer salary\" -> negate, job_seeker, broad \"salary\"\n" +
  "  \"paralegal jobs near me\" -> negate, job_seeker, broad \"jobs\" (keep \"near me\")\n" +
  "  \"what is a deposition\" -> negate, informational, phrase \"what is\"\n" +
  "  \"how to file divorce yourself\" -> negate, wrong_intent, broad \"yourself\"\n" +
  "  \"trust attorney maryland\" -> negate, wrong_geo, broad \"maryland\" (firm does not serve MD)\n" +
  "  \"attorneys for unemployment\" -> keep (an employment-law firm handles unemployment matters)\n" +
  "  \"plumber near me\" -> negate, other, broad \"plumber\"\n\n" +

  "MATCH TYPES: broad = blocks any query containing the word(s); phrase = blocks queries containing " +
  "the exact phrase; exact = blocks only that exact query.\n\n" +
  "OUTPUT: one result object per search term, with intent_summary FIRST, then verdict. For " +
  'verdict=keep set category="", reason="" and negatives=[]. For verdict=negate set a category ' +
  "(competitor|wrong_service|wrong_geo|job_seeker|wrong_intent|informational|other), a short reason, " +
  "and one or more negatives. Each negative has: text (the word(s) ONLY — no quotes or brackets, the " +
  "match_type carries that), match_type, and confidence (0-1). CONFIDENCE & MATCH TYPE: use BROAD only " +
  "when you are HIGHLY confident (>= 0.8) the word is pure junk that could NEVER appear in a real query " +
  "for THIS client; when less sure, use PHRASE of the whole term. Informational and job-seeker junk may " +
  "carry moderate confidence; competitor, wrong_geo and wrong_service negatives should be >= 0.6.";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** User prompt ported verbatim from the bundle's _build_user_prompt. */
export function buildUserPrompt(
  criteria: ClientCriteria,
  candidates: SearchTermRow[],
  protectedWords: Set<string>,
  protectedGeo: Set<string>,
  activeKeywords: string[],
): string {
  const rows = candidates
    .map((t) =>
      [
        t.search_term, t.campaign, t.ad_group, t.matched_keyword,
        t.impressions, t.clicks, round2(t.cost), t.conversions, round2(t.avg_cpc),
      ].map((x) => String(x)).join(" | "),
    )
    .join("\n");
  const practice = criteria.practice_areas.length ? criteria.practice_areas.join(", ") : "not specified";
  return (
    "CLIENT CONTEXT\n" +
    `Business name: ${criteria.business_name}\n` +
    `Website: ${criteria.website}\n` +
    `Service area: ${criteria.service_area}\n` +
    `Practice areas: ${practice}\n` +
    `Services offered: ${criteria.services_offered}\n` +
    `Services NOT offered: ${criteria.services_not_offered}\n` +
    `Known competitors: ${criteria.competitors}\n` +
    `Extra notes: ${criteria.notes}\n\n` +
    "ACTIVELY TARGETED KEYWORDS (the client bids on these — any search term showing the SAME " +
    "intent is a real customer; do NOT negate it):\n" +
    (activeKeywords.length ? activeKeywords.join(", ") : "(none)") + "\n\n" +
    "PROTECTED_WORDS (never use any of these as a broad negative root):\n" +
    [...protectedWords].sort().join(", ") + "\n\n" +
    "PROTECTED_GEO (service-area locations — NEVER negate these in any match type; you may negate " +
    "locations OUTSIDE this area):\n" +
    [...protectedGeo].sort().join(", ") + "\n\n" +
    "SEARCH TERMS (lookback window; columns: term | campaign | ad group | matched keyword | " +
    "impr | clicks | cost | conv | cpc):\n" + rows
  );
}

/**
 * Review candidates; return [raw negate-suggestion dicts, warnings].
 *
 * Terms are split into small batches and reviewed concurrently — the model's
 * recall drops over long lists, so batching keeps a 30-day run from surfacing
 * fewer terms than its 7-day subset. The model emits one record per term
 * (intent_summary -> verdict); we keep only the `negate` records and hand them
 * downstream (dedup of identical negatives happens in dedupeNegatives). A
 * partial batch failure becomes a warning (so the caller can flag an incomplete
 * review instead of silently reporting clean traffic); only a total failure throws.
 */
export async function suggestNegatives(
  criteria: ClientCriteria,
  candidates: SearchTermRow[],
  protectedWords: Set<string>,
  protectedGeo: Set<string>,
  activeKeywords?: string[],
): Promise<[RawTermSuggestion[], string[]]> {
  if (!isOpenAiConfigured()) throw new AdsOsOpenAiNotConfigured();
  if (!candidates.length) return [[], []];

  // A deduped sample of the client's real keywords — strong practice-area signal.
  const kwSample = [...new Set(activeKeywords ?? [])].slice(0, 60);

  const review = async (batch: SearchTermRow[]): Promise<RawTermSuggestion[]> => {
    const parsed = await adsOsStructuredCall<ReviewResponse>(
      REVIEW_SCHEMA,
      "keyword_intel_review",
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: buildUserPrompt(criteria, batch, protectedWords, protectedGeo, kwSample),
        },
      ],
    );
    if (!parsed || !Array.isArray(parsed.results)) {
      throw new Error("structured output failed to parse");
    }
    // Keep only the terms the model decided to negate; hand the per-negative
    // confidence downstream to enforceSafety's asymmetric gating.
    const out: RawTermSuggestion[] = [];
    for (const r of parsed.results) {
      const verdict = String(r?.verdict ?? "").trim().toLowerCase();
      const negatives = Array.isArray(r?.negatives) ? r.negatives : [];
      if (verdict === "keep" || !negatives.length) continue;
      out.push({
        search_term: String(r.search_term ?? ""),
        category: String(r.category ?? "") || "other",
        reason: String(r.reason ?? ""),
        negatives: negatives.map((n) => ({
          text: String(n?.text ?? ""),
          match_type: String(n?.match_type ?? ""),
          confidence: Number(n?.confidence ?? 0),
        })),
      });
    }
    return out;
  };

  // Isolate a bad batch instead of sinking the whole (re-runnable) run.
  const errors: unknown[] = [];
  const reviewSafe = async (batch: SearchTermRow[]): Promise<RawTermSuggestion[] | null> => {
    try {
      return await review(batch);
    } catch (exc) {
      errors.push(exc);
      return null;
    }
  };

  const batches = chunk(candidates, KI_BATCH_SIZE);
  const results = batches.length === 1
    ? [await reviewSafe(batches[0])]
    : await mapPool(batches, Math.min(4, batches.length), reviewSafe);

  const merged: RawTermSuggestion[] = [];
  let nFailed = 0;
  for (const r of results) {
    if (r === null) nFailed++;
    else merged.push(...r);
  }

  const nTotal = batches.length;
  if (nFailed && nFailed === nTotal) {
    throw errors[0]; // nothing succeeded — surface a real error, not a clean run
  }

  const warnings: string[] = [];
  if (nFailed) {
    warnings.push(
      `Search-term review was incomplete: ${nFailed} of ${nTotal} batches failed ` +
      "and were skipped, so some wasteful terms may be missing. Re-run to retry.",
    );
  }
  return [merged, warnings];
}
