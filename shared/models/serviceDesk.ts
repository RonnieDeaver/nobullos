/**
 * Task #3056 — Service Desk foundation: ClickUp structure, config & ticket mapping.
 *
 * Tables in this file are NoBull-side config for the service desk; ClickUp
 * remains authoritative for task status/assignee/dates via the existing
 * clickup_tasks mirror.
 *
 * Architecture: single "All Service Requests" List inside a dedicated
 * Space/Folder. Department is stored as a custom field on each task (not a
 * separate List), so "change fulfilling department" is a field edit — never a
 * List move (ClickUp FAQ: tasks cannot be moved between Lists via API).
 *
 * Custom field UUIDs and dropdown option IDs are stored here (never names),
 * because ClickUp matching is UUID-based; names can be renamed in ClickUp
 * without breaking the mapping.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
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

// ─── Departments ──────────────────────────────────────────────────────────────

// Task #4171 — how a department's Doer/Checker are assigned:
//   'per_client' — one assignment row per client (sd_client_dept_assignments),
//                  with the department-level default_*_user_id columns acting
//                  as per-role fallbacks when a client has no explicit person.
//   'company'    — assigned once company-wide: the department-level
//                  default_*_user_id columns ARE the role holders for every
//                  client, and the department disappears from all per-client
//                  assignment surfaces.
export const SD_ASSIGNMENT_SCOPES = ["per_client", "company"] as const;
export type SdAssignmentScope = (typeof SD_ASSIGNMENT_SCOPES)[number];

export const sdDepartments = pgTable(
  "sd_departments",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    active: boolean("active").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    // 'per_client' | 'company' — see SD_ASSIGNMENT_SCOPES above (Task #4171).
    assignmentScope: varchar("assignment_scope").default("per_client").notNull(),
    // Department-level role holders (Task #4171). For per-client departments
    // these are the per-role DEFAULTS (fallback when the client's assignment
    // row leaves the slot empty); for company departments they are THE
    // company-wide holders.
    defaultPrimaryUserId: varchar("default_primary_user_id"),
    defaultCheckerUserId: varchar("default_checker_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);

export const insertSdDepartmentSchema = createInsertSchema(sdDepartments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSdDepartment = z.infer<typeof insertSdDepartmentSchema>;
export type SdDepartment = typeof sdDepartments.$inferSelect;

// ─── Department members ────────────────────────────────────────────────────────
// Maps a NoBull user to a department. clickupUserId enables eligibility checks
// (does the user have a connected ClickUp account with workspace membership?).

export const sdDepartmentMembers = pgTable(
  "sd_department_members",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    departmentId: varchar("department_id").notNull(),
    userId: varchar("user_id").notNull(),
    clickupUserId: varchar("clickup_user_id"),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    deptIdx: index("sd_department_members_dept_idx").on(t.departmentId),
    userIdx: index("sd_department_members_user_idx").on(t.userId),
    uniq: uniqueIndex("sd_department_members_dept_user_uniq").on(t.departmentId, t.userId),
  }),
);

export const insertSdDepartmentMemberSchema = createInsertSchema(sdDepartmentMembers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSdDepartmentMember = z.infer<typeof insertSdDepartmentMemberSchema>;
export type SdDepartmentMember = typeof sdDepartmentMembers.$inferSelect;

// ─── Request types ────────────────────────────────────────────────────────────
// departmentId null = global type visible in all departments.

export const sdRequestTypes = pgTable(
  "sd_request_types",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    departmentId: varchar("department_id"),
    name: text("name").notNull(),
    description: text("description"),
    active: boolean("active").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    deptIdx: index("sd_request_types_dept_idx").on(t.departmentId),
  }),
);

export const insertSdRequestTypeSchema = createInsertSchema(sdRequestTypes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSdRequestType = z.infer<typeof insertSdRequestTypeSchema>;
export type SdRequestType = typeof sdRequestTypes.$inferSelect;

// ─── List mapping config ───────────────────────────────────────────────────────
// Singleton row. Stores the bound ClickUp List + custom field UUIDs + dropdown
// option ID maps. UUIDs come from GetAccessibleCustomFields on the bound List.
// Option IDs come from the field's type_config.options array.

export const sdListMapping = pgTable(
  "sd_list_mapping",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    clickupListId: varchar("clickup_list_id"),
    clickupSpaceId: varchar("clickup_space_id"),
    clickupFolderId: varchar("clickup_folder_id"),
    clickupWorkspaceId: varchar("clickup_workspace_id"),
    // Custom field UUIDs
    fieldClientId: varchar("field_client_id"),
    fieldDepartmentId: varchar("field_department_id"),
    fieldOwnerDeptId: varchar("field_owner_dept_id"),
    fieldRequestTypeId: varchar("field_request_type_id"),
    fieldRequesterId: varchar("field_requester_id"),
    fieldRequestedDateId: varchar("field_requested_date_id"),
    fieldCommittedDateId: varchar("field_committed_date_id"),
    fieldWaitingWhoId: varchar("field_waiting_who_id"),
    fieldWaitingWhatId: varchar("field_waiting_what_id"),
    fieldWaitingWhenId: varchar("field_waiting_when_id"),
    // Dropdown option ID maps: { "label": "clickup-option-uuid", ... }
    departmentOptionIds: jsonb("department_option_ids"),
    requestTypeOptionIds: jsonb("request_type_option_ids"),
    // Client dropdown option map: { "clickup-option-uuid": "nobull-client-uuid", ... }
    // Populated by the "Sync client options" action in the Field Mapping tab.
    clientOptionIds: jsonb("client_option_ids"),
    // Client option name map: { "clickup-option-uuid": "option-label", ... }
    // Populated alongside clientOptionIds so the submission form can display
    // all option labels (mapped and unmapped) without a live ClickUp API call.
    clientOptionNames: jsonb("client_option_names"),
    // Form links
    masterFormUrl: text("master_form_url"),
    masterFormEmbedUrl: text("master_form_embed_url"),
    // Guided setup step: not_started | space_created | folder_created | list_created | complete
    setupStep: varchar("setup_step").default("not_started").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);

export const insertSdListMappingSchema = createInsertSchema(sdListMapping).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSdListMapping = z.infer<typeof insertSdListMappingSchema>;
export type SdListMapping = typeof sdListMapping.$inferSelect;

// ─── Ticket mapping ────────────────────────────────────────────────────────────
// One row per service-desk ticket (ClickUp task) in the bound List. Resolves
// the ClickUp task to NoBull entities. NoBull-only display/notification state
// lives here; ClickUp remains authoritative for status/assignee/dates.

export const sdTicketMapping = pgTable(
  "sd_ticket_mapping",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    clickupTaskId: varchar("clickup_task_id").notNull().unique(),
    clientId: integer("client_id"),
    // NoBull clients.id UUID (varchar) — the integer clientId above is legacy.
    // Populated at native submission so role lookups can resolve the
    // client×dept assignment row (Task #3618).
    clientUuid: varchar("client_uuid"),
    requesterUserId: varchar("requester_user_id"),
    ownerUserId: varchar("owner_user_id"),
    departmentId: varchar("department_id"),
    // NoBull-only display/notification state
    readAt: timestamp("read_at"),
    lastNotifiedAt: timestamp("last_notified_at"),
    notificationVersion: integer("notification_version").default(0).notNull(),
    // Flexible NoBull-only tags/flags (e.g. { starred: true, pinned: false })
    nts: jsonb("nts"),
    // Structured intake question answers captured at native submission
    // (Task #3397): [{ label, value }] in question sort order.
    questionAnswers: jsonb("question_answers"),
    // Template enforcement tracking (Task #3373)
    templateChecklistApplied: boolean("template_checklist_applied").notNull().default(false),
    createdViaNobull: boolean("created_via_nobull").notNull().default(false),
    needsInfoNotified: boolean("needs_info_notified").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    taskIdx: uniqueIndex("sd_ticket_mapping_task_idx").on(t.clickupTaskId),
    clientIdx: index("sd_ticket_mapping_client_idx").on(t.clientId),
    // Task #4328: the client activity timeline's ticket arm filters by the
    // UUID client key and pages newest-first on (created_at, id).
    clientUuidCreatedIdx: index("sd_ticket_mapping_client_uuid_created_idx").on(
      t.clientUuid,
      t.createdAt,
    ),
    requesterIdx: index("sd_ticket_mapping_requester_idx").on(t.requesterUserId),
    ownerIdx: index("sd_ticket_mapping_owner_idx").on(t.ownerUserId),
    deptIdx: index("sd_ticket_mapping_dept_idx").on(t.departmentId),
  }),
);

export const insertSdTicketMappingSchema = createInsertSchema(sdTicketMapping).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSdTicketMapping = z.infer<typeof insertSdTicketMappingSchema>;
export type SdTicketMapping = typeof sdTicketMapping.$inferSelect;

// ─── Ticket events ────────────────────────────────────────────────────────────
// NoBull-side audit log per ticket. Consumed by the views/notifications task.
// ClickUp remains authoritative for status/assignee/dates; this table records
// the human and machine events that drove each change.
//
// event_type values:
//   status_transition, reassignment, department_change, committed_date_change,
//   confirm_complete, reopen, mark_duplicate, mark_out_of_scope, cancel,
//   waiting_on_set, comment_system

export const sdTicketEvents = pgTable(
  "sd_ticket_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    clickupTaskId: varchar("clickup_task_id").notNull(),
    eventType: varchar("event_type").notNull(),
    actorUserId: varchar("actor_user_id"),
    data: jsonb("data"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    taskIdx: index("sd_ticket_events_task_idx").on(t.clickupTaskId),
    typeIdx: index("sd_ticket_events_type_idx").on(t.eventType),
    createdIdx: index("sd_ticket_events_created_idx").on(t.createdAt),
  }),
);

export const insertSdTicketEventSchema = createInsertSchema(sdTicketEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertSdTicketEvent = z.infer<typeof insertSdTicketEventSchema>;
export type SdTicketEvent = typeof sdTicketEvents.$inferSelect;

// ─── Request type questions ───────────────────────────────────────────────────
// Per-type intake questions shown in the native submission form.
// question_type: text | long_text | number | date | yes_no | select | multi_select
// options: JSON array of strings, only for question_type = 'select' / 'multi_select'

export const sdRequestTypeQuestions = pgTable(
  "sd_request_type_questions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    requestTypeId: varchar("request_type_id").notNull(),
    label: text("label").notNull(),
    questionType: varchar("question_type").notNull().default("text"),
    required: boolean("required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    options: jsonb("options"),
    // Richer intake configuration (Task #3656). All optional; existing
    // questions behave exactly as before when these are null.
    helpText: text("help_text"),
    placeholder: text("placeholder"),
    defaultValue: text("default_value"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    rtIdx: index("sd_rt_questions_rt_idx").on(t.requestTypeId),
  }),
);

export const insertSdRequestTypeQuestionSchema = createInsertSchema(sdRequestTypeQuestions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSdRequestTypeQuestion = z.infer<typeof insertSdRequestTypeQuestionSchema>;
export type SdRequestTypeQuestion = typeof sdRequestTypeQuestions.$inferSelect;

// ─── Request type checklist steps ─────────────────────────────────────────────
// Per-type checklist step templates applied to every new ClickUp task of this type.

export const sdRequestTypeChecklistSteps = pgTable(
  "sd_request_type_checklist_steps",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    requestTypeId: varchar("request_type_id").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    // Template assignee (Task #3656): a fixed NoBull user OR a dynamic role
    // token ('doer' | 'checker') resolved at apply time from
    // sd_client_dept_assignments for the ticket's client + a department.
    // Mutually exclusive; both null = unassigned (legacy behavior).
    assigneeUserId: varchar("assignee_user_id"),
    assigneeRole: varchar("assignee_role"),
    // Optional per-step department override for the dynamic role: resolve the
    // role for the ticket's client × THIS department instead of the ticket's
    // own department (e.g. a "Get design approval" step assigned to the SEO
    // dept's checker on a Web ticket). NULL = ticket's department. Only
    // meaningful when assigneeRole is set.
    assigneeDepartmentId: varchar("assignee_department_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    rtIdx: index("sd_rt_checklist_steps_rt_idx").on(t.requestTypeId),
  }),
);

export const insertSdRequestTypeChecklistStepSchema = createInsertSchema(sdRequestTypeChecklistSteps).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSdRequestTypeChecklistStep = z.infer<typeof insertSdRequestTypeChecklistStepSchema>;
export type SdRequestTypeChecklistStep = typeof sdRequestTypeChecklistSteps.$inferSelect;

// ─── Client × department assignments ─────────────────────────────────────────
// Per-client, per-department role assignments (Task #3618): Primary Doer
// and Checker (formerly "Backup" — ClickUp watcher). Unique per
// (client_id, department_id) pair. clientId is the NoBull clients.id UUID
// (stored as varchar to match clients.id type). The role data is deliberately
// consumer-agnostic so future non-ClickUp consumers can reuse it.

export const sdClientDeptAssignments = pgTable(
  "sd_client_dept_assignments",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: varchar("client_id").notNull(),
    departmentId: varchar("department_id").notNull(),
    primaryUserId: varchar("primary_user_id"),
    // Renamed from backup_user_id (Task #3618): existing backups carried over.
    checkerUserId: varchar("checker_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    clientDeptUniq: uniqueIndex("sd_client_dept_assignments_client_dept_uniq").on(t.clientId, t.departmentId),
    clientIdx: index("sd_client_dept_assignments_client_idx").on(t.clientId),
    deptIdx: index("sd_client_dept_assignments_dept_idx").on(t.departmentId),
  }),
);

export const insertSdClientDeptAssignmentSchema = createInsertSchema(sdClientDeptAssignments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSdClientDeptAssignment = z.infer<typeof insertSdClientDeptAssignmentSchema>;
export type SdClientDeptAssignment = typeof sdClientDeptAssignments.$inferSelect;

// ─── Universal assignment boundary contract ──────────────────────────────────
// These are neutral read-model types over the canonical Service Desk records
// above. They deliberately use responsibility vocabulary instead of database
// column names so non-Service-Desk consumers do not need to know that the
// historical Doer column is named primary_user_id.

export const UNIVERSAL_ASSIGNMENT_RESPONSIBILITIES = [
  "doer",
  "checker",
] as const;
export type UniversalAssignmentResponsibility =
  (typeof UNIVERSAL_ASSIGNMENT_RESPONSIBILITIES)[number];

export type UniversalAssignmentSource =
  | "company"
  | "client_override"
  | "default"
  | null;

export type UniversalAssignmentProjectionIdentity = {
  provider: "clickup";
  workspaceId: string | null;
  externalUserId: string | null;
  source: "provided" | "department_member" | "personal_oauth" | null;
  credentialConnected: boolean;
  credentialStatus: string;
  workspaceVerification: "verified" | "unverified" | "mismatch" | "not_requested";
  ready: boolean;
  revision: string | null;
};

export type UniversalAssignmentRoleState = {
  userId: string | null;
  source: UniversalAssignmentSource;
  eligibility: "eligible" | "ineligible" | "unassigned";
  stale: boolean;
  projection: UniversalAssignmentProjectionIdentity;
};

export type UniversalAssignmentSnapshot = {
  clientId: string | null;
  departmentId: string;
  scope: SdAssignmentScope;
  departmentActive: boolean;
  revision: string;
  freshness: {
    computedAt: string;
    departmentUpdatedAt: string;
    clientOverrideUpdatedAt: string | null;
  };
  roles: Record<"doer", UniversalAssignmentRoleState> &
    Partial<Record<"checker", UniversalAssignmentRoleState>>;
};

// ─── Typed ticket read model ──────────────────────────────────────────────────
// Returned by the server-side resolver; not a DB table.

export type SdTicketResolved = {
  clickupTaskId: string;
  name: string;
  status: string | null;
  statusColor: string | null;
  url: string | null;
  priority: number | null;
  priorityName: string | null;
  dateCreated: string | null;
  dateUpdated: string | null;
  // Resolved from ClickUp custom fields via option-ID maps (authoritative)
  // then supplemented by NoBull sd_ticket_mapping for resolution caches
  /** Integer clientId from sd_ticket_mapping (manual/webhook-set) */
  clientId: number | null;
  /** Canonical NoBull clients.id (UUID) resolved by case-insensitive firmName match against clientName */
  resolvedClientId: string | null;
  /** Raw text/value of the Client custom field in ClickUp (for display before resolution) */
  clientName: string | null;
  requesterUserId: string | null;
  /** Raw text/value of the Requester custom field in ClickUp (for display before resolution) */
  requesterRaw: string | null;
  ownerUserId: string | null;
  /** NoBull department ID resolved from ClickUp option-ID map */
  departmentId: string | null;
  /** NoBull request type label resolved from ClickUp option-ID map */
  requestType: string | null;
  requestedDate: string | null;
  committedDate: string | null;
  waitingWho: string | null;
  waitingWhat: string | null;
  waitingWhen: string | null;
  // Assignees from mirror
  assignees: Array<{ id: string | number; username: string }>;
  // NoBull state
  readAt: string | null;
  lastNotifiedAt: string | null;
  /** Intake question answers ([{ label, value }]) from sd_ticket_mapping, or parsed from the mirrored description as fallback */
  questionAnswers: Array<{ label: string; value: string }> | null;
};
