/**
 * Task #2927 — ClickUp in-app module: local mirror schema.
 *
 * All tables are a write-through mirror of the ClickUp workspace state.
 * Reads come from these tables (fast, no API call); writes go to ClickUp
 * first, then update the mirror optimistically.
 *
 * API refs consulted (2026-07-16):
 *   developer.clickup.com/docs/authentication
 *   developer.clickup.com/docs/rate-limits
 *   developer.clickup.com/docs/webhooks
 *   developer.clickup.com/docs/general-v2-v3-api
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─── Per-user OAuth tokens ────────────────────────────────────────────────────

export const clickupUserTokens = pgTable(
  "clickup_user_tokens",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").notNull().unique(),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    clickupUserId: varchar("clickup_user_id"),
    clickupUsername: varchar("clickup_username"),
    clickupEmail: varchar("clickup_email"),
    workspaceId: varchar("workspace_id"),
    // Every workspace the user checked on ClickUp's authorization screen
    // ([{ id, name }]). workspace_id above remains the first/primary one.
    authorizedWorkspaces: jsonb("authorized_workspaces"),
    status: varchar("status").notNull().default("connected"),
    lastRefreshAt: timestamp("last_refresh_at"),
    lastError: text("last_error"),
    connectedAt: timestamp("connected_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: uniqueIndex("clickup_user_tokens_user_id_idx").on(t.userId),
  }),
);

export const insertClickupUserTokenSchema = createInsertSchema(
  clickupUserTokens,
).omit({ id: true, connectedAt: true, updatedAt: true });
export type InsertClickupUserToken = z.infer<typeof insertClickupUserTokenSchema>;
export type ClickupUserToken = typeof clickupUserTokens.$inferSelect;

// ─── Workspaces ───────────────────────────────────────────────────────────────

export const clickupWorkspaces = pgTable(
  "clickup_workspaces",
  {
    id: varchar("id").primaryKey(),
    name: text("name").notNull(),
    color: varchar("color"),
    avatar: text("avatar"),
    members: jsonb("members"),
    /** ClickUp plan name (e.g. "Business", "Business Plus", "Enterprise").
     *  Populated by GetWorkspacePlan on first load and on each sync.
     *  Drives plan-gated feature notices in the module UI without extra API calls. */
    plan: varchar("plan"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);

export type ClickupWorkspace = typeof clickupWorkspaces.$inferSelect;

// ─── Spaces ───────────────────────────────────────────────────────────────────

export const clickupSpaces = pgTable(
  "clickup_spaces",
  {
    id: varchar("id").primaryKey(),
    workspaceId: varchar("workspace_id").notNull(),
    name: text("name").notNull(),
    color: varchar("color"),
    private: boolean("private").default(false),
    statuses: jsonb("statuses"),
    features: jsonb("features"),
    archived: boolean("archived").default(false),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdx: index("clickup_spaces_workspace_idx").on(t.workspaceId),
  }),
);

export type ClickupSpace = typeof clickupSpaces.$inferSelect;

// ─── Folders ──────────────────────────────────────────────────────────────────

export const clickupFolders = pgTable(
  "clickup_folders",
  {
    id: varchar("id").primaryKey(),
    spaceId: varchar("space_id").notNull(),
    name: text("name").notNull(),
    orderIndex: doublePrecision("order_index"),
    override_statuses: boolean("override_statuses"),
    hidden: boolean("hidden").default(false),
    archived: boolean("archived").default(false),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    spaceIdx: index("clickup_folders_space_idx").on(t.spaceId),
  }),
);

export type ClickupFolder = typeof clickupFolders.$inferSelect;

// ─── Lists ────────────────────────────────────────────────────────────────────

export const clickupLists = pgTable(
  "clickup_lists",
  {
    id: varchar("id").primaryKey(),
    folderId: varchar("folder_id"),
    spaceId: varchar("space_id").notNull(),
    name: text("name").notNull(),
    orderIndex: doublePrecision("order_index"),
    content: text("content"),
    status: varchar("status"),
    priority: integer("priority"),
    assignee: jsonb("assignee"),
    taskCount: integer("task_count"),
    dueDate: varchar("due_date"),
    startDate: varchar("start_date"),
    space: jsonb("space"),
    archived: boolean("archived").default(false),
    overrideStatuses: boolean("override_statuses"),
    statuses: jsonb("statuses"),
    permissionLevel: varchar("permission_level"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    spaceIdx: index("clickup_lists_space_idx").on(t.spaceId),
    folderIdx: index("clickup_lists_folder_idx").on(t.folderId),
  }),
);

export type ClickupList = typeof clickupLists.$inferSelect;

// ─── Custom fields ────────────────────────────────────────────────────────────

