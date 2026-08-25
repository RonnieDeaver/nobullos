import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, real, boolean, index, unique, uniqueIndex, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";
import { clients } from "./clients";
import { rawCommunicationRecords } from "./communications";
import {
  accountHealthStatusOptions,
  relationshipReadOptions,
  type AccountHealthStatus,
  type RelationshipRead,
} from "../clientRating";

export const judgmentStatusOptions = accountHealthStatusOptions;
export type JudgmentStatus = AccountHealthStatus;

export const judgmentRelationshipOptions = relationshipReadOptions;
export type JudgmentRelationship = RelationshipRead;

export const judgmentConfidenceOptions = ["High", "Medium", "Low"] as const;
export type JudgmentConfidence = typeof judgmentConfidenceOptions[number];

export const clientDailyJudgments = pgTable("client_daily_judgments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  judgmentDate: varchar("judgment_date").notNull(),
  status: varchar("status").notNull(),
  relationshipHealth: varchar("relationship_health"),
  confidence: varchar("confidence").default("Medium"),
  overallSentiment: real("overall_sentiment"),
  sentimentTrend: varchar("sentiment_trend"),
  headline: text("headline"),
  narrativeSummary: text("narrative_summary"),
  keyRisks: jsonb("key_risks"),
  keyOpportunities: jsonb("key_opportunities"),
  unresolvedAskCount: integer("unresolved_ask_count").default(0),
  communicationsAnalyzed: integer("communications_analyzed").default(0),
  dataSourcesSummary: jsonb("data_sources_summary"),
  overallStatus: varchar("overall_status"),
  relationshipStatus: varchar("relationship_status"),
  confidenceLevel: varchar("confidence_level"),
  summaryText: text("summary_text"),
  sentimentSummary: text("sentiment_summary"),
  changeSummary: text("change_summary"),
  concernsJson: jsonb("concerns_json"),
  unresolvedAsksJson: jsonb("unresolved_asks_json"),
  winsJson: jsonb("wins_json"),
  actionsJson: jsonb("actions_json"),
  relationshipHealthScore: real("relationship_health_score"),
  sentimentScore: real("sentiment_score"),
  complaintScore: real("complaint_score"),
  riskScore: real("risk_score"),
  generatedFromStartAt: timestamp("generated_from_start_at"),
  generatedFromEndAt: timestamp("generated_from_end_at"),
  modelVersion: varchar("model_version"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("client_daily_judgments_client_id_idx").on(table.clientId),
  dateIdx: index("client_daily_judgments_date_idx").on(table.judgmentDate),
  statusIdx: index("client_daily_judgments_status_idx").on(table.status),
  clientDateIdx: index("client_daily_judgments_client_date_idx").on(table.clientId, table.judgmentDate),
  uniqueClientDate: unique().on(table.clientId, table.judgmentDate),
}));

