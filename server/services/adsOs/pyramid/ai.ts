/**
 * OpenAI stages for the Pyramid Breakdown (port of backend/app/pyramid/ai.py —
 * prompt texts verbatim).
 *
 * Two calls, same discipline as keywordIntel/suggest.ts (Structured Outputs via
 * a strict json_schema, temperature-vs-reasoning_effort toggle with a
 * strip-and-retry inside adsOsStructuredCall, hard checks on
 * truncation/refusal/parse-failure, batch failures isolated to warnings):
 *
 *   * Stage 1 — search-term relevancy. Volume work on OPENAI_MODEL: every capped
 *     term is scored 0-100 against the AD GROUP it triggered in (that ad group's
 *     keywords + the client criteria are in the prompt).
 *   * Stage 2 — strategist. ONE call on the advanced model (PYRAMID_OPENAI_MODEL):
 *     the compact pyramid JSON (rule flags included) in, per-entity verdicts +
 *     executive summary out. If the key can't access the advanced model we fall
 *     back to OPENAI_MODEL once and report the swap — a wrong model name degrades,
 *     never breaks.
 *
 * The engine treats every failure here as a downgrade (partial / rules-only
 * report), so nothing in this module needs to succeed for the tool to answer.
 */

import {
  PYRAMID_TERM_BATCH_SIZE,
  getOpenAiModel,
  getOpenAiReasoningEffort,
  getPyramidOpenAiModel,
  getPyramidReasoningEffort,
  isOpenAiConfigured,
} from "../config";
import {
  adsOsStructuredCall,
  AdsOsOpenAiNotConfigured,
  type JsonSchema,
} from "../openAiHelper";
import type { ClientCriteria } from "../criteriaService";
import { mapPool } from "../singleflight";
import { termKey, type TermPull } from "./queries";

// --- Stage 1: structured-output schema (reason BEFORE score/label, the same
//     reason-first discipline as the negatives reviewer). Types mirror the
//     bundle's Pydantic models 1:1 (plain strings; the engine's guards and the
//     post-parse clamp below are the enforcement, not the schema). ---

export interface TermScore {
  search_term: string;
  reason: string; // <=12 words, written first
  relevancy: number; // 0-100
  label: string; // high_intent | relevant | adjacent | irrelevant
}

interface RelevancyResponse {
  results: TermScore[];
}

const RELEVANCY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          search_term: { type: "string" },
          reason: { type: "string" }, // <=12 words; written BEFORE score/label
          relevancy: { type: "integer" }, // 0-100
          label: { type: "string" }, // high_intent | relevant | adjacent | irrelevant
        },
        required: ["search_term", "reason", "relevancy", "label"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

// --- Stage 2: strategist schema (rationale before action per entity) ---

export interface CampaignVerdict {
  ref: number;
  rationale: string;
  action: string; // scale | keep | watch | throttle | pause
  confidence: number; // 0-1
}

export interface AdGroupVerdict {
  ref: number;
  rationale: string;
  action: string; // keep | watch | pause
}

export interface KeywordVerdict {
  ref: number;
  rationale: string;
  agree: boolean; // does the AI agree with the rule-computed pause?
}

export interface NextStepVerdict {
  priority: number;
  step: string;
}

export interface StrategistResponse {
  executive_summary: string;
  campaigns: CampaignVerdict[];
  ad_groups: AdGroupVerdict[];
  keywords: KeywordVerdict[];
  next_steps: NextStepVerdict[];
}

const STRATEGIST_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    executive_summary: { type: "string" },
    campaigns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "integer" },
          rationale: { type: "string" }, // reasoned BEFORE the action
          action: { type: "string" }, // scale | keep | watch | throttle | pause
          confidence: { type: "number" }, // 0-1
        },
        required: ["ref", "rationale", "action", "confidence"],
        additionalProperties: false,
      },
    },
    ad_groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "integer" },
          rationale: { type: "string" },
          action: { type: "string" }, // keep | watch | pause
        },
        required: ["ref", "rationale", "action"],
        additionalProperties: false,
      },
    },
    keywords: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "integer" },
          rationale: { type: "string" },
          agree: { type: "boolean" },
        },
        required: ["ref", "rationale", "agree"],
        additionalProperties: false,
      },
    },
    next_steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          priority: { type: "integer" },
          step: { type: "string" },
        },
        required: ["priority", "step"],
        additionalProperties: false,
      },
    },
  },
  required: ["executive_summary", "campaigns", "ad_groups", "keywords", "next_steps"],
  additionalProperties: false,
};

