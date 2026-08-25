/**
 * Task #3695 — Going-quiet client detector: daily per-client engagement
 * snapshots.
 *
 * One row per active client per day, written by the going-quiet sweep that
 * runs right after the daily judgment pass. Each snapshot rolls the client's
 * recent inbound/outbound communication counts, a comparison against the
 * client's OWN trailing baseline, silence recency (last inbound message,
 * last call/meeting), and report/dashboard viewing recency into a 0–100
 * quiet score plus a flagged/not-flagged state with human-readable reasons.
 *
 * Baselines are computed from `raw_communication_records` at run time (no
 * historical backfill) — snapshots accumulate going forward. The
 * flagged-state transition between consecutive snapshots drives the
 * once-per-quiet-streak owner/director notification (re-armed when the
 * client re-engages), so this table is also the durable streak state.
 */
import { sql } from "drizzle-orm";
import { pgTable, varchar, jsonb, timestamp, integer, real, boolean, index, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { clients } from "./clients";

export const clientEngagementSnapshots = pgTable("client_engagement_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
  /** YYYY-MM-DD (UTC), same convention as client_daily_judgments.judgment_date. */
  snapshotDate: varchar("snapshot_date").notNull(),
  /** Inbound / outbound message counts in the recent window (14 days). */
  inboundRecent: integer("inbound_recent").default(0).notNull(),
  outboundRecent: integer("outbound_recent").default(0).notNull(),
  /** Inbound / outbound message counts in the last 30 days (display context). */
  inbound30d: integer("inbound_30d").default(0).notNull(),
  outbound30d: integer("outbound_30d").default(0).notNull(),
  /** Client's own trailing baseline: avg inbound messages per week over the
   *  baseline window preceding the recent window. Null when no coverage. */
  baselineWeeklyInbound: real("baseline_weekly_inbound"),
  /** Inbound messages per week over the recent window. */
  recentWeeklyInbound: real("recent_weekly_inbound"),
  /** Percent drop of recent vs baseline weekly inbound (positive = quieter;
   *  negative = client got MORE active). Null when there is no baseline. */
  dropPct: real("drop_pct"),
  daysSinceLastInbound: integer("days_since_last_inbound"),
  daysSinceLastCallMeeting: integer("days_since_last_call_meeting"),
  daysSinceLastViewed: integer("days_since_last_viewed"),
  /** Days between the client's earliest communication record and the run. */
  historyDays: integer("history_days"),
  /** 0–100 severity used for ranking (higher = quieter/more concerning). */
  quietScore: real("quiet_score").default(0).notNull(),
  isFlagged: boolean("is_flagged").default(false).notNull(),
  /** True when the client lacks enough history to judge (never flagged). */
  insufficientHistory: boolean("insufficient_history").default(false).notNull(),
  /**
   * Task #3889 — true when the sweep detected a stale ingestion feed
   * fleet-wide (newest ingested inbound row lags Front's own conversation
   * activity), so this snapshot's inbound zeros are NOT trustworthy client
   * silence. Data-gap snapshots are never flagged, never notify, and are
   * skipped as the baseline for flag transitions.
   */
  dataGap: boolean("data_gap").default(false).notNull(),
  /** string[] — human-readable reasons for the flag / exclusion. */
  reasonsJson: jsonb("reasons_json"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  clientIdx: index("client_engagement_snapshots_client_idx").on(table.clientId),
  dateIdx: index("client_engagement_snapshots_date_idx").on(table.snapshotDate),
  clientDateIdx: index("client_engagement_snapshots_client_date_idx").on(table.clientId, table.snapshotDate),
  flaggedDateIdx: index("client_engagement_snapshots_flagged_date_idx").on(table.isFlagged, table.snapshotDate),
  uniqueClientDate: unique("client_engagement_snapshots_client_id_snapshot_date_unique").on(table.clientId, table.snapshotDate),
}));

export const insertClientEngagementSnapshotSchema = createInsertSchema(clientEngagementSnapshots, {
  reasonsJson: z.array(z.string()).nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertClientEngagementSnapshot = z.infer<typeof insertClientEngagementSnapshotSchema>;
export type ClientEngagementSnapshot = typeof clientEngagementSnapshots.$inferSelect;
