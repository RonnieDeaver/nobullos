// @db-pool-intent: api
/**
 * Service Desk routes — ticket workflow actions.
 * Extracted verbatim from server/routes/serviceDesk.ts (Task #3787 split);
 * sections: Status transition, Reassign, Change department, Committed date, Confirm complete, Reopen, Mark duplicate.
 * Mounted by registerServiceDeskRoutes in ../serviceDesk.ts — route order
 * is preserved by the aggregator's call sequence.
 */

import type { Express } from "express";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { getDb, withDbAttribution } from "../../db";
import { sdDepartments, sdTicketMapping, clickupTasks } from "@shared/schema";
import { notifyUser } from "../../services/notifications/userInbox";
import { alertServiceDeskWaitingFieldsMissing, alertServiceDeskConfigFieldsMissing } from "../../services/serviceDeskConfigAlert";
import { users } from "@shared/models/auth";
import { eq } from "drizzle-orm";
import { getAccessToken } from "../../services/clickUpIntegration";
import { resolveClickUpIdentity } from "../../services/sdRoleResolution";
import * as cu from "../../services/clickUpClient";
import { getListMappingConfig, resolveTickets, isRequesterOrPrivileged } from "./helpers";
import { TRANSITIONS, REQUIRES_WAITING_ON, STATUS, updateMirrorStatus, recordEvent } from "./workflowShared";

