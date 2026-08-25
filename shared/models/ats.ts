import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, real, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";

export const atsJobStatusOptions = ["draft", "active", "paused", "closed"] as const;
export type AtsJobStatus = typeof atsJobStatusOptions[number];

export const atsCandidateStageOptions = [
  "phone_interview", "applied", "invited", "screening", "video", "ai_scored",
  "story_interview", "reference_interview", "focus_interview",
  "review", "interview", "offered", "rejected", "withdrawn"
] as const;
export type AtsCandidateStage = typeof atsCandidateStageOptions[number];

export const atsJobs = pgTable("ats_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  description: text("description").notNull(),
  status: varchar("status").default("draft").notNull(),
  screeningQuestions: jsonb("screening_questions"),
  videoTasks: jsonb("video_tasks"),
  rubric: jsonb("rubric"),
  hardFails: jsonb("hard_fails"),
  clarificationQuestions: jsonb("clarification_questions"),
  clarificationAnswers: jsonb("clarification_answers"),
  roleSourceOfTruth: jsonb("role_source_of_truth"),
  cognitiveProfile: jsonb("cognitive_profile"),
  assessmentJson: jsonb("assessment_json"),
  rubricJson: jsonb("rubric_json"),
  assessmentMeta: jsonb("assessment_meta"),
  aiSpecVersion: varchar("ai_spec_version"),
  modelId: varchar("model_id"),
  aiGeneratedAt: timestamp("ai_generated_at"),
  scorecardText: text("scorecard_text"),
  scorecardJson: jsonb("scorecard_json"),
  lastFeedback: text("last_feedback"),
  inviteToken: varchar("invite_token").unique(),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAtsJobSchema = createInsertSchema(atsJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  aiGeneratedAt: true,
  roleSourceOfTruth: true,
  cognitiveProfile: true,
  assessmentJson: true,
  rubricJson: true,
  assessmentMeta: true,
  aiSpecVersion: true,
  modelId: true,
});

export type InsertAtsJob = z.infer<typeof insertAtsJobSchema>;
export type AtsJob = typeof atsJobs.$inferSelect;

export type AtsScreeningQuestion = {
  id: string;
  prompt: string;
  type: "text" | "multiple_choice";
  options?: string[];
  required: boolean;
};

export type AtsVideoTask = {
  id: string;
  prompt: string;
  durationSec: number;
  required: boolean;
};

export type AtsRubricDimension = {
  name: string;
  weight: number;
  criteria: string;
};

export type AtsRubric = {
  dimensions: AtsRubricDimension[];
};

export const atsCandidates = pgTable("ats_candidates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").references(() => atsJobs.id).notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  stage: varchar("stage").default("applied").notNull(),
  accessToken: varchar("access_token").unique().notNull(),
  tags: text("tags").array(),
  notes: text("notes"),
  totalScore: real("total_score"),
  aiScoreJson: jsonb("ai_score_json"),
  evidenceJson: jsonb("evidence_json"),
  hiringCardJson: jsonb("hiring_card_json"),
  riskTier: varchar("risk_tier"),
  fitDelta: real("fit_delta"),
  languageAgencyScore: real("language_agency_score"),
  agencyUnderPressure: real("agency_under_pressure"),
  agencyConsistency: real("agency_consistency"),
  aiLikelihoodScore: real("ai_likelihood_score"),
  aiAssistanceFlag: varchar("ai_assistance_flag"),
  resumeText: text("resume_text"),
  resumeProfileJson: jsonb("resume_profile_json"),
  resumeConsistencyJson: jsonb("resume_consistency_json"),
  aiSpecVersion: varchar("ai_spec_version"),
  modelId: varchar("model_id"),
  invitedAt: timestamp("invited_at"),
  screeningCompletedAt: timestamp("screening_completed_at"),
  videoCompletedAt: timestamp("video_completed_at"),
  aiScoredAt: timestamp("ai_scored_at"),
  reviewedAt: timestamp("reviewed_at"),
  rejectedAt: timestamp("rejected_at"),
  assessmentBaseScore: real("assessment_base_score"),
  interviewMultiplier: real("interview_multiplier"),
  interviewAdjustmentPercent: real("interview_adjustment_percent"),
  finalDisplayScore: real("final_display_score"),
  scoreChangeSummary: text("score_change_summary"),
  interviewAdjustmentSummary: text("interview_adjustment_summary"),
  cohortAdjustmentSummary: text("cohort_adjustment_summary"),
  calibratedScore: real("calibrated_score"),
  calibrationMultiplier: real("calibration_multiplier"),
  pairwiseWinRate: real("pairwise_win_rate"),
  cohortRank: integer("cohort_rank"),
  cohortPercentile: real("cohort_percentile"),
  cohortSize: integer("cohort_size"),
  comparativeSummary: text("comparative_summary"),
  lastCalibratedAt: timestamp("last_calibrated_at"),
  dimensionHistory: jsonb("dimension_history"),
  evidenceStageCount: integer("evidence_stage_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAtsCandidateSchema = createInsertSchema(atsCandidates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  totalScore: true,
  aiScoreJson: true,
  evidenceJson: true,
  hiringCardJson: true,
  riskTier: true,
  fitDelta: true,
  languageAgencyScore: true,
  agencyUnderPressure: true,
  agencyConsistency: true,
  aiLikelihoodScore: true,
  aiAssistanceFlag: true,
  resumeText: true,
  resumeProfileJson: true,
  resumeConsistencyJson: true,
  aiSpecVersion: true,
  modelId: true,
  invitedAt: true,
  screeningCompletedAt: true,
  videoCompletedAt: true,
  aiScoredAt: true,
  reviewedAt: true,
  rejectedAt: true,
  calibratedScore: true,
  calibrationMultiplier: true,
  pairwiseWinRate: true,
  cohortRank: true,
  cohortPercentile: true,
  cohortSize: true,
  comparativeSummary: true,
  lastCalibratedAt: true,
  dimensionHistory: true,
  evidenceStageCount: true,
});

