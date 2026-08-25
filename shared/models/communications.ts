import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, real, boolean, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";
import { clients } from "./clients";

export const communicationSourceTypes = ["slack", "front_email", "zoom", "manual", "twilio_sms", "twilio_call"] as const;
export type CommunicationSourceType = typeof communicationSourceTypes[number];

export const communicationSourceSubtypes = [
  "slack_channel", "slack_thread", "slack_dm",
  "email_thread", "email_message",
  "zoom_meeting", "zoom_recording", "zoom_transcript",
  "manual_note"
] as const;

export const communicationDirections = ["inbound", "outbound", "internal"] as const;
export const communicationProcessingStatuses = ["pending", "processing", "processed", "failed"] as const;
export const communicationReviewStatuses = ["unreviewed", "suggestions_pending", "partially_resolved", "resolved", "no_updates_needed"] as const;

// Task #897 Phase 5: `orphaned` records are raw communication evidence
// whose client linkage was severed because the client was deleted.
// They are preserved (not deleted) and excluded from client-linked views.
export const communicationMatchStatuses = ["unmatched", "matched", "orphaned"] as const;
export type CommunicationMatchStatus = typeof communicationMatchStatuses[number];

// Task #3689: `unavailable` is the terminal no-transcript state — the backfill
// window lapsed and a live Zoom API check confirmed the final recording set has
// no TRANSCRIPT file (or the recording is gone from Zoom). Reason details are
// stored at rawPayloadJson.zoomTranscriptUnavailable (see @shared/zoomTranscript).
// Deliberately still upgradeable to `ready` by the transcript-apply path if Zoom
// belatedly produces one.
export const transcriptStatuses = ["pending", "ready", "failed", "unavailable"] as const;
export type TranscriptStatus = typeof transcriptStatuses[number];

export const rawCommunicationRecords = pgTable("raw_communication_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id),
  sourceType: varchar("source_type").notNull(),
  sourceSubtype: varchar("source_subtype"),
  title: text("title").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  direction: varchar("direction"),
  participantsJson: jsonb("participants_json"),
  externalSourceId: text("external_source_id"),
  externalThreadId: text("external_thread_id"),
  externalUrl: text("external_url"),
  contentText: text("content_text"),
  contentPreview: text("content_preview"),
  rawPayloadJson: jsonb("raw_payload_json"),
  processingStatus: varchar("processing_status").default("pending").notNull(),
  aiSummary: text("ai_summary"),
  aiSignals: jsonb("ai_signals"),
  aiProcessedAt: timestamp("ai_processed_at"),
  reviewStatus: varchar("review_status").default("unreviewed").notNull(),
  hasSuggestions: boolean("has_suggestions").default(false),
  googleDriveFileUrl: text("google_drive_file_url"),
  // Task #4025 — in-app copy of the recording (client_files row) written by
  // the client-file delivery fan-out. Legacy googleDriveFileUrl stays as a
  // read-only historical reference. No FK: client_files rows can be purged
  // by operators and the comm record must survive with a dangling id.
  clientFileId: varchar("client_file_id"),
  matchMethod: varchar("match_method"),
  matchConfidence: real("match_confidence"),
  matchStatus: varchar("match_status"),
  operationalClassificationReason: text("operational_classification_reason"),
  bulkClassifierVersion: integer("bulk_classifier_version"),
  transcriptStatus: varchar("transcript_status"),
  isTouchpoint: boolean("is_touchpoint").default(false).notNull(),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("raw_comm_client_id_idx").on(table.clientId),
  sourceTypeIdx: index("raw_comm_source_type_idx").on(table.sourceType),
  timestampIdx: index("raw_comm_timestamp_idx").on(table.timestamp),
  reviewStatusIdx: index("raw_comm_review_status_idx").on(table.reviewStatus),
  matchStatusIdx: index("raw_comm_match_status_idx").on(table.matchStatus),
  clientTimestampIdx: index("raw_comm_client_timestamp_idx").on(table.clientId, table.timestamp),
  externalSourceIdx: index("raw_comm_external_source_id_idx").on(table.externalSourceId),
  touchpointIdx: index("raw_comm_is_touchpoint_idx").on(table.isTouchpoint),
  clientTouchpointIdx: index("raw_comm_client_touchpoint_idx").on(table.clientId, table.isTouchpoint, table.timestamp),
}));

export const insertRawCommunicationSchema = createInsertSchema(rawCommunicationRecords, {
  sourceType: z.enum(communicationSourceTypes),
  sourceSubtype: z.enum(communicationSourceSubtypes).optional(),
  direction: z.enum(communicationDirections).optional(),
  processingStatus: z.enum(communicationProcessingStatuses).optional(),
  reviewStatus: z.enum(communicationReviewStatuses).optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  aiSummary: true,
  aiSignals: true,
  aiProcessedAt: true,
  hasSuggestions: true,
  isTouchpoint: true,
  transcriptStatus: true,
});

export type InsertRawCommunication = z.infer<typeof insertRawCommunicationSchema>;
export type RawCommunicationRecord = typeof rawCommunicationRecords.$inferSelect;

export const aiSuggestionStatuses = ["pending", "approved", "edited_and_approved", "rejected", "snoozed", "no_update_needed"] as const;
export const aiSuggestionDestinations = ["command_panel", "intelligence_feed", "action_log"] as const;
export const aiSuggestionPriorities = ["urgent", "normal", "low"] as const;

export const aiSuggestions = pgTable("ai_suggestions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id).notNull(),
  rawCommunicationRecordId: varchar("raw_communication_record_id").references(() => rawCommunicationRecords.id, { onDelete: "cascade" }).notNull(),
  destinationType: varchar("destination_type").notNull(),
  suggestedTitle: text("suggested_title").notNull(),
  suggestedBody: text("suggested_body"),
  suggestedFieldChangesJson: jsonb("suggested_field_changes_json"),
  confidenceScore: real("confidence_score"),
  priority: varchar("priority").default("normal").notNull(),
  reasonForRecommendation: text("reason_for_recommendation"),
  citationSnippetsJson: jsonb("citation_snippets_json"),
  status: varchar("status").default("pending").notNull(),
  assignedToUserId: varchar("assigned_to_user_id").references(() => users.id),
  resolvedAt: timestamp("resolved_at"),
  resolutionNotes: text("resolution_notes"),
  resultingRecordId: varchar("resulting_record_id"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  clientIdx: index("ai_suggestions_client_id_idx").on(table.clientId),
  rawCommIdx: index("ai_suggestions_raw_comm_id_idx").on(table.rawCommunicationRecordId),
  statusIdx: index("ai_suggestions_status_idx").on(table.status),
  // Task #1573 (Audit Track C): composite for listAiSuggestions /
  // countPendingSuggestions; matches migration 0064 (created_at DESC).
  clientStatusCreatedIdx: index("ai_suggestions_client_status_created_idx").on(
    table.clientId,
    table.status,
    sql`${table.createdAt} DESC`,
  ),
}));

