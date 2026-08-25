import { bigint, index, pgTable, serial, text, varchar } from "drizzle-orm/pg-core";

export const blockedRateLimitEvents = pgTable(
  "blocked_rate_limit_events",
  {
    id: serial("id").primaryKey(),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
    category: varchar("category", { length: 128 }).notNull(),
    method: varchar("method", { length: 16 }).notNull(),
    path: text("path").notNull(),
    ip: varchar("ip", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 128 }),
  },
  (t) => ({
    timestampIdx: index("blocked_rate_limit_events_timestamp_idx").on(t.timestamp),
    userTimestampIdx: index("blocked_rate_limit_events_user_timestamp_idx").on(t.userId, t.timestamp),
    ipTimestampIdx: index("blocked_rate_limit_events_ip_timestamp_idx").on(t.ip, t.timestamp),
  }),
);

export type BlockedRateLimitEventRecord = typeof blockedRateLimitEvents.$inferSelect;
export type InsertBlockedRateLimitEvent = typeof blockedRateLimitEvents.$inferInsert;
