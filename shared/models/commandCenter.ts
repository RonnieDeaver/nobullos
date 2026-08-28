import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, real, integer, boolean, index, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";
import { clients } from "./clients";
import { rawCommunicationRecords } from "./communications";

export const commandPanelProductOptions = ["gbp", "google_ads", "lsa", "webinar"] as const;
export type CommandPanelProductOption = typeof commandPanelProductOptions[number];

export const bottleneckOptions = [
  "intake_capacity", "sales_conversion", "lead_volume", "budget_constraints",
  "staffing", "market_saturation", "tracking_gaps", "creative_fatigue", "other"
] as const;
export type BottleneckOption = typeof bottleneckOptions[number];

export const budgetPostureOptions = ["aggressive", "moderate", "conservative", "scaling_back", "paused"] as const;
export type BudgetPostureOption = typeof budgetPostureOptions[number];

export const commandPanels = pgTable("command_panels", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id).notNull().unique(),
  accountOwnerId: varchar("account_owner_id").references(() => users.id),
  secondaryOwnerIds: text("secondary_owner_ids").array(),
  productTypes: text("product_types").array(),
  productStatusNotes: text("product_status_notes"),
  googleAdsBudget: real("google_ads_budget"),
  webinarBudget: real("webinar_budget"),
  lsaBudget: real("lsa_budget"),
  gbpPlannedLocationCount: integer("gbp_planned_location_count"),
  gbpPlannedLocationCities: text("gbp_planned_location_cities").array(),
  quarterPrimaryObjective: text("quarter_primary_objective"),
  annualGoals: text("annual_goals"),
  longTermGoals: text("long_term_goals"),
  successDefinitionQuarter: text("success_definition_quarter"),
  growthStrategy: text("growth_strategy"),
  currentBottleneck: varchar("current_bottleneck"),
  budgetPosture: varchar("budget_posture"),
  approvedTerritory: text("approved_territory"),
  priorityMarkets: jsonb("priority_markets"),
  secondaryMarkets: jsonb("secondary_markets"),
  annualRevenueGoal: real("annual_revenue_goal"),
  onboardingNotes: text("onboarding_notes"),
  geographicExpansionNotes: text("geographic_expansion_notes"),
  googleAdsTargetAreas: text("google_ads_target_areas").array(),
  googleAdsTargetingMethod: text("google_ads_targeting_method"),
  googleAdsExcludedAreas: text("google_ads_excluded_areas"),
  googleAdsGeoNotes: text("google_ads_geo_notes"),
  webinarTargetAreas: text("webinar_target_areas").array(),
  webinarGeoNotes: text("webinar_geo_notes"),
  activeCampaignFocus: text("active_campaign_focus"),
  activeOffers: text("active_offers"),
  keyActiveInitiatives: text("key_active_initiatives"),
  currentRiskFlags: text("current_risk_flags"),
  currentOpportunities: text("current_opportunities"),
  clientPreferences: text("client_preferences"),
  internalHandlingNotes: text("internal_handling_notes"),
  googleDriveFolderLink: text("google_drive_folder_link"),
  googleDriveFolderName: text("google_drive_folder_name"),
  zoomRecordingsFolderId: text("zoom_recordings_folder_id"),
  zoomRecordingsFolderLink: text("zoom_recordings_folder_link"),
  zoomRecordingsFolderName: text("zoom_recordings_folder_name"),
  rerReportsFolderId: text("rer_reports_folder_id"),
  rerReportsFolderLink: text("rer_reports_folder_link"),
  rerReportsFolderName: text("rer_reports_folder_name"),
  // Auto-created "Call Recordings" / "Call Transcripts" subfolders inside
  // googleDriveFolderLink, populated lazily by callArchivePipeline.
  callRecordingsSubfolderId: text("call_recordings_subfolder_id"),
  callTranscriptsSubfolderId: text("call_transcripts_subfolder_id"),
  externalSystemLinks: jsonb("external_system_links"),
  lastReviewedAt: timestamp("last_reviewed_at"),
  lastReviewedBy: varchar("last_reviewed_by").references(() => users.id),
  lastUpdatedAt: timestamp("last_updated_at").defaultNow(),
  lastUpdatedBy: varchar("last_updated_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  clientIdx: index("command_panels_client_id_idx").on(table.clientId),
}));

