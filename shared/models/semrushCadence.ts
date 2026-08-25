/**
 * Task #1785 — SEMrush demand-driven cadence models.
 *
 * - `semrushCadenceSkipLog`: daily rollup of refresh-enqueue skips.
 * - `semrushLastAppliedHashes`: per-(campaign, location, snapshot) hash
 *   of the last applied SEMrush response, used to suppress identical
 *   `semrush_heatmap_apply` fan-out.
 *
 * The `clients.last_viewed_at` active-client signal lives on the
 * existing `clients` table (see `clients.ts`).
 */
import { pgTable, varchar, integer, date, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const semrushCadenceSkipLog = pgTable(
  "semrush_cadence_skip_log",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    date: date("date").notNull(),
    queueName: varchar("queue_name", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 64 }).notNull(),
    count: integer("count").notNull().default(0),
    clientCount: integer("client_count").notNull().default(0),
    campaignCount: integer("campaign_count").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("semrush_cadence_skip_log_unique_idx").on(t.date, t.queueName, t.reason),
    dateIdx: index("semrush_cadence_skip_log_date_idx").on(t.date),
  }),
);

export type SemrushCadenceSkipLog = typeof semrushCadenceSkipLog.$inferSelect;

export const SEMRUSH_CADENCE_SKIP_REASONS = [
  "enqueued_refresh",
  "skipped_not_stale",
  "skipped_inactive_client",
  "skipped_queue_paused",
  "skipped_kill_switch_legacy",
  "skipped_missing_mapping",
  "skipped_identical_result",
  "skipped_permanent_error",
] as const;
export type SemrushCadenceSkipReason = (typeof SEMRUSH_CADENCE_SKIP_REASONS)[number];

export const semrushLastAppliedHashes = pgTable(
  "semrush_last_applied_hashes",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: varchar("campaign_id", { length: 128 }).notNull(),
    locationId: varchar("location_id", { length: 128 }).notNull().default(""),
    snapshotKey: varchar("snapshot_key", { length: 128 }).notNull().default(""),
    responseHash: varchar("response_hash", { length: 64 }).notNull(),
    appliedAt: timestamp("applied_at").notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("semrush_last_applied_hashes_unique_idx").on(t.campaignId, t.locationId, t.snapshotKey),
  }),
);

export type SemrushLastAppliedHash = typeof semrushLastAppliedHashes.$inferSelect;
