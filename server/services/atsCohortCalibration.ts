import { createDefaultOpenAiClient } from "./ai/openAiClient";
import { db } from "../db";
import { eq, and, inArray, sql, ne } from "drizzle-orm";
import {
  atsCandidates, atsInterviews, atsFinalDecisions,
  atsPairwiseComparisons, atsJobs,
  type AtsCandidate, type AtsInterview, type AtsFinalDecision,
} from "@shared/schema";
import { ATS_MODEL_FAST } from "./atsTypes";
import { readAtsAiScore, readAtsRoleSourceOfTruth } from "./atsJsonb";

const openai = createDefaultOpenAiClient();

export const COHORT_ACTIVE_STAGES = new Set([
  "ai_scored", "story_interview",
  "reference_interview", "focus_interview",
  "story", "reference", "focus",
  "review", "offered",
]);

export const COHORT_TERMINAL_STAGES = new Set([
  "rejected", "withdrawn", "lost", "deleted", "archived",
]);

const EXCLUDED_STAGES = new Set([
  "applied", "invited", "screening", "video",
  "rejected", "withdrawn", "lost", "deleted", "archived",
  "answers_received",
]);

interface ComparisonProfile {
  candidateId: string;
  candidateName: string;
  currentStage: string;
  baseScore: number;
  dimensions: Record<string, number> | null;
  riskTier: string | null;
  fitDelta: number | null;
  languageAgency: { score: number; underPressure: number | null; consistency: number | null } | null;
  aiLikelihood: { score: number; flag: string | null } | null;
  phoneInterview: any | null;
  storyInterview: any | null;
  referenceInterview: any | null;
  focusInterview: any | null;
  finalDecision: any | null;
  evidenceCompleteness: string[];
  evidenceCompletenessScore: number;
}

interface PairwiseResult {
  candidateAId: string;
  candidateBId: string;
  winner: "candidate_a" | "candidate_b" | "tie";
  confidence: "low" | "medium" | "high";
  decisiveFactors: string[];
}

export async function getActiveCohortForRole(jobId: string): Promise<AtsCandidate[]> {
  const candidates = await db.select().from(atsCandidates)
    .where(eq(atsCandidates.jobId, jobId));

  return candidates.filter(c => {
    if (EXCLUDED_STAGES.has(c.stage)) return false;
    if (!COHORT_ACTIVE_STAGES.has(c.stage)) return false;
    if (c.totalScore == null) return false;
    return true;
  });
}

export function buildCandidateComparisonProfile(
  candidate: AtsCandidate,
  interviews: AtsInterview[],
  finalDecision: AtsFinalDecision | null,
): ComparisonProfile {
  const aiScore = readAtsAiScore(candidate.aiScoreJson, { candidateId: candidate.id });
  const dimensions = aiScore?.dimensions || aiScore?.dimension_scores || null;

  const phoneInterview = interviews.find(i => i.interviewType === "phone" && i.analysisStatus === "analyzed");
  const storyInterview = interviews.find(i => i.interviewType === "story" && i.analysisStatus === "analyzed");
  const referenceInterview = interviews.find(i => i.interviewType === "reference" && i.analysisStatus === "analyzed");
  const focusInterview = interviews.find(i => i.interviewType === "focus" && i.analysisStatus === "analyzed");

  const evidenceCompleteness: string[] = [];
  if (candidate.totalScore != null) evidenceCompleteness.push("assessment");
  if (phoneInterview) evidenceCompleteness.push("phone");
  if (storyInterview) evidenceCompleteness.push("story");
  if (referenceInterview) evidenceCompleteness.push("reference");
  if (focusInterview) evidenceCompleteness.push("focus");

  return {
    candidateId: candidate.id,
    candidateName: candidate.name,
    currentStage: candidate.stage,
    baseScore: candidate.assessmentBaseScore ?? candidate.totalScore ?? 0,
    dimensions,
    riskTier: candidate.riskTier,
    fitDelta: candidate.fitDelta,
    languageAgency: candidate.languageAgencyScore != null ? {
      score: candidate.languageAgencyScore,
      underPressure: candidate.agencyUnderPressure,
      consistency: candidate.agencyConsistency,
    } : null,
    aiLikelihood: candidate.aiLikelihoodScore != null ? {
      score: candidate.aiLikelihoodScore,
      flag: candidate.aiAssistanceFlag,
    } : null,
    phoneInterview: phoneInterview?.analysisJson || null,
    storyInterview: storyInterview?.analysisJson || null,
    referenceInterview: referenceInterview?.analysisJson || null,
    focusInterview: focusInterview?.analysisJson || null,
    finalDecision: finalDecision?.decisionJson || null,
    evidenceCompleteness,
    evidenceCompletenessScore: evidenceCompleteness.length / 5,
  };
}