export const insertAiSuggestionSchema = createInsertSchema(aiSuggestions, {
  destinationType: z.enum(aiSuggestionDestinations),
  priority: z.enum(aiSuggestionPriorities).optional(),
  status: z.enum(aiSuggestionStatuses).optional(),
}).omit({
  id: true,
  createdAt: true,
  resolvedAt: true,
});

export type InsertAiSuggestion = z.infer<typeof insertAiSuggestionSchema>;

// Task #4222 (F8 follow-up) — focused edit shape for updateAiSuggestion.
// An EDIT is a resolution action: only the status/resolution fields are
// caller-editable. Row id, clientId (ownership), the source-record FK and
// the AI-authored content fields stay out of caller control. `resolvedAt`
// is re-added here (the insert schema omits it) because resolving IS the
// edit. The storage method parses through this schema at runtime so a
// future caller forwarding a raw request body cannot smuggle protected or
// unknown keys into the Drizzle `.set()`.
export const updateAiSuggestionSchema = insertAiSuggestionSchema
  .pick({ status: true, resolutionNotes: true, resultingRecordId: true })
  .extend({ resolvedAt: z.date().nullable() })
  .partial();
export type UpdateAiSuggestion = z.infer<typeof updateAiSuggestionSchema>;

export type AiSuggestion = typeof aiSuggestions.$inferSelect;

// Task #2637: the legacy `dismissed_operational` status is retired — the
// operational classifier is gone and its backlog is re-matched into the
// statuses below via the rematch_dismissed_operational_front_backlog prod-action.
export const frontSyncMatchStatuses = ["unmatched", "auto_matched", "manually_matched", "dismissed", "blocked"] as const;

export const frontPipelineStates = [
  "discovered",
  "fetch_persisted",
  "triage_pending",
  "triage_dismissed",
  "triage_candidate",
  "hydrate_pending",
  "hydrated",
  "deterministic_matched",
  "ai_match_pending",
  "ai_matched",
  "unmatched",
  "apply_pending",
  "applied",
  "failed",
  "dead_lettered",
] as const;
export type FrontPipelineState = typeof frontPipelineStates[number];

export const FRONT_PIPELINE_TRANSITIONS: Record<FrontPipelineState, readonly FrontPipelineState[]> = {
  discovered:             ["fetch_persisted", "failed"],
  fetch_persisted:        ["triage_pending", "failed"],
  triage_pending:         ["triage_dismissed", "triage_candidate", "failed"],
  triage_dismissed:       ["triage_pending"],
  triage_candidate:       ["hydrate_pending", "deterministic_matched", "failed"],
  hydrate_pending:        ["hydrated", "failed"],
  hydrated:               ["deterministic_matched", "ai_match_pending", "unmatched", "failed"],
  deterministic_matched:  ["apply_pending", "failed"],
  ai_match_pending:       ["ai_matched", "unmatched", "failed"],
  ai_matched:             ["apply_pending", "failed"],
  unmatched:              ["triage_pending", "ai_match_pending", "deterministic_matched", "dead_lettered"],
  apply_pending:          ["applied", "failed"],
  applied:                ["discovered"],
  failed:                 ["discovered", "triage_pending", "hydrate_pending", "apply_pending", "dead_lettered"],
  dead_lettered:          ["discovered"],
};

export function isValidPipelineTransition(from: FrontPipelineState, to: FrontPipelineState): boolean {
  return FRONT_PIPELINE_TRANSITIONS[from].includes(to);
}

export function computeVersionKey(conversationId: string, lastMessageId: string | null): string {
  return `${conversationId}::${lastMessageId || "no_msg"}`;
}

export const frontSyncEmails = pgTable("front_sync_emails", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: text("conversation_id").notNull().unique(),
  subject: text("subject"),
  snippet: text("snippet"),
  participantsJson: jsonb("participants_json"),
  frontStatus: varchar("front_status"),
  lastMessageAt: timestamp("last_message_at"),
  matchedClientId: varchar("matched_client_id").references(() => clients.id),
  matchStatus: varchar("match_status").default("unmatched").notNull(),
  matchConfidence: real("match_confidence"),
  matchReason: text("match_reason"),
  ingestedRecordId: varchar("ingested_record_id"),
  operationalClassificationReason: text("operational_classification_reason"),
  bulkClassifierVersion: integer("bulk_classifier_version"),
  dismissedBy: varchar("dismissed_by").references(() => users.id),
  processedAt: timestamp("processed_at"),
  pipelineState: varchar("pipeline_state").default("discovered").notNull(),
  lastMessageId: text("last_message_id"),
  versionKey: text("version_key"),
  pipelineError: text("pipeline_error"),
  pipelineAttempts: integer("pipeline_attempts").default(0).notNull(),
  stateChangedAt: timestamp("state_changed_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  matchStatusIdx: index("front_sync_match_status_idx").on(table.matchStatus),
  matchedClientIdx: index("front_sync_matched_client_idx").on(table.matchedClientId),
  conversationIdx: index("front_sync_conversation_id_idx").on(table.conversationId),
  lastMessageAtIdx: index("front_sync_last_message_at_idx").on(table.lastMessageAt),
  createdAtIdx: index("front_sync_created_at_idx").on(table.createdAt),
  pipelineStateIdx: index("front_sync_pipeline_state_idx").on(table.pipelineState),
  versionKeyIdx: index("front_sync_version_key_idx").on(table.versionKey),
}));

export const insertFrontSyncEmailSchema = createInsertSchema(frontSyncEmails).omit({
  id: true,
  createdAt: true,
});

export type InsertFrontSyncEmail = z.infer<typeof insertFrontSyncEmailSchema>;

