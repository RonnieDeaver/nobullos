import type { Express, Response } from "express";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { hasRole, requireTeamLead } from "./middleware";
import type { AuthenticatedRequest, ValidatedBodyRequest } from "./requestContext";
import {
  applyTagBodySchema,
  createSegmentBodySchema,
  createTagBodySchema,
  updateSegmentBodySchema,
  updateTagBodySchema,
  type ApplyTagBody,
  type CreateSegmentBody,
  type CreateTagBody,
  type UpdateSegmentBody,
  type UpdateTagBody,
} from "@shared/schema";
import {
  tagEntityTypes,
  validateCriteriaSet,
  type TagEntityType,
} from "@shared/criteria";
import {
  applyManualTag,
  createSegment,
  createTag,
  deleteSegment,
  deleteTag,
  getRecordTags,
  getSegment,
  getSweepQueueInfo,
  getTag,
  getTaggableRecord,
  isUniqueViolation,
  listSegmentMembers,
  listSegments,
  listTagAssignments,
  listTags,
  removeManualTag,
  SEGMENT_MEMBER_LIST_LIMIT,
  updateSegment,
  updateTag,
} from "../storage/tagsSegmentsStorage";
import {
  evaluateSegmentFully,
  evaluateTagFully,
  TAG_SEGMENT_RECONCILE_QUEUE,
  TAG_SEGMENT_SWEEP_STATUS_SETTING,
} from "../services/tagSegmentEngine";
import {
  TAG_SEGMENT_SWEEP_DEDUPE_KEY,
  TAG_SEGMENT_SWEEP_ENABLED_SETTING,
  TAG_SEGMENT_SWEEP_INTERVAL_SETTING,
} from "../services/tagSegmentScheduler";

/**
 * Task #4329 — tags & segments routes.
 *
 * Access model:
 *   - Definition CRUD (tags, segments), recompute, sweep trigger, and the
 *     status view are team_lead+ — the management surface.
 *   - Manual tag apply/remove mirrors the RECORD's own edit rule (deals:
 *     sales users touch only deals they own, AM+ touch all — same as
 *     deals.ts; clients: demo rows are CEO-only and sub-AM users touch
 *     only clients they own — same as clients.ts).
 *   - Reads (tag list, record tags, segment lists/members) are any
 *     authenticated user: chips render on boards/lists everyone sees.
 *
 * Rule rows are engine-owned: the manual DELETE route refuses them with
 * 409 (they would resurrect on the next evaluation — operators edit the
 * tag's criteria instead). Criteria bodies are shape-parsed by zod and
 * semantically validated against the entity's field registry
 * (validateCriteriaSet) before any write. Creating or re-criteria-ing a
 * definition evaluates it synchronously so chips/membership are fresh on
 * the caller's next read — the periodic sweep only heals drift.
 */
