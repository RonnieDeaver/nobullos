/**
 * ClickUp role projection — ADMIN/CONFIG service primitives (Task #5156).
 *
 * Extracted from clickUpRoleProjection.ts to keep the durable worker/staging
 * module focused. This module owns the exported, human-facing configuration and
 * status surface: destination/client-target upserts + validation, the joined
 * status query, and manual resync-by-role. No vendor egress lives here.
 *
 * The worker/staging module (clickUpRoleProjection.ts) re-exports everything
 * here through its barrel, so existing importers are unaffected.
 */

// @db-pool-intent: api

import { and, eq, sql } from "drizzle-orm";
import {
  cuRoleProjectionCommands,
  cuRoleProjectionDestinations,
  cuRoleProjectionClientTargets,
  sdDepartments,
  type CuRoleProjectionDestination,
  type CuRoleProjectionClientTarget,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { departmentSupportsChecker } from "@shared/departmentRoleCapabilities";
import { bindArrayParam } from "../utils/sqlArray";
import {
  CANONICAL_PRODUCTION_LIST_ID,
  CLICKUP_DOER_FIELD_ID,
  CLICKUP_CHECKER_FIELD_ID,
  PAID_SEARCH_DEPT_NAME,
} from "./adsOs/paidSearchRoleContract";

/**
 * Task #5157 fix 3 — Paid Search-specific destination policy, enforced in the
 * upsert transaction after the department row is loaded. Generic departments
 * are unaffected. Returns error strings (empty = ok).
 *
 * For a destination whose department is the Paid Search department:
 *  - Only doer/checker responsibilities are accepted.
 *  - The People field is FIXED per role: doer → CLICKUP_DOER_FIELD_ID,
 *    checker → CLICKUP_CHECKER_FIELD_ID.
 *  - targetKind must be client_list_parent (per-parent projection only).
 *  - production list must be EXACTLY the canonical production list; a sandbox
 *    list must DIFFER from it.
 * Drift edits are rejected even when the destination is (or would be) disabled,
 * so a disabled row cannot be quietly pointed at the wrong field/list/kind and
 * later enabled.
 */
function validatePaidSearchDestinationPolicy(
  input: RoleProjectionDestinationInput,
): string[] {
  const errors: string[] = [];
  if (input.responsibility === "doer" && input.peopleFieldId !== CLICKUP_DOER_FIELD_ID) {
    errors.push(
      `Paid Search doer destination must use the fixed doer People field ${CLICKUP_DOER_FIELD_ID}`,
    );
  }
  if (input.responsibility === "checker" && input.peopleFieldId !== CLICKUP_CHECKER_FIELD_ID) {
    errors.push(
      `Paid Search checker destination must use the fixed checker People field ${CLICKUP_CHECKER_FIELD_ID}`,
    );
  }
  if (input.targetKind !== "client_list_parent") {
    errors.push(
      "Paid Search destinations must use targetKind client_list_parent (per-parent projection only)",
    );
  }
  if (input.environment === "production" && input.listId !== CANONICAL_PRODUCTION_LIST_ID) {
    errors.push(
      `Paid Search production destination must use the canonical production list ${CANONICAL_PRODUCTION_LIST_ID}`,
    );
  }
  if (input.environment === "sandbox" && input.listId === CANONICAL_PRODUCTION_LIST_ID) {
    errors.push(
      "Paid Search sandbox destination must use a list that differs from the canonical production list",
    );
  }
  return errors;
}
import {
  enqueueClickUpRoleProjectionJob,
  enqueueProjectionWakesInTx,
} from "./clickUpRoleProjectionKick";
import {
  resolveProjectionEnvironment,
  type ProjectionEnvironment,
} from "./clickUpRoleProjectionEnv";

function isProjectableResponsibility(
  responsibility: string,
  departmentId: string,
): boolean {
  return (
    responsibility === "doer" ||
    (responsibility === "checker" && departmentSupportsChecker(departmentId))
  );
}

/**
 * Approval action verbs. Callers NEVER supply timestamps/actors directly —
 * the service stamps now()+authenticated actor on approve, clears on revoke,
 * and preserves the existing value when omitted. This prevents forging an
 * approval by POSTing an arbitrary timestamp.
 */
export type ApprovalAction = "approve" | "revoke";

export interface RoleProjectionDestinationInput {
  workspaceId: string;
  departmentId: string;
  responsibility: string;
  targetKind: string;
  /** client_list_parent: owning list UUID required */
  listId: string | null;
  /** direct_task (company-scope): the single ClickUp task ID required */
  targetId?: string | null;
  peopleFieldId: string;
  maxPeople?: number;
  environment: string;
  enabled?: boolean;
  /**
   * Authenticated actor id (from session, never client input). REQUIRED when
   * any approval action is supplied — an approval must be attributable.
   */
  actorId?: string | null;
  /** 'approve' stamps now()+actor; 'revoke' clears; omitted = preserve existing. */
  sandboxExitApproval?: ApprovalAction;
  /** 'approve' stamps now()+actor; 'revoke' clears; omitted = preserve existing. */
  ownerApproval?: ApprovalAction;
}

/** Resolved approval columns after applying actions against the existing row. */
interface ResolvedApprovals {
  sandboxExitApprovedAt: Date | null;
  sandboxExitApprovedBy: string | null;
  ownerApprovedAt: Date | null;
  ownerApprovedBy: string | null;
}

export interface RoleProjectionClientTargetInput {
  clientId: string;
  destinationId: string;
  targetId: string;
  resolvedListId?: string | null;
  provenance?: Record<string, unknown> | null;
}

/**
 * Validate a destination input. Returns an array of error strings (empty = valid).
 * Validates: responsibility/environment/targetKind enum, maxPeople=1, listId present,
 * peopleFieldId non-empty, production approval requirements, sandbox non-canonical list.
 * No vendor egress.
 */
function validateDestinationInput(
  input: RoleProjectionDestinationInput,
): string[] {
  const errors: string[] = [];
  const validResponsibilities = ["doer", "checker"];
  if (!validResponsibilities.includes(input.responsibility)) {
    errors.push(
      `responsibility must be one of: ${validResponsibilities.join(", ")}; got "${input.responsibility}"`,
    );
  }
  const validEnvs = ["sandbox", "production"];
  if (!validEnvs.includes(input.environment)) {
    errors.push(`environment must be "sandbox" or "production"; got "${input.environment}"`);
  }
  const validTargetKinds = ["direct_task", "client_list_parent"];
  if (!validTargetKinds.includes(input.targetKind)) {
    errors.push(
      `targetKind must be "direct_task" or "client_list_parent"; got "${input.targetKind}"`,
    );
  }
  const maxPeople = input.maxPeople ?? 1;
  if (maxPeople !== 1) {
    errors.push(`maxPeople must be 1 (role projection is always single-person); got ${maxPeople}`);
  }
  // Every destination needs an owning list: each task write is preceded by a
  // live owning-list ownership proof (fetchProjectionTask). This applies to
  // BOTH kinds, including direct_task.
  if (!input.listId) {
    errors.push("listId (owning list) is required for all destinations");
  }
  // direct_task (company-scope) additionally needs the single task ID; its
  // owning list is destination.listId. Per-client targets are not used.
  if (input.targetKind === "direct_task" && !input.targetId) {
    errors.push("targetId (the ClickUp task) is required for direct_task destinations");
  }
  if (!input.peopleFieldId || !input.peopleFieldId.trim()) {
    errors.push("peopleFieldId is required");
  }
  // Sandbox must not target the canonical production list.
  if (input.environment === "sandbox" && input.listId === CANONICAL_PRODUCTION_LIST_ID) {
    errors.push(
      `sandbox destination must not use canonical production list ID ${CANONICAL_PRODUCTION_LIST_ID}`,
    );
  }
  // An approval action must be attributable to an authenticated actor.
  const hasApprovalAction =
    input.sandboxExitApproval === "approve" || input.ownerApproval === "approve";
  if (hasApprovalAction && !input.actorId) {
    errors.push("an authenticated actor is required to approve a destination");
  }
  const validActions: Array<ApprovalAction | undefined> = ["approve", "revoke", undefined];
  if (!validActions.includes(input.sandboxExitApproval)) {
    errors.push('sandboxExitApproval must be "approve" or "revoke"');
  }
  if (!validActions.includes(input.ownerApproval)) {
    errors.push('ownerApproval must be "approve" or "revoke"');
  }
  return errors;
}

/**
 * Apply approval actions against the existing row's approval columns:
 *   approve  → now() + authenticated actor
 *   revoke   → null both the timestamp and the actor
 *   omitted  → preserve the existing value
 * Callers cannot inject arbitrary timestamps/actors.
 */
function resolveApprovals(
  input: RoleProjectionDestinationInput,
  existing: CuRoleProjectionDestination | null,
  now: Date,
): ResolvedApprovals {
  const actor = input.actorId ?? null;
  const applyOne = (
    action: ApprovalAction | undefined,
    existingAt: Date | null,
    existingBy: string | null,
  ): { at: Date | null; by: string | null } => {
    if (action === "approve") return { at: now, by: actor };
    if (action === "revoke") return { at: null, by: null };
    return { at: existingAt, by: existingBy };
  };
  const sandbox = applyOne(
    input.sandboxExitApproval,
    existing?.sandboxExitApprovedAt ?? null,
    existing?.sandboxExitApprovedBy ?? null,
  );
  const owner = applyOne(
    input.ownerApproval,
    existing?.ownerApprovedAt ?? null,
    existing?.ownerApprovedBy ?? null,
  );
  return {
    sandboxExitApprovedAt: sandbox.at,
    sandboxExitApprovedBy: sandbox.by,
    ownerApprovedAt: owner.at,
    ownerApprovedBy: owner.by,
  };
}

/**
 * Validate the RESOLVED row before write. A production destination that would
 * be enabled requires BOTH approvals present in the resolved state (so a
 * revocation of either approval cannot leave production enabled).
 */
function validateResolvedRow(
  input: RoleProjectionDestinationInput,
  approvals: ResolvedApprovals,
): string[] {
  const errors: string[] = [];
  if (input.environment === "production" && (input.enabled ?? false)) {
    if (!approvals.sandboxExitApprovedAt) {
      errors.push("cannot enable a production destination without sandbox-exit approval");
    }
    if (!approvals.ownerApprovedAt) {
      errors.push("cannot enable a production destination without owner approval");
    }
  }
  return errors;
}

/**
 * List all role projection destinations for the current environment.
 * No vendor egress.
 */
export async function listRoleProjectionConfiguration(): Promise<CuRoleProjectionDestination[]> {
  const env = resolveProjectionEnvironment();
  if (env === "unconfigured") return [];

  return withDbAttribution("cuRoleProjection:listConfig", async () => {
    const db = getDb();
    const destinations = await db
      .select()
      .from(cuRoleProjectionDestinations)
      .where(eq(cuRoleProjectionDestinations.environment, env));
    return destinations.filter(
      (destination) =>
        isProjectableResponsibility(
          destination.responsibility,
          destination.departmentId,
        ),
    );
  });
}

/**
 * Upsert a role projection destination. Validates input; returns validation errors
 * without writing if invalid. No vendor egress.
 */
export async function upsertRoleProjectionDestination(
  input: RoleProjectionDestinationInput,
): Promise<
  | { ok: true; destination: CuRoleProjectionDestination }
  | { ok: false; errors: string[] }
> {
  const errors = validateDestinationInput(input);
  if (errors.length > 0) return { ok: false, errors };

  return withDbAttribution("cuRoleProjection:upsertDest", async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      // Query the destination's department IN this transaction so the Paid
      // Search-specific policy (Task #5157 fix 3) is enforced against the
      // authoritative row, not caller-supplied hints. Generic departments skip
      // the policy entirely.
      const [department] = await tx
        .select({ id: sdDepartments.id, name: sdDepartments.name })
        .from(sdDepartments)
        .where(eq(sdDepartments.id, input.departmentId))
        .limit(1)
        // Department retirement holds this same row before it removes the
        // projection dependency graph. Either this upsert commits first and is
        // swept, or it sees the retired department as absent.
        .for("update");
      if (!department) {
        return { ok: false as const, errors: [`department ${input.departmentId} not found`] };
      }
      if (
        input.responsibility === "checker" &&
        !departmentSupportsChecker(department.id)
      ) {
        return {
          ok: false as const,
          errors: [`Department ${department.id} does not support the Checker role`],
        };
      }
      if (department.name === PAID_SEARCH_DEPT_NAME) {
        const policyErrors = validatePaidSearchDestinationPolicy(input);
        if (policyErrors.length > 0) {
          return { ok: false as const, errors: policyErrors };
        }
      }

      // Load the existing row (by the unique identity) so approval actions apply
      // against the PERSISTED approval state, not caller-supplied timestamps.
      const [existing] = await tx
        .select()
        .from(cuRoleProjectionDestinations)
        .where(
          and(
            eq(cuRoleProjectionDestinations.workspaceId, input.workspaceId),
            eq(cuRoleProjectionDestinations.departmentId, input.departmentId),
            eq(cuRoleProjectionDestinations.responsibility, input.responsibility),
            eq(
              cuRoleProjectionDestinations.environment,
              input.environment as "sandbox" | "production",
            ),
          ),
        )
        .limit(1);

      const now = new Date();
      const approvals = resolveApprovals(input, existing ?? null, now);

      // Validate the RESOLVED row: enabled production requires both approvals.
      const resolvedErrors = validateResolvedRow(input, approvals);
      if (resolvedErrors.length > 0) {
        return { ok: false as const, errors: resolvedErrors };
      }

      const [destination] = await tx
        .insert(cuRoleProjectionDestinations)
        .values({
          workspaceId: input.workspaceId,
          departmentId: input.departmentId,
          responsibility: input.responsibility,
          targetKind: input.targetKind,
          listId: input.listId ?? undefined,
          targetId: input.targetId ?? undefined,
          peopleFieldId: input.peopleFieldId,
          maxPeople: input.maxPeople ?? 1,
          environment: input.environment as "sandbox" | "production",
          enabled: input.enabled ?? false,
          sandboxExitApprovedAt: approvals.sandboxExitApprovedAt,
          sandboxExitApprovedBy: approvals.sandboxExitApprovedBy,
          ownerApprovedAt: approvals.ownerApprovedAt,
          ownerApprovedBy: approvals.ownerApprovedBy,
        })
        .onConflictDoUpdate({
          target: [
            cuRoleProjectionDestinations.workspaceId,
            cuRoleProjectionDestinations.departmentId,
            cuRoleProjectionDestinations.responsibility,
            cuRoleProjectionDestinations.environment,
          ],
          set: {
            targetKind: input.targetKind,
            listId: input.listId ?? undefined,
            targetId: input.targetId ?? undefined,
            peopleFieldId: input.peopleFieldId,
            maxPeople: input.maxPeople ?? 1,
            enabled: input.enabled ?? false,
            sandboxExitApprovedAt: approvals.sandboxExitApprovedAt,
            sandboxExitApprovedBy: approvals.sandboxExitApprovedBy,
            ownerApprovedAt: approvals.ownerApprovedAt,
            ownerApprovedBy: approvals.ownerApprovedBy,
            updatedAt: now,
          },
        })
        .returning();
      return { ok: true as const, destination };
    });
  });
}