export type InsertAtsCandidate = z.infer<typeof insertAtsCandidateSchema>;
export type AtsCandidate = typeof atsCandidates.$inferSelect;

export const atsSubmissions = pgTable("ats_submissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  candidateId: varchar("candidate_id").references(() => atsCandidates.id).notNull(),
  jobId: varchar("job_id").references(() => atsJobs.id).notNull(),
  questionId: varchar("question_id").notNull(),
  questionType: varchar("question_type").notNull(),
  questionLayer: varchar("question_layer"),
  responseText: text("response_text"),
  videoUrl: text("video_url"),
  videoObjectKey: text("video_object_key"),
  videoDurationSec: real("video_duration_sec"),
  isTimed: boolean("is_timed").default(false),
  timeLimitSec: integer("time_limit_sec"),
  timeUsedSec: real("time_used_sec"),
  noRedo: boolean("no_redo").default(false),
  lockedAt: timestamp("locked_at"),
  contradictionPairId: varchar("contradiction_pair_id"),
  contradictionRole: varchar("contradiction_role"),
  traitTarget: varchar("trait_target"),
  pasteEvents: integer("paste_events").default(0),
  timeToFirstKeystrokeSec: real("time_to_first_keystroke_sec"),
  totalTypingTimeSec: real("total_typing_time_sec"),
  evidenceMarkers: jsonb("evidence_markers"),
  transcriptionStatus: varchar("transcription_status"),
  transcriptJson: jsonb("transcript_json"),
  transcriptText: text("transcript_text"),
  revJobId: varchar("rev_job_id"),
  // Task #3963 (audit B-012) — Rev.ai callback completion. Typed
  // machine-readable terminal-failure reason (AtsTranscriptionFailureCode)
  // plus safe human-readable detail (previously a bare 'failed' status
  // carried no explanation), and a server-stamped progress timestamp that
  // drives the fallback sweeper's staleness + give-up windows.
  transcriptionFailureCode: varchar("transcription_failure_code"),
  transcriptionFailureDetail: text("transcription_failure_detail"),
  transcriptionUpdatedAt: timestamp("transcription_updated_at"),
  aiScore: real("ai_score"),
  aiScoreJson: jsonb("ai_score_json"),
  aiFeedback: text("ai_feedback"),
  manualScore: real("manual_score"),
  manualFeedback: text("manual_feedback"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  candidateIdx: index("ats_submissions_candidate_id_idx").on(table.candidateId),
  // Task #3963 — the Rev.ai callback route and the fallback sweeper look
  // submissions up by Rev.ai job id.
  revJobIdx: index("ats_submissions_rev_job_id_idx").on(table.revJobId),
  // Task #4705 — one saved answer per candidate+question. The portal submit
  // route upserts via ON CONFLICT on this index so a timeout retry racing the
  // original request can never create duplicate rows (which would
  // double-count in auto-scoring inputs).
  candidateQuestionUnique: uniqueIndex("ats_submissions_candidate_question_unique_idx")
    .on(table.candidateId, table.questionId),
}));

