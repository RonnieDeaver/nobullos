import { bigint, pgTable, text, varchar } from "drizzle-orm/pg-core";

export const blockedIps = pgTable("blocked_ips", {
  ip: varchar("ip", { length: 64 }).primaryKey(),
  blockedAt: bigint("blocked_at", { mode: "number" }).notNull(),
  reason: text("reason"),
  expiresAt: bigint("expires_at", { mode: "number" }),
});

export type BlockedIpRecord = typeof blockedIps.$inferSelect;
export type InsertBlockedIp = typeof blockedIps.$inferInsert;
