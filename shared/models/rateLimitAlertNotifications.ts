import { sql } from "drizzle-orm";
import { bigint, integer, jsonb, pgTable, text, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Persistent log of rate-limit warning notification attempts (Slack / email).
// One row per channel per attempt. Retention is enforced by a daily scheduled
// background prune in `server/services/rateLimitNotificationRetention.ts`.
// Retention is admin-configurable via the `rate_limit_notification_retention_days`
// system setting (managed in the Notification History admin card), and falls back
// to the RATE_LIMIT_NOTIFICATION_RETENTION_DAYS env var, then 30 days.
export const rateLimitAlertNotifications = pgTable("rate_limit_alert_notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  channel: varchar("channel", { length: 16 }).notNull(),
  destination: text("destination").notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  errorMessage: text("error_message"),
  userId: varchar("user_id"),
  userLabel: text("user_label"),
  category: varchar("category", { length: 64 }).notNull(),
  count: integer("count").notNull(),
  maxRequests: integer("max_requests").notNull(),
  warningPercent: integer("warning_percent").notNull(),
  windowMs: bigint("window_ms", { mode: "number" }).notNull(),
  windowStart: bigint("window_start", { mode: "number" }).notNull(),
  triggeredAt: bigint("triggered_at", { mode: "number" }).notNull(),
  attemptedAt: bigint("attempted_at", { mode: "number" }).notNull(),
  alert: jsonb("alert"),
  triggerSource: varchar("trigger_source", { length: 16 }).notNull().default("scheduled"),
  triggerActorId: varchar("trigger_actor_id"),
  // Canonical delivery-outcome fields shared by all channels and resend paths.
  // `latencyMs` is the wall-clock time the dispatch took (null when skipped
  // before any send was attempted). `attemptNumber` is 1 for the first send
  // and increments each time the same alert is resent through the canonical
  // retry path (per-row, bulk, or background auto-retry). `parentNotificationId`
  // points at the original (attempt 1) row so a whole retry chain can be
  // reconstructed and deduped against.
  latencyMs: integer("latency_ms"),
  attemptNumber: integer("attempt_number").notNull().default(1),
  parentNotificationId: varchar("parent_notification_id"),
});

export const insertRateLimitAlertNotificationSchema = createInsertSchema(
  rateLimitAlertNotifications,
).omit({ id: true });

export type InsertRateLimitAlertNotification = z.infer<typeof insertRateLimitAlertNotificationSchema>;
export type RateLimitAlertNotification = typeof rateLimitAlertNotifications.$inferSelect;