// Task #4222 (F8 follow-up) — focused edit shape for updateFrontSyncEmail.
// Only the match/triage outcome fields are caller-editable. Row id, the
// immutable natural key (`conversationId`), ingest-managed message fields
// (subject/snippet/participants/lastMessageAt/lastMessageId/versionKey) and
// the pipeline-state machine columns (owned exclusively by
// transitionFrontSyncPipelineState) stay out of caller control. The storage
// method parses through this schema at runtime so a future caller forwarding
// a raw request body cannot smuggle protected or unknown keys into `.set()`.
export const updateFrontSyncEmailSchema = insertFrontSyncEmailSchema
  .pick({
    matchStatus: true,
    matchedClientId: true,
    matchConfidence: true,
    matchReason: true,
    ingestedRecordId: true,
    operationalClassificationReason: true,
    bulkClassifierVersion: true,
    dismissedBy: true,
    processedAt: true,
  })
  .partial();
export type UpdateFrontSyncEmail = z.infer<typeof updateFrontSyncEmailSchema>;

export type FrontSyncEmail = typeof frontSyncEmails.$inferSelect;

export const frontHydrateSnapshots = pgTable("front_hydrate_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: text("conversation_id").notNull(),
  versionKey: text("version_key").notNull().unique(),
  conversationJson: jsonb("conversation_json").notNull(),
  messagesJson: jsonb("messages_json").notNull(),
  messageCount: integer("message_count").notNull(),
  hydratedAt: timestamp("hydrated_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
}, (table) => ({
  conversationIdx: index("front_hydrate_conversation_id_idx").on(table.conversationId),
  versionKeyIdx: index("front_hydrate_version_key_idx").on(table.versionKey),
}));

export const insertFrontHydrateSnapshotSchema = createInsertSchema(frontHydrateSnapshots).omit({
  id: true,
  hydratedAt: true,
});

export type InsertFrontHydrateSnapshot = z.infer<typeof insertFrontHydrateSnapshotSchema>;
export type FrontHydrateSnapshot = typeof frontHydrateSnapshots.$inferSelect;

/**
 * Task #867: Provenance trail for hard-match decisions on Front emails. Each
 * row records a single re-evaluation outcome — the prior client/method on the
 * sync_email row at the time of evaluation and the new outcome the hard
 * matcher produced. Used by the one-time backfill job and by the live
 * pipeline so operators can audit "why did this email move?".
 */
export const frontMatchAuditLog = pgTable("front_match_audit_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  syncEmailId: varchar("sync_email_id").references(() => frontSyncEmails.id, { onDelete: "cascade" }).notNull(),
  conversationId: text("conversation_id").notNull(),
  // "backfill_867" | "pipeline" | "manual_assign" | "ai_suggested_accepted" |
  // "filter_rule" — free-form so future surfaces can append without a
  // schema migration.
  source: varchar("source").notNull(),
  // "matched" | "moved" | "unmatched" | "noop"
  outcome: varchar("outcome").notNull(),
  priorClientId: varchar("prior_client_id").references(() => clients.id, { onDelete: "set null" }),
  priorMatchStatus: varchar("prior_match_status"),
  priorMatchMethod: varchar("prior_match_method"),
  newClientId: varchar("new_client_id").references(() => clients.id, { onDelete: "set null" }),
  newMatchMethod: varchar("new_match_method"),
  reason: text("reason"),
  matchedOn: text("matched_on"),
  triggeredBy: varchar("triggered_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  syncEmailIdx: index("front_match_audit_sync_email_id_idx").on(table.syncEmailId),
  conversationIdx: index("front_match_audit_conversation_id_idx").on(table.conversationId),
  createdAtIdx: index("front_match_audit_created_at_idx").on(table.createdAt),
}));

export const insertFrontMatchAuditLogSchema = createInsertSchema(frontMatchAuditLog).omit({
  id: true,
  createdAt: true,
});

export type InsertFrontMatchAuditLog = z.infer<typeof insertFrontMatchAuditLogSchema>;
export type FrontMatchAuditLog = typeof frontMatchAuditLog.$inferSelect;

/**
 * Task #966 — Structured audit trail for orphaning events.
 *
 * The previous policy concatenated free-text reasons onto
 * `raw_communication_records.operational_classification_reason`
 * (e.g. `[orphaned: client X deleted at TS]`). That column
 * accumulates strings and is hard to query — operators cannot
 * answer "how many records were orphaned this month?" or "which
 * deletion event produced this orphan?". This table records one
 * row per orphaning event with the cause, source, prior client id,
 * prior match status, optional free-form reason, and timestamp.
 *
 * Existing `operational_classification_reason` strings remain
 * readable for backwards compat; new code reads from this table.
 */
export const communicationOrphanCauses = ["client_deleted", "sweep_backfill"] as const;
export type CommunicationOrphanCause = typeof communicationOrphanCauses[number];

export const communicationOrphanEvents = pgTable("communication_orphan_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  rawCommunicationRecordId: varchar("raw_communication_record_id").notNull(),
  priorClientId: varchar("prior_client_id"),
  priorMatchStatus: varchar("prior_match_status"),
  cause: varchar("cause", { length: 32 }).notNull(),
  source: varchar("source", { length: 64 }).notNull(),
  reason: text("reason"),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
}, (table) => ({
  // Match the migration: occurred_at uses DESC ordering and the prior
  // client index is partial (WHERE prior_client_id IS NOT NULL).
  recordIdx: index("communication_orphan_events_record_idx").on(table.rawCommunicationRecordId, table.occurredAt.desc()),
  priorClientIdx: index("communication_orphan_events_prior_client_idx").on(table.priorClientId, table.occurredAt.desc()).where(sql`prior_client_id IS NOT NULL`),
  occurredAtIdx: index("communication_orphan_events_occurred_at_idx").on(table.occurredAt.desc()),
  causeIdx: index("communication_orphan_events_cause_idx").on(table.cause, table.occurredAt.desc()),
}));

export const insertCommunicationOrphanEventSchema = createInsertSchema(communicationOrphanEvents, {
  cause: z.enum(communicationOrphanCauses),
}).omit({
  id: true,
  occurredAt: true,
});

export type InsertCommunicationOrphanEvent = z.infer<typeof insertCommunicationOrphanEventSchema>;
export type CommunicationOrphanEvent = typeof communicationOrphanEvents.$inferSelect;

export const slackChannelMappings = pgTable("slack_channel_mappings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  channelId: varchar("channel_id").notNull().unique(),
  channelName: varchar("channel_name").notNull(),
  mappedClientId: varchar("mapped_client_id").references(() => clients.id, { onDelete: "set null" }),
  autoCreated: boolean("auto_created").default(false),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  channelIdx: index("slack_channel_mappings_channel_id_idx").on(table.channelId),
  clientIdx: index("slack_channel_mappings_client_id_idx").on(table.mappedClientId),
}));