/**
 * Upsert a client target mapping. No vendor egress.
 */
export async function upsertRoleProjectionClientTarget(
  input: RoleProjectionClientTargetInput,
): Promise<
  | { ok: true; target: CuRoleProjectionClientTarget }
  | { ok: false; errors: string[] }
> {
  const errors: string[] = [];
  if (!input.clientId) errors.push("clientId is required");
  if (!input.destinationId) errors.push("destinationId is required");
  if (!input.targetId) errors.push("targetId is required");
  if (errors.length > 0) return { ok: false, errors };

  return withDbAttribution("cuRoleProjection:upsertTarget", async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      // Serialize with department retirement, which locks every destination
      // before deleting its target rows. Without this lock, a writer that
      // observed a destination just before retirement could insert an orphan
      // target after the delete pass.
      const [destination] = await tx
        .select({
          id: cuRoleProjectionDestinations.id,
          departmentId: cuRoleProjectionDestinations.departmentId,
          responsibility: cuRoleProjectionDestinations.responsibility,
        })
        .from(cuRoleProjectionDestinations)
        .where(eq(cuRoleProjectionDestinations.id, input.destinationId))
        .limit(1)
        .for("update");
      if (!destination) {
        return {
          ok: false as const,
          errors: [`destination ${input.destinationId} not found`],
        };
      }
      if (!isProjectableResponsibility(destination.responsibility, destination.departmentId)) {
        return {
          ok: false as const,
          errors: [`Destination ${input.destinationId} uses an unsupported responsibility`],
        };
      }
      const [target] = await tx
        .insert(cuRoleProjectionClientTargets)
        .values({
          clientId: input.clientId,
          destinationId: input.destinationId,
          targetId: input.targetId,
          resolvedListId: input.resolvedListId ?? undefined,
          provenance: input.provenance ?? undefined,
        })
        .onConflictDoUpdate({
          target: [
            cuRoleProjectionClientTargets.clientId,
            cuRoleProjectionClientTargets.destinationId,
          ],
          set: {
            targetId: input.targetId,
            resolvedListId: input.resolvedListId ?? undefined,
            provenance: input.provenance ?? undefined,
            updatedAt: new Date(),
          },
        })
        .returning();
      return { ok: true as const, target };
    });
  });
}

