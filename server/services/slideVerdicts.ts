/**
 * Task #4273 — per-slide verdict sentences (audit §8.1-1). Verdicts are
 * operator-authored copy stored in report_sections under an internal key;
 * buildReportResponse strips the row from served `sections` and surfaces it
 * as a `slideVerdicts` payload map, and the anonymous share/demo paths serve
 * the stored copy without ever reaching OpenAI.
 *
 * Task #4902 (owner mandate): the finalize-time auto-drafting kick is GONE —
 * generation now happens ONLY when an operator presses the editor's
 * per-slide "Draft with AI" button (the draft endpoint returns the sentence
 * without storing it; the operator applies/edits it and saves through the
 * strict section PUT). Every AI sentence must still pass the shared quality
 * floor (shared/slideVerdicts.ts findDegenerateVerdict) before it is
 * returned — the same floor the finalize gate enforces on operator copy.
 *
 * The OpenAI client is INJECTED by callers (routes import it from
 * server/routes/middleware — the single confined adapter site). This module
 * deliberately has no vendor import, which also lets tests pass a fake
 * client.
 */
import { CHEAP_MODEL, reasoningEffortFor } from "../aiModels";
import {
  SLIDE_VERDICT_KEYS,
  SLIDE_VERDICT_LABELS,
  VERDICT_MAX_CHARS,
  findDegenerateVerdict,
  sanitizeSlideVerdictMap,
  type SlideVerdictKey,
  type SlideVerdictMap,
} from "../../shared/slideVerdicts";
import {
  readOptionalIntakeSection,
  readOptionalSalesSection,
  readOptionalMarketingSection,
  readOptionalSectionDataObject,
} from "../lib/reportJsonbAccessors";
import { sumMissedCallBucketInputs } from "../../shared/reportMetrics";
import { resolveMissedCallRate } from "../../shared/missedCallRate";

/**
 * report_sections key holding the per-slide verdict map. Internal row —
 * buildReportResponse (and the demo builder) strip it from the served
 * `sections` list and surface it as the `slideVerdicts` payload field.
 */
export const SLIDE_VERDICTS_SECTION_KEY = "slideVerdicts";

/**
 * Attribution identity the RETIRED finalize-time auto-drafting (Task #4273 →
 * removed in Task #4902) stamped on its report_section_history rows. Kept
 * because it is how the purge action attributes legacy AI-authored verdict
 * copy (server/services/slideVerdictPurge.ts): a stored key whose current
 * value was introduced by a history row with this editedBy is AI-authored.
 * No live write path uses this identity anymore.
 */
export const SLIDE_VERDICTS_AI_EDITOR = "system:slide-verdicts-ai";