export const insertSlackChannelMappingSchema = createInsertSchema(slackChannelMappings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSlackChannelMapping = z.infer<typeof insertSlackChannelMappingSchema>;

// Task #4200 (F8 follow-up) — focused edit shape for updateSlackChannelMapping.
// Beyond the insert schema's id/createdAt/updatedAt omissions, an EDIT also
// keeps the immutable natural key (`channelId`) and the server bookkeeping
// flag (`autoCreated`) out of caller control. The storage method parses
// through this schema at runtime so a future caller forwarding a raw request
// body cannot smuggle protected or unknown keys into the Drizzle `.set()`.
export const updateSlackChannelMappingSchema = insertSlackChannelMappingSchema
  .omit({ channelId: true, autoCreated: true })
  .partial();
export type UpdateSlackChannelMapping = z.infer<typeof updateSlackChannelMappingSchema>;

export type SlackChannelMapping = typeof slackChannelMappings.$inferSelect;

export const slackSyncHistory = pgTable("slack_sync_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  triggeredBy: varchar("triggered_by").references(() => users.id),
  status: varchar("status").notNull().default("running"),
  channelsProcessed: integer("channels_processed").default(0),
  messagesCreated: integer("messages_created").default(0),
  messagesSkipped: integer("messages_skipped").default(0),
  errors: jsonb("errors"),
  startedAt: timestamp("started_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const insertSlackSyncHistorySchema = createInsertSchema(slackSyncHistory).omit({
  id: true,
  startedAt: true,
  completedAt: true,
});

export type InsertSlackSyncHistory = z.infer<typeof insertSlackSyncHistorySchema>;

// Task #4222 (F8 follow-up) — focused edit shape for updateSlackSyncHistory.
// An EDIT records sync progress/completion: counters, status, errors and
// `completedAt` (re-added — the insert schema omits it because the server
// stamps startedAt/completedAt). Row id and `triggeredBy` (attribution)
// stay out of caller control. Runtime-parsed in the storage method.
export const updateSlackSyncHistorySchema = insertSlackSyncHistorySchema
  .pick({
    status: true,
    channelsProcessed: true,
    messagesCreated: true,
    messagesSkipped: true,
    errors: true,
  })
  .extend({ completedAt: z.date().nullable() })
  .partial();
export type UpdateSlackSyncHistory = z.infer<typeof updateSlackSyncHistorySchema>;

export type SlackSyncHistory = typeof slackSyncHistory.$inferSelect;

export const clientConversationSummaries = pgTable("client_conversation_summaries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id).notNull().unique(),
  summaryJson: jsonb("summary_json").notNull(),
  generatedAt: timestamp("generated_at").notNull(),
  windowStart: timestamp("window_start").notNull(),
  windowEnd: timestamp("window_end").notNull(),
  commCount: integer("comm_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("client_conv_summary_client_id_idx").on(table.clientId),
}));

export const insertClientConversationSummarySchema = createInsertSchema(clientConversationSummaries).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertClientConversationSummary = z.infer<typeof insertClientConversationSummarySchema>;
export type ClientConversationSummary = typeof clientConversationSummaries.$inferSelect;

export const communicationClientLinks = pgTable("communication_client_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  rawCommunicationRecordId: varchar("raw_communication_record_id").references(() => rawCommunicationRecords.id, { onDelete: "cascade" }).notNull(),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  matchMethod: varchar("match_method"),
  matchConfidence: real("match_confidence"),
  relevantSegments: jsonb("relevant_segments").$type<Array<{ timestamp?: string; text: string; context?: string }>>(),
  perClientSummary: text("per_client_summary"),
  isPrimary: boolean("is_primary").default(false),
  status: varchar("status").default("detected").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  commRecordIdx: index("comm_client_link_record_idx").on(table.rawCommunicationRecordId),
  clientIdx: index("comm_client_link_client_idx").on(table.clientId),
  // Task #1573 (Audit Track C): composite to drop the status filter from
  // bitmap heap; see migration 0064.
  clientStatusIdx: index("comm_client_link_client_status_idx").on(table.clientId, table.status),
  uniqueLink: unique("comm_client_link_unique").on(table.rawCommunicationRecordId, table.clientId),
}));

export const insertCommunicationClientLinkSchema = createInsertSchema(communicationClientLinks).omit({
  id: true,
  createdAt: true,
});

export type InsertCommunicationClientLink = z.infer<typeof insertCommunicationClientLinkSchema>;

// Task #4222 (F8 follow-up) — focused edit shape for
// updateCommunicationClientLink. Beyond the insert schema's id/createdAt
// omissions, an EDIT also keeps the two link-identity keys
// (`rawCommunicationRecordId`, `clientId`) out of caller control — editing
// a link must never re-point it at a different record or client.
// Runtime-parsed in the storage method.
export const updateCommunicationClientLinkSchema = insertCommunicationClientLinkSchema
  .omit({ rawCommunicationRecordId: true, clientId: true })
  .partial();
export type UpdateCommunicationClientLink = z.infer<typeof updateCommunicationClientLinkSchema>;

export type CommunicationClientLink = typeof communicationClientLinks.$inferSelect;

export const twilioConversationStatuses = ["active", "archived"] as const;
export const twilioMessageStatuses = ["queued", "sent", "delivered", "failed", "received"] as const;
export const twilioMessageDirections = ["inbound", "outbound"] as const;
export const twilioCallStatuses = ["initiated", "ringing", "in-progress", "completed", "failed", "busy", "no-answer", "canceled"] as const;
export const twilioCallDirections = ["inbound", "outbound"] as const;

