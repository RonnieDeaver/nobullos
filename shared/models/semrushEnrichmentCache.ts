import { pgTable, varchar, text, integer, timestamp, jsonb, index, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const semrushEnrichmentCacheSources = [
  "background_refresh",
  "on_demand_enrichment",
  "stale_promotion",
] as const;
export type SemrushEnrichmentCacheSource =
  (typeof semrushEnrichmentCacheSources)[number];

export const semrushEnrichmentCache = pgTable(
  "semrush_enrichment_cache",
  {
    campaignId: varchar("campaign_id", { length: 128 }).primaryKey(),
    businessName: varchar("business_name", { length: 512 }),
    location: varchar("location", { length: 1024 }),
    address: varchar("address", { length: 1024 }),
    keywordsJson: jsonb("keywords_json"),
    keywordCount: integer("keyword_count").notNull().default(0),
    payloadHash: varchar("payload_hash", { length: 64 }),
    source: varchar("source", { length: 32 }).notNull(),
    lastRefreshedAt: timestamp("last_refreshed_at").defaultNow().notNull(),
    lastReadAt: timestamp("last_read_at"),
    notes: text("notes"),
    // Task #1973: whether the last fetch returned the full inventory.
    // Consumers must treat `complete=false` rows as stale regardless of
    // `lastRefreshedAt` so the next request triggers a real refresh.
    complete: boolean("complete").notNull().default(true),
    incompleteReason: varchar("incomplete_reason", { length: 64 }),
  },
  (table) => ({
    refreshedAtIdx: index("idx_semrush_enrichment_cache_refreshed_at").on(
      table.lastRefreshedAt,
    ),
    sourceTimeIdx: index("idx_semrush_enrichment_cache_source_time").on(
      table.source,
      table.lastRefreshedAt,
    ),
  }),
);

export const semrushEnrichmentKeywordSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
});
export type SemrushEnrichmentKeyword = z.infer<
  typeof semrushEnrichmentKeywordSchema
>;

export const insertSemrushEnrichmentCacheSchema = createInsertSchema(
  semrushEnrichmentCache,
).omit({
  lastRefreshedAt: true,
  lastReadAt: true,
});
export type InsertSemrushEnrichmentCache = z.infer<
  typeof insertSemrushEnrichmentCacheSchema
>;
export type SemrushEnrichmentCacheRow =
  typeof semrushEnrichmentCache.$inferSelect;
