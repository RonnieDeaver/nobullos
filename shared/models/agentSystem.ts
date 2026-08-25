import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, real, boolean, index, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";
import { clients } from "./clients";

export const agentIdentifierTypes = [
  "email", "domain", "phone", "slack_channel", "slack_name",
  "zoom_participant", "keyword", "phrase", "alias",
  "signature_fragment", "semantic_pattern_reference", "co_occurrence"
] as const;

export const agentMemorySources = ["seeded", "learned", "manual"] as const;

export const clientAgentMemory = pgTable("client_agent_memory", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  identifierType: varchar("identifier_type").notNull(),
  identifierValue: text("identifier_value").notNull(),
  source: varchar("source").notNull().default("seeded"),
  confidenceWeight: real("confidence_weight").default(1.0).notNull(),
  firstSeenAt: timestamp("first_seen_at").defaultNow(),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
  learnedFromMatchId: varchar("learned_from_match_id"),
  manuallyAdded: boolean("manually_added").default(false).notNull(),
  usageCount: integer("usage_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("client_agent_memory_client_id_idx").on(table.clientId),
  typeIdx: index("client_agent_memory_type_idx").on(table.identifierType),
  valueIdx: index("client_agent_memory_value_idx").on(table.identifierValue),
}));

export const insertClientAgentMemorySchema = createInsertSchema(clientAgentMemory).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  firstSeenAt: true,
  lastSeenAt: true,
});

export type InsertClientAgentMemory = z.infer<typeof insertClientAgentMemorySchema>;
export type ClientAgentMemory = typeof clientAgentMemory.$inferSelect;

export const agentMatchStatuses = ["claimed", "not_claimed", "ambiguous", "review_required"] as const;
export const agentEvidenceTypes = ["structured", "semantic", "mixed"] as const;
export const reviewResolutions = ["approved", "reassigned", "dismissed"] as const;
export const dismissReasons = ["not_relevant", "duplicate", "test_call", "other"] as const;
export type DismissReason = typeof dismissReasons[number];
export const dismissReasonLabels: Record<DismissReason, string> = {
  not_relevant: "Not relevant to any client",
  duplicate: "Duplicate of another call",
  test_call: "Test or internal call",
  other: "Other",
};

export const agentMatchDecisions = pgTable("agent_match_decisions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  communicationId: varchar("communication_id").notNull(),
  communicationType: varchar("communication_type").notNull(),
  sourceType: varchar("source_type"),
  // Task #995: nullable so MeetingApply / TranscriptApply / Zoom Reprocess
  // can enqueue `review_required` rows for recordings with no deterministic
  // candidate. Operators pick a client from the Review Queue UI, which then
  // sets `correctedToClientId` (or stamps the row as approved with that id).
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }),
  confidenceScore: real("confidence_score").notNull(),
  status: varchar("status").notNull(),
  explanationSummary: text("explanation_summary"),
  supportingSignalsJson: jsonb("supporting_signals_json"),
  semanticReasoningSummary: text("semantic_reasoning_summary"),
  evidenceType: varchar("evidence_type").notNull().default("structured"),
  candidateShortlistJson: jsonb("candidate_shortlist_json"),
  priorClientId: varchar("prior_client_id"),
  reviewReason: varchar("review_reason"),
  reviewResolution: varchar("review_resolution"),
  dismissReason: varchar("dismiss_reason"),
  dismissReasonNote: text("dismiss_reason_note"),
  reviewedAt: timestamp("reviewed_at"),
  reviewedByUserId: varchar("reviewed_by_user_id"),
  reviewedByHuman: boolean("reviewed_by_human").default(false).notNull(),
  correctedByHuman: boolean("corrected_by_human").default(false).notNull(),
  correctedToClientId: varchar("corrected_to_client_id"),
  reopenedAt: timestamp("reopened_at"),
  reopenedByUserId: varchar("reopened_by_user_id"),
  reopenCount: integer("reopen_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  commIdx: index("agent_match_decisions_comm_id_idx").on(table.communicationId),
  clientIdx: index("agent_match_decisions_client_id_idx").on(table.clientId),
  statusIdx: index("agent_match_decisions_status_idx").on(table.status),
  sourceStatusIdx: index("agent_match_decisions_source_status_idx").on(table.sourceType, table.status),
}));