export const twilioConversations = pgTable("twilio_conversations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id),
  clientContactId: varchar("client_contact_id"),
  contactPhone: varchar("contact_phone").notNull(),
  contactName: varchar("contact_name"),
  displayName: varchar("display_name"),
  twilioPhoneNumber: varchar("twilio_phone_number").notNull(),
  status: varchar("status").default("active").notNull(),
  conversationType: varchar("conversation_type").default("direct").notNull(),
  participants: jsonb("participants").$type<Array<{ phone: string; name?: string; contactId?: string }>>().default([]),
  // Task #849: canonical match keys for direct (1:1) SMS threads. Stored
  // in addition to the raw `contactPhone` / `twilioPhoneNumber` so display
  // formatting can stay human-readable while lookup uses a deterministic
  // last-10-digit key. Group conversations leave these null.
  contactPhoneNormalized: varchar("contact_phone_normalized"),
  twilioPhoneNumberNormalized: varchar("twilio_phone_number_normalized"),
  // `direct:{twilioKey}:{contactKey}` — see server/services/phoneNormalization.ts.
  // Only populated for non-group rows; the partial unique index below
  // enforces one active direct thread per (twilio, contact) pair.
  directThreadKey: varchar("direct_thread_key"),
  lastMessageAt: timestamp("last_message_at"),
  lastMessagePreview: text("last_message_preview"),
  unreadCount: integer("unread_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("twilio_conv_client_id_idx").on(table.clientId),
  phoneIdx: index("twilio_conv_contact_phone_idx").on(table.contactPhone),
  lastMsgIdx: index("twilio_conv_last_message_idx").on(table.lastMessageAt),
  participantsIdx: index("twilio_conv_participants_idx").using("gin", table.participants),
  conversationTypeIdx: index("twilio_conv_type_idx").on(table.conversationType),
  contactNormalizedIdx: index("twilio_conv_contact_normalized_idx").on(table.contactPhoneNormalized),
  twilioNormalizedIdx: index("twilio_conv_twilio_normalized_idx").on(table.twilioPhoneNumberNormalized),
  directThreadKeyIdx: index("twilio_conv_direct_thread_key_idx").on(table.directThreadKey),
  // One direct (non-group) row per (twilio, contact) pair with a non-null key.
  directActiveUniq: uniqueIndex("twilio_conv_direct_active_uniq")
    .on(table.directThreadKey)
    .where(sql`${table.conversationType} <> 'group' AND ${table.directThreadKey} IS NOT NULL`),
}));

export const insertTwilioConversationSchema = createInsertSchema(twilioConversations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTwilioConversation = z.infer<typeof insertTwilioConversationSchema>;

// Task #4222 (F8 follow-up) — focused edit shape for updateTwilioConversation.
// Contact/display/thread-state fields are caller-editable (including the
// normalized keys written by conversationDedupe.buildNormalizedFields).
// Row id, `clientId`/`clientContactId` (ownership — re-linking goes through
// the dedicated link/merge paths) and `twilioPhoneNumber` (our number, an
// identity column) stay out of caller control. Runtime-parsed in storage.
export const updateTwilioConversationSchema = insertTwilioConversationSchema
  .pick({
    contactPhone: true,
    contactName: true,
    displayName: true,
    status: true,
    conversationType: true,
    participants: true,
    contactPhoneNormalized: true,
    twilioPhoneNumberNormalized: true,
    directThreadKey: true,
    lastMessageAt: true,
    lastMessagePreview: true,
    unreadCount: true,
  })
  .partial();
export type UpdateTwilioConversation = z.infer<typeof updateTwilioConversationSchema>;

export type TwilioConversation = typeof twilioConversations.$inferSelect;

export const twilioMessages = pgTable("twilio_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").references(() => twilioConversations.id, { onDelete: "cascade" }).notNull(),
  twilioSid: varchar("twilio_sid"),
  direction: varchar("direction").notNull(),
  fromNumber: varchar("from_number").notNull(),
  toNumber: varchar("to_number").notNull(),
  body: text("body").notNull(),
  status: varchar("status").default("queued").notNull(),
  // Task #875: Twilio delivery-status callback writes these when a
  // message ends in `failed` / `undelivered`. Old rows (pre-task) leave
  // them NULL — the thread view treats NULL as "no Twilio diagnostic
  // available". `errorCode` is the numeric Twilio error (e.g. 30003,
  // 30005); `errorMessage` is Twilio's short description.
  errorCode: varchar("error_code"),
  errorMessage: text("error_message"),
  // Task #883: which Twilio transport the outbound message actually went
  // out through. When set, the message was sent via Messaging Service
  // (RCS-capable Sender Pool) and the `from_number` column only records
  // the configured Twilio phone for thread matching — Twilio actually
  // picked the sender from the service. When NULL on outbound rows, the
  // legacy single-`from` path was used (i.e. `from_number` is the real
  // sender). Always NULL on inbound rows. Populated on insert by
  // `sendSms` and on subsequent status-callback writes from the
  // `MessagingServiceSid` Twilio webhook field so older rows (pre-#883)
  // get backfilled the next time a delivery-status callback fires.
  messagingServiceSid: varchar("messaging_service_sid"),
  sentByUserId: varchar("sent_by_user_id").references(() => users.id),
  rawCommunicationRecordId: varchar("raw_communication_record_id"),
  // Task #3896 (audit B-003): outbound dispatch claim. Set atomically when
  // an outbound send claims this row BEFORE calling Twilio (the row id is
  // the durable operation identity); cleared when the dispatch settles
  // (finalize-with-SID or explicit failure). NULL on inbound rows, on all
  // historical rows, and on settled rows. A row with twilio_sid NULL and a
  // fresh dispatch_claimed_at is an in-flight outbound create; a stale one
  // (older than TWILIO_DISPATCH_STALE_CLAIM_MS) means the sender crashed
  // mid-dispatch — see TWILIO.md "Outbound dispatch reliability".
  dispatchClaimToken: varchar("dispatch_claim_token"),
  dispatchClaimedAt: timestamp("dispatch_claimed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  // Task #875: bumped on every status-callback write so the thread
  // view can poll for in-place status mutations (queued → sent →
  // delivered) using a separate "updated since" watermark.
  // Incremental polling on `created_at` alone never picks these up
  // because the row's created_at is unchanged.
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  convIdx: index("twilio_msg_conversation_id_idx").on(table.conversationId),
  twilioSidIdx: index("twilio_msg_twilio_sid_idx").on(table.twilioSid),
  createdAtIdx: index("twilio_msg_created_at_idx").on(table.createdAt),
  updatedAtIdx: index("twilio_msg_updated_at_idx").on(table.updatedAt),
  // Task #849: enforce webhook idempotency at the DB level. A retried
  // inbound webhook with the same MessageSid must collide here so the
  // app cannot accidentally insert a duplicate row even if the
  // application-level guard is missed. Outbound rows that have no SID yet
  // (status `failed` before send, queued, …) store NULL and are excluded
  // by the partial predicate.
  twilioSidUniq: uniqueIndex("twilio_msg_twilio_sid_uniq")
    .on(table.twilioSid)
    .where(sql`${table.twilioSid} IS NOT NULL`),
}));

