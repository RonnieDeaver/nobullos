import { sql } from "drizzle-orm";
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/**
 * Task #2785 — Google Ads Hygiene: Keyword Intel, LSA Dashboard, Budget
 * Pacing & Alerts.
 *
 * Two new tables supplement the audit foundation (Task #2784):
 *   - `google_ads_hygiene_alerts` — alerts raised by pacing/audit engines,
 *     optionally linked to a ClickUp task.
 *   - `google_ads_keyword_intel_results` — persisted keyword analysis runs
 *     (top performers, low-quality, negative candidates) so results survive
 *     page navigations without re-querying the Google Ads API.
 */

// ─── Alerts ─────────────────────────────────────────────────────────────────

export const HYGIENE_ALERT_TYPES = [
  "budget_pacing_behind",
  "budget_pacing_ahead",
  "disapproval",
  "pacing_risk",
  "low_quality_score",
  "lsa_pacing_behind",
] as const;
export type HygieneAlertType = (typeof HYGIENE_ALERT_TYPES)[number];

export const HYGIENE_ALERT_SEVERITIES = ["warning", "critical"] as const;
export type HygieneAlertSeverity = (typeof HYGIENE_ALERT_SEVERITIES)[number];

export const CLICKUP_TASK_STATUSES = [
  "open",
  "in_progress",
  "closed",
  "unknown",
] as const;
export type ClickUpTaskStatus = (typeof CLICKUP_TASK_STATUSES)[number];

export const googleAdsHygieneAlerts = pgTable(
  "google_ads_hygiene_alerts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    customerId: varchar("customer_id").notNull(),
    alertType: varchar("alert_type").notNull(),
    severity: varchar("severity").notNull().default("warning"),
    title: text("title").notNull(),
    detail: text("detail"),
    campaignId: varchar("campaign_id"),
    campaignName: text("campaign_name"),
    measuredValue: text("measured_value"),
    isResolved: varchar("is_resolved").notNull().default("no"),
    resolvedAt: timestamp("resolved_at"),
    clickupTaskId: varchar("clickup_task_id"),
    clickupListId: varchar("clickup_list_id"),
    clickupTaskStatus: varchar("clickup_task_status"),
    clickupTaskUrl: text("clickup_task_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    customerIdx: index("google_ads_hygiene_alerts_customer_idx").on(
      table.customerId,
    ),
    createdAtIdx: index("google_ads_hygiene_alerts_created_at_idx").on(
      table.createdAt,
    ),
  }),
);

export const insertGoogleAdsHygieneAlertSchema = createInsertSchema(
  googleAdsHygieneAlerts,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertGoogleAdsHygieneAlert = z.infer<
  typeof insertGoogleAdsHygieneAlertSchema
>;
export type GoogleAdsHygieneAlert =
  typeof googleAdsHygieneAlerts.$inferSelect;

// ─── Keyword Intel Results ───────────────────────────────────────────────────

export const KEYWORD_SUGGESTION_TYPES = [
  "top_performer",
  "low_quality",
  "negative_candidate",
  "broad_risk",
  "missing_exact",
] as const;
export type KeywordSuggestionType = (typeof KEYWORD_SUGGESTION_TYPES)[number];

export const googleAdsKeywordIntelResults = pgTable(
  "google_ads_keyword_intel_results",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    customerId: varchar("customer_id").notNull(),
    runAt: timestamp("run_at").defaultNow().notNull(),
    campaignId: varchar("campaign_id"),
    campaignName: text("campaign_name"),
    adGroupId: varchar("ad_group_id"),
    keywordText: text("keyword_text").notNull(),
    matchType: varchar("match_type"),
    impressions: integer("impressions").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    costDollars: doublePrecision("cost_dollars").notNull().default(0),
    conversions: integer("conversions").notNull().default(0),
    avgCpcDollars: doublePrecision("avg_cpc_dollars").notNull().default(0),
    qualityScore: integer("quality_score"),
    suggestionType: varchar("suggestion_type").notNull(),
    notes: text("notes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    customerRunIdx: index("google_ads_keyword_intel_customer_run_idx").on(
      table.customerId,
      table.runAt,
    ),
    customerIdx: index("google_ads_keyword_intel_customer_idx").on(
      table.customerId,
    ),
  }),
);

export const insertGoogleAdsKeywordIntelResultSchema = createInsertSchema(
  googleAdsKeywordIntelResults,
).omit({ id: true, createdAt: true });
export type InsertGoogleAdsKeywordIntelResult = z.infer<
  typeof insertGoogleAdsKeywordIntelResultSchema
>;
export type GoogleAdsKeywordIntelResult =
  typeof googleAdsKeywordIntelResults.$inferSelect;
