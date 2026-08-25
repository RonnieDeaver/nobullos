// @db-pool-intent: api
/**
 * Service Desk routes — shared helpers.
 * Extracted verbatim from server/routes/serviceDesk.ts (Task #3787 split);
 * sections: config access, ClickUp field merging, waiting-field bindings, view filters, ticket resolution, eligibility.
 * Mounted by registerServiceDeskRoutes in ../serviceDesk.ts — route order
 * is preserved by the aggregator's call sequence.
 */

import { getDb, withDbAttribution } from "../../db";
import {
  sdDepartments,
  sdDepartmentMembers,
  sdRequestTypes,
  sdListMapping,
  sdTicketMapping,
  sdClientDeptAssignments,
  clickupTasks,
} from "@shared/schema";
import { clients } from "@shared/models/clients";
import { users } from "@shared/models/auth";
import type { SdTicketResolved } from "@shared/schema";
import { eq, and, desc, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { getAccessToken } from "../../services/clickUpIntegration";
import * as cu from "../../services/clickUpClient";
import { isSdChecklistAssigneeRole, SD_CHECKLIST_ASSIGNEE_ROLES } from "../../services/sdChecklistAssignees";
import {
  clearAssignmentsForMember,
  prepareClientAssignmentSeed,
  resolveClickUpIdentities,
  seedClientAssignments,
  type ClientAssignmentSeedSelection,
  type PreparedClientAssignmentSeed,
} from "../../services/sdRoleResolution";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Intake question types (Task #3373; multi_select added in Task #3656).
export const SD_VALID_QUESTION_TYPES = ["text", "long_text", "number", "date", "yes_no", "select", "multi_select"];
// Types whose configuration carries an options list.
export const SD_OPTION_QUESTION_TYPES = ["select", "multi_select"];

// Checklist-step assignee validation (Task #3656): a step may carry a fixed
// user OR a dynamic role token, never both.
export function validateStepAssignee(
  assigneeUserId: string | null | undefined,
  assigneeRole: string | null | undefined,
  assigneeDepartmentId?: string | null | undefined,
): string | null {
  if (assigneeUserId && assigneeRole) {
    return "A checklist step can have either a fixed assignee or a dynamic role, not both";
  }
  if (assigneeRole && !isSdChecklistAssigneeRole(assigneeRole)) {
    return `assigneeRole must be one of: ${SD_CHECKLIST_ASSIGNEE_ROLES.join(", ")}`;
  }
  if (assigneeDepartmentId && !assigneeRole) {
    return "assigneeDepartmentId is only valid together with a dynamic assigneeRole";
  }
  return null;
}

export async function isRequesterOrPrivileged(actorUserId: string, taskId: string): Promise<boolean> {
  const [mapping] = await withDbAttribution("serviceDesk:authCheck:mapping", async () => {
    const db = getDb();
    return db.select({ requesterUserId: sdTicketMapping.requesterUserId })
      .from(sdTicketMapping)
      .where(eq(sdTicketMapping.clickupTaskId, taskId))
      .limit(1);
  });
  if (mapping?.requesterUserId && mapping.requesterUserId === actorUserId) return true;
  const [actorRow] = await withDbAttribution("serviceDesk:authCheck:role", async () => {
    const db = getDb();
    return db.select({ role: users.role }).from(users).where(eq(users.id, actorUserId)).limit(1);
  });
  return ["ceo", "team_lead"].includes(actorRow?.role ?? "");
}

export async function getListMappingConfig() {
  return withDbAttribution("serviceDesk:getConfig", async () => {
    const db = getDb();
    const [row] = await db.select().from(sdListMapping).limit(1);
    return row ?? null;
  });
}

// ── Mapped-option name refresh (Task #3616) ──────────────────────────────────
// When a dropdown option is renamed in ClickUp, the mapped NoBull row keeps its
// stale name because imports skip already-mapped options. These helpers refresh
// ONLY display names for options that are already mapped — they never bind,
// unbind, or overwrite mappings. Renames that would collide with another
// existing row's name are skipped (safe no-op) to avoid duplicate names.

type RenamedDepartment = { optionId: string; departmentId: string; oldName: string; newName: string };

export async function refreshMappedDepartmentNames(
  clickupOptions: Array<{ id: string; name: string }>,
  optionMap: Record<string, string>,
  existingDepts: Array<{ id: string; name: string }>,
): Promise<RenamedDepartment[]> {
  const renamed: RenamedDepartment[] = [];
  const deptById = new Map(existingDepts.map((d) => [d.id, d]));
  const nameOwner = new Map(existingDepts.map((d) => [d.name.toLowerCase().trim(), d.id]));
  for (const opt of clickupOptions) {
    const deptId = optionMap[opt.id];
    if (!deptId || !opt.name) continue;
    const dept = deptById.get(deptId);
    if (!dept || dept.name.trim() === opt.name) continue;
    const owner = nameOwner.get(opt.name.toLowerCase().trim());
    if (owner && owner !== deptId) continue; // another dept already holds this name
    await withDbAttribution("serviceDesk:refreshNames:renameDept", async () => {
      const db = getDb();
      await db
        .update(sdDepartments)
        .set({ name: opt.name, updatedAt: new Date() })
        .where(eq(sdDepartments.id, deptId));
    });
    renamed.push({ optionId: opt.id, departmentId: deptId, oldName: dept.name, newName: opt.name });
    nameOwner.delete(dept.name.toLowerCase().trim());
    nameOwner.set(opt.name.toLowerCase().trim(), deptId);
    dept.name = opt.name; // keep the in-memory list current for later name matching
  }
  return renamed;
}

type RenamedRequestType = { optionId: string; requestTypeId: string; oldName: string; newName: string };

// requestTypeOptionIds values are request-type NAMES (labels), not ids — so a
// rename must update BOTH the sd_request_types row and the map value. The map
// passed in is mutated in place; callers persist it when anything was renamed.
export async function refreshMappedRequestTypeNames(
  clickupOptions: Array<{ id: string; name: string }>,
  optionMap: Record<string, string>,
  existingRts: Array<{ id: string; name: string }>,
): Promise<RenamedRequestType[]> {
  const renamed: RenamedRequestType[] = [];
  const rtByNameKey = new Map(existingRts.map((r) => [r.name.toLowerCase().trim(), r]));
  for (const opt of clickupOptions) {
    const mappedName = optionMap[opt.id];
    if (!mappedName || !opt.name || mappedName.trim() === opt.name.trim()) continue;
    const rt = rtByNameKey.get(mappedName.toLowerCase().trim());
    if (!rt) continue; // mapping points at a name with no backing row — leave untouched
    const clash = rtByNameKey.get(opt.name.toLowerCase().trim());
    if (clash && clash.id !== rt.id) continue; // another request type already holds this name
    await withDbAttribution("serviceDesk:refreshNames:renameRt", async () => {
      const db = getDb();
      await db
        .update(sdRequestTypes)
        .set({ name: opt.name, updatedAt: new Date() })
        .where(eq(sdRequestTypes.id, rt.id));
    });
    renamed.push({ optionId: opt.id, requestTypeId: rt.id, oldName: rt.name, newName: opt.name });
    rtByNameKey.delete(rt.name.toLowerCase().trim());
    rt.name = opt.name;
    rtByNameKey.set(opt.name.toLowerCase().trim(), rt);
    optionMap[opt.id] = opt.name;
  }
  return renamed;
}

export async function getCeoToken(req: any): Promise<string | null> {
  const userId: string | undefined = req.user?.claims?.sub;
  if (!userId) return null;
  return getAccessToken(userId);
}

/**
 * Fetch custom fields from every ClickUp hierarchy level that is configured for
 * the bound List, then merge them deduplicated by field id.
 *
 * ClickUp's custom-field endpoints are level-scoped (developer.clickup.com,
 * "Get List Custom Fields" and siblings, reviewed Jul 23 2026):
 *   GET /v2/list/{id}/field    — fields created at List level only
 *   GET /v2/folder/{id}/field  — fields created at Folder level
 *   GET /v2/space/{id}/field   — fields created at Space level
 *   GET /v2/team/{id}/field    — fields created at Workspace level
 * A field created above the List level is inherited (visible in the ClickUp UI
 * and on tasks) but invisible to the List endpoint alone. This helper queries
 * every configured level so inherited fields are found.
 *
 * Individual level-fetch failures are tolerated; whatever was successfully
 * fetched is returned together with a list of level names that failed, so
 * callers can report an incomplete check rather than a false "not found".
 */
export async function getMergedCustomFields(
  token: string,
  config: {
    clickupListId: string | null;
    clickupFolderId?: string | null;
    clickupSpaceId?: string | null;
    clickupWorkspaceId?: string | null;
  },
): Promise<{ fields: any[]; levelErrors: string[] }> {
  const seenIds = new Set<string>();
  const merged: any[] = [];
  const levelErrors: string[] = [];

  const addFields = (incoming: any[]) => {
    for (const f of incoming) {
      const id = String(f?.id ?? "");
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        merged.push(f);
      }
    }
  };

  // List level — always attempted when a list is configured
  if (config.clickupListId) {
    try {
      addFields(await cu.getCustomFields(token, config.clickupListId));
    } catch (err: any) {
      levelErrors.push(`list (${err?.message ?? "error"})`);
    }
  }

  // Folder level
  if (config.clickupFolderId) {
    try {
      addFields(await cu.getCustomFieldsForFolder(token, config.clickupFolderId));
    } catch (err: any) {
      levelErrors.push(`folder (${err?.message ?? "error"})`);
    }
  }

  // Space level
  if (config.clickupSpaceId) {
    try {
      addFields(await cu.getCustomFieldsForSpace(token, config.clickupSpaceId));
    } catch (err: any) {
      levelErrors.push(`space (${err?.message ?? "error"})`);
    }
  }

  // Workspace level
  if (config.clickupWorkspaceId) {
    try {
      addFields(await cu.getCustomFieldsForWorkspace(token, config.clickupWorkspaceId));
    } catch (err: any) {
      levelErrors.push(`workspace (${err?.message ?? "error"})`);
    }
  }

  return { fields: merged, levelErrors };
}

// Waiting-on custom-field bindings that transitions depend on (Task #3176).
// Validated at setup/save time against ClickUp's real field list so a stale
// or mistyped UUID is caught before a ticket transition silently loses metadata.
export const WAITING_FIELD_BINDINGS = [
  { key: "fieldWaitingWhoId", label: "Waiting On (who)" },
  { key: "fieldWaitingWhatId", label: "Action Needed (what)" },
  { key: "fieldWaitingWhenId", label: "Response Needed By (when)" },
] as const;

/**
 * Given a config-like object and the list's real custom fields, returns the
 * waiting-on bindings whose stored UUID does NOT exist on the ClickUp list
 * (stale/mistyped). Unset bindings are not returned — "unbound" is reported
 * separately by the field_mapping check.
 */
export function findStaleWaitingFieldBindings(
  config: Record<string, unknown>,
  listFields: Array<{ id?: unknown }>,
): Array<{ key: string; label: string; id: string }> {
  const fieldIds = new Set(listFields.map((f) => String(f?.id ?? "")));
  const stale: Array<{ key: string; label: string; id: string }> = [];
  for (const b of WAITING_FIELD_BINDINGS) {
    const id = config[b.key];
    if (typeof id === "string" && id.trim() && !fieldIds.has(id.trim())) {
      stale.push({ key: b.key, label: b.label, id: id.trim() });
    }
  }
  return stale;
}

// ─── View filter helpers (Task #3059) ─────────────────────────────────────────

export async function getUserDeptIds(userId: string): Promise<Set<string>> {
  const rows = await withDbAttribution("serviceDesk:getUserDepts", async () => {
    const db = getDb();
    return db
      .select({ departmentId: sdDepartmentMembers.departmentId })
      .from(sdDepartmentMembers)
      .where(and(eq(sdDepartmentMembers.userId, userId), eq(sdDepartmentMembers.active, true)));
  });
  return new Set(rows.map((r) => r.departmentId));
}

const VIEW_TERMINAL = new Set(["closed", "canceled", "duplicate", "out of scope"]);
const VIEW_WAITING = new Set(["waiting on account manager", "waiting on client", "waiting on approval", "blocked"]);

export function applyViewFilter(
  tickets: SdTicketResolved[],
  view: string,
  currentUserId: string,
  userDeptIds: Set<string>,
): SdTicketResolved[] {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const todayEndMs = todayMs + 86400000;

  switch (view) {
    case "my_submitted":
      return tickets.filter(
        (t) => t.requesterUserId === currentUserId && !VIEW_TERMINAL.has((t.status ?? "").toLowerCase()),
      );
    case "assigned_to_me":
      return tickets.filter(
        (t) => t.ownerUserId === currentUserId && !VIEW_TERMINAL.has((t.status ?? "").toLowerCase()),
      );
    case "waiting_on_me":
      return tickets.filter((t) => {
        const s = (t.status ?? "").toLowerCase();
        if (!VIEW_WAITING.has(s)) return false;
        if (s === "waiting on client") return t.requesterUserId === currentUserId;
        return t.ownerUserId === currentUserId;
      });
    case "my_department":
      return tickets.filter(
        (t) =>
          t.departmentId !== null &&
          userDeptIds.has(t.departmentId as string) &&
          !VIEW_TERMINAL.has((t.status ?? "").toLowerCase()),
      );
    case "due_today":
      return tickets.filter((t) => {
        if (!t.committedDate) return false;
        const ms = Number(t.committedDate);
        return !isNaN(ms) && ms >= todayMs && ms < todayEndMs && !VIEW_TERMINAL.has((t.status ?? "").toLowerCase());
      });
    case "overdue":
      return tickets
        .filter((t) => {
          if (!t.committedDate) return false;
          const ms = Number(t.committedDate);
          return !isNaN(ms) && ms < todayMs && !VIEW_TERMINAL.has((t.status ?? "").toLowerCase());
        })
        .sort((a, b) => Number(a.committedDate) - Number(b.committedDate));
    case "recently_updated":
      return tickets
        .filter((t) => !VIEW_TERMINAL.has((t.status ?? "").toLowerCase()))
        .sort((a, b) => Number(b.dateUpdated ?? 0) - Number(a.dateUpdated ?? 0))
        .slice(0, 50);
    case "delivered_for_review":
      return tickets.filter(
        (t) => (t.status ?? "").toLowerCase() === "delivered" && t.requesterUserId === currentUserId,
      );
    case "closed":
      return tickets.filter((t) => VIEW_TERMINAL.has((t.status ?? "").toLowerCase()));
    default:
      return tickets;
  }
}

// ─── Ticket resolver ──────────────────────────────────────────────────────────
// Reads tasks from the mirror (listId = bound list), joins with sd_ticket_mapping,
// and maps custom field values to NoBull fields using the stored UUID mappings.
//
// Resolution priority (ClickUp is authoritative for mapped attributes):
//   department  → ClickUp dropdown option UUID → departmentOptionIds map → NoBull dept ID
//   requestType → ClickUp dropdown option UUID → requestTypeOptionIds map → NoBull RT label
//   clientName  → raw ClickUp custom field text (display; canonical resolution via future sync)
//   requesterRaw→ raw ClickUp custom field text
//   clientId    → sd_ticket_mapping (set by webhook/manual sync)
//   requesterUserId → sd_ticket_mapping
//   ownerUserId → sd_ticket_mapping

export async function resolveTickets(
  config: NonNullable<Awaited<ReturnType<typeof getListMappingConfig>>>,
  taskIds?: string[],
): Promise<SdTicketResolved[]> {
  if (!config.clickupListId) return [];

  return withDbAttribution("serviceDesk:resolveTickets", async () => {
    const db = getDb();

    const query = taskIds?.length
      ? db
          .select()
          .from(clickupTasks)
          .where(and(eq(clickupTasks.listId, config.clickupListId!), inArray(clickupTasks.id, taskIds)))
      : db.select().from(clickupTasks).where(eq(clickupTasks.listId, config.clickupListId!));

    const tasks = await query.orderBy(desc(clickupTasks.dateUpdated));

    const taskIdList = tasks.map((t) => t.id);
    const mappings = taskIdList.length
      ? await db
          .select()
          .from(sdTicketMapping)
          .where(inArray(sdTicketMapping.clickupTaskId, taskIdList))
      : [];

    const mappingByTaskId = new Map(mappings.map((m) => [m.clickupTaskId, m]));

    // Canonical client name lookup: fetch all clients once, build case-insensitive map.
    // Task #4330: customers only — a lead sharing a firm name must not be
    // matched as the service-desk client for a ClickUp ticket.
    const allClients = await db.select({ id: clients.id, firmName: clients.firmName }).from(clients).where(eq(clients.lifecycleStage, "customer"));
    const clientByName = new Map(allClients.map((c) => [c.firmName.toLowerCase().trim(), c.id]));

    // Option-ID maps from config (UUID → NoBull entity ID/label)
    const deptOptMap = (config.departmentOptionIds ?? {}) as Record<string, string>;
    const rtOptMap = (config.requestTypeOptionIds ?? {}) as Record<string, string>;

    function findCf(cfs: any[], fieldId: string | null | undefined): any | null {
      if (!fieldId || !Array.isArray(cfs)) return null;
      return cfs.find((cf: any) => cf.id === fieldId) ?? null;
    }

    /** Extract the raw option UUID from a ClickUp dropdown/label field value. */
    function extractOptionId(cfs: any[], fieldId: string | null | undefined): string | null {
      const cf = findCf(cfs, fieldId);
      if (!cf || cf.value === null || cf.value === undefined) return null;
      const v = cf.value;
      // Dropdown: value is option UUID string or { id: uuid } object
      if (typeof v === "string") return v;
      if (typeof v === "object" && v !== null && typeof v.id === "string") return v.id;
      // Labels: first element
      if (Array.isArray(v) && v.length > 0) {
        const first = v[0];
        if (typeof first === "string") return first;
        if (typeof first === "object" && first !== null && typeof first.id === "string") return first.id;
      }
      return null;
    }

    /** Extract a text value from a ClickUp text/date/email field. */
    function extractText(cfs: any[], fieldId: string | null | undefined): string | null {
      const cf = findCf(cfs, fieldId);
      if (!cf || cf.value === null || cf.value === undefined) return null;
      return String(cf.value);
    }

    /**
     * Fallback for tickets submitted before question_answers was stored:
     * parse the "## Intake Questions" block the native form writes into the
     * mirrored task description (`**Label:** value` lines).
     */
    function parseAnswersFromDescription(description: string | null): Array<{ label: string; value: string }> | null {
      if (!description) return null;
      const marker = description.indexOf("## Intake Questions");
      if (marker === -1) return null;
      const block = description.slice(marker + "## Intake Questions".length);
      const end = block.search(/\n#{1,6} |\n---/);
      const section = end === -1 ? block : block.slice(0, end);
      const answers: Array<{ label: string; value: string }> = [];
      for (const line of section.split("\n")) {
        const m = line.match(/^\*\*(.+?):\*\*\s*(.*)$/);
        if (!m) continue;
        const value = m[2].trim();
        if (!value || value === "*(not provided)*") continue;
        answers.push({ label: m[1].trim(), value });
      }
      return answers.length > 0 ? answers : null;
    }

    return tasks.map((task): SdTicketResolved => {
      const mapping = mappingByTaskId.get(task.id);
      const cfs: any[] = Array.isArray(task.customFields) ? (task.customFields as any[]) : [];

      const assignees = Array.isArray(task.assignees)
        ? (task.assignees as any[]).map((a: any) => ({
            id: String(a.id ?? a.userId ?? ""),
            username: String(a.username ?? a.email ?? ""),
          }))
        : [];

      // Department: resolve from ClickUp option UUID via departmentOptionIds map
      const deptOptionId = extractOptionId(cfs, config.fieldDepartmentId);
      const clickupDeptId = deptOptionId ? (deptOptMap[deptOptionId] ?? null) : null;
      const departmentId = clickupDeptId ?? mapping?.departmentId ?? null;

      // Request type: resolve label from ClickUp option UUID via requestTypeOptionIds map
      const rtOptionId = extractOptionId(cfs, config.fieldRequestTypeId);
      const requestType = rtOptionId ? (rtOptMap[rtOptionId] ?? extractText(cfs, config.fieldRequestTypeId)) : extractText(cfs, config.fieldRequestTypeId);

      // Client: extract option UUID from dropdown field first (primary path),
      // then fall back to raw firm-name text lookup for legacy text-field tickets.
      const clientOptMap = (config.clientOptionIds ?? {}) as Record<string, string>;
      const clientOptionId = extractOptionId(cfs, config.fieldClientId);
      const rawClientText = extractText(cfs, config.fieldClientId);

      // Canonical client resolution: option UUID map first, then firm-name text fallback
      const resolvedClientId: string | null =
        (clientOptionId ? (clientOptMap[clientOptionId] ?? null) : null) ??
        (rawClientText ? (clientByName.get(rawClientText.toLowerCase().trim()) ?? null) : null);

      // clientName for display: prefer resolved firm name, then raw text (legacy)
      const resolvedClientFirmName = resolvedClientId
        ? (allClients.find((c) => c.id === resolvedClientId)?.firmName ?? null)
        : null;
      const clientName = resolvedClientFirmName ?? rawClientText;
      const requesterRaw = extractText(cfs, config.fieldRequesterId);

      return {
        clickupTaskId: task.id,
        name: task.name,
        status: task.status,
        statusColor: task.statusColor,
        url: task.url,
        priority: task.priority,
        priorityName: task.priorityName,
        dateCreated: task.dateCreated,
        dateUpdated: task.dateUpdated,
        clientId: mapping?.clientId ?? null,
        resolvedClientId,
        clientName,
        requesterUserId: mapping?.requesterUserId ?? null,
        requesterRaw,
        ownerUserId: mapping?.ownerUserId ?? null,
        departmentId,
        requestType,
        requestedDate: extractText(cfs, config.fieldRequestedDateId),
        committedDate: extractText(cfs, config.fieldCommittedDateId),
        waitingWho: extractText(cfs, config.fieldWaitingWhoId),
        waitingWhat: extractText(cfs, config.fieldWaitingWhatId),
        waitingWhen: extractText(cfs, config.fieldWaitingWhenId),
        assignees,
        readAt: mapping?.readAt?.toISOString() ?? null,
        lastNotifiedAt: mapping?.lastNotifiedAt?.toISOString() ?? null,
        questionAnswers:
          (Array.isArray(mapping?.questionAnswers) && (mapping!.questionAnswers as any[]).length > 0
            ? (mapping!.questionAnswers as Array<{ label: string; value: string }>)
            : null) ?? parseAnswersFromDescription(task.description),
      };
    });
  });
}

// ─── Eligibility helper ───────────────────────────────────────────────────────
// Checks whether department members have ClickUp access (connected token OR manual
// clickupUserId) AND are members of the configured ClickUp workspace/list.
//
// Workspace membership is verified using the CEO token when available.
// If the workspace is not yet configured or the CEO token is unavailable, the
// workspace check is skipped and eligiblePath becomes "token_unverified" / "manual_unverified".

type EligibleMember = {
  userId: string;
  clickupUserId: string | null;
  active: boolean;
  hasClickUp: boolean;
  inWorkspace: boolean | null;
  eligiblePath: "token" | "token_unverified" | "manual" | "manual_unverified";
};

export async function getEligibleAssignees(
  departmentId: string,
  opts: { ceoToken?: string | null; workspaceId?: string | null } = {},
): Promise<{ members: EligibleMember[] }> {
  const members = await withDbAttribution("serviceDesk:eligibility", async () => {
    const db = getDb();
    return db
      .select()
      .from(sdDepartmentMembers)
      .where(and(eq(sdDepartmentMembers.departmentId, departmentId), eq(sdDepartmentMembers.active, true)));
  });
  const identities = await resolveClickUpIdentities(
    members.map((member) => ({ userId: member.userId, departmentId })),
    opts.workspaceId ?? null,
  );

  // Build the candidate list (users who have a ClickUp user ID)
  const candidates = members
    .map((member) => {
      const identity = identities.get(`${member.userId}|${departmentId}`);
      const hasClickUp = !!identity?.ready;
      const baseEligiblePath: "token" | "manual" =
        identity?.source === "personal_oauth" ? "token" : "manual";
      return {
        userId: member.userId,
        clickupUserId: identity?.externalUserId ?? null,
        active: member.active,
        hasClickUp,
        baseEligiblePath,
      };
    })
    .filter((m) => m.hasClickUp);

  // Workspace membership check — requires CEO token + workspace ID
  const { ceoToken, workspaceId } = opts;
  if (ceoToken && workspaceId) {
    try {
      const wsMembers = await cu.getWorkspaceMembers(ceoToken, workspaceId);
      // The existing function returns raw team members: each element is { user: { id, ... } }
      // ClickUp workspace member IDs are numeric; store as string set for lookup
      const wsMemberIds = new Set(
        wsMembers.map((m: any) => String(m.user?.id ?? m.id ?? m.userId ?? "")),
      );
      const eligible: EligibleMember[] = candidates.map((m) => {
        const cuId = m.clickupUserId ? String(m.clickupUserId) : null;
        const inWorkspace = cuId ? wsMemberIds.has(cuId) : false;
        const eligiblePath: EligibleMember["eligiblePath"] =
          m.baseEligiblePath === "token" ? "token" : "manual";
        return { userId: m.userId, clickupUserId: m.clickupUserId, active: m.active, hasClickUp: m.hasClickUp, inWorkspace, eligiblePath };
      }).filter((m) => m.inWorkspace);
      return { members: eligible };
    } catch {
      // Workspace check failed — fall through to unverified path
    }
  }

  // Workspace check skipped (no CEO token / workspace ID / API error) — mark unverified
  const eligible: EligibleMember[] = candidates.map((m) => ({
    userId: m.userId,
    clickupUserId: m.clickupUserId,
    active: m.active,
    hasClickUp: m.hasClickUp,
    inWorkspace: null,
    eligiblePath: (m.baseEligiblePath === "token" ? "token_unverified" : "manual_unverified") as EligibleMember["eligiblePath"],
  }));
  return { members: eligible };
}

// ─── Route registration ───────────────────────────────────────────────────────

/**
 * Task #3586 — When a member leaves a department (deactivated or hard-deleted),
 * clear any client×dept assignment rows still referencing them as Primary
 * Doer or Checker, and return the affected clients so the admin
 * UI can surface them (Task #3618 extends this to all three role slots).
 *
 * Task #4171 — also clears the DEPARTMENT-level role slots (default holders
 * for per-client departments; THE company-wide holders for company-scope
 * departments) so a departed member never lingers as a default/company role.
 */
export async function clearMemberAssignments(
  departmentId: string,
  userId: string,
): Promise<{
  clientAssignments: { clientId: string; clearedPrimary: boolean; clearedChecker: boolean }[];
  departmentSlots: { clearedPrimary: boolean; clearedChecker: boolean };
}> {
  return clearAssignmentsForMember(departmentId, userId);
}

// ─── Client-creation team seeding (Task #4171) ───────────────────────────────

/** One per-department role selection from the Add Client form. Keys that are
 * ABSENT mean "untouched — use the department default"; keys explicitly set
 * to null mean "no explicit person" (runtime resolution still falls back to
 * the department default — that is what defaults are for). */
export type ClientTeamSelection = ClientAssignmentSeedSelection;
export type PreparedClientTeamSeed = PreparedClientAssignmentSeed;

export type PrepareClientTeamSeedResult =
  | { ok: true; seed: PreparedClientTeamSeed }
  | { ok: false; status: 400 | 422; error: string };

const SEED_ROLE_KEYS = ["primaryUserId", "checkerUserId"] as const;
const CLIENT_TEAM_SELECTION_SCHEMA = z
  .object({
    departmentId: z.string().trim().min(1).max(255),
    primaryUserId: z.union([z.string().trim().max(255), z.null()]).optional(),
    checkerUserId: z.union([z.string().trim().max(255), z.null()]).optional(),
  })
  .strict();

/**
 * Validate the Add Client form's team selections and build the assignment
 * rows to seed — one row per ACTIVE client-facing (per_client) department.
 * Runs BEFORE the client row is created so a bad selection rejects the whole
 * request (400/422) without a half-created client.
 *
 * Rules:
 * - explicit picks must be active members of that department (422);
 * - selections may only target known, active, per_client departments (400);
 * - untouched roles inherit the department default, except a default whose
 *   holder is no longer an active member — skipped silently (stale default
 *   must not block client creation);
 * - explicit null stores null (the department default still applies at
 *   resolution time, like any empty slot).
 */
export async function prepareClientTeamSeed(selections: unknown): Promise<PrepareClientTeamSeedResult> {
  if (selections !== undefined && selections !== null && !Array.isArray(selections)) {
    return { ok: false, status: 400, error: "teamAssignments must be an array" };
  }
  const list = (selections ?? []) as unknown[];
  const parsed: ClientTeamSelection[] = [];
  for (const raw of list) {
    const result = CLIENT_TEAM_SELECTION_SCHEMA.safeParse(raw);
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path[0];
      if (field === "departmentId") {
        return { ok: false, status: 400, error: "teamAssignments entries require a departmentId" };
      }
      if (field && SEED_ROLE_KEYS.includes(field as (typeof SEED_ROLE_KEYS)[number])) {
        return { ok: false, status: 400, error: `teamAssignments.${String(field)} must be a user id or null` };
      }
      return { ok: false, status: 400, error: "Invalid teamAssignments entry" };
    }
    parsed.push(result.data);
  }
  const seenDepts = new Set<string>();
  for (const sel of parsed) {
    if (seenDepts.has(sel.departmentId)) {
      return { ok: false, status: 400, error: `Duplicate teamAssignments entry for department ${sel.departmentId}` };
    }
    seenDepts.add(sel.departmentId);
  }

  return prepareClientAssignmentSeed(parsed);
}

/**
 * Insert the prepared assignment rows for a just-created client. Failures
 * here must NOT undo the client creation — the caller logs loudly and
 * surfaces a warning instead. Conflict-safe for retries.
 */
export async function applyClientTeamSeed(clientId: string, seed: PreparedClientTeamSeed): Promise<number> {
  return seedClientAssignments(clientId, seed.rows);
}
