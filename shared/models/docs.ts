// Task #4024 — NoBull Docs (in-app document editor).
//
// Word-processing documents edited with Univer's document preset. The
// persistence stack deliberately mirrors NoBull Sheets (shared/models/sheets.ts):
// JSONB snapshot + optimistic revision guard, single-active-editor lock with
// heartbeat, version snapshots with restore points, and a per-document
// activity log. Documents may optionally belong to a client (`client_id`),
// in which case they surface inside that client's Files tab alongside
// uploaded files.
//
// Unlike Sheets there are no folders or templates. Access is owner-based,
// with client-linked documents visible to everyone who can access the client,
// plus per-user viewer/editor grants (doc_document_permissions, Task #4053)
// mirroring sheets' workbook permissions (see server/routes/docs.ts).
import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, boolean, index, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";
import { clients } from "./clients";

// ---- doc_documents ----

export const docDocuments = pgTable("doc_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  ownerId: varchar("owner_id").notNull().references(() => users.id),
  // Optional client link — set when the document lives in a client's Files tab.
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "set null" }),
  snapshot: jsonb("snapshot"),
  snapshotSizeBytes: integer("snapshot_size_bytes").default(0).notNull(),
  revision: integer("revision").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  ownerIdx: index("doc_documents_owner_id_idx").on(table.ownerId),
  clientIdx: index("doc_documents_client_id_idx").on(table.clientId),
}));

export const insertDocDocumentSchema = createInsertSchema(docDocuments).omit({
  id: true,
  snapshotSizeBytes: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDocDocument = z.infer<typeof insertDocDocumentSchema>;
export type DocDocument = typeof docDocuments.$inferSelect;

/** Document row without the snapshot body (for list views). */
export type DocDocumentMeta = Omit<DocDocument, "snapshot">;

// ---- doc_document_permissions (per-user grants, Task #4053) ----
// Mirrors sheet_workbook_permissions, minus the "owner" grant level —
// docs ownership never transfers via a grant. A grantee is either a
// viewer (read-only open) or an editor (can hold the edit lock + save).

export const docPermissionRoleOptions = ["viewer", "editor"] as const;
export type DocPermissionRole = typeof docPermissionRoleOptions[number];

export const docDocumentPermissions = pgTable("doc_document_permissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: varchar("document_id").notNull().references(() => docDocuments.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id),
  role: varchar("role").notNull().default("viewer"),
  grantedBy: varchar("granted_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  documentUserUnique: unique("doc_document_permissions_document_user_unique").on(table.documentId, table.userId),
  documentIdx: index("doc_document_permissions_document_id_idx").on(table.documentId),
  userIdx: index("doc_document_permissions_user_id_idx").on(table.userId),
}));

export const insertDocDocumentPermissionSchema = createInsertSchema(docDocumentPermissions).omit({
  id: true,
  createdAt: true,
});

export type InsertDocDocumentPermission = z.infer<typeof insertDocDocumentPermissionSchema>;
export type DocDocumentPermission = typeof docDocumentPermissions.$inferSelect;

/** Effective access to a document: null means no access (403). */
export type DocAccessLevel = "owner" | "editor" | "viewer";

// ---- doc_document_locks ----

export const docDocumentLocks = pgTable("doc_document_locks", {
  documentId: varchar("document_id").primaryKey().references(() => docDocuments.id, { onDelete: "cascade" }),
  holderUserId: varchar("holder_user_id").notNull().references(() => users.id),
  holderName: text("holder_name").notNull(),
  acquiredAt: timestamp("acquired_at").defaultNow().notNull(),
  heartbeatAt: timestamp("heartbeat_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
}, (table) => ({
  expiresIdx: index("doc_document_locks_expires_at_idx").on(table.expiresAt),
}));

export type DocDocumentLock = typeof docDocumentLocks.$inferSelect;

// ---- doc_document_versions ----

export const docDocumentVersions = pgTable("doc_document_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: varchar("document_id").notNull().references(() => docDocuments.id, { onDelete: "cascade" }),
  snapshot: jsonb("snapshot").notNull(),
  snapshotSizeBytes: integer("snapshot_size_bytes").default(0).notNull(),
  createdBy: varchar("created_by").references(() => users.id),
  label: text("label"),
  isRestorePoint: boolean("is_restore_point").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  documentIdx: index("doc_document_versions_document_id_idx").on(table.documentId),
  createdAtIdx: index("doc_document_versions_document_created_at_idx").on(table.documentId, table.createdAt),
}));

export const insertDocDocumentVersionSchema = createInsertSchema(docDocumentVersions).omit({
  id: true,
  snapshotSizeBytes: true,
  createdAt: true,
});

export type InsertDocDocumentVersion = z.infer<typeof insertDocDocumentVersionSchema>;
export type DocDocumentVersion = typeof docDocumentVersions.$inferSelect;

/** Version row without the snapshot body (for list views). */
export type DocDocumentVersionMeta = Omit<DocDocumentVersion, "snapshot">;

// ---- doc_document_activity ----
// Per-document audit trail: one entry per meaningful user action.
// Edit sessions are summarized (one entry per lock-session close,
// not per autosave keystroke) — same convention as Sheets.

export const docActivityActions = [
  "created",
  "renamed",
  "edited",
  "imported",
  "exported",
  "version_saved",
  "restored",
  "shared",
  "unshared",
] as const;

export type DocActivityAction = typeof docActivityActions[number];

export const docDocumentActivity = pgTable("doc_document_activity", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: varchar("document_id").notNull().references(() => docDocuments.id, { onDelete: "cascade" }),
  actorId: varchar("actor_id").references(() => users.id, { onDelete: "set null" }),
  actorName: text("actor_name").notNull().default(""),
  action: varchar("action").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  documentIdx: index("doc_document_activity_document_id_idx").on(table.documentId),
  createdAtIdx: index("doc_document_activity_document_created_at_idx").on(table.documentId, table.createdAt),
}));

export const insertDocDocumentActivitySchema = createInsertSchema(docDocumentActivity).omit({
  id: true,
  createdAt: true,
});

export type InsertDocDocumentActivity = z.infer<typeof insertDocDocumentActivitySchema>;
export type DocDocumentActivity = typeof docDocumentActivity.$inferSelect;
