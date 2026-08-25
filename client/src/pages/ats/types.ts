export interface DimensionScores {
  role_skill: number;
  role_behavior: number;
  reality_based_mindset: number;
  personality_alignment: number;
  communication_clarity: number;
  [key: string]: number;
}

export interface DimensionHistoryEntry {
  stage: string;
  timestamp: string;
  dimensions: DimensionScores;
  base_total: number;
  evidence_sources: string[];
  change_summary: string;
}

export type AtsJob = {
  id: string;
  title: string;
  description: string;
  status: string;
  screeningQuestions: any[] | null;
  videoTasks: any[] | null;
  rubric: any | null;
  hardFails: string[] | null;
  clarificationQuestions: string[] | null;
  clarificationAnswers: Record<string, string> | null;
  aiGeneratedAt: string | null;
  inviteToken: string | null;
  roleSourceOfTruth: any | null;
  cognitiveProfile: any | null;
  assessmentJson: any | null;
  rubricJson: any | null;
  assessmentMeta: any | null;
  scorecardText: string | null;
  scorecardJson: any | null;
  aiSpecVersion: string | null;
  modelId: string | null;
  createdAt: string;
};

export type AtsCandidate = {
  id: string;
  jobId: string;
  name: string;
  email: string;
  phone: string | null;
  stage: string;
  accessToken: string;
  tags: string[] | null;
  notes: string | null;
  totalScore: number | null;
  aiScoreJson: any | null;
  evidenceJson: any | null;
  hiringCardJson: any | null;
  riskTier: string | null;
  fitDelta: number | null;
  resumeProfileJson: any | null;
  resumeConsistencyJson: any | null;
  aiSpecVersion: string | null;
  modelId: string | null;
  assessmentBaseScore: number | null;
  interviewMultiplier: number | null;
  interviewAdjustmentPercent: number | null;
  finalDisplayScore: number | null;
  scoreChangeSummary: string | null;
  interviewAdjustmentSummary: string | null;
  cohortAdjustmentSummary: string | null;
  calibratedScore: number | null;
  calibrationMultiplier: number | null;
  pairwiseWinRate: number | null;
  cohortRank: number | null;
  cohortPercentile: number | null;
  cohortSize: number | null;
  comparativeSummary: string | null;
  lastCalibratedAt: string | null;
  dimensionHistory: DimensionHistoryEntry[] | null;
  evidenceStageCount: number | null;
  createdAt: string;
};

export type AtsSubmission = {
  id: string;
  candidateId: string;
  jobId: string;
  questionId: string;
  questionType: string;
  responseText: string | null;
  videoObjectKey: string | null;
  aiScore: number | null;
  aiFeedback: string | null;
  transcriptionStatus: string | null;
  // Task #3987 — typed failure reason persisted by the server (#3963);
  // rendered as friendly copy via describeAtsTranscriptionFailure().
  transcriptionFailureCode: string | null;
  transcriptionFailureDetail: string | null;
  transcriptText: string | null;
  createdAt: string;
};

export type AtsEmailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
  templateType: string;
  jobId: string | null;
  isGlobal: boolean;
  createdAt: string;
};

export type AtsInterview = {
  id: string;
  candidateId: string;
  jobId: string;
  interviewType: string;
  transcript: string | null;
  interviewNotes: string | null;
  uploadedAt: string | null;
  uploadedBy: string | null;
  analysisJson: any | null;
  analysisStatus: string;
  manualRatings: Record<string, number> | null;
  createdAt: string;
  updatedAt: string | null;
};

export type AtsFinalDecision = {
  id: string;
  candidateId: string;
  jobId: string;
  basedOnStagesCompleted: string[];
  decisionJson: any;
  finalRecommendation: string;
  confidence: number;
  nextStep: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
};

export type JobAnalytics = {
  totalCandidates: number;
  stageCounts: Record<string, number>;
  avgScores: Record<string, number>;
  conversionRates: Record<string, number>;
};

export const stageColors: Record<string, string> = {
  phone_interview: "bg-sky-100 text-sky-700 border-sky-300",
  applied: "bg-gray-100 text-gray-700 border-gray-300",
  invited: "bg-blue-100 text-blue-700 border-blue-300",
  screening: "bg-yellow-100 text-yellow-700 border-yellow-300",
  answers_received: "bg-yellow-100 text-yellow-700 border-yellow-300",
  video: "bg-purple-100 text-purple-700 border-purple-300",
  ai_scored: "bg-indigo-100 text-indigo-700 border-indigo-300",
  story_interview: "bg-amber-100 text-amber-700 border-amber-300",
  reference_interview: "bg-lime-100 text-lime-700 border-lime-300",
  focus_interview: "bg-fuchsia-100 text-fuchsia-700 border-fuchsia-300",
  review: "bg-orange-100 text-orange-700 border-orange-300",
  interview: "bg-teal-100 text-teal-700 border-teal-300",
  offered: "bg-green-100 text-green-700 border-green-300",
  rejected: "bg-red-100 text-red-700 border-red-300",
  withdrawn: "bg-gray-200 text-gray-500 border-gray-300",
};

export const stageLabels: Record<string, string> = {
  phone_interview: "Phone Screen",
  applied: "Applied",
  invited: "Invited",
  screening: "Screening",
  answers_received: "Answers Received",
  video: "Video",
  ai_scored: "AI Scored",
  story_interview: "Story Interview",
  reference_interview: "Reference Interview",
  focus_interview: "Focus Interview",
  review: "Review",
  interview: "Interview",
  offered: "Offered",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

export const kanbanStages = ["invited", "answers_received", "ai_scored", "story", "reference", "focus", "offered"];

export const kanbanStageMapping: Record<string, string> = {
  phone_interview: "ai_scored",
  applied: "invited",
  invited: "invited",
  screening: "answers_received",
  video: "answers_received",
  ai_scored: "ai_scored",
  story_interview: "story",
  reference_interview: "reference",
  focus_interview: "focus",
  review: "focus",
  interview: "focus",
  offered: "offered",
};

export const kanbanStageLabels: Record<string, string> = {
  invited: "Invited",
  answers_received: "Answers Received",
  ai_scored: "AI Scored",
  story: "Story Interview",
  reference: "Reference Interview",
  focus: "Focus Interview",
  offered: "Offered",
};

export const kanbanStageColors: Record<string, string> = {
  invited: "bg-blue-100 text-blue-700 border-blue-300",
  answers_received: "bg-yellow-100 text-yellow-700 border-yellow-300",
  ai_scored: "bg-indigo-100 text-indigo-700 border-indigo-300",
  story: "bg-amber-100 text-amber-700 border-amber-300",
  reference: "bg-lime-100 text-lime-700 border-lime-300",
  focus: "bg-fuchsia-100 text-fuchsia-700 border-fuchsia-300",
  offered: "bg-green-100 text-green-700 border-green-300",
};

export const scoredStages = new Set(["ai_scored", "story", "reference", "focus", "offered", "answers_received"]);