// Task #3963 (audit B-012) — machine-readable reasons a video transcription
// terminally failed, persisted on `ats_submissions.transcription_failure_code`
// next to a safe human-readable `transcription_failure_detail`:
//   download_failed / audio_extract_failed — local pipeline before Rev.ai
//     (object-storage download, ffmpeg audio extraction).
//   submit_failed          — the Rev.ai job-creation POST failed.
//   rev_job_failed         — Rev.ai processed the job and reported failure
//                            (vendor `failure` + `failure_detail` in detail).
//   job_not_found          — the persisted rev_job_id 404s at Rev.ai.
//   transcript_fetch_failed — job reports transcribed but the transcript 404s.
//   job_timeout            — sweeper give-up: still in_progress past the window.
//   submit_lost            — stuck 'processing' with no rev_job_id (process
//                            died between claim and submission).
//   unknown                — unclassified error; detail carries the message.
export const ATS_TRANSCRIPTION_FAILURE_CODES = [
  "download_failed",
  "audio_extract_failed",
  "submit_failed",
  "rev_job_failed",
  "job_not_found",
  "transcript_fetch_failed",
  "job_timeout",
  "submit_lost",
  "unknown",
] as const;
export type AtsTranscriptionFailureCode =
  (typeof ATS_TRANSCRIPTION_FAILURE_CODES)[number];

// Task #3987 — the single shared plain-language copy map for the failure
// codes above. The ATS admin/review UI derives its "why did this fail?"
// blurbs from here (never per-component copies). `retrySuggested` marks the
// codes where the failure was on our side / transient, so the UI should
// visibly point the recruiter at the retry action.
export const ATS_TRANSCRIPTION_FAILURE_COPY: Record<
  AtsTranscriptionFailureCode,
  { label: string; retrySuggested: boolean }
> = {
  download_failed: {
    label: "We couldn't download the candidate's video from storage.",
    retrySuggested: true,
  },
  audio_extract_failed: {
    label: "We couldn't extract usable audio from the video file.",
    retrySuggested: false,
  },
  submit_failed: {
    label: "Sending the audio to the transcription service failed.",
    retrySuggested: true,
  },
  rev_job_failed: {
    label: "The transcription service couldn't process the audio (e.g. unreadable or silent recording).",
    retrySuggested: false,
  },
  job_not_found: {
    label: "The transcription service no longer recognizes this job.",
    retrySuggested: true,
  },
  transcript_fetch_failed: {
    label: "Transcription finished but we couldn't retrieve the transcript.",
    retrySuggested: true,
  },
  job_timeout: {
    label: "Transcription took too long and we stopped waiting.",
    retrySuggested: true,
  },
  submit_lost: {
    label: "Our transcription request was interrupted before it went out.",
    retrySuggested: true,
  },
  unknown: {
    label: "Transcription failed for an unrecognized reason.",
    retrySuggested: true,
  },
};

/**
 * Task #3987 — friendly description for a persisted failure code. Unknown /
 * missing codes fall back to the `unknown` copy so the UI never renders a
 * bare machine code.
 */
export function describeAtsTranscriptionFailure(code: string | null | undefined): {
  code: AtsTranscriptionFailureCode;
  label: string;
  retrySuggested: boolean;
} {
  const known = code && (ATS_TRANSCRIPTION_FAILURE_CODES as readonly string[]).includes(code)
    ? (code as AtsTranscriptionFailureCode)
    : "unknown";
  return { code: known, ...ATS_TRANSCRIPTION_FAILURE_COPY[known] };
}

export const insertAtsSubmissionSchema = createInsertSchema(atsSubmissions).omit({
  id: true,
  createdAt: true,
  aiScore: true,
  aiScoreJson: true,
  aiFeedback: true,
  manualScore: true,
  manualFeedback: true,
  transcriptJson: true,
  transcriptText: true,
  revJobId: true,
  // Task #3963 — server-managed transcription bookkeeping, never client-set.
  transcriptionFailureCode: true,
  transcriptionFailureDetail: true,
  transcriptionUpdatedAt: true,
  evidenceMarkers: true,
  lockedAt: true,
});

