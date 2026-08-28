/**
 * Task #5156 — ClickUp Role Projection lane: durable schema.
 *
 * Four tables:
 *
 *   cu_role_projection_destinations
 *     Environment-scoped department+responsibility → ClickUp target mapping
 *     (workspace, target kind task/list, People custom-field UUID,
 *     one-person cardinality contract, sandbox/production classification,
 *     enabled flag, sandbox-exit approval and owner approval timestamps).
 *
 *   cu_role_projection_client_targets
 *     Stable client→target evidence: exact ClickUp task or list ID,
 *     owning-list evidence (resolved list ID), duplicate provenance JSON.
 *     Unique per (client_id, destination_id).
 *
 *   cu_client_list_mappings
 *     Role-independent canonical Client List identity. One row per NoBull
 *     client and one row per canonical ClickUp parent task.
 *
 *   cu_role_projection_commands
 *     Durable projection commands: desired NoBull userId + revision,
 *     target snapshots, status machine, bounded attempt counters,
 *     lease ownership/token/expiry, observed People IDs, safe errors,
 *     verified/drift/terminal timestamps.
 *
 * Design rules:
 *   - Timestamps WITHOUT timezone (UTC; matches codebase convention).
 *   - All PK defaults gen_random_uuid().
 *   - Hot-predicate indexes on the drain paths.
 *   - No FK constraints (NoBull monolith convention for cross-table refs).
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

// ─── Target kinds ──────────────────────────────────────────────────────────────

// direct_task       — company-scope: a single ClickUp task addressed by destination.targetId.
// client_list_parent — per-client: each client maps to a task via client_target.targetId,
//                      the People custom field lives on that task, owned by destination.listId.
// NOTE: unsupported List custom-field writes are deliberately NOT modeled.
export const CU_ROLE_PROJECTION_TARGET_KINDS = ["direct_task", "client_list_parent"] as const;
export type CuRoleProjectionTargetKind = (typeof CU_ROLE_PROJECTION_TARGET_KINDS)[number];

// ─── Environment classification ────────────────────────────────────────────────

export const CU_ROLE_PROJECTION_ENVS = ["sandbox", "production"] as const;
export type CuRoleProjectionEnv = (typeof CU_ROLE_PROJECTION_ENVS)[number];

// ─── Command status machine ────────────────────────────────────────────────────

export const CU_ROLE_PROJECTION_STATUSES = [
  "pending",
  "ambiguous",
  "synced",
  "failed",
  "blocked",
  "drift",
  "disabled",
] as const;
export type CuRoleProjectionStatus = (typeof CU_ROLE_PROJECTION_STATUSES)[number];

// ─── Canonical Client List mapping state ──────────────────────────────────────

export const CU_CLIENT_LIST_SYNC_STATES = [
  "pending_review",
  "verified",
  "conflict",
  "stale",
  "disabled",
] as const;
export type CuClientListSyncState = (typeof CU_CLIENT_LIST_SYNC_STATES)[number];

// ─── Error codes ───────────────────────────────────────────────────────────────

/** Canonical error codes stored in last_error_code. */
export const CU_ROLE_PROJECTION_ERROR_CODES = [
  "missing_identity",   // desired NoBull user has no ClickUp ID — blocked, never treated as clear
  "missing_target",     // no client_target row for this client/destination
  "list_mismatch",      // task belongs to wrong list
  "invalid_field",      // People field absent or wrong type on task
  "invalid_cardinality",// People field has >1 user — nonretryable, must not overwrite
  "auth",               // 401/403 vendor response
  "rate_limited",       // 429 vendor response
  "timeout",            // request timeout / abort
  "vendor_5xx",         // 5xx vendor response
  "exhausted",          // max attempts reached
  "config_mismatch",    // current destination config != selected env/snapshot, or kill switch active — no egress
] as const;
export type CuRoleProjectionErrorCode = (typeof CU_ROLE_PROJECTION_ERROR_CODES)[number];

// ─── Destinations ──────────────────────────────────────────────────────────────
// One row per (workspace_id, department_id, responsibility, env) quadruple.
// Stores where NoBull should project a given role for a given environment.