export const insertClientDailyJudgmentSchema = createInsertSchema(clientDailyJudgments, {
  status: z.enum(judgmentStatusOptions),
  relationshipHealth: z.enum(judgmentRelationshipOptions).nullable().optional(),
  confidence: z.enum(judgmentConfidenceOptions).optional(),
  sentimentTrend: z.enum(["improving", "stable", "declining"]).nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertClientDailyJudgment = z.infer<typeof insertClientDailyJudgmentSchema>;
export type ClientDailyJudgment = typeof clientDailyJudgments.$inferSelect;

export const clientCommunicationInsights = pgTable("client_communication_insights", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  rawCommunicationRecordId: varchar("raw_communication_record_id").references(() => rawCommunicationRecords.id, { onDelete: "cascade" }).notNull(),
  overallSentiment: real("overall_sentiment"),
  sentimentTrend: varchar("sentiment_trend"),
  perPersonSentiment: jsonb("per_person_sentiment"),
  trustLevel: real("trust_level"),
  urgencyLevel: real("urgency_level"),
  frustrationLevel: real("frustration_level"),
  gratitudeLevel: real("gratitude_level"),
  confusionLevel: real("confusion_level"),
  disappointmentLevel: real("disappointment_level"),
  complaintThemes: jsonb("complaint_themes"),
  extractedAsks: jsonb("extracted_asks"),
  extractedPromises: jsonb("extracted_promises"),
  enrichmentModel: varchar("enrichment_model"),
  enrichedAt: timestamp("enriched_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  clientIdx: index("client_comm_insights_client_id_idx").on(table.clientId),
  commIdx: index("client_comm_insights_comm_id_idx").on(table.rawCommunicationRecordId),
  uniqueCommRecord: unique("client_comm_insights_unique_comm").on(table.rawCommunicationRecordId),
}));

export const insertClientCommunicationInsightSchema = createInsertSchema(clientCommunicationInsights).omit({
  id: true,
  createdAt: true,
});

export type InsertClientCommunicationInsight = z.infer<typeof insertClientCommunicationInsightSchema>;
export type ClientCommunicationInsight = typeof clientCommunicationInsights.$inferSelect;

export const clientRelationshipSignals = pgTable("client_relationship_signals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  signalDate: varchar("signal_date").notNull(),
  judgmentId: varchar("judgment_id").references(() => clientDailyJudgments.id, { onDelete: "cascade" }),
  avgTrust: real("avg_trust"),
  avgUrgency: real("avg_urgency"),
  avgFrustration: real("avg_frustration"),
  avgGratitude: real("avg_gratitude"),
  avgConfusion: real("avg_confusion"),
  avgDisappointment: real("avg_disappointment"),
  overallSentiment: real("overall_sentiment"),
  sentimentTrend: varchar("sentiment_trend"),
  communicationCount: integer("communication_count").default(0),
  topComplaintThemes: jsonb("top_complaint_themes"),
  relationshipHealthScore: real("relationship_health_score"),
  sentimentScore: real("sentiment_score"),
  complaintScore: real("complaint_score"),
  trustScore: real("trust_score"),
  responsivenessRiskScore: real("responsiveness_risk_score"),
  executionRiskScore: real("execution_risk_score"),
  leadVolumeConcernScore: real("lead_volume_concern_score"),
  unresolvedTaskScore: real("unresolved_task_score"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  clientIdx: index("client_relationship_signals_client_id_idx").on(table.clientId),
  dateIdx: index("client_relationship_signals_date_idx").on(table.signalDate),
  clientDateIdx: index("client_relationship_signals_client_date_idx").on(table.clientId, table.signalDate),
  uniqueClientDate: unique().on(table.clientId, table.signalDate),
}));

export const insertClientRelationshipSignalSchema = createInsertSchema(clientRelationshipSignals).omit({
  id: true,
  createdAt: true,
});

export type InsertClientRelationshipSignal = z.infer<typeof insertClientRelationshipSignalSchema>;
export type ClientRelationshipSignal = typeof clientRelationshipSignals.$inferSelect;

export const openAskStatusOptions = ["open", "likely_open", "likely_resolved", "resolved", "dismissed"] as const;
export type OpenAskStatus = typeof openAskStatusOptions[number];

// Task #4765 — the ONE active-set definition every reader (judgment prompt,
// rollup/digest, churn radar, enrichment dedup, decay) must share. "Active"
// = still-unresolved for display/evidence. "Sweepable" additionally includes
// likely_resolved: the hindsight sweep + dedup must still see rows parked
// there so they either resolve with evidence or reopen instead of stranding.
export const openAskActiveStatuses = ["open", "likely_open"] as const;
export const openAskSweepableStatuses = ["open", "likely_open", "likely_resolved"] as const;
export function isActiveAskStatus(status: string): boolean {
  return (openAskActiveStatuses as readonly string[]).includes(status);
}