function formatProfileForPrompt(profile: ComparisonProfile, label: string): string {
  const parts: string[] = [`## ${label}: ${profile.candidateName}`];
  parts.push(`Stage: ${profile.currentStage}`);
  parts.push(`Base Assessment Score: ${profile.baseScore}/100`);
  if (profile.riskTier) parts.push(`Risk Tier: ${profile.riskTier}`);
  if (profile.fitDelta != null) parts.push(`Fit Delta: ${profile.fitDelta}`);

  if (profile.dimensions) {
    parts.push(`Dimension Scores: ${JSON.stringify(profile.dimensions)}`);
  }

  if (profile.languageAgency) {
    parts.push(`Language Agency: score=${profile.languageAgency.score}, under_pressure=${profile.languageAgency.underPressure}, consistency=${profile.languageAgency.consistency}`);
  }

  if (profile.aiLikelihood) {
    parts.push(`AI Likelihood: score=${profile.aiLikelihood.score}, flag=${profile.aiLikelihood.flag}`);
  }

  if (profile.phoneInterview) {
    parts.push(`Phone Interview Analysis: ${JSON.stringify(profile.phoneInterview)}`);
  }

  if (profile.storyInterview) {
    parts.push(`Story Interview Analysis: ${JSON.stringify(profile.storyInterview)}`);
  }

  if (profile.referenceInterview) {
    parts.push(`Reference Interview Analysis: ${JSON.stringify(profile.referenceInterview)}`);
  }

  if (profile.focusInterview) {
    parts.push(`Focus Interview Analysis: ${JSON.stringify(profile.focusInterview)}`);
  }

  if (profile.finalDecision) {
    parts.push(`Final Decision Signals: ${JSON.stringify(profile.finalDecision)}`);
  }

  parts.push(`Evidence Available: ${profile.evidenceCompleteness.join(", ")} (${Math.round(profile.evidenceCompletenessScore * 100)}% complete)`);

  return parts.join("\n");
}