const RELEVANCY_SYSTEM =
  "You are a senior Google Ads analyst for a law-firm marketing agency. You judge whether each " +
  "search term that triggered a client's ads is HIGH-INTENT and RELEVANT to the specific AD GROUP " +
  "it ran in (that ad group's keywords are listed with its terms).\n\n" +
  'REASON FIRST. For EVERY term emit one result whose FIRST content field is "reason": at most ' +
  "12 words naming who is searching and what they want. Only then set the score and label.\n\n" +
  "SCORING (0-100):\n" +
  "  85-100 high_intent: someone ready to hire this firm for THIS ad group's service — e.g. " +
  '"<service> lawyer near me", "<service> attorney <in-area city>", "best <service> law firm". ' +
  'Modifiers like "near me", "best", "top", "affordable", "cost", "consultation", ' +
  '"reviews" or an in-area city signal a real client, never junk.\n' +
  '  60-84 relevant: right practice area, softer or researching intent ("how to choose a divorce ' +
  'lawyer", "<service> attorney fees").\n' +
  "  30-59 adjacent: a RELATED practice area, an ambiguous need, or a term that fits the FIRM but " +
  "is misplaced in THIS ad group — say which in the reason.\n" +
  "  0-29 irrelevant: job seekers (jobs, salary, hiring, careers), DIY/forms/templates, " +
  'pure information ("what is", definitions, statistics, penalty lookups), a location the client ' +
  "does not serve, a service they do not offer, a different profession, or a competitor brand " +
  "they'd never win.\n\n" +
  "Judge the WHOLE term against the ad group's keywords first and the client's practice areas " +
  "second. Grammatical variants are the same intent (defense/defending/defendant). When genuinely " +
  "unsure, score 45-59 (adjacent) rather than irrelevant — blocking a real client costs far more " +
  "than tolerating a soft term.\n\n" +
  "OUTPUT: one result object per input term, echoing search_term EXACTLY as given; never skip or " +
  "merge terms.";

const STRATEGIST_SYSTEM =
  "You are the head of paid search at a law-firm marketing agency writing the monthly account " +
  "review. Your input is one JSON document: the account pyramid (campaigns -> ad groups -> " +
  "flagged keywords) for the last 30 days, with deterministic rule flags already computed. Your " +
  "recommendations are DISPLAY-ONLY advice a human account manager applies by hand, top-down " +
  "(budget moves first).\n\n" +
  "NON-NEGOTIABLE RULES:\n" +
  '- Reference every entity ONLY by its integer "ref". Emit one verdict per campaign ref and one ' +
  "per ad-group ref (all of them); keywords: one verdict per keyword ref (they are pre-flagged — " +
  'you confirm or dissent via "agree").\n' +
  "- Allowed campaign actions: scale | keep | watch | throttle | pause. Allowed ad-group actions: " +
  "keep | watch | pause.\n" +
  '- You may assign "scale" ONLY to a campaign whose flags include CAMP_SCALE or CAMP_SCALE_TCPA.\n' +
  '- You may NOT assign pause or throttle to any entity marked "thin": true (insufficient data) — ' +
  "use watch.\n" +
  "- Entities with status other than ENABLED are context, not targets.\n" +
  "- The rule flags are ground-truth arithmetic. Your judgment goes ON TOP: sequencing, where " +
  "paused budget should move, whether a high-CPL ad group is fixable (bad traffic per the " +
  "relevancy data -> fix targeting) or should be paused, and honest confidence (0-1).\n\n" +
  "IMPRESSION-SHARE LOGIC: lost_b (budget-lost IS %) is headroom a budget raise buys; lost_r " +
  "(rank-lost IS %) is headroom ONLY better bids/quality buy — never recommend budget for a rank " +
  "problem.\n\n" +
  "RELEVANCY DATA: rel_avg (0-100, cost-weighted) and irr_pct (% of scored spend on irrelevant " +
  "terms) tell you WHY an ad group underperforms. Converting ad group with dirty traffic -> " +
  "prefer 'fix targeting / add negatives' over pause, and say so in the rationale.\n\n" +
  'STYLE: rationale = 1-2 sentences citing the numbers ("$412 at 0 conversions vs the $95 ' +
  "baseline CPL\"). executive_summary <= 120 words, plain language, leading with the single " +
  "biggest money move. next_steps <= 8, ordered by expected impact. Refs are ONLY for the " +
  'verdict "ref" fields — every human-facing sentence (executive_summary, rationale, ' +
  "next_steps) must use the entity's NAME, never a ref number.";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function criteriaBlock(criteria: ClientCriteria): string {
  const practice = criteria.practice_areas.length
    ? criteria.practice_areas.join(", ")
    : "not specified";
  return (
    "CLIENT CONTEXT\n" +
    `Business name: ${criteria.business_name}\n` +
    `Website: ${criteria.website}\n` +
    `Service area: ${criteria.service_area}\n` +
    `Practice areas: ${practice}\n` +
    `Services offered: ${criteria.services_offered}\n` +
    `Services NOT offered: ${criteria.services_not_offered}\n` +
    `Known competitors: ${criteria.competitors}\n` +
    `Extra notes: ${criteria.notes}\n`
  );
}