export const insertTwilioMessageSchema = createInsertSchema(twilioMessages).omit({
  id: true,
  createdAt: true,
});

export type InsertTwilioMessage = z.infer<typeof insertTwilioMessageSchema>;

// Task #4222 (F8 follow-up) — focused edit shape for updateTwilioMessage.
// A message EDIT is a delivery-status update only (the dedicated webhook
// helper updates by Twilio SID; this generic-by-id function has the same
// edit surface). Body, direction, numbers, attribution and claim columns
// stay out of caller control. Runtime-parsed in the storage method.
export const updateTwilioMessageSchema = insertTwilioMessageSchema
  .pick({ status: true, errorCode: true, errorMessage: true, twilioSid: true, rawCommunicationRecordId: true })
  .partial();
export type UpdateTwilioMessage = z.infer<typeof updateTwilioMessageSchema>;

export type TwilioMessage = typeof twilioMessages.$inferSelect;

export const twilioCalls = pgTable("twilio_calls", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id),
  clientContactId: varchar("client_contact_id"),
  twilioSid: varchar("twilio_sid"),
  direction: varchar("direction").notNull(),
  fromNumber: varchar("from_number").notNull(),
  toNumber: varchar("to_number").notNull(),
  status: varchar("status").default("initiated").notNull(),
  duration: integer("duration"),
  initiatedByUserId: varchar("initiated_by_user_id").references(() => users.id),
  routedToUserId: varchar("routed_to_user_id").references(() => users.id),
  routingTier: integer("routing_tier"),
  answeredAt: timestamp("answered_at"),
  rawCommunicationRecordId: varchar("raw_communication_record_id"),
  // Task #3896 (audit B-003): outbound dispatch claim — same contract as
  // twilio_messages.dispatch_claim_token / dispatch_claimed_at (see there).
  dispatchClaimToken: varchar("dispatch_claim_token"),
  dispatchClaimedAt: timestamp("dispatch_claimed_at"),
  // Recording metadata populated by the /webhooks/recording-status
  // handler. All nullable — calls older than migration 0040 or with
  // recording explicitly disabled simply have no values here.
  recordingSid: varchar("recording_sid"),
  recordingUrl: varchar("recording_url"),
  recordingDuration: integer("recording_duration"),
  recordingStatus: varchar("recording_status"),
  recordingChannels: integer("recording_channels"),
  // Archive pipeline (migration 0041): downloads from Twilio into our
  // private object storage, transcribes, mirrors to Drive, then deletes
  // from Twilio after a safety window. See server/services/callArchivePipeline.ts.
  archiveStatus: varchar("archive_status").default("pending"),
  archiveAttempts: integer("archive_attempts").default(0).notNull(),
  archiveLastError: text("archive_last_error"),
  // Workers/queues audit parity (E-F06), migration
  // 20260806182339_twilio_calls_archive_failure_reason.sql: typed
  // machine-readable classification of the last archive failure (see
  // callArchiveFailureReasons in callArchivePipeline.ts), written by
  // recordFailure() alongside the free-text archive_last_error.
  archiveFailureReason: varchar("archive_failure_reason"),
  archiveLockedUntil: timestamp("archive_locked_until"),
  archiveNextAttemptAt: timestamp("archive_next_attempt_at"),
  // Task #1099: epoch of the current claim's lease. Set by the claim
  // SQL when a row transitions into 'processing'; NEVER touched by the
  // heartbeat (which keeps overwriting archive_locked_until). Lets the
  // stuck-processing inventory show true time-since-claim instead of
  // NOW() - updated_at, which is bumped by intermediate writes.
  archiveLeasedAt: timestamp("archive_leased_at"),
  objectStorageKey: text("object_storage_key"),
  objectStorageArchivedAt: timestamp("object_storage_archived_at"),
  transcriptText: text("transcript_text"),
  transcriptCompletedAt: timestamp("transcript_completed_at"),
  transcriptError: text("transcript_error"),
  driveRecordingFileId: text("drive_recording_file_id"),
  driveRecordingFolderId: text("drive_recording_folder_id"),
  driveRecordingWebLink: text("drive_recording_web_link"),
  driveRecordingUploadedAt: timestamp("drive_recording_uploaded_at"),
  driveTranscriptFileId: text("drive_transcript_file_id"),
  driveTranscriptFolderId: text("drive_transcript_folder_id"),
  driveTranscriptWebLink: text("drive_transcript_web_link"),
  driveTranscriptUploadedAt: timestamp("drive_transcript_uploaded_at"),
  // Task #4025 — in-app client-file copies written by the delivery phase
  // (mode-gated alongside the Drive mirror). saved_at timestamps are the
  // per-sink idempotency markers, mirroring drive_*_uploaded_at above.
  clientFileRecordingId: varchar("client_file_recording_id"),
  clientFileRecordingSavedAt: timestamp("client_file_recording_saved_at"),
  clientFileTranscriptId: varchar("client_file_transcript_id"),
  clientFileTranscriptSavedAt: timestamp("client_file_transcript_saved_at"),
  twilioDeleteEligibleAt: timestamp("twilio_delete_eligible_at"),
  twilioRecordingDeletedAt: timestamp("twilio_recording_deleted_at"),
  // Voicemail (migration 0055): populated by the
  // /webhooks/voicemail-recording-status and
  // /webhooks/voicemail-transcription handlers when an inbound call
  // falls through to the voicemail <Record> verb. All nullable —
  // calls that never reached voicemail simply have no values here.
  // voicemailListenedAt is set the first time a user opens the
  // voicemail card; the "VM" inbox badge counts rows where it is NULL.
  voicemailRecordingSid: varchar("voicemail_recording_sid"),
  voicemailRecordingUrl: varchar("voicemail_recording_url"),
  voicemailRecordingDuration: integer("voicemail_recording_duration"),
  voicemailTranscriptionText: text("voicemail_transcription_text"),
  voicemailTranscriptionStatus: varchar("voicemail_transcription_status"),
  voicemailListenedAt: timestamp("voicemail_listened_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("twilio_call_client_id_idx").on(table.clientId),
  twilioSidIdx: index("twilio_call_twilio_sid_idx").on(table.twilioSid),
}));

export const insertTwilioCallSchema = createInsertSchema(twilioCalls).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTwilioCall = z.infer<typeof insertTwilioCallSchema>;