export const insertCommandPanelSchema = createInsertSchema(commandPanels, {
  currentBottleneck: z.union([z.enum(bottleneckOptions), z.string().startsWith("other:")]).nullable().optional(),
  budgetPosture: z.enum(budgetPostureOptions).nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
});

export type InsertCommandPanel = z.infer<typeof insertCommandPanelSchema>;
export type CommandPanel = typeof commandPanels.$inferSelect;

// PUT /api/clients/:clientId/command-panel — the operator-editable subset of
// panel fields (audit A-007). Derived from the insert schema so field types
// and enum refinements stay in lockstep with the entity. Omits server-managed
// columns: clientId comes from the URL, the review/update stamps are written
// by the server, and the call-archive subfolder ids are populated lazily by
// callArchivePipeline. All fields optional (partial update); nullable columns
// accept explicit null to clear; unknown keys are stripped by Zod, so nothing
// outside this whitelist can reach persistence.
export const updateCommandPanelSchema = insertCommandPanelSchema
  .omit({
    clientId: true,
    callRecordingsSubfolderId: true,
    callTranscriptsSubfolderId: true,
    lastReviewedAt: true,
    lastReviewedBy: true,
    lastUpdatedAt: true,
    lastUpdatedBy: true,
  })
  .partial();

export type UpdateCommandPanel = z.infer<typeof updateCommandPanelSchema>;

// Full request body for that PUT endpoint: the panel fields plus the optional
// audit `reason` recorded on command_panel_history / command_panel_versions
// rows (not a panel column itself).
export const updateCommandPanelRequestSchema = updateCommandPanelSchema.extend({
  reason: z.string().nullable().optional(),
});

export const keyCallTypes = ["discovery", "demo", "onboarding", "handoff"] as const;

export const commandPanelKeyCalls = pgTable("command_panel_key_calls", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  commandPanelId: varchar("command_panel_id").references(() => commandPanels.id, { onDelete: "cascade" }).notNull(),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  callType: varchar("call_type").notNull(),
  rawCommunicationRecordId: varchar("raw_communication_record_id").references(() => rawCommunicationRecords.id, { onDelete: "set null" }),
  assignedBy: varchar("assigned_by").references(() => users.id),
  assignedAt: timestamp("assigned_at").defaultNow(),
}, (table) => ({
  clientIdx: index("key_calls_client_id_idx").on(table.clientId),
  uniqueCallType: unique("key_calls_panel_call_type_uq").on(table.commandPanelId, table.callType),
}));

export const insertCommandPanelKeyCallSchema = createInsertSchema(commandPanelKeyCalls, {
  callType: z.enum(keyCallTypes),
}).omit({
  id: true,
  assignedAt: true,
});

export type InsertCommandPanelKeyCall = z.infer<typeof insertCommandPanelKeyCallSchema>;
export type CommandPanelKeyCall = typeof commandPanelKeyCalls.$inferSelect;

// POST /api/clients/:clientId/command-panel/key-calls request body (audit
// A-007) — the caller supplies only the call slot and, optionally, the
// recording to link; commandPanelId/clientId/assignedBy come from the URL and
// session. Picked from the insert schema so callType stays pinned to
// keyCallTypes.
export const assignCommandPanelKeyCallRequestSchema = insertCommandPanelKeyCallSchema.pick({
  callType: true,
  rawCommunicationRecordId: true,
});

