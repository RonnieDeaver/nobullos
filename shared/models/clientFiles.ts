// Task #4023 — In-app client file storage (Drive-style foundation).
//
// Per-client file spaces on the app's existing private object storage:
// folders (hierarchy), files (current content), prior versions, and an
// activity log. The `client_files` row always points at the CURRENT
// content object; `client_file_versions` rows hold PRIOR content only —
// every object-storage key appears exactly once across the two tables
// (version restore SWAPS keys between them, it never copies bytes).
//
// Trash is a soft-delete state on `client_files` (trashed_at/trashed_by).
// Live-name uniqueness — UNIQUE (client_id, folder, lower(name)) WHERE
// trashed_at IS NULL — is enforced by expression indexes in the SQL
// migration (drizzle-orm can't express COALESCE/lower partial uniques);
// see migrations/*_client_files.sql.
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  jsonb,
  timestamp,
  integer,
  bigint,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";
import { clients } from "./clients";

// ---- client_file_folders ----

export const clientFileFolders = pgTable("client_file_folders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  // NULL parent = folder lives at the client's root.
  parentId: varchar("parent_id").references((): AnyPgColumn => clientFileFolders.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  clientParentIdx: index("client_file_folders_client_parent_idx").on(table.clientId, table.parentId),
}));

export const insertClientFileFolderSchema = createInsertSchema(clientFileFolders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertClientFileFolder = z.infer<typeof insertClientFileFolderSchema>;
export type ClientFileFolder = typeof clientFileFolders.$inferSelect;

// ---- client_files ----

export const clientFiles = pgTable("client_files", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  // NULL folder = client root. ON DELETE SET NULL is a safety net only —
  // the folder-delete flow re-homes/trashes contents explicitly first.
  folderId: varchar("folder_id").references(() => clientFileFolders.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  // SAFE serving mime resolved at claim time (magic-byte sniff), never the
  // client-declared content type. Unknown formats are stored as
  // application/octet-stream and served download-only.
  mimeType: varchar("mime_type").notNull().default("application/octet-stream"),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
  // PRIVATE_OBJECT_DIR-relative storage key of the CURRENT content, e.g.
  // `client-files/<clientId>/<uuid>.pdf`. Unique across live+version rows
  // by construction (mint generates a fresh uuid per upload).
  objectKey: text("object_key").notNull(),
  uploadedBy: varchar("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  // Soft-delete (Trash). Set/cleared by trash/restore; purge deletes the row.
  trashedAt: timestamp("trashed_at"),
  trashedBy: varchar("trashed_by").references(() => users.id, { onDelete: "set null" }),
  // Folder the file lived in when trashed — restore returns it there when
  // that folder still exists (folderId is nulled on trash so folder
  // deletion never dangles).
  trashedFromFolderId: varchar("trashed_from_folder_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // Bumped when CONTENT changes (new version uploaded / version restored).
  contentUpdatedAt: timestamp("content_updated_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  clientFolderIdx: index("client_files_client_folder_idx").on(table.clientId, table.folderId),
  clientTrashedIdx: index("client_files_client_trashed_idx").on(table.clientId, table.trashedAt),
}));

export const insertClientFileSchema = createInsertSchema(clientFiles).omit({
  id: true,
  createdAt: true,
  contentUpdatedAt: true,
  updatedAt: true,
});

export type InsertClientFile = z.infer<typeof insertClientFileSchema>;
export type ClientFile = typeof clientFiles.$inferSelect;

// ---- client_file_versions (PRIOR content only) ----

export const clientFileVersions = pgTable("client_file_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileId: varchar("file_id").notNull().references(() => clientFiles.id, { onDelete: "cascade" }),
  // Denormalized for per-client usage rollups + purge sweeps without a join.
  clientId: varchar("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  mimeType: varchar("mime_type").notNull().default("application/octet-stream"),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
  objectKey: text("object_key").notNull(),
  uploadedBy: varchar("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  // When this content was originally uploaded (carried over from the file
  // row's contentUpdatedAt at supersede time).
  uploadedAt: timestamp("uploaded_at").notNull(),
  // When it stopped being the current content.
  supersededAt: timestamp("superseded_at").defaultNow().notNull(),
}, (table) => ({
  fileVersionIdx: index("client_file_versions_file_version_idx").on(table.fileId, table.versionNumber),
  clientIdx: index("client_file_versions_client_idx").on(table.clientId),
}));

export const insertClientFileVersionSchema = createInsertSchema(clientFileVersions).omit({
  id: true,
  supersededAt: true,
});

export type InsertClientFileVersion = z.infer<typeof insertClientFileVersionSchema>;
export type ClientFileVersion = typeof clientFileVersions.$inferSelect;

// ---- client_file_activity ----

// ---- client_file_share_links (Task #4028 — external expiring links) ----

export const clientFileShareLinks = pgTable("client_file_share_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  fileId: varchar("file_id").notNull().references(() => clientFiles.id, { onDelete: "cascade" }),
  // sha256 hex of the random URL token. The raw token is NEVER stored — a
  // DB leak must not hand out working links. Unique so a token resolves to
  // at most one row.
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  // Denormalized so the share list stays readable if the user goes.
  createdByName: text("created_by_name").notNull().default(""),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  revokedBy: varchar("revoked_by").references(() => users.id, { onDelete: "set null" }),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessedAt: timestamp("last_accessed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  tokenHashUnique: uniqueIndex("client_file_share_links_token_hash_unique").on(table.tokenHash),
  fileIdx: index("client_file_share_links_file_idx").on(table.fileId),
}));

export type ClientFileShareLink = typeof clientFileShareLinks.$inferSelect;

// ---- client_file_activity ----

export const clientFileActivityActions = [
  "uploaded",
  "version_uploaded",
  "version_restored",
  "renamed",
  "moved",
  "trashed",
  "restored",
  "purged",
  "downloaded",
  "shared",
  "share_revoked",
  "share_replaced", // Task #4040 — active link revoked + re-minted in one step
  "folder_created",
  "folder_renamed",
  "folder_moved",
  "folder_deleted",
] as const;

export type ClientFileActivityAction = typeof clientFileActivityActions[number];

export const clientFileActivity = pgTable("client_file_activity", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  // Nullable: folder-only actions carry folderId, file actions carry fileId.
  // File rows CASCADE so purging a file also drops its per-file trail; the
  // `detail` payload keeps names readable in the per-client feed afterwards.
  fileId: varchar("file_id").references(() => clientFiles.id, { onDelete: "cascade" }),
  folderId: varchar("folder_id"),
  action: varchar("action").notNull(),
  actorId: varchar("actor_id").references(() => users.id, { onDelete: "set null" }),
  // Denormalized display name so the trail stays readable if the user goes.
  actorName: text("actor_name").notNull().default(""),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  clientCreatedIdx: index("client_file_activity_client_created_idx").on(table.clientId, table.createdAt),
  fileCreatedIdx: index("client_file_activity_file_created_idx").on(table.fileId, table.createdAt),
}));

export const insertClientFileActivitySchema = createInsertSchema(clientFileActivity).omit({
  id: true,
  createdAt: true,
});

export type InsertClientFileActivity = z.infer<typeof insertClientFileActivitySchema>;
export type ClientFileActivity = typeof clientFileActivity.$inferSelect;