// Task #4222 (F8 follow-up) — focused edit shape for updateTwilioCall.
// Call lifecycle/routing/recording/voicemail fields are caller-editable.
// Row id, identity columns (twilioSid, direction, numbers, clientId),
// dispatch-claim columns and the archive-pipeline state machine (owned by
// callArchivePipeline's dedicated claim/heartbeat SQL) stay out of caller
// control. Runtime-parsed in the storage method.
export const updateTwilioCallSchema = insertTwilioCallSchema
  .pick({
    status: true,
    duration: true,
    routedToUserId: true,
    routingTier: true,
    answeredAt: true,
    rawCommunicationRecordId: true,
    recordingSid: true,
    recordingUrl: true,
    recordingDuration: true,
    recordingStatus: true,
    recordingChannels: true,
    voicemailRecordingSid: true,
    voicemailRecordingUrl: true,
    voicemailRecordingDuration: true,
    voicemailTranscriptionText: true,
    voicemailTranscriptionStatus: true,
    voicemailListenedAt: true,
  })
  .partial();
export type UpdateTwilioCall = z.infer<typeof updateTwilioCallSchema>;

export type TwilioCall = typeof twilioCalls.$inferSelect;

// Task #850: notes + assignment + status (needs_follow_up / resolved) on a
// unified Conversation Hub thread. Keyed by the same thread key the client
// builds in `client/src/lib/conversationModel.ts#resolveThreadKey` (e.g.
// `phone:8005551234`, `group:<convId>`, `contact:<id>`,
// `client-phone:<clientId>:<digits>`) so notes/assignments survive across
// multiple SMS conversation rows that share one phone number.
export const threadStatuses = ["open", "needs_follow_up", "resolved"] as const;
export type ThreadStatus = typeof threadStatuses[number];

export const threadNotes = pgTable("thread_notes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  threadKey: varchar("thread_key").notNull(),
  body: text("body").notNull(),
  createdByUserId: varchar("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  threadKeyIdx: index("thread_notes_thread_key_idx").on(table.threadKey, table.createdAt),
}));

export const insertThreadNoteSchema = createInsertSchema(threadNotes).omit({
  id: true,
  createdAt: true,
});

export type InsertThreadNote = z.infer<typeof insertThreadNoteSchema>;
export type ThreadNote = typeof threadNotes.$inferSelect;

export const threadAssignments = pgTable("thread_assignments", {
  threadKey: varchar("thread_key").primaryKey(),
  assignedToUserId: varchar("assigned_to_user_id").references(() => users.id, { onDelete: "set null" }),
  status: varchar("status").default("open").notNull(),
  updatedByUserId: varchar("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  assignedIdx: index("thread_assignments_assigned_idx").on(table.assignedToUserId),
  statusIdx: index("thread_assignments_status_idx").on(table.status),
}));

export const insertThreadAssignmentSchema = createInsertSchema(threadAssignments, {
  status: z.enum(threadStatuses).optional(),
}).omit({
  updatedAt: true,
});

export type InsertThreadAssignment = z.infer<typeof insertThreadAssignmentSchema>;
export type ThreadAssignment = typeof threadAssignments.$inferSelect;

// Task #1685 — manual read/unread toggle for Conversation Hub threads.
// Keyed by the same unified thread key as `thread_assignments` so the
// flag survives across multiple SMS conversation rows that share a phone
// number AND works for call-only / voicemail-only threads that have no
// SMS conversation row to hang a column off.
//
// Source-of-truth note: SMS unread today is global (the
// `twilio_conversations.unread_count` column). To stay consistent with the
// existing badge / filter / auto-mark-on-open plumbing, the manual toggle
// is also global — there is no per-user `manuallyUnread`. See the route
// handler in `server/routes/twilio.ts` for the rationale.
export const threadReadStates = pgTable("thread_read_states", {
  threadKey: varchar("thread_key").primaryKey(),
  manuallyUnread: boolean("manually_unread").default(false).notNull(),
  updatedByUserId: varchar("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  unreadIdx: index("thread_read_states_manually_unread_idx").on(table.manuallyUnread),
}));

export type ThreadReadState = typeof threadReadStates.$inferSelect;

// Task #1288 — per-user inbox of "you were assigned to this thread" pings.
// One row is inserted whenever `thread_assignments.assigned_to_user_id`
// transitions to a new (non-null) user that isn't the actor making the
// change. The Conversation Hub queries the unread rows on load to show a
// badge on the "Mine" chip and a one-time toast.
export const threadAssignmentNotifications = pgTable("thread_assignment_notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  threadKey: varchar("thread_key").notNull(),
  userId: varchar("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  assignedByUserId: varchar("assigned_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  readAt: timestamp("read_at"),
}, (table) => ({
  userUnreadIdx: index("thread_assignment_notifications_user_unread_idx").on(
    table.userId,
    table.readAt,
  ),
}));

export const insertThreadAssignmentNotificationSchema = createInsertSchema(
  threadAssignmentNotifications,
).omit({
  id: true,
  createdAt: true,
  readAt: true,
});

export type InsertThreadAssignmentNotification = z.infer<typeof insertThreadAssignmentNotificationSchema>;
export type ThreadAssignmentNotification = typeof threadAssignmentNotifications.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Task #4336 — SMS consent ledger & quiet-hours send gate.
//
// Compliance floor required before any automated/marketing SMS ever ships.
// The ledger is OUR durable, cross-number record of texting consent per
// recipient phone number. Twilio's edge keeps its own carrier-level opt-out
// block list, but that list is (a) scoped to a single (recipient, our-number)
// pair, (b) invisible in bulk via the REST API, and (c) explicitly documented
// by Twilio as "we recommend blocking numbers on your side". See TWILIO.md
// "SMS consent & opt-out" for the full division of labor.
//
// `state` semantics: consent as expressed to us (keywords, manual operator
// entry, backfill). `opted_out` additionally absorbs carrier-block evidence
// (a send rejected with Twilio error 21610) because an undeliverable number
// must never count as sendable regardless of expressed consent.

export const smsConsentStates = ["opted_in", "opted_out", "unknown"] as const;
export type SmsConsentState = (typeof smsConsentStates)[number];

