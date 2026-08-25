import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";

// ─── Task #1686 — Per-user in-app notification inbox ────────────────────
//
// This is the bell + dropdown + `/notifications` inbox foundation. It is
// independent of the Slack-channel notification system below
// (notification_settings / notification_deliveries) which routes admin
// watcher events into a Slack channel. The two are NEVER mixed: this
// table is per-user inbox; that one is per-event admin routing.
//
// Categories are deliberately broad: Phase 1 ships the primitive; the
// actual event wiring (which call/sms/booking events produce a row) is
// downstream work in Phases 2 and 3.

export const userNotificationCategories = [
  "comms.sms",
  "comms.call",
  "comms.voicemail",
  "booking",
  "mention",
  "assignment",
  "agent",
  "feedback",
  "system",
  "queue_health",
  "service_desk",
  "crm",
] as const;
export type UserNotificationCategory =
  (typeof userNotificationCategories)[number];

export const userNotifications = pgTable(
  "user_notifications",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: varchar("category").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    deepLink: text("deep_link"),
    metadata: jsonb("metadata"),
    dedupeKey: varchar("dedupe_key"),
    readAt: timestamp("read_at"),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    userCreatedIdx: index("user_notifications_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    userCategoryIdx: index("user_notifications_user_category_idx").on(
      table.userId,
      table.category,
    ),
    // Note: the unread/archived partial indexes are created directly in
    // migration 0067 — Drizzle's pg-core does not expose partial-index
    // predicate syntax cleanly, so they are managed there rather than here.
    //
    // The partial UNIQUE index `user_notifications_user_dedupe_unread_uniq`
    // (unique on (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND
    // read_at IS NULL AND archived_at IS NULL) was dropped 2026-05-26 then
    // RE-ADDED via migration 0085. It is the DB-level guarantee behind the
    // app-layer dedupe in userInbox.ts (the `notifyUser` 23505/race
    // fallback is already written for it). Like the other partial indexes
    // it lives in the migration, not here.
    //
    // PROD PUBLISH SEQUENCE (the migration's pre-cleanup DELETE does NOT
    // run on a Replit Publish — only the diffed CREATE UNIQUE INDEX does):
    // run the `dedupe_user_notifications_unread` prod-action (its self-heal
    // also keeps prod near-zero), then Publish. Replit introspects this dev
    // DB — which now carries the index — and creates it on the deduped prod
    // table, so the CREATE succeeds instead of blocking the deploy.
  }),
);

export const insertUserNotificationSchema = createInsertSchema(userNotifications).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  readAt: true,
  archivedAt: true,
});
export type InsertUserNotification = z.infer<typeof insertUserNotificationSchema>;
export type UserNotification = typeof userNotifications.$inferSelect;

export const notificationSettingSources = [
  "notification_settings",
  "legacy_migrated",
  "env_override",
  "default",
  "none",
] as const;
export type NotificationSettingSource = (typeof notificationSettingSources)[number];

export const notificationSettings = pgTable(
  "notification_settings",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    notificationId: varchar("notification_id").notNull().unique(),
    enabled: boolean("enabled").notNull().default(true),
    channelId: varchar("channel_id"),
    channelName: varchar("channel_name"),
    updatedBy: varchar("updated_by").references(() => users.id),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    source: varchar("source").notNull().default("default"),
    metadataJson: jsonb("metadata_json"),
  },
  (table) => ({
    notificationIdIdx: index("notification_settings_notif_idx").on(table.notificationId),
  }),
);

export const insertNotificationSettingSchema = createInsertSchema(notificationSettings).omit({
  id: true,
  updatedAt: true,
  createdAt: true,
});
export type InsertNotificationSetting = z.infer<typeof insertNotificationSettingSchema>;
export type NotificationSetting = typeof notificationSettings.$inferSelect;

export const notificationDeliveryStatuses = [
  "success",
  "failed",
  "skipped_disabled",
  "skipped_no_channel",
  "skipped_deduped",
  "skipped_unknown_id",
  "skipped_slack_disconnected",
  "skipped_killswitch",
] as const;
export type NotificationDeliveryStatus = (typeof notificationDeliveryStatuses)[number];

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    notificationId: varchar("notification_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    channelId: varchar("channel_id"),
    channelName: varchar("channel_name"),
    status: varchar("status").notNull(),
    errorMessage: text("error_message"),
    errorCode: varchar("error_code"),
    slackTs: varchar("slack_ts"),
    payloadPreview: text("payload_preview"),
    triggerSource: varchar("trigger_source"),
    triggerActorId: varchar("trigger_actor_id"),
    dedupeKey: varchar("dedupe_key"),
    metadataJson: jsonb("metadata_json"),
  },
  (table) => ({
    notifCreatedIdx: index("notif_deliveries_notif_created_idx").on(
      table.notificationId,
      table.createdAt,
    ),
    createdIdx: index("notif_deliveries_created_idx").on(table.createdAt),
    statusCreatedIdx: index("notif_deliveries_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    dedupeKeyIdx: index("notif_deliveries_dedupe_key_idx").on(table.dedupeKey),
  }),
);

