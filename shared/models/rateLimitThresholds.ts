import { integer, pgTable, varchar } from "drizzle-orm/pg-core";

export const rateLimitThresholds = pgTable("rate_limit_thresholds", {
  category: varchar("category", { length: 128 }).primaryKey(),
  threshold: integer("threshold").notNull(),
});

export type RateLimitThresholdRecord = typeof rateLimitThresholds.$inferSelect;
export type InsertRateLimitThreshold = typeof rateLimitThresholds.$inferInsert;
