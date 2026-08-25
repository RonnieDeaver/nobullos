import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, real, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";

export const censusTracts = pgTable("census_tracts", {
  geoid: varchar("geoid", { length: 11 }).primaryKey(),
  stateFips: varchar("state_fips", { length: 2 }).notNull(),
  countyFips: varchar("county_fips", { length: 5 }).notNull(),
  tractCode: varchar("tract_code", { length: 6 }).notNull(),
  population: integer("population").notNull().default(0),
  landAreaSqM: real("land_area_sq_m").default(0),
  centroidLat: real("centroid_lat").notNull(),
  centroidLng: real("centroid_lng").notNull(),
});

export type CensusTract = typeof censusTracts.$inferSelect;

export const h3Population = pgTable("h3_population", {
  h3Index: varchar("h3_index", { length: 20 }).primaryKey(),
  population: integer("population").notNull().default(0),
});

export const mcuCacheTypes = ["geocode", "fips", "census", "places", "trends"] as const;
export type McuCacheType = typeof mcuCacheTypes[number];

export const mcuCache = pgTable("mcu_cache", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  cacheType: varchar("cache_type").notNull(),
  cacheKey: text("cache_key").notNull(),
  data: jsonb("data").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  uniqueCacheEntry: unique().on(table.cacheType, table.cacheKey),
}));

export const insertMcuCacheSchema = createInsertSchema(mcuCache).omit({
  id: true,
  createdAt: true,
});

export type InsertMcuCache = z.infer<typeof insertMcuCacheSchema>;
export type McuCache = typeof mcuCache.$inferSelect;

export const mcuEvaluations = pgTable("mcu_evaluations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  evaluationType: varchar("evaluation_type").notNull(),
  practiceArea: varchar("practice_area").notNull(),
  addresses: jsonb("addresses").notNull(),
  results: jsonb("results").notNull(),
  verdict: varchar("verdict"),
  mcuTotal: real("mcu_total"),
  mcuAllocated: real("mcu_allocated"),
  mcuRemaining: real("mcu_remaining"),
  overlapRisk: varchar("overlap_risk"),
  scarcityLabel: varchar("scarcity_label"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertMcuEvaluationSchema = createInsertSchema(mcuEvaluations).omit({
  id: true,
  createdAt: true,
});

export type InsertMcuEvaluation = z.infer<typeof insertMcuEvaluationSchema>;
export type McuEvaluation = typeof mcuEvaluations.$inferSelect;

export const mcuPracticeAreas = [
  "Personal Injury",
  "Criminal Defense",
  "Family Law",
  "Immigration",
  "Estate Planning",
  "Business Law",
  "Employment Law",
  "Bankruptcy",
  "Real Estate",
  "Medical Malpractice",
] as const;
export type McuPracticeArea = typeof mcuPracticeAreas[number];
