/**
 * Task #994 — Admin API for the Slack Notifications Console.
 *
 * Mounted from server/routes.ts under `/api/admin/notifications/*`.
 * All routes require `requireTeamLead`.
 */

import type { Express, Response } from "express";
import { storage } from "../storage";
import { isConnected as isSlackConnected, listChannels } from "../services/slackIntegration";
import {
  NOTIFICATION_CATEGORIES,
  getNotification,
  listNotificationsByCategory,
} from "../services/notifications/registry";
import { resolveNotification, migrateLegacyIfNeeded } from "../services/notifications/resolver";
import {
  notifyByType,
  invalidateKillSwitchCache,
} from "../services/notifications/dispatcher";
import { getSlackOutageStatusForConsole } from "../services/notifications/slackOutageDetector";
import {
  upsertNotificationSetting,
  listNotificationDeliveries,
  getDeliveryStats24h,
  getLastDeliveryByNotification,
} from "../storage/notificationsStorage";
import { runDeliveryRetentionPass } from "../services/notifications/retentionJob";
import {
  getCallArchiveBacklogAlertConfig,
  countPendingStuck as countCallArchivePendingStuck,
  countRecentFailures as countCallArchiveRecentFailures,
  SETTING_ENABLED as CA_SETTING_ENABLED,
  SETTING_PENDING_HOURS as CA_SETTING_PENDING_HOURS,
  SETTING_PENDING_COUNT as CA_SETTING_PENDING_COUNT,
  SETTING_FAILED_LOOKBACK_HOURS as CA_SETTING_FAILED_LOOKBACK_HOURS,
  SETTING_FAILED_COUNT as CA_SETTING_FAILED_COUNT,
  SETTING_COOLDOWN as CA_SETTING_COOLDOWN,
} from "../services/callArchiveBacklogAlerts";
import {
  getCallAnalysisFailureSpikeAlertConfig,
  SETTING_ENABLED as CAFS_SETTING_ENABLED,
  SETTING_WINDOW_MINUTES as CAFS_SETTING_WINDOW_MINUTES,
  SETTING_BASELINE_DAYS as CAFS_SETTING_BASELINE_DAYS,
  SETTING_ABSOLUTE_THRESHOLD as CAFS_SETTING_ABSOLUTE_THRESHOLD,
  SETTING_RATIO_THRESHOLD as CAFS_SETTING_RATIO_THRESHOLD,
  SETTING_MIN_COUNT_FOR_RATIO as CAFS_SETTING_MIN_COUNT_FOR_RATIO,
  SETTING_COOLDOWN as CAFS_SETTING_COOLDOWN,
  SETTING_MUTED_REASONS as CAFS_SETTING_MUTED_REASONS,
  checkCallAnalysisFailureSpikes,
} from "../services/callAnalysisFailureSpikeAlerts";
import { callAnalysisFailureReasons } from "@shared/models/ceoTools";
import { resolveLastEditedUsers } from "./lastEditedHelper";
import type { AuthenticatedRequest } from "./requestContext";

/**
 * Build the test-alert message text. For most registry entries this is a
 * plain "this is a test" line so an operator can confirm the channel is
 * wired up. For specific high-value entries we include a representative
 * sample payload so the channel preview matches what a real alert looks
 * like — currently `queue.call_analysis.failure_spike` (Task #1097).
 */
function buildTestAlertText(id: string, label: string, actor: string): string {
  const header =
    `:test_tube: *Test alert from NoBull OS*  ·  \`${id}\`\n` +
    `${actor} sent a test for "${label}". If you can read this, ` +
    `notifications for this type will be delivered to this channel.`;

  if (id === "queue.call_analysis.failure_spike") {
    return [
      header,
      "",
      "_Sample payload (no real spike — this is a test):_",
      ":warning: *Call-analysis failure spike* — `whisper_timeout`",
      "• *14* failure(s) in the last *60m*",
      "• Baseline: 1.20 per 60m over the prior 7d",
      "• Absolute: *14* ≥ threshold *10*",
      "• Ratio: *11.67x* baseline ≥ threshold *3.00x* (baseline 1.20 per 60m over the prior 7d)",
    ].join("\n");
  }
  return header;
}

