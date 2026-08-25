import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, boolean, index, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";

// ---- sheet_folders ----

export const sheetFolders = pgTable("sheet_folders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  ownerId: varchar("owner_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSheetFolderSchema = createInsertSchema(sheetFolders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSheetFolder = z.infer<typeof insertSheetFolderSchema>;
export type SheetFolder = typeof sheetFolders.$inferSelect;

// ---- sheet_workbooks ----

export const sheetWorkbooks = pgTable("sheet_workbooks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  folderId: varchar("folder_id").references(() => sheetFolders.id),
  ownerId: varchar("owner_id").notNull().references(() => users.id),
  snapshot: jsonb("snapshot"),
  snapshotSizeBytes: integer("snapshot_size_bytes").default(0).notNull(),
  revision: integer("revision").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  ownerIdx: index("sheet_workbooks_owner_id_idx").on(table.ownerId),
  folderIdx: index("sheet_workbooks_folder_id_idx").on(table.folderId),
}));

export const insertSheetWorkbookSchema = createInsertSchema(sheetWorkbooks).omit({
  id: true,
  snapshotSizeBytes: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSheetWorkbook = z.infer<typeof insertSheetWorkbookSchema>;
export type SheetWorkbook = typeof sheetWorkbooks.$inferSelect;

// ---- sheet_workbook_permissions (per-user grants) ----

export const workbookPermissionRoleOptions = ["viewer", "editor", "owner"] as const;
export type WorkbookPermissionRole = typeof workbookPermissionRoleOptions[number];

export const sheetWorkbookPermissions = pgTable("sheet_workbook_permissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workbookId: varchar("workbook_id").notNull().references(() => sheetWorkbooks.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id),
  role: varchar("role").notNull().default("viewer"),
  grantedBy: varchar("granted_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  workbookUserUnique: unique("sheet_workbook_permissions_workbook_user_unique").on(table.workbookId, table.userId),
  workbookIdx: index("sheet_workbook_permissions_workbook_id_idx").on(table.workbookId),
  userIdx: index("sheet_workbook_permissions_user_id_idx").on(table.userId),
}));

export const insertSheetWorkbookPermissionSchema = createInsertSchema(sheetWorkbookPermissions).omit({
  id: true,
  createdAt: true,
});

export type InsertSheetWorkbookPermission = z.infer<typeof insertSheetWorkbookPermissionSchema>;
export type SheetWorkbookPermission = typeof sheetWorkbookPermissions.$inferSelect;

// ---- sheet_workbook_locks ----

export const sheetWorkbookLocks = pgTable("sheet_workbook_locks", {
  workbookId: varchar("workbook_id").primaryKey().references(() => sheetWorkbooks.id, { onDelete: "cascade" }),
  holderUserId: varchar("holder_user_id").notNull().references(() => users.id),
  holderName: text("holder_name").notNull(),
  acquiredAt: timestamp("acquired_at").defaultNow().notNull(),
  heartbeatAt: timestamp("heartbeat_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
}, (table) => ({
  expiresIdx: index("sheet_workbook_locks_expires_at_idx").on(table.expiresAt),
}));

export type SheetWorkbookLock = typeof sheetWorkbookLocks.$inferSelect;

// ---- sheet_data_blocks ----
// Connector-backed live data blocks embedded in a workbook sheet tab.
// Each block occupies a rectangular region (startRow, startCol, rowCount, colCount)
// within a specific sheet tab (sheetId) and is refreshable via the connector registry.

export const sheetDataBlocks = pgTable("sheet_data_blocks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workbookId: varchar("workbook_id").notNull().references(() => sheetWorkbooks.id, { onDelete: "cascade" }),
  sheetId: text("sheet_id").notNull(),
  label: text("label").notNull(),
  connectorId: varchar("connector_id").notNull(),
  connectorParams: jsonb("connector_params").notNull().default(sql`'{}'::jsonb`),
  startRow: integer("start_row").notNull().default(0),
  startCol: integer("start_col").notNull().default(0),
  rowCount: integer("row_count").notNull().default(1),
  colCount: integer("col_count").notNull().default(1),
  autoRefresh: boolean("auto_refresh").notNull().default(false),
  lastRefreshedAt: timestamp("last_refreshed_at"),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  workbookIdx: index("sheet_data_blocks_workbook_id_idx").on(table.workbookId),
  autoRefreshIdx: index("sheet_data_blocks_auto_refresh_idx").on(table.autoRefresh),
}));