export const clientOpenAsks = pgTable("client_open_asks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  askType: varchar("ask_type").notNull(),
  askText: text("ask_text"),
  askCategory: varchar("ask_category"),
  summary: text("summary").notNull(),
  detail: text("detail"),
  status: varchar("status").default("open").notNull(),
  concernScore: real("concern_score").default(1.0),
  confidence: real("confidence"),
  firstMentionedAt: timestamp("first_mentioned_at").defaultNow(),
  lastReferencedAt: timestamp("last_referenced_at").defaultNow(),
  mentionCount: integer("mention_count").default(1),
  sourceType: varchar("source_type"),
  sourceRecordId: varchar("source_record_id"),
  sourceRecordIds: text("source_record_ids").array(),
  createdFromTimestamp: timestamp("created_from_timestamp"),
  requestedBy: varchar("requested_by"),
  assignedTo: varchar("assigned_to"),
  likelyResolved: boolean("likely_resolved").default(false),
  likelyResolvedAt: timestamp("likely_resolved_at"),
  relatedPromiseText: text("related_promise_text"),
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: varchar("resolved_by").references(() => users.id),
  resolutionNote: text("resolution_note"),
  // Task #4765 — hindsight-sweep checkpoint: stamped when the full-history
  // closure evaluator has judged this row (any disposition, incl. still-live).
  // NULL = not yet groomed; the retro-groom prod action converges on this.
  hindsightCheckedAt: timestamp("hindsight_checked_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("client_open_asks_client_id_idx").on(table.clientId),
  statusIdx: index("client_open_asks_status_idx").on(table.status),
  clientStatusIdx: index("client_open_asks_client_status_idx").on(table.clientId, table.status),
  // Task #4765 — burst-race backstop: two concurrent extractions of the
  // byte-identical ask physically cannot double-insert while one is still
  // in a sweepable status. Semantic near-duplicates are handled above the
  // DB by the shared creation helper (advisory-lock re-check + AI match).
  // Rollout history (Task #4803 follow-on → Task #4811): this entry was
  // temporarily staged OUT of the model on 2026-08-14 because production
  // held pre-existing duplicate active rows that Publish (schema-only)
  // could not dedup; the enable_open_ask_dedup_constraint prod action
  // merged them and built the index in production the same day, and the
  // entry is re-anchored here with idempotent migration 20260814211021
  // re-creating the index wherever it is still missing.
  activeSummaryUniq: uniqueIndex("client_open_asks_active_summary_uniq")
    .on(table.clientId, sql`md5(lower(btrim(${table.summary})))`)
    .where(sql`status IN ('open', 'likely_open', 'likely_resolved')`),
}));

export const insertClientOpenAskSchema = createInsertSchema(clientOpenAsks, {
  askType: z.enum(["client_ask", "internal_promise"]),
  status: z.enum(openAskStatusOptions).optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
});

export type InsertClientOpenAsk = z.infer<typeof insertClientOpenAskSchema>;

// Task #4222 (F8 follow-up) — focused edit shape for updateClientOpenAsk.
// Status/resolution/recurrence-tracking fields are caller-editable;
// `resolvedAt` is re-added (the insert schema omits it) because resolving
// IS the edit. Row id, `clientId` (ownership), the ask identity/content
// columns (askType/askText/summary/detail/source*) and createdAt/updatedAt
// stay out of caller control. Runtime-parsed in the storage method.
export const updateClientOpenAskSchema = insertClientOpenAskSchema
  .pick({
    status: true,
    resolutionNote: true,
    resolvedBy: true,
    likelyResolved: true,
    likelyResolvedAt: true,
    lastReferencedAt: true,
    concernScore: true,
    mentionCount: true,
    sourceRecordIds: true,
    hindsightCheckedAt: true,
  })
  .extend({ resolvedAt: z.date().nullable() })
  .partial();
export type UpdateClientOpenAsk = z.infer<typeof updateClientOpenAskSchema>;

export type ClientOpenAsk = typeof clientOpenAsks.$inferSelect;

// ─── Task #3696 — Save plays (churn interventions) ─────────────────────────
// An accountable intervention on a client: when a client is At Risk or
// Critical, the team opens a "save play" with an owner and a due date —
// manually or pre-filled from a daily judgment's recommended action.
// Status flow: active → completed | abandoned (outcome_note records what
// happened; closed plays keep their history for post-mortems).

export const savePlayStatusOptions = ["active", "completed", "abandoned"] as const;
export type SavePlayStatus = typeof savePlayStatusOptions[number];