export const cuRoleProjectionDestinations = pgTable(
  "cu_role_projection_destinations",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // ClickUp workspace this destination is anchored to.
    workspaceId: varchar("workspace_id").notNull(),
    // NoBull department UUID.
    departmentId: varchar("department_id").notNull(),
    // Active projection responsibilities are "doer" | "checker".
    responsibility: varchar("responsibility").notNull(),
    // "direct_task" | "client_list_parent" — how the People field is addressed.
    targetKind: varchar("target_kind").notNull(),
    // For client_list_parent: the ClickUp list that owns each client's task (owning list UUID).
    listId: varchar("list_id"),
    // For direct_task (company-scope): the single ClickUp task ID that carries the People field.
    targetId: varchar("target_id"),
    // ClickUp People custom-field UUID on the target entity.
    peopleFieldId: varchar("people_field_id").notNull(),
    // Operator-reviewed field metadata from a fresh ClickUp read. The label is
    // descriptive only, not a lookup alias: runtime writes address field IDs.
    peopleFieldLabel: varchar("people_field_label", { length: 255 }),
    peopleFieldType: varchar("people_field_type", { length: 64 }),
    // Maximum persons in this field (always 1 for role projection; enforced by code).
    maxPeople: integer("max_people").notNull().default(1),
    // "sandbox" | "production"
    environment: varchar("environment").notNull().default("sandbox"),
    // Whether this destination is enabled for active projection.
    enabled: boolean("enabled").notNull().default(false),
    // Sandbox-exit approval: ISO timestamp recorded when an operator approved
    // promoting this destination from sandbox to production.
    sandboxExitApprovedAt: timestamp("sandbox_exit_approved_at"),
    sandboxExitApprovedBy: varchar("sandbox_exit_approved_by"),
    // Owner approval for production writes.
    ownerApprovedAt: timestamp("owner_approved_at"),
    ownerApprovedBy: varchar("owner_approved_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    // Each (workspace, dept, responsibility, env) is unique.
    uniqueDest: uniqueIndex("cu_role_proj_dest_uniq").on(
      t.workspaceId,
      t.departmentId,
      t.responsibility,
      t.environment,
    ),
    deptIdx: index("cu_role_proj_dest_dept_idx").on(t.departmentId),
    workspaceIdx: index("cu_role_proj_dest_workspace_idx").on(t.workspaceId),
    enabledEnvIdx: index("cu_role_proj_dest_enabled_env_idx").on(t.enabled, t.environment),
  }),
);

export const insertCuRoleProjectionDestinationSchema = createInsertSchema(
  cuRoleProjectionDestinations,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCuRoleProjectionDestination = z.infer<
  typeof insertCuRoleProjectionDestinationSchema
>;
export type CuRoleProjectionDestination = typeof cuRoleProjectionDestinations.$inferSelect;

// ─── Canonical Client List mappings ───────────────────────────────────────────
// Stable role-independent client identity. Normalized names may suggest an
// adoption candidate in preflight, but are never persisted as write addresses.

export const cuClientListMappings = pgTable(
  "cu_client_list_mappings",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: varchar("client_id").notNull(),
    listId: varchar("list_id").notNull(),
    taskId: varchar("task_id").notNull(),
    remoteTaskName: text("remote_task_name"),
    remoteRevision: varchar("remote_revision", { length: 255 }),
    // Last values written/verified by NoBull. Live differences are direct
    // vendor drift and require review rather than an automatic overwrite.
    ownedName: text("owned_name"),
    ownedArchived: boolean("owned_archived"),
    provenance: jsonb("provenance").notNull().default(sql`'{}'::jsonb`),
    syncState: varchar("sync_state").notNull().default("pending_review"),
    conflictEvidence: jsonb("conflict_evidence"),
    // Set only by a fresh canonical-list enumeration that returned taskId.
    ownershipVerifiedAt: timestamp("ownership_verified_at").notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    oneTaskPerClient: uniqueIndex("cu_client_list_mapping_client_uniq").on(t.clientId),
    oneClientPerTask: uniqueIndex("cu_client_list_mapping_task_uniq").on(t.listId, t.taskId),
    taskIdx: index("cu_client_list_mapping_task_idx").on(t.taskId),
    listIdx: index("cu_client_list_mapping_list_idx").on(t.listId),
    stateUpdatedIdx: index("cu_client_list_mapping_state_updated_idx").on(
      t.syncState,
      t.updatedAt,
    ),
  }),
);