export const insertSheetDataBlockSchema = createInsertSchema(sheetDataBlocks).omit({
  id: true,
  rowCount: true,
  colCount: true,
  lastRefreshedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSheetDataBlock = z.infer<typeof insertSheetDataBlockSchema>;
export type SheetDataBlock = typeof sheetDataBlocks.$inferSelect;

// ---- sheet_templates ----
// Reusable templates created from workbooks. Snapshot + block definitions are
// deep-copied; data blocks in the copy have no IDs and are marked stale until
// the first refresh after a workbook is created from this template.

export const sheetTemplates = pgTable("sheet_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  sourceWorkbookId: varchar("source_workbook_id").references(
    () => sheetWorkbooks.id,
    { onDelete: "set null" },
  ),
  snapshot: jsonb("snapshot"),
  dataBlockDefs: jsonb("data_block_defs").notNull().default(sql`'[]'::jsonb`),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  createdByIdx: index("sheet_templates_created_by_idx").on(table.createdBy),
  archivedIdx: index("sheet_templates_archived_at_idx").on(table.archivedAt),
}));

export const insertSheetTemplateSchema = createInsertSchema(sheetTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSheetTemplate = z.infer<typeof insertSheetTemplateSchema>;
export type SheetTemplate = typeof sheetTemplates.$inferSelect;

// ---- sheet_workbook_role_grants (per-role grants) ----

export const workbookRoleGrantAccessLevels = ["viewer", "editor"] as const;
export type WorkbookRoleGrantAccessLevel = typeof workbookRoleGrantAccessLevels[number];

export const sheetWorkbookRoleGrants = pgTable("sheet_workbook_role_grants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workbookId: varchar("workbook_id").notNull().references(() => sheetWorkbooks.id, { onDelete: "cascade" }),
  role: varchar("role").notNull(),
  accessLevel: varchar("access_level").notNull().default("viewer"),
  grantedBy: varchar("granted_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  workbookRoleUnique: unique("sheet_workbook_role_grants_workbook_role_unique").on(table.workbookId, table.role),
  workbookIdx: index("sheet_workbook_role_grants_workbook_id_idx").on(table.workbookId),
}));

export const insertSheetWorkbookRoleGrantSchema = createInsertSchema(sheetWorkbookRoleGrants).omit({
  id: true,
  createdAt: true,
});

export type InsertSheetWorkbookRoleGrant = z.infer<typeof insertSheetWorkbookRoleGrantSchema>;
export type SheetWorkbookRoleGrant = typeof sheetWorkbookRoleGrants.$inferSelect;

// ---- sheet_workbook_versions ----

export const sheetWorkbookVersions = pgTable("sheet_workbook_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workbookId: varchar("workbook_id").notNull().references(() => sheetWorkbooks.id, { onDelete: "cascade" }),
  snapshot: jsonb("snapshot").notNull(),
  snapshotSizeBytes: integer("snapshot_size_bytes").default(0).notNull(),
  createdBy: varchar("created_by").references(() => users.id),
  label: text("label"),
  isRestorePoint: boolean("is_restore_point").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  workbookIdx: index("sheet_workbook_versions_workbook_id_idx").on(table.workbookId),
  createdAtIdx: index("sheet_workbook_versions_workbook_created_at_idx").on(table.workbookId, table.createdAt),
}));

export const insertSheetWorkbookVersionSchema = createInsertSchema(sheetWorkbookVersions).omit({
  id: true,
  snapshotSizeBytes: true,
  createdAt: true,
});

export type InsertSheetWorkbookVersion = z.infer<typeof insertSheetWorkbookVersionSchema>;
export type SheetWorkbookVersion = typeof sheetWorkbookVersions.$inferSelect;

/** Version row without the snapshot body (for list views). */
export type SheetWorkbookVersionMeta = Omit<SheetWorkbookVersion, "snapshot">;

// ---- sheet_workbook_activity ----
// Per-workbook audit trail: one entry per meaningful user action.
// Edit sessions are summarized (one entry per lock-session close,
// not per autosave keystroke).

export const sheetActivityActions = [
  "created",
  "renamed",
  "edited",
  "shared",
  "unshared",
  "imported",
  "exported",
  "version_saved",
  "restored",
  "duplicated",
] as const;

export type SheetActivityAction = typeof sheetActivityActions[number];

export const sheetWorkbookActivity = pgTable("sheet_workbook_activity", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workbookId: varchar("workbook_id").notNull().references(() => sheetWorkbooks.id, { onDelete: "cascade" }),
  actorId: varchar("actor_id").references(() => users.id, { onDelete: "set null" }),
  actorName: text("actor_name").notNull().default(""),
  action: varchar("action").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  workbookIdx: index("sheet_workbook_activity_workbook_id_idx").on(table.workbookId),
  createdAtIdx: index("sheet_workbook_activity_workbook_created_at_idx").on(table.workbookId, table.createdAt),
}));

export const insertSheetWorkbookActivitySchema = createInsertSchema(sheetWorkbookActivity).omit({
  id: true,
  createdAt: true,
});

export type InsertSheetWorkbookActivity = z.infer<typeof insertSheetWorkbookActivitySchema>;
export type SheetWorkbookActivity = typeof sheetWorkbookActivity.$inferSelect;
