import type { Express, Response } from "express";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { hasRole, requireTeamLead } from "./middleware";
import type { AuthenticatedRequest, ValidatedBodyRequest } from "./requestContext";
import {
  createScoreRuleBodySchema,
  SCORE_RULE_MAX_PER_CONFIG,
  scorePreviewBodySchema,
  scoringEntityTypes,
  updateScoreConfigBodySchema,
  updateScoreRuleBodySchema,
  type CreateScoreRuleBody,
  type ScorePreviewBody,
  type ScoringEntityType,
  type UpdateScoreConfigBody,
  type UpdateScoreRuleBody,
} from "@shared/schema";
import { validateCriteriaSet } from "@shared/criteria";
import {
  countScoreRules,
  createScoreRule,
  deleteScoreRule,
  ensureScoreConfig,
  getScoreConfigWithRules,
  getScoreRule,
  updateScoreConfig,
  updateScoreRule,
} from "../storage/scoringStorage";
import {
  previewScoreForEntity,
  recomputeScoresForEntityType,
  SCORING_SWEEP_STATUS_SETTING,
} from "../services/scoringEngine";
import {
  SCORING_SWEEP_ENABLED_SETTING,
  SCORING_SWEEP_INTERVAL_SETTING,
} from "../services/scoringScheduler";
import { getSystemSetting } from "../storage/settingsStorage";
import { getDeal } from "../storage/dealsStorage";

/**
 * Task #4333 — deal & lead scoring routes.
 *
 * Access model (mirrors tags & segments):
 *   - Config/rule CRUD, manual recompute, and preview are team_lead+ —
 *     the management surface. Preview additionally applies the deal
 *     domain's own record-visibility rule before scoring a sample record.
 *   - Config READ is any authenticated user: badges render score context
 *     (range, enabled state) on boards everyone sees.
 *
 * Mutations recompute the affected entity type SYNCHRONOUSLY before
 * responding — "changing the scoring config visibly re-ranks" without
 * waiting for the nightly sweep. Population is bounded (batched loads in
 * the engine; deals are a board-scale table).
 *
 * Criteria bodies are shape-parsed by zod and semantically validated
 * against the entity's field registry (validateCriteriaSet) before any
 * write — same two-layer validation as tag/segment criteria.
 */
