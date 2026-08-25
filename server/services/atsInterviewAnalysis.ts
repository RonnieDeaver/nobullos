import { createDefaultOpenAiClient } from "./ai/openAiClient";
import { QUALITY_MODEL } from "../aiModels";

const openai = createDefaultOpenAiClient();

export interface PhoneInterviewAnalysis {
  summary: string;
  strengths: string[];
  concerns: string[];
  notableQuotes: string[];
  professionalismSignal: "strong" | "adequate" | "weak";
  technicalViabilitySignal: "strong" | "adequate" | "weak";
  selfReflectionSignal: "strong" | "adequate" | "weak";
  compensationFitSignal: "fit" | "borderline" | "misaligned" | "unknown";
  careerClarity: "clear" | "developing" | "unclear";
  motivationForApplying: string;
  recommendedOutcome: "pass" | "fail" | "borderline";
  confidenceScore: number;
}

export interface StoryInterviewAnalysis {
  summary: string;
  careerNarrativeSnapshot: string;
  repeatedStrengths: string[];
  repeatedWeaknesses: string[];
  riskFlags: string[];
  growthMindsetSignal: "strong" | "moderate" | "weak";
  victimMindsetSignal: "none" | "mild" | "strong";
  emotionalStabilitySignal: "stable" | "mixed" | "volatile";
  integritySignal: "strong" | "adequate" | "concerning";
  initiativePatterns: string[];
  reasonsForLeaving: string[];
  inconsistencies: string[];
  notableQuotes: string[];
  followUpQuestions: string[];
  recommendation: "strong" | "mixed" | "weak";
}

export interface ReferenceInterviewAnalysis {
  summary: string;
  endorsementStrength: "strong" | "moderate" | "weak";
  confirmedStrengths: string[];
  confirmedWeaknesses: string[];
  inconsistenciesWithCandidateStory: string[];
  hesitationFlags: string[];
  quoteHighlights: string[];
  referenceConfidenceLevel: "high" | "moderate" | "low";
  overallRecommendation: "supportive" | "mixed" | "concerning";
}

export interface FocusInterviewAnalysis {
  summary: string;
  categoriesReviewed: string[];
  categoryScores: Record<string, number>;
  strongestCategories: string[];
  weakestCategories: string[];
  evidenceByCategory: Record<string, string>;
  notableQuotes: string[];
  finalFitRecommendation: "strong fit" | "adequate fit" | "poor fit";
}

export interface FinalCandidateDecision {
  finalRecommendation: "Strong Yes" | "Yes" | "Mixed" | "No";
  confidenceLevel: number;
  topReasonsToHire: string[];
  topRisks: string[];
  contradictionsAcrossStages: string[];
  authenticityConcerns: string[];
  strongestEvidence: string[];
  weakestEvidence: string[];
  unresolvedQuestions: string[];
  recommendedNextStep: "Offer" | "Hold" | "Reject";
  authenticityFlag: string;
  aiAssistanceLikelihood: string;
  languageAgencyScore: number | null;
  agencyUnderPressure: number | null;
}

async function callOpenAI(systemPrompt: string, userContent: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: QUALITY_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
  });
  return response.choices[0]?.message?.content || "{}";
}

export async function analyzePhoneInterview(
  transcript: string,
  jobContext: { title: string; roleSourceOfTruth?: any }
): Promise<PhoneInterviewAnalysis> {
  const systemPrompt = `You are a senior hiring analyst evaluating a phone interview.

You may receive a full transcript, interviewer notes, or both. Treat all provided material as evidence.
When both are provided, the transcript is primary evidence and notes provide interviewer observations and context.
When only notes are provided, base your analysis on those observations but note reduced confidence due to lack of verbatim transcript.

IMPORTANT RULES:
- This analysis is advisory only and must not alter any official written assessment scores.
- Cite evidence from the provided content.
- Identify strengths, risks, contradictions, and follow-up flags.
- Avoid false certainty when evidence is weak.

Evaluate the following dimensions:
1. Professionalism - communication quality, tone, preparation
2. Technical baseline - relevant skills and experience mentioned
3. Self-reflection - ability to discuss growth areas honestly
4. Career clarity - clear trajectory and intentional career moves
5. Compensation fit - salary expectations vs role range
6. Motivation - genuine interest in this specific role

Return a JSON object with these exact fields:
{
  "summary": "2-3 sentence overview",
  "strengths": ["list of observed strengths"],
  "concerns": ["list of concerns or red flags"],
  "notableQuotes": ["direct quotes that stand out"],
  "professionalismSignal": "strong|adequate|weak",
  "technicalViabilitySignal": "strong|adequate|weak",
  "selfReflectionSignal": "strong|adequate|weak",
  "compensationFitSignal": "fit|borderline|misaligned|unknown",
  "careerClarity": "clear|developing|unclear",
  "motivationForApplying": "brief description of their stated motivation",
  "recommendedOutcome": "pass|fail|borderline",
  "confidenceScore": 0.0-1.0
}`;

  const userContent = `Role: ${jobContext.title}
${jobContext.roleSourceOfTruth ? `Role Context: ${JSON.stringify(jobContext.roleSourceOfTruth).slice(0, 2000)}` : ""}

Phone Interview Content:
${transcript}`;

  const result = JSON.parse(await callOpenAI(systemPrompt, userContent));
  return result as PhoneInterviewAnalysis;
}

