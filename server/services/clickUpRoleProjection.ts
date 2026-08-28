/**
 * Task #5156 — ClickUp role projection service + work-queue handler.
 *
 * Architecture:
 *   - Commands + initial queue wakes staged inside existing assignment
 *     transactions (no network).
 *   - After commit: bounded immediate attempt for single writes + best-effort
 *     coalesced kick (the in-transaction wake is the durable delivery path).
 *   - Worker: FOR UPDATE SKIP LOCKED lease, claim/snapshot, release DB,
 *     call vendor, re-acquire DB, finalize with CAS lease token.
 *   - Drift: if read-back sees wrong user, persist drift and re-project.
 *   - Terminal: dead-letter after maxAttempts or non-retryable error.
 *     Fires `integration.clickup.role_projection_terminal` alert on terminal.
 *   - Boot catch-up: one-shot re-enqueue of pending commands missing kicks.
 *   - Kill switch: clickup_role_projection pauses command draining.
 *   - Status/manual-resync: direct read, can mark drift, re-enqueue.
 *   - Handler drains max 50 per invocation then self-continues.
 *   - attempt_count = processing attempts; mutation_attempts = actual vendor POST/DELETE.
 *
 * Idempotency:
 *   - Same revision on an in-flight (ambiguous/pending/drift) command → NO UPDATE.
 *   - Same revision on a terminal/synced command → re-pend (re-project).
 *   - Different revision → always supersede (reset and re-pend).
 *
 * Missing ClickUp identity:
 *   - desired NoBull user present but no ClickUp ID → status=blocked, code=missing_identity.
 *   - NEVER treated as a clear operation.
 *
 * Environment:
 *   CLICKUP_ROLE_PROJECTION_ENVIRONMENT absent → unconfigured.
 *   "sandbox" → sandbox mode (writes allowed; fails closed against prod list 901417549202).
 *   "production" → requires destination enabled + sandbox-exit + owner approvals.
 *
 * @db-pool-intent: worker
 */
// @db-pool-intent: worker

import crypto from "crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  cuRoleProjectionCommands,
  cuRoleProjectionDestinations,
  cuRoleProjectionClientTargets,
  cuClientListMappings,
  type CuRoleProjectionDestination,
  type CuRoleProjectionClientTarget,
  type CuClientListMapping,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { departmentSupportsChecker } from "@shared/departmentRoleCapabilities";
import { isValidClickUpUserId } from "./clickUpRoleProjectionClient";
// ─── Environment resolution + retry delays ────────────────────────────────────
// Delegated to the dependency-free leaf so that clickUpRoleProjectionAdmin.ts
// and clickUpRoleProjectionWorker.ts can import these without forming a cycle
// through this barrel module.
import {
  resolveProjectionEnvironment,
  type ProjectionEnvironment,
  projectionRetryDelayMs,
} from "./clickUpRoleProjectionEnv";
import { enqueueProjectionWakeInTx } from "./clickUpRoleProjectionKick";
export {
  resolveProjectionEnvironment,
  type ProjectionEnvironment,
  projectionRetryDelayMs,
} from "./clickUpRoleProjectionEnv";

export { CLICKUP_ROLE_PROJECTION_QUEUE } from "./clickUpRoleProjectionKick";

/** Lease duration: 5 min. */
const LEASE_MS = 5 * 60_000;

/** Max commands drained per handler invocation before self-continuation. */
const MAX_DRAIN_PER_INVOCATION = 50;

// ─── Revision computation ─────────────────────────────────────────────────────

/**
 * Deterministic revision token: SHA-256 of (clientId + destinationId +
 * desiredUserId + desiredClickupUserId). Same inputs → same revision →
 * duplicate requests converge (idempotency).
 */
export function computeProjectionRevision(
  clientId: string,
  destinationId: string,
  desiredUserId: string | null,
  desiredClickupUserId: string | null,
): string {
  return crypto
    .createHash("sha256")
    .update(
      `${clientId}\x00${destinationId}\x00${desiredUserId ?? ""}\x00${desiredClickupUserId ?? ""}`,
    )
    .digest("hex")
    .slice(0, 32);
}

// ─── Projection status query ──────────────────────────────────────────────────

export type ProjectionStatusKind =
  | "nobull_only"
  | "pending"
  | "ambiguous"
  | "synced"
  | "failed"
  | "blocked"
  | "disabled"
  | "drift"
  | "unconfigured";

