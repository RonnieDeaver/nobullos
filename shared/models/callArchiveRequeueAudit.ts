import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./auth";

// Task #1086: audit trail for call-archive re-queue actions (per-row +
// bulk). Both endpoints in server/routes/twilio.ts insert one row per
// invocation so admins can see who kicked the call-archive pipeline
// and when, without grepping server logs.
//
// `mode` is one of:
//   'single'      → per-row re-queue (POST /api/admin/twilio/call-archive/:id/requeue)
//   'bulk_failed' → bulk re-queue of all archive_status='failed' rows
//   'bulk_stuck'  → bulk re-queue of all "stuck pending" rows (no recording_url/sid)
//
// `targetCallId` is set for 'single' (the affected twilio_calls.id);
// 'bulk_*' rows leave it NULL and use `affectedCount` instead.
export const callArchiveRequeueAudit = pgTable(
  "call_archive_requeue_audit",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").references(() => users.id),
    mode: varchar("mode", { length: 32 }).notNull(),
    targetCallId: varchar("target_call_id"),
    affectedCount: integer("affected_count").notNull().default(0),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("call_archive_requeue_audit_created_at_idx").on(table.createdAt),
    index("call_archive_requeue_audit_user_id_idx").on(table.userId),
  ],
);

export const insertCallArchiveRequeueAuditSchema = createInsertSchema(callArchiveRequeueAudit).omit({
  id: true,
  createdAt: true,
});

export type InsertCallArchiveRequeueAudit = z.infer<typeof insertCallArchiveRequeueAuditSchema>;
export type CallArchiveRequeueAudit = typeof callArchiveRequeueAudit.$inferSelect;
