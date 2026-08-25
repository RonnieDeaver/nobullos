import { pgTable, varchar, text, integer, bigint, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Task #2657 — daily app backup run lifecycle.
//   in_progress — a run row was created and the backup is executing.
//   success     — both the database dump AND the file manifest/archive
//                 completed.
//   partial     — exactly one of {database, files} succeeded; the other
//                 failed. Surfaced distinctly so it is never shown green.
//   failed      — the run could not produce either artifact (or crashed
//                 before completing). Watchdog-recovered hung runs are
//                 marked failed by the next run's stale sweep.
export const appBackupStatuses = ["in_progress", "success", "partial", "failed"] as const;
export type AppBackupStatus = (typeof appBackupStatuses)[number];

// Whether the run was the scheduled daily job or an operator on-demand press.
export const appBackupKinds = ["scheduled", "manual"] as const;
export type AppBackupKind = (typeof appBackupKinds)[number];

export const appBackupRuns = pgTable(
  "app_backup_runs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    kind: varchar("kind", { length: 16 }).notNull().default("scheduled"),
    status: varchar("status", { length: 16 }).notNull().default("in_progress"),
    // Sub-statuses so a partial run can name which half failed.
    dbStatus: varchar("db_status", { length: 16 }),
    filesStatus: varchar("files_status", { length: 16 }),
    // Object Storage keys (relative to PRIVATE_OBJECT_DIR) for the artifacts.
    dbDumpKey: text("db_dump_key"),
    fileManifestKey: text("file_manifest_key"),
    dbDumpSizeBytes: bigint("db_dump_size_bytes", { mode: "number" }),
    fileObjectCount: integer("file_object_count"),
    fileCopiedCount: integer("file_copied_count"),
    fileTotalSizeBytes: bigint("file_total_size_bytes", { mode: "number" }),
    totalSizeBytes: bigint("total_size_bytes", { mode: "number" }),
    errorMessage: text("error_message"),
    // The user id for a manual run; null for the scheduled job.
    triggeredBy: varchar("triggered_by"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    createdAtIdx: index("idx_app_backup_runs_created_at").on(table.createdAt),
    statusTimeIdx: index("idx_app_backup_runs_status_time").on(table.status, table.createdAt),
  }),
);

export const insertAppBackupRunSchema = createInsertSchema(appBackupRuns).omit({
  id: true,
  createdAt: true,
});
export type InsertAppBackupRun = z.infer<typeof insertAppBackupRunSchema>;
export type AppBackupRun = typeof appBackupRuns.$inferSelect;
