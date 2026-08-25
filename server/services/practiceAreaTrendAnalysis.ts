/**
 * Task #4240 — AI seasonal-trend commentary ("Current Position" / "Demand
 * Shape Ahead"), extracted verbatim from POST /api/trends/practice-areas
 * (server/routes/settings.ts) so the report-finalize path can generate the
 * SAME analysis once and cache it with the report. The anonymous share view
 * then serves the stored copy — an unauthenticated request never reaches
 * OpenAI (cost/abuse surface; explicit product decision from Task #4210).
 *
 * The OpenAI client is INJECTED by callers (routes import it from
 * server/routes/middleware — the single confined adapter site). This module
 * deliberately has no vendor import, which also lets tests pass a fake
 * client.
 */
import { CHEAP_MODEL, reasoningEffortFor } from "../aiModels";
import type { PracticeAreaTrendData } from "./practiceAreaTrendData";

export type PracticeAreaAiAnalysis = Record<
  string,
  { currentPosition: string[]; demandShapeAhead: string[] }
>;

/** Structural slice of the OpenAI SDK client this module needs. */
export interface TrendAnalysisChatClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        messages: Array<{ role: "user"; content: string }>;
        response_format: { type: "json_object" };
        reasoning_effort?: "minimal";
        max_completion_tokens?: number;
      }): Promise<{
        choices: Array<{ message?: { content?: string | null } }>;
      }>;
    };
  };
}

/**
 * report_sections key holding the cached AI commentary for a finalized
 * report. This is an internal cache row — buildReportResponse strips it from
 * the served `sections` list and surfaces it as `seasonalTrends.aiAnalysis`.
 */
export const SEASONAL_TRENDS_AI_SECTION_KEY = "seasonalTrendsAi";

export const SEASONAL_TRENDS_AI_EDITOR = "system:seasonal-trends-ai";

/**
 * Validated read of a stored seasonalTrendsAi section payload. Returns the
 * analysis map or null when the stored shape is unusable (never throws — the
 * share payload degrades to the deterministic fallback).
 */
