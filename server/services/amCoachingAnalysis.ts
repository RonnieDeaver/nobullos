// @db-pool-intent: worker
//
// Task #3712 — per-AM coaching analysis + department synthesis.
//
// Model conventions follow server/services/dailyJudgment.ts: centralized
// QUALITY_MODEL from server/aiModels.ts, module-local OpenAI client on the
// AI_INTEGRATIONS_* env pair, `response_format: json_object`, and a narrow
// `__test_setCoachingChatCreate` seam so hermetic tests stub the chat call
// without ESM patching.
//
// The attribution guarantee is enforced MECHANICALLY here, not just via
// prompt: a "mistake" survives only if at least one of its evidence
// citations resolves to a sample where the AM was verifiably on the call /
// authored the email. Mistakes citing only unattributed material are demoted
// to unattributed observations — shown, but never pinned on the AM.
//
// Evidence excerpts are grounded the same way: a model-supplied excerpt is
// kept only if it appears (normalized) inside the cited sample's own text,
// so a hallucinated quote can never be rendered as "verbatim" from a real
// record. Citations that fail the check are rejected outright. The same
// mechanical stance applies to the department synthesis: a pattern is
// "department-wide" only when 2+ distinct AMs share it, with severity-5
// singletons as the lone, deliberate exception (mirrors the prompt rule).
import { createDefaultOpenAiClient } from "./ai/openAiClient";
import { QUALITY_MODEL } from "../aiModels";
import type {
  AmCoachingDepartmentSynthesis,
  AmCoachingEvidence,
  AmCoachingMistake,
  AmCoachingStrength,
  AmCoachingUnattributedObservation,
} from "@shared/schema";
import type { AmSample, AmSampleSet } from "./amCoachingSampler";

const openai = createDefaultOpenAiClient();

export const AM_COACHING_MODEL_VERSION = QUALITY_MODEL;

const MAX_EXCERPT_CHARS = 300;
const MAX_MISTAKES = 8;
const MAX_STRENGTHS = 6;

// ---------------------------------------------------------------------------
// Test seam (dailyJudgment convention): tests replace the chat call with a
// stub; production always goes through the module OpenAI client.
// ---------------------------------------------------------------------------

type CoachingChatCreate = (params: {
  model: string;
  response_format: { type: "json_object" };
  messages: Array<{ role: "system" | "user"; content: string }>;
}) => Promise<{ choices: Array<{ message?: { content?: string | null } | null }> }>;

const defaultChatCreate: CoachingChatCreate = (params) =>
  openai.chat.completions.create(params as any) as any;
let chatCreateImpl: CoachingChatCreate = defaultChatCreate;

export function __test_setCoachingChatCreate(fn: CoachingChatCreate | null): void {
  chatCreateImpl = fn ?? defaultChatCreate;
}

// ---------------------------------------------------------------------------

export interface AmCoachingAnalysisResult {
  mistakes: AmCoachingMistake[];
  unattributed: AmCoachingUnattributedObservation[];
  strengths: AmCoachingStrength[];
  zoomSummary: string | null;
  emailSummary: string | null;
  coachingFocus: string | null;
}

function parseModelJson(rawContent: string): any {
  let text = rawContent.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return JSON.parse(text);
}