export const insertCuClientListMappingSchema = createInsertSchema(
  cuClientListMappings,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCuClientListMapping = z.infer<typeof insertCuClientListMappingSchema>;
export type CuClientListMapping = typeof cuClientListMappings.$inferSelect;

// ─── Canonical Client List lifecycle commands ────────────────────────────────

export const CU_CLIENT_MIRROR_STATUSES = [
  "pending",
  "ambiguous",
  "synced",
  "blocked",
  "drift",
  "failed",
] as const;
export type CuClientMirrorStatus = (typeof CU_CLIENT_MIRROR_STATUSES)[number];

export const cuClientMirrorCommands = pgTable(
  "cu_client_mirror_commands",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: varchar("client_id").notNull(),
    desiredName: text("desired_name").notNull(),
    desiredArchived: boolean("desired_archived").notNull().default(false),
    mergedIntoClientId: varchar("merged_into_client_id"),
    revision: varchar("revision", { length: 64 }).notNull(),
    status: varchar("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at"),
    leaseOwner: varchar("lease_owner"),
    leaseToken: varchar("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    lastError: text("last_error"),
    terminalAt: timestamp("terminal_at"),
    verifiedAt: timestamp("verified_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    oneCommandPerClient: uniqueIndex("cu_client_mirror_command_client_uniq").on(t.clientId),
    drainIdx: index("cu_client_mirror_command_drain_idx").on(t.status, t.nextAttemptAt),
    leaseIdx: index("cu_client_mirror_command_lease_idx").on(t.leaseExpiresAt),
  }),
);

export type CuClientMirrorCommand = typeof cuClientMirrorCommands.$inferSelect;

// ─── Client targets ────────────────────────────────────────────────────────────
// Stable client→target evidence. One row per (client_id, destination_id).
// Stores the exact ClickUp task or list ID that carries this client's People field.

export const cuRoleProjectionClientTargets = pgTable(
  "cu_role_projection_client_targets",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // NoBull client UUID.
    clientId: varchar("client_id").notNull(),
    // References cu_role_projection_destinations.id (no FK by convention).
    destinationId: varchar("destination_id").notNull(),
    // Exact ClickUp task or list ID for this client.
    targetId: varchar("target_id").notNull(),
    // Resolved owning list ID (task's list_id as returned by GET /task/:id).
    // Used to prove the task lives in the expected list.
    resolvedListId: varchar("resolved_list_id"),
    // Provenance / duplicate detection: JSON blob. E.g. { source: "manual", linkedAt: "..." }
    provenance: jsonb("provenance"),
    // Timestamp set ONLY after a live GET immediately before a mutation proved the
    // target task lives in the expected owning list. Operator-supplied resolvedListId
    // is evidence metadata only and never authorizes a write on its own.
    ownershipVerifiedAt: timestamp("ownership_verified_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqueClientDest: uniqueIndex("cu_role_proj_client_target_uniq").on(
      t.clientId,
      t.destinationId,
    ),
    clientIdx: index("cu_role_proj_client_target_client_idx").on(t.clientId),
    destIdx: index("cu_role_proj_client_target_dest_idx").on(t.destinationId),
    targetIdx: index("cu_role_proj_client_target_target_idx").on(t.targetId),
  }),
);