export const clientSavePlays = pgTable("client_save_plays", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  why: text("why"),
  sourceJudgmentId: varchar("source_judgment_id").references(() => clientDailyJudgments.id, { onDelete: "set null" }),
  assignedToUserId: varchar("assigned_to_user_id").references(() => users.id).notNull(),
  dueDate: date("due_date").notNull(),
  status: varchar("status").default("active").notNull(),
  notes: text("notes"),
  outcomeNote: text("outcome_note"),
  createdByUserId: varchar("created_by_user_id").references(() => users.id),
  closedAt: timestamp("closed_at"),
  closedByUserId: varchar("closed_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("client_save_plays_client_id_idx").on(table.clientId),
  statusIdx: index("client_save_plays_status_idx").on(table.status),
  clientStatusIdx: index("client_save_plays_client_status_idx").on(table.clientId, table.status),
  assignedIdx: index("client_save_plays_assigned_to_idx").on(table.assignedToUserId),
}));

export const insertClientSavePlaySchema = createInsertSchema(clientSavePlays, {
  title: z.string().trim().min(1, "Title is required"),
  status: z.enum(savePlayStatusOptions).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dueDate must be YYYY-MM-DD"),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  closedAt: true,
  closedByUserId: true,
});

export type InsertClientSavePlay = z.infer<typeof insertClientSavePlaySchema>;

// Task #4222 (F8 follow-up) — focused edit shape for updateClientSavePlay.
// The route-editable fields (mirroring the PATCH route's own zod schema)
// plus the close bookkeeping pair (`closedAt`/`closedByUserId`, re-added —
// the insert schema omits them) which the route stamps server-side on a
// status transition. Row id, `clientId` (ownership), `sourceJudgmentId`
// and `createdByUserId` (attribution) stay out of caller control.
// Runtime-parsed in the storage method.
export const updateClientSavePlaySchema = insertClientSavePlaySchema
  .pick({
    title: true,
    why: true,
    assignedToUserId: true,
    dueDate: true,
    status: true,
    notes: true,
    outcomeNote: true,
  })
  .extend({
    closedAt: z.date().nullable(),
    closedByUserId: z.string().nullable(),
  })
  .partial();
export type UpdateClientSavePlay = z.infer<typeof updateClientSavePlaySchema>;

export type ClientSavePlay = typeof clientSavePlays.$inferSelect;

// ── Task #4292 — operator concern intel ─────────────────────────────────────
// Append-only log of operator responses to judgment concerns ("Add context" /
// "Mark resolved" + note). Written from the Churn Command Center leaderboard,
// read back into every future judgment for the client (last 90d) and matched
// to displayed concerns by normalized text. `judgmentId` is a plain varchar
// (NOT an FK): intel must outlive the judgment row it was filed against —
// judgments are superseded daily and concern text is what carries meaning.
export const concernIntelTypes = ["context", "resolved"] as const;
export type ConcernIntelType = typeof concernIntelTypes[number];

export const clientConcernIntel = pgTable("client_concern_intel", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  judgmentId: varchar("judgment_id"),
  concernText: text("concern_text").notNull(),
  intelType: varchar("intel_type").notNull(),
  note: text("note").notNull(),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  // Both read paths (leaderboard embed + judgment build) are
  // "client_id = ? AND created_at >= ? ORDER BY created_at DESC" —
  // exact prefix match on this composite.
  clientCreatedIdx: index("client_concern_intel_client_created_idx").on(table.clientId, table.createdAt),
}));

export const insertClientConcernIntelSchema = createInsertSchema(clientConcernIntel, {
  concernText: z.string().trim().min(1, "Concern text is required").max(500),
  intelType: z.enum(concernIntelTypes),
  note: z.string().trim().min(1, "Note is required").max(2000),
}).omit({
  id: true,
  createdAt: true,
});

export type InsertClientConcernIntel = z.infer<typeof insertClientConcernIntelSchema>;
export type ClientConcernIntel = typeof clientConcernIntel.$inferSelect;

export const judgmentOverallStatuses = ["Healthy", "Watch", "At Risk", "Critical"] as const;
export type JudgmentOverallStatus = typeof judgmentOverallStatuses[number];

export const judgmentRelationshipStatuses = ["Strong", "Stable", "Strained", "At Risk"] as const;
export type JudgmentRelationshipStatus = typeof judgmentRelationshipStatuses[number];

export const judgmentConfidenceLevels = ["High", "Medium", "Low"] as const;
export type JudgmentConfidenceLevel = typeof judgmentConfidenceLevels[number];

export const openAskStatuses = ["open", "likely_open", "likely_resolved", "resolved", "dismissed"] as const;
