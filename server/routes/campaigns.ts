import type { Express } from "express";
import { z } from "zod";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireAccountManager } from "./middleware";
import type { AuthenticatedRequest } from "./requestContext";
import {
  buildCampaignLinkUrl,
  createCampaignBodySchema,
  createCampaignLinkBodySchema,
  normalizeUtmCampaign,
  updateCampaignBodySchema,
  type CampaignLink,
  type MarketingCampaign,
} from "@shared/schema";
import {
  CampaignKeyConflictError,
  createCampaign,
  createCampaignLink,
  deleteCampaign,
  deleteCampaignLink,
  getAttributionReport,
  getCampaignDetail,
  listCampaigns,
  updateCampaign,
  type AttributionDateRange,
} from "../storage/campaignStorage";

/**
 * Task #4337 — Campaigns & first-touch attribution routes.
 *
 * Access: account_manager+ for EVERYTHING (reads included) — these surfaces
 * aggregate revenue across the whole pipeline, and sales has no owner-scoped
 * slice of an aggregate. Mirrors the strictest end of the deals domain.
 *
 * Semantics owned here:
 *   - Campaigns attribute BY KEY (normalized utm_campaign), not FK — see
 *     server/storage/campaignStorage.ts. Duplicate keys 409 with code
 *     `utm_campaign_conflict`.
 *   - Tracked links are create/delete only; the campaign-tagged URL is
 *     COMPUTED on every response (utm_campaign always the campaign's key),
 *     so a key edit re-tags every link automatically.
 *   - The attribution report takes optional from/to (YYYY-MM-DD, UTC days,
 *     both inclusive) — "this quarter" is just a client-side preset.
 */

const reportDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const reportQuerySchema = z.object({
  from: reportDateSchema.optional(),
  to: reportDateSchema.optional(),
});

const DAY_MS = 86_400_000;

function linkWithUrl(campaign: MarketingCampaign, link: CampaignLink) {
  return {
    ...link,
    url: buildCampaignLinkUrl(link.destinationUrl, {
      utmSource: link.utmSource,
      utmMedium: link.utmMedium,
      utmCampaign: campaign.utmCampaign,
      utmTerm: link.utmTerm,
      utmContent: link.utmContent,
    }),
  };
}

