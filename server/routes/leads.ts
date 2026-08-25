import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { hasRole, requireAccountManager } from "./middleware";
import type { AuthenticatedRequest } from "./requestContext";
import {
  clientLifecycleStages,
  leadSources,
  mergeLeadBodySchema,
  setClientLifecycleBodySchema,
} from "@shared/schema";
import {
  getClientLifecycleHistory,
  getProspectClients,
  getWebsiteInquiriesForLead,
  mergeLeadIntoClient,
  searchMergeCandidateClients,
  setClientLifecycleManual,
  LEADS_LIST_DEFAULT_LIMIT,
  LEADS_LIST_MAX_LIMIT,
} from "../storage/leadLifecycleStorage";
import { listDeals } from "../storage/dealsStorage";

/**
 * Task #4330 — Leads view routes.
 *
 * Lists lifecycle-gated prospect records (lead / session_booked /
 * opportunity — 'customer' only via an explicit stage filter for "recently
 * converted" checks). Access mirrors the deals domain: account_manager+
 * see every lead; sales users are scoped to leads they own (intake-minted
 * leads have no owner until claimed, so sales see none by default).
 *
 * Lifecycle mutation is manual-correction ONLY (AM+): forward jumps and
 * backward corrections both allowed here, always audited to
 * client_lifecycle_history with the acting user. Automatic movement
 * (intake/deal hooks) lives server-side and never goes backwards.
 */

