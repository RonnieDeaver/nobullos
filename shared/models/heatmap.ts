import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, boolean, doublePrecision, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { clients, clientLocations } from "./clients";

export const heatmapGridTemplates = ["5x5", "7x7", "9x9", "11x11", "13x13", "15x15"] as const;
export const heatmapGridUnits = ["MILES", "KM"] as const;
export const heatmapMarketTypes = ["small", "standard", "large_metro"] as const;

export const heatmapSnapshots = pgTable("heatmap_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id),
  locationId: text("location_id").notNull(),
  locationName: text("location_name").notNull(),
  businessName: text("business_name"),
  campaignId: text("campaign_id").notNull(),
  keywordId: text("keyword_id"),
  keywordName: text("keyword_name").notNull(),
  reportDate: timestamp("report_date").notNull(),
  businessLat: doublePrecision("business_lat").notNull(),
  businessLng: doublePrecision("business_lng").notNull(),
  gridTemplate: text("grid_template").notNull(),
  gridUnit: text("grid_unit").notNull(),
  gridDistance: doublePrecision("grid_distance").notNull(),
  baseLat: doublePrecision("base_lat").notNull(),
  baseLng: doublePrecision("base_lng").notNull(),
  pointsNumber: integer("points_number"),
  shareOfVoiceRaw: doublePrecision("share_of_voice_raw"),
  rawPayload: jsonb("raw_payload").notNull(),
  geojsonCache: jsonb("geojson_cache"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  locationIdx: index("heatmap_snapshots_location_id_idx").on(table.locationId),
  reportDateIdx: index("heatmap_snapshots_report_date_idx").on(table.reportDate),
  campaignIdx: index("heatmap_snapshots_campaign_id_idx").on(table.campaignId),
  clientIdx: index("heatmap_snapshots_client_id_idx").on(table.clientId),
  compoundIdx: index("heatmap_snapshots_client_loc_camp_date_idx").on(table.clientId, table.locationId, table.campaignId, table.reportDate),
  // Task #1241: DB-level guard mirroring `normalizeKeyword` in
  // shared/keywordNormalization.ts. Keep in lockstep with migration 0061.
  keywordNameCanonicalChk: check(
    "heatmap_snapshots_keyword_name_canonical_chk",
    sql`${table.keywordName} = lower(regexp_replace(btrim(${table.keywordName}), '\\s+', ' ', 'g'))`,
  ),
}));

export const insertHeatmapSnapshotSchema = createInsertSchema(heatmapSnapshots, {
  gridTemplate: z.enum(heatmapGridTemplates),
  gridUnit: z.enum(heatmapGridUnits),
}).omit({
  id: true,
  createdAt: true,
  geojsonCache: true,
});

export type InsertHeatmapSnapshot = z.infer<typeof insertHeatmapSnapshotSchema>;
export type HeatmapSnapshot = typeof heatmapSnapshots.$inferSelect;

export const heatmapPoints = pgTable("heatmap_points", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  snapshotId: varchar("snapshot_id").references(() => heatmapSnapshots.id, { onDelete: "cascade" }).notNull(),
  pointId: text("point_id").notNull(),
  pointIndex: integer("point_index"),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  position: integer("position"),
  diff: integer("diff"),
  isEnabled: boolean("is_enabled").default(true),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  snapshotIdx: index("heatmap_points_snapshot_id_idx").on(table.snapshotId),
}));

export const insertHeatmapPointSchema = createInsertSchema(heatmapPoints).omit({
  id: true,
  createdAt: true,
});

export type InsertHeatmapPoint = z.infer<typeof insertHeatmapPointSchema>;
export type HeatmapPoint = typeof heatmapPoints.$inferSelect;