export const insertCuRoleProjectionClientTargetSchema = createInsertSchema(
  cuRoleProjectionClientTargets,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCuRoleProjectionClientTarget = z.infer<
  typeof insertCuRoleProjectionClientTargetSchema
>;
export type CuRoleProjectionClientTarget = typeof cuRoleProjectionClientTargets.$inferSelect;

// ─── Commands ─────────────────────────────────────────────────────────────────
// Durable projection commands. One row per (client_id, destination_id) active
// projection intent. Upserted inside the assignment transaction; drained by the
// clickup_role_projection work-queue handler.

export const cuRoleProjectionCommands = pgTable(
  "cu_role_projection_commands",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // NoBull client UUID.
    clientId: varchar("client_id").notNull(),
    // References cu_role_projection_destinations.id (no FK by convention).
    destinationId: varchar("destination_id").notNull(),
    // Desired NoBull user ID (null = clear the People field).
    desiredUserId: varchar("desired_user_id"),
    // Desired ClickUp user ID (null = clear/unassign).
    desiredClickupUserId: varchar("desired_clickup_user_id"),
    // Revision token: deterministic string derived from assignment snapshot.
    // Used for idempotency — same revision → same desired outcome, no re-write.
    revision: varchar("revision").notNull(),
    // Snapshot of the target entity at staging time (JSON).
    targetSnapshot: jsonb("target_snapshot"),
    // Status machine: pending | ambiguous | synced | failed | blocked | drift | disabled
    status: varchar("status").notNull().default("pending"),
    // Total mutation attempts (counts genuine vendor calls).
    attemptCount: integer("attempt_count").notNull().default(0),
    // Maximum mutation attempts before terminal failure.
    maxAttempts: integer("max_attempts").notNull().default(5),
    // Mutation attempts: counts all attempted writes (including ambiguous).
    mutationAttempts: integer("mutation_attempts").notNull().default(0),
    // Earliest time for next attempt (null = immediately eligible).
    nextAttemptAt: timestamp("next_attempt_at"),
    // Lease ownership: NoBull instance identifier claiming this command.
    leaseOwner: varchar("lease_owner"),
    // Lease token: opaque string combining timestamp + owner for CAS.
    leaseToken: varchar("lease_token"),
    // Lease expiry: when the current lease expires (null = not leased).
    leaseExpiresAt: timestamp("lease_expires_at"),
    // Last observed People field user IDs (JSON array of ClickUp user ID strings).
    observedClickupUserIds: jsonb("observed_clickup_user_ids"),
    // Safe (sanitized) error message from last attempt.
    lastError: text("last_error"),
    // Canonical error code from last attempt (see CU_ROLE_PROJECTION_ERROR_CODES).
    lastErrorCode: varchar("last_error_code"),
    // Timestamps for terminal state transitions.
    verifiedAt: timestamp("verified_at"),
    driftDetectedAt: timestamp("drift_detected_at"),
    terminalAt: timestamp("terminal_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    // At most one active command per (client, destination).
    uniqueCmd: uniqueIndex("cu_role_proj_cmd_uniq").on(t.clientId, t.destinationId),
    // Hot drain predicate: status=pending, next_attempt_at <= now.
    statusNextAttemptIdx: index("cu_role_proj_cmd_status_next_idx").on(
      t.status,
      t.nextAttemptAt,
    ),
    // Lease expiry sweeper.
    leaseExpiresIdx: index("cu_role_proj_cmd_lease_expires_idx").on(t.leaseExpiresAt),
    clientIdx: index("cu_role_proj_cmd_client_idx").on(t.clientId),
    destIdx: index("cu_role_proj_cmd_dest_idx").on(t.destinationId),
  }),
);

export const insertCuRoleProjectionCommandSchema = createInsertSchema(
  cuRoleProjectionCommands,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCuRoleProjectionCommand = z.infer<typeof insertCuRoleProjectionCommandSchema>;
export type CuRoleProjectionCommand = typeof cuRoleProjectionCommands.$inferSelect;

// ─── Bidirectional revision contract + immutable transition evidence ──────────

export const cuRoleSyncContracts = pgTable(
  "cu_role_sync_contracts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    clientId: varchar("client_id").notNull(),
    destinationId: varchar("destination_id").notNull(),
    localRevision: integer("local_revision").notNull().default(0),
    vendorRevision: varchar("vendor_revision"),
    lastOutboundRevision: varchar("last_outbound_revision"),
    lastObservedClickupUserIds: jsonb("last_observed_clickup_user_ids"),
    conflictState: varchar("conflict_state").notNull().default("none"),
    conflictEvidence: jsonb("conflict_evidence"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    uniqueClientDestination: uniqueIndex("cu_role_sync_contract_uniq").on(
      t.clientId,
      t.destinationId,
    ),
    conflictIdx: index("cu_role_sync_contract_conflict_idx").on(t.conflictState),
  }),
);

export const cuRoleSyncTransitionEvidence = pgTable(
  "cu_role_sync_transition_evidence",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    receiptId: varchar("receipt_id"),
    commandId: varchar("command_id"),
    clientId: varchar("client_id").notNull(),
    destinationId: varchar("destination_id"),
    departmentId: varchar("department_id"),
    responsibility: varchar("responsibility"),
    actorType: varchar("actor_type").notNull(),
    actorId: varchar("actor_id"),
    source: varchar("source").notNull(),
    beforeAssignment: jsonb("before_assignment"),
    afterAssignment: jsonb("after_assignment"),
    localRevision: integer("local_revision").notNull(),
    vendorRevision: varchar("vendor_revision"),
    outcome: varchar("outcome").notNull(),
    details: jsonb("details"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    receiptDestinationUniq: uniqueIndex("cu_role_sync_evidence_receipt_dest_uniq").on(
      t.receiptId,
      t.destinationId,
    ),
    clientCreatedIdx: index("cu_role_sync_evidence_client_created_idx").on(
      t.clientId,
      t.createdAt,
    ),
    destinationCreatedIdx: index("cu_role_sync_evidence_dest_created_idx").on(
      t.destinationId,
      t.createdAt,
    ),
  }),
);

export type CuRoleSyncContract = typeof cuRoleSyncContracts.$inferSelect;
export type CuRoleSyncTransitionEvidence =
  typeof cuRoleSyncTransitionEvidence.$inferSelect;
