import { sql } from "drizzle-orm";
import { bigint, jsonb, pgTable, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const pendingDigestAlerts = pgTable("pending_digest_alerts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  payload: jsonb("payload").notNull(),
  queuedAt: bigint("queued_at", { mode: "number" }).notNull(),
});

export const insertPendingDigestAlertSchema = createInsertSchema(pendingDigestAlerts).omit({
  id: true,
});

export type InsertPendingDigestAlert = z.infer<typeof insertPendingDigestAlertSchema>;
export type PendingDigestAlert = typeof pendingDigestAlerts.$inferSelect;
