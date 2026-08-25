// @db-pool-intent: api
/**
 * Service Desk routes — request-type templates & native submission.
 * Extracted verbatim from server/routes/serviceDesk.ts (Task #3787 split);
 * sections: Template questions, Template checklist steps, Native ticket submission.
 * Mounted by registerServiceDeskRoutes in ../serviceDesk.ts — route order
 * is preserved by the aggregator's call sequence.
 */

import type { Express } from "express";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireCeo } from "../middleware";
import { getDb, withDbAttribution } from "../../db";
import {
  sdDepartments,
  sdRequestTypes,
  sdListMapping,
  sdTicketMapping,
  sdTicketEvents,
  sdRequestTypeQuestions,
  sdRequestTypeChecklistSteps,
  clickupTasks,
  clickupUserTokens,
} from "@shared/schema";
import multer from "multer";
import { notifyUser } from "../../services/notifications/userInbox";
import { users } from "@shared/models/auth";
import { eq, and, asc } from "drizzle-orm";
import { getAccessToken } from "../../services/clickUpIntegration";
import * as cu from "../../services/clickUpClient";
import { resolveChecklistStepAssignees } from "../../services/sdChecklistAssignees";
import {
  resolveClickUpIdentity,
  resolveSubmitAutoAssign,
} from "../../services/sdRoleResolution";
import { SD_VALID_QUESTION_TYPES, SD_OPTION_QUESTION_TYPES, validateStepAssignee, getListMappingConfig } from "./helpers";

