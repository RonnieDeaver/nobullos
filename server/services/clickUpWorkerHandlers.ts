// @db-pool-intent: worker
/**
 * Task #2927 — ClickUp work-queue handlers.
 *
 * clickup_hierarchy_backfill: Syncs the full workspace hierarchy
 *   (spaces → folders → lists → tasks) for a given workspace.
 *   Triggered via POST /api/clickup/workspaces/:id/sync or on webhook events.
 *
 * clickup_task_apply: Reconciles a single task from ClickUp API
 *   (triggered by webhook events with task_id).
 */

import type { WorkQueueJob } from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { clickupTasks, clickupSpaces, clickupFolders, clickupLists, workQueue, clickupWebhooks, sdListMapping, sdTicketMapping, sdTicketEvents, sdRequestTypes, sdRequestTypeQuestions, sdRequestTypeChecklistSteps } from "@shared/schema";
import { users } from "@shared/models/auth";
import { clients } from "@shared/models/clients";
import { eq, sql, and } from "drizzle-orm";
import { getAccessToken } from "./clickUpIntegration";
import * as cu from "./clickUpClient";
import { workerLog } from "./workerLogger";
import { resolveChecklistStepAssignees } from "./sdChecklistAssignees";

export async function handleClickUpHierarchyBackfill(job: WorkQueueJob): Promise<void> {
  const payload = (job.payload ?? {}) as { workspaceId?: string; userId?: string };
  const { workspaceId, userId } = payload;
  if (!workspaceId || !userId) {
    workerLog({ event: "no_op", worker: "clickup_hierarchy_backfill", detail: "missing workspaceId or userId" });
    return;
  }

  const token = await getAccessToken(userId);
  if (!token) {
    workerLog({ event: "no_op", worker: "clickup_hierarchy_backfill", detail: "user not connected" });
    return;
  }

  workerLog({ event: "backfill_started", worker: "clickup_hierarchy_backfill", workspaceId });

  const spaces = await cu.getSpaces(token, workspaceId);
  let spacesUpserted = 0;
  let foldersUpserted = 0;
  let listsUpserted = 0;
  let tasksUpserted = 0;

  for (const space of spaces) {
    await withDbAttribution("clickup:backfill:upsertSpace", async () => {
      const db = getDb();
      await db
        .insert(clickupSpaces)
        .values({
          id: String(space.id),
          workspaceId,
          name: space.name ?? "",
          color: space.color ?? null,
          private: !!space.private,
          statuses: space.statuses ?? null,
          features: space.features ?? null,
          archived: !!space.archived,
          syncedAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: clickupSpaces.id,
          set: {
            name: space.name ?? "",
            color: space.color ?? null,
            private: !!space.private,
            statuses: space.statuses ?? null,
            features: space.features ?? null,
            archived: !!space.archived,
            syncedAt: new Date(),
            updatedAt: new Date(),
          },
        });
    });
    spacesUpserted++;

    const [folders, spaceListsRaw] = await Promise.all([
      cu.getFolders(token, String(space.id)),
      cu.getListsInSpace(token, String(space.id)),
    ]);

    for (const folder of folders) {
      await withDbAttribution("clickup:backfill:upsertFolder", async () => {
        const db = getDb();
        await db
          .insert(clickupFolders)
          .values({
            id: String(folder.id),
            spaceId: String(space.id),
            name: folder.name ?? "",
            orderIndex: folder.orderindex ?? null,
            override_statuses: folder.override_statuses ?? null,
            hidden: !!folder.hidden,
            archived: !!folder.archived,
            syncedAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: clickupFolders.id,
            set: {
              name: folder.name ?? "",
              hidden: !!folder.hidden,
              archived: !!folder.archived,
              syncedAt: new Date(),
              updatedAt: new Date(),
            },
          });
      });
      foldersUpserted++;

      const folderLists = await cu.getListsInFolder(token, String(folder.id));
      for (const list of folderLists) {
        await upsertList(list, String(space.id), String(folder.id));
        listsUpserted++;
        const listTasks = await fetchAllTasksForList(token, String(list.id));
        for (const task of listTasks) {
          await upsertTask(task, workspaceId, String(space.id), String(folder.id), String(list.id));
          tasksUpserted++;
        }
      }
    }

    for (const list of spaceListsRaw) {
      await upsertList(list, String(space.id), null);
      listsUpserted++;
      const listTasks = await fetchAllTasksForList(token, String(list.id));
      for (const task of listTasks) {
        await upsertTask(task, workspaceId, String(space.id), null, String(list.id));
        tasksUpserted++;
      }
    }
  }

  workerLog({
    event: "backfill_completed",
    worker: "clickup_hierarchy_backfill",
    workspaceId,
    spacesUpserted,
    foldersUpserted,
    listsUpserted,
    tasksUpserted,
  });
}