export function registerServiceDeskTicketActionRoutes(app: Express): void {
  // ─── Status transition ─────────────────────────────────────────────────────
  // Guards:
  //   - REQUIRES_WAITING_ON statuses: body must include waitingWho, waitingWhat, waitingWhen
  //   - DUPLICATE: body must include linkedTaskId
  //
  // Writes to ClickUp then updates the local mirror.
  // System comment is posted to ClickUp for full audit trail.

  app.post("/api/service-desk/tickets/:taskId/transition", isAuthenticated, async (req: any, res) => {
    try {
      const { taskId } = req.params;
      const actorUserId: string = req.user?.claims?.sub ?? req.user?.id ?? "";
      const { toStatus, waitingWho, waitingWhat, waitingWhen, linkedTaskId, reason } = req.body as {
        toStatus: string;
        waitingWho?: string;
        waitingWhat?: string;
        waitingWhen?: string;
        linkedTaskId?: string;
        reason?: string;
      };

      if (!toStatus) return res.status(400).json({ error: "toStatus is required" });

      const config = await getListMappingConfig();
      if (!config?.clickupListId) return res.status(409).json({ error: "Service desk not configured" });

      const token = await getAccessToken(actorUserId);
      if (!token) return res.status(403).json({ error: "ClickUp not connected for your account", requiresClickUpConnection: true });

      // Read current status from mirror
      const [taskRow] = await withDbAttribution("serviceDesk:transition:read", async () => {
        const db = getDb();
        return db.select({ status: clickupTasks.status }).from(clickupTasks).where(eq(clickupTasks.id, taskId)).limit(1);
      });
      const fromStatus = (taskRow?.status ?? "").toLowerCase().trim();
      const toNorm = toStatus.toLowerCase().trim();

      // Guard: validate transition is allowed
      const allowed = TRANSITIONS[fromStatus] ?? [];
      if (!allowed.includes(toNorm)) {
        return res.status(422).json({
          error: `Transition from "${fromStatus}" to "${toNorm}" is not allowed`,
          allowed,
        });
      }

      // Guard: waiting-on metadata required
      if (REQUIRES_WAITING_ON.has(toNorm)) {
        if (!waitingWho?.trim() || !waitingWhat?.trim() || !waitingWhen?.trim()) {
          return res.status(422).json({
            error: `Transitioning to "${toNorm}" requires waitingWho, waitingWhat, and waitingWhen`,
            requiresWaitingOn: true,
          });
        }
      }

      // Guard: duplicate requires linked task
      if (toNorm === STATUS.DUPLICATE && !linkedTaskId) {
        return res.status(422).json({
          error: "Marking as Duplicate requires linkedTaskId (the original ticket)",
          requiresLinkedTask: true,
        });
      }

      // Write waiting-on custom fields when entering a waiting/blocked status
      if (REQUIRES_WAITING_ON.has(toNorm)) {
        const missingFieldIds: string[] = [];
        if (!config.fieldWaitingWhoId) missingFieldIds.push("fieldWaitingWhoId");
        if (!config.fieldWaitingWhatId) missingFieldIds.push("fieldWaitingWhatId");
        if (!config.fieldWaitingWhenId) missingFieldIds.push("fieldWaitingWhenId");
        if (missingFieldIds.length > 0) {
          console.warn(
            `[ServiceDesk] waiting-on transition to "${toNorm}" for task ${taskId}: ` +
            `custom-field UUID(s) missing from sd_list_mapping config (${missingFieldIds.join(", ")}) — ` +
            `waiting-on metadata will NOT be written to ClickUp`,
          );
          // Task #3175 — surface the misconfiguration to admins in-app
          // (fire-and-forget; rate-limited once per list per day in-module).
          void alertServiceDeskWaitingFieldsMissing(
            config.clickupListId,
            missingFieldIds,
            { taskId, toStatus: toNorm },
          );
        }
        const fieldWrites: Array<Promise<void>> = [];
        if (config.fieldWaitingWhoId && waitingWho) {
          fieldWrites.push(
            cu.setCustomFieldValue(token, taskId, config.fieldWaitingWhoId, waitingWho)
              .catch((e: any) => { console.warn("[ServiceDesk] waiting-who field write failed:", e.message); }),
          );
        }
        if (config.fieldWaitingWhatId && waitingWhat) {
          fieldWrites.push(
            cu.setCustomFieldValue(token, taskId, config.fieldWaitingWhatId, waitingWhat)
              .catch((e: any) => { console.warn("[ServiceDesk] waiting-what field write failed:", e.message); }),
          );
        }
        if (config.fieldWaitingWhenId && waitingWhen) {
          fieldWrites.push(
            cu.setCustomFieldValue(token, taskId, config.fieldWaitingWhenId, waitingWhen)
              .catch((e: any) => { console.warn("[ServiceDesk] waiting-when field write failed:", e.message); }),
          );
        }
        await Promise.all(fieldWrites);
      }

      // For duplicate: add task link before transition — propagate error; link is required
      if (toNorm === STATUS.DUPLICATE && linkedTaskId) {
        await cu.addTaskLink(token, taskId, linkedTaskId);
      }

      // Update status in ClickUp
      await cu.updateTask(token, taskId, { status: toNorm });

      // Post system comment
      const label = toNorm.replace(/\b\w/g, (c) => c.toUpperCase());
      let commentParts: string[] = [`[NoBull] Status → ${label}`];
      if (REQUIRES_WAITING_ON.has(toNorm)) {
        commentParts.push(`Waiting on: ${waitingWho}`);
        commentParts.push(`Action needed: ${waitingWhat}`);
        commentParts.push(`Response by: ${waitingWhen}`);
      }
      if (reason) commentParts.push(`Reason: ${reason}`);
      if (toNorm === STATUS.DUPLICATE && linkedTaskId) {
        commentParts.push(`Duplicate of: ${linkedTaskId}`);
      }
      await cu.createTaskComment(token, taskId, { comment_text: commentParts.join("\n") }).catch(() => {});

      // Mirror update
      await updateMirrorStatus(taskId, toNorm);

      // Record event
      await recordEvent(taskId, "status_transition", actorUserId, {
        fromStatus,
        toStatus: toNorm,
        waitingWho: waitingWho ?? null,
        waitingWhat: waitingWhat ?? null,
        waitingWhen: waitingWhen ?? null,
        linkedTaskId: linkedTaskId ?? null,
        reason: reason ?? null,
      });

      const [ticket] = await resolveTickets(config, [taskId]);

      // Notify on key transitions (§17): delivered → notify requester; waiting on client → notify requester.
      // Task #3080: also notify the ticket owner (assignee) on any status change they didn't make.
      if (ticket) {
        const toNormLow = toNorm.toLowerCase();
        if (ticket.ownerUserId && ticket.ownerUserId !== actorUserId) {
          const fromLabel = fromStatus ? fromStatus.replace(/\b\w/g, (c) => c.toUpperCase()) : "—";
          const toLabel = toNorm.replace(/\b\w/g, (c) => c.toUpperCase());
          void notifyUser(ticket.ownerUserId, {
            category: "service_desk",
            title: "Ticket status updated",
            body: `"${ticket.name}" moved from ${fromLabel} to ${toLabel}.`,
            deepLink: `/admin/service-desk/tickets/${taskId}`,
            dedupeKey: `sd_status_owner_${taskId}_${toNorm}_${Date.now()}`,
            metadata: { taskId, event: "status_changed", fromStatus, toStatus: toNorm },
          }).catch(() => {});
        }
        if (toNormLow === "delivered" && ticket.requesterUserId) {
          void notifyUser(ticket.requesterUserId, {
            category: "service_desk",
            title: "Request ready for review",
            body: `"${ticket.name}" has been delivered. Please review and confirm or reopen.`,
            deepLink: `/admin/service-desk/tickets/${taskId}`,
            dedupeKey: `sd_delivered_${taskId}`,
            metadata: { taskId, event: "delivered" },
          }).catch(() => {});
        } else if (toNormLow === "waiting on client" && ticket.requesterUserId) {
          void notifyUser(ticket.requesterUserId, {
            category: "service_desk",
            title: "Action needed on your request",
            body: `"${ticket.name}" is waiting on your response.`,
            deepLink: `/admin/service-desk/tickets/${taskId}`,
            dedupeKey: `sd_waiting_client_${taskId}_${Date.now()}`,
            metadata: { taskId, event: "waiting_on_client" },
          }).catch(() => {});
        }
      }

      res.json({ ticket });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Reassign (new owner, same department) ─────────────────────────────────

  app.post("/api/service-desk/tickets/:taskId/reassign", isAuthenticated, async (req: any, res) => {
    try {
      const { taskId } = req.params;
      const actorUserId: string = req.user?.claims?.sub ?? req.user?.id ?? "";
      const { newOwnerUserId, reason } = req.body as { newOwnerUserId: string; reason?: string };

      if (!newOwnerUserId) return res.status(400).json({ error: "newOwnerUserId is required" });

      const config = await getListMappingConfig();
      if (!config?.clickupListId) return res.status(409).json({ error: "Service desk not configured" });

      const token = await getAccessToken(actorUserId);
      if (!token) return res.status(403).json({ error: "ClickUp not connected for your account", requiresClickUpConnection: true });

      // Get current mapping to find old owner
      const [mapping] = await withDbAttribution("serviceDesk:reassign:readMapping", async () => {
        const db = getDb();
        return db.select().from(sdTicketMapping).where(eq(sdTicketMapping.clickupTaskId, taskId)).limit(1);
      });

      const newOwnerIdentity = await resolveClickUpIdentity({
        userId: newOwnerUserId,
        departmentId: mapping?.departmentId ?? null,
        requireActiveDepartmentMembership: false,
        allowDurableMemberFallback: !!mapping?.departmentId,
      }, config.clickupWorkspaceId ?? null);

      // Get new owner name for comment
      const [newOwnerUser] = await withDbAttribution("serviceDesk:reassign:getNewOwnerUser", async () => {
        const db = getDb();
        return db
          .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
          .from(users)
          .where(eq(users.id, newOwnerUserId))
          .limit(1);
      });
      const newOwnerName = newOwnerUser
        ? [newOwnerUser.firstName, newOwnerUser.lastName].filter(Boolean).join(" ") || newOwnerUser.email || newOwnerUserId
        : newOwnerUserId;

      // The selected owner needs a projection-ready identity. The credential
      // used for the write is the actor's; the owner's personal OAuth may be
      // disconnected when a verified department-member identity exists.
      if (!newOwnerIdentity.ready || !newOwnerIdentity.externalUserId) {
        return res.status(422).json({
          error: "The selected team member does not have ClickUp connected and cannot be assigned as ticket owner",
        });
      }

      // Build assignee delta for ClickUp
      const assigneeUpdate: { add: string[]; rem: string[] } = { add: [], rem: [] };
      assigneeUpdate.add.push(String(newOwnerIdentity.externalUserId));

      // Get current task assignees to remove old ones
      const [taskRow] = await withDbAttribution("serviceDesk:reassign:readTask", async () => {
        const db = getDb();
        return db.select({ assignees: clickupTasks.assignees }).from(clickupTasks).where(eq(clickupTasks.id, taskId)).limit(1);
      });
      const existingAssignees: any[] = Array.isArray(taskRow?.assignees) ? (taskRow.assignees as any[]) : [];
      existingAssignees.forEach((a: any) => {
        const id = String(a.id ?? a.userId ?? "");
        if (id && id !== String(newOwnerIdentity.externalUserId)) {
          assigneeUpdate.rem.push(id);
        }
      });

      if (assigneeUpdate.add.length > 0 || assigneeUpdate.rem.length > 0) {
        await cu.updateTask(token, taskId, { assignees: assigneeUpdate });
      }

      // Post system comment
      const commentLines = [`[NoBull] Reassigned to ${newOwnerName}`];
      if (reason) commentLines.push(`Reason: ${reason}`);
      await cu.createTaskComment(token, taskId, { comment_text: commentLines.join("\n") }).catch(() => {});

      // Update sd_ticket_mapping
      await withDbAttribution("serviceDesk:reassign:updateMapping", async () => {
        const db = getDb();
        await db
          .insert(sdTicketMapping)
          .values({ clickupTaskId: taskId, ownerUserId: newOwnerUserId, updatedAt: new Date() } as any)
          .onConflictDoUpdate({
            target: sdTicketMapping.clickupTaskId,
            set: { ownerUserId: newOwnerUserId, updatedAt: new Date() },
          });
      });

      // Record event
      await recordEvent(taskId, "reassignment", actorUserId, {
        fromOwnerUserId: mapping?.ownerUserId ?? null,
        toOwnerUserId: newOwnerUserId,
        reason: reason ?? null,
      });

      const [ticket] = await resolveTickets(config, [taskId]);

      // Notify new owner of assignment (§17).
      if (newOwnerUserId && ticket) {
        void notifyUser(newOwnerUserId, {
          category: "service_desk",
          title: "Ticket assigned to you",
          body: `"${ticket.name}" has been assigned to you.`,
          deepLink: `/admin/service-desk/tickets/${taskId}`,
          dedupeKey: `sd_assigned_${taskId}_${newOwnerUserId}`,
          metadata: { taskId, event: "reassigned" },
        }).catch(() => {});
        // Notify requester of the change.
        if (ticket.requesterUserId && ticket.requesterUserId !== newOwnerUserId) {
          void notifyUser(ticket.requesterUserId, {
            category: "service_desk",
            title: "Your request was reassigned",
            body: `"${ticket.name}" has been reassigned to a new team member.`,
            deepLink: `/admin/service-desk/tickets/${taskId}`,
            dedupeKey: `sd_reassigned_requester_${taskId}_${Date.now()}`,
            metadata: { taskId, event: "reassigned" },
          }).catch(() => {});
        }
      }

      res.json({ ticket });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Change department (field edit + owner re-pick) ────────────────────────

  app.post("/api/service-desk/tickets/:taskId/change-department", isAuthenticated, async (req: any, res) => {
    try {
      const { taskId } = req.params;
      const actorUserId: string = req.user?.claims?.sub ?? req.user?.id ?? "";
      const { newDepartmentId, newOwnerUserId, reason } = req.body as {
        newDepartmentId: string;
        newOwnerUserId?: string;
        reason?: string;
      };

      if (!newDepartmentId) return res.status(400).json({ error: "newDepartmentId is required" });

      const config = await getListMappingConfig();
      if (!config?.clickupListId) return res.status(409).json({ error: "Service desk not configured" });

      const token = await getAccessToken(actorUserId);
      if (!token) return res.status(403).json({ error: "ClickUp not connected for your account", requiresClickUpConnection: true });

      const newOwnerIdentity = newOwnerUserId
        ? await resolveClickUpIdentity(
            {
              userId: newOwnerUserId,
              departmentId: newDepartmentId,
              requireActiveDepartmentMembership: false,
            },
            config.clickupWorkspaceId ?? null,
          )
        : null;
      if (newOwnerIdentity && (!newOwnerIdentity.ready || !newOwnerIdentity.externalUserId)) {
        return res.status(422).json({
          error: "The selected team member does not have ClickUp connected and cannot be assigned as ticket owner",
        });
      }

      // Find the ClickUp option UUID for this department from the option ID map
      const deptOptMap = (config.departmentOptionIds ?? {}) as Record<string, string>;
      const optionUuid = Object.entries(deptOptMap).find(([, nbId]) => nbId === newDepartmentId)?.[0] ?? null;

      // Update the department custom field in ClickUp
      if (optionUuid && config.fieldDepartmentId) {
        await cu.setCustomFieldValue(token, taskId, config.fieldDepartmentId, optionUuid).catch(() => {});
      } else {
        // Task #3227 — config gap means the department change is NOT written
        // to ClickUp. Surface it to admins instead of dropping it silently.
        const missingKeys: string[] = [];
        if (!config.fieldDepartmentId) missingKeys.push("fieldDepartmentId");
        if (!optionUuid) missingKeys.push(`departmentOptionIds[${newDepartmentId}]`);
        console.warn(
          `[ServiceDesk] change-department for task ${taskId}: sd_list_mapping config missing ` +
          `(${missingKeys.join(", ")}) — department will NOT be written to ClickUp`,
        );
        void alertServiceDeskConfigFieldsMissing(config.clickupListId, missingKeys, {
          taskId,
          action: "change department",
        });
      }

      // Reassign if a new owner is provided
      if (newOwnerUserId && newOwnerIdentity?.externalUserId) {
        const assigneeUpdate: { add: string[]; rem: string[] } = { add: [], rem: [] };
        assigneeUpdate.add.push(String(newOwnerIdentity.externalUserId));

        const [taskRow] = await withDbAttribution("serviceDesk:changeDept:readTask", async () => {
          const db = getDb();
          return db.select({ assignees: clickupTasks.assignees }).from(clickupTasks).where(eq(clickupTasks.id, taskId)).limit(1);
        });
        const existingAssignees: any[] = Array.isArray(taskRow?.assignees) ? (taskRow.assignees as any[]) : [];
        existingAssignees.forEach((a: any) => {
          const id = String(a.id ?? a.userId ?? "");
          if (id && id !== String(newOwnerIdentity.externalUserId)) assigneeUpdate.rem.push(id);
        });

        if (assigneeUpdate.add.length > 0 || assigneeUpdate.rem.length > 0) {
          await cu.updateTask(token, taskId, { assignees: assigneeUpdate });
        }
      }

      // Get department name for comment
      const [dept] = await withDbAttribution("serviceDesk:changeDept:readDept", async () => {
        const db = getDb();
        return db.select({ name: sdDepartments.name }).from(sdDepartments).where(eq(sdDepartments.id, newDepartmentId)).limit(1);
      });

      const commentLines = [`[NoBull] Department changed to ${dept?.name ?? newDepartmentId}`];
      if (reason) commentLines.push(`Reason: ${reason}`);
      await cu.createTaskComment(token, taskId, { comment_text: commentLines.join("\n") }).catch(() => {});

      // Update sd_ticket_mapping
      await withDbAttribution("serviceDesk:changeDept:updateMapping", async () => {
        const db = getDb();
        const set: Record<string, any> = { departmentId: newDepartmentId, updatedAt: new Date() };
        if (newOwnerUserId) set.ownerUserId = newOwnerUserId;
        await db
          .insert(sdTicketMapping)
          .values({ clickupTaskId: taskId, ...set } as any)
          .onConflictDoUpdate({ target: sdTicketMapping.clickupTaskId, set });
      });

      await recordEvent(taskId, "department_change", actorUserId, {
        newDepartmentId,
        newOwnerUserId: newOwnerUserId ?? null,
        reason: reason ?? null,
      });

      const [ticket] = await resolveTickets(config, [taskId]);
      res.json({ ticket });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Set / change committed date ───────────────────────────────────────────
  // Moving the date later requires a reason (spec §9).
  // Date value is stored as epoch-ms string in ClickUp custom field.

  app.post("/api/service-desk/tickets/:taskId/committed-date", isAuthenticated, async (req: any, res) => {
    try {
      const { taskId } = req.params;
      const actorUserId: string = req.user?.claims?.sub ?? req.user?.id ?? "";
      const { committedDate, reason } = req.body as { committedDate: string; reason?: string };

      if (!committedDate) return res.status(400).json({ error: "committedDate is required (ISO string or epoch-ms)" });

      const config = await getListMappingConfig();
      if (!config?.clickupListId) return res.status(409).json({ error: "Service desk not configured" });
      if (!config.fieldCommittedDateId) {
        return res.status(409).json({ error: "Committed date custom field not configured" });
      }

      const token = await getAccessToken(actorUserId);
      if (!token) return res.status(403).json({ error: "ClickUp not connected for your account", requiresClickUpConnection: true });

      // Resolve the new date to epoch-ms
      const newDateMs = isNaN(Number(committedDate)) ? new Date(committedDate).getTime() : Number(committedDate);
      if (isNaN(newDateMs)) return res.status(400).json({ error: "committedDate is not a valid date" });

      // Read current committed date from mirror
      const [taskRow] = await withDbAttribution("serviceDesk:committedDate:read", async () => {
        const db = getDb();
        return db.select({ customFields: clickupTasks.customFields }).from(clickupTasks).where(eq(clickupTasks.id, taskId)).limit(1);
      });

      const cfs: any[] = Array.isArray(taskRow?.customFields) ? (taskRow.customFields as any[]) : [];
      const existingCf = cfs.find((cf: any) => cf.id === config.fieldCommittedDateId);
      const existingMs: number | null = existingCf?.value ? Number(existingCf.value) : null;

      // Guard: moving later requires reason
      const isMovingLater = existingMs !== null && newDateMs > existingMs;
      if (isMovingLater && !reason?.trim()) {
        return res.status(422).json({
          error: "Moving the committed date to a later date requires a reason",
          requiresReason: true,
        });
      }

      // Write to ClickUp
      await cu.setCustomFieldValue(token, taskId, config.fieldCommittedDateId, String(newDateMs));

      // Post system comment
      const dateStr = new Date(newDateMs).toLocaleDateString();
      const commentLines = [`[NoBull] Committed date set to ${dateStr}`];
      if (isMovingLater) commentLines.push(`Reason for extension: ${reason}`);
      await cu.createTaskComment(token, taskId, { comment_text: commentLines.join("\n") }).catch(() => {});

      // Mirror: update the custom_fields jsonb to reflect the new value
      await withDbAttribution("serviceDesk:committedDate:mirror", async () => {
        const db = getDb();
        const updated = cfs.map((cf: any) =>
          cf.id === config.fieldCommittedDateId ? { ...cf, value: String(newDateMs) } : cf,
        );
        if (!updated.some((cf: any) => cf.id === config.fieldCommittedDateId)) {
          updated.push({ id: config.fieldCommittedDateId, value: String(newDateMs) });
        }
        await db.update(clickupTasks).set({ customFields: updated, updatedAt: new Date() }).where(eq(clickupTasks.id, taskId));
      });

      await recordEvent(taskId, "committed_date_change", actorUserId, {
        previousMs: existingMs,
        newMs: newDateMs,
        isMovingLater,
        reason: reason ?? null,
      });

      const [ticket] = await resolveTickets(config, [taskId]);

      // Notify owner + requester of committed-date change (§17).
      if (ticket) {
        const notifyTargets: string[] = [];
        if (ticket.ownerUserId && ticket.ownerUserId !== actorUserId) notifyTargets.push(ticket.ownerUserId);
        if (ticket.requesterUserId && ticket.requesterUserId !== actorUserId && !notifyTargets.includes(ticket.requesterUserId)) {
          notifyTargets.push(ticket.requesterUserId);
        }
        for (const uid of notifyTargets) {
          void notifyUser(uid, {
            category: "service_desk",
            title: "Committed date updated",
            body: `The committed date on "${ticket.name}" has been updated.`,
            deepLink: `/admin/service-desk/tickets/${taskId}`,
            dedupeKey: `sd_committed_date_${taskId}_${newDateMs}`,
            metadata: { taskId, event: "committed_date_change" },
          }).catch(() => {});
        }
      }

      res.json({ ticket });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Confirm complete (requester confirms delivery → close) ────────────────

  app.post("/api/service-desk/tickets/:taskId/confirm-complete", isAuthenticated, async (req: any, res) => {
    try {
      const { taskId } = req.params;
      const actorUserId: string = req.user?.claims?.sub ?? req.user?.id ?? "";

      const config = await getListMappingConfig();
      if (!config?.clickupListId) return res.status(409).json({ error: "Service desk not configured" });

      const token = await getAccessToken(actorUserId);
      if (!token) return res.status(403).json({ error: "ClickUp not connected for your account", requiresClickUpConnection: true });

      // Auth: only the ticket requester, CEO, or team lead may confirm completion
      const authorized = await isRequesterOrPrivileged(actorUserId, taskId);
      if (!authorized) {
        return res.status(403).json({ error: "Only the ticket requester, CEO, or team lead can confirm completion" });
      }

      // Guard: must be in Delivered status
      const [taskRow] = await withDbAttribution("serviceDesk:confirm:read", async () => {
        const db = getDb();
        return db.select({ status: clickupTasks.status }).from(clickupTasks).where(eq(clickupTasks.id, taskId)).limit(1);
      });
      const currentStatus = (taskRow?.status ?? "").toLowerCase().trim();
      if (currentStatus !== STATUS.DELIVERED) {
        return res.status(422).json({ error: `Confirm Complete is only available when status is "delivered" (current: "${currentStatus}")` });
      }

      await cu.updateTask(token, taskId, { status: STATUS.CLOSED });
      await cu.createTaskComment(token, taskId, { comment_text: "[NoBull] Requester confirmed complete. Ticket closed." }).catch(() => {});
      await updateMirrorStatus(taskId, STATUS.CLOSED);
      await recordEvent(taskId, "confirm_complete", actorUserId, { fromStatus: STATUS.DELIVERED });

      const [ticket] = await resolveTickets(config, [taskId]);

      // Task #3080: notify the owner (assignee) that the requester confirmed and the ticket closed.
      if (ticket?.ownerUserId && ticket.ownerUserId !== actorUserId) {
        void notifyUser(ticket.ownerUserId, {
          category: "service_desk",
          title: "Ticket confirmed complete",
          body: `"${ticket.name}" was confirmed complete by the requester and is now closed.`,
          deepLink: `/admin/service-desk/tickets/${taskId}`,
          dedupeKey: `sd_confirmed_${taskId}`,
          metadata: { taskId, event: "confirm_complete" },
        }).catch(() => {});
      }

      res.json({ ticket });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Reopen (requester believes DoD not satisfied) ─────────────────────────

  app.post("/api/service-desk/tickets/:taskId/reopen", isAuthenticated, async (req: any, res) => {
    try {
      const { taskId } = req.params;
      const actorUserId: string = req.user?.claims?.sub ?? req.user?.id ?? "";
      const { explanation } = req.body as { explanation: string };

      if (!explanation?.trim()) {
        return res.status(422).json({ error: "Reopening requires an explanation of what remains incomplete", requiresExplanation: true });
      }

      const config = await getListMappingConfig();
      if (!config?.clickupListId) return res.status(409).json({ error: "Service desk not configured" });

      const token = await getAccessToken(actorUserId);
      if (!token) return res.status(403).json({ error: "ClickUp not connected for your account", requiresClickUpConnection: true });

      // Auth: only the ticket requester, CEO, or team lead may reopen
      const authorizedReopen = await isRequesterOrPrivileged(actorUserId, taskId);
      if (!authorizedReopen) {
        return res.status(403).json({ error: "Only the ticket requester, CEO, or team lead can reopen a ticket" });
      }

      const [taskRow] = await withDbAttribution("serviceDesk:reopen:read", async () => {
        const db = getDb();
        return db.select({ status: clickupTasks.status }).from(clickupTasks).where(eq(clickupTasks.id, taskId)).limit(1);
      });
      const currentStatus = (taskRow?.status ?? "").toLowerCase().trim();
      const allowedFrom: string[] = [STATUS.DELIVERED, STATUS.CLOSED];
      if (!allowedFrom.includes(currentStatus)) {
        return res.status(422).json({ error: `Reopen is only available from "delivered" or "closed" (current: "${currentStatus}")` });
      }

      await cu.updateTask(token, taskId, { status: STATUS.REOPENED });
      await cu.createTaskComment(token, taskId, {
        comment_text: `[NoBull] Ticket reopened.\nWhat remains incomplete: ${explanation}`,
      }).catch(() => {});
      await updateMirrorStatus(taskId, STATUS.REOPENED);
      await recordEvent(taskId, "reopen", actorUserId, { fromStatus: currentStatus, explanation });

      const [ticket] = await resolveTickets(config, [taskId]);

      // Notify current owner that ticket was reopened (§17).
      const ownerUserId = ticket?.ownerUserId;
      if (ownerUserId && ownerUserId !== actorUserId) {
        void notifyUser(ownerUserId, {
          category: "service_desk",
          title: "Ticket reopened",
          body: `"${ticket?.name}" has been reopened. ${explanation}`,
          deepLink: `/admin/service-desk/tickets/${taskId}`,
          dedupeKey: `sd_reopen_${taskId}_${Date.now()}`,
          metadata: { taskId, event: "reopened" },
        }).catch(() => {});
      }

      res.json({ ticket });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Mark duplicate (requires linked task ID, then closes) ────────────────

  app.post("/api/service-desk/tickets/:taskId/mark-duplicate", isAuthenticated, async (req: any, res) => {
    try {
      const { taskId } = req.params;
      const actorUserId: string = req.user?.claims?.sub ?? req.user?.id ?? "";
      const { linkedTaskId } = req.body as { linkedTaskId: string };

      if (!linkedTaskId?.trim()) {
        return res.status(422).json({ error: "linkedTaskId (the original ticket) is required", requiresLinkedTask: true });
      }

      const config = await getListMappingConfig();
      if (!config?.clickupListId) return res.status(409).json({ error: "Service desk not configured" });

      const token = await getAccessToken(actorUserId);
      if (!token) return res.status(403).json({ error: "ClickUp not connected for your account", requiresClickUpConnection: true });

      // Link required — propagate error if ClickUp rejects the link
      await cu.addTaskLink(token, taskId, linkedTaskId);
      await cu.updateTask(token, taskId, { status: STATUS.DUPLICATE });
      await cu.createTaskComment(token, taskId, {
        comment_text: `[NoBull] Marked as Duplicate of ${linkedTaskId}. Ticket closed.`,
      }).catch(() => {});
      await updateMirrorStatus(taskId, STATUS.DUPLICATE);
      await recordEvent(taskId, "mark_duplicate", actorUserId, { linkedTaskId });

      const [ticket] = await resolveTickets(config, [taskId]);

      // Task #3080: notify owner (assignee) on this status change if they didn't make it.
      if (ticket?.ownerUserId && ticket.ownerUserId !== actorUserId) {
        void notifyUser(ticket.ownerUserId, {
          category: "service_desk",
          title: "Ticket status updated",
          body: `"${ticket.name}" was marked as a duplicate of ${linkedTaskId} and closed.`,
          deepLink: `/admin/service-desk/tickets/${taskId}`,
          dedupeKey: `sd_status_owner_${taskId}_duplicate_${Date.now()}`,
          metadata: { taskId, event: "status_changed", toStatus: STATUS.DUPLICATE },
        }).catch(() => {});
      }

      res.json({ ticket });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

}
