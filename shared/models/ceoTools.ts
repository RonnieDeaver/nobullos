import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, real, bigint, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const callAnalysisStatusOptions = ["queued", "processing", "complete", "failed"] as const;
export type CallAnalysisStatus = typeof callAnalysisStatusOptions[number];

export const callClassificationOptions = ["human", "voicemail", "ivr_menu", "ivr_queue", "system_message_then_human", "unknown"] as const;
export type CallClassification = typeof callClassificationOptions[number];

// Task #1049: typed failure reasons replace free-text error_message
// classification. Used by both lanes so the failure mix is groupable.
export const callAnalysisFailureReasons = [
  "ffmpeg_timeout",
  "ffmpeg_invalid_audio",
  "whisper_timeout",
  "download_failed",
  "cpu_starved",
  "file_too_large",
  "unknown",
] as const;
export type CallAnalysisFailureReason = typeof callAnalysisFailureReasons[number];

// Task #1049: `normal` is the default fast lane (short / medium calls).
// `slow` is reserved for long audio with its own poller, lower
// concurrency, and a much larger per-job budget so it can't starve
// normal-call latency.
export const callAnalysisLanes = ["normal", "slow"] as const;
export type CallAnalysisLane = typeof callAnalysisLanes[number];

export const callAnalysisJobs = pgTable("call_analysis_jobs", {
  analysisId: varchar("analysis_id").primaryKey().default(sql`gen_random_uuid()`),
  externalId: varchar("external_id").notNull(),
  idempotencyKey: varchar("idempotency_key").unique().notNull(),
  audioUrl: text("audio_url"),
  revTranscriptJson: jsonb("rev_transcript_json"),
  maxListenSeconds: integer("max_listen_seconds").default(60),
  status: varchar("status").default("queued").notNull(),
  resultJson: jsonb("result_json"),
  errorMessage: text("error_message"),
  // Task #1049: typed failure reason — see callAnalysisFailureReasons.
  failureReason: varchar("failure_reason"),
  // Task #1049: preflight metadata captured before conversion.
  audioDurationSeconds: real("audio_duration_seconds"),
  // Task #1049: bigint to match the migration 0051 column type — a
  // raw recording can comfortably exceed Postgres `integer` range
  // (the file_too_large cap is 200 MB but bigint avoids any future
  // schema drift if the cap is raised).
  audioSizeBytes: bigint("audio_size_bytes", { mode: "number" }),
  // Task #1049: `normal` (default) or `slow`. The slow-lane poller
  // filters lane='slow'; the normal poller filters lane='normal'.
  lane: varchar("lane").default("normal").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  attemptCount: integer("attempt_count").default(0),
  // Workers/queues audit parity (E-F01/E-F02), migration
  // 20260806182338_call_analysis_jobs_lease.sql: bounded in-row lease,
  // mirroring twilio_calls.archive_locked_until/archive_leased_at.
  // locked_until = lease expiry (claim sets, heartbeat extends up to the
  // canonical lane ceiling); leased_at = claim epoch (set once per claim,
  // never touched by the heartbeat). Both NULL for legacy/unclaimed rows.
  lockedUntil: timestamp("locked_until"),
  leasedAt: timestamp("leased_at"),
}, (table) => ({
  // Task #1573 (Audit Track C): the normal-lane and slow-lane pollers
  // query `status='queued' AND lane=? ORDER BY created_at`. Without
  // this composite every poll is a Seq Scan that grows linearly with
  // the job log. See migration 0064.
  statusLaneCreatedIdx: index("call_analysis_jobs_status_lane_created_idx").on(
    table.status,
    table.lane,
    table.createdAt,
  ),
}));

export const insertCallAnalysisJobSchema = createInsertSchema(callAnalysisJobs).omit({
  analysisId: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  attemptCount: true,
  resultJson: true,
  errorMessage: true,
  failureReason: true,
  audioDurationSeconds: true,
  audioSizeBytes: true,
  lane: true,
});

export type InsertCallAnalysisJob = z.infer<typeof insertCallAnalysisJobSchema>;
export type CallAnalysisJob = typeof callAnalysisJobs.$inferSelect;

export type CallAnalysisSignals = {
  humanSeenAtSeconds?: number;
  ivrMenuSeenAtSeconds?: number;
  ivrQueueSeenAtSeconds?: number;
  voicemailSeenAtSeconds?: number;
  systemMessageSeenAtSeconds?: number;
};

export type CallAnalysisResult = {
  pickupTimeSeconds: number | null;
  timeToHumanSeconds: number | null;
  finalClassification: CallClassification;
  confidence: number;
  evidence: string;
  reviewRequired: boolean;
  signals: CallAnalysisSignals;
  detectedLanguage?: string;
  callDurationSeconds?: number | null;
};

export const webhookImportLogs = pgTable("webhook_import_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id"),
  clientName: varchar("client_name"),
  reportMonth: varchar("report_month"),
  reportId: varchar("report_id"),
  status: varchar("status").default("pending").notNull(),
  sectionsCreated: jsonb("sections_created"),
  fieldConfidence: jsonb("field_confidence"),
  pdfFileName: varchar("pdf_file_name"),
  pdfSizeBytes: integer("pdf_size_bytes"),
  pdfSourceType: varchar("pdf_source_type"),
  pdfSourceUrl: text("pdf_source_url"),
  pdfExtractedText: text("pdf_extracted_text"),
  webhookPayload: jsonb("webhook_payload"),
  errorMessage: text("error_message"),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type WebhookImportLog = typeof webhookImportLogs.$inferSelect;