export function readStoredSeasonalTrendAiAnalysis(
  sectionData: unknown,
): PracticeAreaAiAnalysis | null {
  if (!sectionData || typeof sectionData !== "object") return null;
  const analysis = (sectionData as Record<string, unknown>).aiAnalysis;
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    return null;
  }
  const out: PracticeAreaAiAnalysis = {};
  for (const [area, value] of Object.entries(analysis as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const currentPosition = Array.isArray(v.currentPosition)
      ? v.currentPosition.filter((s): s is string => typeof s === "string")
      : null;
    const demandShapeAhead = Array.isArray(v.demandShapeAhead)
      ? v.demandShapeAhead.filter((s): s is string => typeof s === "string")
      : null;
    if (!currentPosition?.length || !demandShapeAhead?.length) continue;
    out[area] = { currentPosition, demandShapeAhead };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Generate the AI commentary for an already-computed deterministic trend
 * payload. Returns null when there is nothing to analyze or the AI call
 * fails (logged; callers fall back to deterministic commentary). Never
 * throws.
 */
export async function generatePracticeAreaTrendAiAnalysis(
  trendData: PracticeAreaTrendData,
  openaiClient: TrendAnalysisChatClient,
): Promise<PracticeAreaAiAnalysis | null> {
  const results = trendData.practiceAreas;
  const combined = trendData.combined;
  const { currentMonth, currentMonthIndex } = trendData;

  if (results.length === 0) return null;

  // Build list of all practice areas to analyze (including combined if present)
  const areasToAnalyze = [...results.map((r) => r.practiceArea)];
  if (combined) {
    areasToAnalyze.push("Combined Average");
  }

  try {
    // Build comprehensive input summary for unified prompt
    const inputSummary = results.map((r) => {
      const monthlyDataStr = r.data.map((d: { month: string; value: number; phase: string }) =>
        `${d.month}: ${d.value} (${d.phase})`
      ).join(", ");
      return `Practice Area: ${r.practiceArea}
Search Term: "${r.searchTerm}"
Current Phase: ${r.data[currentMonthIndex].phase}
Monthly Data: ${monthlyDataStr}`;
    }).join("\n\n") + (combined ? `\n\nCombined Portfolio Average:
Current Phase: ${combined.data[currentMonthIndex].phase}
Monthly Data: ${combined.data.map((d: { month: string; value: number; phase: string }) => `${d.month}: ${d.value} (${d.phase})`).join(", ")}` : "");

    // Build dynamic output format showing expected keys
    const outputExample = areasToAnalyze.reduce((acc, area) => {
      acc[area] = {
        currentPosition: ["Label: sentence", "Label: sentence"],
        demandShapeAhead: ["Label: sentence", "Label: sentence"]
      };
      return acc;
    }, {} as Record<string, { currentPosition: string[]; demandShapeAhead: string[] }>);

    const prompt = `You are an outside market analyst interpreting a 5-year averaged Google Trends seasonality index for legal services.

IMPORTANT CONTEXT:
- This data is a smoothed 5-year average representing a typical annual pattern.
- It is NOT live performance data.
- Analysis should reflect how operators read dashboards, not academic full-year reviews.
- Do NOT give campaign, budget, or marketing advice.

TIME HORIZON (CRITICAL):
- Treat the current month as the anchor.
- Forward-looking analysis is LIMITED to the current month plus the next 3 months.
- Do NOT reference or analyze any months beyond this 3-month window.

CURRENT MONTH: ${currentMonth}

INPUT DATA:
${inputSummary}

Notes:
- inputSummary may include one practice area, multiple practice areas, and/or a combined portfolio average.
- Phase labels are PRE-DETERMINED. Do NOT define, question, or rename them.

────────────────────────────────────────
REQUIRED ANALYST COMPUTATIONS

For each practice area and combined portfolio (if present), compute where possible:
- annual high value
- annual low value
- amplitude (annual high minus annual low)
- annual average
- rank (out of 12 months)
- values for next 1, next 2, and next 3 months
- month-over-month change for each of the next 3 months
- share of total demand represented by the top three months
- count of near-peak months (≥ 90% of annual high)

Only values within the allowed 3-month forward window may be referenced.

Every output line MUST reference at least one numeric value.

────────────────────────────────────────
PORTFOLIO INTERACTION ANALYSIS (COMBINED VIEW ONLY)

If a combined portfolio is present:
- Assess whether individual practice areas are reinforcing or offsetting each other in the current month.
- Identify cases where one practice is near its annual high while another is near its annual low in the SAME month.
- Explain how this interaction affects the combined average using numbers.
- Do NOT speculate beyond the 3-month forward window.

Single-practice views must NEVER reference other practice areas.

────────────────────────────────────────
OUTPUT SANITIZATION RULE (CRITICAL)

- Do NOT output internal variable names or camelCase tokens.
- Forbidden examples: yearlyHigh, yearlyLow, next2Value, deltaNext, top3Share.
- Convert all metrics into plain English.

Correct examples:
- "annual high of 100"
- "annual low of 75"
- "month-over-month change of -10"
- "January through March account for 33 percent of annual demand"

────────────────────────────────────────
PHRASING CANONICALIZATION (MANDATORY)

Use ONLY the following phrases for these concepts:
- "annual high"
- "annual low"
- "ranked X of 12 months"
- "month-over-month change"
- "top three months account for X percent of annual demand"

Do NOT introduce alternative phrasing for these ideas.

────────────────────────────────────────
INTERPRETATION RULES

- Write like a market analyst, not a marketer.
- Use neutral, declarative language.
- Avoid emphasis, adjectives, or persuasive framing.
- Do NOT speculate beyond visible seasonal structure.
- Do NOT describe anomalies or external causes.
- Do NOT say "you should".

Allowed interpretation verbs (use only one per line):
- holds
- marks
- reflects
- shows
- declines

Rotate verbs to avoid repetition.

────────────────────────────────────────
LABEL CONSTRAINTS (STRICT)

Each Insight Line MUST use ONE of the following labels exactly:
- Position
- Amplitude
- Concentration
- Slope
- Transition

Additional label allowed ONLY when a combined portfolio exists:
- Interaction

LABEL INTENT DEFINITIONS (CRITICAL):
- Position: where the current month ranks within the year.
- Amplitude: the annual range or spread, not phase movement.
- Concentration: how demand is distributed across months.
- Slope: month-over-month change within the CURRENT phase only.
- Transition: the FIRST month that enters a NEW phase.
- Interaction: how multiple practice areas offset or reinforce the combined average in the SAME month.

LABEL USAGE RULES:
- Each section must use two DIFFERENT labels.
- Do NOT repeat the same label within a section.
- When Position references an annual high, Amplitude must emphasize range or spread, not restate the peak.
- Interaction labels are ONLY allowed in combined portfolio views.

────────────────────────────────────────
PHASE ALIGNMENT RULE (CRITICAL)

- A Transition line MUST reference ONLY the first month that enters the next phase.
- Do NOT reference month-over-month change values in a Transition line.
- If the next phase begins in March, the Transition line must reference March only.

SLOPE SCOPE RULE (CRITICAL)

- A Slope line may reference ONLY month-over-month change within the CURRENT phase.
- Do NOT reference future phase names in a Slope line.

────────────────────────────────────────
INSIGHT LINE FORMAT (CRITICAL)

Each Insight Line must:
- Be exactly ONE sentence
- Contain exactly ONE numeric metric
- Contain exactly ONE interpretation
- Use NO stylistic emphasis (no bolding, no adjectives)
- Use NO more than ONE conjunction
- Be NO LONGER than 18 words

Format exactly as:

Label: sentence

────────────────────────────────────────
OUTPUT LANGUAGE STYLE (MANDATORY)

All output must use plain, operational language consistent with the tone of Revenue Engineering for Law Firms.

This is not an academic analysis and not a consulting report.
It should read like a clear-eyed operator describing what the numbers say.

Language rules:
- Prefer short, direct sentences.
- Avoid elevated, abstract, or formal phrasing.
- Do not sound advisory, strategic, or theoretical.
- Do not explain concepts or justify interpretations.
- Do not use metaphors, analogies, or narrative framing.
- Do not soften statements with hedging language.

Forbidden language patterns (examples):
- "This suggests that…"
- "This may indicate…"
- "From a strategic perspective…"
- "Historically speaking…"
- "This implies an opportunity to…"
- "Demand dynamics suggest…"

Required language patterns:
- State what the number does.
- State where it sits.
- State how it moves.
- Stop.

Tone calibration test:
- Each sentence should sound reasonable if spoken out loud to a firm owner in under five seconds.
- If a sentence sounds like it belongs in a whitepaper, rewrite it.

RELATIONSHIP LANGUAGE RULE (MANDATORY)

Do not explain relationships. Only state alignment.

Forbidden examples:
- "reinforce"
- "offset"
- "support"
- "contribute to"
- "drive"
- "amplify"

Required pattern:
- Describe values in the same month.
- State whether they are high, low, or mixed.
- Stop.

VERB USAGE RULE (VERY IMPORTANT)

Avoid abstract verbs. Prefer physical or positional language.

Forbidden verb patterns:
- "reinforces"
- "reflects broader"
- "indicates"
- "suggests"
- "accounts for" (allowed only in the required canonical phrase)

Preferred replacements:
- "holds"
- "sits"
- "is"
- "remains"
- "enters"

────────────────────────────────────────
OUTPUT FORMAT (JSON ONLY)

Return a JSON object with a key for EACH practice area (use exact names from input).
Each practice area entry MUST contain exactly 2 Insight Lines per section.

If "Combined Average" exists:
- ONE of the two Insight Lines in Combined Average MAY use the Interaction label.

${JSON.stringify(outputExample, null, 2)}

────────────────────────────────────────
SELF-VALIDATION CHECK (MANDATORY)

Before finalizing:
- No camelCase or internal variable names appear
- No month beyond current + 3 is referenced
- Every line contains a number
- Every line is ≤ 18 words
- Only approved labels are used
- Labels are not repeated within a section
- Position and Amplitude are not redundant
- Slope and Transition reference correct months
- Interaction appears only in Combined Average
- No campaign, budget, or tactical language appears
- Output matches the JSON structure exactly with ALL practice areas as keys

If any rule fails, rewrite until all rules pass.

If any sentence sounds academic, explanatory, or polished beyond necessity, rewrite it using simpler words.

Rewrite any sentence that explains why numbers matter into a sentence that only states where the numbers are.

Return valid JSON only.`;

    // Increase max_tokens based on number of practice areas. Add headroom
    // so the cheap reasoning model's reasoning tokens don't starve output.
    const maxTokens = Math.min(2000 + (areasToAnalyze.length * 200), 4000);

    const response = await openaiClient.chat.completions.create({
      model: CHEAP_MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      reasoning_effort: reasoningEffortFor(CHEAP_MODEL),
      max_completion_tokens: maxTokens,
    });

    const content = response.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as PracticeAreaAiAnalysis;
  } catch (aiError) {
    console.error("AI analysis failed:", aiError);
    // Continue without AI analysis
    return null;
  }
}

/**
 * Finalize-time cache: compute the deterministic trend data for the client's
 * practice areas, generate the AI commentary ONCE (authenticated trigger —
 * finalize is an auth-gated operator action), and store it in
 * report_sections under SEASONAL_TRENDS_AI_SECTION_KEY. buildReportResponse
 * serves the stored copy to anonymous /api/share/:token viewers.
 *
 * Best-effort: returns null (after logging) on any failure — a finalize must
 * never be blocked by the AI layer, and the share view degrades to the
 * deterministic fallback commentary. On AI failure nothing is written, so a
 * previously stored good copy is never clobbered. Idempotent: the section
 * upsert conflicts on (report_id, section_key).
 */
export async function generateAndStoreSeasonalTrendAiAnalysis(args: {
  reportId: string;
  practiceAreas: string[];
  openaiClient: TrendAnalysisChatClient;
}): Promise<PracticeAreaAiAnalysis | null> {
  try {
    const areas = args.practiceAreas.filter((a) => typeof a === "string" && a.length > 0);
    if (areas.length === 0) return null;
    const { computePracticeAreaTrendData } = await import("./practiceAreaTrendData");
    const trendData = await computePracticeAreaTrendData(areas);
    const aiAnalysis = await generatePracticeAreaTrendAiAnalysis(trendData, args.openaiClient);
    if (!aiAnalysis) return null;
    const { storage } = await import("../storage");
    await storage.upsertReportSection(
      {
        reportId: args.reportId,
        sectionKey: SEASONAL_TRENDS_AI_SECTION_KEY,
        data: {
          aiAnalysis,
          practiceAreas: areas,
          generatedAt: new Date().toISOString(),
        },
      },
      { editor: SEASONAL_TRENDS_AI_EDITOR, source: "system" },
    );
    return aiAnalysis;
  } catch (err) {
    console.error(
      `[trend-ai] seasonal AI cache generation failed for report ${args.reportId}:`,
      err,
    );
    return null;
  }
}