export interface ProjectionStatusResult {
  clientId: string;
  departmentId: string;
  responsibility: string;
  kind: ProjectionStatusKind;
  desiredUserId: string | null;
  desiredClickupUserId: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  updatedAt: Date;
}

/**
 * Honest status per client/department/role. Direct DB read with no periodic
 * scan — can mark drift and enqueue a correction job.
 *
 * Returns "nobull_only" when no destination is configured for the
 * department+responsibility. Returns "unconfigured" when the projection
 * environment is not set.
 */
export async function getProjectionStatus(args: {
  clientId: string;
  departmentId: string;
  responsibility: string;
}): Promise<ProjectionStatusResult> {
  const env = resolveProjectionEnvironment();
  if (env === "unconfigured") {
    return {
      clientId: args.clientId,
      departmentId: args.departmentId,
      responsibility: args.responsibility,
      kind: "unconfigured",
      desiredUserId: null,
      desiredClickupUserId: null,
      lastError: null,
      lastErrorCode: null,
      attemptCount: 0,
      nextAttemptAt: null,
      updatedAt: new Date(),
    };
  }

  return withDbAttribution("cuRoleProjection:status", async () => {
    const db = getDb();
    const [dest] = await db
      .select()
      .from(cuRoleProjectionDestinations)
      .where(
        and(
          eq(cuRoleProjectionDestinations.departmentId, args.departmentId),
          eq(cuRoleProjectionDestinations.responsibility, args.responsibility),
          eq(cuRoleProjectionDestinations.environment, env),
        ),
      )
      .limit(1);

    if (!dest) {
      return {
        clientId: args.clientId,
        departmentId: args.departmentId,
        responsibility: args.responsibility,
        kind: "nobull_only" as ProjectionStatusKind,
        desiredUserId: null,
        desiredClickupUserId: null,
        lastError: null,
        lastErrorCode: null,
        attemptCount: 0,
        nextAttemptAt: null,
        updatedAt: new Date(),
      };
    }

    if (!dest.enabled) {
      return {
        clientId: args.clientId,
        departmentId: args.departmentId,
        responsibility: args.responsibility,
        kind: "disabled" as ProjectionStatusKind,
        desiredUserId: null,
        desiredClickupUserId: null,
        lastError: null,
        lastErrorCode: null,
        attemptCount: 0,
        nextAttemptAt: null,
        updatedAt: dest.updatedAt,
      };
    }

    const [cmd] = await db
      .select()
      .from(cuRoleProjectionCommands)
      .where(
        and(
          eq(cuRoleProjectionCommands.clientId, args.clientId),
          eq(cuRoleProjectionCommands.destinationId, dest.id),
        ),
      )
      .limit(1);

    if (!cmd) {
      return {
        clientId: args.clientId,
        departmentId: args.departmentId,
        responsibility: args.responsibility,
        kind: "nobull_only" as ProjectionStatusKind,
        desiredUserId: null,
        desiredClickupUserId: null,
        lastError: null,
        lastErrorCode: null,
        attemptCount: 0,
        nextAttemptAt: null,
        updatedAt: dest.updatedAt,
      };
    }

    return {
      clientId: args.clientId,
      departmentId: args.departmentId,
      responsibility: args.responsibility,
      kind: cmd.status as ProjectionStatusKind,
      desiredUserId: cmd.desiredUserId ?? null,
      desiredClickupUserId: cmd.desiredClickupUserId ?? null,
      lastError: cmd.lastError ?? null,
      lastErrorCode: cmd.lastErrorCode ?? null,
      attemptCount: cmd.attemptCount,
      nextAttemptAt: cmd.nextAttemptAt ?? null,
      updatedAt: cmd.updatedAt,
    };
  });
}

// ─── Command staging (inside transaction) ────────────────────────────────────

export interface ProjectionCommandStageArgs {
  clientId: string;
  destinationId: string;
  desiredUserId: string | null;
  desiredClickupUserId: string | null;
  targetSnapshot?: Record<string, unknown>;
  /** When true, the desired NoBull user exists but has no ClickUp ID → blocked with missing_identity */
  missingIdentity?: boolean;
}

/**
 * Stage (upsert) a projection command inside an existing transaction.
 * No network calls.
 *
 * Idempotency rules:
 *   - Same revision → NO UPDATE (preserve existing row entirely, including
 *     in-flight leases AND terminal/synced state). A duplicate assignment save
 *     never resets a lease and never auto-repends a terminal row.
 *   - Different revision → always supersede (reset counters, re-pend).
 *   Only a NEW desired revision or an authorized manual resync re-pends terminal.
 */
