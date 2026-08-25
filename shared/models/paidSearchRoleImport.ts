/**
 * Task #5157 — Paid Search role cutover: durable import audit/resume state.
 *
 * Two tables:
 *
 *   ps_role_import_audit
 *     Per-parent / per-role disposition rows from the "Import Paid Search roles"
 *     prod action. Keyed by stable ClickUp parent task ID + role name.
 *     Current resume state for each stable parent/role slot. ALL five
 *     dispositions are persisted, but only
 *     imported/unchanged are TERMINAL (skipped on repeat presses). conflict,
 *     blank, and ineligible are NON-terminal: they are re-evaluated every press
 *     so correcting the underlying data lets a later Apply advance the slot
 *     (Task #5157 fix 5). The enum/table/constraints are unchanged — the
 *     terminal/non-terminal distinction is a read-time policy in the importer.
 *
 *   ps_role_import_attempts
 *     Append-only evidence for every evaluated role slot on every operator
 *     press, including transient retryable write failures. Current-state
 *     upserts never erase prior conflicts, blanks, unmapped rows, or actors.
 *
 * Design rules:
 *   - Timestamps WITHOUT timezone (UTC; matches codebase convention).
 *   - No FK constraints (NoBull monolith convention).
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─── Dispositions ─────────────────────────────────────────────────────────────

export const PS_ROLE_IMPORT_DISPOSITIONS = [
  "imported",    // assignment written successfully
  "unchanged",   // already matches desired value — idempotent skip
  "conflict",    // existing non-null role differs — never overwrite
  "blank",       // ClickUp People field is empty — skip
  "ineligible",  // parent/mapping/membership not eligible for import
] as const;
export type PsRoleImportDisposition = (typeof PS_ROLE_IMPORT_DISPOSITIONS)[number];

// ─── Roles ────────────────────────────────────────────────────────────────────

export const PS_ROLE_IMPORT_ROLES = ["doer", "checker"] as const;
export type PsRoleImportRole = (typeof PS_ROLE_IMPORT_ROLES)[number];

// ─── Table ────────────────────────────────────────────────────────────────────

export const psRoleImportAudit = pgTable(
  "ps_role_import_audit",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // Stable ClickUp parent task ID (e.g. "abc123xyz").
    clickupParentTaskId: varchar("clickup_parent_task_id").notNull(),
    // "doer" | "checker"
    role: varchar("role").notNull(),
    // "imported" | "unchanged" | "conflict" | "blank" | "ineligible"
    disposition: varchar("disposition").notNull(),
    // Human-readable reason for the disposition.
    reason: text("reason"),
    // NoBull client ID when the parent was successfully matched (nullable).
    clientId: varchar("client_id"),
    // The ClickUp People field raw ID on this parent for the role.
    clickupFieldId: varchar("clickup_field_id"),
    // Raw ClickUp user ID from the People field (single-person; nullable = blank).
    clickupUserIdCurrent: varchar("clickup_user_id_current"),
    // NoBull user ID resolved from clickupUserIdCurrent (nullable = no mapping).
    nobullUserId: varchar("nobull_user_id"),
    // NoBull department ID used for the assignment write (nullable = not written).
    departmentId: varchar("department_id"),
    // Canonical ClickUp client name (display).
    clickupClientName: text("clickup_client_name"),
    // ISO timestamp of this apply press.
    appliedAt: timestamp("applied_at").notNull().defaultNow(),
    // NoBull user ID of the operator who pressed Apply.
    appliedBy: varchar("applied_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    // Idempotency key: stable parent task ID + role.
    taskRoleUniq: uniqueIndex("ps_role_import_audit_task_role_uniq").on(
      t.clickupParentTaskId,
      t.role,
    ),
    clientIdx: index("ps_role_import_audit_client_idx")
      .on(t.clientId)
      .where(sql`${t.clientId} IS NOT NULL`),
    dispositionIdx: index("ps_role_import_audit_disposition_idx").on(t.disposition),
    roleChk: check(
      "ps_role_import_audit_role_chk",
      sql`${t.role} IN ('doer', 'checker')`,
    ),
    dispositionChk: check(
      "ps_role_import_audit_disposition_chk",
      sql`${t.disposition} IN ('imported', 'unchanged', 'conflict', 'blank', 'ineligible')`,
    ),
  }),
);

export const psRoleImportAttempts = pgTable(
  "ps_role_import_attempts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    importRunId: varchar("import_run_id").notNull(),
    clickupParentTaskId: varchar("clickup_parent_task_id").notNull(),
    role: varchar("role").notNull(),
    disposition: varchar("disposition").notNull(),
    reason: text("reason"),
    clientId: varchar("client_id"),
    clickupFieldId: varchar("clickup_field_id"),
    clickupUserIdCurrent: varchar("clickup_user_id_current"),
    nobullUserId: varchar("nobull_user_id"),
    departmentId: varchar("department_id"),
    clickupClientName: text("clickup_client_name"),
    attemptedAt: timestamp("attempted_at").notNull().defaultNow(),
    attemptedBy: varchar("attempted_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    taskRoleTimeIdx: index("ps_role_import_attempts_task_role_time_idx").on(
      t.clickupParentTaskId,
      t.role,
      t.attemptedAt,
    ),
    runIdx: index("ps_role_import_attempts_run_idx").on(t.importRunId),
    dispositionIdx: index("ps_role_import_attempts_disposition_idx").on(t.disposition),
    roleChk: check(
      "ps_role_import_attempts_role_chk",
      sql`${t.role} IN ('doer', 'checker')`,
    ),
    dispositionChk: check(
      "ps_role_import_attempts_disposition_chk",
      sql`${t.disposition} IN ('imported', 'unchanged', 'conflict', 'blank', 'ineligible', 'retryable')`,
    ),
  }),
);

export const insertPsRoleImportAuditSchema = createInsertSchema(psRoleImportAudit).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPsRoleImportAudit = z.infer<typeof insertPsRoleImportAuditSchema>;
export type PsRoleImportAudit = typeof psRoleImportAudit.$inferSelect;
export type PsRoleImportAttempt = typeof psRoleImportAttempts.$inferSelect;
