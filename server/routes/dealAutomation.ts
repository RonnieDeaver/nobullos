import type { Express, Response } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";
import type {
  AuthenticatedRequest,
  ValidatedBodyRequest,
} from "./requestContext";
import { z } from "zod";
import {
  createDealAutomationRuleBodySchema,
  updateDealAutomationRuleBodySchema,
  type CreateDealAutomationRuleBody,
  type UpdateDealAutomationRuleBody,
} from "@shared/schema";
import {
  AutomationStageError,
  createAutomationRule,
  deleteAutomationRule,
  getAutomationRule,
  getPendingEventStats,
  listAutomationRulesWithStats,
  listAutomationRuns,
  updateAutomationRule,
} from "../storage/dealAutomationStorage";
import {
  DEAL_AUTOMATION_KILL_SWITCH_KEY,
  isDealAutomationEnabled,
} from "../services/dealAutomationEngine";
import { requeuePendingDealStageEvents } from "../services/dealAutomationQueue";
import { setSystemSetting } from "../storage/settingsStorage";
import {
  dealTriggersConfigSchema,
  dealTriggerEventStatuses,
  dealTriggerTypes,
  pandadocKnownStatuses,
  type DealTriggerEventStatus,
  type DealTriggersConfig,
  type DealTriggerType,
} from "@shared/schema";
import {
  readDealTriggersConfig,
  reprocessAfterPandadocLink,
  reprocessTriggerEvent,
  saveDealTriggersConfig,
} from "../services/dealTriggers";
import {
  getDealById,
  getPandadocDocumentRow,
  getStageBySlug,
  linkPandadocDocumentToDeal,
  listTriggerEvents,
  listUnlinkedMappedPandadocDocuments,
} from "../storage/dealTriggersStorage";
import { getDefaultPipeline } from "../storage/dealsStorage";