export async function stageProjectionCommandInTx(
  tx: any,
  args: ProjectionCommandStageArgs,
): Promise<void> {
  const revision = computeProjectionRevision(
    args.clientId,
    args.destinationId,
    args.desiredUserId,
    args.desiredClickupUserId,
  );

  if (args.missingIdentity) {
    // Desired NoBull user present but has no ClickUp ID: stage as blocked/missing_identity.
    // Never treated as a clear operation.
    await tx.execute(sql`
      INSERT INTO cu_role_projection_commands (
        client_id, destination_id, desired_user_id, desired_clickup_user_id,
        revision, target_snapshot, status, attempt_count, mutation_attempts, max_attempts,
        last_error, last_error_code
      ) VALUES (
        ${args.clientId}, ${args.destinationId},
        ${args.desiredUserId ?? null}, NULL,
        ${revision},
        ${args.targetSnapshot ? JSON.stringify(args.targetSnapshot) : null}::jsonb,
        'blocked', 0, 0, 5,
        'Desired NoBull user has no ClickUp identity configured',
        'missing_identity'
      )
      ON CONFLICT (client_id, destination_id) DO UPDATE SET
        desired_user_id = EXCLUDED.desired_user_id,
        desired_clickup_user_id = NULL,
        revision = EXCLUDED.revision,
        target_snapshot = EXCLUDED.target_snapshot,
        status = 'blocked',
        last_error = EXCLUDED.last_error,
        last_error_code = 'missing_identity',
        updated_at = now()
    `);
    return;
  }

  const staged = await tx.execute(sql`
    INSERT INTO cu_role_projection_commands (
      client_id, destination_id, desired_user_id, desired_clickup_user_id,
      revision, target_snapshot, status, attempt_count, mutation_attempts, max_attempts,
      lease_owner, lease_token, lease_expires_at, next_attempt_at, last_error, last_error_code,
      verified_at, drift_detected_at, terminal_at
    ) VALUES (
      ${args.clientId},
      ${args.destinationId},
      ${args.desiredUserId ?? null},
      ${args.desiredClickupUserId ?? null},
      ${revision},
      ${args.targetSnapshot ? JSON.stringify(args.targetSnapshot) : null}::jsonb,
      'pending',
      0, 0, 5,
      NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL
    )
    ON CONFLICT (client_id, destination_id) DO UPDATE SET
      -- Different revision: supersede, reset counters, and re-pend. The WHERE
      -- makes a same-revision save a true no-op (and therefore returns no row),
      -- preserving leases and terminal/synced state exactly.
      desired_user_id = EXCLUDED.desired_user_id,
      desired_clickup_user_id = EXCLUDED.desired_clickup_user_id,
      revision = EXCLUDED.revision,
      target_snapshot = EXCLUDED.target_snapshot,
      status = 'pending',
      attempt_count = 0,
      mutation_attempts = 0,
      next_attempt_at = NULL,
      lease_owner = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error = NULL,
      last_error_code = NULL,
      verified_at = NULL,
      drift_detected_at = NULL,
      terminal_at = NULL,
      updated_at = now()
    WHERE cu_role_projection_commands.revision IS DISTINCT FROM EXCLUDED.revision
    RETURNING id, revision, attempt_count
  `);

  const stagedRow = (staged.rows as Array<{
    id: string;
    revision: string;
    attempt_count: number;
  }>)[0];
  if (!stagedRow) return;

  // Advance the local side of the bidirectional contract only for a genuinely
  // new desired revision. This shares the assignment transaction, so a queued
  // command can never exist without its durable causal revision/evidence.
  await tx.execute(sql`
    WITH contract AS (
      INSERT INTO cu_role_sync_contracts (
        client_id, destination_id, local_revision, last_outbound_revision,
        conflict_state, conflict_evidence
      ) VALUES (
        ${args.clientId}, ${args.destinationId}, 1, ${revision}, 'none', NULL
      )
      ON CONFLICT (client_id, destination_id) DO UPDATE SET
        local_revision = cu_role_sync_contracts.local_revision + 1,
        last_outbound_revision = EXCLUDED.last_outbound_revision,
        conflict_state = 'none',
        conflict_evidence = NULL,
        updated_at = now()
      RETURNING local_revision
    )
    INSERT INTO cu_role_sync_transition_evidence (
      command_id, client_id, destination_id, department_id, responsibility,
      actor_type, actor_id, source, before_assignment, after_assignment,
      local_revision, outcome, details
    )
    SELECT
      ${stagedRow.id}, ${args.clientId}, ${args.destinationId},
      destination.department_id, destination.responsibility,
      'nobull', 'assignment_boundary', 'nobull_assignment',
       NULL,
       jsonb_build_object('userId', (${args.desiredUserId ?? null})::text),
      contract.local_revision, 'outbound_staged',
      jsonb_build_object(
        'commandRevision', (${revision})::text,
         'desiredClickupUserId', (${args.desiredClickupUserId ?? null})::text
      )
    FROM contract
    JOIN cu_role_projection_destinations destination
      ON destination.id = ${args.destinationId}
  `);

  // The initial wake is part of the SAME short transaction as the new desired
  // command revision. A failed post-commit accelerator kick therefore cannot
  // strand this command before its first vendor attempt.
  await enqueueProjectionWakeInTx(tx, new Date(), {
    commandId: stagedRow.id,
    revision: stagedRow.revision,
    attemptCount: Number(stagedRow.attempt_count),
  });
}