export async function analyzeStoryInterview(
  transcript: string,
  jobContext: { title: string; roleSourceOfTruth?: any }
): Promise<StoryInterviewAnalysis> {
  const systemPrompt = `You are a senior hiring analyst evaluating a story interview.

You may receive a full transcript, interviewer notes, or both. Treat all provided material as evidence.
When both are provided, the transcript is primary evidence and notes provide interviewer observations and context.
When only notes are provided, base your analysis on those observations but note reduced confidence due to lack of verbatim transcript.

The story interview explores the candidate's narrative across their last 3 roles to assess:
- Growth mindset vs victim mindset
- Ownership vs excuse-making
- Emotional development and stability
- Integrity and initiative patterns
- Consistency and credibility of their career story

IMPORTANT RULES:
- This analysis is advisory only and must not alter any official written assessment scores.
- Cite evidence from the provided content.
- Identify strengths, risks, contradictions, and follow-up flags.
- Avoid false certainty when evidence is weak.

Return a JSON object with these exact fields:
{
  "summary": "2-3 sentence overview",
  "careerNarrativeSnapshot": "brief description of career arc across roles discussed",
  "repeatedStrengths": ["patterns of strength across roles"],
  "repeatedWeaknesses": ["patterns of weakness across roles"],
  "riskFlags": ["specific risk indicators"],
  "growthMindsetSignal": "strong|moderate|weak",
  "victimMindsetSignal": "none|mild|strong",
  "emotionalStabilitySignal": "stable|mixed|volatile",
  "integritySignal": "strong|adequate|concerning",
  "initiativePatterns": ["examples of self-driven action"],
  "reasonsForLeaving": ["reasons given for each role departure"],
  "inconsistencies": ["any contradictions in their story"],
  "notableQuotes": ["direct quotes that reveal character"],
  "followUpQuestions": ["questions for the final review"],
  "recommendation": "strong|mixed|weak"
}`;

  const userContent = `Role: ${jobContext.title}
${jobContext.roleSourceOfTruth ? `Role Context: ${JSON.stringify(jobContext.roleSourceOfTruth).slice(0, 2000)}` : ""}

Story Interview Content:
${transcript}`;

  const result = JSON.parse(await callOpenAI(systemPrompt, userContent));
  return result as StoryInterviewAnalysis;
}

