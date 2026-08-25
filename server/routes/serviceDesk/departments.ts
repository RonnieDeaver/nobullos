// @db-pool-intent: api
/**
 * Service Desk routes — departments, members & role assignments.
 * Extracted verbatim from server/routes/serviceDesk.ts (Task #3787 split);
 * sections: Client options, Departments, Department members, Client × department assignments, Bulk role assignment.
 * Mounted by registerServiceDeskRoutes in ../serviceDesk.ts — route order
 * is preserved by the aggregator's call sequence.
 */

import type { Express } from "express";
import type { UniversalAssignmentProjectionIdentity } from "@shared/schema";
import { z } from "zod";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireCeo, requireTeamLead } from "../middleware";
import { getDb, withDbAttribution } from "../../db";
import {
  SD_ASSIGNMENT_SCOPES,
  cuRoleProjectionClientTargets,
  cuRoleProjectionCommands,
  cuRoleProjectionDestinations,
  sdDepartments,
  sdDepartmentMembers,
  sdClientDeptAssignments,
  sdRequestTypes,
  sdRequestTypeQuestions,
  sdRequestTypeChecklistSteps,
  sdTicketMapping,
} from "@shared/schema";
import { clients } from "@shared/models/clients";
import { users } from "@shared/models/auth";
import { getDepartmentRoleCapabilities, departmentSupportsChecker } from "@shared/departmentRoleCapabilities";
import { eq, and, asc, inArray, notInArray, sql } from "drizzle-orm";
import { recordAdminSettingChange } from "../../storage/settingsStorage";
import {
  computeEffectiveRoles,
  isCompanyScoped,
  resolveClickUpIdentities,
  resolveClickUpIdentity,
  resolveUniversalAssignmentsForDepartments,
  setBulkClientAssignments,
  setClientDepartmentAssignment,
  setDepartmentRoleAssignments,
  updateDepartmentConfiguration,
  upsertDepartmentMember,
  updateDepartmentMember,
  deleteDepartmentMember,
} from "../../services/sdRoleResolution";
import { getListMappingConfig } from "./helpers";
import { getAccessToken } from "../../services/clickUpIntegration";
import * as cu from "../../services/clickUpClient";
// ClickUp role projection admin surface (Task #5156). Static, typed imports —
// a module-load failure must fail startup rather than silently degrading the
// projection endpoints to 200-empty. Runtime errors are still caught per-route.
import {
  listRoleProjectionConfiguration,
  upsertRoleProjectionDestination,
  upsertRoleProjectionClientTarget,
  listRoleProjectionStatuses,
  manualResyncProjectionByRole,
} from "../../services/clickUpRoleProjection";

const ASSIGNMENT_USER_ID_SCHEMA = z.string().trim().min(1).max(255).nullable();

const DEPARTMENT_CREATION_BODY_SCHEMA = z
  .object({
    name: z.string().optional(),
    sortOrder: z.number().optional(),
    assignmentScope: z.string().optional(),
  })
  .strict();