export const clickupCustomFields = pgTable(
  "clickup_custom_fields",
  {
    id: varchar("id").primaryKey(),
    listId: varchar("list_id").notNull(),
    name: text("name").notNull(),
    type: varchar("type").notNull(),
    typeConfig: jsonb("type_config"),
    dateCreated: varchar("date_created"),
    hideFromGuests: boolean("hide_from_guests").default(false),
    required: boolean("required").default(false),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (t) => ({
    listIdx: index("clickup_custom_fields_list_idx").on(t.listId),
  }),
);

export type ClickupCustomField = typeof clickupCustomFields.$inferSelect;

// ─── Tasks ────────────────────────────────────────────────────────────────────

export const clickupTasks = pgTable(
  "clickup_tasks",
  {
    id: varchar("id").primaryKey(),
    listId: varchar("list_id").notNull(),
    folderId: varchar("folder_id"),
    spaceId: varchar("space_id"),
    workspaceId: varchar("workspace_id"),
    parentId: varchar("parent_id"),
    name: text("name").notNull(),
    description: text("description"),
    status: varchar("status"),
    statusColor: varchar("status_color"),
    statusType: varchar("status_type"),
    orderIndex: doublePrecision("order_index"),
    dateCreated: varchar("date_created"),
    dateUpdated: varchar("date_updated"),
    dateDone: varchar("date_done"),
    dueDate: varchar("due_date"),
    startDate: varchar("start_date"),
    priority: integer("priority"),
    priorityName: varchar("priority_name"),
    timeEstimate: integer("time_estimate"),
    timeSpent: integer("time_spent"),
    creator: jsonb("creator"),
    assignees: jsonb("assignees"),
    watchers: jsonb("watchers"),
    tags: jsonb("tags"),
    customFields: jsonb("custom_fields"),
    customType: varchar("custom_type"),
    url: text("url"),
    archived: boolean("archived").default(false),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    listIdx: index("clickup_tasks_list_idx").on(t.listId),
    spaceIdx: index("clickup_tasks_space_idx").on(t.spaceId),
    parentIdx: index("clickup_tasks_parent_idx").on(t.parentId),
    workspaceIdx: index("clickup_tasks_workspace_idx").on(t.workspaceId),
    dateUpdatedIdx: index("clickup_tasks_date_updated_idx").on(t.dateUpdated),
  }),
);

export const insertClickupTaskSchema = createInsertSchema(clickupTasks).omit({
  syncedAt: true,
  updatedAt: true,
});
export type InsertClickupTask = z.infer<typeof insertClickupTaskSchema>;
export type ClickupTask = typeof clickupTasks.$inferSelect;

// ─── Checklists ───────────────────────────────────────────────────────────────