export const insertAgentMatchDecisionSchema = createInsertSchema(agentMatchDecisions).omit({
  id: true,
  createdAt: true,
});

export type InsertAgentMatchDecision = z.infer<typeof insertAgentMatchDecisionSchema>;

// Task #4222 (F8 follow-up) — focused edit shape for updateAgentMatchDecision.
// An EDIT is a review action: status plus the human-review/correction and
// dismiss/review-resolution fields. Row id, the communication identity
// (communicationId/communicationType/sourceType), `clientId`,
// `confidenceScore` and the AI evidence columns stay out of caller control.
// Runtime-parsed in the storage method.
export const updateAgentMatchDecisionSchema = insertAgentMatchDecisionSchema
  .pick({
    status: true,
    explanationSummary: true,
    reviewedAt: true,
    reviewedByUserId: true,
    reviewedByHuman: true,
    correctedByHuman: true,
    correctedToClientId: true,
    reviewReason: true,
    reviewResolution: true,
    dismissReason: true,
    dismissReasonNote: true,
  })
  .partial();
export type UpdateAgentMatchDecision = z.infer<typeof updateAgentMatchDecisionSchema>;

export type AgentMatchDecision = typeof agentMatchDecisions.$inferSelect;

export const clientAgentChats = pgTable("client_agent_chats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  role: varchar("role").notNull(),
  content: text("content").notNull(),
  // Task #3721: the team member who sent this message. Stamped on new
  // user-role rows by the chat write route so the internal usage tracker
  // can count chat usage per member. Nullable — assistant rows and all
  // historical rows (pre-#3721) stay unattributed and count per client only.
  createdByUserId: varchar("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  clientIdx: index("client_agent_chats_client_id_idx").on(table.clientId),
  createdByIdx: index("client_agent_chats_created_by_idx").on(table.createdByUserId),
}));

export const insertClientAgentChatSchema = createInsertSchema(clientAgentChats).omit({
  id: true,
  createdAt: true,
});

export type InsertClientAgentChat = z.infer<typeof insertClientAgentChatSchema>;
export type ClientAgentChat = typeof clientAgentChats.$inferSelect;

export const knowledgeFactCategories = [
  "client_preference",
  "communication_pattern",
  "recurring_concern",
  "strategic_context",
  "relationship_insight",
  "behavioral_pattern",
  // Task #4292 — human-filed context/resolutions from the churn concern-intel
  // dialog, mirrored into the KB so the radar sweep and agent chat see what
  // operators already addressed. Source of record is client_concern_intel.
  "operator_intel",
] as const;
export type KnowledgeFactCategory = typeof knowledgeFactCategories[number];

export const knowledgeSourceAgents = [
  "daily_judgment",
  "communication_analysis",
  "communication_enrichment",
  "agent_chat",
  "manual",
] as const;
export type KnowledgeSourceAgent = typeof knowledgeSourceAgents[number];

export const agentKnowledgeBase = pgTable("agent_knowledge_base", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  factCategory: varchar("fact_category").notNull(),
  factText: text("fact_text").notNull(),
  confidence: real("confidence").default(0.7).notNull(),
  sourceAgent: varchar("source_agent").notNull(),
  sourceRecordId: varchar("source_record_id"),
  firstSeenAt: timestamp("first_seen_at").defaultNow(),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
  usageCount: integer("usage_count").default(1).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("agent_kb_client_id_idx").on(table.clientId),
  categoryIdx: index("agent_kb_category_idx").on(table.factCategory),
  clientCategoryIdx: index("agent_kb_client_category_idx").on(table.clientId, table.factCategory),
  sourceAgentIdx: index("agent_kb_source_agent_idx").on(table.sourceAgent),
  activeIdx: index("agent_kb_active_idx").on(table.isActive),
}));

export const insertAgentKnowledgeBaseSchema = createInsertSchema(agentKnowledgeBase).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  firstSeenAt: true,
  lastSeenAt: true,
});

