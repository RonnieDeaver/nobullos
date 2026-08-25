import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, boolean, index, unique } from "drizzle-orm/pg-core";
import { users } from "./auth";

// ─── Task #3712 — AM coaching runs & reports ────────────────────────────────
//
// A coaching run is one director-triggered background analysis across every
// account manager who owns at least one active client. The run row carries
// live progress counters (processed/failed out of total) that the Team
// Coaching tab polls, plus the department-wide synthesis produced after all
// per-AM reports finish. Past runs are kept so the director can compare an
// AM's patterns against earlier runs.
//
// One report row per (run, AM). Reports store STRUCTURED results only —
// ranked mistakes with evidence citations (excerpt + pointer to the exact
// raw_communication_record), strengths, per-channel summaries, and a
// suggested coaching focus. AMs whose books have too little verifiably-theirs
// Zoom/email material get `status = insufficient_data` instead of fabricated
// coaching; a per-AM analysis crash lands as `status = failed` with the error
// preserved and never kills the run.

export const amCoachingRunStatuses = ["running", "completed", "failed"] as const;
export type AmCoachingRunStatus = (typeof amCoachingRunStatuses)[number];

export const amCoachingRuns = pgTable("am_coaching_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  status: varchar("status", { length: 16 }).default("running").notNull(),
  requestedByUserId: varchar("requested_by_user_id").references(() => users.id),
  totalManagers: integer("total_managers").default(0).notNull(),
  processedManagers: integer("processed_managers").default(0).notNull(),
  failedManagers: integer("failed_managers").default(0).notNull(),
  departmentSynthesisJson: jsonb("department_synthesis_json"),
  modelVersion: varchar("model_version"),
  error: text("error"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  statusIdx: index("am_coaching_runs_status_idx").on(table.status),
  startedAtIdx: index("am_coaching_runs_started_at_idx").on(table.startedAt),
}));

export type AmCoachingRun = typeof amCoachingRuns.$inferSelect;
export type InsertAmCoachingRun = typeof amCoachingRuns.$inferInsert;

export const amCoachingReportStatuses = ["completed", "insufficient_data", "failed"] as const;
export type AmCoachingReportStatus = (typeof amCoachingReportStatuses)[number];

export const amCoachingReports = pgTable("am_coaching_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  runId: varchar("run_id").references(() => amCoachingRuns.id, { onDelete: "cascade" }).notNull(),
  amUserId: varchar("am_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  status: varchar("status", { length: 24 }).notNull(),
  clientCount: integer("client_count").default(0).notNull(),
  zoomSampleCount: integer("zoom_sample_count").default(0).notNull(),
  emailSampleCount: integer("email_sample_count").default(0).notNull(),
  unattributedSampleCount: integer("unattributed_sample_count").default(0).notNull(),
  mistakesJson: jsonb("mistakes_json"),
  unattributedJson: jsonb("unattributed_json"),
  strengthsJson: jsonb("strengths_json"),
  zoomSummary: text("zoom_summary"),
  emailSummary: text("email_summary"),
  coachingFocus: text("coaching_focus"),
  insufficientData: boolean("insufficient_data").default(false).notNull(),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  runIdx: index("am_coaching_reports_run_id_idx").on(table.runId),
  amIdx: index("am_coaching_reports_am_user_id_idx").on(table.amUserId),
  uniqueRunAm: unique("am_coaching_reports_run_am_uniq").on(table.runId, table.amUserId),
}));

export type AmCoachingReport = typeof amCoachingReports.$inferSelect;
export type InsertAmCoachingReport = typeof amCoachingReports.$inferInsert;

// ── JSON payload shapes (shared server ⇄ client contracts) ─────────────────
// Stored in the *Json columns above. Evidence always points at a concrete
// raw_communication_record so the UI can open the underlying call/email;
// `attributed=false` marks material where the acting staff member could not
// be verified — shown as "unattributed", never pinned on the book owner.

export interface AmCoachingEvidence {
  recordId: string;
  clientId: string | null;
  clientName: string | null;
  sourceType: "zoom" | "front_email";
  title: string;
  /** ISO timestamp of the underlying communication. */
  timestamp: string;
  /** Short verbatim excerpt backing the finding. */
  excerpt: string;
  /** True when the AM was verifiably on the call / authored the email. */
  attributed: boolean;
}

export interface AmCoachingMistake {
  title: string;
  description: string;
  /** 1 (minor) – 5 (severe), used for impact ranking. */
  severity: number;
  channel: "zoom" | "email";
  evidence: AmCoachingEvidence[];
}

export interface AmCoachingUnattributedObservation {
  title: string;
  description: string;
  evidence: AmCoachingEvidence[];
}

export interface AmCoachingStrength {
  title: string;
  description: string;
  channel: "zoom" | "email" | "both";
}

export interface AmCoachingDepartmentMistake {
  title: string;
  description: string;
  /** 1–5 team-level impact. */
  severity: number;
  /** AMs whose individual reports share this pattern. */
  amUserIds: string[];
}

export interface AmCoachingDepartmentSynthesis {
  summary: string;
  commonMistakes: AmCoachingDepartmentMistake[];
}
