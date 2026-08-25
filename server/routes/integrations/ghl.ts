import type { Express } from "express";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireAccountManager, requireTeamLead } from "../middleware";
import { invalidateIntegrationStatus } from "../../services/integrationStatusCache";

export function registerIntegrationsGhlRoutes(app: Express) {
  app.post("/api/integrations/ghl/connect", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const privateToken = typeof req.body?.privateToken === "string" ? req.body.privateToken.trim() : "";
    const locationId = typeof req.body?.locationId === "string" ? req.body.locationId.trim() : "";
    if (!privateToken || privateToken.length < 12) {
      return res.status(400).json({ error: "A valid HighLevel private integration token is required." });
    }
    if (!locationId || locationId.length > 128) {
      return res.status(400).json({ error: "A valid HighLevel location ID is required." });
    }
    try {
      const ghl = await import("../../services/ghlIntegration");
      const actorId = req.user?.claims?.sub || req.user?.id || undefined;
      await ghl.setPrivateIntegrationCredentials(privateToken, locationId, actorId);
      const probe = await ghl.probeConnection();
      await invalidateIntegrationStatus("ghl");
      if (probe.outcome === "connected") return res.json({ ok: true });
      if (probe.outcome === "unauthorized" && ghl.isTerminalGhlAuthReason(probe.reason)) {
        await ghl.disconnect(actorId, { trigger: "connect_terminal_auth_error", reason: probe.reason });
        await invalidateIntegrationStatus("ghl");
        return res.status(400).json({
          error: `HighLevel rejected the token or its scopes (${probe.reason}). Re-enter a token with the approved location scopes.`,
          reason: probe.reason,
        });
      }
      return res.status(202).json({
        ok: true,
        warning: `Credentials saved but verification is temporarily unavailable (${probe.reason}). They were preserved and will be rechecked automatically.`,
        reason: probe.reason,
      });
    } catch (error: any) {
      return res.status(500).json({ error: "Could not save HighLevel credentials." });
    }
  });

  app.post("/api/integrations/ghl/disconnect", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const ghl = await import("../../services/ghlIntegration");
      const actorId = req.user?.claims?.sub || req.user?.id || undefined;
      await ghl.disconnect(actorId, { trigger: "manual_disconnect" });
      await invalidateIntegrationStatus("ghl");
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: "Could not disconnect HighLevel." });
    }
  });

  // Explicitly cached: this endpoint must never turn an admin render into a
  // live vendor probe. The Hub is the canonical status reader.
  app.get("/api/integrations/ghl/status", isAuthenticated, requireAccountManager, async (_req, res) => {
    const { getCachedIntegrationStatus } = await import("../../services/integrationStatusCache");
    const { ghlStatusLoader } = await import("../../services/integrationStatusLoaders");
    const status = await getCachedIntegrationStatus("ghl", ghlStatusLoader);
    return res.json({
      connected: status.value?.connected ?? null,
      disconnectReason: status.value?.disconnectReason ?? null,
      lastCheckedAt: status.lastCheckedAt,
      lastProbeError: status.lastProbeError,
    });
  });
}