export function registerScoringRoutes(app: Express): void {
  /** Loads the acting user; null when the session has no users row. */
  async function getActor(req: AuthenticatedRequest) {
    const userId = req.user?.claims?.sub;
    if (!userId) return null;
    const user = await storage.getUser(userId);
    if (!user) return null;
    return { userId, user };
  }

  function parseEntityType(raw: string): ScoringEntityType | null {
    return (scoringEntityTypes as readonly string[]).includes(raw)
      ? (raw as ScoringEntityType)
      : null;
  }

  // ── Config (per entity type) ───────────────────────────────────────────────

  app.get(
    "/api/scoring/:entityType/config",
    isAuthenticated,
    async (req: AuthenticatedRequest<{ entityType: string }>, res: Response) => {
      try {
        const entityType = parseEntityType(req.params.entityType);
        if (!entityType) {
          return res.status(404).json({ error: "Unknown entity type" });
        }
        const config = await getScoreConfigWithRules(entityType);
        const [statusSetting, enabledSetting, intervalSetting] = await Promise.all([
          getSystemSetting(SCORING_SWEEP_STATUS_SETTING),
          getSystemSetting(SCORING_SWEEP_ENABLED_SETTING),
          getSystemSetting(SCORING_SWEEP_INTERVAL_SETTING),
        ]);
        let sweepStatus: unknown = null;
        if (statusSetting?.value) {
          try {
            sweepStatus = JSON.parse(statusSetting.value);
          } catch {
            sweepStatus = null;
          }
        }
        res.json({
          config,
          maxRules: SCORE_RULE_MAX_PER_CONFIG,
          sweep: {
            status: sweepStatus,
            enabledSetting: enabledSetting?.value ?? null,
            intervalSetting: intervalSetting?.value ?? null,
          },
        });
      } catch (error) {
        console.error("Error loading scoring config:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.put(
    "/api/scoring/:entityType/config",
    isAuthenticated,
    requireTeamLead,
    async (
      req: ValidatedBodyRequest<UpdateScoreConfigBody, { entityType: string }>,
      res: Response,
    ) => {
      try {
        const entityType = parseEntityType(req.params.entityType);
        if (!entityType) {
          return res.status(404).json({ error: "Unknown entity type" });
        }
        const parsed = updateScoreConfigBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const body = parsed.data;
        const current = await ensureScoreConfig(entityType);
        const nextMin = body.scoreMin ?? current.scoreMin;
        const nextMax = body.scoreMax ?? current.scoreMax;
        if (nextMin >= nextMax) {
          return res
            .status(400)
            .json({ error: "Score range minimum must be below the maximum" });
        }
        const updated = await updateScoreConfig(entityType, body);
        if (!updated) return res.status(404).json({ error: "Config not found" });
        // Range/enabled changes alter every clamp — re-rank immediately.
        const recompute = await recomputeScoresForEntityType(entityType);
        res.json({ config: updated, recompute });
      } catch (error) {
        console.error("Error updating scoring config:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // ── Rules ──────────────────────────────────────────────────────────────────

  app.post(
    "/api/scoring/:entityType/rules",
    isAuthenticated,
    requireTeamLead,
    async (
      req: ValidatedBodyRequest<CreateScoreRuleBody, { entityType: string }>,
      res: Response,
    ) => {
      try {
        const entityType = parseEntityType(req.params.entityType);
        if (!entityType) {
          return res.status(404).json({ error: "Unknown entity type" });
        }
        const parsed = createScoreRuleBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const body = parsed.data;
        if (body.kind === "fit") {
          const problems = validateCriteriaSet(entityType, body.criteria);
          if (problems.length > 0) {
            return res.status(400).json({ error: problems });
          }
        }
        const config = await ensureScoreConfig(entityType);
        const existing = await countScoreRules(config.id);
        if (existing >= SCORE_RULE_MAX_PER_CONFIG) {
          return res.status(400).json({
            error: `Rule limit reached (${SCORE_RULE_MAX_PER_CONFIG} per entity type)`,
          });
        }
        const rule = await createScoreRule({
          configId: config.id,
          kind: body.kind,
          name: body.name,
          points: body.points,
          position: existing,
          criteria: body.kind === "fit" ? body.criteria : null,
          eventType: body.kind === "engagement" ? body.eventType : null,
          direction: body.kind === "engagement" ? body.direction : null,
          windowDays: body.kind === "engagement" ? body.windowDays : null,
          minCount: body.kind === "engagement" ? body.minCount : null,
        });
        // Synchronous re-rank: the new rule is visible in scores before the
        // caller's next read.
        const recompute = await recomputeScoresForEntityType(entityType);
        res.status(201).json({ rule, recompute });
      } catch (error) {
        console.error("Error creating score rule:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.patch(
    "/api/scoring/rules/:id",
    isAuthenticated,
    requireTeamLead,
    async (
      req: ValidatedBodyRequest<UpdateScoreRuleBody, { id: string }>,
      res: Response,
    ) => {
      try {
        const existing = await getScoreRule(req.params.id);
        if (!existing) return res.status(404).json({ error: "Rule not found" });
        const parsed = updateScoreRuleBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const body = parsed.data;
        // Kind is immutable — reject fields from the other kind instead of
        // silently ignoring them (an operator sending them is confused).
        if (existing.kind === "fit") {
          if (
            body.eventType !== undefined ||
            body.direction !== undefined ||
            body.windowDays !== undefined ||
            body.minCount !== undefined
          ) {
            return res
              .status(400)
              .json({ error: "Engagement fields are not valid on a fit rule" });
          }
        } else {
          if (body.criteria !== undefined) {
            return res
              .status(400)
              .json({ error: "Criteria are not valid on an engagement rule" });
          }
          const nextEventType = body.eventType ?? existing.eventType;
          const nextDirection = body.direction ?? existing.direction ?? "any";
          if (nextEventType === "meeting" && nextDirection !== "any") {
            return res
              .status(400)
              .json({ error: 'Meetings have no direction — use "any"' });
          }
        }
        if (body.criteria !== undefined) {
          const config = await getConfigForRule(existing.configId);
          const problems = validateCriteriaSet(
            (config?.entityType ?? "deal") as ScoringEntityType,
            body.criteria,
          );
          if (problems.length > 0) {
            return res.status(400).json({ error: problems });
          }
        }
        const updated = await updateScoreRule(existing.id, body);
        if (!updated) return res.status(404).json({ error: "Rule not found" });
        const entityType = await entityTypeForRuleConfig(existing.configId);
        const recompute = entityType
          ? await recomputeScoresForEntityType(entityType)
          : null;
        res.json({ rule: updated, recompute });
      } catch (error) {
        console.error("Error updating score rule:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.delete(
    "/api/scoring/rules/:id",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
      try {
        const existing = await getScoreRule(req.params.id);
        if (!existing) return res.status(404).json({ error: "Rule not found" });
        const entityType = await entityTypeForRuleConfig(existing.configId);
        const deleted = await deleteScoreRule(existing.id);
        if (!deleted) return res.status(404).json({ error: "Rule not found" });
        // Re-rank without the rule (zero rules left ⇒ scores clear).
        const recompute = entityType
          ? await recomputeScoresForEntityType(entityType)
          : null;
        res.json({ deleted: true, recompute });
      } catch (error) {
        console.error("Error deleting score rule:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  /** Rule → owning config entity type (rules only reference configs). */
  async function entityTypeForRuleConfig(
    configId: string,
  ): Promise<ScoringEntityType | null> {
    const config = await getConfigForRule(configId);
    return config ? (config.entityType as ScoringEntityType) : null;
  }

  async function getConfigForRule(configId: string) {
    for (const entityType of scoringEntityTypes) {
      const config = await ensureScoreConfig(entityType);
      if (config.id === configId) return config;
    }
    return null;
  }

  // ── Recompute + preview ────────────────────────────────────────────────────

  app.post(
    "/api/scoring/:entityType/recompute",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<{ entityType: string }>, res: Response) => {
      try {
        const entityType = parseEntityType(req.params.entityType);
        if (!entityType) {
          return res.status(404).json({ error: "Unknown entity type" });
        }
        // Synchronous convergence — the admin "Recompute now" lever.
        const result = await recomputeScoresForEntityType(entityType);
        res.json(result);
      } catch (error) {
        console.error("Error recomputing scores:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.post(
    "/api/scoring/preview",
    isAuthenticated,
    requireTeamLead,
    async (req: ValidatedBodyRequest<ScorePreviewBody>, res: Response) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });
        const parsed = scorePreviewBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const body = parsed.data;
        // Preview surfaces per-record engagement details — apply the deal
        // domain's own visibility rule to the sample record.
        const deal = await getDeal(body.entityId);
        if (!deal) return res.status(404).json({ error: "Deal not found" });
        const canSeeAll = hasRole(actor.user.role, "account_manager");
        if (!canSeeAll && deal.ownerId !== actor.userId) {
          return res.status(403).json({ error: "Access denied" });
        }
        if (body.draftRules) {
          for (const [i, draft] of body.draftRules.entries()) {
            if (draft.kind === "fit") {
              const problems = validateCriteriaSet(body.entityType, draft.criteria);
              if (problems.length > 0) {
                return res
                  .status(400)
                  .json({ error: [`Draft rule ${i + 1}: ${problems.join("; ")}`] });
              }
            }
          }
        }
        const preview = await previewScoreForEntity(
          body.entityType,
          body.entityId,
          body.draftRules,
        );
        if (!preview.found) return res.status(404).json({ error: "Deal not found" });
        res.json(preview);
      } catch (error) {
        console.error("Error previewing score:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );
}