const leadsListQuerySchema = z.object({
  stage: z
    .union([z.enum(clientLifecycleStages), z.array(z.enum(clientLifecycleStages))])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  source: z.enum(leadSources).optional(),
  limit: z.coerce.number().int().min(1).max(LEADS_LIST_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// Task #4584 — merge-target typeahead query: short bounded search string only.
const mergeCandidatesQuerySchema = z.object({
  q: z.string().trim().min(2).max(100),
  // client ids are uuid-defaulted but the column is plain text — bound, don't format-check
  exclude: z.string().min(1).max(100).optional(),
});

export function registerLeadsRoutes(app: Express): void {
  /** Loads the acting user; null when the session has no users row. */
  async function getActor(req: AuthenticatedRequest) {
    const userId = req.user?.claims?.sub;
    if (!userId) return null;
    const user = await storage.getUser(userId);
    if (!user) return null;
    return { userId, user };
  }

  // List prospects (Leads view).
  app.get("/api/leads", isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const actor = await getActor(req);
      if (!actor) return res.status(401).json({ error: "Unauthorized" });

      const parsed = leadsListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues });
      }
      const q = parsed.data;

      const scopedToOwner = !hasRole(actor.user.role, "account_manager");
      const { data, total } = await getProspectClients({
        stages: q.stage,
        leadSource: q.source,
        ownerId: scopedToOwner ? actor.userId : undefined,
        limit: q.limit ?? LEADS_LIST_DEFAULT_LIMIT,
        offset: q.offset ?? 0,
      });
      return res.json({ data, total });
    } catch (err) {
      console.error("[Leads] list failed:", err);
      return res.status(500).json({ error: "Failed to load leads" });
    }
  });

  // Task #4584 — merge-target search (AM+, matching the merge gate below).
  // Bounded typeahead over ALL clients (customers included) by name/email so
  // the merge picker isn't limited to the leads on the current page.
  // Registered before /api/leads/:id so the literal path wins.
  app.get(
    "/api/leads/merge-candidates",
    isAuthenticated,
    requireAccountManager,
    async (req: AuthenticatedRequest, res) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });

        const parsed = mergeCandidatesQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }

        const data = await searchMergeCandidateClients({
          q: parsed.data.q,
          excludeId: parsed.data.exclude,
          includeDemo: actor.user.role === "ceo",
        });
        return res.json({ data });
      } catch (err) {
        console.error("[Leads] merge-candidate search failed:", err);
        return res.status(500).json({ error: "Failed to search merge targets" });
      }
    },
  );

  // Lead detail: record + lifecycle history + linked inquiries, meetings, deals.
  app.get("/api/leads/:id", isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const actor = await getActor(req);
      if (!actor) return res.status(401).json({ error: "Unauthorized" });

      const client = await storage.getClient(req.params.id);
      if (!client) return res.status(404).json({ error: "Lead not found" });
      if (client.isDemo && actor.user.role !== "ceo") {
        return res.status(404).json({ error: "Lead not found" });
      }
      if (
        !hasRole(actor.user.role, "account_manager") &&
        client.ownerId !== actor.userId
      ) {
        return res.status(403).json({ error: "Access denied" });
      }

      const [history, inquiries, meetings, clientDeals] = await Promise.all([
        getClientLifecycleHistory(client.id),
        getWebsiteInquiriesForLead(client.id),
        storage.listScheduledMeetingsForClient(client.id),
        listDeals({ clientId: client.id, includeArchived: false }),
      ]);
      return res.json({ client, history, inquiries, meetings, deals: clientDeals });
    } catch (err) {
      console.error("[Leads] detail failed:", err);
      return res.status(500).json({ error: "Failed to load lead" });
    }
  });

  // Manual lifecycle correction (AM+). Any direction; always audited.
  app.post(
    "/api/leads/:id/lifecycle",
    isAuthenticated,
    requireAccountManager,
    async (req: AuthenticatedRequest, res) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });

        const parsed = setClientLifecycleBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }

        const client = await storage.getClient(req.params.id);
        if (!client) return res.status(404).json({ error: "Lead not found" });
        if (client.isDemo && actor.user.role !== "ceo") {
          return res.status(404).json({ error: "Lead not found" });
        }

        const result = await setClientLifecycleManual(
          client.id,
          parsed.data.stage,
          actor.userId,
          parsed.data.reason ?? null,
        );
        return res.json({
          changed: result.changed,
          fromStage: result.fromStage,
          toStage: result.toStage,
          client: result.client ?? client,
        });
      } catch (err) {
        console.error("[Leads] lifecycle set failed:", err);
        return res.status(500).json({ error: "Failed to update lifecycle" });
      }
    },
  );

  // Task #4424 — merge a duplicate lead (:id, the loser) into another
  // record (AM+). All child rows relink atomically; the loser is deleted;
  // the survivor keeps the furthest-forward stage + earliest created_at,
  // with a manual-source history entry documenting who merged what.
  app.post(
    "/api/leads/:id/merge",
    isAuthenticated,
    requireAccountManager,
    async (req: AuthenticatedRequest, res) => {
      try {
        const actor = await getActor(req);
        if (!actor) return res.status(401).json({ error: "Unauthorized" });

        const parsed = mergeLeadBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }

        const source = await storage.getClient(req.params.id);
        if (!source) return res.status(404).json({ error: "Lead not found" });
        if (source.isDemo && actor.user.role !== "ceo") {
          return res.status(404).json({ error: "Lead not found" });
        }
        const target = await storage.getClient(parsed.data.targetClientId);
        if (!target || (target.isDemo && actor.user.role !== "ceo")) {
          return res.status(404).json({ error: "Merge target not found" });
        }

        const result = await mergeLeadIntoClient(
          source.id,
          target.id,
          actor.userId,
          parsed.data.reason ?? null,
        );
        if (!result.ok) {
          if (result.error === "source_not_found") {
            return res.status(404).json({ error: "Lead not found" });
          }
          if (result.error === "target_not_found") {
            return res.status(404).json({ error: "Merge target not found" });
          }
          if (result.error === "same_record") {
            return res.status(400).json({ error: "Cannot merge a lead into itself" });
          }
          // source_is_customer
          return res.status(400).json({ error: "Only prospect records can be merged away" });
        }
        return res.json({ merged: true, winner: result.winner, moved: result.moved });
      } catch (err) {
        console.error("[Leads] merge failed:", err);
        return res.status(500).json({ error: "Failed to merge lead" });
      }
    },
  );
}