const killSwitchBodySchema = z.object({ enabled: z.boolean() });
const requeueBodySchema = z.object({
  olderThanMs: z.number().int().min(0).max(30 * 24 * 60 * 60 * 1000).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
const linkDealBodySchema = z.object({
  /** null unlinks the document. */
  dealId: z.string().min(1).nullable(),
});

/**
 * Task #4332 — soft-validate configured stage slugs against the default
 * pipeline so typos surface at save time instead of as skipped events.
 * Returns an error string or null when the config is referentially sound.
 */
async function validateTriggerConfigStages(
  config: DealTriggersConfig,
): Promise<string | null> {
  const pipeline = await getDefaultPipeline();
  if (!pipeline) return null; // pipeline seeds lazily — nothing to check yet
  const bookingStage = await getStageBySlug(pipeline.id, config.bookingStageSlug);
  if (!bookingStage) {
    return `Booking stage "${config.bookingStageSlug}" does not exist in the default pipeline`;
  }
  if (bookingStage.stageType !== "open") {
    return `Booking stage "${config.bookingStageSlug}" must be an open stage`;
  }
  for (const [status, slug] of Object.entries(config.pandadocStageMap)) {
    const stage = await getStageBySlug(pipeline.id, slug);
    if (!stage) {
      return `PandaDoc mapping for "${status}" points at unknown stage "${slug}"`;
    }
  }
  return null;
}

/**
 * Task #4331 — deal stage automation admin surface.
 *
 * Everything here is team_lead+ (rule management mirrors stage
 * configuration in deals.ts — the same people who shape the pipeline
 * shape its automations). Rule bodies are zod-parsed; pipelineId is
 * always DERIVED server-side from the trigger stage, and cross-pipeline
 * from-stage filters are rejected in storage.
 *
 * The kill switch is the `deal_automation_enabled` system setting
 * (missing = enabled). setSystemSetting records the acting user, giving
 * the flip an audit trail; the engine reads the key FRESH per event so a
 * flip takes effect on the next stage move.
 */
export function registerDealAutomationRoutes(app: Express): void {
  // ── Rules ──────────────────────────────────────────────────────────────────

  app.get(
    "/api/deal-automation/rules",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const pipelineId =
          typeof req.query.pipelineId === "string" && req.query.pipelineId
            ? req.query.pipelineId
            : undefined;
        const rules = await listAutomationRulesWithStats(pipelineId);
        res.json(rules);
      } catch (error) {
        console.error("Error listing automation rules:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.post(
    "/api/deal-automation/rules",
    isAuthenticated,
    requireTeamLead,
    async (
      req: ValidatedBodyRequest<CreateDealAutomationRuleBody>,
      res: Response,
    ) => {
      try {
        const parsed = createDealAutomationRuleBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const userId = req.user?.claims?.sub;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        const rule = await createAutomationRule({
          stageId: parsed.data.stageId,
          fromStageId: parsed.data.fromStageId ?? null,
          name: parsed.data.name,
          enabled: parsed.data.enabled ?? true,
          actions: parsed.data.actions,
          createdBy: userId,
        });
        res.status(201).json(rule);
      } catch (error) {
        if (error instanceof AutomationStageError) {
          return res.status(400).json({ error: error.message });
        }
        console.error("Error creating automation rule:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.patch(
    "/api/deal-automation/rules/:id",
    isAuthenticated,
    requireTeamLead,
    async (
      req: ValidatedBodyRequest<UpdateDealAutomationRuleBody, { id: string }>,
      res: Response,
    ) => {
      try {
        const parsed = updateDealAutomationRuleBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const userId = req.user?.claims?.sub;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        const updated = await updateAutomationRule(
          req.params.id,
          parsed.data,
          userId,
        );
        if (!updated) return res.status(404).json({ error: "Rule not found" });
        res.json(updated);
      } catch (error) {
        if (error instanceof AutomationStageError) {
          return res.status(400).json({ error: error.message });
        }
        console.error("Error updating automation rule:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.delete(
    "/api/deal-automation/rules/:id",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const existing = await getAutomationRule(req.params.id as string);
        if (!existing) return res.status(404).json({ error: "Rule not found" });
        await deleteAutomationRule(existing.id);
        res.json({ deleted: true });
      } catch (error) {
        console.error("Error deleting automation rule:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // ── Run history ────────────────────────────────────────────────────────────

  app.get(
    "/api/deal-automation/runs",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const ruleId =
          typeof req.query.ruleId === "string" && req.query.ruleId
            ? req.query.ruleId
            : undefined;
        const dealId =
          typeof req.query.dealId === "string" && req.query.dealId
            ? req.query.dealId
            : undefined;
        const limitRaw =
          typeof req.query.limit === "string"
            ? parseInt(req.query.limit, 10)
            : NaN;
        const runs = await listAutomationRuns({
          ruleId,
          dealId,
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
        });
        res.json(runs);
      } catch (error) {
        console.error("Error listing automation runs:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // ── Status + controls ──────────────────────────────────────────────────────

  app.get(
    "/api/deal-automation/status",
    isAuthenticated,
    requireTeamLead,
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const [enabled, pending] = await Promise.all([
          isDealAutomationEnabled(),
          getPendingEventStats(),
        ]);
        res.json({
          enabled,
          killSwitchKey: DEAL_AUTOMATION_KILL_SWITCH_KEY,
          pendingEvents: pending.pendingCount,
          oldestPendingAt: pending.oldestPendingAt,
        });
      } catch (error) {
        console.error("Error reading automation status:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.post(
    "/api/deal-automation/kill-switch",
    isAuthenticated,
    requireTeamLead,
    async (
      req: ValidatedBodyRequest<{ enabled: boolean }>,
      res: Response,
    ) => {
      try {
        const parsed = killSwitchBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const userId = req.user?.claims?.sub;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        await setSystemSetting(
          DEAL_AUTOMATION_KILL_SWITCH_KEY,
          parsed.data.enabled ? "true" : "false",
          userId,
        );
        console.log(
          `[dealAutomation] kill switch set to ${parsed.data.enabled ? "ENABLED" : "DISABLED"} by ${userId}`,
        );
        res.json({ enabled: parsed.data.enabled });
      } catch (error) {
        console.error("Error setting automation kill switch:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // ── Native triggers (Task #4332) ───────────────────────────────────────────
  // Booking / PandaDoc / Front-reply auto-move hooks: per-hook toggles +
  // mappings (system settings, fresh-read per event), the durable trigger
  // event run log, and the PandaDoc manual-linking surface.

  app.get(
    "/api/deal-automation/triggers/config",
    isAuthenticated,
    requireTeamLead,
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const config = await readDealTriggersConfig();
        res.json({ config, knownPandadocStatuses: pandadocKnownStatuses });
      } catch (error) {
        console.error("Error reading trigger config:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.put(
    "/api/deal-automation/triggers/config",
    isAuthenticated,
    requireTeamLead,
    async (req: ValidatedBodyRequest<DealTriggersConfig>, res: Response) => {
      try {
        const parsed = dealTriggersConfigSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const userId = req.user?.claims?.sub;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        const stageError = await validateTriggerConfigStages(parsed.data);
        if (stageError) return res.status(400).json({ error: stageError });
        await saveDealTriggersConfig(parsed.data, userId);
        res.json({ config: parsed.data });
      } catch (error) {
        console.error("Error saving trigger config:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.get(
    "/api/deal-automation/triggers/events",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const typeRaw = typeof req.query.type === "string" ? req.query.type : undefined;
        const statusRaw =
          typeof req.query.status === "string" ? req.query.status : undefined;
        const limitRaw =
          typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : NaN;
        const triggerType = dealTriggerTypes.includes(typeRaw as DealTriggerType)
          ? (typeRaw as DealTriggerType)
          : undefined;
        const status = dealTriggerEventStatuses.includes(
          statusRaw as DealTriggerEventStatus,
        )
          ? (statusRaw as DealTriggerEventStatus)
          : undefined;
        const events = await listTriggerEvents({
          triggerType,
          status,
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
        });
        res.json(events);
      } catch (error) {
        console.error("Error listing trigger events:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.post(
    "/api/deal-automation/triggers/events/:id/reprocess",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await reprocessTriggerEvent(req.params.id as string);
        if (!result.ok) {
          if (result.error === "not_found") {
            return res.status(404).json({ error: "Event not found" });
          }
          return res.status(409).json({
            error:
              "Event is not reprocessable (already processed, or another reprocess is in flight)",
          });
        }
        res.json(result.event);
      } catch (error) {
        console.error("Error reprocessing trigger event:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.get(
    "/api/deal-automation/triggers/pandadoc/unlinked",
    isAuthenticated,
    requireTeamLead,
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const config = await readDealTriggersConfig();
        const docs = await listUnlinkedMappedPandadocDocuments(
          Object.keys(config.pandadocStageMap),
        );
        res.json(docs);
      } catch (error) {
        console.error("Error listing unlinked PandaDoc documents:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  app.post(
    "/api/deal-automation/triggers/pandadoc/:id/link-deal",
    isAuthenticated,
    requireTeamLead,
    async (
      req: ValidatedBodyRequest<{ dealId: string | null }, { id: string }>,
      res: Response,
    ) => {
      try {
        const parsed = linkDealBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const doc = await getPandadocDocumentRow(req.params.id);
        if (!doc) return res.status(404).json({ error: "Document not found" });
        if (parsed.data.dealId) {
          const deal = await getDealById(parsed.data.dealId);
          if (!deal) return res.status(400).json({ error: "Deal not found" });
        }
        const updated = await linkPandadocDocumentToDeal(doc.id, parsed.data.dealId);
        // Linking unblocks the doc's latest no_deal_link skip — reprocess it
        // right away so the move happens without waiting for the next sync.
        const reprocessedEvent = parsed.data.dealId
          ? await reprocessAfterPandadocLink(doc.id)
          : null;
        res.json({ document: updated, reprocessedEvent });
      } catch (error) {
        console.error("Error linking PandaDoc document to deal:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );

  // Manual recovery lever: re-enqueue pending events whose post-commit
  // kick was lost (complements the deployment-gated boot catch-up).
  app.post(
    "/api/deal-automation/events/requeue",
    isAuthenticated,
    requireTeamLead,
    async (
      req: ValidatedBodyRequest<{ olderThanMs?: number; limit?: number }>,
      res: Response,
    ) => {
      try {
        const parsed = requeueBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const result = await requeuePendingDealStageEvents({
          olderThanMs: parsed.data.olderThanMs,
          limit: parsed.data.limit,
        });
        res.json(result);
      } catch (error) {
        console.error("Error requeueing automation events:", error);
        res.status(500).json({ error: "Server error" });
      }
    },
  );
}