// ─── Stage commands for all configured roles ──────────────────────────────────

export interface ProjectionRoleInput {
  clientId: string;
  departmentId: string;
  responsibility: string;
  desiredUserId: string | null;
  desiredClickupUserId: string | null;
}

export interface ProjectionCommandRef {
  clientId: string;
  destinationId: string;
}

export interface ProjectionStageSummary {
  staged: number;
  nobullOnly: number;
  blocked: number;
  disabled: number;
  missingIdentity: number;
  /** Exact (clientId, destinationId) refs for commands staged as pending — for bounded immediate attempts. */
  stagedRefs: ProjectionCommandRef[];
}

/**
 * Stage projection commands for a set of role inputs within a transaction.
 * Resolves destinations for the current environment. NoBull-only when no
 * destination configured; blocked when mapping missing; disabled when dest
 * not enabled in production.
 *
 * Missing ClickUp identity (desiredUserId set but desiredClickupUserId null):
 * treated as missing_identity/blocked — never as a clear operation.
 */
export async function stageProjectionCommandsInTx(
  tx: any,
  roles: ProjectionRoleInput[],
): Promise<ProjectionStageSummary> {
  // Only supported responsibilities may stage ClickUp projection commands.
  roles = roles.filter(
    (role) =>
      (role.responsibility === "doer" ||
        (role.responsibility === "checker" &&
          departmentSupportsChecker(role.departmentId))),
  );
  const env = resolveProjectionEnvironment();
  if (env === "unconfigured" || roles.length === 0) {
    return {
      staged: 0,
      nobullOnly: roles.length,
      blocked: 0,
      disabled: 0,
      missingIdentity: 0,
      stagedRefs: [],
    };
  }

  const departmentIds = [...new Set(roles.map((r) => r.departmentId))];
  const responsibilities = [...new Set(roles.map((r) => r.responsibility))];

  // Load destinations for these departments+responsibilities+env.
  const destinations = await tx
    .select()
    .from(cuRoleProjectionDestinations)
    .where(
      and(
        inArray(cuRoleProjectionDestinations.departmentId, departmentIds),
        inArray(cuRoleProjectionDestinations.responsibility, responsibilities),
        eq(cuRoleProjectionDestinations.environment, env),
      ),
      )
      // A department hard-delete takes the same destination-row lock before
      // deleting commands, targets, and destinations. This prevents a staged
      // assignment from inserting an orphan command after that cascade.
      .for("update");

  const destByKey = new Map<string, CuRoleProjectionDestination>();
  for (const dest of destinations as CuRoleProjectionDestination[]) {
    destByKey.set(`${dest.departmentId}:${dest.responsibility}`, dest);
  }

  // Load client targets for each destination + client combo.
  const destIds = (destinations as CuRoleProjectionDestination[]).map((d) => d.id);
  const clientIds = [...new Set(roles.map((r) => r.clientId))];
  const clientTargets =
    destIds.length > 0 && clientIds.length > 0
      ? await tx
          .select()
          .from(cuRoleProjectionClientTargets)
          .where(
            and(
              inArray(cuRoleProjectionClientTargets.clientId, clientIds),
              inArray(cuRoleProjectionClientTargets.destinationId, destIds),
            ),
          )
      : [];

  // Canonical production Client List targets are role-independent and must
  // resolve through the stable client mapping, never a repeated per-destination
  // target or a normalized name. Non-canonical/sandbox destinations retain the
  // legacy target table for backward compatibility.
  const canonicalMappings =
    clientIds.length > 0
      ? await tx
          .select()
          .from(cuClientListMappings)
          .where(inArray(cuClientListMappings.clientId, clientIds))
      : [];

  const targetByKey = new Map<string, CuRoleProjectionClientTarget>();
  for (const t of clientTargets as CuRoleProjectionClientTarget[]) {
    targetByKey.set(`${t.clientId}:${t.destinationId}`, t);
  }
  const canonicalMappingByClient = new Map<string, CuClientListMapping>();
  for (const mapping of canonicalMappings as CuClientListMapping[]) {
    if (
      mapping.listId === "901417549202" &&
      mapping.syncState === "verified"
    ) {
      canonicalMappingByClient.set(mapping.clientId, mapping);
    }
  }

  let staged = 0;
  let nobullOnly = 0;
  let blocked = 0;
  let disabled = 0;
  let missingIdentity = 0;
  const stagedRefs: ProjectionCommandRef[] = [];

  for (const role of roles) {
    const dest = destByKey.get(`${role.departmentId}:${role.responsibility}`);
    if (!dest) {
      nobullOnly++;
      continue;
    }

    // Production: require enabled + approvals.
    if (env === "production") {
      if (!dest.enabled || !dest.sandboxExitApprovedAt || !dest.ownerApprovedAt) {
        disabled++;
        continue;
      }
    }

    if (!dest.enabled) {
      disabled++;
      continue;
    }

    // Missing ClickUp identity: desired NoBull user present but no ClickUp ID.
    // Never treat as clear — stage as blocked/missing_identity.
    if (role.desiredUserId !== null && role.desiredClickupUserId === null) {
      await stageProjectionCommandInTx(tx, {
        clientId: role.clientId,
        destinationId: dest.id,
        desiredUserId: role.desiredUserId,
        desiredClickupUserId: null,
        missingIdentity: true,
        targetSnapshot: {
          listId: dest.listId,
          peopleFieldId: dest.peopleFieldId,
          targetKind: dest.targetKind,
        },
      });
      missingIdentity++;
      continue;
    }

    // Validate ClickUp ID format (digits only) if present.
    if (
      role.desiredClickupUserId !== null &&
      !isValidClickUpUserId(role.desiredClickupUserId)
    ) {
      // Malformed ClickUp ID — block with invalid_field.
      await tx.execute(sql`
        INSERT INTO cu_role_projection_commands (
          client_id, destination_id, desired_user_id, desired_clickup_user_id,
          revision, status, attempt_count, mutation_attempts, max_attempts,
          last_error, last_error_code
        ) VALUES (
          ${role.clientId}, ${dest.id}, ${role.desiredUserId ?? null}, ${role.desiredClickupUserId},
          ${computeProjectionRevision(role.clientId, dest.id, role.desiredUserId, role.desiredClickupUserId)},
          'blocked', 0, 0, 5,
          ${"ClickUp user ID must be digits only: " + String(role.desiredClickupUserId).slice(0, 50)},
          'invalid_field'
        )
        ON CONFLICT (client_id, destination_id) DO UPDATE SET
          status = 'blocked',
          last_error = EXCLUDED.last_error,
          last_error_code = 'invalid_field',
          desired_user_id = EXCLUDED.desired_user_id,
          desired_clickup_user_id = EXCLUDED.desired_clickup_user_id,
          revision = EXCLUDED.revision,
          updated_at = now()
      `);
      blocked++;
      continue;
    }

    // Resolve the exact task target by target kind.
    //   direct_task        → dest.targetId (single company-scope task), owning list = dest.listId
    //   client_list_parent → per-client target row, owning list = dest.listId
    let resolvedTargetId: string | null = null;
    let resolvedListSnapshot: string | null = null;

    if (dest.targetKind === "direct_task") {
      resolvedTargetId = dest.targetId ?? null;
      resolvedListSnapshot = dest.listId ?? null;
    } else if (dest.listId === "901417549202") {
      const mapping = canonicalMappingByClient.get(role.clientId);
      resolvedTargetId = mapping?.taskId ?? null;
      resolvedListSnapshot = mapping?.listId ?? dest.listId ?? null;
    } else {
      // client_list_parent (default): needs a per-client target mapping.
      const target = targetByKey.get(`${role.clientId}:${dest.id}`);
      resolvedTargetId = target?.targetId ?? null;
      resolvedListSnapshot = dest.listId ?? null;
    }

    if (!resolvedTargetId) {
      // No target: visibly blocked with missing_target, not silently omitted.
      await tx.execute(sql`
        INSERT INTO cu_role_projection_commands (
          client_id, destination_id, desired_user_id, desired_clickup_user_id,
          revision, status, attempt_count, mutation_attempts, max_attempts,
          last_error, last_error_code
        ) VALUES (
          ${role.clientId}, ${dest.id}, ${role.desiredUserId ?? null}, ${role.desiredClickupUserId ?? null},
          ${computeProjectionRevision(role.clientId, dest.id, role.desiredUserId, role.desiredClickupUserId)},
          'blocked', 0, 0, 5,
          'No target configured for this client/destination',
          'missing_target'
        )
        ON CONFLICT (client_id, destination_id) DO UPDATE SET
          status = 'blocked',
          last_error = EXCLUDED.last_error,
          last_error_code = 'missing_target',
          desired_user_id = EXCLUDED.desired_user_id,
          desired_clickup_user_id = EXCLUDED.desired_clickup_user_id,
          revision = EXCLUDED.revision,
          updated_at = now()
      `);
      blocked++;
      continue;
    }

    const clientTarget =
      dest.targetKind === "direct_task"
        ? undefined
        : targetByKey.get(`${role.clientId}:${dest.id}`);
    const resolvedListId =
      dest.listId === "901417549202"
        ? canonicalMappingByClient.get(role.clientId)?.listId ?? null
        : clientTarget?.resolvedListId ?? null;

    // Stage command with target snapshot.
    await stageProjectionCommandInTx(tx, {
      clientId: role.clientId,
      destinationId: dest.id,
      desiredUserId: role.desiredUserId,
      desiredClickupUserId: role.desiredClickupUserId,
      targetSnapshot: {
        targetId: resolvedTargetId,
        resolvedListId,
        listId: resolvedListSnapshot,
        peopleFieldId: dest.peopleFieldId,
        targetKind: dest.targetKind,
      },
    });
    staged++;
    stagedRefs.push({ clientId: role.clientId, destinationId: dest.id });
  }

  return { staged, nobullOnly, blocked, disabled, missingIdentity, stagedRefs };
}