export const insertNotificationDeliverySchema = createInsertSchema(notificationDeliveries).omit({
  id: true,
  createdAt: true,
});
export type InsertNotificationDelivery = z.infer<typeof insertNotificationDeliverySchema>;
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;

export const notificationHealthState = pgTable(
  "notification_health_state",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    notificationId: varchar("notification_id").notNull(),
    dedupeKey: varchar("dedupe_key").notNull(),
    state: varchar("state").notNull(),
    failureType: varchar("failure_type"),
    transitionedAt: timestamp("transitioned_at").defaultNow().notNull(),
    lastNotifiedAt: timestamp("last_notified_at"),
    occurrenceCount: jsonb("occurrence_count"),
    metadataJson: jsonb("metadata_json"),
  },
  (table) => ({
    uniqNotifKey: index("notification_health_state_notif_key_idx").on(
      table.notificationId,
      table.dedupeKey,
    ),
  }),
);

export type NotificationHealthState = typeof notificationHealthState.$inferSelect;

// ─── Task #1687 — Per-user Slack DM forwarding ─────────────────────────
//
// `user_slack_identities` links a NoBull OS user to their Slack user id.
// The existing Slack app only has a bot token (no per-user OAuth), so
// linking is performed by looking up the user's email via Slack's
// `users.lookupByEmail` endpoint (see docs/notification-phase-2.md and
// the inline note on `linkSlackIdentityByEmail` in
// server/services/notifications/userSlackSender.ts).
//
// `user_notification_preferences` is the per-(user, category) matrix
// controlling whether each notification is delivered in-app and/or as
// a Slack DM. Defaults: in-app=true, slack-dm=false; backfilled lazily
// on first read.

export const userSlackDmStatuses = [
  "success",
  "failed",
  "skipped_killswitch",
  "skipped_no_identity",
  "skipped_disabled",
] as const;
export type UserSlackDmStatus = (typeof userSlackDmStatuses)[number];

export const userSlackIdentities = pgTable(
  "user_slack_identities",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    slackUserId: varchar("slack_user_id").notNull(),
    slackTeamId: varchar("slack_team_id"),
    slackEmail: varchar("slack_email"),
    connectedAt: timestamp("connected_at").defaultNow().notNull(),
    disconnectedAt: timestamp("disconnected_at"),
    lastDmStatus: varchar("last_dm_status"),
    lastDmError: text("last_dm_error"),
    lastDmAt: timestamp("last_dm_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("user_slack_identities_user_idx").on(table.userId),
    slackUserIdx: index("user_slack_identities_slack_user_idx").on(
      table.slackUserId,
    ),
  }),
);

export type UserSlackIdentity = typeof userSlackIdentities.$inferSelect;
export const insertUserSlackIdentitySchema = createInsertSchema(
  userSlackIdentities,
).omit({
  id: true,
  connectedAt: true,
  createdAt: true,
  updatedAt: true,
  disconnectedAt: true,
  lastDmStatus: true,
  lastDmError: true,
  lastDmAt: true,
});
export type InsertUserSlackIdentity = z.infer<typeof insertUserSlackIdentitySchema>;

export const userNotificationPreferences = pgTable(
  "user_notification_preferences",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: varchar("category").notNull(),
    inAppEnabled: boolean("in_app_enabled").notNull().default(true),
    slackDmEnabled: boolean("slack_dm_enabled").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    // The unique index on (user_id, category) is created directly in
    // migration 0068 — drizzle-pg-core's `uniqueIndex` is available but
    // we mirror the pattern used by user_notifications above.
  }),
);

export type UserNotificationPreference =
  typeof userNotificationPreferences.$inferSelect;
export const insertUserNotificationPreferenceSchema = createInsertSchema(
  userNotificationPreferences,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertUserNotificationPreference = z.infer<
  typeof insertUserNotificationPreferenceSchema
>;

