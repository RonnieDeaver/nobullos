// @db-pool-intent: api
/**
 * PR9 split (Task f1425127) — extracted VERBATIM from server/routes.ts
 * (formerly inline at lines 4853–5378 at split time).
 *
 * Slack channel listing plus the per-feature alert-channel settings routes: match-settings alerts and heatmap coverage-check settings. (The Zoom comparative-reset alert-channel routes that used to live between them were retired in Task #4177 with the comparative-semantic card — its /api/agents/shadow-metrics feed never existed.)
 *
 * Mount-order contract: registerAlertChannelSettingsRoutes(app) is invoked from
 * registerRoutes() in server/routes.ts at the exact position the inline
 * registrations previously occupied, preserving global registration order.
 * Do not reorder registrations here and do not mount this module elsewhere.
 */
import type { Express } from "express";
import { db } from "../db";
import { eq, desc } from "drizzle-orm";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";
import { storage } from "../storage";
import {
  postMessage,
  listChannels,
  isConnected as isSlackConnected,
  getChannelInfo,
  getWorkspaceInfo,
} from "../services/slackIntegration";
import { attachUserInfoToAudit } from "./auditAuxHelpers";
export function registerAlertChannelSettingsRoutes(app: Express): void {
  app.get("/api/integrations/slack/channels", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      if (!(await isSlackConnected())) {
        return res.status(400).json({ error: "Slack is not connected" });
      }
      const channels = await listChannels();
      const memberChannels = channels
        .filter((c) => c.is_member)
        .map((c) => ({ id: c.id, name: c.name, isPrivate: c.is_private }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ channels: memberChannels });
    } catch (err: any) {
      console.error("[SlackChannels] List failed:", err.message);
      res.status(500).json({ error: "Failed to list Slack channels" });
    }
  });

  app.get("/api/admin/match-settings/alert-channel", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { matchSettingAlertChannelStatus } = await import("../services/matchSettingsAlerts");
      const status = await matchSettingAlertChannelStatus();
      res.json(status);
    } catch (err: any) {
      console.error("[MatchSettingsAlerts] GET channel failed:", err.message);
      res.status(500).json({ error: "Failed to load alert channel" });
    }
  });

  app.put("/api/admin/match-settings/alert-channel", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const { channelId } = req.body || {};
    if (channelId !== null && channelId !== undefined && typeof channelId !== "string") {
      return res.status(400).json({ error: "channelId must be a string or null" });
    }
    try {
      const trimmed = typeof channelId === "string" ? channelId.trim() : null;
      if (trimmed) {
        if (!(await isSlackConnected())) {
          return res.status(400).json({ error: "Slack is not connected" });
        }
        const channels = await listChannels();
        const found = channels.find((c) => c.id === trimmed);
        if (!found) {
          return res.status(400).json({ error: "Channel not found in Slack workspace" });
        }
        if (!found.is_member) {
          return res.status(400).json({ error: "Bot is not a member of that channel" });
        }
      }
      const { setMatchSettingsAlertChannelId, matchSettingAlertChannelStatus } = await import(
        "../services/matchSettingsAlerts"
      );
      await setMatchSettingsAlertChannelId(trimmed || null, req.user?.claims?.sub ?? "system");
      const status = await matchSettingAlertChannelStatus();
      res.json(status);
    } catch (err: any) {
      console.error("[MatchSettingsAlerts] PUT channel failed:", err.message);
      res.status(500).json({ error: "Failed to update alert channel" });
    }
  });

  app.get("/api/admin/match-settings/alert-channel/history", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { MATCH_SETTINGS_ALERT_SLACK_CHANNEL_SETTING_KEY } = await import(
        "../services/matchSettingsAlerts"
      );
      const { ensureAdminSettingAuditTable } = await import("../storage/settingsStorage");
      await ensureAdminSettingAuditTable();
      const { adminSettingAudit } = await import("@shared/schema");
      const entries = await db
        .select({
          id: adminSettingAudit.id,
          settingKey: adminSettingAudit.settingKey,
          scope: adminSettingAudit.scope,
          changedBy: adminSettingAudit.changedBy,
          oldValues: adminSettingAudit.oldValues,
          newValues: adminSettingAudit.newValues,
          changedAt: adminSettingAudit.changedAt,
        })
        .from(adminSettingAudit)
        .where(eq(adminSettingAudit.settingKey, MATCH_SETTINGS_ALERT_SLACK_CHANNEL_SETTING_KEY))
        .orderBy(desc(adminSettingAudit.changedAt));
      const history = await attachUserInfoToAudit(entries);
      res.json({ history });
    } catch (err: any) {
      console.error("[MatchSettingsAlerts] History fetch failed:", err?.message);
      res.status(500).json({ error: "Failed to fetch alert channel history" });
    }
  });

  app.get(
    "/api/admin/match-settings/alert-channel/test-history",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { getRecentAlertChannelTests } = await import(
          "../services/matchSettingsAlerts"
        );
        const attempts = await getRecentAlertChannelTests();
        res.json({ attempts });
      } catch (err: any) {
        console.error(
          "[MatchSettingsAlerts] Test history fetch failed:",
          err?.message,
        );
        res.status(500).json({ error: "Failed to fetch alert test history" });
      }
    },
  );

  app.get(
    "/api/admin/match-settings/alert-channel/channel-info",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      const channelId = typeof req.query?.channelId === "string" ? req.query.channelId.trim() : "";
      if (!channelId) {
        return res.status(400).json({ error: "channelId query param is required" });
      }
      try {
        if (!(await isSlackConnected())) {
          return res.json({
            channelId,
            slackConnected: false,
            channel: null,
            permalink: null,
            workspace: null,
          });
        }
        const [channel, workspace] = await Promise.all([
          getChannelInfo(channelId).catch((err) => {
            console.error("[MatchSettingsAlerts] channel-info lookup failed:", err?.message);
            return null;
          }),
          getWorkspaceInfo().catch(() => null),
        ]);
        let permalink: string | null = null;
        if (workspace?.url) {
          const base = workspace.url.replace(/\/$/, "");
          permalink = `${base}/archives/${channelId}`;
        } else if (workspace?.teamId) {
          permalink = `slack://channel?team=${workspace.teamId}&id=${channelId}`;
        }
        return res.json({
          channelId,
          slackConnected: true,
          channel,
          permalink,
          workspace: workspace
            ? { teamId: workspace.teamId, teamName: workspace.teamName, url: workspace.url }
            : null,
        });
      } catch (err: any) {
        console.error("[MatchSettingsAlerts] channel-info failed:", err?.message);
        res.status(500).json({ error: "Failed to load channel details" });
      }
    },
  );

  app.post("/api/admin/match-settings/alert-channel/test", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const { channelId } = req.body || {};
    if (channelId !== null && channelId !== undefined && typeof channelId !== "string") {
      return res.status(400).json({ ok: false, error: "channelId must be a string or null" });
    }
    try {
      const { matchSettingAlertChannelStatus, recordAlertChannelTest } = await import(
        "../services/matchSettingsAlerts"
      );
      const trimmedInput = typeof channelId === "string" ? channelId.trim() : "";
      let targetChannel = trimmedInput;
      if (!targetChannel) {
        const status = await matchSettingAlertChannelStatus();
        targetChannel = status.slackChannelId || "";
      }
      if (!targetChannel) {
        return res.status(400).json({ ok: false, error: "No alert channel configured. Pick a channel first." });
      }
      if (!(await isSlackConnected())) {
        return res.status(400).json({ ok: false, error: "Slack is not connected" });
      }

      const userId = req.user?.claims?.sub;
      const user = userId ? await storage.getUser(userId) : null;
      const actorName =
        [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
        user?.email ||
        "An admin";

      const text = `:test_tube: Test alert from NoBull OS — ${actorName} sent a test threshold-change alert to verify this channel.`;
      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `:test_tube: *Test alert from NoBull OS*\n` +
              `${actorName} sent a test threshold-change alert to verify this channel is reachable.\n` +
              `_If you can read this, alerts will be delivered here._`,
          },
        },
      ];
      try {
        await postMessage(targetChannel, text, blocks);
        await recordAlertChannelTest({
          channelId: targetChannel,
          actorId: userId ?? null,
          actorName,
          actorEmail: user?.email ?? null,
          success: true,
          errorMessage: null,
        });
        return res.json({ ok: true, channelId: targetChannel });
      } catch (err: any) {
        const raw = err?.message || String(err);
        const slackError = raw.replace(/^Slack API error:\s*/, "");
        await recordAlertChannelTest({
          channelId: targetChannel,
          actorId: userId ?? null,
          actorName,
          actorEmail: user?.email ?? null,
          success: false,
          errorMessage: slackError,
        });
        return res.status(502).json({ ok: false, error: slackError, channelId: targetChannel });
      }
    } catch (err: any) {
      console.error("[MatchSettingsAlerts] test alert failed:", err.message);
      res.status(500).json({ ok: false, error: "Failed to send test alert" });
    }
  });

  // Task #1115 — admin form for the post-backfill heatmap coverage check
  // settings (Task #651). The runtime read path lives in
  // `server/services/heatmapCoverageCheck.ts`; this endpoint pair drives the
  // form on `/admin/match-settings`.
  app.get(
    "/api/admin/heatmap-coverage-check/settings",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { heatmapCoverageCheckAdminStatus } = await import(
          "../services/heatmapCoverageCheckAdmin"
        );
        const status = await heatmapCoverageCheckAdminStatus();
        res.json(status);
      } catch (err: any) {
        console.error(
          "[HeatmapCoverageCheckAdmin] GET failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to load heatmap coverage check settings" });
      }
    },
  );

  app.put(
    "/api/admin/heatmap-coverage-check/settings",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const {
          validateHeatmapCoverageCheckUpdate,
          setHeatmapCoverageCheckSettings,
        } = await import("../services/heatmapCoverageCheckAdmin");
        const parsed = validateHeatmapCoverageCheckUpdate(req.body);
        if (!parsed.ok) {
          return res.status(400).json({ error: parsed.error });
        }
        if (parsed.patch.slackChannelId) {
          if (!(await isSlackConnected())) {
            return res.status(400).json({ error: "Slack is not connected" });
          }
          const channels = await listChannels();
          const found = channels.find((c) => c.id === parsed.patch.slackChannelId);
          if (!found) {
            return res
              .status(400)
              .json({ error: "Channel not found in Slack workspace" });
          }
          if (!found.is_member) {
            return res
              .status(400)
              .json({ error: "Bot is not a member of that channel" });
          }
        }
        const result = await setHeatmapCoverageCheckSettings(
          parsed.patch,
          req.user?.claims?.sub ?? "system",
        );
        res.json(result);
      } catch (err: any) {
        console.error(
          "[HeatmapCoverageCheckAdmin] PUT failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to update heatmap coverage check settings" });
      }
    },
  );
}