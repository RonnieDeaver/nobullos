import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/**
 * Task #1759 — Google Ads integration (reshaped by Task #4008).
 *
 * Auth is env-only: every Google Ads surface mints access tokens from the
 * GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_REFRESH_TOKEN
 * secret trio (see `server/services/adsOs/googleAdsClient.ts`), so there is
 * NO stored credential table — the old `google_ads_connection` singleton was
 * dropped when the in-app OAuth flow retired. The tables here capture
 * discovery (customers) and the per-day campaign + keyword stats produced by
 * the daily sync worker. All numeric Google Ads "micros" values are stored
 * both in micros (authoritative, BIGINT) and converted to dollars at
 * read time when needed.
 *
 * Strictly OUT of scope here: per-user OAuth, ad-group / ad data,
 * auto-mapping to NoBull OS clients, conversion uploads, and report
 * wiring. Operator-driven `nobull_client_id` mapping is supported on
 * `google_ads_customers` so a single customer row can later be linked
 * to a NoBull OS client without coupling the sync to that mapping.
 */

export const googleAdsCustomers = pgTable(
  "google_ads_customers",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    customerId: varchar("customer_id").notNull(),
    descriptiveName: text("descriptive_name"),
    currencyCode: varchar("currency_code"),
    timeZone: varchar("time_zone"),
    isManager: boolean("is_manager").notNull().default(false),
    isTestAccount: boolean("is_test_account").notNull().default(false),
    status: varchar("status"),
    nobullClientId: varchar("nobull_client_id"),
    syncEnabled: boolean("sync_enabled").notNull().default(true),
    lastSyncAt: timestamp("last_sync_at"),
    lastSyncError: text("last_sync_error"),
    discoveredAt: timestamp("discovered_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    customerIdUniq: uniqueIndex("google_ads_customers_customer_id_uniq").on(
      table.customerId,
    ),
    nobullClientIdx: index("google_ads_customers_nobull_client_idx").on(
      table.nobullClientId,
    ),
  }),
);

export const googleAdsCampaigns = pgTable(
  "google_ads_campaigns",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    customerId: varchar("customer_id").notNull(),
    campaignId: varchar("campaign_id").notNull(),
    name: text("name"),
    status: varchar("status"),
    advertisingChannelType: varchar("advertising_channel_type"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    biddingStrategyType: varchar("bidding_strategy_type"),
    budgetMicros: bigint("budget_micros", { mode: "number" })
      .notNull()
      .default(0),
    budgetDollars: doublePrecision("budget_dollars").notNull().default(0),
    budgetName: text("budget_name"),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    customerCampaignUniq: uniqueIndex(
      "google_ads_campaigns_customer_campaign_uniq",
    ).on(table.customerId, table.campaignId),
    customerIdx: index("google_ads_campaigns_customer_idx").on(table.customerId),
  }),
);

export const googleAdsCampaignDailyStats = pgTable(
  "google_ads_campaign_daily_stats",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    customerId: varchar("customer_id").notNull(),
    campaignId: varchar("campaign_id").notNull(),
    date: date("date").notNull(),
    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    clicks: bigint("clicks", { mode: "number" }).notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    costDollars: doublePrecision("cost_dollars").notNull().default(0),
    conversions: integer("conversions").notNull().default(0),
    conversionValueMicros: bigint("conversion_value_micros", {
      mode: "number",
    })
      .notNull()
      .default(0),
    conversionValueDollars: doublePrecision("conversion_value_dollars")
      .notNull()
      .default(0),
    averageCpcMicros: bigint("average_cpc_micros", { mode: "number" })
      .notNull()
      .default(0),
    averageCpcDollars: doublePrecision("average_cpc_dollars")
      .notNull()
      .default(0),
    ctr: integer("ctr_basis_points").notNull().default(0),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (table) => ({
    dailyUniq: uniqueIndex(
      "google_ads_campaign_daily_stats_uniq",
    ).on(table.customerId, table.campaignId, table.date),
    customerDateIdx: index(
      "google_ads_campaign_daily_stats_customer_date_idx",
    ).on(table.customerId, table.date),
  }),
);