function asCleanString(value: unknown, max = 2000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function clampSeverity(value: unknown): number {
  const n = typeof value === "number" ? Math.round(value) : parseInt(String(value), 10);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

/**
 * Collapse text to lowercase alphanumeric words so excerpt verification
 * tolerates the model normalizing whitespace, quotes, or punctuation while
 * still requiring the actual words to come from the cited sample.
 */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function evidenceFromSample(sample: AmSample, excerpt: string | null): AmCoachingEvidence {
  return {
    recordId: sample.recordId,
    clientId: sample.clientId,
    clientName: sample.clientName,
    sourceType: sample.sourceType,
    title: sample.title,
    timestamp: sample.timestamp.toISOString(),
    excerpt: (excerpt ?? sample.content.slice(0, 200)).slice(0, MAX_EXCERPT_CHARS),
    attributed: sample.attributed,
  };
}

function mapEvidenceList(rawList: unknown, samples: AmSample[]): AmCoachingEvidence[] {
  if (!Array.isArray(rawList)) return [];
  const out: AmCoachingEvidence[] = [];
  const seen = new Set<string>();
  for (const raw of rawList) {
    const idx =
      typeof raw?.sampleIndex === "number"
        ? raw.sampleIndex
        : parseInt(String(raw?.sampleIndex), 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= samples.length) continue;
    const sample = samples[idx];
    const key = `${sample.recordId}`;
    if (seen.has(key)) continue;
    const excerpt = asCleanString(raw?.excerpt, MAX_EXCERPT_CHARS);
    if (excerpt) {
      // Excerpt grounding: the quote must actually occur in the cited
      // sample's text (normalized), or the whole citation is rejected — a
      // fabricated "verbatim" quote must never reach the director.
      const normalized = normalizeForMatch(excerpt);
      if (!normalized || !normalizeForMatch(sample.content).includes(normalized)) {
        continue;
      }
      seen.add(key);
      out.push(evidenceFromSample(sample, excerpt));
    } else {
      // No excerpt claimed: fall back to the head of the sample's own text,
      // which is source-derived and therefore cannot be fabricated.
      seen.add(key);
      out.push(evidenceFromSample(sample, null));
    }
  }
  return out;
}

function formatSampleBlock(sample: AmSample, index: number): string {
  const kind = sample.sourceType === "zoom" ? "ZOOM CALL" : "EMAIL";
  const verified = sample.attributed
    ? sample.sourceType === "zoom"
      ? "AM VERIFIED ON CALL"
      : "AM VERIFIED AUTHOR"
    : "STAFF MEMBER UNVERIFIED — do not attribute to the AM";
  const client = sample.clientName ?? "Unknown client";
  const when = sample.timestamp.toISOString().slice(0, 10);
  return [
    `[Sample ${index} — ${kind} — ${verified} — Client: ${client} — ${when} — "${sample.title}"]`,
    sample.content,
  ].join("\n");
}

function getAnalysisSystemPrompt(): string {
  return `You are an elite account-management coach at a legal marketing agency. You review an account manager's (AM's) real client communications — Zoom call transcripts and outbound emails — and produce direct, evidence-grounded coaching.

STRICT RULES:
1. Only samples marked "AM VERIFIED" show this AM's own behavior. Mistakes may ONLY be based on VERIFIED samples.
2. Samples marked "STAFF MEMBER UNVERIFIED" may reveal problems in the account, but the person acting cannot be identified. Report anything notable there under "unattributedObservations" — NEVER as the AM's mistake.
3. Every mistake and every unattributed observation MUST cite evidence: the sample index plus a short VERBATIM excerpt (max 240 characters) copied from that sample. Do not paraphrase inside "excerpt". Do not invent quotes.
4. Rank mistakes by churn impact. severity: 1 (minor polish) to 5 (actively driving churn risk).
5. Look for recurring PATTERNS across samples (missed follow-through, vague answers, over-promising, defensiveness, failure to set agendas, ignoring client questions, slow escalation, burying bad news, no next steps), not one-off nitpicks.
6. Analyze Zoom-call behavior and email behavior separately in "zoomSummary" and "emailSummary". If a channel has no verified samples, say so plainly in that summary.
7. Be specific and coachable — name the behavior, why it hurts retention, and what to do instead. No generic advice.

Respond with ONLY a JSON object in exactly this shape:
{
  "mistakes": [
    { "title": string, "description": string, "severity": 1-5, "channel": "zoom"|"email",
      "evidence": [ { "sampleIndex": number, "excerpt": string } ] }
  ],
  "unattributedObservations": [
    { "title": string, "description": string,
      "evidence": [ { "sampleIndex": number, "excerpt": string } ] }
  ],
  "strengths": [ { "title": string, "description": string, "channel": "zoom"|"email"|"both" } ],
  "zoomSummary": string,
  "emailSummary": string,
  "coachingFocus": string
}`;
}

/**
 * Analyze one AM's sampled communications into structured coaching output.
 * Throws on model/parse failure — the orchestrator isolates per-AM errors.
 */
export async function analyzeAmCoaching(
  sampleSet: AmSampleSet,
): Promise<AmCoachingAnalysisResult> {
  const { samples } = sampleSet;
  const attributed = samples.filter((s) => s.attributed);
  const zoomCount = attributed.filter((s) => s.sourceType === "zoom").length;
  const emailCount = attributed.length - zoomCount;

  const userPrompt = [
    `Account manager under review: ${sampleSet.amName} (${sampleSet.amEmail})`,
    `Book size: ${sampleSet.clientCount} active clients.`,
    `Verified samples: ${zoomCount} Zoom calls, ${emailCount} outbound emails. Unverified context samples: ${samples.length - attributed.length}.`,
    ``,
    ...samples.map((s, i) => formatSampleBlock(s, i)),
  ].join("\n\n");

  const response = await chatCreateImpl({
    model: AM_COACHING_MODEL_VERSION,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: getAnalysisSystemPrompt() },
      { role: "user", content: userPrompt },
    ],
  });

  const rawContent = response.choices[0]?.message?.content;
  if (!rawContent) throw new Error("Empty AI response for AM coaching analysis");
  const parsed = parseModelJson(rawContent);

  const mistakes: AmCoachingMistake[] = [];
  const unattributed: AmCoachingUnattributedObservation[] = [];

  const rawMistakes = Array.isArray(parsed?.mistakes) ? parsed.mistakes : [];
  for (const raw of rawMistakes) {
    const title = asCleanString(raw?.title, 200);
    if (!title) continue;
    const description = asCleanString(raw?.description) ?? "";
    const evidence = mapEvidenceList(raw?.evidence, samples);
    const attributedEvidence = evidence.filter((e) => e.attributed);
    const channel: "zoom" | "email" =
      raw?.channel === "zoom" || raw?.channel === "email"
        ? raw.channel
        : attributedEvidence[0]?.sourceType === "zoom"
          ? "zoom"
          : "email";
    if (attributedEvidence.length === 0) {
      // Attribution guarantee: no verified evidence → never pinned on the AM.
      if (evidence.length > 0) {
        unattributed.push({ title, description, evidence });
      }
      continue;
    }
    mistakes.push({
      title,
      description,
      severity: clampSeverity(raw?.severity),
      channel,
      evidence: attributedEvidence,
    });
  }

  const rawUnattributed = Array.isArray(parsed?.unattributedObservations)
    ? parsed.unattributedObservations
    : [];
  for (const raw of rawUnattributed) {
    const title = asCleanString(raw?.title, 200);
    if (!title) continue;
    const description = asCleanString(raw?.description) ?? "";
    const evidence = mapEvidenceList(raw?.evidence, samples);
    if (evidence.length === 0) continue; // uncited observations are dropped
    unattributed.push({ title, description, evidence });
  }

  const strengths: AmCoachingStrength[] = [];
  const rawStrengths = Array.isArray(parsed?.strengths) ? parsed.strengths : [];
  for (const raw of rawStrengths) {
    const title = asCleanString(raw?.title, 200);
    if (!title) continue;
    strengths.push({
      title,
      description: asCleanString(raw?.description) ?? "",
      channel:
        raw?.channel === "zoom" || raw?.channel === "email" || raw?.channel === "both"
          ? raw.channel
          : "both",
    });
  }

  mistakes.sort((a, b) => b.severity - a.severity);

  return {
    mistakes: mistakes.slice(0, MAX_MISTAKES),
    unattributed,
    strengths: strengths.slice(0, MAX_STRENGTHS),
    zoomSummary: asCleanString(parsed?.zoomSummary),
    emailSummary: asCleanString(parsed?.emailSummary),
    coachingFocus: asCleanString(parsed?.coachingFocus),
  };
}