const CLIENT_ASSIGNMENT_BODY_SCHEMA = z
  .object({
    primaryUserId: ASSIGNMENT_USER_ID_SCHEMA.optional(),
    checkerUserId: ASSIGNMENT_USER_ID_SCHEMA.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.primaryUserId !== undefined ||
      body.checkerUserId !== undefined,
    { message: "Provide at least one role assignment" },
  );

const DEPARTMENT_ROLE_ASSIGNMENT_BODY_SCHEMA = z
  .object({
    defaultPrimaryUserId: ASSIGNMENT_USER_ID_SCHEMA.optional(),
    defaultCheckerUserId: ASSIGNMENT_USER_ID_SCHEMA.optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.defaultPrimaryUserId !== undefined ||
      body.defaultCheckerUserId !== undefined,
    { message: "Provide at least one role assignment" },
  );

const DEPARTMENT_CONFIGURATION_BODY_SCHEMA = z
  .object({
    name: z.string().optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().optional(),
    assignmentScope: z.enum(SD_ASSIGNMENT_SCOPES).optional(),
    defaultPrimaryUserId: ASSIGNMENT_USER_ID_SCHEMA.optional(),
    defaultCheckerUserId: ASSIGNMENT_USER_ID_SCHEMA.optional(),
  })
  .strict();

const SERVICE_DESK_BULK_ASSIGNMENT_BODY_SCHEMA = z
  .object({
    departmentId: z.string().trim().min(1).max(255),
    role: z.enum(["primary", "checker"]),
    userId: z
      .union([z.string().trim().max(255), z.null()])
      .optional()
      .transform((value) => value || null),
    clientIds: z.array(z.string().trim().min(1).max(255)).min(1),
  })
  .strict();

const BULK_ROLE_ASSIGNMENT_BODY_SCHEMA = z
  .object({
    departmentId: z.string().trim().min(1).max(255),
    responsibility: z.enum(["doer", "checker"]),
    userId: z
      .union([z.string().trim().max(255), z.null()])
      .optional()
      .transform((value) => value || null),
    clientIds: z.array(z.string().trim().min(1).max(255)).min(1),
  })
  .strict();

const UNSUPPORTED_CHECKER_ERROR =
  "This department does not support the Checker role; only approved Checker-capable departments may assign one";

function departmentReadPayload<T extends { id: string; defaultCheckerUserId?: string | null }>(
  department: T,
) {
  const roleCapabilities = getDepartmentRoleCapabilities(department.id);
  if (roleCapabilities.checker) return { ...department, roleCapabilities };
  const { defaultCheckerUserId: _unsupportedChecker, ...supportedDepartment } = department;
  return { ...supportedDepartment, roleCapabilities };
}

function assignmentReadPayload<T extends { departmentId: string; checkerUserId?: string | null }>(
  assignment: T,
) {
  if (departmentSupportsChecker(assignment.departmentId)) return assignment;
  const { checkerUserId: _unsupportedChecker, ...supportedAssignment } = assignment;
  return supportedAssignment;
}

async function verifyManualClickUpWorkspaceIdentity(
  req: any,
  clickupUserId: string,
): Promise<
  | { ok: true; workspaceId: string }
  | { ok: false; status: number; error: string }
> {
  const config = await getListMappingConfig();
  const workspaceId = config?.clickupWorkspaceId?.trim() || null;
  if (!workspaceId) {
    return {
      ok: false,
      status: 422,
      error: "Configure the Service Desk ClickUp workspace before adding a manual ClickUp member ID",
    };
  }
  const actorId: string | null = req.dbUser?.id ?? req.user?.claims?.sub ?? req.user?.id ?? null;
  const actorToken = actorId ? await getAccessToken(actorId) : null;
  if (!actorToken) {
    return {
      ok: false,
      status: 422,
      error: "A connected ClickUp account is required to verify a manual ClickUp member ID",
    };
  }
  try {
    const workspaceMembers = await cu.getWorkspaceMembers(actorToken, workspaceId);
    const verified = workspaceMembers.some(
      (member: any) =>
        String(member.user?.id ?? member.id ?? member.userId ?? "") === clickupUserId,
    );
    if (!verified) {
      return {
        ok: false,
        status: 422,
        error: "The manual ClickUp member ID is not in the configured Service Desk workspace",
      };
    }
    return { ok: true, workspaceId };
  } catch {
    return {
      ok: false,
      status: 503,
      error: "ClickUp workspace membership could not be verified",
    };
  }
}

export function registerServiceDeskDepartmentRoutes(app: Express): void {
  // ── Departments ────────────────────────────────────────────────────────────

  // ─── Client options for the submission form ─────────────────────────────────
  // Returns the Client dropdown option list sourced from sd_list_mapping so the
  // form can render a searchable combobox instead of a free-text input.
  // Requires only isAuthenticated (any staff member can submit a request).
  // Returns { options: null, configured: false } when the option map has not
  // been populated yet so the form can degrade loudly to the free-text fallback.
  app.get("/api/service-desk/client-options", isAuthenticated, async (_req, res) => {
    try {
      const config = await getListMappingConfig();
      if (!config?.clickupListId || !config.fieldClientId) {
        return res.json({ options: null, configured: false });
      }

      const clientOptMap = (config.clientOptionIds ?? {}) as Record<string, string>;
      const clientOptNames = (config.clientOptionNames ?? {}) as Record<string, string>;
      const hasOptions = Object.keys(clientOptNames).length > 0;

      if (!hasOptions) {
        return res.json({ options: null, configured: false });
      }

      // Load NoBull firm names for all mapped clients so the label prefers the
      // canonical firm name (kept in sync with NoBull) over the ClickUp label.
      const mappedClientIds = [...new Set(Object.values(clientOptMap))];
      const allMappedClients = mappedClientIds.length > 0
        ? await withDbAttribution("serviceDesk:clientOptions:loadMapped", async () => {
          const db = getDb();
          return db
            .select({ id: clients.id, firmName: clients.firmName })
            .from(clients)
            .where(inArray(clients.id, mappedClientIds));
        })
        : [];
      const firmNameById = new Map(allMappedClients.map((c) => [c.id, c.firmName]));

      // Build the option list in the order ClickUp defines them (preserve key insertion order).
      const options = Object.entries(clientOptNames).map(([optionId, optionLabel]) => {
        const clientId = clientOptMap[optionId] ?? null;
        const label = clientId ? (firmNameById.get(clientId) ?? optionLabel) : optionLabel;
        return { optionId, label, clientId };
      });

      // Sort: mapped options (with clientId) first, alphabetically; then unmapped, alphabetically.
      options.sort((a, b) => {
        if (a.clientId && !b.clientId) return -1;
        if (!a.clientId && b.clientId) return 1;
        return a.label.localeCompare(b.label);
      });

      res.json({ options, configured: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Team options for the Add Client form (Task #4171) ─────────────────────
  // Every ACTIVE client-facing (per_client) department with its default
  // Doer/Checker plus the active-member option list, so the form
  // can pre-fill each role with the default person's name and let the creator
  // change it. Defaults whose holder is no longer an active member are nulled
  // here (they would be skipped at seed time anyway — never pre-select a
  // stale person). Requires only isAuthenticated: the same bar as POST
  // /api/clients, which is what this feeds.
  app.get("/api/service-desk/client-team-options", isAuthenticated, async (_req, res) => {
    try {
      const { depts, members } = await withDbAttribution("serviceDesk:clientTeamOptions", async () => {
        const db = getDb();
        const depts = await db
          .select()
          .from(sdDepartments)
          .where(eq(sdDepartments.active, true))
          .orderBy(asc(sdDepartments.sortOrder), asc(sdDepartments.name));
        const members = await db
          .select({
            departmentId: sdDepartmentMembers.departmentId,
            userId: sdDepartmentMembers.userId,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(sdDepartmentMembers)
          .innerJoin(users, eq(sdDepartmentMembers.userId, users.id))
          .where(eq(sdDepartmentMembers.active, true));
        return { depts, members };
      });

      const activeByDept = new Map<string, Set<string>>();
      const membersByDept: Record<string, { id: string; name: string }[]> = {};
      for (const m of members) {
        (activeByDept.get(m.departmentId) ?? activeByDept.set(m.departmentId, new Set()).get(m.departmentId)!).add(m.userId);
        (membersByDept[m.departmentId] ??= []).push({
          id: m.userId,
          name: [m.firstName, m.lastName].filter(Boolean).join(" ").trim() || m.email || m.userId,
        });
      }
      for (const list of Object.values(membersByDept)) {
        list.sort((a, b) => a.name.localeCompare(b.name));
      }

      const departments = depts
        .filter((d) => !isCompanyScoped(d))
        .map((d) => {
          const active = activeByDept.get(d.id) ?? new Set<string>();
          const liveDefault = (userId: string | null) => (userId && active.has(userId) ? userId : null);
          return {
            id: d.id,
            name: d.name,
            sortOrder: d.sortOrder,
            defaultPrimaryUserId: liveDefault(d.defaultPrimaryUserId ?? null),
            ...(departmentSupportsChecker(d.id)
              ? { defaultCheckerUserId: liveDefault(d.defaultCheckerUserId ?? null) }
              : {}),
            roleCapabilities: getDepartmentRoleCapabilities(d.id),
          };
        });

      res.json({ departments, membersByDept });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/service-desk/departments", isAuthenticated, async (_req, res) => {
    try {
      const { rows, counts, assignStats } = await withDbAttribution("serviceDesk:listDepts", async () => {
        const db = getDb();
        const rows = await db.select().from(sdDepartments).orderBy(asc(sdDepartments.sortOrder), asc(sdDepartments.name));
        // Active-member count per department (Task #4002) so listings can show
        // membership at a glance (and flag empty departments) without a
        // per-department members fetch.
        const counts = await db
          .select({
            departmentId: sdDepartmentMembers.departmentId,
            memberCount: sql<number>`count(*)::int`,
          })
          .from(sdDepartmentMembers)
          .where(eq(sdDepartmentMembers.active, true))
          .groupBy(sdDepartmentMembers.departmentId);
        // Per-client assignment footprint (Task #4173) so the Scope toggle can
        // warn how many client rows go dormant on per_client → company (and
        // come back into effect on the way back). Only rows with at least one
        // role holder count — an all-null row affects nothing either way.
        const assignStats = await db
          .select({
            departmentId: sdClientDeptAssignments.departmentId,
            assignmentCount: sql<number>`count(*)::int`,
            lastAssignmentUpdatedAt: sql<string | null>`max(${sdClientDeptAssignments.updatedAt})`,
          })
          .from(sdClientDeptAssignments)
          .where(sql`(
            ${sdClientDeptAssignments.primaryUserId} IS NOT NULL
            OR ${sdClientDeptAssignments.checkerUserId} IS NOT NULL
          )`)
          .groupBy(sdClientDeptAssignments.departmentId);
        return { rows, counts, assignStats };
      });
      const countByDept = new Map(counts.map((c) => [c.departmentId, c.memberCount]));
      const assignByDept = new Map(assignStats.map((a) => [a.departmentId, a]));
      res.json({
        departments: rows.map((d) => ({
          ...departmentReadPayload(d),
          memberCount: countByDept.get(d.id) ?? 0,
          assignmentCount: assignByDept.get(d.id)?.assignmentCount ?? 0,
          lastAssignmentUpdatedAt: assignByDept.get(d.id)?.lastAssignmentUpdatedAt ?? null,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/service-desk/departments", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const parsed = DEPARTMENT_CREATION_BODY_SCHEMA.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      }
      const { name, sortOrder, assignmentScope } = parsed.data;
      if (!name?.trim()) return res.status(400).json({ error: "name is required" });

      // Task #4893 — creation-time scope, so a company-wide department can be
      // born company-wide instead of polluting per-client surfaces (and
      // client-creation seeding) until someone remembers the scope toggle.
      // Same validation as the update route below; omitted → 'per_client'.
      if (assignmentScope !== undefined && !(SD_ASSIGNMENT_SCOPES as readonly string[]).includes(assignmentScope)) {
        return res.status(400).json({
          error: `assignmentScope must be one of: ${SD_ASSIGNMENT_SCOPES.join(", ")}`,
        });
      }

      const [row] = await withDbAttribution("serviceDesk:createDept", async () => {
        const db = getDb();
        return db
          .insert(sdDepartments)
          .values({
            name: name.trim(),
            sortOrder: sortOrder ?? 0,
            assignmentScope: assignmentScope ?? "per_client",
          })
          .returning();
      });
      res.json({ department: departmentReadPayload(row) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/service-desk/departments/:id", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const parsed = DEPARTMENT_CONFIGURATION_BODY_SCHEMA.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      }
      const { id } = req.params;
      const { name, active, sortOrder, assignmentScope, defaultPrimaryUserId, defaultCheckerUserId } = parsed.data;

      const mutation = await updateDepartmentConfiguration({
        departmentId: id,
        patch: {
          ...(name != null ? { name } : {}),
          ...(active != null ? { active } : {}),
          ...(sortOrder != null ? { sortOrder } : {}),
          ...(assignmentScope !== undefined
            ? { assignmentScope: assignmentScope as "per_client" | "company" }
            : {}),
          ...(defaultPrimaryUserId !== undefined ? { defaultPrimaryUserId } : {}),
          ...(defaultCheckerUserId !== undefined ? { defaultCheckerUserId } : {}),
        },
      });
      if (!mutation.ok && mutation.kind === "department_not_found") {
        return res.status(404).json({ error: "Department not found" });
      }
      if (!mutation.ok && mutation.kind === "unsupported_role") {
        return res.status(422).json({ error: UNSUPPORTED_CHECKER_ERROR });
      }
      if (!mutation.ok) {
        const label =
          mutation.field === "checkerUserId" ? "Default checker" : "Default primary";
        return res.status(422).json({
          error: `${label} user must be an active member of this department`,
        });
      }
      res.json({ department: departmentReadPayload(mutation.department) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Department role defaults / company role holders (Task #4171) ──────────
  // Moves people between the department-level Doer/Checker slots:
  // per-client departments treat them as per-role defaults (fallback when a
  // client has no explicit person); company departments treat them as THE
  // company-wide role holders. Team-lead-gated — the same bar as every other
  // role-holder edit on the Role Assignments console — while department
  // STRUCTURE changes (name/active/sortOrder/scope) stay CEO-only above.
  // Fields left undefined are untouched; explicit null/"" clears the slot.
  app.put(
    "/api/service-desk/departments/:id/role-defaults",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const parsed = DEPARTMENT_ROLE_ASSIGNMENT_BODY_SCHEMA.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        }
        const { id } = req.params;
        const { defaultPrimaryUserId, defaultCheckerUserId } = parsed.data;
        const result = await setDepartmentRoleAssignments({
          departmentId: id,
          patch: {
            ...(defaultPrimaryUserId !== undefined ? { primaryUserId: defaultPrimaryUserId } : {}),
            ...(defaultCheckerUserId !== undefined ? { checkerUserId: defaultCheckerUserId } : {}),
          },
        });
        if (!result.ok && result.kind === "department_not_found") {
          return res.status(404).json({ error: "Department not found" });
        }
        if (!result.ok && result.kind === "unsupported_role") {
          return res.status(422).json({ error: UNSUPPORTED_CHECKER_ERROR });
        }
        if (!result.ok) {
          const label =
            result.field === "checkerUserId" ? "Default checker" : "Default primary";
          return res.status(422).json({
            error: `${label} user must be an active member of this department`,
          });
        }
        const { previous: dept, department: row } = result;

        // Audit who moved which role holders (same mechanism as bulk assign).
        const actorId: string | null = req.dbUser?.id ?? req.user?.claims?.sub ?? null;
        await recordAdminSettingChange({
          settingKey: "sd_department_role_defaults",
          scope: id,
          changedBy: actorId,
          oldValues: {
            defaultPrimaryUserId: dept.defaultPrimaryUserId ?? null,
            defaultCheckerUserId: dept.defaultCheckerUserId ?? null,
          },
          newValues: {
            defaultPrimaryUserId: row.defaultPrimaryUserId ?? null,
            defaultCheckerUserId: row.defaultCheckerUserId ?? null,
          },
        });

        res.json({
          department: departmentReadPayload(row),
          projection: result.projection ?? null,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── Permanent delete (Task #4892) ───────────────────────────────────────────
  // Two removal levels: PUT { active: false } hides a department (soft, above);
  // DELETE permanently removes it. Guarded: the department must already be
  // inactive (deactivate-then-delete is the two-step safety). One transaction
  // deletes the department, its member rows, its per-client assignment rows,
  // and its department-scoped request types with their questions and checklist
  // steps; NULLs sd_ticket_mapping.department_id (historical tickets stay,
  // untagged) and surviving checklist-step assignee_department_id overrides
  // (they fall back to the ticket's department — documented legacy behavior);
  // removes ClickUp projection commands/targets/destinations and
  // sd_list_mapping.department_option_ids entries whose VALUE is the deleted
  // id. The ClickUp dropdown option itself cannot be deleted via API (read-only
  // for options). Import is reconciliation-only, so a leftover remote option is
  // reported for operator cleanup instead of creating a replacement department.

  // Read-only impact preview so the confirmation dialog can show exactly what
  // a permanent delete will cascade to before the destructive call.
  app.get(
    "/api/service-desk/departments/:id/delete-impact",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const { id } = req.params;
        const [dept] = await withDbAttribution("serviceDesk:deptDeleteImpact:getDept", async () => {
          const db = getDb();
          return db.select().from(sdDepartments).where(eq(sdDepartments.id, id)).limit(1);
        });
        if (!dept) return res.status(404).json({ error: "Department not found" });

        const impact = await computeDeptDeleteImpact(id);
        res.json({
          department: { id: dept.id, name: dept.name, active: dept.active },
          // Active departments cannot be deleted — the dialog disables the
          // destructive button and explains the deactivate-first step.
          deletable: !dept.active,
          impact,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.delete("/api/service-desk/departments/:id", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const { id } = req.params;

      const result = await withDbAttribution("serviceDesk:hardDeleteDept", async () => {
        const db = getDb();
        return db.transaction(async (tx) => {
          // Lock the row so a concurrent second press waits, then sees the
          // deleted state (404) instead of half-running the cascade.
          const [dept] = await tx
            .select()
            .from(sdDepartments)
            .where(eq(sdDepartments.id, id))
            .limit(1)
            .for("update");
          if (!dept) return { kind: "not_found" as const };
          if (dept.active) return { kind: "still_active" as const, name: dept.name };

          const deptRts = await tx
            .select({ id: sdRequestTypes.id })
            .from(sdRequestTypes)
            .where(eq(sdRequestTypes.departmentId, id));
          const deptRtIds = deptRts.map((r) => r.id);

          // Department-scoped request types go away with their questions and
          // checklist steps (delete children first — no FKs, but keep the
          // order meaningful for anyone reading the audit trail).
          const deletedQuestions = deptRtIds.length > 0
            ? await tx
                .delete(sdRequestTypeQuestions)
                .where(inArray(sdRequestTypeQuestions.requestTypeId, deptRtIds))
                .returning({ id: sdRequestTypeQuestions.id })
            : [];
          const deletedSteps = deptRtIds.length > 0
            ? await tx
                .delete(sdRequestTypeChecklistSteps)
                .where(inArray(sdRequestTypeChecklistSteps.requestTypeId, deptRtIds))
                .returning({ id: sdRequestTypeChecklistSteps.id })
            : [];

          // Steps on SURVIVING request types that route work to this
          // department via the assignee_department_id override: NULL the
          // override so the step falls back to the ticket's department
          // (the documented pre-override behavior).
          const clearedOverrides = await tx
            .update(sdRequestTypeChecklistSteps)
            .set({ assigneeDepartmentId: null, updatedAt: new Date() })
            .where(eq(sdRequestTypeChecklistSteps.assigneeDepartmentId, id))
            .returning({ id: sdRequestTypeChecklistSteps.id });

          const deletedRts = deptRtIds.length > 0
            ? await tx
                .delete(sdRequestTypes)
                .where(eq(sdRequestTypes.departmentId, id))
                .returning({ id: sdRequestTypes.id })
            : [];
          const deletedMembers = await tx
            .delete(sdDepartmentMembers)
            .where(eq(sdDepartmentMembers.departmentId, id))
            .returning({ id: sdDepartmentMembers.id });
          const deletedAssignments = await tx
            .delete(sdClientDeptAssignments)
            .where(eq(sdClientDeptAssignments.departmentId, id))
            .returning({ id: sdClientDeptAssignments.id });

          // Projection artifacts are live NoBull configuration, not history.
          // Lock destination rows before enumerating dependencies so target and
          // command writers either finish before this cascade (then are removed)
          // or observe the deleted destination after it commits. No vendor work
          // occurs in this transaction.
          const projectionDestinations = await tx
            .select({ id: cuRoleProjectionDestinations.id })
            .from(cuRoleProjectionDestinations)
            .where(eq(cuRoleProjectionDestinations.departmentId, id))
            .for("update");
          const projectionDestinationIds = projectionDestinations.map((destination) => destination.id);
          const deletedProjectionCommands = projectionDestinationIds.length > 0
            ? await tx
                .delete(cuRoleProjectionCommands)
                .where(inArray(cuRoleProjectionCommands.destinationId, projectionDestinationIds))
                .returning({ id: cuRoleProjectionCommands.id })
            : [];
          const deletedProjectionTargets = projectionDestinationIds.length > 0
            ? await tx
                .delete(cuRoleProjectionClientTargets)
                .where(inArray(cuRoleProjectionClientTargets.destinationId, projectionDestinationIds))
                .returning({ id: cuRoleProjectionClientTargets.id })
            : [];
          const deletedProjectionDestinations = projectionDestinationIds.length > 0
            ? await tx
                .delete(cuRoleProjectionDestinations)
                .where(inArray(cuRoleProjectionDestinations.id, projectionDestinationIds))
                .returning({ id: cuRoleProjectionDestinations.id })
            : [];

          // Historical tickets keep every row and event — only the department
          // tag is cleared.
          const clearedTickets = await tx
            .update(sdTicketMapping)
            .set({ departmentId: null, updatedAt: new Date() })
            .where(eq(sdTicketMapping.departmentId, id))
            .returning({ id: sdTicketMapping.id });

          // Option-map surgery: drop entries whose VALUE is the deleted id.
          // Atomic jsonb rebuild in SQL (not read-modify-write in JS) so a
          // concurrent writer to another sd_list_mapping column can't be
          // clobbered. NOTE: jsonb_each columns are aliased opt_key/opt_val —
          // never reuse a column alias inside the aggregate subquery.
          const optCountRes = await tx.execute(sql`
            SELECT count(*)::int AS n
              FROM sd_list_mapping,
                   jsonb_each(COALESCE(department_option_ids, '{}'::jsonb)) AS opt(opt_key, opt_val)
             WHERE opt.opt_val = to_jsonb(${id}::text)
          `);
          const optionMapEntriesRemoved = Number((optCountRes.rows[0] as any)?.n ?? 0);
          if (optionMapEntriesRemoved > 0) {
            await tx.execute(sql`
              UPDATE sd_list_mapping
                 SET department_option_ids = COALESCE(
                       (SELECT jsonb_object_agg(opt.opt_key, opt.opt_val)
                          FROM jsonb_each(department_option_ids) AS opt(opt_key, opt_val)
                         WHERE opt.opt_val <> to_jsonb(${id}::text)),
                       '{}'::jsonb
                     ),
                     updated_at = NOW()
               WHERE EXISTS (
                       SELECT 1
                         FROM jsonb_each(COALESCE(department_option_ids, '{}'::jsonb)) AS chk(chk_key, chk_val)
                        WHERE chk.chk_val = to_jsonb(${id}::text)
                     )
            `);
          }

          await tx.delete(sdDepartments).where(eq(sdDepartments.id, id));

          return {
            kind: "deleted" as const,
            dept,
            cascade: {
              memberRows: deletedMembers.length,
              clientAssignmentRows: deletedAssignments.length,
              requestTypes: deletedRts.length,
              requestTypeQuestions: deletedQuestions.length,
              requestTypeChecklistSteps: deletedSteps.length,
              checklistStepOverridesCleared: clearedOverrides.length,
              ticketMappingsUntagged: clearedTickets.length,
              optionMapEntriesRemoved,
              projectionCommands: deletedProjectionCommands.length,
              projectionClientTargets: deletedProjectionTargets.length,
              projectionDestinations: deletedProjectionDestinations.length,
            },
          };
        });
      });

      if (result.kind === "not_found") {
        return res.status(404).json({ error: "Department not found" });
      }
      if (result.kind === "still_active") {
        return res.status(409).json({
          error: `"${result.name}" is still active. Mark it inactive first — permanent delete is only allowed for inactive departments.`,
        });
      }

      // Audit who deleted what, with the cascade counts (same mechanism as
      // role defaults / bulk assign above).
      const actorId: string | null = req.dbUser?.id ?? req.user?.claims?.sub ?? null;
      const audit = await recordAdminSettingChange({
        settingKey: "sd_department_hard_delete",
        scope: id,
        changedBy: actorId,
        oldValues: {
          name: result.dept.name,
          active: result.dept.active,
          assignmentScope: result.dept.assignmentScope,
          sortOrder: result.dept.sortOrder,
          defaultPrimaryUserId: result.dept.defaultPrimaryUserId ?? null,
          defaultCheckerUserId: result.dept.defaultCheckerUserId ?? null,
          createdAt: result.dept.createdAt,
        },
        newValues: { deleted: true, cascade: result.cascade },
      });

      res.json({
        success: true,
        deleted: { id: result.dept.id, name: result.dept.name },
        cascade: result.cascade,
        auditId: audit.id,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Department members ─────────────────────────────────────────────────────
  // Membership WRITES are team-lead-gated (not CEO-only) as of Task #4002: the
  // Role Assignments console (team-lead+) manages membership too, and
  // membership is the prerequisite for the role assignments team leads already
  // control (a team lead who can assign roles but not fix an empty department
  // would dead-end on "no active members"). Department structure changes
  // (create/rename/deactivate/default-primary) remain CEO-only above.

  app.get(
    "/api/service-desk/departments/:id/members",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const { id } = req.params;
        const rows = await withDbAttribution("serviceDesk:listMembers", async () => {
          const db = getDb();
          return db
            .select()
            .from(sdDepartmentMembers)
            .where(eq(sdDepartmentMembers.departmentId, id))
            .orderBy(asc(sdDepartmentMembers.createdAt));
        });
        res.json({ members: rows });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/service-desk/departments/:id/members",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { id } = req.params;
        const { userId, clickupUserId } = req.body as {
          userId?: string;
          clickupUserId?: string | null;
        };
        if (!userId?.trim()) return res.status(400).json({ error: "userId is required" });
        const memberUserId = userId.trim();
        const manualClickupId =
          typeof clickupUserId === "string" && clickupUserId.trim() ? clickupUserId.trim() : null;
        const config = await getListMappingConfig();
        const workspaceId = config?.clickupWorkspaceId ?? null;
        let manualVerified = false;
        if (manualClickupId) {
          const verification = await verifyManualClickUpWorkspaceIdentity(req, manualClickupId);
          if (!verification.ok) {
            return res.status(verification.status).json({ error: verification.error });
          }
          manualVerified = true;
        }

        const identity = await resolveClickUpIdentity({
          userId: memberUserId,
          preferredClickUpUserId: manualClickupId,
          preferredClickUpUserIdVerified: manualVerified,
        }, workspaceId);
        const resolvedClickupId = identity.ready ? identity.externalUserId : null;
        const clickupResolution: "manual" | "connected" | "none" =
          identity.source === "provided"
            ? "manual"
            : identity.source === "personal_oauth"
              ? "connected"
              : "none";

        const row = await upsertDepartmentMember({
          departmentId: id,
          userId: memberUserId,
          clickupUserId: resolvedClickupId,
        });
        res.json({ member: row, clickupResolution });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.put(
    "/api/service-desk/departments/:id/members/:memberId",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { memberId } = req.params;
        const { active, clickupUserId } = req.body as {
          active?: boolean;
          clickupUserId?: string;
        };
        if (typeof clickupUserId === "string" && clickupUserId.trim()) {
          const verification = await verifyManualClickUpWorkspaceIdentity(
            req,
            clickupUserId.trim(),
          );
          if (!verification.ok) {
            return res.status(verification.status).json({ error: verification.error });
          }
        }
        const mutation = await updateDepartmentMember({
          memberId,
          ...(active != null ? { active } : {}),
          ...(clickupUserId !== undefined ? { clickupUserId } : {}),
        });
        if (!mutation) return res.status(404).json({ error: "Member not found" });
        // When a member is deactivated, clear any client×dept assignments that
        // still reference them (doer/checker) so tickets don't
        // silently degrade to no-owner later (Task #3586), plus the
        // department-level default/company role slots (Task #4171). Surface
        // affected clients.
        res.json({
          member: mutation.member,
          clearedAssignments: mutation.cleared.clientAssignments,
          clearedDepartmentSlots: mutation.cleared.departmentSlots,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.delete(
    "/api/service-desk/departments/:id/members/:memberId",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { memberId } = req.params;
        const mutation = await deleteDepartmentMember(memberId);
        // Hard-delete must also clear referencing assignments (Task #3586)
        // and the department-level default/company role slots (Task #4171).
        res.json({
          success: true,
          clearedAssignments: mutation?.cleared.clientAssignments ?? [],
          clearedDepartmentSlots:
            mutation?.cleared.departmentSlots ?? {
              clearedPrimary: false,
              clearedChecker: false,
            },
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ── Client × department assignments ────────────────────────────────────────
  // Endpoints to read/write per-client, per-department role assignments
  // (Primary Doer / Checker). Admin/CEO-gated for
  // writes; authenticated for reads.
  //
  // GET  /api/service-desk/clients/:clientId/assignments
  //      → { assignments: SdClientDeptAssignment[], departments: SdDepartment[] }
  // PUT  /api/service-desk/clients/:clientId/assignments/:departmentId
  //      body: { primaryUserId?: string|null; checkerUserId?: string|null }
  //      → { assignment }
  // GET  /api/service-desk/coverage
  //      → { rows: [{ clientId, firmName, departmentId, deptName, primaryUserId, checkerUserId, defaultPrimaryUserId, hasCoverage }] }

  app.get(
    "/api/service-desk/clients/:clientId/assignments",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { clientId } = req.params;
        const [assignments, departments, allMembers, config] = await Promise.all([
          withDbAttribution("serviceDesk:getClientAssignments", async () => {
            const db = getDb();
            return db
              .select()
              .from(sdClientDeptAssignments)
              .where(eq(sdClientDeptAssignments.clientId, clientId));
          }),
          withDbAttribution("serviceDesk:getClientAssignments:depts", async () => {
            const db = getDb();
            return db
              .select()
              .from(sdDepartments)
              .where(eq(sdDepartments.active, true))
              .orderBy(asc(sdDepartments.sortOrder), asc(sdDepartments.name));
          }),
          withDbAttribution("serviceDesk:getClientAssignments:members", async () => {
            const db = getDb();
            return db
              .select({ departmentId: sdDepartmentMembers.departmentId, userId: sdDepartmentMembers.userId })
              .from(sdDepartmentMembers)
              .where(eq(sdDepartmentMembers.active, true));
          }),
          getListMappingConfig(),
        ]);
        const membersByDept: Record<string, string[]> = {};
        for (const m of allMembers) {
          (membersByDept[m.departmentId] ??= []).push(m.userId);
        }
        const resolvedAssignments = [
          ...(await resolveUniversalAssignmentsForDepartments({
            departmentIds: departments.map((department) => department.id),
            clientId,
            workspaceId: config?.clickupWorkspaceId ?? null,
          })).values(),
        ];
        res.json({
          assignments: assignments.map(assignmentReadPayload),
          departments: departments.map(departmentReadPayload),
          membersByDept,
          resolvedAssignments,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.put(
    "/api/service-desk/clients/:clientId/assignments/:departmentId",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { clientId, departmentId } = req.params;
        const parsed = CLIENT_ASSIGNMENT_BODY_SCHEMA.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        }
        const primaryUserId = parsed.data.primaryUserId ?? null;
        const checkerUserId = parsed.data.checkerUserId ?? null;

        const result = await setClientDepartmentAssignment({
          clientId,
          departmentId,
          primaryUserId,
          checkerUserId,
        });
        if (!result.ok && result.kind === "department_not_found") {
          return res.status(404).json({ error: "Department not found or inactive" });
        }
        if (!result.ok && result.kind === "unsupported_role") {
          return res.status(422).json({ error: UNSUPPORTED_CHECKER_ERROR });
        }
        if (!result.ok && result.kind === "company_scope") {
          return res.status(422).json({
            error:
              "This department's roles are company-wide — set them in the Role Assignments console instead of per client",
          });
        }
        if (!result.ok) {
          return res.status(422).json({
            error: `User set as ${result.field} is not an active member of this department`,
          });
        }
        res.json({
          assignment: assignmentReadPayload(result.assignment),
          projection: result.projection ?? null,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // Coverage grid: all active clients × all active departments, with assignment state.
  app.get(
    "/api/service-desk/coverage",
    isAuthenticated,
    requireTeamLead,
    async (_req, res) => {
      try {
        res.json(await loadUniversalRoleConsole());
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ── Bulk role assignment (Task #3626) ───────────────────────────────────────
  // Applies ONE user (or null to clear) to ONE role slot across a set of
  // client × department pairs, transactionally, with an audit entry recording
  // the full change set (previous values included). Same team-lead gate and
  // department-membership eligibility as the single-row PUT.
  app.post(
    "/api/service-desk/assignments/bulk",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const parsed = SERVICE_DESK_BULK_ASSIGNMENT_BODY_SCHEMA.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        }
        const { departmentId, role, userId: targetUserId } = parsed.data;
        const clientIds = Array.from(new Set(parsed.data.clientIds));
        if (clientIds.length > 1000) {
          return res.status(400).json({ error: "Too many clients in one bulk change (max 1000)" });
        }

        const result = await setBulkClientAssignments({
          departmentId,
          responsibility: role === "primary" ? "doer" : role as "checker",
          userId: targetUserId,
          clientIds,
        });
        if (!result.ok && result.kind === "department_not_found") {
          return res.status(404).json({ error: "Department not found or inactive" });
        }
        if (!result.ok && result.kind === "unsupported_role") {
          return res.status(422).json({ error: UNSUPPORTED_CHECKER_ERROR });
        }
        if (!result.ok && result.kind === "company_scope") {
          return res.status(422).json({
            error: "This department's roles are company-wide — set them in the Role Assignments console instead of per client",
          });
        }
        if (!result.ok && result.kind === "ineligible") {
          return res.status(422).json({
            error: "Selected user is not an active member of this department",
          });
        }
        if (!result.ok && result.kind === "invalid_clients") {
          return res.status(400).json({
            error: `Unknown, archived, or non-customer client(s): ${result.clientIds.join(", ")}`,
          });
        }
        const changes = result.changes;

        // Audit the change set (who changed what, when).
        const actorId: string | null = req.dbUser?.id ?? req.user?.claims?.sub ?? null;
        const audit = await recordAdminSettingChange({
          settingKey: "sd_role_assignments_bulk",
          scope: departmentId,
          changedBy: actorId,
          oldValues: {
            role,
            departmentId,
            previous: changes.map((c) => ({ clientId: c.clientId, userId: c.previousUserId })),
          },
          newValues: {
            role,
            departmentId,
            userId: targetUserId,
            clientIds,
          },
        });

        res.json({ updated: changes.length, changes, auditId: audit.id, projection: result.projection ?? null });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ── Universal Role Assignment Console ─────────────────────────────────────
  // The neutral API is the company-wide UI boundary and preserves the
  // team-lead editor gate.

  app.get(
    "/api/admin/role-assignments",
    isAuthenticated,
    requireTeamLead,
    async (_req, res) => {
      try {
        res.json(await loadUniversalRoleConsole());
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/admin/role-assignments/clients/:clientId",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { clientId } = req.params;
        const [assignments, departments, allMembers, config] = await Promise.all([
          withDbAttribution("assignments:console:getClientAssignments", async () => {
            const db = getDb();
            return db
              .select()
              .from(sdClientDeptAssignments)
              .where(eq(sdClientDeptAssignments.clientId, clientId));
          }),
          withDbAttribution("assignments:console:getClientDepartments", async () => {
            const db = getDb();
            return db
              .select()
              .from(sdDepartments)
              .where(eq(sdDepartments.active, true))
              .orderBy(asc(sdDepartments.sortOrder), asc(sdDepartments.name));
          }),
          withDbAttribution("assignments:console:getClientMembers", async () => {
            const db = getDb();
            return db
              .select({ departmentId: sdDepartmentMembers.departmentId, userId: sdDepartmentMembers.userId })
              .from(sdDepartmentMembers)
              .innerJoin(sdDepartments, eq(sdDepartments.id, sdDepartmentMembers.departmentId))
              .where(and(eq(sdDepartmentMembers.active, true), eq(sdDepartments.active, true)));
          }),
          getListMappingConfig(),
        ]);
        const membersByDept: Record<string, string[]> = {};
        for (const member of allMembers) {
          (membersByDept[member.departmentId] ??= []).push(member.userId);
        }
        const resolvedAssignments = [
          ...(await resolveUniversalAssignmentsForDepartments({
            departmentIds: departments.map((department) => department.id),
            clientId,
            workspaceId: config?.clickupWorkspaceId ?? null,
          })).values(),
        ];
        res.json({
          assignments: assignments.map(assignmentReadPayload),
          departments: departments.map(departmentReadPayload),
          membersByDept,
          resolvedAssignments,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.put(
    "/api/admin/role-assignments/clients/:clientId/departments/:departmentId",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { clientId, departmentId } = req.params;
        const parsed = CLIENT_ASSIGNMENT_BODY_SCHEMA.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        }
        const body = parsed.data;
        const result = await setClientDepartmentAssignment({
          clientId,
          departmentId,
          primaryUserId: body.primaryUserId ?? null,
          checkerUserId: body.checkerUserId ?? null,
        });
        if (!result.ok && result.kind === "department_not_found") {
          return res.status(404).json({ error: "Department not found or inactive" });
        }
        if (!result.ok && result.kind === "unsupported_role") {
          return res.status(422).json({ error: UNSUPPORTED_CHECKER_ERROR });
        }
        if (!result.ok && result.kind === "company_scope") {
          return res.status(422).json({
            error: "This department's roles are company-wide — edit the company role holders instead",
          });
        }
        if (!result.ok) {
          return res.status(422).json({
            error: `User set as ${result.field} is not an active member of this department`,
          });
        }
        res.json({
          assignment: assignmentReadPayload(result.assignment),
          projection: result.projection ?? null,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.put(
    "/api/admin/role-assignments/departments/:id",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { id } = req.params;
        const parsed = DEPARTMENT_ROLE_ASSIGNMENT_BODY_SCHEMA.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        }
        const { defaultPrimaryUserId, defaultCheckerUserId } = parsed.data;
        const result = await setDepartmentRoleAssignments({
          departmentId: id,
          patch: {
            ...(defaultPrimaryUserId !== undefined ? { primaryUserId: defaultPrimaryUserId } : {}),
            ...(defaultCheckerUserId !== undefined ? { checkerUserId: defaultCheckerUserId } : {}),
          },
        });
        if (!result.ok && result.kind === "department_not_found") {
          return res.status(404).json({ error: "Department not found" });
        }
        if (!result.ok && result.kind === "unsupported_role") {
          return res.status(422).json({ error: UNSUPPORTED_CHECKER_ERROR });
        }
        if (!result.ok) {
          return res.status(422).json({
            error: `User set as ${result.field} is not an active member of this department`,
          });
        }
        const actorId: string | null = req.dbUser?.id ?? req.user?.claims?.sub ?? null;
        const audit = await recordAdminSettingChange({
          settingKey: "sd_department_role_defaults",
          scope: id,
          changedBy: actorId,
          oldValues: {
            defaultPrimaryUserId: result.previous.defaultPrimaryUserId ?? null,
            defaultCheckerUserId: result.previous.defaultCheckerUserId ?? null,
          },
          newValues: {
            defaultPrimaryUserId: result.department.defaultPrimaryUserId ?? null,
            defaultCheckerUserId: result.department.defaultCheckerUserId ?? null,
          },
        });
        res.json({
          department: departmentReadPayload(result.department),
          auditId: audit.id,
          projection: result.projection ?? null,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/admin/role-assignments/bulk",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const parsed = BULK_ROLE_ASSIGNMENT_BODY_SCHEMA.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        }
        const { departmentId, responsibility, userId } = parsed.data;
        const clientIds = Array.from(new Set(parsed.data.clientIds));
        if (clientIds.length > 1000) {
          return res.status(400).json({ error: "Too many clients in one bulk change (max 1000)" });
        }
        const result = await setBulkClientAssignments({
          departmentId,
          responsibility: responsibility as "doer" | "checker",
          userId,
          clientIds,
        });
        if (!result.ok && result.kind === "department_not_found") {
          return res.status(404).json({ error: "Department not found or inactive" });
        }
        if (!result.ok && result.kind === "unsupported_role") {
          return res.status(422).json({ error: UNSUPPORTED_CHECKER_ERROR });
        }
        if (!result.ok && result.kind === "company_scope") {
          return res.status(422).json({
            error: "This department's roles are company-wide — edit the company role holders instead",
          });
        }
        if (!result.ok && result.kind === "ineligible") {
          return res.status(422).json({
            error: "Selected user is not an active member of this department",
          });
        }
        if (!result.ok && result.kind === "invalid_clients") {
          return res.status(400).json({
            error: `Unknown, archived, or non-customer client(s): ${result.clientIds.join(", ")}`,
          });
        }
        const actorId: string | null = req.dbUser?.id ?? req.user?.claims?.sub ?? null;
        const audit = await recordAdminSettingChange({
          settingKey: "sd_role_assignments_bulk",
          scope: departmentId,
          changedBy: actorId,
          oldValues: {
            responsibility,
            departmentId,
            previous: result.changes.map((change) => ({
              clientId: change.clientId,
              userId: change.previousUserId,
            })),
          },
          newValues: { responsibility, departmentId, userId, clientIds },
        });
        res.json({ updated: result.changes.length, changes: result.changes, auditId: audit.id, projection: result.projection ?? null });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.get(
    "/api/admin/role-assignments/departments/:id/members",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const rows = await withDbAttribution("assignments:console:listMembers", async () => {
          const db = getDb();
          return db
            .select()
            .from(sdDepartmentMembers)
            .where(eq(sdDepartmentMembers.departmentId, req.params.id))
            .orderBy(asc(sdDepartmentMembers.createdAt));
        });
        res.json({ members: rows });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.post(
    "/api/admin/role-assignments/departments/:id/members",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
        if (!userId) return res.status(400).json({ error: "userId is required" });
        const manualClickupId =
          typeof req.body?.clickupUserId === "string" && req.body.clickupUserId.trim()
            ? req.body.clickupUserId.trim()
            : null;
        let manualVerified = false;
        if (manualClickupId) {
          const verification = await verifyManualClickUpWorkspaceIdentity(req, manualClickupId);
          if (!verification.ok) {
            return res.status(verification.status).json({ error: verification.error });
          }
          manualVerified = true;
        }
        const config = await getListMappingConfig();
        const identity = await resolveClickUpIdentity(
          {
            userId,
            preferredClickUpUserId: manualClickupId,
            preferredClickUpUserIdVerified: manualVerified,
          },
          config?.clickupWorkspaceId ?? null,
        );
        const row = await upsertDepartmentMember({
          departmentId: req.params.id,
          userId,
          clickupUserId: identity.ready ? identity.externalUserId : null,
        });
        const clickupResolution =
          identity.source === "provided"
            ? "manual"
            : identity.source === "personal_oauth"
              ? "connected"
              : "none";
        res.json({ member: row, clickupResolution });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  app.delete(
    "/api/admin/role-assignments/departments/:id/members/:memberId",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const mutation = await deleteDepartmentMember(req.params.memberId);
        res.json({
          success: true,
          clearedAssignments: mutation?.cleared.clientAssignments ?? [],
          clearedDepartmentSlots:
            mutation?.cleared.departmentSlots ?? {
              clearedPrimary: false,
              clearedChecker: false,
            },
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ── ClickUp Role Projections (Task #5156) ──────────────────────────────────
  // Routes for managing and monitoring ClickUp role projection state.
  // Projection mutations are always secondary to NoBull assignment success.
  // HTTP 200 is returned even when projection is pending/ambiguous/blocked.
  //
  // GET  /api/service-desk/role-projections/configuration  — CEO only
  // PUT  /api/service-desk/role-projections/destinations   — CEO only
  // PUT  /api/service-desk/role-projections/targets        — CEO only
  // GET  /api/service-desk/role-projections/status         — team-lead+
  // POST /api/service-desk/role-projections/resync         — team-lead+

  const RESPONSIBILITY_ENUM = z.enum(["doer", "checker"]);
  const ENV_ENUM = z.enum(["sandbox", "production"]);

  // ─ GET /api/service-desk/role-projections/configuration (CEO only) ─────────
  app.get(
    "/api/service-desk/role-projections/configuration",
    isAuthenticated,
    requireCeo,
    async (_req, res) => {
      try {
        const result = await listRoleProjectionConfiguration();
        // Strip any token/private fields defensively.
        res.json(
          result.map((destination) => ({
            ...destination,
            roleCapabilities: getDepartmentRoleCapabilities(destination.departmentId),
          })),
        );
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─ PUT /api/service-desk/role-projections/destinations (CEO only) ──────────
  app.put(
    "/api/service-desk/role-projections/destinations",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const BodySchema = z.object({
          departmentId: z.string().uuid(),
          responsibility: RESPONSIBILITY_ENUM,
          environment: ENV_ENUM,
          workspaceId: z.string().max(64),
          // Owning list UUID — REQUIRED for every destination (each task write is
          // preceded by a live owning-list ownership proof).
          listId: z.string().max(64),
          // direct_task (company-scope): the single ClickUp task ID.
          targetId: z.string().max(64).optional(),
          targetKind: z.enum(["direct_task", "client_list_parent"]),
          peopleFieldId: z.string().max(128),
          enabled: z.boolean().optional().default(false),
          // Approval ACTIONS only — never raw timestamps/actors. The service
          // stamps now()+authenticated actor on approve, clears on revoke, and
          // preserves the existing value when omitted. Arbitrary approval
          // timestamps/actors from the client are rejected by this schema
          // (unknown keys are stripped) and cannot forge an approval.
          sandboxExitApproval: z.enum(["approve", "revoke"]).optional(),
          ownerApproval: z.enum(["approve", "revoke"]).optional(),
        }).strict().superRefine((val, ctx) => {
          // The canonical PRODUCTION list ID may only be used by a PRODUCTION
          // destination. A SANDBOX destination pointed at the canonical
          // production list is rejected (Task #5157 fix 3) — production
          // destinations legitimately use the canonical list and must NOT be
          // blocked. The literal "901417549202" is the canonical production list.
          if (val.environment === "sandbox" && val.listId === "901417549202") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["listId"],
              message:
                "Cannot set the canonical production list ID as a sandbox destination",
            });
          }
        });
        const parsed = BodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        }

        // Actor id from authenticated session only — never client input. An
        // approval must be attributable to the acting CEO.
        const actorId: string | null = req.dbUser?.id ?? req.user?.claims?.sub ?? null;
        const result = await upsertRoleProjectionDestination({
          ...parsed.data,
          actorId,
        });
        if (!result.ok) {
          return res.status(400).json({ error: "Invalid destination", errors: result.errors });
        }
        res.json({
          ...result,
          destination: {
            ...result.destination,
            roleCapabilities: getDepartmentRoleCapabilities(result.destination.departmentId),
          },
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─ PUT /api/service-desk/role-projections/targets (CEO only) ───────────────
  app.put(
    "/api/service-desk/role-projections/targets",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const BodySchema = z.object({
          clientId: z.string().uuid(),
          destinationId: z.string().uuid(),
          targetId: z.string().max(64),
          resolvedListId: z.string().max(64).optional(),
        });
        const parsed = BodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        }

        const result = await upsertRoleProjectionClientTarget(parsed.data);
        if (!result.ok) {
          return res.status(400).json({ error: "Invalid target", errors: result.errors });
        }
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─ GET /api/service-desk/role-projections/status (team-lead+) ──────────────
  app.get(
    "/api/service-desk/role-projections/status",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const QuerySchema = z.object({
          clientId: z.string().uuid().optional(),
          departmentId: z.string().uuid().optional(),
          responsibility: RESPONSIBILITY_ENUM.optional(),
          problemOnly: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
          limit: z.string().optional().transform((v) => {
            const n = Number(v ?? "100");
            return Math.min(Math.max(1, isNaN(n) ? 100 : n), 200);
          }),
        });
        const parsed = QuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten() });
        }

        const result = await listRoleProjectionStatuses(parsed.data);
        // Never expose token/body/private vendor response — filter defensively.
        const safeStatuses = (result?.statuses ?? []).map((s: any) => ({
          clientId: s.clientId,
          departmentId: s.departmentId,
          responsibility: s.responsibility,
          kind: s.kind,
          desiredUserId: s.desiredUserId ?? null,
          desiredClickupUserId: s.desiredClickupUserId
            ? String(s.desiredClickupUserId).slice(0, 255)
            : null,
          lastErrorCode: s.lastErrorCode ? String(s.lastErrorCode).slice(0, 120) : null,
          lastError: s.lastError ? String(s.lastError).slice(0, 500) : null,
          attemptCount: Number.isFinite(Number(s.attemptCount))
            ? Math.max(0, Math.trunc(Number(s.attemptCount)))
            : 0,
          maxAttempts: Number.isFinite(Number(s.maxAttempts))
            ? Math.max(0, Math.trunc(Number(s.maxAttempts)))
            : 5,
          resyncEligible: s.resyncEligible === true,
          nextAttemptAt: s.nextAttemptAt ?? null,
          updatedAt: s.updatedAt ?? null,
          roleCapabilities: getDepartmentRoleCapabilities(s.departmentId),
        }));
        res.json({ statuses: safeStatuses, environment: result?.environment ?? "unconfigured" });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─ POST /api/service-desk/role-projections/resync (team-lead+) ─────────────
  app.post(
    "/api/service-desk/role-projections/resync",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const BodySchema = z.object({
          clientId: z.string().uuid().optional(),
          departmentId: z.string().uuid(),
          responsibility: RESPONSIBILITY_ENUM,
        });
        const parsed = BodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        }

        const result = await manualResyncProjectionByRole(parsed.data);
        // Return safe summary — never expose internal error detail beyond message.
        const response = {
          ok: result?.ok ?? false,
          message: result?.message ?? "Unknown result",
          queued: result?.queued ?? 0,
        };
        if (!response.ok) {
          return res.status(409).json({ ...response, error: response.message });
        }
        res.json(response);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

}

async function loadUniversalRoleConsole() {
  const [allClients, allDepts, config] = await Promise.all([
    withDbAttribution("assignments:console:clients", async () => {
      const db = getDb();
      return db
        .select({ id: clients.id, firmName: clients.firmName })
        .from(clients)
        .where(and(eq(clients.isArchived, false), eq(clients.lifecycleStage, "customer")))
        .orderBy(asc(clients.firmName));
    }),
    withDbAttribution("assignments:console:departments", async () => {
      const db = getDb();
      return db
        .select()
        .from(sdDepartments)
        .where(eq(sdDepartments.active, true))
        .orderBy(asc(sdDepartments.sortOrder), asc(sdDepartments.name));
    }),
    getListMappingConfig(),
  ]);
  const activeClientIds = allClients.map((client) => client.id);
  const activeDepartmentIds = allDepts.map((department) => department.id);
  const perClientDepartmentIds = allDepts
    .filter((department) => !isCompanyScoped(department))
    .map((department) => department.id);
  const [allAssignments, allMembers] = await Promise.all([
    activeClientIds.length > 0 && perClientDepartmentIds.length > 0
      ? withDbAttribution("assignments:console:assignments", async () => {
          const db = getDb();
          return db
            .select()
            .from(sdClientDeptAssignments)
            .where(
              and(
                inArray(sdClientDeptAssignments.clientId, activeClientIds),
                inArray(sdClientDeptAssignments.departmentId, perClientDepartmentIds),
              ),
            );
        })
      : Promise.resolve([]),
    activeDepartmentIds.length > 0
      ? withDbAttribution("assignments:console:members", async () => {
          const db = getDb();
          return db
            .select({ departmentId: sdDepartmentMembers.departmentId, userId: sdDepartmentMembers.userId })
            .from(sdDepartmentMembers)
            .where(
              and(
                inArray(sdDepartmentMembers.departmentId, activeDepartmentIds),
                eq(sdDepartmentMembers.active, true),
              ),
            );
        })
      : Promise.resolve([]),
  ]);

  const assignMap = new Map(
    allAssignments.map((assignment) => [`${assignment.clientId}|${assignment.departmentId}`, assignment]),
  );
  const membersByDept: Record<string, string[]> = {};
  for (const member of allMembers) {
    (membersByDept[member.departmentId] ??= []).push(member.userId);
  }

  const identityTargets = new Map<string, { userId: string; departmentId: string }>();
  for (const department of allDepts) {
    for (const userId of [
      department.defaultPrimaryUserId,
      departmentSupportsChecker(department.id) ? department.defaultCheckerUserId : null,
    ]) {
      if (userId) identityTargets.set(`${department.id}|${userId}`, { departmentId: department.id, userId });
    }
  }
  // Membership eligibility is a first-class console view even before a person
  // holds a role. Resolve every active member so the Members tab can distinguish
  // ClickUp-ready identities from missing identities without inferring from
  // assignment presence.
  for (const member of allMembers) {
    identityTargets.set(`${member.departmentId}|${member.userId}`, {
      departmentId: member.departmentId,
      userId: member.userId,
    });
  }
  for (const assignment of allAssignments) {
    for (const userId of [
      assignment.primaryUserId,
      departmentSupportsChecker(assignment.departmentId) ? assignment.checkerUserId : null,
    ]) {
      if (userId) {
        identityTargets.set(`${assignment.departmentId}|${userId}`, {
          departmentId: assignment.departmentId,
          userId,
        });
      }
    }
  }
  const workspaceId = config?.clickupWorkspaceId ?? null;
  const identities = await resolveClickUpIdentities([...identityTargets.values()], workspaceId);
  const identityByDepartmentUser = new Map(
    [...identities.values()].map((identity) => [
      `${identity.departmentId}|${identity.userId}`,
      identity,
    ]),
  );
  const emptyProjection = {
    provider: "clickup" as const,
    workspaceId,
    externalUserId: null,
    source: null,
    credentialConnected: false,
    credentialStatus: "not_connected",
    workspaceVerification: workspaceId ? ("unverified" as const) : ("not_requested" as const),
    ready: false,
    revision: null,
  };
  const roleState = (
    departmentId: string,
    userId: string | null,
    source: "client_override" | "default" | "company" | null,
    activeMembers: Set<string>,
  ) => ({
    userId,
    source,
    eligibility: !userId ? ("unassigned" as const) : activeMembers.has(userId) ? ("eligible" as const) : ("ineligible" as const),
    stale: !!userId && !activeMembers.has(userId),
    projection: userId
      ? identityByDepartmentUser.get(`${departmentId}|${userId}`) ?? emptyProjection
      : emptyProjection,
  });

  const perClientDepts = allDepts.filter((department) => !isCompanyScoped(department));
  const companyDepts = allDepts.filter((department) => isCompanyScoped(department));
  const rows = allClients.flatMap((client) =>
    perClientDepts.map((department) => {
      const assignment = assignMap.get(`${client.id}|${department.id}`) ?? null;
      const activeMembers = new Set(membersByDept[department.id] ?? []);
      const effective = computeEffectiveRoles(department, assignment);
      const doerState = roleState(
        department.id,
        effective.primaryUserId,
        assignment?.primaryUserId ? "client_override" : department.defaultPrimaryUserId ? "default" : null,
        activeMembers,
      );
      const checkerState = departmentSupportsChecker(department.id)
        ? roleState(
            department.id,
            effective.checkerUserId,
            assignment?.checkerUserId ? "client_override" : department.defaultCheckerUserId ? "default" : null,
            activeMembers,
          )
        : null;
      return {
        clientId: client.id,
        firmName: client.firmName,
        departmentId: department.id,
        deptName: department.name,
        primaryUserId: assignment?.primaryUserId ?? null,
        ...(checkerState
          ? { checkerUserId: assignment?.checkerUserId ?? null }
          : {}),
        defaultPrimaryUserId: department.defaultPrimaryUserId ?? null,
        ...(checkerState
          ? { defaultCheckerUserId: department.defaultCheckerUserId ?? null }
          : {}),
        hasCoverage: doerState.eligibility === "eligible",
        stalePrimary: !!(assignment?.primaryUserId && !activeMembers.has(assignment.primaryUserId)),
        ...(checkerState
          ? {
              staleChecker: !!(
                assignment?.checkerUserId &&
                !activeMembers.has(assignment.checkerUserId)
              ),
            }
          : {}),
        missingDoer: doerState.eligibility !== "eligible",
        ...(checkerState
          ? { missingChecker: checkerState.eligibility !== "eligible" }
          : {}),
        roleStates: {
          doer: doerState,
          ...(checkerState ? { checker: checkerState } : {}),
        },
      };
    }),
  );
  const companyRows = companyDepts.map((department) => {
    const activeMembers = new Set(membersByDept[department.id] ?? []);
    const doer = roleState(department.id, department.defaultPrimaryUserId ?? null, "company", activeMembers);
    const checker = departmentSupportsChecker(department.id)
      ? roleState(department.id, department.defaultCheckerUserId ?? null, "company", activeMembers)
      : null;
    return {
      departmentId: department.id,
      deptName: department.name,
      primaryUserId: doer.userId,
      ...(checker ? { checkerUserId: checker.userId } : {}),
      stalePrimary: doer.stale,
      ...(checker ? { staleChecker: checker.stale } : {}),
      missingDoer: doer.eligibility !== "eligible",
      ...(checker ? { missingChecker: checker.eligibility !== "eligible" } : {}),
       roleStates: { doer, ...(checker ? { checker } : {}) },
    };
  });
  const memberProjectionByDept: Record<string, Record<string, UniversalAssignmentProjectionIdentity>> = {};
  for (const [departmentId, userIds] of Object.entries(membersByDept)) {
    memberProjectionByDept[departmentId] = {};
    for (const userId of userIds) {
      memberProjectionByDept[departmentId][userId] =
        identityByDepartmentUser.get(`${departmentId}|${userId}`) ?? emptyProjection;
    }
  }

  return {
    rows,
    companyRows,
    departments: allDepts.map(departmentReadPayload),
    membersByDept,
    memberProjectionByDept,
    projectionConfigured: !!(config?.clickupWorkspaceId && config?.clickupListId),
  };
}

async function computeDeptDeleteImpact(id: string): Promise<{
  memberRows: number;
  clientAssignmentRows: number;
  requestTypes: number;
  requestTypeQuestions: number;
  requestTypeChecklistSteps: number;
  checklistStepOverridesCleared: number;
  ticketMappingsUntagged: number;
  optionMapEntriesRemoved: number;
  projectionCommands: number;
  projectionClientTargets: number;
  projectionDestinations: number;
  clickupOptionIds: string[];
}> {
  return withDbAttribution("serviceDesk:deptDeleteImpact", async () => {
    const db = getDb();

    const deptRts = await db
      .select({ id: sdRequestTypes.id })
      .from(sdRequestTypes)
      .where(eq(sdRequestTypes.departmentId, id));
    const deptRtIds = deptRts.map((r) => r.id);
    const projectionDestinations = await db
      .select({ id: cuRoleProjectionDestinations.id })
      .from(cuRoleProjectionDestinations)
      .where(eq(cuRoleProjectionDestinations.departmentId, id));
    const projectionDestinationIds = projectionDestinations.map((destination) => destination.id);

    const countRows = async (q: Promise<Array<{ n: number }>>): Promise<number> =>
      Number((await q)[0]?.n ?? 0);
    const n = sql<number>`count(*)::int`;

    const [memberRows, clientAssignmentRows, ticketMappingsUntagged, checklistStepOverridesCleared, requestTypeQuestions, requestTypeChecklistSteps, projectionCommands, projectionClientTargets, config] =
      await Promise.all([
        countRows(db.select({ n }).from(sdDepartmentMembers).where(eq(sdDepartmentMembers.departmentId, id))),
        countRows(db.select({ n }).from(sdClientDeptAssignments).where(eq(sdClientDeptAssignments.departmentId, id))),
        countRows(db.select({ n }).from(sdTicketMapping).where(eq(sdTicketMapping.departmentId, id))),
        // Overrides on SURVIVING request types only — steps of the department's
        // own request types are deleted outright and counted below.
        countRows(
          db
            .select({ n })
            .from(sdRequestTypeChecklistSteps)
            .where(
              and(
                eq(sdRequestTypeChecklistSteps.assigneeDepartmentId, id),
                deptRtIds.length > 0
                  ? notInArray(sdRequestTypeChecklistSteps.requestTypeId, deptRtIds)
                  : undefined,
              ),
            ),
        ),
        deptRtIds.length > 0
          ? countRows(
              db
                .select({ n })
                .from(sdRequestTypeQuestions)
                .where(inArray(sdRequestTypeQuestions.requestTypeId, deptRtIds)),
            )
          : Promise.resolve(0),
        deptRtIds.length > 0
          ? countRows(
              db
                .select({ n })
                .from(sdRequestTypeChecklistSteps)
                .where(inArray(sdRequestTypeChecklistSteps.requestTypeId, deptRtIds)),
            )
          : Promise.resolve(0),
        projectionDestinationIds.length > 0
          ? countRows(
              db
                .select({ n })
                .from(cuRoleProjectionCommands)
                .where(inArray(cuRoleProjectionCommands.destinationId, projectionDestinationIds)),
            )
          : Promise.resolve(0),
        projectionDestinationIds.length > 0
          ? countRows(
              db
                .select({ n })
                .from(cuRoleProjectionClientTargets)
                .where(inArray(cuRoleProjectionClientTargets.destinationId, projectionDestinationIds)),
            )
          : Promise.resolve(0),
        getListMappingConfig(),
      ]);

    const deptOptMap = (config?.departmentOptionIds ?? {}) as Record<string, string>;
    const clickupOptionIds = Object.entries(deptOptMap)
      .filter(([, deptId]) => deptId === id)
      .map(([optionId]) => optionId);

    return {
      memberRows,
      clientAssignmentRows,
      requestTypes: deptRtIds.length,
      requestTypeQuestions,
      requestTypeChecklistSteps,
      checklistStepOverridesCleared,
      ticketMappingsUntagged,
      optionMapEntriesRemoved: clickupOptionIds.length,
      projectionCommands,
      projectionClientTargets,
      projectionDestinations: projectionDestinationIds.length,
      clickupOptionIds,
    };
  });
}