export const googleAdsKeywordDailyStats = pgTable(
  "google_ads_keyword_daily_stats",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    customerId: varchar("customer_id").notNull(),
    campaignId: varchar("campaign_id").notNull(),
    adGroupId: varchar("ad_group_id").notNull(),
    criterionId: varchar("criterion_id").notNull(),
    keywordText: text("keyword_text"),
    matchType: varchar("match_type"),
    date: date("date").notNull(),
    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    clicks: bigint("clicks", { mode: "number" }).notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    costDollars: doublePrecision("cost_dollars").notNull().default(0),
    conversions: integer("conversions").notNull().default(0),
    averageCpcMicros: bigint("average_cpc_micros", { mode: "number" })
      .notNull()
      .default(0),
    averageCpcDollars: doublePrecision("average_cpc_dollars")
      .notNull()
      .default(0),
    qualityScore: integer("quality_score"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (table) => ({
    dailyUniq: uniqueIndex("google_ads_keyword_daily_stats_uniq").on(
      table.customerId,
      table.criterionId,
      table.adGroupId,
      table.date,
    ),
    customerDateIdx: index(
      "google_ads_keyword_daily_stats_customer_date_idx",
    ).on(table.customerId, table.date),
    campaignDateIdx: index(
      "google_ads_keyword_daily_stats_campaign_date_idx",
    ).on(table.campaignId, table.date),
  }),
);

export const googleAdsSyncRuns = pgTable(
  "google_ads_sync_runs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    customerId: varchar("customer_id"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    status: varchar("status").notNull().default("running"),
    campaignsUpserted: integer("campaigns_upserted").notNull().default(0),
    campaignStatsUpserted: integer("campaign_stats_upserted")
      .notNull()
      .default(0),
    keywordStatsUpserted: integer("keyword_stats_upserted")
      .notNull()
      .default(0),
    error: text("error"),
    metadata: jsonb("metadata"),
  },
  (table) => ({
    startedAtIdx: index("google_ads_sync_runs_started_at_idx").on(
      table.startedAt,
    ),
  }),
);

export const insertGoogleAdsCustomerSchema = createInsertSchema(
  googleAdsCustomers,
).omit({ id: true, createdAt: true, updatedAt: true, discoveredAt: true });
export type InsertGoogleAdsCustomer = z.infer<
  typeof insertGoogleAdsCustomerSchema
>;
export type GoogleAdsCustomer = typeof googleAdsCustomers.$inferSelect;

export const insertGoogleAdsCampaignSchema = createInsertSchema(
  googleAdsCampaigns,
).omit({ id: true, createdAt: true, updatedAt: true, lastSeenAt: true });
export type InsertGoogleAdsCampaign = z.infer<
  typeof insertGoogleAdsCampaignSchema
>;
export type GoogleAdsCampaign = typeof googleAdsCampaigns.$inferSelect;

export const insertGoogleAdsCampaignDailyStatsSchema = createInsertSchema(
  googleAdsCampaignDailyStats,
).omit({ id: true, syncedAt: true });
export type InsertGoogleAdsCampaignDailyStats = z.infer<
  typeof insertGoogleAdsCampaignDailyStatsSchema
>;
export type GoogleAdsCampaignDailyStats =
  typeof googleAdsCampaignDailyStats.$inferSelect;

export const insertGoogleAdsKeywordDailyStatsSchema = createInsertSchema(
  googleAdsKeywordDailyStats,
).omit({ id: true, syncedAt: true });
export type InsertGoogleAdsKeywordDailyStats = z.infer<
  typeof insertGoogleAdsKeywordDailyStatsSchema
>;
export type GoogleAdsKeywordDailyStats =
  typeof googleAdsKeywordDailyStats.$inferSelect;

export const insertGoogleAdsSyncRunSchema = createInsertSchema(
  googleAdsSyncRuns,
).omit({ id: true, startedAt: true });
export type InsertGoogleAdsSyncRun = z.infer<typeof insertGoogleAdsSyncRunSchema>;
export type GoogleAdsSyncRun = typeof googleAdsSyncRuns.$inferSelect;