export function registerTagsSegmentsRoutes(app: Express): void {
  /** Loads the acting user; null when the session has no users row. */
  async function getActor(req: AuthenticatedRequest) {
    const userId = req.user?.claims?.sub;
    if (!userId) return null;
    const user = await storage.getUser(userId);
    if (!user) return null;
    return { userId, user };
  }

  /**
   * Record-level access for manual tagging. Returns null when allowed,
   * otherwise writes the error response and returns it.
   */
  async function checkRecordAccess(
    res: Response,
    entityType: TagEntityType,
    recordId: string,
    actor: { userId: string; user: { role: string | null } },
  ): Promise<Response | null> {
    const record = await getTaggableRecord(entityType, recordId);
    if (!record) {
      return res.status(404).json({ error: `${entityType === "deal" ? "Deal" : "Client"} not found` });
    }
    const isCeo = actor.user.role === "ceo";
    if (entityType === "client" && record.isDemo && !isCeo) {
      return res.status(404).json({ error: "Client not found" });
    }
    if (
      !hasRole(actor.user.role, "account_manager") &&
      record.ownerId !== actor.userId
    ) {
      return res.status(403).json({ error: "Access denied" });
    }
    return null;
  }

  // ── Tag definitions ────────────────────────────────────────────────────────

  app.get(
    "/api/tags",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const rawEntityType = req.query.entityType;
        let entityType: TagEntityType | undefined;
        if (rawEntityType !== undefined) {
          if (
            typeof rawEntityType !== "string" ||
            !tagEntityTypes.includes(rawEntityType as TagEntityType)
          ) {
            return res.status(400).json({ error: "entityType must be 'deal' or 'client'" });
          }
          entityType = rawEntityType as TagEntityType;
        }
        const tagList = await listTags(entityType);
        if (req.query.includeAssignments === "1") {
          if (!entityType) {
            return res
              .status(400)
              .json({ error: "includeAssignments requires entityType" });
          }
          const assignments = await listTagAssignments(entityType);
          return res.json({ tags: tagList, assignments });
        }
        res.json({ tags: tagList });
      } catch (error) {
        console.error("Error listing tags:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.post(
    "/api/tags",
    isAuthenticated,
    requireTeamLead,
    async (req: ValidatedBodyRequest<CreateTagBody>, res: Response) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });
        const parsed = createTagBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const body = parsed.data;
        if (body.criteria) {
          const problems = validateCriteriaSet(body.entityType, body.criteria);
          if (problems.length > 0) {
            return res.status(400).json({ error: problems });
          }
        }
        const tag = await createTag({
          entityType: body.entityType,
          name: body.name,
          color: body.color,
          description: body.description ?? null,
          criteria: body.criteria ?? null,
          createdBy: actor.userId,
        });
        // Synchronous first evaluation: rule chips exist before the caller's
        // next read. Population is bounded (batched loads inside).
        if (tag.criteria) await evaluateTagFully(tag);
        res.status(201).json(tag);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return res
            .status(409)
            .json({ error: "A tag with this name already exists for this entity type" });
        }
        console.error("Error creating tag:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.patch(
    "/api/tags/:id",
    isAuthenticated,
    requireTeamLead,
    async (req: ValidatedBodyRequest<UpdateTagBody, { id: string }>, res: Response) => {
      try {
        const existing = await getTag(req.params.id);
        if (!existing) return res.status(404).json({ error: "Tag not found" });
        const parsed = updateTagBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const body = parsed.data;
        if (body.criteria) {
          const problems = validateCriteriaSet(existing.entityType, body.criteria);
          if (problems.length > 0) {
            return res.status(400).json({ error: problems });
          }
        }
        const updated = await updateTag(existing.id, body);
        if (!updated) return res.status(404).json({ error: "Tag not found" });
        // Re-evaluate when the rule changed (including criteria removal,
        // which demotes the tag to manual-only and clears its rule rows).
        if (body.criteria !== undefined) await evaluateTagFully(updated);
        res.json(updated);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return res
            .status(409)
            .json({ error: "A tag with this name already exists for this entity type" });
        }
        console.error("Error updating tag:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.delete(
    "/api/tags/:id",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
      try {
        const deleted = await deleteTag(req.params.id);
        if (!deleted) return res.status(404).json({ error: "Tag not found" });
        res.status(204).end();
      } catch (error) {
        console.error("Error deleting tag:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // ── Manual application (deals + clients) ──────────────────────────────────

  for (const entityType of tagEntityTypes) {
    const base =
      entityType === "deal" ? "/api/deals/:recordId/tags" : "/api/clients/:recordId/tags";

    app.get(
      base,
      isAuthenticated,
      async (req: AuthenticatedRequest<{ recordId: string }>, res: Response) => {
        try {
          const actor = await getActor(req);
          if (!actor) return res.status(401).json({ error: "Unauthorized" });
          const denied = await checkRecordAccess(res, entityType, req.params.recordId, actor);
          if (denied) return;
          res.json(await getRecordTags(entityType, req.params.recordId));
        } catch (error) {
          console.error(`Error fetching ${entityType} tags:`, error);
          res.status(500).json({ error: "Server error" });
        }
      },
    );

    app.post(
      base,
      isAuthenticated,
      async (
        req: ValidatedBodyRequest<ApplyTagBody, { recordId: string }>,
        res: Response,
      ) => {
        try {
          const actor = await getActor(req);
          if (!actor) return res.status(401).json({ error: "Unauthorized" });
          const denied = await checkRecordAccess(res, entityType, req.params.recordId, actor);
          if (denied) return;
          const parsed = applyTagBodySchema.safeParse(req.body);
          if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.issues });
          }
          const tag = await getTag(parsed.data.tagId);
          if (!tag) return res.status(404).json({ error: "Tag not found" });
          if (tag.entityType !== entityType) {
            return res.status(400).json({
              error: `Tag "${tag.name}" is a ${tag.entityType} tag and cannot be applied to a ${entityType}`,
            });
          }
          await applyManualTag(entityType, req.params.recordId, tag.id, actor.userId);
          res.status(201).json(await getRecordTags(entityType, req.params.recordId));
        } catch (error) {
          console.error(`Error applying ${entityType} tag:`, error);
          res.status(500).json({ error: "Server error" });
        }
      },
    );

    app.delete(
      `${base}/:tagId`,
      isAuthenticated,
      async (
        req: AuthenticatedRequest<{ recordId: string; tagId: string }>,
        res: Response,
      ) => {
        try {
          const actor = await getActor(req);
          if (!actor) return res.status(401).json({ error: "Unauthorized" });
          const denied = await checkRecordAccess(res, entityType, req.params.recordId, actor);
          if (denied) return;
          const result = await removeManualTag(
            entityType,
            req.params.recordId,
            req.params.tagId,
          );
          if (result === "not_found") {
            return res.status(404).json({ error: "Tag is not applied to this record" });
          }
          if (result === "rule_protected") {
            return res.status(409).json({
              error:
                "This tag was applied by its rule and will re-apply while the record matches. Edit the tag's criteria to remove it.",
            });
          }
          res.json(await getRecordTags(entityType, req.params.recordId));
        } catch (error) {
          console.error(`Error removing ${entityType} tag:`, error);
          res.status(500).json({ error: "Server error" });
        }
      },
    );
  }

  // ── Segments ───────────────────────────────────────────────────────────────

  app.get(
    "/api/segments",
    isAuthenticated,
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        res.json(await listSegments());
      } catch (error) {
        console.error("Error listing segments:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.post(
    "/api/segments",
    isAuthenticated,
    requireTeamLead,
    async (req: ValidatedBodyRequest<CreateSegmentBody>, res: Response) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });
        const parsed = createSegmentBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const body = parsed.data;
        const problems = validateCriteriaSet(body.entityType, body.criteria);
        if (problems.length > 0) {
          return res.status(400).json({ error: problems });
        }
        const segment = await createSegment({
          entityType: body.entityType,
          name: body.name,
          description: body.description ?? null,
          criteria: body.criteria,
          createdBy: actor.userId,
        });
        // Membership + count are fresh before the caller's next read.
        await evaluateSegmentFully(segment);
        const fresh = await getSegment(segment.id);
        res.status(201).json(fresh ?? segment);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return res
            .status(409)
            .json({ error: "A segment with this name already exists for this entity type" });
        }
        console.error("Error creating segment:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.patch(
    "/api/segments/:id",
    isAuthenticated,
    requireTeamLead,
    async (
      req: ValidatedBodyRequest<UpdateSegmentBody, { id: string }>,
      res: Response,
    ) => {
      try {
        const existing = await getSegment(req.params.id);
        if (!existing) return res.status(404).json({ error: "Segment not found" });
        const parsed = updateSegmentBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const body = parsed.data;
        if (body.criteria) {
          const problems = validateCriteriaSet(existing.entityType, body.criteria);
          if (problems.length > 0) {
            return res.status(400).json({ error: problems });
          }
        }
        const updated = await updateSegment(existing.id, body);
        if (!updated) return res.status(404).json({ error: "Segment not found" });
        if (body.criteria !== undefined) await evaluateSegmentFully(updated);
        const fresh = await getSegment(updated.id);
        res.json(fresh ?? updated);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return res
            .status(409)
            .json({ error: "A segment with this name already exists for this entity type" });
        }
        console.error("Error updating segment:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.delete(
    "/api/segments/:id",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
      try {
        const deleted = await deleteSegment(req.params.id);
        if (!deleted) return res.status(404).json({ error: "Segment not found" });
        res.status(204).end();
      } catch (error) {
        console.error("Error deleting segment:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.get(
    "/api/segments/:id/members",
    isAuthenticated,
    async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
      try {
        const segment = await getSegment(req.params.id);
        if (!segment) return res.status(404).json({ error: "Segment not found" });
        const members = await listSegmentMembers(segment);
        res.json({
          segment,
          members,
          total: segment.memberCount,
          limit: SEGMENT_MEMBER_LIST_LIMIT,
        });
      } catch (error) {
        console.error("Error listing segment members:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.post(
    "/api/segments/:id/recompute",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
      try {
        const segment = await getSegment(req.params.id);
        if (!segment) return res.status(404).json({ error: "Segment not found" });
        const result = await evaluateSegmentFully(segment);
        res.json(result);
      } catch (error) {
        console.error("Error recomputing segment:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // ── Admin: evaluation status + manual sweep ────────────────────────────────

  app.get(
    "/api/tags-segments/status",
    isAuthenticated,
    requireTeamLead,
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const { getSystemSetting } = await import("../storage/settingsStorage");
        const { isRunningInDeployment } = await import("../lib/deploymentEnv");
        const [enabledSetting, intervalSetting, statusSetting, queue, tagList, segmentList] =
          await Promise.all([
            getSystemSetting(TAG_SEGMENT_SWEEP_ENABLED_SETTING),
            getSystemSetting(TAG_SEGMENT_SWEEP_INTERVAL_SETTING),
            getSystemSetting(TAG_SEGMENT_SWEEP_STATUS_SETTING),
            getSweepQueueInfo(TAG_SEGMENT_RECONCILE_QUEUE),
            listTags(),
            listSegments(),
          ]);
        const enabledValue = enabledSetting?.value ?? "false";
        let lastSweep: unknown = null;
        if (statusSetting?.value) {
          try {
            lastSweep = JSON.parse(statusSetting.value);
          } catch {
            lastSweep = { unparseable: statusSetting.value };
          }
        }
        res.json({
          sweepEnabled: ["true", "1", "yes", "on"].includes(enabledValue),
          enabledSetting: TAG_SEGMENT_SWEEP_ENABLED_SETTING,
          intervalMs: intervalSetting?.value ? parseInt(intervalSetting.value, 10) : null,
          isDeployment: isRunningInDeployment(),
          forceEnabled: ["1", "true"].includes(process.env.TAG_SEGMENT_SWEEP_FORCE_ENABLE ?? ""),
          lastSweep,
          queue,
          definitions: [
            ...tagList.map((t) => ({
              kind: "tag" as const,
              id: t.id,
              name: t.name,
              entityType: t.entityType,
              hasCriteria: t.criteria !== null,
              lastEvaluatedAt: t.lastEvaluatedAt,
              count: t.taggedCount,
            })),
            ...segmentList.map((s) => ({
              kind: "segment" as const,
              id: s.id,
              name: s.name,
              entityType: s.entityType,
              hasCriteria: true,
              lastEvaluatedAt: s.lastEvaluatedAt,
              count: s.memberCount,
            })),
          ],
        });
      } catch (error) {
        console.error("Error fetching tags/segments status:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.patch(
    "/api/tags-segments/settings",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });
        const { z } = await import("zod");
        const schema = z
          .object({
            enabled: z.boolean().optional(),
            intervalMs: z.number().int().min(5 * 60 * 1000).max(24 * 60 * 60 * 1000).optional(),
          })
          .strict();
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const { setSystemSetting } = await import("../storage/settingsStorage");
        if (parsed.data.enabled !== undefined) {
          await setSystemSetting(
            TAG_SEGMENT_SWEEP_ENABLED_SETTING,
            parsed.data.enabled ? "true" : "false",
            actor.userId,
          );
        }
        if (parsed.data.intervalMs !== undefined) {
          await setSystemSetting(
            TAG_SEGMENT_SWEEP_INTERVAL_SETTING,
            String(parsed.data.intervalMs),
            actor.userId,
          );
        }
        res.json({ ok: true });
      } catch (error) {
        console.error("Error updating tags/segments settings:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.post(
    "/api/tags-segments/sweep",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });
        const { enqueueJob } = await import("../services/workScheduler");
        // Same dedupeKey as the scheduler: if a sweep is already queued or
        // running, this returns the existing job instead of stacking one.
        const jobId = await enqueueJob({
          queueName: TAG_SEGMENT_RECONCILE_QUEUE,
          workloadClass: "maintenance",
          priority: 50,
          payload: { trigger: "manual", requestedBy: actor.userId },
          dedupeKey: TAG_SEGMENT_SWEEP_DEDUPE_KEY,
        });
        res.status(202).json({ jobId });
      } catch (error) {
        console.error("Error enqueueing tags/segments sweep:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );
}