async function upsertList(list: any, spaceId: string, folderId: string | null): Promise<void> {
  await withDbAttribution("clickup:backfill:upsertList", async () => {
    const db = getDb();
    await db
      .insert(clickupLists)
      .values({
        id: String(list.id),
        folderId: folderId,
        spaceId,
        name: list.name ?? "",
        orderIndex: list.orderindex ?? null,
        content: list.content ?? null,
        status: list.status?.status ?? null,
        taskCount: typeof list.task_count === "number" ? list.task_count : null,
        archived: !!list.archived,
        statuses: list.statuses ?? null,
        syncedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: clickupLists.id,
        set: {
          name: list.name ?? "",
          taskCount: typeof list.task_count === "number" ? list.task_count : null,
          archived: !!list.archived,
          syncedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  });
}

async function fetchAllTasksForList(token: string, listId: string): Promise<any[]> {
  const allTasks: any[] = [];
  let page = 0;
  while (true) {
    const result = await cu.getTasksInList(token, listId, { page, includeMarkdownDescription: false });
    allTasks.push(...(result.tasks ?? []));
    if (result.last_page) break;
    page++;
    if (page > 100) break; // safety cap
  }
  return allTasks;
}

async function upsertTask(
  task: any,
  workspaceId: string,
  spaceId: string,
  folderId: string | null,
  listId: string,
): Promise<void> {
  await withDbAttribution("clickup:backfill:upsertTask", async () => {
    const db = getDb();
    await db
      .insert(clickupTasks)
      .values({
        id: String(task.id),
        listId,
        folderId: folderId,
        spaceId,
        workspaceId,
        parentId: task.parent ? String(task.parent) : null,
        name: task.name ?? "",
        description: task.description ?? null,
        status: task.status?.status ?? null,
        statusColor: task.status?.color ?? null,
        statusType: task.status?.type ?? null,
        orderIndex: task.orderindex != null ? Number(task.orderindex) : null,
        dateCreated: task.date_created ?? null,
        dateUpdated: task.date_updated ?? null,
        dateDone: task.date_done ?? null,
        dueDate: task.due_date ?? null,
        startDate: task.start_date ?? null,
        priority: task.priority?.id != null ? Number(task.priority.id) : null,
        priorityName: task.priority?.priority ?? null,
        timeEstimate: task.time_estimate ?? null,
        timeSpent: task.time_spent ?? null,
        creator: task.creator ?? null,
        assignees: task.assignees ?? null,
        watchers: task.watchers ?? null,
        tags: task.tags ?? null,
        customFields: task.custom_fields ?? null,
        url: task.url ?? null,
        archived: !!task.archived,
        syncedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: clickupTasks.id,
        set: {
          name: task.name ?? "",
          status: task.status?.status ?? null,
          statusColor: task.status?.color ?? null,
          statusType: task.status?.type ?? null,
          priority: task.priority?.id != null ? Number(task.priority.id) : null,
          priorityName: task.priority?.priority ?? null,
          dueDate: task.due_date ?? null,
          assignees: task.assignees ?? null,
          timeSpent: task.time_spent ?? null,
          dateUpdated: task.date_updated ?? null,
          archived: !!task.archived,
          syncedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  });
}

/**
 * clickup_subtree_refresh — targeted mirror refresh after template-based creation.
 *
 * Payload: { kind: "list" | "folder" | "space", id: string, workspaceId: string,
 *             spaceId?: string, userId: string }
 *
 * This handler refreshes only the specified sub-tree, which is much cheaper than
 * a full workspace backfill.  It is enqueued automatically after every
 * create-from-template API call so that template-created objects appear in the
 * mirror without waiting for the next scheduled full sync (important for async
 * return_immediately=true cases where webhooks may lag large template expansions).
 */
export async function handleClickUpSubtreeRefresh(job: WorkQueueJob): Promise<void> {
  const payload = (job.payload ?? {}) as {
    kind?: string;
    id?: string;
    workspaceId?: string;
    spaceId?: string;
    userId?: string;
  };
  const { kind, id, workspaceId, userId } = payload;

  if (!kind || !id || !workspaceId || !userId) {
    workerLog({
      event: "no_op",
      worker: "clickup_subtree_refresh",
      detail: "missing required payload fields",
    });
    return;
  }

  const token = await getAccessToken(userId);
  if (!token) {
    workerLog({ event: "no_op", worker: "clickup_subtree_refresh", detail: "user not connected" });
    return;
  }

  workerLog({ event: "backfill_started", worker: "clickup_subtree_refresh", kind, id } as any);

  let listsRefreshed = 0;
  let tasksRefreshed = 0;
  let foldersRefreshed = 0;

  if (kind === "list") {
    const tasks = await fetchAllTasksForList(token, id);
    for (const task of tasks) {
      const spaceId = payload.spaceId ?? "";
      const folderId: string | null = null;
      await upsertTask(task, workspaceId, spaceId, folderId, id);
      tasksRefreshed++;
    }
  } else if (kind === "folder") {
    const spaceId = payload.spaceId ?? "";
    const lists = await cu.getListsInFolder(token, id).catch(() => []);
    for (const list of lists) {
      await upsertList(list, spaceId, id);
      listsRefreshed++;
      const tasks = await fetchAllTasksForList(token, String(list.id));
      for (const task of tasks) {
        await upsertTask(task, workspaceId, spaceId, id, String(list.id));
        tasksRefreshed++;
      }
    }
  } else if (kind === "space") {
    const [folders, spaceLists] = await Promise.all([
      cu.getFolders(token, id).catch(() => []),
      cu.getListsInSpace(token, id).catch(() => []),
    ]);

    for (const folder of folders) {
      await withDbAttribution("clickup:subtreeRefresh:upsertFolder", async () => {
        const db = getDb();
        await db
          .insert(clickupFolders)
          .values({
            id: String(folder.id),
            spaceId: id,
            name: folder.name ?? "",
            orderIndex: folder.orderindex ?? null,
            override_statuses: folder.override_statuses ?? null,
            hidden: !!folder.hidden,
            archived: !!folder.archived,
            syncedAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: clickupFolders.id,
            set: {
              name: folder.name ?? "",
              hidden: !!folder.hidden,
              archived: !!folder.archived,
              syncedAt: new Date(),
              updatedAt: new Date(),
            },
          });
      });
      foldersRefreshed++;

      const folderLists = await cu.getListsInFolder(token, String(folder.id)).catch(() => []);
      for (const list of folderLists) {
        await upsertList(list, id, String(folder.id));
        listsRefreshed++;
        const tasks = await fetchAllTasksForList(token, String(list.id));
        for (const task of tasks) {
          await upsertTask(task, workspaceId, id, String(folder.id), String(list.id));
          tasksRefreshed++;
        }
      }
    }

    for (const list of spaceLists) {
      await upsertList(list, id, null);
      listsRefreshed++;
      const tasks = await fetchAllTasksForList(token, String(list.id));
      for (const task of tasks) {
        await upsertTask(task, workspaceId, id, null, String(list.id));
        tasksRefreshed++;
      }
    }
  }

  workerLog({
    event: "backfill_completed",
    worker: "clickup_subtree_refresh",
    kind,
    id,
    foldersRefreshed,
    listsRefreshed,
    tasksRefreshed,
  } as any);
}

export async function handleClickUpTaskApply(job: WorkQueueJob): Promise<void> {
  const payload = (job.payload ?? {}) as { taskId?: string; event?: string; userId?: string };
  const { taskId } = payload;
  if (!taskId) {
    workerLog({ event: "no_op", worker: "clickup_task_apply", detail: "missing taskId" });
    return;
  }

  const existingRow = await withDbAttribution("clickup:taskApply:read", async () => {
    const db = getDb();
    const [r] = await db
      .select({ listId: clickupTasks.listId, spaceId: clickupTasks.spaceId, workspaceId: clickupTasks.workspaceId })
      .from(clickupTasks)
      .where(eq(clickupTasks.id, taskId))
      .limit(1);
    return r;
  });

  const userId = payload.userId;
  if (!userId) {
    workerLog({ event: "no_op", worker: "clickup_task_apply", detail: "no userId in payload" });
    return;
  }

  const token = await getAccessToken(userId);
  if (!token) {
    workerLog({ event: "no_op", worker: "clickup_task_apply", detail: "user not connected" });
    return;
  }

  const task = await cu.getTask(token, taskId).catch(() => null);
  if (!task) {
    workerLog({ event: "no_op", worker: "clickup_task_apply", detail: "task not found in ClickUp", taskId });
    return;
  }

  const listId = task.list?.id ? String(task.list.id) : existingRow?.listId ?? "";
  const spaceId = task.space?.id ? String(task.space.id) : existingRow?.spaceId ?? "";
  const wsId = task.team_id ? String(task.team_id) : existingRow?.workspaceId ?? "";

  await upsertTask(task, wsId, spaceId, task.folder?.id ? String(task.folder.id) : null, listId);

  void tryCompleteSdTicketMapping(task, listId);

  workerLog({ event: "job_completed", worker: "clickup_task_apply", taskId });
}

// ─── Service-desk post-apply mapping ─────────────────────────────────────────
// After a task is mirrored from ClickUp, check if it belongs to the bound
// service-desk list and, if so, idempotently populate sd_ticket_mapping with
// the requester user ID resolved from the requester email custom field.
// Only fills NULL fields — never overwrites values set by manual admin edits.

export async function tryCompleteSdTicketMapping(task: any, resolvedListId: string): Promise<void> {
  try {
    const config = await withDbAttribution("clickup:taskApply:sdConfig", async () => {
      const db = getDb();
      const [row] = await db
        .select({
          clickupListId: sdListMapping.clickupListId,
          clickupWorkspaceId: sdListMapping.clickupWorkspaceId,
          fieldRequesterId: sdListMapping.fieldRequesterId,
          fieldClientId: sdListMapping.fieldClientId,
          fieldDepartmentId: sdListMapping.fieldDepartmentId,
          departmentOptionIds: sdListMapping.departmentOptionIds,
          fieldRequestTypeId: sdListMapping.fieldRequestTypeId,
          requestTypeOptionIds: sdListMapping.requestTypeOptionIds,
          clientOptionIds: sdListMapping.clientOptionIds,
        })
        .from(sdListMapping)
        .limit(1);
      return row ?? null;
    });

    if (!config || !config.clickupListId || config.clickupListId !== resolvedListId) return;

    const cfs: Array<{ id: string; value: any }> = Array.isArray(task.custom_fields)
      ? task.custom_fields
      : Array.isArray(task.customFields)
        ? task.customFields
        : [];

    function cfValue(fieldId: string | null | undefined): any {
      if (!fieldId) return null;
      return cfs.find((f) => f.id === fieldId)?.value ?? null;
    }

    function extractOptionId(fieldId: string | null | undefined): string | null {
      const v = cfValue(fieldId);
      if (v === null || v === undefined) return null;
      if (typeof v === "string") return v;
      if (typeof v === "object" && v !== null && typeof v.id === "string") return v.id;
      if (Array.isArray(v) && v.length > 0) {
        const first = v[0];
        if (typeof first === "string") return first;
        if (typeof first === "object" && first !== null && typeof first.id === "string") return first.id;
      }
      return null;
    }

    const requesterRaw = cfValue(config.fieldRequesterId);
    const requesterEmail = typeof requesterRaw === "string" ? requesterRaw.trim().toLowerCase() : null;

    let requesterUserId: string | null = null;
    if (requesterEmail && requesterEmail.includes("@")) {
      const userRow = await withDbAttribution("clickup:taskApply:sdResolveRequester", async () => {
        const db = getDb();
        const [u] = await db
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(trim(${users.email})) = ${requesterEmail}`)
          .limit(1);
        return u ?? null;
      });
      requesterUserId = userRow?.id ?? null;
    }

    const deptOptionId = extractOptionId(config.fieldDepartmentId);
    const deptOptMap = (config.departmentOptionIds ?? {}) as Record<string, string>;
    const resolvedDeptId = (deptOptionId && deptOptMap[deptOptionId]) || null;

    // Client resolution: option UUID first, then firm-name text fallback.
    // 1. Option UUID path: extractOptionId(Client field) → look up in clientOptionIds map → clients.id.
    // 2. Text fallback: use raw field value as firm name → case-insensitive match against clients.firmName.
    // Resolution failure is a gap surfaced at read-time via resolveTickets; never auto-creates a client record.
    const clientOptMap = (config.clientOptionIds ?? {}) as Record<string, string>;
    const clientOptionId = extractOptionId(config.fieldClientId);
    let resolvedClientStringId: string | null =
      (clientOptionId ? (clientOptMap[clientOptionId] ?? null) : null) ?? null;
    let clientResolutionPath: "option_uuid" | "text_fallback" | null = resolvedClientStringId ? "option_uuid" : null;

    // Text fallback when option UUID lookup failed (text field OR unmapped dropdown option)
    if (!resolvedClientStringId && config.fieldClientId) {
      const clientFieldRaw = cfValue(config.fieldClientId);
      let clientFieldText: string | null = null;
      if (typeof clientFieldRaw === "string") {
        clientFieldText = clientFieldRaw.trim() || null;
      } else if (clientFieldRaw && typeof clientFieldRaw === "object" && typeof (clientFieldRaw as any).name === "string") {
        clientFieldText = ((clientFieldRaw as any).name as string).trim() || null;
      } else if (Array.isArray(clientFieldRaw) && clientFieldRaw.length > 0) {
        const first = clientFieldRaw[0];
        if (typeof first === "string") clientFieldText = first.trim() || null;
        else if (first && typeof first === "object" && typeof (first as any).name === "string") clientFieldText = ((first as any).name as string).trim() || null;
      }
      if (clientFieldText) {
        const lowerText = clientFieldText.toLowerCase();
        const matchedClient = await withDbAttribution("clickup:taskApply:sdClientTextFallback", async () => {
          const db = getDb();
          const [c] = await db
            .select({ id: clients.id })
            .from(clients)
            .where(sql`lower(trim(${clients.firmName})) = ${lowerText}`)
            .limit(1);
          return c ?? null;
        });
        if (matchedClient) {
          resolvedClientStringId = matchedClient.id;
          clientResolutionPath = "text_fallback";
        }
      }
    }

    // Log the final client resolution outcome once (only when the Client field is configured
    // and the task actually carried a client value worth resolving).
    if (config.fieldClientId && (clientOptionId || resolvedClientStringId)) {
      if (resolvedClientStringId) {
        workerLog({ event: "sd_client_option_resolved", worker: "clickup_task_apply", taskId: task.id, resolvedClientStringId, detail: clientResolutionPath ?? "option_uuid" });
      } else {
        workerLog({ event: "sd_client_option_unresolved", worker: "clickup_task_apply", taskId: task.id, clientOptionId, detail: "no match by option UUID or firm name — sync needed or option not mapped" });
      }
    }

    await withDbAttribution("clickup:taskApply:sdTicketUpsert", async () => {
      const db = getDb();
      await db
        .insert(sdTicketMapping)
        .values({
          clickupTaskId: task.id,
          requesterUserId,
          departmentId: resolvedDeptId,
        })
        .onConflictDoUpdate({
          target: sdTicketMapping.clickupTaskId,
          set: {
            requesterUserId: sql`CASE WHEN ${sdTicketMapping.requesterUserId} IS NULL THEN EXCLUDED.requester_user_id ELSE ${sdTicketMapping.requesterUserId} END`,
            departmentId: sql`CASE WHEN ${sdTicketMapping.departmentId} IS NULL THEN EXCLUDED.department_id ELSE ${sdTicketMapping.departmentId} END`,
            updatedAt: new Date(),
          },
        });
    });

    // ── Template enforcement ──────────────────────────────────────────────────
    // Resolve the request type for this ticket from the ClickUp option UUID.
    // Then apply checklist steps (once) and post a needs-info comment (once)
    // for tickets not submitted via the native NoBull form.
    try {
      const mappingRow = await withDbAttribution("clickup:taskApply:sdMappingRead", async () => {
        const db = getDb();
        const [row] = await db
          .select({
            templateChecklistApplied: sdTicketMapping.templateChecklistApplied,
            createdViaNobull: sdTicketMapping.createdViaNobull,
            needsInfoNotified: sdTicketMapping.needsInfoNotified,
            clientUuid: sdTicketMapping.clientUuid,
            departmentId: sdTicketMapping.departmentId,
          })
          .from(sdTicketMapping)
          .where(eq(sdTicketMapping.clickupTaskId, task.id))
          .limit(1);
        return row ?? null;
      });

      if (mappingRow && config.fieldRequestTypeId && config.requestTypeOptionIds) {
        // Resolve the request type from the ClickUp option UUID on this task
        const rtOptUuid = (() => {
          const v = cfs.find((f) => f.id === config.fieldRequestTypeId)?.value;
          if (!v) return null;
          if (typeof v === "string") return v;
          if (typeof v === "object" && v !== null && typeof (v as any).id === "string") return (v as any).id;
          if (Array.isArray(v) && v.length > 0) {
            const first = v[0];
            if (typeof first === "string") return first;
            if (typeof first === "object" && first !== null && typeof (first as any).id === "string") return (first as any).id;
          }
          return null;
        })();

        const rtOptMap = config.requestTypeOptionIds as Record<string, string>;
        const rtLabel = rtOptUuid ? (rtOptMap[rtOptUuid] ?? null) : null;

        // Find the NoBull request type row by name
        const rtRow = rtLabel
          ? await withDbAttribution("clickup:taskApply:sdResolveRt", async () => {
              const db = getDb();
              const [r] = await db
                .select({ id: sdRequestTypes.id, name: sdRequestTypes.name })
                .from(sdRequestTypes)
                .where(sql`lower(trim(${sdRequestTypes.name})) = ${rtLabel.trim().toLowerCase()}`)
                .limit(1);
              return r ?? null;
            })
          : null;

        if (rtRow) {
          // Find a connected ClickUp token for API calls (use any connected user)
          const templateTokenUserId = await withDbAttribution("clickup:taskApply:sdTemplateToken", async () => {
            const db = getDb();
            const res = await db.execute(
              sql`SELECT user_id FROM clickup_user_tokens WHERE status = 'connected' LIMIT 1`,
            );
            const firstRow = (res.rows ?? [])[0] as any;
            return firstRow?.user_id ?? null;
          });
          const templateToken = templateTokenUserId ? await getAccessToken(templateTokenUserId) : null;

          // Apply checklist steps if not yet applied
          if (!mappingRow.templateChecklistApplied && templateToken) {
            const steps = await withDbAttribution("clickup:taskApply:sdLoadSteps", async () => {
              const db = getDb();
              return db
                .select({
                  name: sdRequestTypeChecklistSteps.name,
                  assigneeUserId: sdRequestTypeChecklistSteps.assigneeUserId,
                  assigneeRole: sdRequestTypeChecklistSteps.assigneeRole,
                  assigneeDepartmentId: sdRequestTypeChecklistSteps.assigneeDepartmentId,
                })
                .from(sdRequestTypeChecklistSteps)
                .where(eq(sdRequestTypeChecklistSteps.requestTypeId, rtRow.id))
                .orderBy(sdRequestTypeChecklistSteps.sortOrder);
            });

            if (steps.length > 0) {
              try {
                // Resolve per-step assignees (fixed user or dynamic role) —
                // Task #3656. Failure NEVER blocks the apply; steps fall back
                // to unassigned (log-and-skip).
                let stepAssignees: Array<number | null> = steps.map(() => null);
                try {
                  const resolved = await resolveChecklistStepAssignees(steps, {
                    clientId: resolvedClientStringId ?? mappingRow.clientUuid ?? null,
                    departmentId: resolvedDeptId ?? mappingRow.departmentId ?? null,
                    workspaceId: config.clickupWorkspaceId ?? null,
                  });
                  stepAssignees = resolved.assignees;
                  for (const w of resolved.warnings) {
                    workerLog({ event: "sd_checklist_assignee_skip", worker: "clickup_task_apply", taskId: task.id, detail: w });
                  }
                } catch (assignErr: any) {
                  workerLog({ event: "sd_checklist_assignee_error", worker: "clickup_task_apply", taskId: task.id, error: assignErr?.message });
                }
                const checklistResp = await cu.createChecklist(
                  templateToken, task.id, `${rtRow.name} Checklist`,
                );
                const checklistId =
                  checklistResp?.checklist?.id ?? checklistResp?.id ?? null;
                if (checklistId) {
                  for (let i = 0; i < steps.length; i++) {
                    const assignee = stepAssignees[i];
                    await cu.createChecklistItem(templateToken, checklistId, {
                      name: steps[i].name,
                      ...(assignee != null ? { assignee } : {}),
                    });
                  }
                }
                await withDbAttribution("clickup:taskApply:sdMarkChecklistApplied", async () => {
                  const db = getDb();
                  await db
                    .update(sdTicketMapping)
                    .set({ templateChecklistApplied: true, updatedAt: new Date() })
                    .where(eq(sdTicketMapping.clickupTaskId, task.id));
                });
                workerLog({ event: "sd_template_checklist_applied", worker: "clickup_task_apply", taskId: task.id, steps: steps.length });
              } catch (checklistErr: any) {
                workerLog({ event: "sd_template_checklist_error", worker: "clickup_task_apply", taskId: task.id, error: checklistErr?.message });
              }
            } else {
              // No steps configured — mark applied so we don't recheck every run
              await withDbAttribution("clickup:taskApply:sdMarkChecklistApplied", async () => {
                const db = getDb();
                await db
                  .update(sdTicketMapping)
                  .set({ templateChecklistApplied: true, updatedAt: new Date() })
                  .where(eq(sdTicketMapping.clickupTaskId, task.id));
              });
            }
          }

          // Post needs-info comment for tickets NOT submitted via NoBull native form
          if (!mappingRow.createdViaNobull && !mappingRow.needsInfoNotified && templateToken) {
            const requiredQs = await withDbAttribution("clickup:taskApply:sdLoadRequiredQs", async () => {
              const db = getDb();
              return db
                .select({ label: sdRequestTypeQuestions.label })
                .from(sdRequestTypeQuestions)
                .where(
                  and(
                    eq(sdRequestTypeQuestions.requestTypeId, rtRow.id),
                    eq(sdRequestTypeQuestions.required, true),
                  ),
                )
                .orderBy(sdRequestTypeQuestions.sortOrder);
            });

            if (requiredQs.length > 0) {
              const qList = requiredQs.map((q, i) => `${i + 1}. ${q.label}`).join("\n");
              const commentText =
                `[NoBull] This ticket was submitted outside the NoBull portal. Please provide the following required information:\n\n${qList}`;
              // Transition status to "needs information" then post the comment
              try {
                await cu.updateTask(templateToken, task.id, { status: "needs information" });
              } catch (statusErr: any) {
                workerLog({ event: "sd_needs_info_comment_error", worker: "clickup_task_apply", taskId: task.id, error: `status transition failed: ${statusErr?.message}` });
              }
              try {
                await cu.createTaskComment(templateToken, task.id, { comment_text: commentText });
              } catch (commentErr: any) {
                workerLog({ event: "sd_needs_info_comment_error", worker: "clickup_task_apply", taskId: task.id, error: commentErr?.message });
              }
              await withDbAttribution("clickup:taskApply:sdMarkNeedsInfoNotified", async () => {
                const db = getDb();
                await db
                  .update(sdTicketMapping)
                  .set({ needsInfoNotified: true, updatedAt: new Date() })
                  .where(eq(sdTicketMapping.clickupTaskId, task.id));
              });
              workerLog({ event: "sd_needs_info_notified", worker: "clickup_task_apply", taskId: task.id });
            }
          }
        }
      }
    } catch (templateErr: any) {
      workerLog({ event: "sd_template_enforcement_error", worker: "clickup_task_apply", taskId: task.id, error: templateErr?.message });
    }
    // ── End template enforcement ──────────────────────────────────────────────

    const needsMapping = !requesterUserId;
    workerLog({
      event: "sd_ticket_mapping_applied",
      worker: "clickup_task_apply",
      taskId: task.id,
      needsMapping,
      requesterResolved: !!requesterUserId,
      deptResolved: !!resolvedDeptId,
    });
  } catch (err: any) {
    workerLog({
      event: "sd_ticket_mapping_error",
      worker: "clickup_task_apply",
      taskId: task.id,
      error: err?.message,
    });
  }
}

// ─── Task #2984: Reconciliation sweep + webhook health handlers ───────────────

/**
 * Walks all connected workspaces, checks syncedAt staleness, and enqueues
 * a clickup_hierarchy_backfill for any workspace that has not synced within
 * the configured threshold (default 24h). Writes a status summary to
 * system_settings for admin visibility.
 */
export async function handleClickUpReconciliationSweep(job: WorkQueueJob): Promise<void> {
  const payload = (job.payload ?? {}) as { staleThresholdMs?: number };
  const staleThresholdMs = payload.staleThresholdMs ?? 24 * 60 * 60 * 1000;

  const connectedUsers = await withDbAttribution("clickup:reconciliation:getConnected", async () => {
    const db = getDb();
    const result = await db.execute(
      `SELECT user_id, workspace_id FROM clickup_user_tokens WHERE status = 'connected' AND workspace_id IS NOT NULL` as any,
    );
    return (result.rows ?? []) as Array<{ user_id: string; workspace_id: string }>;
  });

  if (!connectedUsers.length) {
    workerLog({ event: "no_op", worker: "clickup_reconciliation_sweep", detail: "no connected users" });
    return;
  }

  let backfillsEnqueued = 0;
  const now = Date.now();

  for (const { user_id: userId, workspace_id: workspaceId } of connectedUsers) {
    const staleRow = await withDbAttribution("clickup:reconciliation:checkStaleness", async () => {
      const db = getDb();
      const [row] = await db
        .select({ maxSyncedAt: sql<string>`MAX(${clickupSpaces.syncedAt})` })
        .from(clickupSpaces)
        .where(eq(clickupSpaces.workspaceId, workspaceId));
      return row;
    });

    const maxSyncedAt = staleRow?.maxSyncedAt ? new Date(staleRow.maxSyncedAt).getTime() : 0;
    const isStale = !maxSyncedAt || now - maxSyncedAt > staleThresholdMs;

    if (isStale) {
      const hasPending = await withDbAttribution("clickup:reconciliation:checkPending", async () => {
        const db = getDb();
        const [row] = await db
          .select({ id: workQueue.id })
          .from(workQueue)
          .where(
            sql`${workQueue.queueName} = 'clickup_hierarchy_backfill'
                AND (${workQueue.payload}->>'workspaceId') = ${workspaceId}
                AND ${workQueue.status} IN ('pending', 'leased', 'processing')`,
          )
          .limit(1);
        return !!row;
      });

      if (!hasPending) {
        await withDbAttribution("clickup:reconciliation:enqueue", async () => {
          const db = getDb();
          await db.insert(workQueue).values({
            queueName: "clickup_hierarchy_backfill",
            jobType: "clickup_hierarchy_backfill",
            workloadClass: "reporting",
            priority: 100,
            status: "pending",
            payload: { workspaceId, userId },
          } as any);
        });
        backfillsEnqueued++;
        workerLog({ event: "backfill_enqueued", worker: "clickup_reconciliation_sweep", workspaceId });
      }
    }
  }

  void (async () => {
    try {
      const { setSystemSetting } = await import("../storage/settingsStorage");
      await setSystemSetting(
        "clickup_reconciliation_sweep_status",
        JSON.stringify({
          lastRunAt: new Date().toISOString(),
          workspacesChecked: connectedUsers.length,
          backfillsEnqueued,
        }),
        "system",
      );
    } catch {
      /* best-effort */
    }
  })();

  workerLog({
    event: "sweep_completed",
    worker: "clickup_reconciliation_sweep",
    workspacesChecked: connectedUsers.length,
    backfillsEnqueued,
  });
}

/**
 * Polls the live health of every registered ClickUp webhook via the API,
 * updates the stored health field, and enqueues clickup_webhook_repair for
 * any webhook with excessive fail_count or not found in ClickUp. Fires a
 * once-per-streak admin alert when degraded webhooks are found.
 */
export async function handleClickUpWebhookHealthCheck(job: WorkQueueJob): Promise<void> {
  const allWebhooks = await withDbAttribution("clickup:webhookHealth:list", async () => {
    const db = getDb();
    return db.select().from(clickupWebhooks).where(eq(clickupWebhooks.status, "active"));
  });

  if (!allWebhooks.length) {
    workerLog({ event: "no_op", worker: "clickup_webhook_health_check", detail: "no active webhooks" });
    return;
  }

  let degradedCount = 0;

  for (const webhook of allWebhooks) {
    const token = await getAccessToken(webhook.userId);
    if (!token) {
      workerLog({ event: "skip", worker: "clickup_webhook_health_check", webhookId: webhook.id, detail: "no user token" });
      continue;
    }

    let liveWebhooks: any[] = [];
    try {
      liveWebhooks = await cu.getWebhooks(token, webhook.workspaceId);
    } catch (err: any) {
      workerLog({ event: "fetch_error", worker: "clickup_webhook_health_check", webhookId: webhook.id, error: err?.message });
      continue;
    }

    const liveHook = liveWebhooks.find((w: any) => String(w.id) === String(webhook.id));
    const liveHealth = liveHook?.health ?? null;
    // fail_count of 999 signals the webhook was not found in ClickUp at all
    const failCount = liveHook ? (liveHealth?.fail_count ?? 0) : 999;
    const isHealthy = liveHook && failCount < 5;

    await withDbAttribution("clickup:webhookHealth:update", async () => {
      const db = getDb();
      await db
        .update(clickupWebhooks)
        .set({ health: liveHealth ?? { status: "unknown" }, updatedAt: new Date() })
        .where(eq(clickupWebhooks.id, webhook.id));
    });

    if (!isHealthy) {
      degradedCount++;
      workerLog({ event: "degraded", worker: "clickup_webhook_health_check", webhookId: webhook.id, failCount });

      const hasPendingRepair = await withDbAttribution("clickup:webhookHealth:checkRepairPending", async () => {
        const db = getDb();
        const [row] = await db
          .select({ id: workQueue.id })
          .from(workQueue)
          .where(
            sql`${workQueue.queueName} = 'clickup_webhook_repair'
                AND (${workQueue.payload}->>'webhookId') = ${webhook.id}
                AND ${workQueue.status} IN ('pending', 'leased', 'processing')`,
          )
          .limit(1);
        return !!row;
      });

      if (!hasPendingRepair) {
        await withDbAttribution("clickup:webhookHealth:enqueueRepair", async () => {
          const db = getDb();
          await db.insert(workQueue).values({
            queueName: "clickup_webhook_repair",
            jobType: "clickup_webhook_repair",
            workloadClass: "reporting",
            priority: 50,
            status: "pending",
            payload: {
              webhookId: webhook.id,
              workspaceId: webhook.workspaceId,
              userId: webhook.userId,
              endpoint: webhook.endpoint,
              events: webhook.events,
              locationId: webhook.locationId,
            },
          } as any);
        });
      }
    }
  }

  if (degradedCount > 0) {
    void (async () => {
      try {
        const { notifyByType } = await import("./notifications/dispatcher");
        await notifyByType(
          "integration.clickup.webhook_health_degraded",
          {
            text:
              `*${degradedCount} ClickUp webhook(s) degraded or missing.* ` +
              `Repair jobs have been enqueued automatically. ` +
              `Check Settings → Integrations → ClickUp to review.`,
          },
          {
            triggerSource: "alert_service",
            dedupeKey: "clickup.webhook_health_degraded",
          },
        );
      } catch {
        /* best-effort */
      }
    })();
  }

  workerLog({
    event: "health_check_completed",
    worker: "clickup_webhook_health_check",
    webhooksChecked: allWebhooks.length,
    degradedCount,
  });
}

/**
 * Deletes a degraded ClickUp webhook and recreates it with the same config.
 * Payload: { webhookId, workspaceId, userId, endpoint, events, locationId? }
 */
export async function handleClickUpWebhookRepair(job: WorkQueueJob): Promise<void> {
  const payload = (job.payload ?? {}) as {
    webhookId?: string;
    workspaceId?: string;
    userId?: string;
    endpoint?: string;
    events?: any;
    locationId?: string | null;
  };
  const { webhookId, workspaceId, userId, endpoint } = payload;
  if (!webhookId || !workspaceId || !userId || !endpoint) {
    workerLog({ event: "no_op", worker: "clickup_webhook_repair", detail: "missing required payload fields" });
    return;
  }

  const token = await getAccessToken(userId);
  if (!token) {
    workerLog({ event: "no_op", worker: "clickup_webhook_repair", webhookId, detail: "no user token" });
    return;
  }

  await withDbAttribution("clickup:webhookRepair:markRepairing", async () => {
    const db = getDb();
    await db
      .update(clickupWebhooks)
      .set({ status: "repairing", updatedAt: new Date() })
      .where(eq(clickupWebhooks.id, webhookId));
  });

  try {
    await cu.deleteWebhook(token, webhookId);
  } catch (err: any) {
    // It may already be gone from ClickUp — continue to re-create
    workerLog({ event: "delete_failed", worker: "clickup_webhook_repair", webhookId, detail: err?.message });
  }

  let newHook: any;
  try {
    const events = Array.isArray(payload.events) ? (payload.events as string[]) : ["*"];
    newHook = await cu.createWebhook(token, workspaceId, endpoint, events, payload.locationId ?? undefined);
  } catch (err: any) {
    workerLog({ event: "create_failed", worker: "clickup_webhook_repair", webhookId, error: err?.message });
    await withDbAttribution("clickup:webhookRepair:markFailed", async () => {
      const db = getDb();
      await db
        .update(clickupWebhooks)
        .set({ status: "repair_failed", updatedAt: new Date() })
        .where(eq(clickupWebhooks.id, webhookId));
    });
    return;
  }

  const newId = String(newHook.id ?? newHook.webhook?.id ?? webhookId);
  const newSecret = (newHook.webhook?.secret ?? newHook.secret ?? null) as string | null;

  await withDbAttribution("clickup:webhookRepair:replaceRow", async () => {
    const db = getDb();
    await db.delete(clickupWebhooks).where(eq(clickupWebhooks.id, webhookId));
    await db.insert(clickupWebhooks).values({
      id: newId,
      workspaceId,
      userId,
      endpoint,
      events: Array.isArray(payload.events) ? payload.events : ["*"],
      locationId: payload.locationId ?? null,
      secret: newSecret,
      health: { status: "active", fail_count: 0 },
      status: "active",
      updatedAt: new Date(),
    });
  });

  workerLog({ event: "repair_completed", worker: "clickup_webhook_repair", oldWebhookId: webhookId, newWebhookId: newId });
}

// ─── Task #3059: Service Desk overdue sweep + delivered auto-close ─────────────

const SD_TERMINAL_STATUSES = new Set([
  "closed", "canceled", "duplicate", "out of scope", "out_of_scope",
]);

/**
 * Walks all open service desk tickets with a committed date in the past and
 * fires one notifyUser notification per day to owner + requester using a
 * day-scoped dedupeKey.
 */
export async function handleSdOverdueSweep(_job: WorkQueueJob): Promise<void> {
  const config = await withDbAttribution("sd:overdueSweep:getConfig", async () => {
    const db = getDb();
    const [row] = await db.select().from(sdListMapping).limit(1);
    return row ?? null;
  });
  if (!config?.clickupListId) {
    workerLog({ event: "sd_config_missing", worker: "sd_overdue_sweep" });
    return;
  }

  const rows = await withDbAttribution("sd:overdueSweep:listTickets", async () => {
    const db = getDb();
    return db
      .select({
        taskId: clickupTasks.id,
        name: clickupTasks.name,
        status: clickupTasks.status,
        customFields: clickupTasks.customFields,
        ownerUserId: sdTicketMapping.ownerUserId,
        requesterUserId: sdTicketMapping.requesterUserId,
      })
      .from(clickupTasks)
      .leftJoin(sdTicketMapping, eq(sdTicketMapping.clickupTaskId, clickupTasks.id))
      .where(eq(clickupTasks.listId, config.clickupListId!));
  });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const todayStr = todayStart.toISOString().slice(0, 10);
  const fieldId = config.fieldCommittedDateId;

  const { notifyUser } = await import("./notifications/userInbox");
  let notified = 0;

  for (const row of rows) {
    const status = (row.status ?? "").toLowerCase().trim();
    if (SD_TERMINAL_STATUSES.has(status)) continue;

    const cfs: any[] = Array.isArray(row.customFields) ? (row.customFields as any[]) : [];
    const cf = fieldId ? cfs.find((c: any) => c.id === fieldId) : null;
    const committedMs = cf?.value ? Number(cf.value) : null;
    if (!committedMs || isNaN(committedMs)) continue;

    // Day-based overdue notifications only fire once the committed DATE is in
    // the past.
    const isDayOverdue = committedMs < todayMs;

    const dedupeBase = `sd_overdue_${row.taskId}_${todayStr}`;
    const notifyPromises: Promise<any>[] = [];

    if (isDayOverdue && row.ownerUserId) {
      notifyPromises.push(
        notifyUser(row.ownerUserId, {
          category: "service_desk",
          title: "Ticket overdue",
          body: `"${row.name}" has passed its committed date.`,
          deepLink: `/admin/service-desk/tickets/${row.taskId}`,
          dedupeKey: `${dedupeBase}_owner`,
          metadata: { taskId: row.taskId, event: "overdue" },
        }).catch(() => null),
      );
    }
    if (isDayOverdue && row.requesterUserId && row.requesterUserId !== row.ownerUserId) {
      notifyPromises.push(
        notifyUser(row.requesterUserId, {
          category: "service_desk",
          title: "Your request is overdue",
          body: `"${row.name}" has passed its committed date.`,
          deepLink: `/admin/service-desk/tickets/${row.taskId}`,
          dedupeKey: `${dedupeBase}_requester`,
          metadata: { taskId: row.taskId, event: "overdue" },
        }).catch(() => null),
      );
    }
    if (notifyPromises.length > 0) {
      await Promise.all(notifyPromises);
      notified++;
      workerLog({ event: "sd_ticket_overdue_notified", worker: "sd_overdue_sweep", taskId: row.taskId });
    }

  }

  workerLog({ event: "sd_overdue_sweep_completed", worker: "sd_overdue_sweep", overdueNotified: notified, totalChecked: rows.length });
}

/**
 * Finds tickets in "delivered" status whose dateUpdated is older than
 * sd_delivered_review_period_days (default 3). Transitions each to "closed"
 * in ClickUp + local mirror, records an event, and notifies the requester.
 */
export async function handleSdDeliveredAutoclose(_job: WorkQueueJob): Promise<void> {
  const config = await withDbAttribution("sd:autoclose:getConfig", async () => {
    const db = getDb();
    const [row] = await db.select().from(sdListMapping).limit(1);
    return row ?? null;
  });
  if (!config?.clickupListId) {
    workerLog({ event: "sd_config_missing", worker: "sd_delivered_autoclose" });
    return;
  }

  const { getSystemSetting } = await import("../storage/settingsStorage");
  let reviewDays = 3;
  try {
    const s = await getSystemSetting("sd_delivered_review_period_days");
    const n = s?.value ? parseInt(s.value, 10) : NaN;
    if (Number.isFinite(n) && n > 0) reviewDays = n;
  } catch { /* use default */ }

  const cutoffMs = Date.now() - reviewDays * 24 * 60 * 60 * 1000;

  const rows = await withDbAttribution("sd:autoclose:listDelivered", async () => {
    const db = getDb();
    return db
      .select({
        taskId: clickupTasks.id,
        name: clickupTasks.name,
        ownerUserId: sdTicketMapping.ownerUserId,
        requesterUserId: sdTicketMapping.requesterUserId,
      })
      .from(clickupTasks)
      .leftJoin(sdTicketMapping, eq(sdTicketMapping.clickupTaskId, clickupTasks.id))
      .where(
        and(
          eq(clickupTasks.listId, config.clickupListId!),
          sql`lower(trim(${clickupTasks.status})) = 'delivered'`,
          sql`COALESCE(NULLIF(${clickupTasks.dateUpdated}, '')::bigint, 0) < ${cutoffMs}`,
        ),
      );
  });

  if (!rows.length) {
    workerLog({ event: "sd_autoclose_completed", worker: "sd_delivered_autoclose", autoclosed: 0 });
    return;
  }

  // Find a connected ClickUp token to use for the API call
  const tokenUserId = await withDbAttribution("sd:autoclose:getToken", async () => {
    const db = getDb();
    const res = await db.execute(
      sql`SELECT user_id FROM clickup_user_tokens WHERE status = 'connected' LIMIT 1`,
    );
    const firstRow = (res.rows ?? [])[0] as any;
    return firstRow?.user_id ?? null;
  });

  const token = tokenUserId ? await getAccessToken(tokenUserId) : null;
  const { notifyUser } = await import("./notifications/userInbox");
  let autoclosed = 0;

  for (const row of rows) {
    try {
      if (token) {
        await cu.updateTask(token, row.taskId, { status: "closed" });
        await cu.createTaskComment(token, row.taskId, {
          comment_text: `[NoBull] Auto-closed after ${reviewDays}-day review period.`,
        }).catch(() => {});
      }

      await withDbAttribution("sd:autoclose:updateMirror", async () => {
        const db = getDb();
        await db
          .update(clickupTasks)
          .set({ status: "closed", dateUpdated: String(Date.now()), updatedAt: new Date() })
          .where(eq(clickupTasks.id, row.taskId));
      });

      await withDbAttribution("sd:autoclose:recordEvent", async () => {
        const db = getDb();
        await db.insert(sdTicketEvents).values({
          clickupTaskId: row.taskId,
          eventType: "status_transition",
          actorUserId: null,
          data: { fromStatus: "delivered", toStatus: "closed", reason: "auto_close_review_period", reviewDays },
        } as any);
      });

      if (row.requesterUserId) {
        await notifyUser(row.requesterUserId, {
          category: "service_desk",
          title: "Request closed",
          body: `"${row.name}" was automatically closed after the ${reviewDays}-day review period.`,
          deepLink: `/admin/service-desk/tickets/${row.taskId}`,
          dedupeKey: `sd_autoclose_${row.taskId}`,
          metadata: { taskId: row.taskId, event: "auto_closed" },
        }).catch(() => null);
      }

      autoclosed++;
      workerLog({ event: "sd_ticket_autoclosed", worker: "sd_delivered_autoclose", taskId: row.taskId });
    } catch (err: any) {
      workerLog({ event: "sd_ticket_autoclose_skipped", worker: "sd_delivered_autoclose", taskId: row.taskId, error: err?.message });
    }
  }

  workerLog({ event: "sd_autoclose_completed", worker: "sd_delivered_autoclose", autoclosed, totalChecked: rows.length });
}