export const heatmapMetrics = pgTable("heatmap_metrics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  snapshotId: varchar("snapshot_id").references(() => heatmapSnapshots.id, { onDelete: "cascade" }).notNull(),
  avgRank: doublePrecision("avg_rank"),
  medianRank: doublePrecision("median_rank"),
  bestRank: integer("best_rank"),
  worstRank: integer("worst_rank"),
  top3CoveragePct: doublePrecision("top_3_coverage_pct"),
  top10CoveragePct: doublePrecision("top_10_coverage_pct"),
  rankedPointsCount: integer("ranked_points_count"),
  unrankedPointsCount: integer("unranked_points_count"),
  shareOfVoice90dAvg: doublePrecision("share_of_voice_90d_avg"),
  shareOfVoiceAnchorIncrease: doublePrecision("share_of_voice_anchor_increase"),
  bandTop3Pct: doublePrecision("band_top_3_pct"),
  band4to10Pct: doublePrecision("band_4_to_10_pct"),
  band11to20Pct: doublePrecision("band_11_to_20_pct"),
  bandOutOfTop20Pct: doublePrecision("band_out_of_top_20_pct"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  snapshotIdx: index("heatmap_metrics_snapshot_id_idx").on(table.snapshotId),
}));

export type HeatmapMetric = typeof heatmapMetrics.$inferSelect;

export const heatmapOverrides = pgTable("heatmap_overrides", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  locationId: text("location_id").notNull(),
  template: text("template"),
  unit: text("unit"),
  distance: doublePrecision("distance"),
  baseLat: doublePrecision("base_lat"),
  baseLng: doublePrecision("base_lng"),
  marketType: text("market_type"),
  notes: text("notes"),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  locationIdx: index("heatmap_overrides_location_id_idx").on(table.locationId),
}));

export const clientSemrushIntegrations = pgTable("client_semrush_integrations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull().unique(),
  integrationEnabled: boolean("integration_enabled").default(true).notNull(),
  semrushCampaignId: text("semrush_campaign_id"),
  businessName: text("business_name"),
  businessLocationId: text("business_location_id"),
  defaultGridSize: text("default_grid_size").default("9x9"),
  defaultKeywords: text("default_keywords").array(),
  syncStatus: text("sync_status").default("idle"),
  lastSuccessfulSyncAt: timestamp("last_successful_sync_at"),
  lastFailedSyncAt: timestamp("last_failed_sync_at"),
  errorMessage: text("error_message"),
  // E-F16 typed-failure parity: machine-readable classification of
  // `error_message`, sharing the `semrushLocationSyncStateErrorCategories`
  // vocabulary (classifyError). NULL on healthy rows and rows that last
  // failed before the column shipped; the free text above is preserved
  // unchanged as the human-readable detail.
  errorCategory: text("error_category"),
  warningMessage: text("warning_message"),
  lastSyncOutcome: text("last_sync_outcome"),
  lastSyncSummary: text("last_sync_summary"),
  syncProgress: text("sync_progress"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("client_semrush_integrations_client_id_idx").on(table.clientId),
}));