export function registerServiceDeskTemplateRoutes(app: Express): void {
  // ─── Request type template questions (Task #3373) ──────────────────────────

  app.get("/api/service-desk/request-types/:id/questions", isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const questions = await withDbAttribution("serviceDesk:questions:list", async () => {
        const db = getDb();
        return db
          .select()
          .from(sdRequestTypeQuestions)
          .where(eq(sdRequestTypeQuestions.requestTypeId, id))
          .orderBy(asc(sdRequestTypeQuestions.sortOrder), asc(sdRequestTypeQuestions.createdAt));
      });
      res.json({ questions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/service-desk/request-types/:id/questions", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { label, questionType = "text", required = false, sortOrder = 0, options, helpText, placeholder, defaultValue } = req.body as {
        label: string;
        questionType?: string;
        required?: boolean;
        sortOrder?: number;
        options?: string[];
        helpText?: string | null;
        placeholder?: string | null;
        defaultValue?: string | null;
      };
      if (!label?.trim()) return res.status(400).json({ error: "label is required" });
      if (!SD_VALID_QUESTION_TYPES.includes(questionType)) {
        return res.status(400).json({ error: `questionType must be one of: ${SD_VALID_QUESTION_TYPES.join(", ")}` });
      }
      const [question] = await withDbAttribution("serviceDesk:questions:create", async () => {
        const db = getDb();
        return db
          .insert(sdRequestTypeQuestions)
          .values({
            requestTypeId: id,
            label: label.trim(),
            questionType,
            required: !!required,
            sortOrder,
            options: SD_OPTION_QUESTION_TYPES.includes(questionType) && Array.isArray(options) ? options : null,
            helpText: typeof helpText === "string" && helpText.trim() ? helpText.trim() : null,
            placeholder: typeof placeholder === "string" && placeholder.trim() ? placeholder.trim() : null,
            defaultValue: typeof defaultValue === "string" && defaultValue.trim() ? defaultValue.trim() : null,
          })
          .returning();
      });
      res.json({ question });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/service-desk/request-types/:id/questions/:qid", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const { qid } = req.params;
      const { label, questionType, required, sortOrder, options, helpText, placeholder, defaultValue } = req.body as {
        label?: string;
        questionType?: string;
        required?: boolean;
        sortOrder?: number;
        options?: string[];
        helpText?: string | null;
        placeholder?: string | null;
        defaultValue?: string | null;
      };
      if (questionType !== undefined && !SD_VALID_QUESTION_TYPES.includes(questionType)) {
        return res.status(400).json({ error: `questionType must be one of: ${SD_VALID_QUESTION_TYPES.join(", ")}` });
      }
      const updates: Record<string, any> = { updatedAt: new Date() };
      if (label !== undefined) updates.label = label.trim();
      if (questionType !== undefined) updates.questionType = questionType;
      if (required !== undefined) updates.required = !!required;
      if (sortOrder !== undefined) updates.sortOrder = sortOrder;
      if (options !== undefined) updates.options = Array.isArray(options) ? options : null;
      if (helpText !== undefined) updates.helpText = typeof helpText === "string" && helpText.trim() ? helpText.trim() : null;
      if (placeholder !== undefined) updates.placeholder = typeof placeholder === "string" && placeholder.trim() ? placeholder.trim() : null;
      if (defaultValue !== undefined) updates.defaultValue = typeof defaultValue === "string" && defaultValue.trim() ? defaultValue.trim() : null;
      const [question] = await withDbAttribution("serviceDesk:questions:update", async () => {
        const db = getDb();
        return db
          .update(sdRequestTypeQuestions)
          .set(updates)
          .where(eq(sdRequestTypeQuestions.id, qid))
          .returning();
      });
      if (!question) return res.status(404).json({ error: "Question not found" });
      res.json({ question });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/service-desk/request-types/:id/questions/:qid", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const { qid } = req.params;
      await withDbAttribution("serviceDesk:questions:delete", async () => {
        const db = getDb();
        return db.delete(sdRequestTypeQuestions).where(eq(sdRequestTypeQuestions.id, qid));
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Request type template checklist steps (Task #3373) ───────────────────

  app.get("/api/service-desk/request-types/:id/checklist-steps", isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const steps = await withDbAttribution("serviceDesk:checklistSteps:list", async () => {
        const db = getDb();
        return db
          .select()
          .from(sdRequestTypeChecklistSteps)
          .where(eq(sdRequestTypeChecklistSteps.requestTypeId, id))
          .orderBy(asc(sdRequestTypeChecklistSteps.sortOrder), asc(sdRequestTypeChecklistSteps.createdAt));
      });
      res.json({ steps });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/service-desk/request-types/:id/checklist-steps", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { name, sortOrder = 0, assigneeUserId, assigneeRole, assigneeDepartmentId } = req.body as {
        name: string;
        sortOrder?: number;
        assigneeUserId?: string | null;
        assigneeRole?: string | null;
        assigneeDepartmentId?: string | null;
      };
      if (!name?.trim()) return res.status(400).json({ error: "name is required" });
      const assigneeErr = validateStepAssignee(assigneeUserId, assigneeRole, assigneeDepartmentId);
      if (assigneeErr) return res.status(400).json({ error: assigneeErr });
      const [step] = await withDbAttribution("serviceDesk:checklistSteps:create", async () => {
        const db = getDb();
        return db
          .insert(sdRequestTypeChecklistSteps)
          .values({
            requestTypeId: id,
            name: name.trim(),
            sortOrder,
            assigneeUserId: assigneeUserId || null,
            assigneeRole: assigneeRole || null,
            assigneeDepartmentId: (assigneeRole && assigneeDepartmentId) || null,
          })
          .returning();
      });
      res.json({ step });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/service-desk/request-types/:id/checklist-steps/:sid", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const { sid } = req.params;
      const { name, sortOrder, assigneeUserId, assigneeRole, assigneeDepartmentId } = req.body as {
        name?: string;
        sortOrder?: number;
        assigneeUserId?: string | null;
        assigneeRole?: string | null;
        assigneeDepartmentId?: string | null;
      };
      if (assigneeUserId !== undefined || assigneeRole !== undefined || assigneeDepartmentId !== undefined) {
        const assigneeErr = validateStepAssignee(assigneeUserId, assigneeRole, assigneeDepartmentId);
        if (assigneeErr) return res.status(400).json({ error: assigneeErr });
      }
      const updates: Record<string, any> = { updatedAt: new Date() };
      if (name !== undefined) updates.name = name.trim();
      if (sortOrder !== undefined) updates.sortOrder = sortOrder;
      if (assigneeUserId !== undefined) updates.assigneeUserId = assigneeUserId || null;
      if (assigneeRole !== undefined) {
        updates.assigneeRole = assigneeRole || null;
        // Clearing the role also clears any department override.
        if (!assigneeRole) updates.assigneeDepartmentId = null;
      }
      if (assigneeDepartmentId !== undefined) updates.assigneeDepartmentId = assigneeDepartmentId || null;
      const [step] = await withDbAttribution("serviceDesk:checklistSteps:update", async () => {
        const db = getDb();
        return db
          .update(sdRequestTypeChecklistSteps)
          .set(updates)
          .where(eq(sdRequestTypeChecklistSteps.id, sid))
          .returning();
      });
      if (!step) return res.status(404).json({ error: "Checklist step not found" });
      res.json({ step });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/service-desk/request-types/:id/checklist-steps/:sid", isAuthenticated, requireCeo, async (req: any, res) => {
    try {
      const { sid } = req.params;
      await withDbAttribution("serviceDesk:checklistSteps:delete", async () => {
        const db = getDb();
        return db.delete(sdRequestTypeChecklistSteps).where(eq(sdRequestTypeChecklistSteps.id, sid));
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Native ticket submission (Task #3373) ─────────────────────────────────
  // POST /api/service-desk/tickets/submit
  // Multipart: fields + optional file attachment.

  const sdSubmitUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

  app.post(
    "/api/service-desk/tickets/submit",
    isAuthenticated,
    sdSubmitUpload.single("file"),
    async (req: any, res) => {
      try {
        const actorUserId: string = req.user?.claims?.sub ?? req.user?.id ?? "";
        const {
          departmentId,
          requestTypeId,
          title,
          description = "",
          priority: priorityStr,
          requestedDate,
          clientId: clientIdStr,
          clientName = "",
        } = req.body as {
          departmentId: string;
          requestTypeId: string;
          title: string;
          description?: string;
          priority?: string;
          requestedDate?: string;
          clientId?: string;
          clientName?: string;
        };

        // Parse answers: JSON array of { questionId, value }
        let answers: Array<{ questionId: string; value: string }> = [];
        try {
          answers = JSON.parse(req.body.answers || "[]");
        } catch { /* ignore parse errors */ }

        // Basic validation
        if (!title?.trim()) return res.status(400).json({ error: "title is required" });
        if (!requestTypeId) return res.status(400).json({ error: "requestTypeId is required" });
        if (!departmentId) return res.status(400).json({ error: "departmentId is required" });

        // Load config
        const config = await getListMappingConfig();
        if (!config?.clickupListId) {
          return res.status(409).json({ error: "Service desk is not configured. Ask an administrator to set it up." });
        }

        // Hard-fail if critical ClickUp field mappings are absent — submitting without them
        // produces a task that can't be routed, searched, or reported on correctly.
        const missingConfig: string[] = [];
        if (!config.fieldDepartmentId) missingConfig.push("Department field (fieldDepartmentId)");
        if (!config.fieldRequestTypeId) missingConfig.push("Request type field (fieldRequestTypeId)");
        if (!config.fieldRequesterId) missingConfig.push("Requester field (fieldRequesterId)");
        if (missingConfig.length > 0) {
          return res.status(409).json({
            error: `Service desk field mappings are not fully configured: ${missingConfig.join("; ")}. Ask an administrator to complete the ClickUp field mapping in Service Desk settings.`,
            missingConfig,
          });
        }

        // Load request type
        const [rtRow] = await withDbAttribution("serviceDesk:submit:getRequestType", async () => {
          const db = getDb();
          return db.select().from(sdRequestTypes).where(eq(sdRequestTypes.id, requestTypeId)).limit(1);
        });
        if (!rtRow) return res.status(400).json({ error: "Invalid requestTypeId" });

        // Load department
        const [deptRow] = await withDbAttribution("serviceDesk:submit:getDept", async () => {
          const db = getDb();
          return db.select().from(sdDepartments).where(eq(sdDepartments.id, departmentId)).limit(1);
        });

        // Load template questions and validate required answers
        const questions = await withDbAttribution("serviceDesk:submit:getQuestions", async () => {
          const db = getDb();
          return db
            .select()
            .from(sdRequestTypeQuestions)
            .where(eq(sdRequestTypeQuestions.requestTypeId, requestTypeId))
            .orderBy(asc(sdRequestTypeQuestions.sortOrder));
        });

        const answersMap = new Map(answers.map((a) => [a.questionId, a.value]));
        const missingRequired = questions
          .filter((q) => q.required)
          .filter((q) => {
            const val = (answersMap.get(q.id) ?? "").trim();
            return !val;
          })
          .map((q) => q.label);
        if (missingRequired.length > 0) {
          return res.status(422).json({
            error: "Required questions are unanswered",
            missingQuestions: missingRequired,
          });
        }

        // Get submitter's email for requester field
        const [actorRow] = await withDbAttribution("serviceDesk:submit:getActorEmail", async () => {
          const db = getDb();
          return db.select({ email: users.email, firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, actorUserId)).limit(1);
        });
        const actorEmail = actorRow?.email ?? "";

        // Resolve ClickUp token: try actor first, fall back to CEO/any-connected user so
        // staff without a personal ClickUp connection can still submit requests.
        const rawActorToken = await getAccessToken(actorUserId);
        let usedFallbackToken = false;

        // Helper to resolve the CEO/any-connected fallback token.
        const resolveFallbackToken = async (): Promise<string | null> => {
          const fallbackUserId = await withDbAttribution("serviceDesk:submit:tokenFallback", async () => {
            const db = getDb();
            const ceoRows = await db
              .select({ userId: clickupUserTokens.userId })
              .from(clickupUserTokens)
              .innerJoin(users, eq(clickupUserTokens.userId, users.id))
              .where(and(eq(clickupUserTokens.status, "connected"), eq(users.role, "ceo" as any)))
              .limit(1);
            if (ceoRows[0]?.userId) return ceoRows[0].userId;
            const anyRows = await db
              .select({ userId: clickupUserTokens.userId })
              .from(clickupUserTokens)
              .where(eq(clickupUserTokens.status, "connected"))
              .limit(1);
            return anyRows[0]?.userId ?? null;
          });
          return fallbackUserId ? getAccessToken(fallbackUserId) : null;
        };

        let token: string;
        if (rawActorToken) {
          token = rawActorToken;
        } else {
          const fallbackToken = await resolveFallbackToken();
          if (!fallbackToken) {
            return res.status(409).json({
              error: "Service desk is not connected to ClickUp. Please ask an administrator to connect ClickUp.",
              requiresClickUpConnection: true,
            });
          }
          token = fallbackToken;
          usedFallbackToken = true;
        }

        // ── Auto-assign resolution (Task #3585; scope + per-role defaults
        // Task #4171) ────────────────────────────────────────────────────────
        // Company-scope departments resolve Doer/Checker from the department-
        // level holders regardless of client; per-client departments use the
        // client's assignment row with per-role fallback to the department
        // defaults. A failure at any step degrades gracefully — it never
        // blocks ticket creation. The Checker (formerly "backup", Task #3618)
        // is added as a ClickUp watcher after creation.
        let autoAssignPrimaryUserId: string | null = null;
        let autoAssignCheckerUserId: string | null = null;
        let autoAssignPrimaryClickupId: string | null = null;
        let autoAssignCheckerClickupId: string | null = null;
        const resolvedClientStringId =
          typeof clientIdStr === "string" && isNaN(Number(clientIdStr)) ? clientIdStr : null;

        try {
          const autoAssign = await resolveSubmitAutoAssign({
            departmentId: departmentId || null,
            clientId: resolvedClientStringId,
            dept: deptRow ?? null,
            workspaceId: config.clickupWorkspaceId ?? null,
          });
          autoAssignPrimaryUserId = autoAssign.primaryUserId;
          autoAssignCheckerUserId = autoAssign.checkerUserId;
          autoAssignPrimaryClickupId = autoAssign.primaryClickupId;
          autoAssignCheckerClickupId = autoAssign.checkerClickupId;
        } catch (autoAssignErr: any) {
          console.warn("[ServiceDesk] auto-assign resolution failed (proceeding unassigned):", autoAssignErr?.message);
        }

        // Resolve the primary owner's display name so the submitter confirmation
        // can show "your request will be handled by [Name]". Non-fatal — null when
        // no coverage or the lookup fails.
        let resolvedOwnerName: string | null = null;
        if (autoAssignPrimaryUserId) {
          try {
            const [ownerRow] = await withDbAttribution("serviceDesk:submit:getOwnerName", async () => {
              const db = getDb();
              return db
                .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
                .from(users)
                .where(eq(users.id, autoAssignPrimaryUserId))
                .limit(1);
            });
            if (ownerRow) {
              const fullName = [ownerRow.firstName, ownerRow.lastName].filter(Boolean).join(" ").trim();
              resolvedOwnerName = fullName || ownerRow.email || null;
            }
          } catch (ownerNameErr: any) {
            console.warn("[ServiceDesk] owner name resolution failed (omitting from response):", ownerNameErr?.message);
          }
        }

        // Build custom fields array for the task
        const taskCustomFields: Array<{ id: string; value: any }> = [];
        const configWarnings: string[] = [];

        // Department field — hard-fail if field is configured but option UUID not found
        if (config.fieldDepartmentId) {
          const deptOptMap = (config.departmentOptionIds ?? {}) as Record<string, string>;
          const deptOptionUuid = Object.entries(deptOptMap).find(([, nid]) => nid === departmentId)?.[0];
          if (deptOptionUuid) {
            taskCustomFields.push({ id: config.fieldDepartmentId, value: deptOptionUuid });
          } else {
            configWarnings.push(`Department field (${config.fieldDepartmentId}) is configured but no option UUID mapping found for department "${deptRow?.name ?? departmentId}". Update the ClickUp field mapping in Service Desk settings.`);
          }
        }

        // Request type field — hard-fail if field is configured but option UUID not found
        if (config.fieldRequestTypeId) {
          const rtOptMap = (config.requestTypeOptionIds ?? {}) as Record<string, string>;
          const rtOptionUuid = Object.entries(rtOptMap).find(([, label]) =>
            label.trim().toLowerCase() === rtRow.name.trim().toLowerCase(),
          )?.[0];
          if (rtOptionUuid) {
            taskCustomFields.push({ id: config.fieldRequestTypeId, value: rtOptionUuid });
          } else {
            configWarnings.push(`Request type field (${config.fieldRequestTypeId}) is configured but no option UUID mapping found for type "${rtRow.name}". Update the ClickUp field mapping in Service Desk settings.`);
          }
        }

        if (configWarnings.length > 0) {
          return res.status(409).json({
            error: "Service desk field mapping is incomplete. " + configWarnings[0],
            configWarnings,
          });
        }

        // Requester field is a ClickUp "users" (People) custom field — it cannot be
        // set to an email string at create time (ClickUp rejects with "Invalid Value").
        // Instead, resolve the submitter's numeric ClickUp user ID and set the field
        // AFTER creation via the documented Set Custom Field endpoint, which accepts
        // { add: [userId], rem: [] } for People fields. Non-fatal if unresolvable —
        // the requester is always captured in the task description as a fallback.
        let requesterClickupUserId: number | null = null;
        try {
          const requesterIdentity = await resolveClickUpIdentity(
            { userId: actorUserId },
            config.clickupWorkspaceId,
          );
          if (
            requesterIdentity.ready &&
            requesterIdentity.externalUserId &&
            !isNaN(Number(requesterIdentity.externalUserId))
          ) {
            requesterClickupUserId = Number(requesterIdentity.externalUserId);
          } else if (actorEmail && config.clickupWorkspaceId) {
            const wsMembers = await cu.getWorkspaceMembers(token, config.clickupWorkspaceId);
            const emailLc = actorEmail.trim().toLowerCase();
            const hit = wsMembers.find(
              (m: any) => String(m?.user?.email ?? "").trim().toLowerCase() === emailLc,
            );
            const hitId = hit?.user?.id;
            if (hitId != null && !isNaN(Number(hitId))) requesterClickupUserId = Number(hitId);
          }
        } catch (reqResolveErr: any) {
          console.warn("[ServiceDesk] requester ClickUp ID resolution failed (will omit People field):", reqResolveErr?.message);
        }

        // Client ID field — set by option UUID if Client is a dropdown, else fall back to text
        // Legacy integer column: UUID client ids parse to NaN → store null
        // (the new client_uuid column, set below, supersedes it — Task #3618).
        const clientIdParsed = clientIdStr ? parseInt(clientIdStr, 10) : NaN;
        const clientId = Number.isFinite(clientIdParsed) ? clientIdParsed : null;
        // clientIdStr may be a NoBull clients.id (UUID string) passed from the form
        const clientStringId = typeof clientIdStr === "string" && isNaN(Number(clientIdStr))
          ? clientIdStr
          : null;
        if (config.fieldClientId) {
          const clientOptMap = (config.clientOptionIds ?? {}) as Record<string, string>;
          const hasClientOptions = Object.keys(clientOptMap).length > 0;
          if (hasClientOptions && clientStringId) {
            // Client dropdown: find the ClickUp option UUID by reverse lookup of NoBull client UUID
            const clientOptionUuid = Object.entries(clientOptMap).find(([, cid]) => cid === clientStringId)?.[0];
            if (clientOptionUuid) {
              taskCustomFields.push({ id: config.fieldClientId, value: clientOptionUuid });
            }
            // No option UUID match: the Client field is a dropdown when an option map
            // exists — sending free text would make ClickUp reject the whole task with
            // "Invalid Value". Omit the field; the client name is in the description.
          } else if (hasClientOptions && !clientStringId && clientName?.trim()) {
            // Unmapped ClickUp option selected (no NoBull clientId): find its option
            // UUID by label so we send a valid dropdown value, else omit.
            const labelMap = (config.clientOptionNames ?? {}) as Record<string, string>;
            const nameLc = clientName.trim().toLowerCase();
            const byLabel = Object.entries(labelMap).find(
              ([, label]) => String(label).trim().toLowerCase() === nameLc,
            )?.[0];
            if (byLabel) taskCustomFields.push({ id: config.fieldClientId, value: byLabel });
          } else if (!hasClientOptions && clientName?.trim()) {
            // Legacy text field path (or no option map yet): set firm name as text value
            taskCustomFields.push({ id: config.fieldClientId, value: clientName.trim() });
          }
        }

        // Requested date field (ClickUp date field — unix ms)
        if (config.fieldRequestedDateId && requestedDate) {
          const rdMs = new Date(requestedDate).getTime();
          if (!isNaN(rdMs)) taskCustomFields.push({ id: config.fieldRequestedDateId, value: rdMs });
        }

        // Build description: Q&A block + user description
        const qaParts: string[] = [];
        {
          const actorName = [actorRow?.firstName, actorRow?.lastName].filter(Boolean).join(" ").trim();
          const requesterLabel = actorName && actorEmail
            ? `${actorName} (${actorEmail})`
            : (actorName || actorEmail);
          if (requesterLabel) qaParts.push(`**Requested by:** ${requesterLabel}`);
        }
        if (clientName?.trim()) qaParts.push(`**Client:** ${clientName.trim()}`);
        if (deptRow) qaParts.push(`**Department:** ${deptRow.name}`);
        qaParts.push(`**Request Type:** ${rtRow.name}`);
        if (requestedDate) qaParts.push(`**Requested by date:** ${requestedDate}`);

        if (questions.length > 0) {
          qaParts.push("\n## Intake Questions");
          for (const q of questions) {
            const ans = (answersMap.get(q.id) ?? "").trim();
            if (ans) qaParts.push(`**${q.label}:** ${ans}`);
            else if (!q.required) qaParts.push(`**${q.label}:** *(not provided)*`);
          }
        }

        if (description?.trim()) {
          qaParts.push("\n## Additional Details");
          qaParts.push(description.trim());
        }

        qaParts.push("\n---\n*Submitted via NoBull OS*");

        const fullDescription = qaParts.join("\n");

        // Priority: 1=urgent, 2=high, 3=normal, 4=low
        const priority = priorityStr ? parseInt(priorityStr, 10) : 3;

        // Due date from requestedDate
        const dueDate = requestedDate ? new Date(requestedDate).getTime() : undefined;

        // Resolve the best intake status the target ClickUp list actually has.
        // Preference when "submitted" is missing (avoids CRTSK_001 "Status not found"):
        //   1. the list's "open"-type status (ClickUp's canonical intake status)
        //   2. the status with the lowest orderindex (first column in the list)
        //   3. omit status entirely so ClickUp applies the list default (last resort)
        let resolvedSubmitStatus: string | undefined = "submitted";
        let statusDriftDetected = false;
        let statusLookupFailed = false;
        try {
          const listInfo = await cu.getList(token, config.clickupListId!);
          const listStatuses: any[] = Array.isArray(listInfo?.statuses) ? listInfo.statuses : [];
          // Compare case-insensitively but send the list's ORIGINAL status text
          // to ClickUp (some contexts may match case-sensitively).
          const rawNameOf = (s: any) => String(s?.status ?? s?.name ?? "").trim();
          const nameOf = (s: any) => rawNameOf(s).toLowerCase();
          const submittedEntry = listStatuses.find((s) => nameOf(s) === "submitted");
          if (submittedEntry) {
            resolvedSubmitStatus = rawNameOf(submittedEntry);
          } else {
            statusDriftDetected = true;
            const openType = listStatuses.find(
              (s) => String(s?.type ?? "").toLowerCase() === "open" && nameOf(s),
            );
            const byOrder = [...listStatuses]
              .filter((s) => nameOf(s))
              .sort((a, b) => Number(a?.orderindex ?? 0) - Number(b?.orderindex ?? 0))[0];
            const picked = openType ?? byOrder;
            resolvedSubmitStatus = picked ? rawNameOf(picked) : undefined;
            console.warn(
              `[ServiceDesk] list ${config.clickupListId} is missing "submitted" status — using ${resolvedSubmitStatus ? `"${resolvedSubmitStatus}"` : "the list default status"} instead`,
            );
          }
        } catch (statusLookupErr: any) {
          // Can't verify statuses — omit the explicit status so ClickUp uses the list
          // default (never risk CRTSK_001), and alert admins below.
          statusLookupFailed = true;
          resolvedSubmitStatus = undefined;
          console.warn(`[ServiceDesk] status pre-check failed (creating without explicit status):`, statusLookupErr?.message);
        }

        // Create the ClickUp task — retry with fallback token on 401/403 from actor token.
        // `status` is optional on createTask; when `resolvedSubmitStatus` is undefined
        // (list is missing "submitted") ClickUp will use the list's default status.
        const taskPayload = {
          name: title.trim(),
          description: fullDescription,
          status: resolvedSubmitStatus,
          priority,
          ...(dueDate ? { due_date: dueDate } : {}),
          custom_fields: taskCustomFields.length > 0 ? taskCustomFields : undefined,
          ...(autoAssignPrimaryClickupId ? { assignees: [autoAssignPrimaryClickupId] } : {}),
        };
        let newTask: any;
        try {
          newTask = await cu.createTask(token, config.clickupListId!, taskPayload);
        } catch (createErr: any) {
          // If actor token was used and ClickUp rejected with an auth error, retry with
          // CEO/any-connected fallback token (submitter may lack ClickUp write permission).
          const isAuthFailure = !usedFallbackToken && (
            createErr?.status === 401 || createErr?.status === 403 ||
            /\b(401|403|OAUTH_023|unauthorized|forbidden|token)/i.test(createErr?.message ?? "")
          );
          if (isAuthFailure) {
            const retryToken = await resolveFallbackToken();
            if (!retryToken) throw createErr;
            token = retryToken;
            usedFallbackToken = true;
            newTask = await cu.createTask(retryToken, config.clickupListId!, taskPayload);
          } else {
            // Map ClickUp-specific error codes to plain-English messages before surfacing.
            const rawMsg = String(createErr?.message ?? "");
            const jsonMatch = rawMsg.match(/\{[\s\S]*?\}/);
            let friendlyMsg: string | null = null;
            if (jsonMatch) {
              try {
                const parsed = JSON.parse(jsonMatch[0]);
                const ecode = String(parsed.ECODE ?? "");
                const errText = String(parsed.err ?? "");
                if (ecode === "CRTSK_001" || /status not found/i.test(errText)) {
                  friendlyMsg =
                    'The ClickUp list is missing a required status. Ask your administrator to add the missing statuses in ClickUp (Settings → Service Desk → Verify setup), then try again.';
                } else if (errText) {
                  friendlyMsg = `ClickUp rejected the request: ${errText}`;
                }
              } catch { /* unparseable JSON in error — use raw message */ }
            }
            if (!friendlyMsg && /status not found/i.test(rawMsg)) {
              friendlyMsg =
                'The ClickUp list is missing a required status. Ask your administrator to verify the Service Desk setup, then try again.';
            }
            if (friendlyMsg) {
              const fe: any = new Error(friendlyMsg);
              fe.originalMessage = rawMsg;
              throw fe;
            }
            throw createErr;
          }
        }

        // Fire a deduped admin alert when the status fallback was used (list missing
        // "submitted") OR the status pre-check itself failed, so admins fix the config.
        if (statusDriftDetected || statusLookupFailed) {
          const alertTitle = statusDriftDetected
            ? 'Service Desk: ClickUp list is missing the "Submitted" status'
            : "Service Desk: could not verify the ClickUp list's statuses";
          const alertBody = statusDriftDetected
            ? `A request was submitted but the ClickUp list is missing the "Submitted" status — the ticket was created in ${resolvedSubmitStatus ? `the "${resolvedSubmitStatus}" status` : "the list's default status"} instead. Please add all required statuses in ClickUp and verify the setup at /admin/service-desk.`
            : "A request was submitted but the ClickUp list's statuses could not be verified — the ticket was created in the list's default status. Please verify the Service Desk setup at /admin/service-desk.";
          const alertKey = statusDriftDetected
            ? `sd_status_drift_${config.clickupListId}`
            : `sd_status_lookup_failed_${config.clickupListId}`;
          void (async () => {
            try {
              const ceoUserIds = await withDbAttribution("serviceDesk:submit:getCeoIds", async () => {
                const db = getDb();
                return db.select({ id: users.id }).from(users).where(eq(users.role, "ceo" as any));
              });
              for (const { id: ceoId } of ceoUserIds) {
                void notifyUser(ceoId, {
                  category: "service_desk",
                  title: alertTitle,
                  body: alertBody,
                  deepLink: "/admin/service-desk",
                  dedupeKey: alertKey,
                  metadata: {
                    listId: config.clickupListId,
                    event: statusDriftDetected ? "status_drift" : "status_lookup_failed",
                  },
                }).catch(() => {});
              }
            } catch (e: any) {
              console.warn("[ServiceDesk] status drift admin alert failed:", e?.message);
            }
          })();
        }

        const taskId: string = newTask.id;
        const taskUrl: string = newTask.url ?? `https://app.clickup.com/t/${taskId}`;
        const nowMs = String(Date.now());
        // Capture the actual status ClickUp assigned (may differ from "submitted" when the
        // list was missing that status and we omitted it from the payload).
        const actualTaskStatus: string = String(
          newTask.status?.status ?? newTask.status ?? resolvedSubmitStatus ?? "submitted",
        ).toLowerCase();

        // Set the Requester People field post-create (documented format for
        // "users" custom fields: { add: [userId], rem: [] }). Non-fatal — the
        // requester is already captured in the task description.
        if (config.fieldRequesterId && requesterClickupUserId != null) {
          await cu.setCustomFieldValue(token, taskId, config.fieldRequesterId, {
            add: [requesterClickupUserId],
            rem: [],
          }).catch((e: any) => {
            console.warn(`[ServiceDesk] requester People field set failed for task ${taskId}:`, e?.message);
          });
        }

        // ── Post-create: checker watcher + coverage-missing alert (Task #3585/#3618) ─
        // Add the Checker as a ClickUp watcher via PUT /task/{id}.
        if (autoAssignCheckerClickupId) {
          await cu.updateTask(token, taskId, {
            watchers: { add: [Number(autoAssignCheckerClickupId)], rem: [] as number[] },
          }).catch((e: any) => {
            console.warn(`[ServiceDesk] checker watcher add failed for task ${taskId}:`, e?.message);
          });
        }

        // Fire a deduped coverage-missing alert when no primary could be resolved
        // for the client + department combination. Alert goes to CEOs only.
        if (!autoAssignPrimaryUserId && (resolvedClientStringId || departmentId)) {
          void (async () => {
            try {
              const ceoUserIds = await withDbAttribution("serviceDesk:submit:coverageAlertCeos", async () => {
                const db = getDb();
                return db.select({ id: users.id }).from(users).where(eq(users.role, "ceo" as any));
              });
              for (const { id: ceoId } of ceoUserIds) {
                void notifyUser(ceoId, {
                  category: "service_desk",
                  title: "Service Desk: no assignee for ticket",
                  body: `A ticket was submitted with no primary assignee resolved. Client: ${clientName?.trim() || resolvedClientStringId || "(unknown)"}; Department: ${departmentId || "(none)"}. Set an assignment at /admin/service-desk or update the department default.`,
                  deepLink: "/admin/service-desk",
                  dedupeKey: `sd_no_assignee_${resolvedClientStringId ?? "none"}_${departmentId ?? "none"}`,
                  metadata: {
                    taskId,
                    clientId: resolvedClientStringId,
                    departmentId,
                  },
                }).catch(() => {});
              }
            } catch (e: any) {
              console.warn("[ServiceDesk] coverage-missing alert failed:", e?.message);
            }
          })();
        }

        // Upload attachment if present
        const file = req.file as Express.Multer.File | undefined;
        if (file) {
          await cu.uploadAttachment(token, taskId, file.originalname, file.buffer, file.mimetype)
            .catch((e: any) => {
              console.warn(`[ServiceDesk] attachment upload failed for task ${taskId}:`, e?.message);
            });
        }

        // Load checklist steps for template enforcement
        const checklistSteps = await withDbAttribution("serviceDesk:submit:getChecklistSteps", async () => {
          const db = getDb();
          return db
            .select()
            .from(sdRequestTypeChecklistSteps)
            .where(eq(sdRequestTypeChecklistSteps.requestTypeId, requestTypeId))
            .orderBy(asc(sdRequestTypeChecklistSteps.sortOrder));
        });

        let templateChecklistApplied = false;
        if (checklistSteps.length > 0) {
          try {
            // Resolve step assignees (fixed user or dynamic role) — Task #3656.
            // Resolution failure NEVER blocks the apply; steps fall back to unassigned.
            let stepAssignees: Array<number | null> = checklistSteps.map(() => null);
            try {
              const resolved = await resolveChecklistStepAssignees(checklistSteps, {
                clientId: resolvedClientStringId ?? null,
                departmentId: departmentId || null,
                workspaceId: config.clickupWorkspaceId ?? null,
              });
              stepAssignees = resolved.assignees;
              for (const w of resolved.warnings) {
                console.warn(`[ServiceDesk] checklist assignee for task ${taskId}: ${w}`);
              }
            } catch (assignErr: any) {
              console.warn(`[ServiceDesk] checklist assignee resolution failed for task ${taskId} — items unassigned:`, assignErr?.message);
            }
            const checklist = await cu.createChecklist(token, taskId, `${rtRow.name} Checklist`);
            const checklistId: string = checklist?.checklist?.id ?? checklist?.id;
            if (checklistId) {
              for (let i = 0; i < checklistSteps.length; i++) {
                const step = checklistSteps[i];
                const assignee = stepAssignees[i];
                await cu.createChecklistItem(token, checklistId, {
                  name: step.name,
                  ...(assignee != null ? { assignee } : {}),
                });
              }
              templateChecklistApplied = true;
            }
          } catch (e: any) {
            console.warn(`[ServiceDesk] checklist apply failed for task ${taskId}:`, e?.message);
          }
        }

        // Mirror the task in clickup_tasks so it appears immediately in the read model
        await withDbAttribution("serviceDesk:submit:mirrorTask", async () => {
          const db = getDb();
          const [listRow] = await db
            .select({ folderId: sdListMapping.clickupFolderId, spaceId: sdListMapping.clickupSpaceId, workspaceId: sdListMapping.clickupWorkspaceId })
            .from(sdListMapping)
            .limit(1);
          await db
            .insert(clickupTasks)
            .values({
              id: taskId,
              listId: config.clickupListId!,
              folderId: listRow?.folderId ?? null,
              spaceId: listRow?.spaceId ?? null,
              workspaceId: listRow?.workspaceId ?? null,
              name: title.trim(),
              description: fullDescription,
              status: actualTaskStatus,
              priority,
              dateCreated: nowMs,
              dateUpdated: nowMs,
              url: taskUrl,
              customFields: taskCustomFields.length > 0 ? taskCustomFields : null,
            })
            .onConflictDoNothing();
        });

        // Structured intake answers for inline display (Task #3397):
        // [{ label, value }] in question sort order, answered questions only.
        const storedAnswers = questions
          .map((q) => ({ label: q.label, value: (answersMap.get(q.id) ?? "").trim() }))
          .filter((a) => a.value);

        // Write sd_ticket_mapping (include ownerUserId from auto-assign resolution)
        await withDbAttribution("serviceDesk:submit:ticketMapping", async () => {
          const db = getDb();
          await db
            .insert(sdTicketMapping)
            .values({
              clickupTaskId: taskId,
              clientId: clientId ?? null,
              clientUuid: resolvedClientStringId ?? null,
              requesterUserId: actorUserId,
              departmentId: departmentId || null,
              createdViaNobull: true,
              templateChecklistApplied,
              questionAnswers: storedAnswers.length > 0 ? storedAnswers : null,
              ownerUserId: autoAssignPrimaryUserId ?? null,
            })
            .onConflictDoNothing();
        });

        // Write sd_ticket_events
        await withDbAttribution("serviceDesk:submit:ticketEvent", async () => {
          const db = getDb();
          await db.insert(sdTicketEvents).values({
            clickupTaskId: taskId,
            eventType: "submitted_native",
            actorUserId,
            data: {
              requestTypeId,
              departmentId,
              clientId: clientId ?? null,
              clientName: clientName?.trim() || null,
              answeredQuestions: questions.length,
              checklistApplied: templateChecklistApplied,
            },
          });
        });

        const statusFallbackUsed = statusDriftDetected || statusLookupFailed;
        res.json({
          success: true,
          taskId,
          taskUrl,
          resolvedOwnerName,
          ...(statusFallbackUsed
            ? {
                statusFallbackUsed: true,
                statusNotice: statusDriftDetected
                  ? `Your request was filed, but it was placed in the "${actualTaskStatus}" status because the ClickUp list is missing the expected "Submitted" status. An administrator has been notified.`
                  : `Your request was filed in the "${actualTaskStatus}" status because the ClickUp list's statuses could not be verified. An administrator has been notified.`,
              }
            : {}),
        });
      } catch (err: any) {
        console.error("[ServiceDesk] submit error:", err?.message);
        res.status(500).json({ error: err.message });
      }
    },
  );
}