/** (ad group name, keywords, terms) blocks -> the stage-1 user prompt. */
type PromptBlock = [string, string[], TermPull[]];

function relevancyUserPrompt(criteria: ClientCriteria, groups: PromptBlock[]): string {
  const blocks: string[] = [criteriaBlock(criteria)];
  for (const [name, keywords, terms] of groups) {
    const rows = terms
      .map((t) => `${t.search_term} | ${round2(t.cost)} | ${t.clicks} | ${round2(t.conversions)}`)
      .join("\n");
    blocks.push(
      `AD GROUP: ${name}\n` +
        "ITS KEYWORDS: " +
        (keywords.length ? keywords.join(", ") : "(none reported)") +
        "\n" +
        "TERMS (term | cost | clicks | conversions):\n" +
        rows,
    );
  }
  return blocks.join("\n\n");
}

/**
 * One structured call with the bundle's model-not-found fallback. Parameter
 * rejection (temperature / reasoning_effort) is already stripped-and-retried
 * inside adsOsStructuredCall; here we add the second swap scenario: model not
 * found / no access -> retry once on the base OPENAI_MODEL. Returns the parsed
 * payload plus the model actually used. Truncation, refusal and parse failure
 * throw — the caller downgrades.
 */
async function createWithModelFallback<T>(
  schema: JsonSchema,
  schemaName: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  model: string,
  effort: string,
): Promise<{ parsed: T; used: string }> {
  try {
    const parsed = await adsOsStructuredCall<T>(schema, schemaName, messages, {
      model,
      reasoningEffort: effort,
    });
    return { parsed, used: model };
  } catch (err: any) {
    const msg = String(err?.message ?? err).toLowerCase();
    const base = getOpenAiModel();
    const noAccess =
      msg.includes("model") &&
      (msg.includes("not found") ||
        msg.includes("does not exist") ||
        msg.includes("do not have access"));
    if (noAccess && model !== base) {
      const parsed = await adsOsStructuredCall<T>(schema, schemaName, messages, {
        model: base,
        reasoningEffort: getOpenAiReasoningEffort(),
      });
      return { parsed, used: base };
    }
    throw err;
  }
}

/**
 * Stage 1: relevancy per (ad_group_id, term) — scores keyed by
 * `termKey(agId, term)`. Whole ad-group blocks are greedily packed into batches
 * (an oversized group splits, repeating its keyword header) and reviewed
 * concurrently. A failed batch leaves its terms unscored and becomes a warning;
 * only a total failure throws.
 */