export const insertClientSemrushIntegrationSchema = createInsertSchema(clientSemrushIntegrations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertClientSemrushIntegration = z.infer<typeof insertClientSemrushIntegrationSchema>;
export type ClientSemrushIntegration = typeof clientSemrushIntegrations.$inferSelect;

export const heatmapCompetitorSnapshots = pgTable("heatmap_competitor_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  snapshotId: varchar("snapshot_id").references(() => heatmapSnapshots.id, { onDelete: "cascade" }).notNull(),
  clientId: varchar("client_id").references(() => clients.id),
  campaignId: text("campaign_id").notNull(),
  keyword: text("keyword").notNull(),
  scanDate: timestamp("scan_date").notNull(),
  competitorName: text("competitor_name").notNull(),
  competitorRankPosition: integer("competitor_rank_position"),
  competitorShareOfVoice: doublePrecision("competitor_share_of_voice"),
  competitorAverageRank: doublePrecision("competitor_average_rank"),
  competitorReviewCount: integer("competitor_review_count"),
  competitorReviewRating: doublePrecision("competitor_review_rating"),
  competitorGbpUrl: text("competitor_gbp_url"),
  // Task #2020 — structured location disambiguators parsed from the
  // SEMrush Map Rank Tracker business `address` free-text string (the
  // API exposes a single concatenated address, not separate fields).
  // Best-effort: first comma segment → street, second → locality. Both
  // nullable; `deriveCompetitorLocationLabel` prefers them over the GBP
  // URL fragment / short-code hash when present.
  competitorLocality: text("competitor_locality"),
  competitorStreet: text("competitor_street"),
  // Durable "GBP-URL backfill attempted, no SEMrush name-match" marker.
  // Stamped by competitorLocationBackfill.processSnapshot (apply mode)
  // on rows that stay NULL after a successful SEMrush re-fetch, or whose
  // parent snapshot has no keywordId (can never be queried). Lets
  // findCandidateSnapshots exclude permanently-unfillable rows so the
  // backfill_competitor_location_labels action converges to "not needed".
  // Read-time label derivation is unaffected (URL stays NULL).
  gbpUrlBackfillAttemptedAt: timestamp("gbp_url_backfill_attempted_at"),
  // Task #2434 — bounded transient-retry budget for the GBP-URL backfill.
  // A snapshot whose SEMrush re-fetch keeps returning a *transient* outcome
  // (campaign_backoff / fetch_failed — distinct from the global
  // circuit_open / rate_limited outage, which never burns budget) would
  // otherwise be re-counted forever, so the action never converges. This
  // counter is incremented per transient apply attempt; once it reaches
  // BACKFILL_TRANSIENT_RETRY_BUDGET the row is stamped
  // gbpUrlBackfillAttemptedAt (terminal — provably-unreachable). Campaigns
  // proven gone (absent from semrush_campaign_metadata_cache) are stamped
  // immediately without spending the budget. NOT NULL DEFAULT 0 so existing
  // rows start at "zero attempts".
  gbpUrlBackfillRetryCount: integer("gbp_url_backfill_retry_count").notNull().default(0),
  // Task #2052 — sibling convergence marker for the STRUCTURED-location
  // backfill (competitor_locality / competitor_street). Stamped by
  // competitorStructuredLocationBackfill.processStructuredLocationSnapshot
  // (apply mode) on rows that stay BOTH-NULL after a successful SEMrush
  // re-fetch, or whose parent snapshot has no keywordId. Lets
  // findStructuredLocationCandidateSnapshots exclude permanently-unfillable
  // rows so the backfill_competitor_structured_location action converges to
  // "not needed". Independent of gbpUrlBackfillAttemptedAt (different target
  // columns, different fill semantics).
  structuredLocationBackfillAttemptedAt: timestamp("structured_location_backfill_attempted_at"),
  // Task #2434 — sibling of gbpUrlBackfillRetryCount for the STRUCTURED
  // (locality/street) backfill. Same bounded transient-retry budget so the
  // backfill_competitor_structured_location action converges instead of
  // re-counting campaigns whose re-fetch keeps failing transiently. Once it
  // reaches BACKFILL_TRANSIENT_RETRY_BUDGET the row is stamped
  // structuredLocationBackfillAttemptedAt; proven-gone campaigns stamp at once.
  structuredLocationBackfillRetryCount: integer("structured_location_backfill_retry_count").notNull().default(0),
  // Task #2357 — convergence marker for the locality-RELABEL backfill, which
  // re-corrects a `competitor_locality` that an OLD address parse (before the
  // Task #2291 AU / Eircode / Dutch postal rules) wrongly stored as a region /
  // postal token (e.g. "NSW 2000", an Eircode). Distinct from
  // structuredLocationBackfillAttemptedAt: that marker is for filling BOTH-NULL
  // rows; this one is for re-parsing already-NON-NULL but mislabeled localities.
  // Stamped (apply mode) on suspect rows after a successful SEMrush re-fetch so
  // the backfill converges and the action settles to "not needed".
  competitorLocalityRelabelAttemptedAt: timestamp("competitor_locality_relabel_attempted_at"),
  isSubjectBusiness: boolean("is_subject_business").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  snapshotIdx: index("heatmap_competitor_snapshots_snapshot_id_idx").on(table.snapshotId),
  clientIdx: index("heatmap_competitor_snapshots_client_id_idx").on(table.clientId),
  campaignKeywordIdx: index("heatmap_competitor_snapshots_campaign_keyword_idx").on(table.campaignId, table.keyword),
}));