export const smsConsentSources = [
  // Inbound STOP/START-family keyword on the Twilio SMS webhook.
  "keyword_inbound",
  // Outbound send rejected by Twilio with error 21610 (carrier block list).
  "twilio_block_21610",
  // Operator set the state by hand in the admin ledger (note required).
  "manual",
  // Backfill seeded a previously-unknown number with state `unknown`.
  "backfill_seed",
  // Backfill derived the state from historical inbound keyword messages.
  "backfill_history",
  // Buyer made an explicit checked/unchecked choice on the book checkout.
  // This records evidence only; a checked box remains `unknown` until the
  // approved confirmation flow produces authoritative opt-in evidence.
  "book_checkout",
  // Task #5105 — GHL Marketplace webhook: ContactDndUpdate (DND enabled) or
  // InboundMessage STOP-family. Tighten-only: GHL may only make outreach more
  // restrictive; it is never accepted as affirmative consent authority.
  "ghl_dnd",
] as const;
export type SmsConsentSource = (typeof smsConsentSources)[number];

export const smsConsentLedger = pgTable("sms_consent_ledger", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // E.164 (`+1XXXXXXXXXX`) — unique identity of the ledger row.
  phoneNormalized: varchar("phone_normalized").notNull(),
  // Last-10-digits canonical key (`getPhoneMatchKey`) so UI surfaces holding
  // loosely-formatted phone strings can resolve consent without re-deriving
  // E.164 (mirrors the twilio_conversations matching convention).
  phoneMatchKey: varchar("phone_match_key").notNull(),
  state: varchar("state").notNull().default("unknown"),
  source: varchar("source").notNull(),
  // Human-readable provenance for the CURRENT state (message SID, operator
  // note, Twilio error reference). Full history lives in sms_consent_events.
  evidence: text("evidence"),
  // Optional IANA timezone override for quiet-hours evaluation. NULL means
  // the send gate derives candidates from the NANP area code (conservative
  // multi-zone check when unmapped) — see server/services/smsQuietHours.ts.
  timezone: varchar("timezone"),
  optedInAt: timestamp("opted_in_at"),
  optedOutAt: timestamp("opted_out_at"),
  // Real users.id or NULL only — synthetic actor markers violate the FK.
  updatedByUserId: varchar("updated_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Upsert target: all writers use INSERT … ON CONFLICT (phone_normalized)
  // so concurrent webhook/manual/backfill writers can never duplicate a row.
  phoneUniq: uniqueIndex("sms_consent_ledger_phone_uniq").on(table.phoneNormalized),
  matchKeyIdx: index("sms_consent_ledger_match_key_idx").on(table.phoneMatchKey),
  updatedAtIdx: index("sms_consent_ledger_updated_at_idx").on(table.updatedAt),
}));

export const insertSmsConsentLedgerSchema = createInsertSchema(smsConsentLedger).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSmsConsentLedger = z.infer<typeof insertSmsConsentLedgerSchema>;
export type SmsConsentLedgerRow = typeof smsConsentLedger.$inferSelect;

export const smsConsentEventTypes = [
  "opt_out",
  "opt_in",
  "help",
  "manual_set",
  "twilio_block",
  "backfill",
  "checkout_choice",
] as const;
export type SmsConsentEventType = (typeof smsConsentEventTypes)[number];

// Append-only history of every consent-affecting observation. Keyword events
// carry the inbound MessageSid; the partial unique index makes webhook
// replays a database-level no-op even if the upstream SID dedupe in
// `handleInboundSms` were ever bypassed (belt-and-braces, mirroring the
// twilio_messages `twilio_msg_twilio_sid_uniq` convention).
export const smsConsentEvents = pgTable("sms_consent_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phoneNormalized: varchar("phone_normalized").notNull(),
  messageSid: varchar("message_sid"),
  eventType: varchar("event_type").notNull(),
  // Uppercased keyword that triggered a keyword event (STOP, START, HELP…).
  keyword: varchar("keyword"),
  priorState: varchar("prior_state"),
  newState: varchar("new_state"),
  source: varchar("source").notNull(),
  // Real users.id or NULL only (manual events record the operator).
  actorUserId: varchar("actor_user_id").references(() => users.id),
  detail: text("detail"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  phoneCreatedIdx: index("sms_consent_events_phone_created_idx").on(
    table.phoneNormalized,
    table.createdAt,
  ),
  createdAtIdx: index("sms_consent_events_created_at_idx").on(table.createdAt),
  messageSidUniq: uniqueIndex("sms_consent_events_message_sid_uniq")
    .on(table.messageSid)
    .where(sql`${table.messageSid} IS NOT NULL`),
}));

export const insertSmsConsentEventSchema = createInsertSchema(smsConsentEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertSmsConsentEvent = z.infer<typeof insertSmsConsentEventSchema>;
export type SmsConsentEvent = typeof smsConsentEvents.$inferSelect;

export const smsSendGateOutcomes = [
  // Gate passed; the delegated Twilio send succeeded.
  "allowed",
  // Gate passed but the delegated Twilio send threw (audit trail for P11
  // triage — the thrown error still propagates to the caller).
  "send_failed",
  "blocked_kill_switch",
  "blocked_no_consent",
  "blocked_opted_out",
  "blocked_quiet_hours",
  "blocked_invalid_phone",
] as const;
export type SmsSendGateOutcome = (typeof smsSendGateOutcomes)[number];

// Audit log of every automated-SMS gate evaluation (allowed AND blocked).
// Human console 1:1 sends deliberately do NOT pass through the gate and are
// never recorded here — see TWILIO.md "SMS consent & opt-out".
export const smsSendGateAudit = pgTable("sms_send_gate_audit", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phoneNormalized: varchar("phone_normalized").notNull(),
  // Caller-supplied machine label for WHAT automation attempted the send
  // (e.g. "booking_reminder"). Required so a future opt-out investigation
  // can attribute every attempt.
  purpose: varchar("purpose").notNull(),
  outcome: varchar("outcome").notNull(),
  consentState: varchar("consent_state"),
  detail: text("detail"),
  // Real users.id or NULL only.
  requestedByUserId: varchar("requested_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  createdAtIdx: index("sms_send_gate_audit_created_at_idx").on(table.createdAt),
  phoneCreatedIdx: index("sms_send_gate_audit_phone_created_idx").on(
    table.phoneNormalized,
    table.createdAt,
  ),
}));

export const insertSmsSendGateAuditSchema = createInsertSchema(smsSendGateAudit).omit({
  id: true,
  createdAt: true,
});
export type InsertSmsSendGateAudit = z.infer<typeof insertSmsSendGateAuditSchema>;
export type SmsSendGateAuditRow = typeof smsSendGateAudit.$inferSelect;
