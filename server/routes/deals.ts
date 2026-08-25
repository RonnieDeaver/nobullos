import type { Express, Response } from "express";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { hasRole, requireTeamLead } from "./middleware";
import type { AuthenticatedRequest, ValidatedBodyRequest } from "./requestContext";
import {
  createDealBodySchema,
  createDealStageBodySchema,
  moveDealBodySchema,
  updateDealBodySchema,
  updateDealStageBodySchema,
  type CreateDealBody,
  type CreateDealStageBody,
  type MoveDealBody,
  type UpdateDealBody,
  type UpdateDealStageBody,
} from "@shared/schema";
import {
  ContactClientMismatchError,
  createDeal,
  createStage,
  deleteDeal,
  ensureDefaultDealPipelineSeeded,
  getDeal,
  getDealDetail,
  getDefaultPipeline,
  getPipeline,
  listDeals,
  listPipelinesWithStages,
  MissingRequiredFieldsError,
  moveDealStage,
  StageMismatchError,
  updateDeal,
  updateStage,
} from "../storage/dealsStorage";
import { evaluateRecordWriteSafe } from "../services/tagSegmentEngine";
import { recomputeEntityScoreSafe } from "../services/scoringEngine";

/**
 * Task #4327 — Deals pipeline routes.
 *
 * Access model mirrors the clients domain: account_manager+ see and manage
 * every deal; below that (sales) users are scoped to deals they own —
 * owner_id is forced to self on create and owner reassignment is rejected.
 * Stage configuration (create/edit stage rows) is team_lead+.
 *
 * Stage transitions go ONLY through POST /api/deals/:id/move (stageId is
 * absent from the update schema) so every move atomically writes its
 * deal_stage_history row. A move into a stage with unmet requiredFields
 * returns 422 { missingFields } and the client prompts for them.
 */