export const clickupChecklists = pgTable(
  "clickup_checklists",
  {
    id: varchar("id").primaryKey(),
    taskId: varchar("task_id").notNull(),
    name: text("name").notNull(),
    orderIndex: integer("order_index"),
    resolved: integer("resolved").default(0),
    unresolved: integer("unresolved").default(0),
    items: jsonb("items"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (t) => ({
    taskIdx: index("clickup_checklists_task_idx").on(t.taskId),
  }),
);

export type ClickupChecklist = typeof clickupChecklists.$inferSelect;

// ─── Comments ─────────────────────────────────────────────────────────────────

export const clickupComments = pgTable(
  "clickup_comments",
  {
    id: varchar("id").primaryKey(),
    taskId: varchar("task_id"),
    listId: varchar("list_id"),
    parentCommentId: varchar("parent_comment_id"),
    comment: jsonb("comment"),
    commentText: text("comment_text"),
    user: jsonb("user"),
    assignee: jsonb("assignee"),
    assignedBy: jsonb("assigned_by"),
    resolved: boolean("resolved").default(false),
    date: varchar("date"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (t) => ({
    taskIdx: index("clickup_comments_task_idx").on(t.taskId),
    listIdx: index("clickup_comments_list_idx").on(t.listId),
  }),
);

export type ClickupComment = typeof clickupComments.$inferSelect;

// ─── Time entries ─────────────────────────────────────────────────────────────

export const clickupTimeEntries = pgTable(
  "clickup_time_entries",
  {
    id: varchar("id").primaryKey(),
    workspaceId: varchar("workspace_id").notNull(),
    taskId: varchar("task_id"),
    userId: varchar("user_id"),
    user: jsonb("user"),
    billable: boolean("billable").default(false),
    start: varchar("start"),
    end: varchar("end"),
    duration: integer("duration"),
    description: text("description"),
    tags: jsonb("tags"),
    at: varchar("at"),
    isRunning: boolean("is_running").default(false),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdx: index("clickup_time_entries_workspace_idx").on(t.workspaceId),
    taskIdx: index("clickup_time_entries_task_idx").on(t.taskId),
    userIdx: index("clickup_time_entries_user_idx").on(t.userId),
  }),
);

export type ClickupTimeEntry = typeof clickupTimeEntries.$inferSelect;

// ─── Goals ────────────────────────────────────────────────────────────────────

export const clickupGoals = pgTable(
  "clickup_goals",
  {
    id: varchar("id").primaryKey(),
    workspaceId: varchar("workspace_id").notNull(),
    name: text("name").notNull(),
    dueDate: varchar("due_date"),
    description: text("description"),
    multipleOwners: boolean("multiple_owners").default(false),
    owners: jsonb("owners"),
    color: varchar("color"),
    dateCreated: varchar("date_created"),
    startDate: varchar("start_date"),
    keyResults: jsonb("key_results"),
    fullName: text("full_name"),
    percentCompleted: doublePrecision("percent_completed"),
    completed: boolean("completed").default(false),
    createdBy: jsonb("created_by"),
    prettyId: varchar("pretty_id"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdx: index("clickup_goals_workspace_idx").on(t.workspaceId),
  }),
);

export type ClickupGoal = typeof clickupGoals.$inferSelect;

// ─── Docs ─────────────────────────────────────────────────────────────────────

export const clickupDocs = pgTable(
  "clickup_docs",
  {
    id: varchar("id").primaryKey(),
    workspaceId: varchar("workspace_id").notNull(),
    parentId: varchar("parent_id"),
    title: text("title"),
    visibility: varchar("visibility"),
    creator: integer("creator"),
    dateCreated: varchar("date_created"),
    dateUpdated: varchar("date_updated"),
    parent: jsonb("parent"),
    type: integer("type"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdx: index("clickup_docs_workspace_idx").on(t.workspaceId),
  }),
);

export type ClickupDoc = typeof clickupDocs.$inferSelect;

// ─── Filter presets (per-user, stored in NoBull) ──────────────────────────────

export const clickupFilterPresets = pgTable(
  "clickup_filter_presets",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").notNull(),
    name: text("name").notNull(),
    workspaceId: varchar("workspace_id").notNull(),
    filters: jsonb("filters").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("clickup_filter_presets_user_idx").on(t.userId),
    workspaceIdx: index("clickup_filter_presets_workspace_idx").on(t.workspaceId),
  }),
);

export const insertClickupFilterPresetSchema = createInsertSchema(
  clickupFilterPresets,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertClickupFilterPreset = z.infer<typeof insertClickupFilterPresetSchema>;
export type ClickupFilterPreset = typeof clickupFilterPresets.$inferSelect;

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export const clickupWebhooks = pgTable(
  "clickup_webhooks",
  {
    id: varchar("id").primaryKey(),
    workspaceId: varchar("workspace_id").notNull(),
    userId: varchar("user_id").notNull(),
    endpoint: text("endpoint").notNull(),
    clientId: varchar("client_id"),
    secret: text("secret_encrypted"),
    events: jsonb("events"),
    locationType: varchar("location_type"),
    locationId: varchar("location_id"),
    health: jsonb("health"),
    status: varchar("status").notNull().default("active"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdx: index("clickup_webhooks_workspace_idx").on(t.workspaceId),
    userIdx: index("clickup_webhooks_user_idx").on(t.userId),
  }),
);

export type ClickupWebhook = typeof clickupWebhooks.$inferSelect;

// ─── Verified webhook receipts ─────────────────────────────────────────────────

/**
 * Minimal, durable correlation for canonical Client List task deliveries.
 * The raw vendor body and webhook secret are deliberately never persisted.
 * Execution/retry/dead-letter evidence remains authoritative in work_queue via
 * queueJobId, avoiding a second queue state machine that could drift.
 */
export const clickupWebhookReceipts = pgTable(
  "clickup_webhook_receipts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    deliveryKey: varchar("delivery_key").notNull(),
    webhookId: varchar("webhook_id").notNull(),
    workspaceId: varchar("workspace_id").notNull(),
    serviceUserId: varchar("service_user_id").notNull(),
    eventType: varchar("event_type").notNull(),
    providerEventId: varchar("provider_event_id"),
    taskId: varchar("task_id").notNull(),
    listId: varchar("list_id").notNull(),
    bodySha256: varchar("body_sha256").notNull(),
    queueJobId: varchar("queue_job_id"),
    actorClickupUserId: varchar("actor_clickup_user_id"),
    changedFieldIds: jsonb("changed_field_ids"),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
  },
  (t) => ({
    deliveryKeyIdx: uniqueIndex("clickup_webhook_receipts_delivery_key_idx").on(
      t.deliveryKey,
    ),
    queueJobIdx: index("clickup_webhook_receipts_queue_job_idx").on(t.queueJobId),
    taskReceivedIdx: index("clickup_webhook_receipts_task_received_idx").on(
      t.taskId,
      t.receivedAt,
    ),
  }),
);

export type ClickupWebhookReceipt =
  typeof clickupWebhookReceipts.$inferSelect;
