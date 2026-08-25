// @db-pool-intent: api
/**
 * PR9 split (Task f1425127) — extracted VERBATIM from server/routes.ts
 * (formerly inline at lines 3594–4336 at split time).
 *
 * Rate-limit usage alerts (active/clear), alert notification history + CSV, notify-config, digest status/flush/growth, chains, per-row/bulk/auto retry, max-attempts warning, and test-alert routes.
 *
 * Mount-order contract: registerRateLimitNotificationRoutes(app) is invoked from
 * registerRoutes() in server/routes.ts at the exact position the inline
 * registrations previously occupied, preserving global registration order.
 * Do not reorder registrations here and do not mount this module elsewhere.
 */
import type { Express } from "express";
import { and } from "drizzle-orm";
import { isAuthenticated } from "../middlewares/requireAuth";
import { getActiveUsageAlerts, clearUsageAlerts } from "../services/rateLimitMonitor";
import { requireTeamLead } from "./middleware";
import { storage } from "../storage";
import { attachUserInfoToAudit } from "./auditAuxHelpers";
export function registerRateLimitNotificationRoutes(app: Express): void {
  app.get("/api/health/rate-limits/alerts", isAuthenticated, requireTeamLead, (_req: any, res) => {
    res.json({ alerts: getActiveUsageAlerts() });
  });

  app.post("/api/health/rate-limits/alerts/clear", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    clearUsageAlerts();
    try {
      const { clearAlertNotifyDedup } = await import("../services/rateLimitAlertNotifier");
      clearAlertNotifyDedup();
    } catch {}
    res.json({ message: "Usage alerts cleared" });
  });

  app.get("/api/health/rate-limits/notifications.csv", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const allowedStatuses = new Set(["sent", "failed", "skipped"]);
      const allowedChannels = new Set(["slack", "email"]);
      const allowedTriggerSources = new Set(["scheduled", "manual", "config_change"]);
      const rawStatus = typeof req.query.status === "string" ? req.query.status : "";
      const rawChannel = typeof req.query.channel === "string" ? req.query.channel : "";
      const rawCategory = typeof req.query.category === "string" ? req.query.category : "";
      const rawSearch = typeof req.query.search === "string" ? req.query.search : "";
      const rawTrigger = typeof req.query.triggerSource === "string" ? req.query.triggerSource : "";
      const filters: {
        status?: string;
        channel?: string;
        category?: string;
        search?: string;
        triggerSource?: string;
        startMs?: number;
        endMs?: number;
      } = {};
      if (rawStatus && allowedStatuses.has(rawStatus)) filters.status = rawStatus;
      if (rawChannel && allowedChannels.has(rawChannel)) filters.channel = rawChannel;
      if (rawCategory) filters.category = rawCategory.slice(0, 64);
      const trimmedSearch = rawSearch.trim().slice(0, 200);
      if (trimmedSearch) filters.search = trimmedSearch;
      if (rawTrigger && allowedTriggerSources.has(rawTrigger)) filters.triggerSource = rawTrigger;
      const parseMs = (raw: any): number | undefined => {
        if (raw == null || raw === "") return undefined;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return undefined;
        return Math.floor(n);
      };
      const startMs = parseMs(req.query.start);
      const endMs = parseMs(req.query.end);
      if (startMs != null) filters.startMs = startMs;
      if (endMs != null) filters.endMs = endMs;
      const {
        listAlertNotificationsForExport,
        ALERT_NOTIFICATION_EXPORT_HARD_CEILING,
        ALERT_NOTIFICATION_EXPORT_DEFAULT_LIMIT,
      } = await import("../storage/rateLimitAlertNotificationsStorage");
      const rawLimit = req.query.limit;
      let exportLimit = ALERT_NOTIFICATION_EXPORT_DEFAULT_LIMIT;
      if (rawLimit != null && rawLimit !== "") {
        const n = Number(rawLimit);
        if (!Number.isFinite(n) || n < 1) {
          return res
            .status(400)
            .json({ error: "limit must be a positive integer" });
        }
        exportLimit = Math.min(
          Math.floor(n),
          ALERT_NOTIFICATION_EXPORT_HARD_CEILING,
        );
      }
      const rows = await listAlertNotificationsForExport(filters, exportLimit);

      const userIds = Array.from(
        new Set(rows.map((r) => r.userId).filter((v): v is string => !!v)),
      );
      const userMap = new Map<string, string>();
      if (userIds.length > 0) {
        const dbUsers = await Promise.all(userIds.map((id) => storage.getUser(id).catch(() => null)));
        dbUsers.forEach((u, i) => {
          if (!u) return;
          const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
          userMap.set(userIds[i], name || u.email || userIds[i]);
        });
      }

      const escape = (value: string | number | null | undefined): string => {
        if (value === null || value === undefined) return "";
        const s = String(value);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = [
        "when",
        "status",
        "channel",
        "destination",
        "user",
        "category",
        "usage",
        "trigger_source",
        "trigger_actor",
        "error",
      ];
      const lines: string[] = [header.join(",")];
      for (const r of rows) {
        const userDisplay = r.userId
          ? userMap.get(r.userId) || r.userLabel || r.userId
          : r.userLabel || "";
        const usagePct = r.maxRequests > 0 ? Math.round((r.count / r.maxRequests) * 100) : 0;
        const usage = `${r.count}/${r.maxRequests} (${usagePct}%)`;
        const actor = r.triggerActorId
          ? userMap.get(r.triggerActorId) || r.triggerActorId
          : "";
        lines.push(
          [
            new Date(Number(r.attemptedAt)).toISOString(),
            r.status,
            r.channel,
            r.destination,
            userDisplay,
            r.category,
            usage,
            r.triggerSource ?? "scheduled",
            actor,
            r.errorMessage ?? "",
          ]
            .map(escape)
            .join(","),
        );
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filterParts: string[] = [];
      if (filters.status) filterParts.push(`status-${filters.status}`);
      if (filters.channel) filterParts.push(`channel-${filters.channel}`);
      if (filters.category) {
        const safeCat = filters.category.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 60);
        if (safeCat) filterParts.push(`category-${safeCat}`);
      }
      if (filters.triggerSource) filterParts.push(`trigger-${filters.triggerSource}`);
      if (rawLimit != null && rawLimit !== "") filterParts.push(`limit-${exportLimit}`);
      const suffix = filterParts.length ? `_${filterParts.join("_")}` : "";
      const filename = `notification-history${suffix}_${stamp}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("X-Notification-Export-Count", String(rows.length));
      res.send(lines.join("\n"));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[RateLimitAlertNotifier] Export notifications failed:", msg);
      res.status(500).json({ error: "Failed to export notifications" });
    }
  });

  app.get("/api/health/rate-limits/notifications", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
      const allowedStatuses = new Set(["sent", "failed", "skipped"]);
      const allowedChannels = new Set(["slack", "email"]);
      const allowedTriggerSources = new Set(["scheduled", "manual", "config_change"]);
      const rawStatus = typeof req.query.status === "string" ? req.query.status : "";
      const rawChannel = typeof req.query.channel === "string" ? req.query.channel : "";
      const rawCategory = typeof req.query.category === "string" ? req.query.category : "";
      const rawSearch = typeof req.query.search === "string" ? req.query.search : "";
      const rawTrigger = typeof req.query.triggerSource === "string" ? req.query.triggerSource : "";
      const filters: {
        status?: string;
        channel?: string;
        category?: string;
        search?: string;
        triggerSource?: string;
        startMs?: number;
        endMs?: number;
        chainRootIds?: string[];
      } = {};
      if (rawStatus && allowedStatuses.has(rawStatus)) filters.status = rawStatus;
      if (rawChannel && allowedChannels.has(rawChannel)) filters.channel = rawChannel;
      if (rawCategory) filters.category = rawCategory.slice(0, 64);
      const trimmedSearch = rawSearch.trim().slice(0, 200);
      if (trimmedSearch) filters.search = trimmedSearch;
      if (rawTrigger && allowedTriggerSources.has(rawTrigger)) filters.triggerSource = rawTrigger;
      const parseMs = (raw: any): number | undefined => {
        if (raw == null || raw === "") return undefined;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return undefined;
        return Math.floor(n);
      };
      const startMs = parseMs(req.query.start);
      const endMs = parseMs(req.query.end);
      if (startMs != null) filters.startMs = startMs;
      if (endMs != null) filters.endMs = endMs;
      const rawExhaustedOnly = req.query.exhaustedOnly;
      const exhaustedOnly =
        rawExhaustedOnly === "1" ||
        rawExhaustedOnly === "true" ||
        rawExhaustedOnly === true;
      const {
        listRecentRateLimitAlertNotifications,
        listExhaustedChainRootIds,
      } = await import("../storage/rateLimitAlertNotificationsStorage");
      // Task #1251: load the auto-retry cap so we can stamp each row with a
      // `chainExhausted` flag (and pre-filter when the caller asked for
      // exhausted-only). Falls back gracefully — if the cap can't be loaded
      // we leave every row un-stamped rather than failing the whole list.
      let exhaustedRoots = new Set<string>();
      let exhaustedLookupFailed = false;
      try {
        const { loadAutoRetryConfig } = await import(
          "../services/rateLimitAlertNotifier"
        );
        const cfg = await loadAutoRetryConfig();
        if (cfg.maxAttempts > 0) {
          const ids = await listExhaustedChainRootIds(cfg.maxAttempts);
          exhaustedRoots = new Set(ids);
        }
      } catch (err: any) {
        exhaustedLookupFailed = true;
        console.warn(
          "[RateLimitAlertNotifier] List notifications: exhausted-root lookup failed:",
          err?.message,
        );
      }
      if (exhaustedOnly) {
        // If the lookup failed we cannot honestly answer "exhausted only" —
        // surface a 503 instead of silently returning an empty list that
        // looks identical to "nothing is exhausted". Stamping rows with
        // chainExhausted=false on the unfiltered list path stays best-effort.
        if (exhaustedLookupFailed) {
          return res.status(503).json({
            error: "Could not determine exhausted chains. Please try again.",
          });
        }
        // True empty set — nothing is exhausted, so the filter trivially
        // returns no rows.
        if (exhaustedRoots.size === 0) {
          return res.json({ notifications: [] });
        }
        filters.chainRootIds = Array.from(exhaustedRoots);
      }
      const rows = await listRecentRateLimitAlertNotifications(limit, filters);
      const notifications = rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        destination: r.destination,
        status: r.status,
        errorMessage: r.errorMessage,
        userId: r.userId,
        userLabel: r.userLabel,
        category: r.category,
        count: r.count,
        maxRequests: r.maxRequests,
        warningPercent: r.warningPercent,
        windowMs: r.windowMs,
        windowStart: r.windowStart,
        triggeredAt: r.triggeredAt,
        attemptedAt: r.attemptedAt,
        triggerSource: r.triggerSource,
        triggerActorId: r.triggerActorId,
        latencyMs: r.latencyMs,
        attemptNumber: r.attemptNumber,
        parentNotificationId: r.parentNotificationId,
        hasChildren: r.hasChildren,
        chainExhausted: exhaustedRoots.has(r.parentNotificationId ?? r.id),
      }));
      res.json({ notifications });
    } catch (err: any) {
      console.error("[RateLimitAlertNotifier] List notifications failed:", err.message);
      res.status(500).json({ error: "Failed to list notifications" });
    }
  });

  app.get("/api/health/rate-limits/notify-config", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { loadAlertNotifyConfig } = await import("../services/rateLimitAlertNotifier");
      const config = await loadAlertNotifyConfig(true);
      const { resolveLastEditedUsers, buildLastEdited } = await import("./lastEditedHelper");
      const SETTING_KEYS = {
        slackChannelId: "rate_limit_alert_slack_channel_id",
        email: "rate_limit_alert_email",
        disabledCategories: "rate_limit_alert_disabled_categories",
        cadence: "rate_limit_alert_cadence",
      } as const;
      const settings = await Promise.all(
        Object.values(SETTING_KEYS).map((k) => storage.getSystemSetting(k)),
      );
      const userMap = await resolveLastEditedUsers(
        settings.map((s) => s?.updatedBy ?? null),
      );
      const lastEdited: Record<string, ReturnType<typeof buildLastEdited>> = {};
      Object.keys(SETTING_KEYS).forEach((field, i) => {
        const s = settings[i];
        lastEdited[field] = s
          ? buildLastEdited(s.updatedAt, s.updatedBy, userMap)
          : { updatedAt: null, updatedBy: null };
      });
      res.json({ ...config, lastEdited });
    } catch (err: any) {
      console.error("[RateLimitAlertNotifier] GET config failed:", err.message);
      res.status(500).json({ error: "Failed to load notification config" });
    }
  });

  app.put("/api/health/rate-limits/notify-config", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const { slackChannelId, email, disabledCategories, cadence } = req.body || {};
    if (slackChannelId !== undefined && slackChannelId !== null && typeof slackChannelId !== "string") {
      return res.status(400).json({ error: "slackChannelId must be a string" });
    }
    if (email !== undefined && email !== null && typeof email !== "string") {
      return res.status(400).json({ error: "email must be a string" });
    }
    if (email && typeof email === "string" && email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: "email must be a valid address" });
    }
    if (
      disabledCategories !== undefined &&
      (!Array.isArray(disabledCategories) || disabledCategories.some((s: any) => typeof s !== "string"))
    ) {
      return res.status(400).json({ error: "disabledCategories must be an array of strings" });
    }
    if (cadence !== undefined && !["realtime", "hourly", "daily"].includes(cadence)) {
      return res.status(400).json({ error: "cadence must be one of: realtime, hourly, daily" });
    }
    try {
      const { setAlertNotifyConfig } = await import("../services/rateLimitAlertNotifier");
      const updated = await setAlertNotifyConfig(
        { slackChannelId, email, disabledCategories, cadence },
        req.user?.claims?.sub ?? "system",
      );
      res.json(updated);
    } catch (err: any) {
      console.error("[RateLimitAlertNotifier] PUT config failed:", err.message);
      res.status(500).json({ error: "Failed to update notification config" });
    }
  });

  app.get(
    "/api/health/rate-limits/notify-config/history",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
        const SETTING_KEYS: Record<string, string> = {
          rate_limit_alert_slack_channel_id: "slackChannelId",
          rate_limit_alert_email: "email",
          rate_limit_alert_disabled_categories: "disabledCategories",
          rate_limit_alert_cadence: "cadence",
        };
        const perKey = await Promise.all(
          Object.keys(SETTING_KEYS).map((k) =>
            storage.listAdminSettingAudit({ settingKey: k, limit }),
          ),
        );
        const merged = perKey
          .flat()
          .sort((a, b) => {
            const at = new Date(a.changedAt as any).getTime();
            const bt = new Date(b.changedAt as any).getTime();
            return bt - at;
          })
          .slice(0, limit);
        const enriched = await attachUserInfoToAudit(merged);
        const history = enriched.map((e) => ({
          ...e,
          field: SETTING_KEYS[e.settingKey] ?? e.settingKey,
        }));
        res.json({ history });
      } catch (err: any) {
        console.error(
          "[RateLimitAlertNotifier] History fetch failed:",
          err?.message,
        );
        res.status(500).json({ error: "Failed to fetch notification config history" });
      }
    },
  );

  app.post(
    "/api/health/rate-limits/notify-config/history/:id/resend",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { resendNotifyConfigChangeAlert } = await import(
          "../services/rateLimitAlertNotifier"
        );
        const actorId = req.user?.claims?.sub ?? null;
        const result = await resendNotifyConfigChangeAlert({
          auditId: req.params.id,
          actorId,
        });
        if (!result.ok) {
          return res.status(result.status).json({ error: result.error });
        }
        const row = await storage.getAdminSettingAuditById(req.params.id);
        if (!row) {
          return res.json({ ok: true, entry: null });
        }
        const SETTING_KEYS: Record<string, string> = {
          rate_limit_alert_slack_channel_id: "slackChannelId",
          rate_limit_alert_email: "email",
          rate_limit_alert_disabled_categories: "disabledCategories",
          rate_limit_alert_cadence: "cadence",
        };
        const [enriched] = await attachUserInfoToAudit([row]);
        res.json({
          ok: true,
          entry: { ...enriched, field: SETTING_KEYS[row.settingKey] ?? row.settingKey },
        });
      } catch (err: any) {
        console.error(
          "[RateLimitAlertNotifier] POST notify-config resend failed:",
          err?.message,
        );
        res.status(500).json({ error: "Failed to resend notification config alert" });
      }
    },
  );

  app.get("/api/health/rate-limits/digest-status", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { getDigestStatus } = await import("../services/rateLimitAlertNotifier");
      res.json(await getDigestStatus());
    } catch (err: any) {
      console.error("[RateLimitAlertNotifier] GET digest-status failed:", err.message);
      res.status(500).json({ error: "Failed to load digest status" });
    }
  });

  app.post("/api/health/rate-limits/digest-flush", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { flushDigestNow, getDigestStatus } = await import("../services/rateLimitAlertNotifier");
      const actorId = req.user?.claims?.sub ?? null;
      await flushDigestNow({ source: "manual", actorId });
      res.json({ ok: true, status: await getDigestStatus() });
    } catch (err: any) {
      console.error("[RateLimitAlertNotifier] POST digest-flush failed:", err.message);
      res.status(500).json({ error: "Failed to flush digest" });
    }
  });

  // Task #792 — return the ordered retry chain for a notification, so the
  // history UI can expand a row and show every prior attempt in the same
  // chain. Accepts either the chain root id or any descendant id.
  app.get(
    "/api/health/rate-limits/notifications/:id/chain",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { getNotificationChain } = await import(
          "../storage/rateLimitAlertNotificationsStorage"
        );
        const rows = await getNotificationChain(req.params.id);
        if (rows.length === 0) {
          return res.status(404).json({ error: "Notification not found" });
        }
        const chain = rows.map((r) => ({
          id: r.id,
          parentNotificationId: r.parentNotificationId,
          attemptNumber: r.attemptNumber,
          status: r.status,
          channel: r.channel,
          destination: r.destination,
          errorMessage: r.errorMessage,
          attemptedAt: r.attemptedAt,
          triggeredAt: r.triggeredAt,
          triggerSource: r.triggerSource,
          triggerActorId: r.triggerActorId,
          latencyMs: r.latencyMs,
        }));
        const rootId = rows[0]?.parentNotificationId ?? rows[0]?.id ?? null;
        res.json({ rootId, chain });
      } catch (err: any) {
        console.error(
          "[RateLimitAlertNotifier] GET notification chain failed:",
          err?.message,
        );
        res.status(500).json({ error: "Failed to load notification chain" });
      }
    },
  );

  // Per-row resend (#680) — canonical entry point reused by bulk + auto.
  app.post(
    "/api/health/rate-limits/notifications/:id/retry",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { retryNotificationById, loadAutoRetryConfig } = await import(
          "../services/rateLimitAlertNotifier"
        );
        const actorId = req.user?.claims?.sub ?? null;
        const cfg = await loadAutoRetryConfig();
        const outcome = await retryNotificationById(
          req.params.id,
          { source: "retry", actorId },
          { maxAttempts: cfg.maxAttempts },
        );
        if (outcome.status === "blocked") {
          return res.status(409).json({ error: outcome.errorMessage, outcome });
        }
        res.json({ ok: outcome.status === "sent", outcome });
      } catch (err: any) {
        console.error("[RateLimitAlertNotifier] POST notification retry failed:", err.message);
        res.status(500).json({ error: "Failed to retry notification" });
      }
    },
  );

  // Bulk resend (#671). Filters mirror the notification history list.
  app.post(
    "/api/health/rate-limits/notifications/bulk-retry",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { bulkRetryFailedNotifications } = await import(
          "../services/rateLimitAlertNotifier"
        );
        const actorId = req.user?.claims?.sub ?? null;
        const body = (req.body ?? {}) as Record<string, unknown>;
        const filters: Record<string, unknown> = {};
        for (const k of [
          "channel",
          "userId",
          "category",
          "triggerSource",
          "destination",
          "search",
        ]) {
          const v = body[k];
          if (typeof v === "string" && v.trim()) filters[k] = v.trim();
        }
        if (typeof body.startTime === "number") filters.startTime = body.startTime;
        if (typeof body.endTime === "number") filters.endTime = body.endTime;
        const limit =
          typeof body.limit === "number" && body.limit > 0
            ? Math.min(200, Math.floor(body.limit))
            : 50;
        const result = await bulkRetryFailedNotifications(
          filters as any,
          { source: "manual", actorId },
          limit,
        );
        res.json({ ok: true, ...result });
      } catch (err: any) {
        console.error("[RateLimitAlertNotifier] POST bulk-retry failed:", err.message);
        res.status(500).json({ error: "Failed to bulk retry notifications" });
      }
    },
  );

  // Auto-retry config (#672). Read + update.
  app.get(
    "/api/health/rate-limits/auto-retry-config",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { loadAutoRetryConfig } = await import("../services/rateLimitAlertNotifier");
        res.json(await loadAutoRetryConfig(true));
      } catch (err: any) {
        console.error("[RateLimitAlertNotifier] GET auto-retry-config failed:", err.message);
        res.status(500).json({ error: "Failed to load auto-retry config" });
      }
    },
  );
  app.put(
    "/api/health/rate-limits/auto-retry-config",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { setAutoRetryConfig } = await import("../services/rateLimitAlertNotifier");
        const actorId = req.user?.claims?.sub ?? "system";
        const body = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
        if (typeof body.maxAttempts === "number") patch.maxAttempts = body.maxAttempts;
        if (typeof body.minIntervalMinutes === "number")
          patch.minIntervalMinutes = body.minIntervalMinutes;
        if (typeof body.lookbackHours === "number") patch.lookbackHours = body.lookbackHours;
        const updated = await setAutoRetryConfig(patch as any, actorId);
        res.json(updated);
      } catch (err: any) {
        console.error("[RateLimitAlertNotifier] PUT auto-retry-config failed:", err.message);
        res.status(500).json({ error: "Failed to update auto-retry config" });
      }
    },
  );

  // Manual auto-retry trigger (admin button).
  app.post(
    "/api/health/rate-limits/auto-retry-run",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { runAutoRetryPass } = await import("../services/rateLimitAlertNotifier");
        const actorId = req.user?.claims?.sub ?? null;
        const result = await runAutoRetryPass(actorId);
        res.json({ ok: true, ...result });
      } catch (err: any) {
        console.error("[RateLimitAlertNotifier] POST auto-retry-run failed:", err.message);
        res.status(500).json({ error: "Failed to run auto-retry pass" });
      }
    },
  );

  // Digest growth warning (#648).
  app.get(
    "/api/health/rate-limits/digest-growth",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { getDigestGrowthInfo } = await import("../services/rateLimitAlertNotifier");
        res.json(await getDigestGrowthInfo());
      } catch (err: any) {
        console.error("[RateLimitAlertNotifier] GET digest-growth failed:", err.message);
        res.status(500).json({ error: "Failed to load digest growth info" });
      }
    },
  );
  // Rolling samples of `pendingDigest.length` so the UI can render a
  // sparkline of how the queue size is trending (Task #1108).
  app.get(
    "/api/health/rate-limits/digest-growth/history",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { getDigestGrowthHistory } = await import("../services/rateLimitAlertNotifier");
        res.json(getDigestGrowthHistory());
      } catch (err: any) {
        console.error("[RateLimitAlertNotifier] GET digest-growth/history failed:", err.message);
        res.status(500).json({ error: "Failed to load digest growth history" });
      }
    },
  );
  app.put(
    "/api/health/rate-limits/digest-growth",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { setDigestGrowthConfig } = await import("../services/rateLimitAlertNotifier");
        const actorId = req.user?.claims?.sub ?? "system";
        const body = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
        if (typeof body.warnAt === "number") patch.warnAt = body.warnAt;
        if (typeof body.cooldownMinutes === "number") patch.cooldownMinutes = body.cooldownMinutes;
        if (typeof body.overdueMultiplier === "number")
          patch.overdueMultiplier = body.overdueMultiplier;
        if (typeof body.autoFlushOnOverdue === "boolean")
          patch.autoFlushOnOverdue = body.autoFlushOnOverdue;
        const updated = await setDigestGrowthConfig(patch as any, actorId);
        res.json(updated);
      } catch (err: any) {
        console.error("[RateLimitAlertNotifier] PUT digest-growth failed:", err.message);
        res.status(500).json({ error: "Failed to update digest growth config" });
      }
    },
  );

  // Max-attempts-reached warning (Task #793).
  app.get(
    "/api/health/rate-limits/max-attempts-warning",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { getMaxAttemptsWarningInfo } = await import(
          "../services/rateLimitAlertNotifier"
        );
        res.json(await getMaxAttemptsWarningInfo());
      } catch (err: any) {
        console.error(
          "[RateLimitAlertNotifier] GET max-attempts-warning failed:",
          err.message,
        );
        res.status(500).json({ error: "Failed to load max-attempts warning info" });
      }
    },
  );
  app.put(
    "/api/health/rate-limits/max-attempts-warning",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { setMaxAttemptsWarningConfig } = await import(
          "../services/rateLimitAlertNotifier"
        );
        const actorId = req.user?.claims?.sub ?? "system";
        const body = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
        if (typeof body.cooldownMinutes === "number")
          patch.cooldownMinutes = body.cooldownMinutes;
        const updated = await setMaxAttemptsWarningConfig(patch as any, actorId);
        res.json(updated);
      } catch (err: any) {
        console.error(
          "[RateLimitAlertNotifier] PUT max-attempts-warning failed:",
          err.message,
        );
        res.status(500).json({ error: "Failed to update max-attempts warning config" });
      }
    },
  );

  // Test alert (#669) — sends a synthetic alert through the configured
  // channels and persists the outcome in system settings so the admin UI
  // can show "last test alert".
  app.get(
    "/api/health/rate-limits/last-test-alert",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { getLastTestAlert } = await import("../services/rateLimitAlertNotifier");
        res.json({ lastTest: await getLastTestAlert() });
      } catch (err: any) {
        console.error("[RateLimitAlertNotifier] GET last-test-alert failed:", err.message);
        res.status(500).json({ error: "Failed to load last test alert" });
      }
    },
  );
  app.post(
    "/api/health/rate-limits/test-alert",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { sendTestAlert } = await import("../services/rateLimitAlertNotifier");
        const actorId = req.user?.claims?.sub ?? null;
        const result = await sendTestAlert(actorId);
        res.json({ ok: true, lastTest: result });
      } catch (err: any) {
        console.error("[RateLimitAlertNotifier] POST test-alert failed:", err.message);
        res.status(500).json({ error: "Failed to send test alert" });
      }
    },
  );
}