// ─── Durable worker / lifecycle (extracted module) ───────────────────────────
// The claim/finalize/processOneCommand/job-handler/boot-catchup/manual-resync
// lifecycle now lives in clickUpRoleProjectionWorker.ts (execution-time gate +
// injectable seams). Re-exported here so existing importers of
// "./clickUpRoleProjection" keep working unchanged.
export {
  claimProjectionCommand,
  claimProjectionCommandForTarget,
  processOneCommand,
  attemptProjectionCommandNow,
  handleClickUpRoleProjectionJob,
  scheduleClickUpRoleProjectionBootCatchup,
  manualResyncProjectionCommand,
  readProjectionCommandStatuses,
  __test_setProjectionWorkerDeps,
  __test_loadCurrentProjectionConfig,
  type ClaimedCommand,
  type ProjectionWorkerDeps,
  type CurrentProjectionConfig,
  type ProjectionRefStatus,
} from "./clickUpRoleProjectionWorker";

// ─── Config management / admin surface (extracted module) ────────────────────
// The admin/config primitives now live in clickUpRoleProjectionAdmin.ts to keep
// this module focused on staging. Re-exported here so all existing importers of
// "./clickUpRoleProjection" keep working unchanged.
export {
  listRoleProjectionConfiguration,
  upsertRoleProjectionDestination,
  upsertRoleProjectionClientTarget,
  listRoleProjectionStatuses,
  manualResyncProjectionByRole,
  type RoleProjectionDestinationInput,
  type RoleProjectionClientTargetInput,
  type ProjectionStatusFilter,
  type ProjectionStatusRow,
  type ProjectionStatusListResult,
} from "./clickUpRoleProjectionAdmin";

export {
  bindCanonicalClientTask,
  classifyCanonicalClientListPreflight,
  deriveRequiredRoleColumns,
  getRoleColumnLabel,
  findCanonicalMappingConflict,
  getCanonicalClientListPreflight,
  listCanonicalClientListConfiguration,
  __setCanonicalClientListEvidenceLoaderForTest,
  type BindCanonicalClientTaskInput,
  type CanonicalClientListConfiguration,
  type CanonicalClientListPreflight,
  type CanonicalClientListPreflightUnavailable,
} from "./clickUpClientListIdentity";