export const insertHeatmapCompetitorSnapshotSchema = createInsertSchema(heatmapCompetitorSnapshots).omit({
  id: true,
  createdAt: true,
});

export type InsertHeatmapCompetitorSnapshot = z.infer<typeof insertHeatmapCompetitorSnapshotSchema>;
export type HeatmapCompetitorSnapshot = typeof heatmapCompetitorSnapshots.$inferSelect;

export const semrushLocationCampaigns = pgTable("semrush_location_campaigns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  locationId: varchar("location_id").references(() => clientLocations.id, { onDelete: "cascade" }).notNull(),
  semrushCampaignId: text("semrush_campaign_id").notNull(),
  semrushCampaignName: text("semrush_campaign_name"),
  isStale: boolean("is_stale").default(false).notNull(),
  staleSince: timestamp("stale_since"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  clientIdx: index("semrush_loc_campaigns_client_id_idx").on(table.clientId),
  locationIdx: index("semrush_loc_campaigns_location_id_idx").on(table.locationId),
  uniqueMapping: uniqueIndex("semrush_loc_campaigns_unique_idx").on(table.clientId, table.locationId, table.semrushCampaignId),
}));

export const insertSemrushLocationCampaignSchema = createInsertSchema(semrushLocationCampaigns).omit({
  id: true,
  createdAt: true,
});

export type InsertSemrushLocationCampaign = z.infer<typeof insertSemrushLocationCampaignSchema>;
export type SemrushLocationCampaign = typeof semrushLocationCampaigns.$inferSelect;

/**
 * Task #1112 — last-known-good SEMrush campaign metadata.
 *
 * The heatmap coverage panel needs each campaign's `reportDates` and
 * active-keyword count to classify (clientId, locationId, campaignId,
 * reportDate) gaps. Those values come from live SEMrush calls (`getCampaign`
 * + `getCampaignKeywords`) and any rate-limit / outage flips every affected
 * row to "inconclusive", which hides real gaps from operators.
 *
 * This table persists the most recent SUCCESSFUL fetch per campaign so the
 * coverage service can fall back to it when the live call fails. Writes only
 * happen on success — failed fetches never overwrite a healthy snapshot.
 */
export const semrushCampaignMetadataCache = pgTable("semrush_campaign_metadata_cache", {
  campaignId: text("campaign_id").primaryKey(),
  reportDates: jsonb("report_dates").$type<string[]>().notNull(),
  activeKeywordCount: integer("active_keyword_count"),
  fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
});

export type SemrushCampaignMetadataCacheRow =
  typeof semrushCampaignMetadataCache.$inferSelect;

/**
 * Canonical per-location SEMrush sync state.
 *
 * One row per (clientId, locationId, campaignId). Read by both the worker
 * (to schedule auto-retries and persist outcomes) and by the dashboard /
 * manual-retry endpoint. A failure on one row must NOT cascade to siblings
 * — each row owns its own attempt budget, abort signal, and timeout.
 *
 * status values:
 *   queued        — created, not yet attempted in current run
 *   in_progress   — currently being synced
 *   succeeded     — finished with full coverage
 *   partial       — finished with incomplete coverage (some keywords missing)
 *   failed        — last attempt errored; may be retryable until attemptCount >= maxAttempts
 *   stale         — campaign no longer exists in SEMrush (404); will not auto-retry
 *   skipped       — no work to do (e.g. no report dates, no keywords)
 *
 * errorCategory values (when status=failed):
 *   transient     — DB connection issues, transport errors → retryable
 *   timeout       — per-location timeout exceeded → retryable
 *   rate_limit    — SEMrush 429 propagated past per-call retry → retryable
 *   server        — SEMrush 5xx → retryable
 *   not_found     — SEMrush 404 → NOT retryable, becomes stale
 *   unknown       — other, treated as transient
 */