export function registerNotificationRoutes(
  app: Express,
  middleware: { isAuthenticated: any; requireTeamLead: any },
): void {
  const { isAuthenticated, requireTeamLead } = middleware;

  // ─────────── List notifications + summary ───────────
  app.get(
    "/api/admin/notifications",
    isAuthenticated,
    requireTeamLead,
    async (_req, res: Response) => {
      try {
        const grouped = listNotificationsByCategory();
        const [stats, lastDeliveries] = await Promise.all([
          getDeliveryStats24h().catch(() => new Map()),
          getLastDeliveryByNotification().catch(() => new Map()),
        ]);

        const categories = await Promise.all(
          grouped.map(async ({ category, notifications }) => {
            const rows = await Promise.all(
              notifications.map(async (entry) => {
                const resolved = await resolveNotification(entry.id);
                const stat = stats.get(entry.id) ?? {
                  total: 0,
                  success: 0,
                  failed: 0,
                  skipped: 0,
                };
                const last = lastDeliveries.get(entry.id) ?? null;
                return {
                  id: entry.id,
                  label: entry.label,
                  description: entry.description,
                  category: entry.category,
                  implemented: entry.implemented,
                  supportsTest: entry.supportsTest,
                  ownerService: entry.ownerService ?? null,
                  enabled: resolved?.enabled ?? entry.defaultEnabled,
                  channelId: resolved?.channelId ?? null,
                  channelName: resolved?.channelName ?? null,
                  source: resolved?.source ?? "default",
                  envOverrideActive: resolved?.envOverrideActive ?? false,
                  envChannelId: resolved?.envChannelId ?? null,
                  envOverrideKeys: entry.envOverrideKeys ?? [],
                  legacySettingKeys: [
                    ...(entry.defaultChannelSettingKey
                      ? [entry.defaultChannelSettingKey]
                      : []),
                    ...(entry.legacySettingKeys ?? []),
                  ],
                  legacyChannelId: resolved?.legacyChannelId ?? null,
                  lastEditedAt: resolved?.savedRow?.updatedAt ?? null,
                  lastEditedBy: resolved?.savedRow?.updatedBy ?? null,
                  deliveryStats24h: stat,
                  lastDelivery: last
                    ? {
                        createdAt: last.createdAt,
                        status: last.status,
                        channelId: last.channelId,
                        channelName: last.channelName,
                        errorMessage: last.errorMessage,
                      }
                    : null,
                };
              }),
            );
            return {
              id: category.id,
              label: category.label,
              description: category.description,
              notifications: rows,
            };
          }),
        );

        const flat = categories.flatMap((c) => c.notifications);
        // Task #4645 — sustained-outage state for the console banner
        // (throttled lazy refresh inside; never fails the console load).
        const [slackConnected, slackOutage] = await Promise.all([
          isSlackConnected().catch(() => false),
          getSlackOutageStatusForConsole().catch(() => null),
        ]);

        const summary = {
          total: flat.length,
          implemented: flat.filter((n) => n.implemented).length,
          enabled: flat.filter((n) => n.enabled && n.implemented).length,
          configured: flat.filter((n) => n.enabled && !!n.channelId && n.implemented)
            .length,
          missingChannel: flat.filter((n) => n.enabled && !n.channelId && n.implemented)
            .length,
          failed24h: flat.reduce((acc, n) => acc + (n.deliveryStats24h.failed ?? 0), 0),
          slackConnected,
        };

        res.json({ summary, categories, slackOutage });
      } catch (err: any) {
        console.error("[notifications/api] GET /api/admin/notifications failed:", err.message);
        res.status(500).json({ error: "Failed to load notifications" });
      }
    },
  );

  // ─────────── Kill switch state (must be registered BEFORE /:id) ───────────
  app.get(
    "/api/admin/notifications/kill-switch",
    isAuthenticated,
    requireTeamLead,
    async (_req, res) => {
      try {
        const row = await storage.getSystemSetting("notifications_slack_watchers_enabled");
        const v = row?.value?.trim().toLowerCase();
        const enabled = !(v === "false" || v === "0" || v === "off");
        res.json({ enabled, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null });
      } catch (err: any) {
        res.status(500).json({ error: "Failed to read kill switch" });
      }
    },
  );

  app.put(
    "/api/admin/notifications/kill-switch",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { enabled?: unknown }>, res) => {
      const { enabled } = req.body || {};
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be boolean" });
      }
      try {
        await storage.setSystemSetting(
          "notifications_slack_watchers_enabled",
          enabled ? "true" : "false",
          req.user?.claims?.sub ?? "system",
        );
        invalidateKillSwitchCache();
        res.json({ enabled });
      } catch (err: any) {
        res.status(500).json({ error: "Failed to write kill switch" });
      }
    },
  );

  // ─────────── Categories metadata (also static, before /:id) ───────────
  app.get(
    "/api/admin/notifications/categories",
    isAuthenticated,
    requireTeamLead,
    (_req, res) => {
      res.json({ categories: NOTIFICATION_CATEGORIES });
    },
  );

  // ─────────── Manual retention pass (static, before /:id) ───────────
  app.post(
    "/api/admin/notifications/retention/run",
    isAuthenticated,
    requireTeamLead,
    async (_req, res) => {
      try {
        const result = await runDeliveryRetentionPass();
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err?.message ?? "Retention pass failed" });
      }
    },
  );

  // ─────────── Call-archive alert thresholds (Task #1080) ───────────
  const CA_FIELD_KEY_PAIRS: Array<[string, string]> = [
    ["enabled", CA_SETTING_ENABLED],
    ["pendingHours", CA_SETTING_PENDING_HOURS],
    ["pendingCount", CA_SETTING_PENDING_COUNT],
    ["failedLookbackHours", CA_SETTING_FAILED_LOOKBACK_HOURS],
    ["failedCount", CA_SETTING_FAILED_COUNT],
    ["cooldownMinutes", CA_SETTING_COOLDOWN],
  ];

  async function buildCallArchiveThresholdsResponse() {
    const [config, settingRows] = await Promise.all([
      getCallArchiveBacklogAlertConfig(),
      Promise.all(
        CA_FIELD_KEY_PAIRS.map(async ([field, key]) => {
          const row = await storage.getSystemSetting(key).catch(() => undefined);
          return { field, key, row };
        }),
      ),
    ]);
    const userMap = await resolveLastEditedUsers(
      settingRows.map((s) => s.row?.updatedBy ?? null),
    );
    const audit: Record<
      string,
      {
        settingKey: string;
        updatedAt: string | null;
        updatedBy: { id: string; firstName: string | null; lastName: string | null; email: string | null } | null;
      }
    > = {};
    for (const { field, key, row } of settingRows) {
      const updatedBy = row?.updatedBy ? userMap.get(row.updatedBy) ?? null : null;
      audit[field] = {
        settingKey: key,
        updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
        updatedBy,
      };
    }
    return { ...config, audit };
  }

  app.get(
    "/api/admin/notifications/call-archive-thresholds",
    isAuthenticated,
    requireTeamLead,
    async (_req, res) => {
      try {
        res.json(await buildCallArchiveThresholdsResponse());
      } catch (err: any) {
        res.status(500).json({ error: "Failed to load thresholds" });
      }
    },
  );

  app.put(
    "/api/admin/notifications/call-archive-thresholds",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest, res) => {
      const body = (req.body || {}) as Partial<{
        enabled: unknown;
        pendingHours: unknown;
        pendingCount: unknown;
        failedLookbackHours: unknown;
        failedCount: unknown;
        cooldownMinutes: unknown;
      }>;

      const writes: Array<{ key: string; value: string }> = [];

      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          return res.status(400).json({ error: "enabled must be boolean" });
        }
        writes.push({ key: CA_SETTING_ENABLED, value: body.enabled ? "true" : "false" });
      }

      const intFields: Array<[keyof typeof body, string, string]> = [
        ["pendingHours", CA_SETTING_PENDING_HOURS, "pendingHours"],
        ["pendingCount", CA_SETTING_PENDING_COUNT, "pendingCount"],
        ["failedLookbackHours", CA_SETTING_FAILED_LOOKBACK_HOURS, "failedLookbackHours"],
        ["failedCount", CA_SETTING_FAILED_COUNT, "failedCount"],
        ["cooldownMinutes", CA_SETTING_COOLDOWN, "cooldownMinutes"],
      ];
      for (const [field, key, label] of intFields) {
        const raw = body[field];
        if (raw === undefined) continue;
        const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
        if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
          return res
            .status(400)
            .json({ error: `${label} must be a positive integer` });
        }
        writes.push({ key, value: String(n) });
      }

      if (writes.length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }

      try {
        const updatedBy = req.user?.claims?.sub ?? "system";
        for (const w of writes) {
          await storage.setSystemSetting(w.key, w.value, updatedBy);
        }
        res.json(await buildCallArchiveThresholdsResponse());
      } catch (err: any) {
        console.error("[notifications/api] PUT call-archive-thresholds failed:", err.message);
        res.status(500).json({ error: "Failed to update thresholds" });
      }
    },
  );

  // Live backlog counts (Task #1089) — uses the same SQL helpers the
  // watcher uses so the panel matches what the next tick will see.
  app.get(
    "/api/admin/notifications/call-archive-thresholds/live-counts",
    isAuthenticated,
    requireTeamLead,
    async (_req, res) => {
      try {
        const config = await getCallArchiveBacklogAlertConfig();
        const [pendingStuck, recentFailures] = await Promise.all([
          countCallArchivePendingStuck(config.pendingHours),
          countCallArchiveRecentFailures(config.failedLookbackHours),
        ]);
        res.json({
          pendingStuck,
          recentFailures,
          pendingHours: config.pendingHours,
          failedLookbackHours: config.failedLookbackHours,
          evaluatedAt: new Date().toISOString(),
        });
      } catch (err: any) {
        console.error(
          "[notifications/api] GET call-archive-thresholds/live-counts failed:",
          err.message,
        );
        res.status(500).json({ error: "Failed to load live counts" });
      }
    },
  );

  // ─────────── Call-analysis failure spike alert thresholds (Task #1076) ───────────
  app.get(
    "/api/admin/notifications/call-analysis-failure-spike-thresholds",
    isAuthenticated,
    requireTeamLead,
    async (_req, res) => {
      try {
        const config = await getCallAnalysisFailureSpikeAlertConfig();
        res.json({ ...config, knownReasons: callAnalysisFailureReasons });
      } catch (err: any) {
        res.status(500).json({ error: "Failed to load thresholds" });
      }
    },
  );

  app.put(
    "/api/admin/notifications/call-analysis-failure-spike-thresholds",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest, res) => {
      const body = (req.body || {}) as Partial<{
        enabled: unknown;
        windowMinutes: unknown;
        baselineDays: unknown;
        absoluteThreshold: unknown;
        ratioThreshold: unknown;
        minCountForRatio: unknown;
        cooldownMinutes: unknown;
        mutedReasons: unknown;
      }>;

      const writes: Array<{ key: string; value: string }> = [];

      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          return res.status(400).json({ error: "enabled must be boolean" });
        }
        writes.push({ key: CAFS_SETTING_ENABLED, value: body.enabled ? "true" : "false" });
      }

      const intFields: Array<[keyof typeof body, string, string]> = [
        ["windowMinutes", CAFS_SETTING_WINDOW_MINUTES, "windowMinutes"],
        ["baselineDays", CAFS_SETTING_BASELINE_DAYS, "baselineDays"],
        ["absoluteThreshold", CAFS_SETTING_ABSOLUTE_THRESHOLD, "absoluteThreshold"],
        ["minCountForRatio", CAFS_SETTING_MIN_COUNT_FOR_RATIO, "minCountForRatio"],
        ["cooldownMinutes", CAFS_SETTING_COOLDOWN, "cooldownMinutes"],
      ];
      for (const [field, key, label] of intFields) {
        const raw = body[field];
        if (raw === undefined) continue;
        const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
        if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
          return res
            .status(400)
            .json({ error: `${label} must be a positive integer` });
        }
        writes.push({ key, value: String(n) });
      }

      if (body.ratioThreshold !== undefined) {
        const raw = body.ratioThreshold;
        const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
        if (!Number.isFinite(n) || n <= 0) {
          return res
            .status(400)
            .json({ error: "ratioThreshold must be a positive number" });
        }
        writes.push({ key: CAFS_SETTING_RATIO_THRESHOLD, value: String(n) });
      }

      if (body.mutedReasons !== undefined) {
        if (
          !Array.isArray(body.mutedReasons) ||
          !body.mutedReasons.every((r) => typeof r === "string")
        ) {
          return res
            .status(400)
            .json({ error: "mutedReasons must be an array of strings" });
        }
        const cleaned = (body.mutedReasons as string[])
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0);
        // Reject obviously bogus reasons so the operator catches typos
        // before they silently disable a real alert. We only enforce
        // membership against the canonical set — unknown reasons in
        // the data still flow through, but mute entries must be from
        // the known set.
        const known = new Set<string>(callAnalysisFailureReasons);
        const bad = cleaned.filter((r) => !known.has(r));
        if (bad.length > 0) {
          return res.status(400).json({
            error: `Unknown failure_reason in mutedReasons: ${bad.join(", ")}. Known: ${callAnalysisFailureReasons.join(", ")}`,
          });
        }
        writes.push({ key: CAFS_SETTING_MUTED_REASONS, value: cleaned.join(",") });
      }

      if (writes.length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }

      try {
        const updatedBy = req.user?.claims?.sub ?? "system";
        for (const w of writes) {
          await storage.setSystemSetting(w.key, w.value, updatedBy);
        }
        const config = await getCallAnalysisFailureSpikeAlertConfig();
        res.json({ ...config, knownReasons: callAnalysisFailureReasons });
      } catch (err: any) {
        console.error(
          "[notifications/api] PUT call-analysis-failure-spike-thresholds failed:",
          err.message,
        );
        res.status(500).json({ error: "Failed to update thresholds" });
      }
    },
  );

  // Diagnostics: run the watcher inline and return the per-reason
  // evaluation table so an operator can preview what would alert
  // before changing a threshold.
  app.post(
    "/api/admin/notifications/call-analysis-failure-spike-thresholds/preview",
    isAuthenticated,
    requireTeamLead,
    async (_req, res) => {
      try {
        // Preview is side-effect-free: it evaluates every reason
        // against the current config and reports which would alert,
        // but never invokes the Slack dispatcher and never advances
        // the per-reason cooldown cache. Operators can change a
        // threshold and re-preview without spamming the channel.
        const result = await checkCallAnalysisFailureSpikes(Date.now(), {
          dryRun: true,
        });
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err?.message ?? "Preview failed" });
      }
    },
  );

  // ─────────── Update a notification ───────────
  app.put(
    "/api/admin/notifications/:id",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
      const { id } = req.params || {};
      const entry = getNotification(String(id));
      if (!entry) return res.status(404).json({ error: "Unknown notification id" });

      const { enabled, channelId } = (req.body || {}) as {
        enabled?: unknown;
        channelId?: unknown;
      };
      if (enabled !== undefined && typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be boolean" });
      }
      if (
        channelId !== undefined &&
        channelId !== null &&
        typeof channelId !== "string"
      ) {
        return res.status(400).json({ error: "channelId must be string or null" });
      }

      const trimmedChannel =
        typeof channelId === "string" ? channelId.trim() : (channelId as null | undefined);
      let channelName: string | null = null;

      if (trimmedChannel) {
        const slackOk = await isSlackConnected().catch(() => false);
        if (!slackOk) return res.status(400).json({ error: "Slack is not connected" });
        const channels = await listChannels().catch(() => []);
        const found = channels.find((c) => c.id === trimmedChannel);
        if (!found) return res.status(400).json({ error: "Channel not found in Slack workspace" });
        if (!found.is_member) {
          return res.status(400).json({ error: "Bot is not a member of that channel" });
        }
        channelName = found.name;
      }

      try {
        // Migrate any pre-existing legacy channel value into
        // `notification_settings` BEFORE applying the admin's edit.
        // Without this, an `enabled`-only toggle would insert a row with
        // `channelId: null` (because the resolver hadn't seeded it yet)
        // and the resolver would then treat that null as authoritative,
        // silently dropping the previously-working legacy channel.
        await migrateLegacyIfNeeded(String(id));
        await upsertNotificationSetting({
          notificationId: String(id),
          enabled: enabled as boolean | undefined,
          channelId: channelId === undefined ? undefined : trimmedChannel || null,
          channelName: channelId === undefined ? undefined : channelName,
          updatedBy: req.user?.claims?.sub ?? null,
          source: "notification_settings",
        });
        const resolved = await resolveNotification(String(id));
        res.json({
          id,
          enabled: resolved?.enabled,
          channelId: resolved?.channelId,
          channelName: resolved?.channelName,
          source: resolved?.source,
          envOverrideActive: resolved?.envOverrideActive,
          envChannelId: resolved?.envChannelId,
        });
      } catch (err: any) {
        console.error("[notifications/api] PUT failed:", err.message);
        res.status(500).json({ error: "Failed to update notification" });
      }
    },
  );

  // ─────────── Send test ───────────
  app.post(
    "/api/admin/notifications/:id/test",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
      const { id } = req.params || {};
      const entry = getNotification(String(id));
      if (!entry) return res.status(404).json({ ok: false, error: "Unknown notification id" });
      if (!entry.supportsTest) {
        return res.status(400).json({ ok: false, error: "Test send not supported" });
      }

      const { channelId } = (req.body || {}) as { channelId?: unknown };
      if (
        channelId !== undefined &&
        channelId !== null &&
        typeof channelId !== "string"
      ) {
        return res.status(400).json({ ok: false, error: "channelId must be string or null" });
      }
      const draft = typeof channelId === "string" ? channelId.trim() : null;

      const userId = req.user?.claims?.sub ?? null;
      const user = userId ? await storage.getUser(userId).catch(() => null) : null;
      const actor =
        [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
        user?.email ||
        "An admin";

      const text = buildTestAlertText(entry.id, entry.label, actor);

      const result = await notifyByType(
        String(id),
        { text },
        {
          triggerSource: "test",
          triggerActorId: userId,
          channelOverride: draft || undefined,
          bypassKillSwitch: true,
          bypassDedupe: true,
          metadata: {
            test: true,
            notificationId: entry.id,
            actorId: userId,
            actorName: actor,
          },
        },
      );
      if (result.delivered) {
        return res.json({ ok: true, channelId: result.channelId, deliveryId: result.deliveryId });
      }
      return res
        .status(result.status === "failed" ? 502 : 400)
        .json({
          ok: false,
          error: result.error ?? result.skipReason ?? "Test send failed",
          status: result.status,
          skipReason: result.skipReason ?? null,
          channelId: result.channelId ?? null,
          deliveryId: result.deliveryId,
        });
    },
  );

  // ─────────── Delivery history ───────────
  app.get(
    "/api/admin/notifications/:id/deliveries",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<{ id: string }>, res: Response) => {
      const { id } = req.params || {};
      const entry = getNotification(String(id));
      if (!entry) return res.status(404).json({ error: "Unknown notification id" });
      const limit = Math.max(1, Math.min(Number(req.query?.limit ?? 20) || 20, 200));
      try {
        const rows = await listNotificationDeliveries(String(id), limit);
        res.json({
          deliveries: rows.map((r) => ({
            id: r.id,
            createdAt: r.createdAt,
            channelId: r.channelId,
            channelName: r.channelName,
            status: r.status,
            errorMessage: r.errorMessage,
            errorCode: r.errorCode,
            slackTs: r.slackTs,
            payloadPreview: r.payloadPreview,
            triggerSource: r.triggerSource,
            triggerActorId: r.triggerActorId,
            dedupeKey: r.dedupeKey,
          })),
        });
      } catch (err: any) {
        console.error("[notifications/api] deliveries failed:", err.message);
        res.status(500).json({ error: "Failed to load deliveries" });
      }
    },
  );

}
