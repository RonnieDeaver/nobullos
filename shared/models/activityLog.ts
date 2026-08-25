import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";

export const userActivityLogs = pgTable(
  "user_activity_logs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").references(() => users.id),
    actionType: varchar("action_type").notNull(),
    route: text("route"),
    actionDetail: text("action_detail"),
    metadata: jsonb("metadata"),
    sessionId: varchar("session_id"),
    duration: integer("duration"),
    timestamp: timestamp("timestamp").notNull().defaultNow(),
  },
  (table) => [
    index("idx_activity_user_id").on(table.userId),
    index("idx_activity_timestamp").on(table.timestamp),
    index("idx_activity_action_type").on(table.actionType),
    index("idx_activity_session_id").on(table.sessionId),
  ]
);

export const insertUserActivityLogSchema = createInsertSchema(userActivityLogs).omit({
  id: true,
});

export type InsertUserActivityLog = z.infer<typeof insertUserActivityLogSchema>;
export type UserActivityLog = typeof userActivityLogs.$inferSelect;