export type InsertAgentKnowledgeBase = z.infer<typeof insertAgentKnowledgeBaseSchema>;

// Task #4222 (F8 follow-up) — focused edit shape for updateAgentKnowledgeEntry.
// Fact content/curation fields are caller-editable; `lastSeenAt` is re-added
// (the insert schema omits it) because re-observing a fact IS an edit.
// Row id, `clientId` (ownership) and source attribution
// (sourceAgent/sourceRecordId/firstSeenAt) stay out of caller control.
// Runtime-parsed in the storage method.
export const updateAgentKnowledgeEntrySchema = insertAgentKnowledgeBaseSchema
  .pick({ factCategory: true, factText: true, confidence: true, isActive: true, usageCount: true })
  .extend({ lastSeenAt: z.date() })
  .partial();
export type UpdateAgentKnowledgeEntry = z.infer<typeof updateAgentKnowledgeEntrySchema>;

export type AgentKnowledgeBase = typeof agentKnowledgeBase.$inferSelect;

export const feedbackTypes = ["confirmed", "corrected", "dismissed"] as const;
export type FeedbackType = typeof feedbackTypes[number];

export const agentFeedback = pgTable("agent_feedback", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentType: varchar("agent_type").notNull(),
  targetRecordId: varchar("target_record_id").notNull(),
  targetRecordType: varchar("target_record_type").notNull(),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }),
  feedbackType: varchar("feedback_type").notNull(),
  correctedValue: text("corrected_value"),
  userId: varchar("user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  agentTypeIdx: index("agent_feedback_agent_type_idx").on(table.agentType),
  targetIdx: index("agent_feedback_target_idx").on(table.targetRecordId),
  clientIdx: index("agent_feedback_client_id_idx").on(table.clientId),
  typeIdx: index("agent_feedback_type_idx").on(table.feedbackType),
}));

export const insertAgentFeedbackSchema = createInsertSchema(agentFeedback).omit({
  id: true,
  createdAt: true,
});

export type InsertAgentFeedback = z.infer<typeof insertAgentFeedbackSchema>;
export type AgentFeedback = typeof agentFeedback.$inferSelect;

export const operationalFilterIdentifierTypes = [
  "sender_email", "sender_domain", "subject_keyword", "subject_phrase",
  "content_pattern", "sender_name",
] as const;

export const operationalFilterSources = [
  "auto_dismissed", "user_dismissed", "user_blocked", "penalized",
] as const;

export const operationalFilterMemory = pgTable("operational_filter_memory", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  identifierType: varchar("identifier_type").notNull(),
  identifierValue: text("identifier_value").notNull(),
  source: varchar("source").notNull().default("auto_dismissed"),
  confidenceWeight: real("confidence_weight").default(0.5).notNull(),
  firstSeenAt: timestamp("first_seen_at").defaultNow(),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
  learnedFromId: varchar("learned_from_id"),
  usageCount: integer("usage_count").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  typeIdx: index("op_filter_mem_type_idx").on(table.identifierType),
  valueIdx: index("op_filter_mem_value_idx").on(table.identifierValue),
  typeValueIdx: index("op_filter_mem_type_value_idx").on(table.identifierType, table.identifierValue),
}));

export const insertOperationalFilterMemorySchema = createInsertSchema(operationalFilterMemory).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  firstSeenAt: true,
  lastSeenAt: true,
});

export type InsertOperationalFilterMemory = z.infer<typeof insertOperationalFilterMemorySchema>;
export type OperationalFilterMemory = typeof operationalFilterMemory.$inferSelect;

export const agentMatchSettingSources = ["default", "zoom"] as const;
export type AgentMatchSettingSource = typeof agentMatchSettingSources[number];