export function registerCampaignRoutes(app: Express): void {
  // List campaigns with all-time attributed stats.
  app.get(
    "/api/campaigns",
    isAuthenticated,
    requireAccountManager,
    async (_req: AuthenticatedRequest, res) => {
      try {
        return res.json({ data: await listCampaigns() });
      } catch (err) {
        console.error("[Campaigns] list failed:", err);
        return res.status(500).json({ error: "Failed to load campaigns" });
      }
    },
  );

  // Create a campaign. Key collisions 409 (unique index resolves races).
  app.post(
    "/api/campaigns",
    isAuthenticated,
    requireAccountManager,
    async (req: AuthenticatedRequest, res) => {
      try {
        const parsed = createCampaignBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        if (!normalizeUtmCampaign(parsed.data.utmCampaign)) {
          return res.status(400).json({
            error: "utmCampaign must contain at least one non-space character",
          });
        }
        const userId = req.user?.claims?.sub;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        const campaign = await createCampaign(parsed.data, userId);
        return res.status(201).json(campaign);
      } catch (err) {
        if (err instanceof CampaignKeyConflictError) {
          return res
            .status(409)
            .json({ error: err.message, code: "utm_campaign_conflict" });
        }
        console.error("[Campaigns] create failed:", err);
        return res.status(500).json({ error: "Failed to create campaign" });
      }
    },
  );

  // Campaign detail: record + links (with computed URLs) + stats +
  // attributed leads/deals.
  app.get(
    "/api/campaigns/:id",
    isAuthenticated,
    requireAccountManager,
    async (req: AuthenticatedRequest, res) => {
      try {
        const detail = await getCampaignDetail(req.params.id);
        if (!detail) return res.status(404).json({ error: "Campaign not found" });
        return res.json({
          ...detail,
          links: detail.links.map((l) => linkWithUrl(detail.campaign, l)),
        });
      } catch (err) {
        console.error("[Campaigns] detail failed:", err);
        return res.status(500).json({ error: "Failed to load campaign" });
      }
    },
  );

  // Update (partial): name/key/period/notes/isArchived. Key edits re-point
  // attribution — deliberate (see storage header).
  app.patch(
    "/api/campaigns/:id",
    isAuthenticated,
    requireAccountManager,
    async (req: AuthenticatedRequest, res) => {
      try {
        const parsed = updateCampaignBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        if (
          parsed.data.utmCampaign !== undefined &&
          !normalizeUtmCampaign(parsed.data.utmCampaign)
        ) {
          return res.status(400).json({
            error: "utmCampaign must contain at least one non-space character",
          });
        }
        const updated = await updateCampaign(req.params.id, parsed.data);
        if (!updated) return res.status(404).json({ error: "Campaign not found" });
        return res.json(updated);
      } catch (err) {
        if (err instanceof CampaignKeyConflictError) {
          return res
            .status(409)
            .json({ error: err.message, code: "utm_campaign_conflict" });
        }
        console.error("[Campaigns] update failed:", err);
        return res.status(500).json({ error: "Failed to update campaign" });
      }
    },
  );

  // Delete the campaign record. Stamped attribution on clients/deals
  // survives by design (string keys, not FKs).
  app.delete(
    "/api/campaigns/:id",
    isAuthenticated,
    requireAccountManager,
    async (req: AuthenticatedRequest, res) => {
      try {
        const deleted = await deleteCampaign(req.params.id);
        if (!deleted) return res.status(404).json({ error: "Campaign not found" });
        return res.json({ ok: true });
      } catch (err) {
        console.error("[Campaigns] delete failed:", err);
        return res.status(500).json({ error: "Failed to delete campaign" });
      }
    },
  );

  // Add a tracked link (UTM builder row) to a campaign.
  app.post(
    "/api/campaigns/:id/links",
    isAuthenticated,
    requireAccountManager,
    async (req: AuthenticatedRequest, res) => {
      try {
        const parsed = createCampaignLinkBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const userId = req.user?.claims?.sub;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });
        const created = await createCampaignLink(req.params.id, parsed.data, userId);
        if (!created) return res.status(404).json({ error: "Campaign not found" });
        return res.status(201).json(linkWithUrl(created.campaign, created.link));
      } catch (err) {
        console.error("[Campaigns] link create failed:", err);
        return res.status(500).json({ error: "Failed to add link" });
      }
    },
  );

  // Remove a tracked link.
  app.delete(
    "/api/campaigns/:id/links/:linkId",
    isAuthenticated,
    requireAccountManager,
    async (req: AuthenticatedRequest, res) => {
      try {
        const deleted = await deleteCampaignLink(req.params.id, req.params.linkId);
        if (!deleted) return res.status(404).json({ error: "Link not found" });
        return res.json({ ok: true });
      } catch (err) {
        console.error("[Campaigns] link delete failed:", err);
        return res.status(500).json({ error: "Failed to delete link" });
      }
    },
  );

  // Source/campaign attribution report ("where did this quarter's won
  // deals come from"). from/to are inclusive YYYY-MM-DD UTC days.
  app.get(
    "/api/attribution/report",
    isAuthenticated,
    requireAccountManager,
    async (req: AuthenticatedRequest, res) => {
      try {
        const parsed = reportQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error.issues });
        }
        const { from, to } = parsed.data;
        const range: AttributionDateRange = {
          fromUtc: from ? new Date(`${from}T00:00:00.000Z`) : null,
          toUtcExclusive: to
            ? new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS)
            : null,
        };
        if (
          range.fromUtc &&
          range.toUtcExclusive &&
          range.fromUtc.getTime() >= range.toUtcExclusive.getTime()
        ) {
          return res.status(400).json({ error: "'from' must be on or before 'to'" });
        }
        return res.json(await getAttributionReport(range));
      } catch (err) {
        console.error("[Campaigns] attribution report failed:", err);
        return res.status(500).json({ error: "Failed to build attribution report" });
      }
    },
  );
}