export const commandPanelRerRecordings = pgTable("command_panel_rer_recordings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  commandPanelId: varchar("command_panel_id").references(() => commandPanels.id, { onDelete: "cascade" }).notNull(),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  rawCommunicationRecordId: varchar("raw_communication_record_id").references(() => rawCommunicationRecords.id, { onDelete: "cascade" }).notNull(),
  reportingMonth: varchar("reporting_month").notNull(),
  assignedBy: varchar("assigned_by").references(() => users.id),
  assignedAt: timestamp("assigned_at").defaultNow(),
}, (table) => ({
  clientIdx: index("rer_recordings_client_id_idx").on(table.clientId),
  monthIdx: index("rer_recordings_month_idx").on(table.clientId, table.reportingMonth),
  uniqueClientRecordingMonth: unique("rer_recordings_client_recording_month_uq").on(
    table.clientId,
    table.rawCommunicationRecordId,
    table.reportingMonth,
  ),
}));

export const insertCommandPanelRerRecordingSchema = createInsertSchema(commandPanelRerRecordings).omit({
  id: true,
  assignedAt: true,
});

export type InsertCommandPanelRerRecording = z.infer<typeof insertCommandPanelRerRecordingSchema>;
export type CommandPanelRerRecording = typeof commandPanelRerRecordings.$inferSelect;

// POST /api/clients/:clientId/command-panel/rer-recordings request body
// (audit A-007) — both ids must arrive as non-empty strings; surrounding
// whitespace is trimmed exactly like the pre-Zod handler did.
export const assignCommandPanelRerRecordingRequestSchema = z.object({
  rawCommunicationRecordId: z.string().trim().min(1),
  reportingMonth: z.string().trim().min(1),
});

export const commandPanelVersions = pgTable("command_panel_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id).notNull(),
  fieldName: varchar("field_name").notNull(),
  previousValue: text("previous_value"),
  newValue: text("new_value"),
  changedBy: varchar("changed_by").references(() => users.id).notNull(),
  changedAt: timestamp("changed_at").defaultNow(),
  sourceReference: text("source_reference"),
  changeReason: text("change_reason"),
}, (table) => ({
  clientIdx: index("command_panel_versions_client_id_idx").on(table.clientId),
  changedByIdx: index("command_panel_versions_changed_by_idx").on(table.changedBy),
}));

export const insertCommandPanelVersionSchema = createInsertSchema(commandPanelVersions).omit({
  id: true,
  changedAt: true,
});

export type InsertCommandPanelVersion = z.infer<typeof insertCommandPanelVersionSchema>;
export type CommandPanelVersion = typeof commandPanelVersions.$inferSelect;

export const commandPanelHistory = pgTable("command_panel_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  commandPanelId: varchar("command_panel_id").references(() => commandPanels.id).notNull(),
  clientId: varchar("client_id").references(() => clients.id).notNull(),
  fieldName: varchar("field_name").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedBy: varchar("changed_by").references(() => users.id).notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  panelIdx: index("command_panel_history_panel_idx").on(table.commandPanelId),
  clientIdx: index("command_panel_history_client_idx").on(table.clientId),
}));

export const insertCommandPanelHistorySchema = createInsertSchema(commandPanelHistory).omit({
  id: true,
  createdAt: true,
});

export type InsertCommandPanelHistory = z.infer<typeof insertCommandPanelHistorySchema>;
export type CommandPanelHistory = typeof commandPanelHistory.$inferSelect;

export const intelligenceEntryTypes = [
  "strategy_insight", "client_preference", "meeting_takeaway", "goal_change",
  "risk", "opportunity", "relationship_note", "internal_observation",
  "competitive_context", "escalation", "win_progress", "priority_shift",
  "budget_context", "product_context"
] as const;
export type IntelligenceEntryType = typeof intelligenceEntryTypes[number];

// "draft" was retired (Task #3713): intel notes publish immediately on
// create. The stored value for published entries stays "approved" (UI copy
// says "Published"); rows are flipped by migration 0146.
export const intelligenceEntryStatuses = ["approved", "archived"] as const;
export type IntelligenceEntryStatus = typeof intelligenceEntryStatuses[number];