export const agentMatchSettingKeys = [
  "AGENT_CONFIDENCE_THRESHOLD",
  "AGENT_AMBIGUITY_GAP",
  "AGENT_THRESHOLD_EXACT",
  "AGENT_THRESHOLD_DOMAIN",
  "AGENT_THRESHOLD_HEURISTIC",
  "AGENT_THRESHOLD_SEMANTIC",
  "AGENT_THRESHOLD_MIXED",
  "AGENT_REVIEW_FLOOR",
  "ZOOM_TRANSCRIPT_CONTEXT_BUDGET",
  "ZOOM_SHORTLIST_MAX",
  "ZOOM_STRONG_SIGNAL_MIN_WEIGHT",
  "ZOOM_SHORT_TOKEN_MAX_LEN",
] as const;
export type AgentMatchSettingKey = typeof agentMatchSettingKeys[number];

export const agentMatchSettings = pgTable("agent_match_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  source: varchar("source").notNull().default("default"),
  settingKey: varchar("setting_key").notNull(),
  value: real("value").notNull(),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  uniqueSourceKey: unique("agent_match_settings_source_key_uq").on(table.source, table.settingKey),
}));

export const insertAgentMatchSettingSchema = createInsertSchema(agentMatchSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAgentMatchSetting = z.infer<typeof insertAgentMatchSettingSchema>;
export type AgentMatchSetting = typeof agentMatchSettings.$inferSelect;

export const agentMatchSettingHistory = pgTable("agent_match_setting_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  source: varchar("source").notNull(),
  settingKey: varchar("setting_key").notNull(),
  oldValue: real("old_value"),
  newValue: real("new_value"),
  changedBy: varchar("changed_by").references(() => users.id),
  changedAt: timestamp("changed_at").defaultNow().notNull(),
  slackStatus: varchar("slack_status"),
  emailStatus: varchar("email_status"),
  slackFailureReason: text("slack_failure_reason"),
  emailFailureReason: text("email_failure_reason"),
  // Trigger metadata for the most recent operator-initiated resend of this
  // alert. Populated by the generic resend guard; null until a resend occurs.
  lastResendAt: timestamp("last_resend_at"),
  lastResendBy: varchar("last_resend_by").references(() => users.id),
  lastResendSource: varchar("last_resend_source"),
  // When this history row was produced by restoring an earlier snapshot,
  // these reference the source row so the Change History UI can render a
  // "Restored from <date>" badge. Null for normal edits.
  restoreFromHistoryId: varchar("restore_from_history_id"),
  restoreFromChangedAt: timestamp("restore_from_changed_at"),
  // Task #672 — background auto-retry bookkeeping. Per-channel attempt
  // counts cap how many times the scheduler will re-broadcast a failed
  // delivery; `lastAutoRetryAt` drives the exponential backoff between
  // attempts. A successful initial dispatch resets these (counts stay 0).
  // A manual UI retry resets them so the auto-retry loop will pick up
  // again if the channel keeps failing.
  slackAttemptCount: integer("slack_attempt_count").default(0).notNull(),
  emailAttemptCount: integer("email_attempt_count").default(0).notNull(),
  lastAutoRetryAt: timestamp("last_auto_retry_at"),
  // Task #1137 — set the first time the auto-retry scheduler exhausts the
  // per-channel attempt budget on a row that still has at least one failed
  // channel. Drives the one-time admin "we gave up retrying" notification
  // so we don't re-spam every tick.
  autoRetryGiveupNotifiedAt: timestamp("auto_retry_giveup_notified_at"),
}, (table) => ({
  sourceKeyIdx: index("agent_match_setting_history_source_key_idx").on(table.source, table.settingKey),
  changedAtIdx: index("agent_match_setting_history_changed_at_idx").on(table.changedAt),
}));

export const insertAgentMatchSettingHistorySchema = createInsertSchema(agentMatchSettingHistory).omit({
  id: true,
  changedAt: true,
});

export type InsertAgentMatchSettingHistory = z.infer<typeof insertAgentMatchSettingHistorySchema>;
export type AgentMatchSettingHistory = typeof agentMatchSettingHistory.$inferSelect;

// Task #4202: the retired "Zoom comparative semantic" card's two orphaned
// tables (comparative_metrics_snapshots, comparative_metrics_daily_rollups)
// were dropped — declarations removed here; see
// migrations/20260810005717_drop_comparative_metrics_tables.sql.