export const semrushLocationSyncStateStatuses = [
  "queued",
  "in_progress",
  "succeeded",
  "partial",
  "failed",
  "stale",
  "skipped",
  // Task #1877: sweep-level short-circuit when SEMrush OAuth is not
  // configured. NOT a per-location failure: no attempt was ever made
  // against the SEMrush API, so the row's `attemptCount` is not
  // incremented. Clears back to `queued` once the operator
  // re-authorizes via the Integrations Hub.
  "paused_auth",
] as const;
export type SemrushLocationSyncStateStatus = (typeof semrushLocationSyncStateStatuses)[number];

export const semrushLocationSyncStateErrorCategories = [
  "transient",
  "timeout",
  "rate_limit",
  "server",
  "not_found",
  "unknown",
  // Task #1785: deterministic permanent failures. These never retry,
  // never count toward the auto-retry budget, and dead-letter
  // immediately with a `terminal:` lastError prefix.
  "missing_place_id",
  "mapping_disabled",
  "invalid_mapping",
  "auth_config",
  "malformed_payload",
] as const;
export type SemrushLocationSyncStateErrorCategory =
  (typeof semrushLocationSyncStateErrorCategories)[number];

export const semrushLocationSyncState = pgTable("semrush_location_sync_state", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  locationId: varchar("location_id").references(() => clientLocations.id, { onDelete: "cascade" }).notNull(),
  campaignId: text("campaign_id").notNull(),
  reportDate: text("report_date"),
  status: text("status").notNull().default("queued"),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  lastAttemptAt: timestamp("last_attempt_at"),
  lastSucceededAt: timestamp("last_succeeded_at"),
  lastFailedAt: timestamp("last_failed_at"),
  lastError: text("last_error"),
  errorCategory: text("error_category"),
  nextRetryAt: timestamp("next_retry_at"),
  importedKeywordCount: integer("imported_keyword_count").notNull().default(0),
  expectedKeywordCount: integer("expected_keyword_count").notNull().default(0),
  durationMs: integer("duration_ms"),
  runId: varchar("run_id"),
  triggeredBy: text("triggered_by"),
  message: text("message"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("semrush_loc_sync_state_client_idx").on(table.clientId),
  locationIdx: index("semrush_loc_sync_state_location_idx").on(table.locationId),
  statusIdx: index("semrush_loc_sync_state_status_idx").on(table.status),
  uniqueLocCamp: uniqueIndex("semrush_loc_sync_state_unique_idx").on(
    table.clientId, table.locationId, table.campaignId,
  ),
}));

export const insertSemrushLocationSyncStateSchema = createInsertSchema(semrushLocationSyncState).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSemrushLocationSyncState = z.infer<typeof insertSemrushLocationSyncStateSchema>;
export type SemrushLocationSyncState = typeof semrushLocationSyncState.$inferSelect;

/**
 * Append-only attempt history for SEMrush per-location syncs.
 *
 * `semrushLocationSyncState` only stores the LATEST attempt outcome for a
 * (clientId, locationId, campaignId) row, which makes it impossible to ask
 * "how many times did this location flap last week?" or "what was the error
 * three attempts ago?". This table keeps one immutable row per attempt so
 * those operator questions can be answered without re-reading worker logs.
 *
 * Insert-only — never UPDATE or DELETE rows here from product code (cleanup
 * is fine via dedicated retention jobs). One row is written from
 * `beginAttempt` (status='in_progress') and one from `completeAttempt`
 * (terminal status). The pair is correlated by `(runId, clientId,
 * locationId, campaignId, attemptNumber)`.
 */
