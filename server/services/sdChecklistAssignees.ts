// @db-pool-intent: ambient
//
// Task #3656 — resolve template checklist step assignees at apply time.
//
// Each sd_request_type_checklist_steps row may carry either a fixed NoBull
// user (assignee_user_id) or a dynamic role token (assignee_role =
// 'doer' | 'checker'). Dynamic roles resolve via the shared
// sdRoleResolution rules (Task #4171): company-scope departments use the
// department-level holders regardless of client; per-client departments use
// the client's sd_client_dept_assignments row (doer = primary_user_id,
// checker = checker_user_id) with per-role
// fallback to the department defaults. The universal boundary then maps the
// NoBull user to a numeric ClickUp identity while keeping that projection
// identity separate from the user's personal OAuth credential state.
//
// This module is intent-ambient: it is called from BOTH the native
// submission route (API pool) and the background ClickUp worker; every DB
// read goes through the caller-pinned getDb().
//
// Resolution NEVER throws for missing data — an unresolvable assignee yields
// null (item created unassigned) plus a human-readable warning the caller
// logs. Callers must also try/catch the whole resolution so a hard failure
// (e.g. DB blip) degrades to an all-unassigned checklist, never a failed apply.

import {
  resolveClickUpIdentities,
  resolveUniversalAssignmentsForDepartments,
  type ResolvedClickUpIdentity,
} from "./sdRoleResolution";

export const SD_CHECKLIST_ASSIGNEE_ROLES = ["doer", "checker"] as const;
export type SdChecklistAssigneeRole = (typeof SD_CHECKLIST_ASSIGNEE_ROLES)[number];

export function isSdChecklistAssigneeRole(v: unknown): v is SdChecklistAssigneeRole {
  return typeof v === "string" && (SD_CHECKLIST_ASSIGNEE_ROLES as readonly string[]).includes(v);
}

export interface ChecklistStepAssigneeSource {
  name?: string | null;
  assigneeUserId?: string | null;
  assigneeRole?: string | null;
  /**
   * Optional department override for the dynamic role: resolve the role for
   * the ticket's client × THIS department instead of the ticket's own
   * department. Null/undefined = ticket's department.
   */
  assigneeDepartmentId?: string | null;
}

export interface ResolvedChecklistAssignees {
  /** Per-step numeric ClickUp user id, aligned to the input array; null = leave unassigned. */
  assignees: Array<number | null>;
  /** Human-readable log-and-skip reasons for every step left unassigned unexpectedly. */
  warnings: string[];
}

export async function resolveChecklistStepAssignees(
  steps: ChecklistStepAssigneeSource[],
  ctx: { clientId: string | null; departmentId: string | null; workspaceId?: string | null },
): Promise<ResolvedChecklistAssignees> {
  const warnings: string[] = [];
  const noAssignees = steps.map(() => null as number | null);
  if (!steps.some((s) => s.assigneeUserId || s.assigneeRole)) {
    return { assignees: noAssignees, warnings };
  }

  // 1. Dynamic role → neutral assignment snapshot. Each step may target its
  // own department; company/client/default precedence, active membership, and
  // ClickUp projection identity all come from the universal boundary.
  const roleSteps = steps.filter((s) => isSdChecklistAssigneeRole(s.assigneeRole));
  const deptIds = [
    ...new Set(
      roleSteps
        .map((s) => s.assigneeDepartmentId || ctx.departmentId)
        .filter((d): d is string => !!d),
    ),
  ];
  const snapshots = await resolveUniversalAssignmentsForDepartments({
    departmentIds: deptIds,
    clientId: ctx.clientId,
    workspaceId: ctx.workspaceId,
    activeOnly: false,
  });
  if (roleSteps.length > 0) {
    for (const departmentId of deptIds) {
      if (!snapshots.has(departmentId)) {
        warnings.push(
          `unknown department ${departmentId} — dynamic-role steps targeting it left unassigned`,
        );
      }
    }
    if (
      !ctx.clientId &&
      [...snapshots.values()].some((snapshot) => snapshot.scope === "per_client")
    ) {
      warnings.push(
        "ticket client is unresolved — per-client dynamic roles resolve from department defaults only",
      );
    }
  }

  // 2. Resolve each step to a NoBull user plus projection state. Fixed users
  // are intentionally not constrained to the ticket department; dynamic role
  // users must be active members there.
  const fixedUserIds = [
    ...new Set(
      steps
        .filter((step) => !step.assigneeRole)
        .map((step) => step.assigneeUserId)
        .filter((userId): userId is string => !!userId),
    ),
  ];
  const fixedIdentities = await resolveClickUpIdentities(
    fixedUserIds.map((userId) => ({ userId })),
    ctx.workspaceId ?? null,
  );
  const stepValues: Array<{
    userId: string | null;
    identity: ResolvedClickUpIdentity | null;
  }> = steps.map((s) => {
    if (s.assigneeRole) {
      if (!isSdChecklistAssigneeRole(s.assigneeRole)) {
        warnings.push(`step "${s.name ?? "?"}" has unknown assignee role "${s.assigneeRole}" — left unassigned`);
        return { userId: null, identity: null };
      }
      const deptId = s.assigneeDepartmentId || ctx.departmentId;
      if (!deptId) {
        warnings.push(
          `step "${s.name ?? "?"}" has a dynamic role but no department is resolvable — left unassigned`,
        );
        return { userId: null, identity: null };
      }
      const snapshot = snapshots.get(deptId);
      if (!snapshot) return { userId: null, identity: null };
      const role = snapshot.roles[s.assigneeRole];
      if (!role) {
        warnings.push(
          `role "${s.assigneeRole}" is not supported for this department (dept=${deptId}) — step "${s.name ?? "?"}" left unassigned`,
        );
        return { userId: null, identity: null };
      }
      if (!role.userId) {
        warnings.push(
          `role "${s.assigneeRole}" has no configured person for this department (dept=${deptId}) — step "${s.name ?? "?"}" left unassigned`,
        );
        return { userId: null, identity: null };
      }
      if (role.eligibility !== "eligible") {
        warnings.push(
          `user ${role.userId} is not an active member of department ${deptId} — step "${s.name ?? "?"}" left unassigned`,
        );
      }
      const identity: ResolvedClickUpIdentity = {
        ...role.projection,
        userId: role.userId,
        departmentId: deptId,
        activeDepartmentMember: role.eligibility === "eligible",
      };
      return { userId: role.userId, identity };
    }
    const userId = s.assigneeUserId ?? null;
    return {
      userId,
      identity: userId ? fixedIdentities.get(`${userId}|`) ?? null : null,
    };
  });

  // 3. Projection-ready ClickUp identity → numeric checklist assignee id.
  const assignees = stepValues.map(({ userId, identity }, i) => {
    if (!userId) return null;
    const clickupUserId = identity?.ready ? identity.externalUserId : null;
    if (!clickupUserId) {
      warnings.push(`user ${userId} has no ClickUp identity — step "${steps[i].name ?? "?"}" left unassigned`);
      return null;
    }
    const n = Number(clickupUserId);
    if (!Number.isFinite(n)) {
      warnings.push(`user ${userId} has non-numeric ClickUp id "${clickupUserId}" — step "${steps[i].name ?? "?"}" left unassigned`);
      return null;
    }
    return n;
  });

  return { assignees, warnings };
}
