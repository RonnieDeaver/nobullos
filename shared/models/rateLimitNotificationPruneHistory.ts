import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

// Persistent audit log of every notification-history cleanup run.
// Written by `server/services/rateLimitNotificationRetention.ts` after each
// scheduled or on-demand prune (success or failure).
export const rateLimitNotificationPruneHistory = pgTable(
  "rate_limit_notification_prune_history",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    ranAt: timestamp("ran_at").notNull().default(sql`now()`),
    triggeredBy: varchar("triggered_by", { length: 32 }).notNull(),
    actorId: varchar("actor_id"),
    retentionDays: integer("retention_days").notNull(),
    cutoffMs: bigint("cutoff_ms", { mode: "number" }).notNull(),
    deletedRows: integer("deleted_rows").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    status: varchar("status", { length: 16 }).notNull().default("ok"),
    errorMessage: text("error_message"),
  },
  (table) => [
    index("rate_limit_notification_prune_history_ran_at_idx").on(table.ranAt),
  ],
);

// Internal-only audit log — no client-facing validation needed, so we
// rely on Drizzle's $inferInsert rather than a Zod schema. (drizzle-zod's
// createInsertSchema().omit({...}) chokes on
// `bigint(...).generatedAlwaysAsIdentity()` primary keys, hence the direct
// inferred type here.)
export type InsertRateLimitNotificationPruneHistory =
  typeof rateLimitNotificationPruneHistory.$inferInsert;
export type RateLimitNotificationPruneHistory =
  typeof rateLimitNotificationPruneHistory.$inferSelect;
