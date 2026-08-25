/**
 * Task #3692 — Churn Risk Radar agent sweep.
 *
 * Persistence for the on-demand portfolio-wide churn interview:
 *
 *   - churn_radar_runs           one row per sweep run (status, progress
 *                                counters, requester, portfolio synthesis).
 *   - churn_radar_client_results one row per (run, client): the client-level
 *                                interview outcome — analyzed with a churn
 *                                likelihood, insufficient_data (never
 *                                fabricated), or error (isolated per client).
 *   - churn_radar_findings       one row per (run, client, rank 1–5) churn
 *                                reason with severity, confidence, evidence
 *                                references, and a fixed-vocabulary theme
 *                                category the synthesis step aggregates on.
 *
 * `requestedBy` deliberately has NO foreign key: run history must survive
 * user deletion, and hermetic route tests seed users in an isolated schema
 * while radar rows are written by the worker pool to public.
 */
import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, real, index, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { clients } from "./clients";

export const churnRadarRunStatuses = ["running", "synthesizing", "completed", "failed"] as const;
export type ChurnRadarRunStatus = typeof churnRadarRunStatuses[number];

/** Statuses a run can be "active" in — used for the already-running gate. */
export const churnRadarActiveRunStatuses = ["running", "synthesizing"] as const;

export const churnRadarClientStatuses = ["analyzed", "insufficient_data", "error"] as const;
export type ChurnRadarClientStatus = typeof churnRadarClientStatuses[number];

export const churnRadarSeverities = ["high", "medium", "low"] as const;
export type ChurnRadarSeverity = typeof churnRadarSeverities[number];

export const churnRadarLikelihoodBands = ["low", "moderate", "high", "critical"] as const;
export type ChurnRadarLikelihoodBand = typeof churnRadarLikelihoodBands[number];

/**
 * Fixed theme vocabulary. The interview model must classify every reason
 * into one of these categories; the synthesis step aggregates findings by
 * category so cross-client themes dedupe deterministically (no second AI
 * pass). Labels are shared by the API, CSV export, and the Radar tab UI.
 */
export const churnRadarThemeCategories = [
  "responsiveness",
  "results_performance",
  "lead_volume",
  "lead_quality",
  "execution_delivery",
  "communication_cadence",
  "trust_relationship",
  "billing_budget",
  "reporting_transparency",
  "strategy_misalignment",
  "competitive_pressure",
  "internal_client_changes",
  "other",
] as const;
export type ChurnRadarThemeCategory = typeof churnRadarThemeCategories[number];

export const churnRadarThemeLabels: Record<ChurnRadarThemeCategory, string> = {
  responsiveness: "Slow responsiveness on asks",
  results_performance: "Underwhelming results / performance",
  lead_volume: "Lead volume concerns",
  lead_quality: "Lead quality concerns",
  execution_delivery: "Execution & delivery misses",
  communication_cadence: "Communication gaps / going quiet",
  trust_relationship: "Trust & relationship strain",
  billing_budget: "Billing / budget pressure",
  reporting_transparency: "Reporting & transparency gaps",
  strategy_misalignment: "Strategy misalignment",
  competitive_pressure: "Competitive pressure / shopping around",
  internal_client_changes: "Client-side changes (staff, priorities, finances)",
  other: "Other",
};

export const churnRadarRuns = pgTable("churn_radar_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  status: varchar("status").notNull().default("running"),
  requestedBy: varchar("requested_by"),
  totalClients: integer("total_clients").notNull().default(0),
  processedClients: integer("processed_clients").notNull().default(0),
  analyzedClients: integer("analyzed_clients").notNull().default(0),
  insufficientClients: integer("insufficient_clients").notNull().default(0),
  errorClients: integer("error_clients").notNull().default(0),
  /** Portfolio synthesis persisted on completion: { themes: ChurnRadarTheme[] }. */
  synthesisJson: jsonb("synthesis_json"),
  /** Fatal-failure summary (per-client errors live on client_results rows). */
  errorSummary: text("error_summary"),
  modelVersion: varchar("model_version"),
  startedAt: timestamp("started_at").defaultNow(),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  statusIdx: index("churn_radar_runs_status_idx").on(table.status),
  startedIdx: index("churn_radar_runs_started_at_idx").on(table.startedAt),
}));

