import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";
import { clients } from "./clients";

// ─── Channel types ──────────────────────────────────────────────────────────
export const commsChannelTypes = ["channel", "dm", "group_dm"] as const;
export type CommsChannelType = (typeof commsChannelTypes)[number];

export const commsChannelVisibilities = ["public", "private"] as const;
export type CommsChannelVisibility = (typeof commsChannelVisibilities)[number];

export const commsMessageContentTypes = ["text", "system", "bot"] as const;
export type CommsMessageContentType = (typeof commsMessageContentTypes)[number];

export const commsCallStatuses = ["active", "ended"] as const;
export type CommsCallStatus = (typeof commsCallStatuses)[number];

export const commsClientTagMethods = ["channel_bound", "mention", "suggestion"] as const;
export type CommsClientTagMethod = (typeof commsClientTagMethods)[number];

// ─── comms_channels ─────────────────────────────────────────────────────────
export const commsChannels = pgTable(
  "comms_channels",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 80 }),
    slug: varchar("slug", { length: 80 }),
    type: varchar("type", { length: 16 }).notNull().default("channel"),
    visibility: varchar("visibility", { length: 16 }).notNull().default("public"),
    topic: text("topic"),
    description: text("description"),
    clientId: varchar("client_id").references(() => clients.id, { onDelete: "set null" }),
    createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    slugIdx: index("comms_channels_slug_idx").on(t.slug),
    clientIdx: index("comms_channels_client_id_idx").on(t.clientId),
    typeIdx: index("comms_channels_type_idx").on(t.type),
    uniqueActiveClient: uniqueIndex("comms_channels_unique_active_client")
      .on(t.clientId)
      .where(sql`client_id IS NOT NULL AND archived_at IS NULL`),
  }),
);

export const insertCommsChannelSchema = createInsertSchema(commsChannels, {
  type: z.enum(commsChannelTypes).optional(),
  visibility: z.enum(commsChannelVisibilities).optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertCommsChannel = z.infer<typeof insertCommsChannelSchema>;
export type CommsChannel = typeof commsChannels.$inferSelect;

// ─── comms_channel_members ──────────────────────────────────────────────────
export const commsChannelMembers = pgTable(
  "comms_channel_members",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    channelId: varchar("channel_id")
      .notNull()
      .references(() => commsChannels.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull().default("member"),
    mutedAt: timestamp("muted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqueMember: unique("comms_channel_members_unique").on(t.channelId, t.userId),
    channelIdx: index("comms_channel_members_channel_id_idx").on(t.channelId),
    userIdx: index("comms_channel_members_user_id_idx").on(t.userId),
  }),
);

export const insertCommsChannelMemberSchema = createInsertSchema(commsChannelMembers).omit({
  id: true,
  createdAt: true,
});

export type InsertCommsChannelMember = z.infer<typeof insertCommsChannelMemberSchema>;
export type CommsChannelMember = typeof commsChannelMembers.$inferSelect;

// ─── comms_messages ─────────────────────────────────────────────────────────
export const commsMessages = pgTable(
  "comms_messages",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    channelId: varchar("channel_id")
      .notNull()
      .references(() => commsChannels.id, { onDelete: "cascade" }),
    userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }),
    parentId: varchar("parent_id"),
    content: text("content").notNull().default(""),
    contentType: varchar("content_type", { length: 16 }).notNull().default("text"),
    editedAt: timestamp("edited_at"),
    deletedAt: timestamp("deleted_at"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    channelIdx: index("comms_messages_channel_id_idx").on(t.channelId),
    channelCreatedIdx: index("comms_messages_channel_created_idx").on(
      t.channelId,
      t.createdAt,
    ),
    parentIdx: index("comms_messages_parent_id_idx").on(t.parentId),
    userIdx: index("comms_messages_user_id_idx").on(t.userId),
  }),
);