export const intelligenceConfidenceLevels = ["high", "medium", "low"] as const;
export type IntelligenceConfidenceLevel = typeof intelligenceConfidenceLevels[number];

export const intelligenceFeedEntries = pgTable("intelligence_feed_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id).notNull(),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  entryType: varchar("entry_type").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  tags: text("tags").array(),
  sourceReferences: jsonb("source_references"),
  aiConfidence: varchar("ai_confidence"),
  status: varchar("status").default("approved").notNull(),
  pinned: boolean("pinned").default(false).notNull(),
  linkedActionLogIds: text("linked_action_log_ids").array(),
  linkedCommandPanelFields: text("linked_command_panel_fields").array(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("intelligence_feed_client_id_idx").on(table.clientId),
  createdByIdx: index("intelligence_feed_created_by_idx").on(table.createdBy),
}));

export const insertIntelligenceFeedEntrySchema = createInsertSchema(intelligenceFeedEntries, {
  entryType: z.enum(intelligenceEntryTypes),
  status: z.enum(intelligenceEntryStatuses).default("approved"),
  aiConfidence: z.enum(intelligenceConfidenceLevels).nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateIntelligenceFeedEntrySchema = insertIntelligenceFeedEntrySchema
  .omit({ clientId: true, createdBy: true })
  .partial();
export type UpdateIntelligenceFeedEntry = z.infer<typeof updateIntelligenceFeedEntrySchema>;

export type InsertIntelligenceFeedEntry = z.infer<typeof insertIntelligenceFeedEntrySchema>;
export type IntelligenceFeedEntry = typeof intelligenceFeedEntries.$inferSelect;

export const actionLogActionTypes = [
  "campaign_launched", "campaign_paused", "budget_increased", "budget_reduced",
  "geo_expansion", "geo_deprioritized", "service_focus_changed",
  "landing_page_launched", "intake_workflow_updated", "tracking_changed",
  "crm_workflow_changed", "new_offer_introduced", "creative_refreshed",
  "copy_refreshed", "review_generation_launched", "reporting_change",
  "product_added", "product_removed", "product_paused",
  "webinar_launched", "webinar_paused", "major_escalation_handled", "other"
] as const;
export type ActionLogActionType = typeof actionLogActionTypes[number];

export const actionLogImpactedSystems = [
  "gbp", "google_ads", "lsa", "webinar", "website", "crm",
  "analytics", "reporting", "billing", "communications",
  "social_media", "email_marketing", "review_generation", "call_tracking",
] as const;
export type ActionLogImpactedSystem = typeof actionLogImpactedSystems[number];

export const actionLogEntries = pgTable("action_log_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id).notNull(),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  actionType: varchar("action_type").notNull(),
  title: text("title").notNull(),
  whatChanged: text("what_changed"),
  whyChanged: text("why_changed"),
  impactedSystems: text("impacted_systems").array(),
  relatedObjective: text("related_objective"),
  relatedProductType: text("related_product_type"),
  relatedCampaign: text("related_campaign"),
  sourceReferences: jsonb("source_references"),
  rollbackNote: text("rollback_note"),
  linkedIntelligenceEntryIds: text("linked_intelligence_entry_ids").array(),
  linkedCommandPanelFields: text("linked_command_panel_fields").array(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("action_log_client_id_idx").on(table.clientId),
  createdByIdx: index("action_log_created_by_idx").on(table.createdBy),
}));

export const insertActionLogEntrySchema = createInsertSchema(actionLogEntries, {
  actionType: z.enum(actionLogActionTypes),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateActionLogEntrySchema = insertActionLogEntrySchema
  .omit({ clientId: true, createdBy: true })
  .partial();
export type UpdateActionLogEntry = z.infer<typeof updateActionLogEntrySchema>;

export type InsertActionLogEntry = z.infer<typeof insertActionLogEntrySchema>;
export type ActionLogEntry = typeof actionLogEntries.$inferSelect;