export async function compareCandidatesForRole(
  profileA: ComparisonProfile,
  profileB: ComparisonProfile,
  roleTitle: string,
  roleContext: string | null,
): Promise<PairwiseResult> {
  const systemPrompt = `You are a hiring comparison engine. You must decide which candidate is a stronger fit for the role of "${roleTitle}".

RULES:
- Compare strongest fit for THIS SPECIFIC ROLE, not nicest overall profile.
- Use ALL currently available scored evidence for both candidates.
- Do NOT reward verbosity or polished writing — reward substance, ownership, and real examples.
- Missing evidence should REDUCE your confidence, NOT automatically count against the candidate.
- If one candidate has much less evidence but existing data is clearly stronger, you may still favor them, but lower your confidence.
- Weighting priority: assessment/test > focus interview > story interview > phone interview > reference interview.
- Choose ONE: candidate_a wins, candidate_b wins, or tie (true ties only).
- Assign confidence: low (unclear/limited evidence), medium (moderate signal), high (clear separation).
- List 2-3 decisive factors that drove your decision.

Respond with ONLY valid JSON in this exact format:
{"winner":"candidate_a"|"candidate_b"|"tie","confidence":"low"|"medium"|"high","decisive_factors":["factor1","factor2"]}`;

  const userPrompt = `${roleContext ? `Role Context: ${roleContext}\n\n` : ""}${formatProfileForPrompt(profileA, "Candidate A")}\n\n${formatProfileForPrompt(profileB, "Candidate B")}`;

  try {
    const response = await openai.chat.completions.create({
      model: ATS_MODEL_FAST,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      reasoning_effort: "minimal",
      max_completion_tokens: 2000,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty response from comparison engine");

    const parsed = JSON.parse(content);
    return {
      candidateAId: profileA.candidateId,
      candidateBId: profileB.candidateId,
      winner: parsed.winner || "tie",
      confidence: parsed.confidence || "low",
      decisiveFactors: Array.isArray(parsed.decisive_factors) ? parsed.decisive_factors : [],
    };
  } catch (error: any) {
    console.error(`[Cohort Calibration] Pairwise comparison failed for ${profileA.candidateName} vs ${profileB.candidateName}:`, error.message);
    return {
      candidateAId: profileA.candidateId,
      candidateBId: profileB.candidateId,
      winner: "tie",
      confidence: "low",
      decisiveFactors: ["comparison_error"],
    };
  }
}

const CONFIDENCE_WEIGHTS: Record<string, number> = {
  low: 1.0,
  medium: 1.15,
  high: 1.3,
};

export function computeCalibrationScores(
  pairwiseResults: PairwiseResult[],
  candidateIds: string[],
  cohortSize: number,
): Map<string, { pairwiseScore: number; winRate: number; multiplier: number; rank: number; percentile: number }> {
  const scores = new Map<string, { weightedPoints: number; maxPoints: number }>();

  for (const id of candidateIds) {
    scores.set(id, { weightedPoints: 0, maxPoints: 0 });
  }

  for (const result of pairwiseResults) {
    const weight = CONFIDENCE_WEIGHTS[result.confidence] || 1.0;
    const aData = scores.get(result.candidateAId);
    const bData = scores.get(result.candidateBId);

    if (aData) {
      aData.maxPoints += weight;
      if (result.winner === "candidate_a") aData.weightedPoints += weight;
      else if (result.winner === "tie") aData.weightedPoints += weight * 0.5;
    }
    if (bData) {
      bData.maxPoints += weight;
      if (result.winner === "candidate_b") bData.weightedPoints += weight;
      else if (result.winner === "tie") bData.weightedPoints += weight * 0.5;
    }
  }

  const winRates = new Map<string, number>();
  for (const [id, data] of scores) {
    winRates.set(id, data.maxPoints > 0 ? data.weightedPoints / data.maxPoints : 0.5);
  }

  const sorted = [...winRates.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  let minMult: number, maxMult: number;
  if (cohortSize < 2) {
    minMult = 1.0; maxMult = 1.0;
  } else if (cohortSize < 4) {
    minMult = 0.97; maxMult = 1.03;
  } else {
    minMult = 0.92; maxMult = 1.08;
  }

  const results = new Map<string, { pairwiseScore: number; winRate: number; multiplier: number; rank: number; percentile: number }>();

  for (let i = 0; i < sorted.length; i++) {
    const [id, winRate] = sorted[i];
    const rank = i + 1;
    const percentile = cohortSize > 1
      ? ((cohortSize - rank) / (cohortSize - 1)) * 100
      : 50;

    const normalizedPosition = cohortSize > 1
      ? (cohortSize - rank) / (cohortSize - 1)
      : 0.5;

    const multiplier = minMult + normalizedPosition * (maxMult - minMult);

    results.set(id, {
      pairwiseScore: winRate * 100,
      winRate,
      multiplier: Math.round(multiplier * 1000) / 1000,
      rank,
      percentile: Math.round(percentile * 10) / 10,
    });
  }

  return results;
}

async function generateComparativeSummary(
  profile: ComparisonProfile,
  calibration: { rank: number; percentile: number; multiplier: number; winRate: number },
  cohortSize: number,
  roleTitle: string,
): Promise<string> {
  const position = calibration.rank <= Math.ceil(cohortSize * 0.25)
    ? "top quarter"
    : calibration.rank <= Math.ceil(cohortSize * 0.5)
      ? "upper half"
      : calibration.rank <= Math.ceil(cohortSize * 0.75)
        ? "lower half"
        : "bottom quarter";

  const smallPoolNote = cohortSize < 5
    ? `\nIMPORTANT: There are only ${cohortSize} candidates in the active pool. Note the limited comparison data — rankings and matchup results carry less weight with fewer candidates.`
    : "";

  const systemPrompt = `Write a 1-2 sentence comparative summary explaining where this candidate stands relative to the active pool for the role of "${roleTitle}". Candidates are compared head-to-head across their full hiring profile: assessment scores, interview evidence, risk tier, and role fit. Explain what sets this candidate apart in concrete terms. Never reference "win rate" as a bare statistic — instead describe matchup results in plain language (e.g., "preferred over all other candidates" or "outperformed 3 of 4 candidates across assessment and interview evidence"). No hedging. No fluff.${smallPoolNote}`;

  const winsCount = Math.round(calibration.winRate * (cohortSize - 1));
  const matchups = cohortSize - 1;

  const userPrompt = `Candidate: ${profile.candidateName}
Base Score: ${profile.baseScore}/100
Rank: ${calibration.rank} of ${cohortSize} active candidates
Head-to-Head Matchups: Preferred in ${winsCount} of ${matchups} comparisons (across assessment scores, interview evidence, risk tier, and role fit)
Position: ${position}
Evidence Available: ${profile.evidenceCompleteness.join(", ")}
Risk Tier: ${profile.riskTier || "unknown"}
Fit Delta: ${profile.fitDelta ?? "unknown"}`;

  try {
    const response = await openai.chat.completions.create({
      model: ATS_MODEL_FAST,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      reasoning_effort: "minimal",
      max_completion_tokens: 2000,
    });
    return response.choices[0]?.message?.content?.trim() || `Ranked ${calibration.rank} of ${cohortSize} in active pool.`;
  } catch {
    return `Ranked ${calibration.rank} of ${cohortSize} in active pool.`;
  }
}

const recalibrationInProgress = new Set<string>();

export async function recalibrateRoleCohort(jobId: string): Promise<void> {
  if (recalibrationInProgress.has(jobId)) {
    return;
  }
  recalibrationInProgress.add(jobId);
  try {
    await _recalibrateRoleCohortInner(jobId);
  } finally {
    recalibrationInProgress.delete(jobId);
  }
}

async function _recalibrateRoleCohortInner(jobId: string): Promise<void> {
  const startTime = Date.now();
  const cohort = await getActiveCohortForRole(jobId);

  if (cohort.length < 2) {
    console.log(`[Cohort Calibration] Cohort too small (${cohort.length}), setting multiplier to 1.0`);
    for (const candidate of cohort) {
      const base = candidate.assessmentBaseScore ?? candidate.totalScore ?? 0;
      const cohortMult = 1.0;
      const rawFinal = base * cohortMult;
      const maxAllowed = base * 1.12;
      const minAllowed = base * 0.88;
      const finalScore = Math.round(Math.min(100, Math.max(0, Math.min(maxAllowed, Math.max(minAllowed, rawFinal)))) * 10) / 10;

      const smallCohortNote = cohort.length === 1 ? "Only candidate in active pool — no comparative data yet." : null;
      await db.update(atsCandidates).set({
        assessmentBaseScore: base,
        interviewMultiplier: null,
        interviewAdjustmentPercent: null,
        interviewAdjustmentSummary: null,
        calibratedScore: finalScore,
        calibrationMultiplier: cohortMult,
        finalDisplayScore: finalScore,
        scoreChangeSummary: `No change from base score of ${base.toFixed(0)}. ${smallCohortNote || "No cohort adjustment."}`,
        cohortAdjustmentSummary: smallCohortNote,
        pairwiseWinRate: null,
        cohortRank: 1,
        cohortPercentile: 50,
        cohortSize: cohort.length,
        comparativeSummary: smallCohortNote,
        lastCalibratedAt: new Date(),
      }).where(eq(atsCandidates.id, candidate.id));
    }
    return;
  }

  const candidateIds = cohort.map(c => c.id);
  const allInterviews = await db.select().from(atsInterviews)
    .where(inArray(atsInterviews.candidateId, candidateIds));

  const allDecisions = await db.select().from(atsFinalDecisions)
    .where(inArray(atsFinalDecisions.candidateId, candidateIds));

  const interviewsByCandidate = new Map<string, AtsInterview[]>();
  for (const interview of allInterviews) {
    const existing = interviewsByCandidate.get(interview.candidateId) || [];
    existing.push(interview);
    interviewsByCandidate.set(interview.candidateId, existing);
  }

  const decisionsByCandidate = new Map<string, AtsFinalDecision>();
  for (const decision of allDecisions) {
    const existing = decisionsByCandidate.get(decision.candidateId);
    if (!existing || (decision.createdAt && existing.createdAt && decision.createdAt > existing.createdAt)) {
      decisionsByCandidate.set(decision.candidateId, decision);
    }
  }

  const profiles = cohort.map(c => buildCandidateComparisonProfile(
    c,
    interviewsByCandidate.get(c.id) || [],
    decisionsByCandidate.get(c.id) || null,
  ));

  const job = await db.select().from(atsJobs).where(eq(atsJobs.id, jobId)).limit(1);
  const roleTitle = job[0]?.title || "Unknown Role";
  const roleContext = job[0]?.roleSourceOfTruth
    ? JSON.stringify(readAtsRoleSourceOfTruth(job[0].roleSourceOfTruth)?.role_summary || "")
    : null;

  const pairwiseResults: PairwiseResult[] = [];
  const BATCH_SIZE = 5;
  const pairs: [ComparisonProfile, ComparisonProfile][] = [];

  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      pairs.push([profiles[i], profiles[j]]);
    }
  }

  for (let batchStart = 0; batchStart < pairs.length; batchStart += BATCH_SIZE) {
    const batch = pairs.slice(batchStart, batchStart + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(([a, b]) => compareCandidatesForRole(a, b, roleTitle, roleContext))
    );
    pairwiseResults.push(...batchResults);
  }

  await db.delete(atsPairwiseComparisons).where(eq(atsPairwiseComparisons.jobId, jobId));
  if (pairwiseResults.length > 0) {
    for (const result of pairwiseResults) {
      await db.insert(atsPairwiseComparisons).values({
        jobId,
        candidateAId: result.candidateAId,
        candidateBId: result.candidateBId,
        winner: result.winner,
        confidence: result.confidence,
        decisiveFactors: result.decisiveFactors,
      });
    }
  }

  const calibrationScores = computeCalibrationScores(pairwiseResults, candidateIds, cohort.length);

  const summaryPromises = profiles.map(async (profile) => {
    const cal = calibrationScores.get(profile.candidateId);
    if (!cal) return { candidateId: profile.candidateId, summary: "No calibration data." };

    const summary = await generateComparativeSummary(profile, cal, cohort.length, roleTitle);
    return { candidateId: profile.candidateId, summary };
  });

  const summaries = await Promise.all(summaryPromises);
  const summaryMap = new Map(summaries.map(s => [s.candidateId, s.summary]));

  for (const candidate of cohort) {
    const cal = calibrationScores.get(candidate.id);
    if (!cal) continue;

    const base = candidate.assessmentBaseScore ?? candidate.totalScore ?? 0;
    const cohortMult = cal.multiplier;

    const rawFinal = base * cohortMult;
    const maxAllowed = base * 1.12;
    const minAllowed = base * 0.88;
    const finalScore = Math.round(Math.min(100, Math.max(0, Math.min(maxAllowed, Math.max(minAllowed, rawFinal)))) * 10) / 10;
    const calibratedScore = finalScore;

    const changePct = base > 0 ? ((finalScore - base) / base * 100) : 0;

    const cohortAdj = cohortMult !== 1.0
      ? `Relative ranking ${cohortMult > 1 ? "boosted" : "softened"} the score (×${cohortMult.toFixed(3)}).`
      : "No cohort adjustment.";

    const changeSummary = changePct === 0
      ? `No change from base score of ${base.toFixed(0)}. ${cohortAdj}`
      : `Score ${changePct > 0 ? "boosted" : "adjusted"} ${changePct > 0 ? "+" : ""}${changePct.toFixed(1)}% from base ${base.toFixed(0)} → ${finalScore.toFixed(0)}. ${cohortAdj}`;

    await db.update(atsCandidates).set({
      assessmentBaseScore: base,
      interviewMultiplier: null,
      interviewAdjustmentPercent: null,
      interviewAdjustmentSummary: null,
      calibratedScore,
      calibrationMultiplier: cohortMult,
      finalDisplayScore: finalScore,
      scoreChangeSummary: changeSummary,
      cohortAdjustmentSummary: cohortAdj,
      pairwiseWinRate: cal.winRate,
      cohortRank: cal.rank,
      cohortPercentile: cal.percentile,
      cohortSize: cohort.length,
      comparativeSummary: summaryMap.get(candidate.id) || null,
      lastCalibratedAt: new Date(),
    }).where(eq(atsCandidates.id, candidate.id));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Cohort Calibration] Recalibration complete for job ${jobId} in ${elapsed}s. ${cohort.length} candidates, ${pairwiseResults.length} comparisons.`);
}