/** Structural slice of the OpenAI SDK client this module needs. */
export interface SlideVerdictChatClient {
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
 * Validated read of a stored slideVerdicts section payload. Returns the
 * sparse verdict map or null when nothing usable is stored (never throws —
 * absent/garbled rows mean "no verdicts", slides render without them).
 */
export function readStoredSlideVerdicts(sectionData: unknown): SlideVerdictMap | null {
  if (!sectionData || typeof sectionData !== "object" || Array.isArray(sectionData)) {
    return null;
  }
  const verdicts = sanitizeSlideVerdictMap(
    (sectionData as Record<string, unknown>).verdicts,
  );
  return Object.keys(verdicts).length > 0 ? verdicts : null;
}

/**
 * Compact per-slide facts the prompt can quote. Built exclusively through
 * the sanctioned reportJsonbAccessors narrowing points. Slides with no
 * substantive data are omitted so the model cannot invent numbers for them.
 */
export function buildSlideVerdictContext(args: {
  reportMonth: string;
  consultType?: string | null;
  practiceAreas?: string[] | null;
  sections: Array<{ id?: string; sectionKey: string; data: unknown }>;
  reportId: string;
  clientId?: string;
  /**
   * Per-client "hide Other leads" toggle (Task #4983) — the missed-call
   * resolution must use the SAME lead set the public card displays, so the
   * caller passes the client flag and the bucket sums apply it
   * symmetrically (numerator and denominator both drop Other).
   */
  hideOtherLeads?: boolean;
  /** Optional current seasonal phase per practice area (marketContext slide). */
  seasonalPhases?: Record<string, string> | null;
}): Record<string, unknown> {
  const { sections, reportId, clientId } = args;
  const rowFor = (key: string) => sections.find((s) => s.sectionKey === key);
  const ctxMeta = (key: string) => {
    const row = rowFor(key);
    return { sectionId: row?.id, reportId, clientId };
  };

  const intake = readOptionalIntakeSection(rowFor("intake")?.data, ctxMeta("intake"));
  const sales = readOptionalSalesSection(rowFor("sales")?.data, ctxMeta("sales"));
  const marketing = readOptionalMarketingSection(
    rowFor("marketing")?.data,
    ctxMeta("marketing"),
  );
  const nextActions = readOptionalSectionDataObject(
    rowFor("nextActions")?.data,
    ctxMeta("nextActions"),
  );

  const context: Record<string, unknown> = {
    reportMonth: args.reportMonth,
    consultType: args.consultType ?? undefined,
  };

  // Task #4983 — feed the prompt the SAME three-tier resolution the report
  // surfaces show, not the raw stored field: the month's bucket sums
  // (same-lead-set, hideOtherLeads-symmetric via the shared aggregation)
  // recompute when they carry a missed call — a stale stored value can
  // never contradict the buckets the card recomputes from; else a stored
  // rate > 0 is pushed/typed truth (clamped like the card); otherwise the
  // field is omitted (undefined keys drop out of the prompt JSON) so the
  // model can never cite a fabricated 0% the card renders as "No data".
  const resolvedMissedCallRate = (() => {
    const resolved = resolveMissedCallRate({
      ...sumMissedCallBucketInputs(rowFor("marketing")?.data, {
        hideOtherLeads: args.hideOtherLeads === true,
      }),
      storedRate: intake?.missedCallRate,
    });
    return resolved === null ? undefined : resolved;
  })();

  if (intake) {
    context.intake = {
      totalConsults: intake.totalConsults,
      leadToConsultRate: intake.leadToConsultRate,
      missedCallRate: resolvedMissedCallRate,
      avgTimeToAnswerSeconds: intake.avgTimeToAnswer,
      qualityScore: intake.qualityScore,
      commonIssuesExcerpt:
        typeof intake.commonIssues === "string" && intake.commonIssues.trim().length > 0
          ? intake.commonIssues.slice(0, 400)
          : undefined,
    };
  }

  if (sales) {
    context.sales = {
      totalCases: sales.totalCases,
      consultToCaseRate: sales.consultToCaseRate,
      averageCaseValue: sales.averageCaseValue,
      noShowRate: sales.noShowRate,
      avgFollowUps: sales.avgFollowUps,
      qualityScore: sales.qualityScore,
      commonIssuesExcerpt:
        typeof sales.commonIssues === "string" && sales.commonIssues.trim().length > 0
          ? sales.commonIssues.slice(0, 400)
          : undefined,
    };
  }

  if (marketing) {
    const gbpLocations = marketing.gbp?.locations || marketing.gbpLocations || [];
    context.marketing = {
      totalLeads: marketing.totalLeads,
      leadQuality: marketing.leadQuality,
      gbpLeads: gbpLocations.reduce(
        (sum: number, loc: any) => sum + (Number(loc?.uniqueLeads) || 0),
        0,
      ),
      googleAdsLeads: marketing.googleAds?.uniqueLeads,
      googleAdsSpend: marketing.googleAds?.adSpend,
      lsaLeads: marketing.lsa?.uniqueLeads,
      lsaSpend: marketing.lsa?.adSpend,
      webinarHotTransfers: marketing.webinar?.hotTransfers,
      totalReviews: marketing.reviewGeneration?.totalReviews,
    };
  }

  if (Array.isArray(args.practiceAreas) && args.practiceAreas.length > 0) {
    context.practiceAreas = args.practiceAreas;
  }
  if (args.seasonalPhases && Object.keys(args.seasonalPhases).length > 0) {
    context.seasonalPhaseByPracticeArea = args.seasonalPhases;
  }

  const actionTitles = (list: unknown): string[] =>
    Array.isArray(list)
      ? list
          .map((a: any) => (typeof a?.action === "string" ? a.action.trim() : ""))
          .filter((s) => s.length > 0)
          .slice(0, 3)
      : [];
  if (nextActions) {
    const ours = actionTitles(nextActions.ours);
    const theirs = actionTitles(nextActions.theirs);
    if (ours.length > 0 || theirs.length > 0) {
      context.next30Days = { ourActions: ours, clientActions: theirs };
    }
  }

  return context;
}

/**
 * One JSON chat call drafting verdicts for the requested slide keys. Every
 * returned sentence is floor-checked; degenerate entries are dropped.
 * Returns the surviving sparse map, or null when the call fails or nothing
 * survives. Never throws.
 */
export async function generateSlideVerdicts(args: {
  context: Record<string, unknown>;
  slideKeys: SlideVerdictKey[];
  openaiClient: SlideVerdictChatClient;
}): Promise<SlideVerdictMap | null> {
  const slideKeys = args.slideKeys.filter((k) => SLIDE_VERDICT_KEYS.includes(k));
  if (slideKeys.length === 0) return null;

  const slideList = slideKeys
    .map((k) => `- "${k}" — the ${SLIDE_VERDICT_LABELS[k]} slide`)
    .join("\n");

  const prompt = `You write the opening verdict sentence for slides of a monthly law-firm revenue report.

A verdict is ONE plain-language sentence that tells the firm owner what the slide's numbers mean and what matters next. Reference example (do not copy): "Intake is leaking ~$18K/mo — answer speed is the fix."

SLIDES TO WRITE (JSON keys, one sentence each):
${slideList}

REPORT DATA (the ONLY numbers you may use):
${JSON.stringify(args.context, null, 2)}

RULES:
- One sentence per slide, 20-${VERDICT_MAX_CHARS} characters, plain operator language a firm owner absorbs in five seconds.
- Use ONLY numbers present in the data above. Simple arithmetic on those numbers (e.g. cases × average case value) is allowed; round aggressively ("~$18K", "about 1 in 4").
- If the data above has no substantive numbers for a slide, OMIT that slide's key entirely. Never write a filler sentence.
- State the situation and the single move that matters. No hedging, no marketing fluff, no "you should consider".
- No emojis, no markdown, no quotes around the sentence.
- engineHealth reads the lead → consult → case funnel as one machine; revenueLeak names the biggest loss and its cost; marketContext uses the seasonal phase data only.

OUTPUT (JSON only): an object whose keys are a SUBSET of the slide keys listed above, each value the verdict sentence string.`;

  try {
    const response = await args.openaiClient.chat.completions.create({
      model: CHEAP_MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      reasoning_effort: reasoningEffortFor(CHEAP_MODEL),
      max_completion_tokens: 2500,
    });
    const content = response.choices[0]?.message?.content || "{}";
    const parsed: unknown = JSON.parse(content);
    const candidate = sanitizeSlideVerdictMap(parsed);
    const out: SlideVerdictMap = {};
    for (const key of slideKeys) {
      const sentence = candidate[key];
      if (typeof sentence !== "string") continue;
      if (findDegenerateVerdict(sentence)) {
        console.warn(
          `[slide-verdicts] dropped degenerate AI verdict for ${key}: ${sentence.slice(0, 80)}`,
        );
        continue;
      }
      out[key] = sentence;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch (aiError) {
    console.error("[slide-verdicts] AI generation failed:", aiError);
    return null;
  }
}