export async function scoreSearchTerms(
  criteria: ClientCriteria,
  termsByAdGroup: Map<string, TermPull[]>,
  keywordsByAdGroup: Map<string, string[]>,
  adGroupNames: Map<string, string>,
): Promise<{ scores: Map<string, TermScore>; warnings: string[] }> {
  if (!isOpenAiConfigured()) {
    throw new AdsOsOpenAiNotConfigured();
  }

  const batchSize = Math.max(1, PYRAMID_TERM_BATCH_SIZE);
  // (ad group name, keywords, terms) blocks, largest spend first.
  const blocks: PromptBlock[] = [];
  const order = [...termsByAdGroup.entries()].sort(
    (a, b) =>
      b[1].reduce((s, t) => s + t.cost, 0) - a[1].reduce((s, t) => s + t.cost, 0),
  );
  for (const [agId, terms] of order) {
    const name = adGroupNames.get(agId) ?? agId;
    const keywords = (keywordsByAdGroup.get(agId) ?? []).slice(0, 20);
    for (let i = 0; i < terms.length; i += batchSize) {
      blocks.push([name, keywords, terms.slice(i, i + batchSize)]);
    }
  }

  // Greedy pack whole blocks into <=batchSize batches.
  const batches: PromptBlock[][] = [];
  let current: PromptBlock[] = [];
  let count = 0;
  for (const block of blocks) {
    const n = block[2].length;
    if (current.length && count + n > batchSize) {
      batches.push(current);
      current = [];
      count = 0;
    }
    current.push(block);
    count += n;
  }
  if (current.length) batches.push(current);
  if (!batches.length) return { scores: new Map(), warnings: [] };

  const errors: unknown[] = [];

  const review = async (batch: PromptBlock[]): Promise<Map<string, TermScore> | null> => {
    try {
      // Base model + base effort (the helper's defaults) — volume work.
      const parsed = await adsOsStructuredCall<RelevancyResponse>(
        RELEVANCY_SCHEMA,
        "pyramid_relevancy",
        [
          { role: "system", content: RELEVANCY_SYSTEM },
          { role: "user", content: relevancyUserPrompt(criteria, batch) },
        ],
      );
      // Map results back to (ad_group_id, term): terms are unique per
      // (group, term) inside a batch, so index by the batch's own blocks.
      const out = new Map<string, TermScore>();
      const byTerm = new Map<string, string[]>();
      for (const [, , terms] of batch) {
        for (const t of terms) {
          const ids = byTerm.get(t.search_term) ?? [];
          ids.push(t.ad_group_id);
          byTerm.set(t.search_term, ids);
        }
      }
      const results = Array.isArray(parsed?.results) ? parsed.results : [];
      for (const r of results) {
        const ids = byTerm.get(r.search_term);
        if (!ids || !ids.length) continue;
        const rel = Number(r.relevancy);
        r.relevancy = Math.max(0, Math.min(100, Number.isFinite(rel) ? Math.trunc(rel) : 0));
        if (!["high_intent", "relevant", "adjacent", "irrelevant"].includes(r.label)) {
          r.label = "adjacent";
        }
        r.reason = String(r.reason ?? "");
        for (const agId of ids) {
          out.set(termKey(agId, r.search_term), r);
        }
      }
      return out;
    } catch (exc) {
      errors.push(exc);
      return null;
    }
  };

  const results =
    batches.length === 1
      ? [await review(batches[0])]
      : await mapPool(batches, Math.min(4, batches.length), review);

  const merged = new Map<string, TermScore>();
  let nFailed = 0;
  for (const r of results) {
    if (r === null) {
      nFailed += 1;
    } else {
      for (const [k, v] of r) merged.set(k, v);
    }
  }
  if (nFailed && nFailed === batches.length) throw errors[0];
  const warnings: string[] = [];
  if (nFailed) {
    warnings.push(
      `Search-term relevancy scoring was incomplete: ${nFailed} of ${batches.length} ` +
        "batches failed; unscored terms show without a relevancy score. Re-run to retry.",
    );
  }
  return { scores: merged, warnings };
}

/** Pydantic-equivalent coercion so a malformed strategist payload can never
 * crash the assembly (the engine relies on these arrays existing). */
function normalizeStrategist(p: any): StrategistResponse {
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    executive_summary: String(p?.executive_summary ?? ""),
    campaigns: (Array.isArray(p?.campaigns) ? p.campaigns : []).map((v: any) => ({
      ref: num(v?.ref),
      rationale: String(v?.rationale ?? ""),
      action: String(v?.action ?? ""),
      confidence: num(v?.confidence),
    })),
    ad_groups: (Array.isArray(p?.ad_groups) ? p.ad_groups : []).map((v: any) => ({
      ref: num(v?.ref),
      rationale: String(v?.rationale ?? ""),
      action: String(v?.action ?? ""),
    })),
    keywords: (Array.isArray(p?.keywords) ? p.keywords : []).map((v: any) => ({
      ref: num(v?.ref),
      rationale: String(v?.rationale ?? ""),
      agree: Boolean(v?.agree),
    })),
    next_steps: (Array.isArray(p?.next_steps) ? p.next_steps : []).map((v: any) => ({
      priority: num(v?.priority),
      step: String(v?.step ?? ""),
    })),
  };
}

/**
 * Stage 2: one advanced-model call. Returns (verdicts | null, model_used,
 * warnings) — null means the engine falls back to rules-only verdicts.
 */
export async function runStrategist(
  payload: Record<string, unknown>,
): Promise<{ verdicts: StrategistResponse | null; modelUsed: string; warnings: string[] }> {
  if (!isOpenAiConfigured()) {
    throw new AdsOsOpenAiNotConfigured();
  }

  const model = getPyramidOpenAiModel().trim() || getOpenAiModel();
  const warnings: string[] = [];
  try {
    const { parsed, used } = await createWithModelFallback<StrategistResponse>(
      STRATEGIST_SCHEMA,
      "pyramid_strategist",
      [
        { role: "system", content: STRATEGIST_SYSTEM },
        // json.dumps(payload, separators=(",", ":")) == compact JSON.stringify.
        { role: "user", content: JSON.stringify(payload) },
      ],
      model,
      getPyramidReasoningEffort(),
    );
    if (used !== model) {
      warnings.push(
        `Advanced model '${model}' is unavailable to this API key — the review ` +
          `used '${used}' instead.`,
      );
    }
    return { verdicts: normalizeStrategist(parsed), modelUsed: used, warnings };
  } catch (exc: any) {
    warnings.push(
      `AI strategist failed (${exc?.message ?? exc}); showing the rules-based verdicts only.`,
    );
    return { verdicts: null, modelUsed: "", warnings };
  }
}