export interface ProjectionStatusFilter {
  clientId?: string;
  departmentId?: string;
  responsibility?: string;
  status?: string;
  problemOnly?: boolean;
  limit?: number;
}

export interface ProjectionStatusRow {
  clientId: string | null;
  destinationId: string;
  departmentId: string;
  responsibility: string;
  kind: string;
  status: string;
  lastErrorCode: string | null;
  lastError: string | null;
  desiredUserId: string | null;
  desiredClickupUserId: string | null;
  observedClickupUserIds: unknown;
  attemptCount: number;
  mutationAttempts: number;
  maxAttempts: number;
  resyncEligible: boolean;
  nextAttemptAt: Date | null;
  updatedAt: Date | null;
}

export interface ProjectionStatusListResult {
  statuses: ProjectionStatusRow[];
  environment: ProjectionEnvironment;
}

/**
 * List projection command statuses as ONE joined bounded query.
 * Joins commands → destinations to expose departmentId/responsibility.
 * Honors clientId, departmentId, responsibility, problemOnly, limit (<=200).
 * Company-subject rows carry a "company:<departmentId>" client_id.
 */
export async function listRoleProjectionStatuses(
  filters: ProjectionStatusFilter = {},
): Promise<ProjectionStatusListResult> {
  const env = resolveProjectionEnvironment();
  if (env === "unconfigured") {
    return { statuses: [], environment: "unconfigured" };
  }

  const limit = Math.min(Math.max(1, filters.limit ?? 100), 200);
  // Problem statuses: anything not synced/nobull_only that the operator should see.
  const problemStatuses = ["pending", "ambiguous", "failed", "blocked", "drift"];

  return withDbAttribution("cuRoleProjection:listStatuses", async () => {
    const db = getDb();
    const res = await db.execute(sql`
      SELECT
        c.client_id                 AS client_id,
        c.destination_id            AS destination_id,
        d.department_id             AS department_id,
        d.responsibility            AS responsibility,
        c.status                    AS status,
        c.last_error_code           AS last_error_code,
        c.last_error                AS last_error,
        c.desired_user_id           AS desired_user_id,
        c.desired_clickup_user_id   AS desired_clickup_user_id,
        c.observed_clickup_user_ids AS observed_clickup_user_ids,
        c.attempt_count             AS attempt_count,
        c.mutation_attempts         AS mutation_attempts,
        c.max_attempts              AS max_attempts,
        (
          (
            (c.status = 'failed' AND c.terminal_at IS NOT NULL)
            OR c.status = 'blocked'
          )
          AND c.lease_owner IS NULL
          AND c.lease_token IS NULL
          AND c.lease_expires_at IS NULL
        )                            AS resync_eligible,
        c.next_attempt_at           AS next_attempt_at,
        c.updated_at                AS updated_at
      FROM cu_role_projection_commands c
      JOIN cu_role_projection_destinations d ON d.id = c.destination_id
      WHERE d.environment = ${env}
        ${filters.clientId ? sql`AND c.client_id = ${filters.clientId}` : sql``}
        ${filters.departmentId ? sql`AND d.department_id = ${filters.departmentId}` : sql``}
        ${filters.responsibility ? sql`AND d.responsibility = ${filters.responsibility}` : sql``}
        ${filters.status ? sql`AND c.status = ${filters.status}` : sql``}
        ${filters.problemOnly ? sql`AND c.status = ANY(${bindArrayParam(problemStatuses, "text")})` : sql``}
      ORDER BY c.updated_at DESC
      LIMIT ${limit}
    `);

    const statuses: ProjectionStatusRow[] = (res.rows as Array<Record<string, unknown>>).map(
      (r) => ({
        clientId: r.client_id ? String(r.client_id) : null,
        destinationId: String(r.destination_id),
        departmentId: String(r.department_id),
        responsibility: String(r.responsibility),
        kind: String(r.status),
        status: String(r.status),
        lastErrorCode: r.last_error_code ? String(r.last_error_code) : null,
        lastError: r.last_error ? String(r.last_error) : null,
        desiredUserId: r.desired_user_id ? String(r.desired_user_id) : null,
        desiredClickupUserId: r.desired_clickup_user_id
          ? String(r.desired_clickup_user_id)
          : null,
        observedClickupUserIds: r.observed_clickup_user_ids ?? null,
        attemptCount: Number(r.attempt_count ?? 0),
        mutationAttempts: Number(r.mutation_attempts ?? 0),
        maxAttempts: Number(r.max_attempts ?? 5),
        resyncEligible: r.resync_eligible === true,
        nextAttemptAt: r.next_attempt_at ? new Date(String(r.next_attempt_at)) : null,
        updatedAt: r.updated_at ? new Date(String(r.updated_at)) : null,
      }),
    );

    return {
      statuses: statuses.filter(
        (status) =>
          isProjectableResponsibility(status.responsibility, status.departmentId),
      ),
      environment: env,
    };
  });
}

