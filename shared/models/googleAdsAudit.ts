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
 * Task #2784 — Google Ads Hygiene Audit foundation.
 *
 * Rewrite (not port-by-copy) of a standalone Python/FastAPI "NBM Ads
 * Hygiene" tool. An audit run scores one Google Ads customer account
 * against a law-firm-specific checklist (see
 * `server/config/googleAdsAuditChecks.ts`) using a weighted model with
 * critical-gate capping (`H` uncapped weighted score, `H_final` after
 * gates). Read-only — no write-back to Google Ads, no new OAuth. Reuses
 * the existing MCC connection from Task #1759.
 *
 * `google_ads_audit_runs` holds one row per audit execution (overall
 * scores, triggered gates, category sub-scores, status). Each run has
 * many `google_ads_audit_check_results` rows — one per checklist item —
 * so a past report can be rendered without re-running the audit.
 */

export const googleAdsAuditRuns = pgTable(
  "google_ads_audit_runs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    customerId: varchar("customer_id").notNull(),
    status: varchar("status").notNull().default("running"), // running | completed | failed
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    triggeredBy: varchar("triggered_by"),
    // Uncapped weighted overall score (0-100), before gate capping.
    scoreH: doublePrecision("score_h"),
    // Final overall score after critical-gate caps are applied (0-100).
    scoreHFinal: doublePrecision("score_h_final"),
    // Category id -> sub-score (0-100). See CHECK_CATEGORIES ids.
    categoryScores: jsonb("category_scores"),
    // Gate ids that fired on this run, each with the cap it imposed and why.
    triggeredGates: jsonb("triggered_gates"),
    error: text("error"),
    // Free-form metadata: lookback window, account name snapshot, etc.
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    customerIdx: index("google_ads_audit_runs_customer_idx").on(
      table.customerId,
    ),
    startedAtIdx: index("google_ads_audit_runs_started_at_idx").on(
      table.startedAt,
    ),
  }),
);

export const googleAdsAuditCheckResults = pgTable(
  "google_ads_audit_check_results",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    runId: varchar("run_id").notNull(),
    checkId: varchar("check_id").notNull(),
    categoryId: varchar("category_id").notNull(),
    // good | okay | bad | critical | not_applicable
    status: varchar("status").notNull(),
    // Normalized 0-100 score this check contributed (null when N/A).
    score: doublePrecision("score"),
    weight: doublePrecision("weight").notNull().default(0),
    // Human-readable measured value, e.g. "3 of 12 ad groups", "62%".
    measuredValue: text("measured_value"),
    // Raw numeric value backing measuredValue, when applicable.
    measuredNumeric: doublePrecision("measured_numeric"),
    // Campaign / ad group / asset names or ids this check flagged.
    affectedEntities: jsonb("affected_entities"),
    recommendedFix: text("recommended_fix"),
    isGate: text("is_gate"), // gate id this check corresponds to, if any
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    runIdx: index("google_ads_audit_check_results_run_idx").on(table.runId),
    runCheckUniqIdx: index(
      "google_ads_audit_check_results_run_check_idx",
    ).on(table.runId, table.checkId),
  }),
);

export const insertGoogleAdsAuditRunSchema = createInsertSchema(
  googleAdsAuditRuns,
).omit({ id: true, startedAt: true, createdAt: true });
export type InsertGoogleAdsAuditRun = z.infer<
  typeof insertGoogleAdsAuditRunSchema
>;
export type GoogleAdsAuditRun = typeof googleAdsAuditRuns.$inferSelect;

export const insertGoogleAdsAuditCheckResultSchema = createInsertSchema(
  googleAdsAuditCheckResults,
).omit({ id: true, createdAt: true });
export type InsertGoogleAdsAuditCheckResult = z.infer<
  typeof insertGoogleAdsAuditCheckResultSchema
>;
export type GoogleAdsAuditCheckResult =
  typeof googleAdsAuditCheckResults.$inferSelect;

export const AUDIT_CHECK_STATUSES = [
  "good",
  "okay",
  "bad",
  "critical",
  "not_applicable",
] as const;
export type AuditCheckStatus = (typeof AUDIT_CHECK_STATUSES)[number];

export const AUDIT_RUN_STATUSES = ["running", "completed", "failed"] as const;
export type AuditRunStatus = (typeof AUDIT_RUN_STATUSES)[number];