export const churnRadarClientResults = pgTable("churn_radar_client_results", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  runId: varchar("run_id").references(() => churnRadarRuns.id, { onDelete: "cascade" }).notNull(),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  /** Snapshot so past runs stay readable/exportable after renames. */
  firmName: varchar("firm_name").notNull(),
  status: varchar("status").notNull(),
  /** 0–100, higher = more likely to churn. Null unless status=analyzed. */
  churnLikelihood: real("churn_likelihood"),
  likelihoodBand: varchar("likelihood_band"),
  summary: text("summary"),
  insufficiencyReason: text("insufficiency_reason"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  runIdx: index("churn_radar_client_results_run_idx").on(table.runId),
  clientIdx: index("churn_radar_client_results_client_idx").on(table.clientId),
  // Idempotent resume: one outcome per client per run; the orchestrator
  // skips clients that already have a row for the run.
  uniqueRunClient: unique("churn_radar_client_results_run_client_uq").on(table.runId, table.clientId),
}));

export const churnRadarFindings = pgTable("churn_radar_findings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  runId: varchar("run_id").references(() => churnRadarRuns.id, { onDelete: "cascade" }).notNull(),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  /** 1 = most likely churn driver for this client; at most 5 per client. */
  rank: integer("rank").notNull(),
  reason: text("reason").notNull(),
  severity: varchar("severity").notNull(),
  /** Model confidence 0–1. */
  confidence: real("confidence"),
  /** string[] — evidence references (judgment dates, asks, comms). */
  evidenceJson: jsonb("evidence_json"),
  themeCategory: varchar("theme_category").notNull().default("other"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  runIdx: index("churn_radar_findings_run_idx").on(table.runId),
  clientIdx: index("churn_radar_findings_client_idx").on(table.clientId),
  themeIdx: index("churn_radar_findings_theme_idx").on(table.themeCategory),
  uniqueRunClientRank: unique("churn_radar_findings_run_client_rank_uq").on(table.runId, table.clientId, table.rank),
}));

export const insertChurnRadarRunSchema = createInsertSchema(churnRadarRuns, {
  status: z.enum(churnRadarRunStatuses).optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });

export const insertChurnRadarClientResultSchema = createInsertSchema(churnRadarClientResults, {
  status: z.enum(churnRadarClientStatuses),
  likelihoodBand: z.enum(churnRadarLikelihoodBands).nullable().optional(),
}).omit({ id: true, createdAt: true });

export const insertChurnRadarFindingSchema = createInsertSchema(churnRadarFindings, {
  severity: z.enum(churnRadarSeverities),
  themeCategory: z.enum(churnRadarThemeCategories).optional(),
}).omit({ id: true, createdAt: true });

export type ChurnRadarRun = typeof churnRadarRuns.$inferSelect;
export type InsertChurnRadarRun = z.infer<typeof insertChurnRadarRunSchema>;
export type ChurnRadarClientResult = typeof churnRadarClientResults.$inferSelect;
export type InsertChurnRadarClientResult = z.infer<typeof insertChurnRadarClientResultSchema>;
export type ChurnRadarFinding = typeof churnRadarFindings.$inferSelect;
export type InsertChurnRadarFinding = z.infer<typeof insertChurnRadarFindingSchema>;

/** One aggregated cross-client theme, persisted in churn_radar_runs.synthesis_json. */
export interface ChurnRadarThemeClient {
  clientId: string;
  firmName: string;
  churnLikelihood: number | null;
  likelihoodBand: string | null;
  worstSeverity: ChurnRadarSeverity;
  reasons: string[];
}

export interface ChurnRadarTheme {
  category: ChurnRadarThemeCategory;
  label: string;
  /** Distinct clients with ≥1 finding in this theme. */
  clientCount: number;
  /** Affected clients whose likelihood band is high or critical. */
  highRiskClientCount: number;
  severityCounts: { high: number; medium: number; low: number };
  /**
   * Portfolio-impact weight the themes are rank-ordered by:
   *   impactScore = Σ severityWeight(finding) + 2 × clientCount
   * with severityWeight high=3 / medium=2 / low=1. Deterministic so the
   * synthesis is testable and re-runs produce identical ordering.
   */
  impactScore: number;
  affectedClients: ChurnRadarThemeClient[];
  /** Up to 3 highest-weight reason texts, for the theme card. */
  representativeReasons: string[];
}

export interface ChurnRadarSynthesis {
  themes: ChurnRadarTheme[];
  generatedAt: string;
}