/**
 * Manual resync for terminal, unleased commands matching a role.
 *
 * Pending/drift commands already have durable continuation wakes. Ambiguous
 * commands must retain their status so the worker reads back before any repeat
 * mutation. A command with any lease fields present may still be in flight.
 * This route performs no vendor egress.
 */
export async function manualResyncProjectionByRole(args: {
  clientId?: string;
  departmentId: string;
  responsibility: string;
}): Promise<{ ok: boolean; count: number; queued: number; message: string }> {
  if (
    args.responsibility !== "doer" &&
    args.responsibility !== "checker"
  ) {
    return {
      ok: false,
      count: 0,
      queued: 0,
      message: "responsibility must be one of: doer, checker",
    };
  }
  const env = resolveProjectionEnvironment();
  if (env === "unconfigured") {
    return { ok: false, count: 0, queued: 0, message: "Projection environment not configured" };
  }

  return withDbAttribution("cuRoleProjection:manualResyncByRole", async () => {
    const db = getDb();

    // Find the destination for this department+responsibility+env.
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
        ok: false,
        count: 0,
        queued: 0,
        message: `No destination configured for department=${args.departmentId} responsibility=${args.responsibility} env=${env}`,
      };
    }
    if (!isProjectableResponsibility(args.responsibility, args.departmentId)) {
      return {
        ok: false,
        count: 0,
        queued: 0,
        message: `Department ${args.departmentId} does not support the requested responsibility`,
      };
    }

    const count = await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE cu_role_projection_commands
        SET status = 'pending',
            next_attempt_at = NULL,
            last_error = NULL,
            last_error_code = NULL,
            terminal_at = NULL,
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            attempt_count = 0,
            mutation_attempts = 0,
            updated_at = now()
        WHERE destination_id = ${dest.id}
          ${args.clientId ? sql`AND client_id = ${args.clientId}` : sql``}
          AND (
            (status = 'failed' AND terminal_at IS NOT NULL)
            OR status = 'blocked'
          )
          AND lease_owner IS NULL
          AND lease_token IS NULL
          AND lease_expires_at IS NULL
        RETURNING id, revision, attempt_count
      `);
      const rows = result.rows as Array<{
        id: string;
        revision: string;
        attempt_count: number;
      }>;
      await enqueueProjectionWakesInTx(
        tx,
        new Date(),
        rows.map((row) => ({
          commandId: row.id,
          revision: row.revision,
          attemptCount: Number(row.attempt_count),
        })),
      );
      return rows.length;
    });
    if (count > 0) {
      await enqueueClickUpRoleProjectionJob().catch((e) =>
        console.warn("[ClickUpRoleProjection] Resync accelerator kick failed:", e),
      );
      return {
        ok: true,
        count,
        queued: count,
        message: `Reset ${count} failed or blocked command(s) to pending`,
      };
    }

    return {
      ok: false,
      count: 0,
      queued: 0,
      message:
        "No eligible commands. Re-sync is limited to failed or blocked commands with no lease; pending, drift, and ambiguous commands continue through the projection worker.",
    };
  });
}
