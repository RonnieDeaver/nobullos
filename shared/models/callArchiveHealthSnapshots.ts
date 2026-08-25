import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, timestamp } from "drizzle-orm/pg-core";

export const callArchiveHealthSnapshots = pgTable(
  "call_archive_health_snapshots",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    sampledAt: timestamp("sampled_at").notNull().default(sql`now()`),
    pendingStuckCount: integer("pending_stuck_count").notNull().default(0),
    oldestPendingAgeSeconds: integer("oldest_pending_age_seconds"),
    recentFailedCount: integer("recent_failed_count").notNull().default(0),
    pendingHours: integer("pending_hours").notNull(),
    failedLookbackHours: integer("failed_lookback_hours").notNull(),
  },
  (table) => [
    index("call_archive_health_snapshots_sampled_at_idx").on(table.sampledAt),
  ],
);

export type CallArchiveHealthSnapshot = typeof callArchiveHealthSnapshots.$inferSelect;
export type InsertCallArchiveHealthSnapshot = typeof callArchiveHealthSnapshots.$inferInsert;