export function registerDealsRoutes(app: Express): void {
  /** Loads the acting user; 401 when the session has no users row. */
  async function getActor(req: AuthenticatedRequest) {
    const userId = req.user?.claims?.sub;
    if (!userId) return null;
    const user = await storage.getUser(userId);
    if (!user) return null;
    return { userId, user };
  }

  /**
   * Validates that the actor may attach this client to a deal. Returns an
   * error response when not; null when allowed. Mirrors clients.ts: demo
   * clients are CEO-only; sales users only touch clients they own.
   */
  async function checkClientAttachable(
    res: Response,
    clientId: string,
    actor: { userId: string; user: { role: string | null } },
  ): Promise<Response | null> {
    const client = await storage.getClient(clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });
    const isCeo = actor.user.role === "ceo";
    if (client.isDemo && !isCeo) {
      return res.status(404).json({ error: "Client not found" });
    }
    if (
      !hasRole(actor.user.role, "account_manager") &&
      client.ownerId !== actor.userId
    ) {
      return res.status(403).json({ error: "Access denied" });
    }
    return null;
  }

  // ── Pipelines & stage config ───────────────────────────────────────────────

  app.get(
    "/api/deals/pipelines",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        await ensureDefaultDealPipelineSeeded();
        const pipelines = await listPipelinesWithStages();
        res.json(pipelines);
      } catch (error) {
        console.error("Error fetching deal pipelines:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.post(
    "/api/deals/pipelines/:pipelineId/stages",
    isAuthenticated,
    requireTeamLead,
    async (
      req: ValidatedBodyRequest<CreateDealStageBody, { pipelineId: string }>,
      res: Response,
    ) => {
      try {
        const parsed = createDealStageBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const pipeline = await getPipeline(req.params.pipelineId);
        if (!pipeline) {
          return res.status(404).json({ error: "Pipeline not found" });
        }
        const stage = await createStage({
          pipelineId: pipeline.id,
          name: parsed.data.name,
          winProbability: parsed.data.winProbability,
          stageType: parsed.data.stageType,
          requiredFields: parsed.data.requiredFields,
          position: parsed.data.position,
        });
        res.status(201).json(stage);
      } catch (error) {
        console.error("Error creating deal stage:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.patch(
    "/api/deals/stages/:id",
    isAuthenticated,
    requireTeamLead,
    async (
      req: ValidatedBodyRequest<UpdateDealStageBody, { id: string }>,
      res: Response,
    ) => {
      try {
        const parsed = updateDealStageBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const stage = await updateStage(req.params.id, parsed.data);
        if (!stage) return res.status(404).json({ error: "Stage not found" });
        res.json(stage);
      } catch (error) {
        console.error("Error updating deal stage:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // ── Deals ──────────────────────────────────────────────────────────────────

  app.get(
    "/api/deals",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });
        await ensureDefaultDealPipelineSeeded();

        const requestedPipelineId =
          typeof req.query.pipelineId === "string" && req.query.pipelineId
            ? req.query.pipelineId
            : undefined;
        const pipeline = requestedPipelineId
          ? await getPipeline(requestedPipelineId)
          : await getDefaultPipeline();
        if (!pipeline) {
          return res.status(404).json({ error: "Pipeline not found" });
        }
        const includeArchived =
          req.query.includeArchived === "true" || req.query.includeArchived === "1";
        const canSeeAll = hasRole(actor.user.role, "account_manager");
        const rows = await listDeals({
          pipelineId: pipeline.id,
          ownerId: canSeeAll ? undefined : actor.userId,
          includeArchived,
        });
        res.json(rows);
      } catch (error) {
        console.error("Error fetching deals:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.post(
    "/api/deals",
    isAuthenticated,
    async (req: ValidatedBodyRequest<CreateDealBody>, res: Response) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });
        const parsed = createDealBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const body = parsed.data;
        await ensureDefaultDealPipelineSeeded();

        const pipeline = body.pipelineId
          ? await getPipeline(body.pipelineId)
          : await getDefaultPipeline();
        if (!pipeline) {
          return res.status(404).json({ error: "Pipeline not found" });
        }
        const pipelines = await listPipelinesWithStages();
        const stages =
          pipelines.find((p) => p.id === pipeline.id)?.stages ?? [];
        if (stages.length === 0) {
          return res.status(409).json({ error: "Pipeline has no stages" });
        }
        let stage = stages.find((s) => s.stageType === "open") ?? stages[0];
        if (body.stageId) {
          const explicit = stages.find((s) => s.id === body.stageId);
          if (!explicit) {
            return res
              .status(400)
              .json({ error: "Stage does not belong to the pipeline" });
          }
          stage = explicit;
        }

        const canSeeAll = hasRole(actor.user.role, "account_manager");
        if (body.clientId) {
          const denied = await checkClientAttachable(res, body.clientId, actor);
          if (denied) return denied;
        }
        const ownerId = canSeeAll
          ? (body.ownerId !== undefined ? body.ownerId : actor.userId)
          : actor.userId;

        const deal = await createDeal({
          name: body.name,
          pipelineId: pipeline.id,
          stageId: stage.id,
          clientId: body.clientId ?? null,
          contactIds: body.contactIds ?? [],
          amount: body.amount ?? null,
          expectedCloseDate: body.expectedCloseDate ?? null,
          ownerId,
          notes: body.notes ?? null,
          createdBy: actor.userId,
        });
        // Task #4329 — rule tags evaluate on write (never fails the write).
        await evaluateRecordWriteSafe("deal", deal.id);
        // Task #4333 — new deals get an initial score (never fails the write).
        await recomputeEntityScoreSafe("deal", deal.id);
        res.status(201).json(deal);
      } catch (error) {
        if (error instanceof ContactClientMismatchError) {
          return res.status(400).json({ error: error.message });
        }
        console.error("Error creating deal:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.get(
    "/api/deals/:id",
    isAuthenticated,
    async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });
        const detail = await getDealDetail(req.params.id);
        if (!detail) return res.status(404).json({ error: "Deal not found" });
        const canSeeAll = hasRole(actor.user.role, "account_manager");
        if (!canSeeAll && detail.ownerId !== actor.userId) {
          return res.status(403).json({ error: "Access denied" });
        }
        res.json(detail);
      } catch (error) {
        console.error("Error fetching deal:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.patch(
    "/api/deals/:id",
    isAuthenticated,
    async (
      req: ValidatedBodyRequest<UpdateDealBody, { id: string }>,
      res: Response,
    ) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });
        const parsed = updateDealBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const deal = await getDeal(req.params.id);
        if (!deal) return res.status(404).json({ error: "Deal not found" });
        const canSeeAll = hasRole(actor.user.role, "account_manager");
        if (!canSeeAll && deal.ownerId !== actor.userId) {
          return res.status(403).json({ error: "Access denied" });
        }
        const body = parsed.data;
        if (
          !canSeeAll &&
          body.ownerId !== undefined &&
          body.ownerId !== deal.ownerId
        ) {
          return res
            .status(403)
            .json({ error: "Only account managers can reassign deal owners" });
        }
        if (body.clientId) {
          const denied = await checkClientAttachable(res, body.clientId, actor);
          if (denied) return denied;
        }
        const updated = await updateDeal(req.params.id, body);
        if (!updated) return res.status(404).json({ error: "Deal not found" });
        // Task #4329 — rule tags evaluate on write (never fails the write).
        await evaluateRecordWriteSafe("deal", updated.id);
        // Task #4333 — property edits can flip fit rules (never fails the write).
        await recomputeEntityScoreSafe("deal", updated.id);
        res.json(updated);
      } catch (error) {
        if (error instanceof ContactClientMismatchError) {
          return res.status(400).json({ error: error.message });
        }
        console.error("Error updating deal:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.post(
    "/api/deals/:id/move",
    isAuthenticated,
    async (
      req: ValidatedBodyRequest<MoveDealBody, { id: string }>,
      res: Response,
    ) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });
        const parsed = moveDealBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const deal = await getDeal(req.params.id);
        if (!deal) return res.status(404).json({ error: "Deal not found" });
        const canSeeAll = hasRole(actor.user.role, "account_manager");
        if (!canSeeAll && deal.ownerId !== actor.userId) {
          return res.status(403).json({ error: "Access denied" });
        }
        const result = await moveDealStage(req.params.id, {
          toStageId: parsed.data.toStageId,
          movedByUserId: actor.userId,
          fields: parsed.data.fields,
        });
        if (!result) return res.status(404).json({ error: "Deal not found" });
        // Task #4329 — stage moves can flip stage_name-based rule tags.
        await evaluateRecordWriteSafe("deal", req.params.id);
        // Task #4333 — stage moves can flip stage_name fit rules.
        await recomputeEntityScoreSafe("deal", req.params.id);
        res.json(result);
      } catch (error) {
        if (error instanceof MissingRequiredFieldsError) {
          return res.status(422).json({
            error: "Missing required fields for this stage",
            missingFields: error.missingFields,
          });
        }
        if (error instanceof StageMismatchError) {
          return res.status(400).json({ error: error.message });
        }
        console.error("Error moving deal:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.delete(
    "/api/deals/:id",
    isAuthenticated,
    async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });
        const deal = await getDeal(req.params.id);
        if (!deal) return res.status(404).json({ error: "Deal not found" });
        const canDelete =
          hasRole(actor.user.role, "team_lead") || deal.ownerId === actor.userId;
        if (!canDelete) {
          return res.status(403).json({ error: "Access denied" });
        }
        await deleteDeal(req.params.id);
        res.json({ success: true });
      } catch (error) {
        console.error("Error deleting deal:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // ── Client-page entry point ────────────────────────────────────────────────

  app.get(
    "/api/clients/:clientId/deals",
    isAuthenticated,
    async (req: AuthenticatedRequest<{ clientId: string }>, res: Response) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });
        const denied = await checkClientAttachable(res, req.params.clientId, actor);
        if (denied) return denied;
        const rows = await listDeals({
          clientId: req.params.clientId,
          includeArchived: false,
        });
        res.json(rows);
      } catch (error) {
        console.error("Error fetching client deals:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );
}