export const semrushLocationSyncAttempts = pgTable("semrush_location_sync_attempts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  syncStateId: varchar("sync_state_id").references(() => semrushLocationSyncState.id, { onDelete: "cascade" }).notNull(),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  locationId: varchar("location_id").references(() => clientLocations.id, { onDelete: "cascade" }).notNull(),
  campaignId: text("campaign_id").notNull(),
  runId: varchar("run_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  phase: text("phase").notNull(), // "begin" | "complete"
  status: text("status").notNull(), // mirrors SemrushLocationSyncStateStatus or "in_progress"
  triggeredBy: text("triggered_by"), // "manual" | "scheduled" | "auto_retry"
  reportDate: text("report_date"),
  importedKeywordCount: integer("imported_keyword_count"),
  expectedKeywordCount: integer("expected_keyword_count"),
  durationMs: integer("duration_ms"),
  errorCategory: text("error_category"),
  lastError: text("last_error"),
  message: text("message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  stateIdx: index("semrush_loc_sync_attempts_state_idx").on(table.syncStateId),
  clientIdx: index("semrush_loc_sync_attempts_client_idx").on(table.clientId),
  locationIdx: index("semrush_loc_sync_attempts_location_idx").on(table.locationId),
  runIdx: index("semrush_loc_sync_attempts_run_idx").on(table.runId),
  createdIdx: index("semrush_loc_sync_attempts_created_idx").on(table.createdAt),
}));

export type SemrushLocationSyncAttempt = typeof semrushLocationSyncAttempts.$inferSelect;

/**
 * Canonical backfill job model.
 *
 * Replaces the previous in-flight-only "backfill is happening somewhere in a
 * worker" story for SEMrush heatmap backfills (and Zoom review-signals
 * backfills). One row per logical backfill request, written from the route
 * handler that initiates the job and updated as the worker progresses.
 *
 * status values:
 *   queued     — recorded but not yet running
 *   running    — picked up by a worker
 *   succeeded  — completed without errors
 *   partial    — completed but some scope items failed; see `coverageGapsJson`
 *   failed     — terminal error, see `errorMessage`
 *   cancelled  — operator-cancelled
 */
export const backfillJobTypes = [
  "semrush_heatmap_backfill",
  "zoom_review_signals_backfill",
] as const;
export type BackfillJobType = (typeof backfillJobTypes)[number];

export const backfillJobStatuses = [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
] as const;
export type BackfillJobStatus = (typeof backfillJobStatuses)[number];

export const backfillJobs = pgTable("backfill_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobType: text("job_type").notNull(),
  status: text("status").notNull().default("queued"),
  triggeredBy: text("triggered_by"), // user id or "scheduled"
  parametersJson: jsonb("parameters_json").notNull(),
  // Live progress.
  totalUnits: integer("total_units").notNull().default(0),
  processedUnits: integer("processed_units").notNull().default(0),
  succeededUnits: integer("succeeded_units").notNull().default(0),
  failedUnits: integer("failed_units").notNull().default(0),
  alreadyCurrentUnits: integer("already_current_units").notNull().default(0),
  // Persisted on completion: which (clientId, locationId, campaignId,
  // reportDate) tuples are still missing or incomplete.
  coverageGapsJson: jsonb("coverage_gaps_json"),
  resultJson: jsonb("result_json"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  typeIdx: index("backfill_jobs_type_idx").on(table.jobType),
  statusIdx: index("backfill_jobs_status_idx").on(table.status),
  createdIdx: index("backfill_jobs_created_idx").on(table.createdAt),
}));

export const insertBackfillJobSchema = createInsertSchema(backfillJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBackfillJob = z.infer<typeof insertBackfillJobSchema>;
export type BackfillJob = typeof backfillJobs.$inferSelect;