export const insertCommsMessageSchema = createInsertSchema(commsMessages, {
  contentType: z.enum(commsMessageContentTypes).optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertCommsMessage = z.infer<typeof insertCommsMessageSchema>;
export type CommsMessage = typeof commsMessages.$inferSelect;

// ─── comms_reactions ────────────────────────────────────────────────────────
export const commsReactions = pgTable(
  "comms_reactions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    messageId: varchar("message_id")
      .notNull()
      .references(() => commsMessages.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: varchar("emoji", { length: 64 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqueReaction: unique("comms_reactions_unique").on(t.messageId, t.userId, t.emoji),
    messageIdx: index("comms_reactions_message_id_idx").on(t.messageId),
  }),
);

export const insertCommsReactionSchema = createInsertSchema(commsReactions).omit({
  id: true,
  createdAt: true,
});

export type InsertCommsReaction = z.infer<typeof insertCommsReactionSchema>;
export type CommsReaction = typeof commsReactions.$inferSelect;

// ─── comms_read_states ──────────────────────────────────────────────────────
export const commsReadStates = pgTable(
  "comms_read_states",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    channelId: varchar("channel_id")
      .notNull()
      .references(() => commsChannels.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadMessageId: varchar("last_read_message_id"),
    lastReadAt: timestamp("last_read_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqueState: unique("comms_read_states_unique").on(t.channelId, t.userId),
    channelIdx: index("comms_read_states_channel_id_idx").on(t.channelId),
    userIdx: index("comms_read_states_user_id_idx").on(t.userId),
  }),
);

export const insertCommsReadStateSchema = createInsertSchema(commsReadStates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCommsReadState = z.infer<typeof insertCommsReadStateSchema>;
export type CommsReadState = typeof commsReadStates.$inferSelect;

// ─── comms_calls ────────────────────────────────────────────────────────────
export const commsCalls = pgTable(
  "comms_calls",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    channelId: varchar("channel_id")
      .notNull()
      .references(() => commsChannels.id, { onDelete: "cascade" }),
    initiatedBy: varchar("initiated_by").references(() => users.id, { onDelete: "set null" }),
    livekitRoomName: varchar("livekit_room_name", { length: 256 }),
    callType: varchar("call_type", { length: 16 }).notNull().default("voice"),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    participantsJson: jsonb("participants_json").$type<
      Array<{ userId: string; joinedAt: string; leftAt?: string }>
    >(),
    systemMessageId: varchar("system_message_id"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
    durationSeconds: integer("duration_seconds"),
    recordingEgressId: varchar("recording_egress_id", { length: 256 }),
    recordingStatus: varchar("recording_status", { length: 32 }),
    recordingObjectKey: varchar("recording_object_key", { length: 512 }),
    recordingTransitKey: varchar("recording_transit_key", { length: 512 }),
    recordingDurationSeconds: integer("recording_duration_seconds"),
    recordingFileSizeBytes: integer("recording_file_size_bytes"),
    recordingCompletedAt: timestamp("recording_completed_at"),
    recordingError: varchar("recording_error", { length: 512 }),
    recordingSystemMessageId: varchar("recording_system_message_id", { length: 256 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    channelIdx: index("comms_calls_channel_id_idx").on(t.channelId),
    statusIdx: index("comms_calls_status_idx").on(t.status),
  }),
);

export const insertCommsCallSchema = createInsertSchema(commsCalls, {
  status: z.enum(commsCallStatuses).optional(),
}).omit({ id: true, createdAt: true });

export type InsertCommsCall = z.infer<typeof insertCommsCallSchema>;
export type CommsCall = typeof commsCalls.$inferSelect;

// ─── comms_message_client_tags ──────────────────────────────────────────────
export const commsMessageClientTags = pgTable(
  "comms_message_client_tags",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    messageId: varchar("message_id")
      .notNull()
      .references(() => commsMessages.id, { onDelete: "cascade" }),
    clientId: varchar("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    tagMethod: varchar("tag_method", { length: 32 }).notNull().default("mention"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqueTag: unique("comms_message_client_tags_unique").on(t.messageId, t.clientId),
    messageIdx: index("comms_message_client_tags_message_idx").on(t.messageId),
    clientIdx: index("comms_message_client_tags_client_idx").on(t.clientId),
  }),
);

export const insertCommsMessageClientTagSchema = createInsertSchema(commsMessageClientTags, {
  tagMethod: z.enum(commsClientTagMethods).optional(),
}).omit({ id: true, createdAt: true });

export type InsertCommsMessageClientTag = z.infer<typeof insertCommsMessageClientTagSchema>;
export type CommsMessageClientTag = typeof commsMessageClientTags.$inferSelect;

// ─── comms_attachments ───────────────────────────────────────────────────────
export const commsAttachments = pgTable(
  "comms_attachments",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    messageId: varchar("message_id")
      .notNull()
      .references(() => commsMessages.id, { onDelete: "cascade" }),
    uploadedBy: varchar("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    objectKey: varchar("object_key", { length: 512 }).notNull(),
    thumbnailKey: varchar("thumbnail_key", { length: 512 }),
    filename: varchar("filename", { length: 512 }).notNull(),
    contentType: varchar("content_type", { length: 128 }).notNull().default("application/octet-stream"),
    sizeBytes: integer("size_bytes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    messageIdx: index("comms_attachments_message_id_idx").on(t.messageId),
    uploaderIdx: index("comms_attachments_uploaded_by_idx").on(t.uploadedBy),
  }),
);

export const insertCommsAttachmentSchema = createInsertSchema(commsAttachments).omit({
  id: true,
  createdAt: true,
});
export type InsertCommsAttachment = z.infer<typeof insertCommsAttachmentSchema>;
export type CommsAttachment = typeof commsAttachments.$inferSelect;

// ─── comms_link_previews ─────────────────────────────────────────────────────
// Server-cached OpenGraph / Twitter-card unfurl results.
// One row per canonical URL; stale rows are re-fetched after cached_until.
export const commsLinkPreviews = pgTable(
  "comms_link_previews",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    url: text("url").notNull(),
    title: text("title"),
    description: text("description"),
    imageUrl: text("image_url"),
    siteName: text("site_name"),
    faviconUrl: text("favicon_url"),
    error: text("error"),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
    cachedUntil: timestamp("cached_until").notNull().default(sql`now() + INTERVAL '24 hours'`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    urlIdx: uniqueIndex("comms_link_previews_url_idx").on(t.url),
    cachedUntilIdx: index("comms_link_previews_cached_until_idx").on(t.cachedUntil),
  }),
);

export const insertCommsLinkPreviewSchema = createInsertSchema(commsLinkPreviews).omit({
  id: true,
  createdAt: true,
});
export type InsertCommsLinkPreview = z.infer<typeof insertCommsLinkPreviewSchema>;
export type CommsLinkPreview = typeof commsLinkPreviews.$inferSelect;

// ─── comms_notification_prefs ────────────────────────────────────────────────
export const commsNotificationPrefs = pgTable(
  "comms_notification_prefs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    channelId: varchar("channel_id")
      .notNull()
      .references(() => commsChannels.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pref: varchar("pref", { length: 16 }).notNull().default("all"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    uniquePref: unique("comms_notification_prefs_unique").on(t.channelId, t.userId),
    channelIdx: index("comms_notification_prefs_channel_id_idx").on(t.channelId),
    userIdx: index("comms_notification_prefs_user_id_idx").on(t.userId),
  }),
);

export const insertCommsNotificationPrefSchema = createInsertSchema(commsNotificationPrefs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCommsNotificationPref = z.infer<typeof insertCommsNotificationPrefSchema>;
export type CommsNotificationPref = typeof commsNotificationPrefs.$inferSelect;

// ─── comms_pinned_messages ───────────────────────────────────────────────────
export const commsPinnedMessages = pgTable(
  "comms_pinned_messages",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    channelId: varchar("channel_id")
      .notNull()
      .references(() => commsChannels.id, { onDelete: "cascade" }),
    messageId: varchar("message_id")
      .notNull()
      .references(() => commsMessages.id, { onDelete: "cascade" }),
    pinnedBy: varchar("pinned_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    uniquePin: unique("comms_pinned_messages_unique").on(t.channelId, t.messageId),
    channelIdx: index("comms_pinned_messages_channel_id_idx").on(t.channelId),
  }),
);

export const insertCommsPinnedMessageSchema = createInsertSchema(commsPinnedMessages).omit({
  id: true,
  createdAt: true,
});
export type InsertCommsPinnedMessage = z.infer<typeof insertCommsPinnedMessageSchema>;
export type CommsPinnedMessage = typeof commsPinnedMessages.$inferSelect;

// ─── comms_saved_messages ────────────────────────────────────────────────────
export const commsSavedMessages = pgTable(
  "comms_saved_messages",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageId: varchar("message_id")
      .notNull()
      .references(() => commsMessages.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqueSave: unique("comms_saved_messages_unique").on(t.userId, t.messageId),
    userIdx: index("comms_saved_messages_user_id_idx").on(t.userId),
  }),
);

export const insertCommsSavedMessageSchema = createInsertSchema(commsSavedMessages).omit({
  id: true,
  createdAt: true,
});
export type InsertCommsSavedMessage = z.infer<typeof insertCommsSavedMessageSchema>;
export type CommsSavedMessage = typeof commsSavedMessages.$inferSelect;

// ─── comms_user_statuses ─────────────────────────────────────────────────────
// Persisted manual status, DND expiry, and custom status per user.
// Effective status = manual override → auto-away (heartbeat-derived) → offline.

export const commsManualStatuses = ["online", "away", "dnd", "offline"] as const;
export type CommsManualStatus = (typeof commsManualStatuses)[number];

export const commsUserStatuses = pgTable("comms_user_statuses", {
  userId: varchar("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  manualStatus: varchar("manual_status", { length: 16 }).$type<CommsManualStatus>(),
  dndExpiresAt: timestamp("dnd_expires_at"),
  priorStatus: varchar("prior_status", { length: 16 }).$type<CommsManualStatus>(),
  customEmoji: varchar("custom_emoji", { length: 64 }),
  customText: varchar("custom_text", { length: 100 }),
  customExpiresAt: timestamp("custom_expires_at"),
  recentCustomStatuses: jsonb("recent_custom_statuses")
    .$type<Array<{ emoji: string; text: string }>>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  lastActivityAt: timestamp("last_activity_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCommsUserStatusSchema = createInsertSchema(commsUserStatuses, {
  manualStatus: z.enum(commsManualStatuses).nullable().optional(),
  priorStatus: z.enum(commsManualStatuses).nullable().optional(),
}).omit({ updatedAt: true });

export type InsertCommsUserStatus = z.infer<typeof insertCommsUserStatusSchema>;
export type CommsUserStatus = typeof commsUserStatuses.$inferSelect;

// ─── comms_drafts ───────────────────────────────────────────────────────────
export const commsDrafts = pgTable(
  "comms_drafts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: varchar("channel_id")
      .notNull()
      .references(() => commsChannels.id, { onDelete: "cascade" }),
    parentId: varchar("parent_id"),
    content: text("content").notNull().default(""),
    metadata: jsonb("metadata"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("comms_drafts_user_id_idx").on(t.userId),
    channelIdx: index("comms_drafts_channel_id_idx").on(t.channelId),
  }),
);

export const insertCommsDraftSchema = createInsertSchema(commsDrafts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCommsDraft = z.infer<typeof insertCommsDraftSchema>;
export type CommsDraft = typeof commsDrafts.$inferSelect;

// ─── comms_scheduled_messages ───────────────────────────────────────────────
export const commsScheduledMessageStatuses = [
  "pending",
  "delivering",
  "delivered",
  "failed",
  "cancelled",
] as const;
export type CommsScheduledMessageStatus = (typeof commsScheduledMessageStatuses)[number];

export const commsScheduledMessages = pgTable(
  "comms_scheduled_messages",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: varchar("channel_id")
      .notNull()
      .references(() => commsChannels.id, { onDelete: "cascade" }),
    parentId: varchar("parent_id"),
    content: text("content").notNull(),
    metadata: jsonb("metadata"),
    scheduledFor: timestamp("scheduled_for").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    errorMessage: text("error_message"),
    deliveredMessageId: varchar("delivered_message_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("comms_scheduled_messages_user_id_idx").on(t.userId),
    channelIdx: index("comms_scheduled_messages_channel_id_idx").on(t.channelId),
    dueIdx: index("comms_scheduled_messages_due_idx").on(t.status, t.scheduledFor),
  }),
);

export const insertCommsScheduledMessageSchema = createInsertSchema(commsScheduledMessages, {
  status: z.enum(commsScheduledMessageStatuses).optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCommsScheduledMessage = z.infer<typeof insertCommsScheduledMessageSchema>;
export type CommsScheduledMessage = typeof commsScheduledMessages.$inferSelect;

// ─── comms_webhooks ──────────────────────────────────────────────────────────
// Incoming webhooks — token-authenticated POST endpoints for each channel.
// Raw tokens are never stored; only their SHA-256 hex hash is persisted.
export const commsWebhooks = pgTable(
  "comms_webhooks",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    channelId: varchar("channel_id")
      .notNull()
      .references(() => commsChannels.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull().default("Incoming Webhook"),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
    enabled: boolean("enabled").notNull().default(true),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex("comms_webhooks_token_hash_idx").on(t.tokenHash),
    channelIdx: index("comms_webhooks_channel_id_idx").on(t.channelId),
    createdByIdx: index("comms_webhooks_created_by_idx").on(t.createdBy),
  }),
);

export const insertCommsWebhookSchema = createInsertSchema(commsWebhooks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCommsWebhook = z.infer<typeof insertCommsWebhookSchema>;
export type CommsWebhook = typeof commsWebhooks.$inferSelect;

// ─── comms_user_notification_settings ────────────────────────────────────────
// Per-user global notification preferences and personal keyword watch list.
// One row per user; absent row = all defaults.
//
// global_default: fallback when no per-channel pref is set
//   "all"      → all messages → desktop notification + sound
//   "mentions" → only @mentions + keyword hits → desktop notification + sound
//   "nothing"  → suppress desktop notifications (unread badge still appears)
//
// keywords: JSON array of strings; case-insensitive word-boundary matched
// at write time (server) and message-arrival time (client, for desktop alerts).

export const commsGlobalNotifDefaults = ["all", "mentions", "nothing"] as const;
export type CommsGlobalNotifDefault = (typeof commsGlobalNotifDefaults)[number];

export const commsNotifSoundChoices = ["default", "ding", "subtle"] as const;
export type CommsNotifSoundChoice = (typeof commsNotifSoundChoices)[number];

export const commsUserNotificationSettings = pgTable("comms_user_notification_settings", {
  userId: varchar("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  globalDefault: varchar("global_default", { length: 16 })
    .notNull()
    .$type<CommsGlobalNotifDefault>()
    .default("all"),
  soundEnabled: boolean("sound_enabled").notNull().default(true),
  soundChoice: varchar("sound_choice", { length: 32 })
    .notNull()
    .$type<CommsNotifSoundChoice>()
    .default("default"),
  desktopEnabled: boolean("desktop_enabled").notNull().default(false),
  suppressSnippetPrivate: boolean("suppress_snippet_private").notNull().default(false),
  keywords: jsonb("keywords").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCommsUserNotificationSettingsSchema = createInsertSchema(
  commsUserNotificationSettings,
  {
    globalDefault: z.enum(commsGlobalNotifDefaults).optional(),
    soundChoice: z.enum(commsNotifSoundChoices).optional(),
    keywords: z.array(z.string().max(80)).max(50).optional(),
  },
).omit({ updatedAt: true });

export type InsertCommsUserNotificationSettings = z.infer<
  typeof insertCommsUserNotificationSettingsSchema
>;
export type CommsUserNotificationSettings =
  typeof commsUserNotificationSettings.$inferSelect;

// ─── comms_bookmarks ────────────────────────────────────────────────────────
// Per-channel bookmarks bar — persistent, ordered list of link or file shortcuts.
// Members can add; channel_admin / team_lead can edit, delete, and reorder.

export const commsBookmarkTypes = ["link", "file"] as const;
export type CommsBookmarkType = (typeof commsBookmarkTypes)[number];

export const commsBookmarks = pgTable(
  "comms_bookmarks",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    channelId: varchar("channel_id")
      .notNull()
      .references(() => commsChannels.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 16 }).notNull().default("link"),
    label: varchar("label", { length: 200 }).notNull(),
    emoji: varchar("emoji", { length: 64 }),
    url: text("url"),
    attachmentId: varchar("attachment_id").references(() => commsAttachments.id, {
      onDelete: "set null",
    }),
    objectKey: varchar("object_key", { length: 512 }),
    filename: varchar("filename", { length: 512 }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    channelIdx: index("comms_bookmarks_channel_id_idx").on(t.channelId),
    channelOrderIdx: index("comms_bookmarks_channel_order_idx").on(t.channelId, t.sortOrder),
    createdByIdx: index("comms_bookmarks_created_by_idx").on(t.createdBy),
  }),
);

export const insertCommsBookmarkSchema = createInsertSchema(commsBookmarks, {
  type: z.enum(commsBookmarkTypes).optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertCommsBookmark = z.infer<typeof insertCommsBookmarkSchema>;
export type CommsBookmark = typeof commsBookmarks.$inferSelect;

// ─── comms_thread_members ───────────────────────────────────────────────────
// Per-user thread follow records. Auto-created when a user starts or replies to
// a thread, or is @mentioned inside one. `following` can be flipped manually.
// `last_read_reply_at` drives per-thread unread reply counts.

export const commsThreadMembers = pgTable(
  "comms_thread_members",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    rootMessageId: varchar("root_message_id").notNull(),
    channelId: varchar("channel_id")
      .notNull()
      .references(() => commsChannels.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    following: boolean("following").notNull().default(true),
    lastReadReplyAt: timestamp("last_read_reply_at").notNull().default(sql`to_timestamp(0)`),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqueMember: unique("comms_thread_members_unique").on(t.rootMessageId, t.userId),
    userIdx: index("comms_thread_members_user_id_idx").on(t.userId),
    rootMsgIdx: index("comms_thread_members_root_message_id_idx").on(t.rootMessageId),
    channelIdx: index("comms_thread_members_channel_id_idx").on(t.channelId),
  }),
);

export const insertCommsThreadMemberSchema = createInsertSchema(commsThreadMembers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCommsThreadMember = z.infer<typeof insertCommsThreadMemberSchema>;
export type CommsThreadMember = typeof commsThreadMembers.$inferSelect;


// ─── comms_message_edit_history ─────────────────────────────────────────────
// Stores a snapshot of the prior content before each edit (including restores).
// Version 1 = snapshot saved before the FIRST edit on a message; each subsequent
// edit increments version.  Author + team leads may view and restore.

export const commsMessageEditHistory = pgTable(
  "comms_message_edit_history",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    messageId: varchar("message_id")
      .notNull()
      .references(() => commsMessages.id, { onDelete: "cascade" }),
    editorId: varchar("editor_id").references(() => users.id, { onDelete: "set null" }),
    priorContent: text("prior_content").notNull().default(""),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    msgIdx: index("comms_msg_edit_history_msg_idx").on(t.messageId),
    editorIdx: index("comms_msg_edit_history_editor_idx").on(t.editorId),
  }),
);

export const insertCommsMessageEditHistorySchema = createInsertSchema(commsMessageEditHistory).omit({
  id: true,
  createdAt: true,
});
export type InsertCommsMessageEditHistory = z.infer<typeof insertCommsMessageEditHistorySchema>;
export type CommsMessageEditHistory = typeof commsMessageEditHistory.$inferSelect;

// ─── comms_message_reminders ─────────────────────────────────────────────────
// Per-user "remind me about this" records.  status: pending | delivered | cancelled.
// A work-queue job (`comms_reminder_deliver`) claims due rows and fans out via
// notifyUser() with a permalink back to the message.

export const commsReminderStatuses = ["pending", "delivered", "cancelled"] as const;
export type CommsReminderStatus = (typeof commsReminderStatuses)[number];

export const commsMessageReminders = pgTable(
  "comms_message_reminders",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageId: varchar("message_id")
      .notNull()
      .references(() => commsMessages.id, { onDelete: "cascade" }),
    channelId: varchar("channel_id")
      .notNull()
      .references(() => commsChannels.id, { onDelete: "cascade" }),
    note: text("note"),
    remindAt: timestamp("remind_at").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("comms_reminders_user_idx").on(t.userId),
    dueIdx: index("comms_reminders_due_idx").on(t.status, t.remindAt),
    msgIdx: index("comms_reminders_message_idx").on(t.messageId),
  }),
);

export const insertCommsMessageReminderSchema = createInsertSchema(commsMessageReminders, {
  status: z.enum(commsReminderStatuses).optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCommsMessageReminder = z.infer<typeof insertCommsMessageReminderSchema>;
export type CommsMessageReminder = typeof commsMessageReminders.$inferSelect;

// ─── comms_presence ─────────────────────────────────────────────────────────
// Lightweight in-memory presence is handled by server/services/commsPresence.ts.
// Heartbeat TTL determines online/offline; comms_user_statuses holds overrides.

// ─── comms_typing ───────────────────────────────────────────────────────────
// Typing indicators are SSE-only (no persistence needed).

// ─── comms_sidebar_categories ───────────────────────────────────────────────
// Per-user sidebar organization modeled after Mattermost's sidebar-categories
// API (GET/POST/PUT/DELETE /users/{id}/teams/{id}/channels/categories).
// Built-in types: favorites (rendered first), channels, dms.
// Custom categories are user-created with user-controlled sort_order.

export const commsSidebarCategoryTypes = ["favorites", "channels", "dms", "custom"] as const;
export type CommsSidebarCategoryType = (typeof commsSidebarCategoryTypes)[number];

export const commsSidebarSortings = ["recent", "alpha", "manual"] as const;
export type CommsSidebarSorting = (typeof commsSidebarSortings)[number];

export const commsSidebarCategories = pgTable(
  "comms_sidebar_categories",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    type: varchar("type", { length: 16 }).notNull().default("custom"),
    sortOrder: integer("sort_order").notNull().default(0),
    collapsed: boolean("collapsed").notNull().default(false),
    clientSubgroupCollapsed: boolean("client_subgroup_collapsed").notNull().default(true),
    sorting: varchar("sorting", { length: 16 }).notNull().default("recent"),
    unreadsOnTop: boolean("unreads_on_top").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("comms_sidebar_categories_user_id_idx").on(t.userId),
    userTypeIdx: uniqueIndex("comms_sidebar_categories_user_type_idx")
      .on(t.userId, t.type)
      .where(sql`type IN ('favorites', 'channels', 'dms')`),
  }),
);

export const insertCommsSidebarCategorySchema = createInsertSchema(commsSidebarCategories, {
  type: z.enum(commsSidebarCategoryTypes).optional(),
  sorting: z.enum(commsSidebarSortings).optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertCommsSidebarCategory = z.infer<typeof insertCommsSidebarCategorySchema>;
export type CommsSidebarCategory = typeof commsSidebarCategories.$inferSelect;

// ─── comms_sidebar_category_items ───────────────────────────────────────────
// Ordered channel membership within a sidebar category.
// Channels not explicitly in any category fall into the default buckets
// (channels / dms) at render time — no row needed for the default state.

export const commsSidebarCategoryItems = pgTable(
  "comms_sidebar_category_items",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    categoryId: varchar("category_id")
      .notNull()
      .references(() => commsSidebarCategories.id, { onDelete: "cascade" }),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: varchar("channel_id")
      .notNull()
      .references(() => commsChannels.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqueItem: unique("comms_sidebar_category_items_unique").on(t.categoryId, t.channelId),
    categoryIdx: index("comms_sidebar_category_items_category_id_idx").on(t.categoryId),
    userIdx: index("comms_sidebar_category_items_user_id_idx").on(t.userId),
    channelIdx: index("comms_sidebar_category_items_channel_id_idx").on(t.channelId),
  }),
);

export const insertCommsSidebarCategoryItemSchema = createInsertSchema(
  commsSidebarCategoryItems,
).omit({ id: true, createdAt: true });

export type InsertCommsSidebarCategoryItem = z.infer<typeof insertCommsSidebarCategoryItemSchema>;
export type CommsSidebarCategoryItem = typeof commsSidebarCategoryItems.$inferSelect;

// ─── comms_custom_emoji ──────────────────────────────────────────────────────
// Team-wide custom emoji.  Images live in private object storage and are
// served through an authenticated route with immutable cache headers.
// name: unique, [a-zA-Z0-9_-], 2–64 chars.
export const commsCustomEmoji = pgTable(
  "comms_custom_emoji",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 64 }).notNull(),
    objectKey: varchar("object_key", { length: 512 }).notNull(),
    contentType: varchar("content_type", { length: 64 }).notNull().default("image/png"),
    sizeBytes: integer("size_bytes"),
    createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    nameIdx: uniqueIndex("comms_custom_emoji_name_idx").on(t.name),
    createdByIdx: index("comms_custom_emoji_created_by_idx").on(t.createdBy),
  }),
);

export const insertCommsCustomEmojiSchema = createInsertSchema(commsCustomEmoji).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCommsCustomEmoji = z.infer<typeof insertCommsCustomEmojiSchema>;
export type CommsCustomEmoji = typeof commsCustomEmoji.$inferSelect;

// ─── comms_emoji_usage ───────────────────────────────────────────────────────
// Per-user emoji usage counts for the "Frequently Used" row in the picker.
// emoji stores the raw emoji character or ":name:" for custom emoji.
export const commsEmojiUsage = pgTable(
  "comms_emoji_usage",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: varchar("emoji", { length: 64 }).notNull(),
    useCount: integer("use_count").notNull().default(1),
    lastUsedAt: timestamp("last_used_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqueUsage: unique("comms_emoji_usage_unique").on(t.userId, t.emoji),
    userIdx: index("comms_emoji_usage_user_idx").on(t.userId),
    lastUsedIdx: index("comms_emoji_usage_last_used_idx").on(t.userId, t.lastUsedAt),
  }),
);

export const insertCommsEmojiUsageSchema = createInsertSchema(commsEmojiUsage).omit({
  id: true,
});
export type InsertCommsEmojiUsage = z.infer<typeof insertCommsEmojiUsageSchema>;
export type CommsEmojiUsage = typeof commsEmojiUsage.$inferSelect;
