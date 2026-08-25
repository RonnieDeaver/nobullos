import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { clients } from "./clients";
import { deals } from "./deals";

export const pandadocDocuments = pgTable("pandadoc_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: text("document_id").notNull().unique(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  createdDate: timestamp("created_date"),
  completedDate: timestamp("completed_date"),
  expirationDate: timestamp("expiration_date"),
  recipientsJson: jsonb("recipients_json"),
  contentText: text("content_text"),
  linkedClientId: varchar("linked_client_id").references(() => clients.id, { onDelete: "set null" }),
  // Task #4332 — explicit document→deal link for the PandaDoc auto-move
  // trigger. Set ONLY via the dedicated link endpoint/storage fn (excluded
  // from both write schemas below); auto-moves never guess a deal.
  linkedDealId: varchar("linked_deal_id").references(() => deals.id, { onDelete: "set null" }),
  lastSyncedAt: timestamp("last_synced_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  documentIdIdx: uniqueIndex("pandadoc_documents_document_id_idx").on(table.documentId),
  clientIdx: index("pandadoc_documents_client_id_idx").on(table.linkedClientId),
  linkedDealIdx: index("pandadoc_documents_linked_deal_idx").on(table.linkedDealId),
}));

export const insertPandadocDocumentSchema = createInsertSchema(pandadocDocuments).omit({
  id: true,
  createdAt: true,
  // Task #4332 — deal link changes only via linkPandadocDocumentToDeal.
  linkedDealId: true,
});

export type InsertPandadocDocument = z.infer<typeof insertPandadocDocumentSchema>;

// Task #4222 (F8 follow-up) — focused edit shape for updatePandadocDocument.
// Beyond the insert schema's id/createdAt omissions, an EDIT also keeps the
// immutable vendor natural key (`documentId`) out of caller control — the
// sync looks rows up BY documentId, so an update never legitimately changes
// it. Runtime-parsed in the storage method (unknown keys are stripped).
export const updatePandadocDocumentSchema = insertPandadocDocumentSchema
  .omit({ documentId: true })
  .partial();
export type UpdatePandadocDocument = z.infer<typeof updatePandadocDocumentSchema>;

export type PandadocDocument = typeof pandadocDocuments.$inferSelect;