export type InsertAtsSubmission = z.infer<typeof insertAtsSubmissionSchema>;
export type AtsSubmission = typeof atsSubmissions.$inferSelect;

export const atsEmailTemplates = pgTable("ats_email_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  templateType: varchar("template_type").notNull(),
  jobId: varchar("job_id").references(() => atsJobs.id),
  isGlobal: boolean("is_global").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAtsEmailTemplateSchema = createInsertSchema(atsEmailTemplates).omit({
  id: true,
  createdAt: true,
});

export type InsertAtsEmailTemplate = z.infer<typeof insertAtsEmailTemplateSchema>;
export type AtsEmailTemplate = typeof atsEmailTemplates.$inferSelect;

export const atsAiRuns = pgTable("ats_ai_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").references(() => atsJobs.id),
  candidateId: varchar("candidate_id").references(() => atsCandidates.id),
  stageName: varchar("stage_name").notNull(),
  inputRefs: jsonb("input_refs"),
  outputJson: jsonb("output_json"),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  success: boolean("success"),
  errorMessage: text("error_message"),
  modelId: varchar("model_id"),
  aiSpecVersion: varchar("ai_spec_version"),
  promptHash: varchar("prompt_hash"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAtsAiRunSchema = createInsertSchema(atsAiRuns).omit({
  id: true,
  createdAt: true,
});

export type InsertAtsAiRun = z.infer<typeof insertAtsAiRunSchema>;
export type AtsAiRun = typeof atsAiRuns.$inferSelect;

export const atsInterviewTypeOptions = ["phone", "story", "reference", "focus"] as const;
export type AtsInterviewType = typeof atsInterviewTypeOptions[number];

export const atsInterviewStatusOptions = ["pending", "uploaded", "analyzing", "analyzed", "failed"] as const;
export type AtsInterviewStatus = typeof atsInterviewStatusOptions[number];

export const atsInterviews = pgTable("ats_interviews", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  candidateId: varchar("candidate_id").references(() => atsCandidates.id).notNull(),
  jobId: varchar("job_id").references(() => atsJobs.id).notNull(),
  interviewType: varchar("interview_type").notNull(),
  transcript: text("transcript"),
  interviewNotes: text("interview_notes"),
  uploadedAt: timestamp("uploaded_at"),
  uploadedBy: varchar("uploaded_by"),
  analysisJson: jsonb("analysis_json"),
  analysisStatus: varchar("analysis_status").default("pending").notNull(),
  manualRatings: jsonb("manual_ratings"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAtsInterviewSchema = createInsertSchema(atsInterviews).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  analysisJson: true,
  analysisStatus: true,
});

export type InsertAtsInterview = z.infer<typeof insertAtsInterviewSchema>;
export type AtsInterview = typeof atsInterviews.$inferSelect;

export const atsFinalDecisions = pgTable("ats_final_decisions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  candidateId: varchar("candidate_id").references(() => atsCandidates.id).notNull(),
  jobId: varchar("job_id").references(() => atsJobs.id).notNull(),
  generatedAt: timestamp("generated_at").defaultNow(),
  basedOnStagesCompleted: text("based_on_stages_completed").array(),
  decisionJson: jsonb("decision_json"),
  finalRecommendation: varchar("final_recommendation"),
  confidence: real("confidence"),
  nextStep: varchar("next_step"),
  lastFeedback: text("last_feedback"),
  approvedBy: varchar("approved_by"),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAtsFinalDecisionSchema = createInsertSchema(atsFinalDecisions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  generatedAt: true,
  approvedBy: true,
  approvedAt: true,
});

export type InsertAtsFinalDecision = z.infer<typeof insertAtsFinalDecisionSchema>;
export type AtsFinalDecision = typeof atsFinalDecisions.$inferSelect;

export const atsPairwiseComparisons = pgTable("ats_pairwise_comparisons", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").references(() => atsJobs.id).notNull(),
  candidateAId: varchar("candidate_a_id").references(() => atsCandidates.id).notNull(),
  candidateBId: varchar("candidate_b_id").references(() => atsCandidates.id).notNull(),
  winner: varchar("winner").notNull(),
  confidence: varchar("confidence").notNull(),
  decisiveFactors: jsonb("decisive_factors"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type AtsPairwiseComparison = typeof atsPairwiseComparisons.$inferSelect;