export async function analyzeReferenceInterview(
  transcript: string,
  jobContext: { title: string; roleSourceOfTruth?: any },
  candidateStoryHighlights?: string
): Promise<ReferenceInterviewAnalysis> {
  const systemPrompt = `You are a senior hiring analyst evaluating a reference interview.

You may receive a full transcript, interviewer notes, or both. Treat all provided material as evidence.
When both are provided, the transcript is primary evidence and notes provide interviewer observations and context.
When only notes are provided, base your analysis on those observations but note reduced confidence due to lack of verbatim transcript.

Reference calls are used to:
- Compare candidate claims vs reference claims
- Identify what references hesitate to say
- Spot soft warnings and coded language
- Calibrate actual performance level
- Assess trustworthiness of the reference

IMPORTANT RULES:
- This analysis is advisory only and must not alter any official written assessment scores.
- Cite evidence from the provided content.
- Pay special attention to pauses, hedging language, and non-answers.
- Compare reference statements against candidate claims when available.
- Avoid false certainty when evidence is weak.

Return a JSON object with these exact fields:
{
  "summary": "2-3 sentence overview",
  "endorsementStrength": "strong|moderate|weak",
  "confirmedStrengths": ["strengths the reference verified"],
  "confirmedWeaknesses": ["weaknesses the reference acknowledged"],
  "inconsistenciesWithCandidateStory": ["mismatches between candidate and reference accounts"],
  "hesitationFlags": ["moments of evasion or hedging"],
  "quoteHighlights": ["notable direct quotes"],
  "referenceConfidenceLevel": "high|moderate|low",
  "overallRecommendation": "supportive|mixed|concerning"
}`;

  const userContent = `Role: ${jobContext.title}
${candidateStoryHighlights ? `Candidate's own claims to compare against:\n${candidateStoryHighlights}\n` : ""}

Reference Interview Content:
${transcript}`;

  const result = JSON.parse(await callOpenAI(systemPrompt, userContent));
  return result as ReferenceInterviewAnalysis;
}

export async function analyzeFocusInterview(
  transcript: string,
  jobContext: { title: string; roleSourceOfTruth?: any },
  manualRatings?: Record<string, number>
): Promise<FocusInterviewAnalysis> {
  const systemPrompt = `You are a senior hiring analyst evaluating a focus interview.

You may receive a full transcript, interviewer notes, or both. Treat all provided material as evidence.
When both are provided, the transcript is primary evidence and notes provide interviewer observations and context.
When only notes are provided, base your analysis on those observations but note reduced confidence due to lack of verbatim transcript.

The focus interview reviews:
- Role outcomes: can the candidate deliver the specific results this role requires?
- Culture expectations: does the candidate align with team values and operating style?
- Competencies: does the candidate demonstrate the required skill set at the right level?
- Real examples: quality and depth of specific stories/examples provided

Rate each category 1-10 based on evidence in the provided content.

IMPORTANT RULES:
- This analysis is advisory only and must not alter any official written assessment scores.
- Cite evidence from the provided content.
- Identify strengths, risks, contradictions, and follow-up flags.
- Avoid false certainty when evidence is weak.
- Base category scores on concrete evidence, not impressions.

Return a JSON object with these exact fields:
{
  "summary": "2-3 sentence overview",
  "categoriesReviewed": ["list of categories discussed"],
  "categoryScores": {"category_name": 1-10},
  "strongestCategories": ["top performing areas"],
  "weakestCategories": ["areas of concern"],
  "evidenceByCategory": {"category_name": "supporting evidence summary"},
  "notableQuotes": ["direct quotes showing capability or concern"],
  "finalFitRecommendation": "strong fit|adequate fit|poor fit"
}`;

  const userContent = `Role: ${jobContext.title}
${jobContext.roleSourceOfTruth ? `Role Context: ${JSON.stringify(jobContext.roleSourceOfTruth).slice(0, 2000)}` : ""}
${manualRatings ? `\nInterviewer's manual category ratings: ${JSON.stringify(manualRatings)}` : ""}

Focus Interview Content:
${transcript}`;

  const result = JSON.parse(await callOpenAI(systemPrompt, userContent));
  return result as FocusInterviewAnalysis;
}

export async function generateFinalDecision(
  inputs: {
    candidateName: string;
    jobTitle: string;
    phoneAnalysis?: PhoneInterviewAnalysis | null;
    assessmentScore?: {
      totalScore: number | null;
      riskTier: string | null;
      fitDelta: number | null;
      hiringCard: any;
      languageAgencyScore: number | null;
      agencyUnderPressure: number | null;
      agencyConsistency: number | null;
      aiLikelihoodScore: number | null;
      aiAssistanceFlag: string | null;
    } | null;
    storyAnalysis?: StoryInterviewAnalysis | null;
    referenceAnalysis?: ReferenceInterviewAnalysis | null;
    focusAnalysis?: FocusInterviewAnalysis | null;
    feedback?: string;
  }
): Promise<FinalCandidateDecision> {
  const systemPrompt = `You are a senior hiring decision advisor creating a final candidate decision card.

You are synthesizing evidence from multiple hiring stages into one structured recommendation.

TRUST HIERARCHY (highest to lowest):
1. Assessment score and scoring evidence
2. Focus interview evidence
3. Reference quality
4. Contradictions across stages
5. Authenticity risk (AI likelihood, language agency)
6. Phone screen quality
7. Story interview narrative quality
8. Communication consistency

OVERRIDE CONDITIONS - Flag for caution even with a good assessment score if:
- References are weak or concerning
- Story interview shows clear victim mindset
- Spoken communication sharply conflicts with written performance
- Authenticity flags are strong (high AI likelihood)
- Major contradictions appear across stages

IMPORTANT RULES:
- This decision card is score-informed, not score-only.
- Use the existing assessment score as a major input.
- Use interview analyses as additional evidence.
- Allow override flags for serious concerns.
- Be direct about risks — do not soften language.

Return a JSON object with these exact fields:
{
  "finalRecommendation": "Strong Yes|Yes|Mixed|No",
  "confidenceLevel": 0.0-1.0,
  "topReasonsToHire": ["list of strongest evidence for hiring"],
  "topRisks": ["list of risks or concerns"],
  "contradictionsAcrossStages": ["inconsistencies found between stages"],
  "authenticityConcerns": ["any AI-related or authenticity flags"],
  "strongestEvidence": ["most compelling positive signals"],
  "weakestEvidence": ["areas with thin or missing evidence"],
  "unresolvedQuestions": ["things that remain unclear"],
  "recommendedNextStep": "Offer|Hold|Reject"
}`;

  const stagesCompleted: string[] = [];
  let evidenceSummary = `Candidate: ${inputs.candidateName}\nRole: ${inputs.jobTitle}\n\n`;

  if (inputs.phoneAnalysis) {
    stagesCompleted.push("phone_interview");
    evidenceSummary += `=== PHONE INTERVIEW ===\nOutcome: ${inputs.phoneAnalysis.recommendedOutcome} (confidence: ${inputs.phoneAnalysis.confidenceScore})\nSummary: ${inputs.phoneAnalysis.summary}\nStrengths: ${inputs.phoneAnalysis.strengths.join(", ")}\nConcerns: ${inputs.phoneAnalysis.concerns.join(", ")}\nProfessionalism: ${inputs.phoneAnalysis.professionalismSignal}\nTechnical: ${inputs.phoneAnalysis.technicalViabilitySignal}\nSelf-reflection: ${inputs.phoneAnalysis.selfReflectionSignal}\n\n`;
  }

  if (inputs.assessmentScore) {
    stagesCompleted.push("assessment");
    const a = inputs.assessmentScore;
    evidenceSummary += `=== WRITTEN ASSESSMENT ===\nTotal Score: ${a.totalScore ?? "N/A"}\nRisk Tier: ${a.riskTier ?? "N/A"}\nFit Delta: ${a.fitDelta ?? "N/A"}\nLanguage Agency: ${a.languageAgencyScore ?? "N/A"}\nAgency Under Pressure: ${a.agencyUnderPressure ?? "N/A"}\nAgency Consistency: ${a.agencyConsistency ?? "N/A"}\nAI Likelihood: ${a.aiLikelihoodScore ?? "N/A"}\nAI Assistance Flag: ${a.aiAssistanceFlag ?? "none"}\n`;
    if (a.hiringCard) {
      evidenceSummary += `Hiring Card Summary: ${JSON.stringify(a.hiringCard).slice(0, 1500)}\n`;
    }
    evidenceSummary += "\n";
  }

  if (inputs.storyAnalysis) {
    stagesCompleted.push("story_interview");
    const s = inputs.storyAnalysis;
    evidenceSummary += `=== STORY INTERVIEW ===\nRecommendation: ${s.recommendation}\nSummary: ${s.summary}\nGrowth Mindset: ${s.growthMindsetSignal}\nVictim Mindset: ${s.victimMindsetSignal}\nEmotional Stability: ${s.emotionalStabilitySignal}\nIntegrity: ${s.integritySignal}\nRepeated Strengths: ${s.repeatedStrengths.join(", ")}\nRisk Flags: ${s.riskFlags.join(", ")}\nInconsistencies: ${s.inconsistencies.join(", ")}\n\n`;
  }

  if (inputs.referenceAnalysis) {
    stagesCompleted.push("reference_interview");
    const r = inputs.referenceAnalysis;
    evidenceSummary += `=== REFERENCE INTERVIEW ===\nRecommendation: ${r.overallRecommendation}\nEndorsement: ${r.endorsementStrength}\nSummary: ${r.summary}\nConfirmed Strengths: ${r.confirmedStrengths.join(", ")}\nConfirmed Weaknesses: ${r.confirmedWeaknesses.join(", ")}\nInconsistencies: ${r.inconsistenciesWithCandidateStory.join(", ")}\nHesitation Flags: ${r.hesitationFlags.join(", ")}\n\n`;
  }

  if (inputs.focusAnalysis) {
    stagesCompleted.push("focus_interview");
    const f = inputs.focusAnalysis;
    evidenceSummary += `=== FOCUS INTERVIEW ===\nFit: ${f.finalFitRecommendation}\nSummary: ${f.summary}\nStrongest: ${f.strongestCategories.join(", ")}\nWeakest: ${f.weakestCategories.join(", ")}\nScores: ${JSON.stringify(f.categoryScores)}\n\n`;
  }

  evidenceSummary += `\nStages completed: ${stagesCompleted.join(", ")}`;

  if (inputs.feedback) {
    evidenceSummary += `\n\nIMPORTANT — User Feedback for Regeneration:\nThe user has requested changes to the previous output. You MUST incorporate this feedback:\n${inputs.feedback}`;
  }

  const result = JSON.parse(await callOpenAI(systemPrompt, evidenceSummary));

  return {
    ...result,
    authenticityFlag: inputs.assessmentScore?.aiAssistanceFlag || "none",
    aiAssistanceLikelihood: inputs.assessmentScore?.aiLikelihoodScore != null
      ? `${(inputs.assessmentScore.aiLikelihoodScore * 100).toFixed(0)}%`
      : "N/A",
    languageAgencyScore: inputs.assessmentScore?.languageAgencyScore ?? null,
    agencyUnderPressure: inputs.assessmentScore?.agencyUnderPressure ?? null,
  } as FinalCandidateDecision;
}