// ---------------------------------------------------------------------------
// Department synthesis
// ---------------------------------------------------------------------------

export interface SynthesisInputReport {
  amUserId: string;
  amName: string;
  mistakes: Pick<AmCoachingMistake, "title" | "description" | "severity" | "channel">[];
}

function getSynthesisSystemPrompt(): string {
  return `You are the head coach of an account-management department at a legal marketing agency. You are given each account manager's individually diagnosed mistakes. Identify the patterns the TEAM shares so the director can run department-wide coaching.

RULES:
1. Merge near-duplicate mistakes across AMs into one common pattern with a clear name.
2. For each common pattern, list which AMs share it using their index numbers. Only include patterns shared by at least two AMs, unless a single-AM pattern is severity 5.
3. severity: 1-5 by team-level churn impact (how widespread × how damaging).
4. "summary": 2-4 sentences on the department's overall coaching priorities.

Respond with ONLY a JSON object in exactly this shape:
{
  "summary": string,
  "commonMistakes": [
    { "title": string, "description": string, "severity": 1-5, "amIndexes": [number] }
  ]
}`;
}

/**
 * Department-wide synthesis across completed per-AM reports. Returns null
 * when fewer than one report has any mistakes to synthesize.
 */
export async function synthesizeDepartment(
  reports: SynthesisInputReport[],
): Promise<AmCoachingDepartmentSynthesis | null> {
  const withMistakes = reports.filter((r) => r.mistakes.length > 0);
  if (withMistakes.length === 0) return null;

  const userPrompt = withMistakes
    .map((r, i) => {
      const lines = r.mistakes
        .map(
          (m) =>
            `  - [severity ${m.severity}, ${m.channel}] ${m.title}: ${m.description}`,
        )
        .join("\n");
      return `AM ${i} — ${r.amName}:\n${lines}`;
    })
    .join("\n\n");

  const response = await chatCreateImpl({
    model: AM_COACHING_MODEL_VERSION,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: getSynthesisSystemPrompt() },
      { role: "user", content: userPrompt },
    ],
  });

  const rawContent = response.choices[0]?.message?.content;
  if (!rawContent) throw new Error("Empty AI response for department synthesis");
  const parsed = parseModelJson(rawContent);

  const commonMistakes = [];
  const rawCommon = Array.isArray(parsed?.commonMistakes) ? parsed.commonMistakes : [];
  for (const raw of rawCommon) {
    const title = asCleanString(raw?.title, 200);
    if (!title) continue;
    const amUserIds: string[] = [];
    const rawIndexes = Array.isArray(raw?.amIndexes) ? raw.amIndexes : [];
    for (const rawIdx of rawIndexes) {
      const idx = typeof rawIdx === "number" ? rawIdx : parseInt(String(rawIdx), 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= withMistakes.length) continue;
      const id = withMistakes[idx].amUserId;
      if (!amUserIds.includes(id)) amUserIds.push(id);
    }
    if (amUserIds.length === 0) continue;
    const severity = clampSeverity(raw?.severity);
    // Cardinality guard (mechanical twin of prompt rule 2): a pattern is
    // only "department-wide" when at least two distinct AMs share it; a
    // single-AM finding survives solely as the severity-5 exception.
    if (amUserIds.length < 2 && severity !== 5) continue;
    commonMistakes.push({
      title,
      description: asCleanString(raw?.description) ?? "",
      severity,
      amUserIds,
    });
  }
  commonMistakes.sort((a, b) => b.severity - a.severity || b.amUserIds.length - a.amUserIds.length);

  return {
    summary: asCleanString(parsed?.summary) ?? "",
    commonMistakes,
  };
}
