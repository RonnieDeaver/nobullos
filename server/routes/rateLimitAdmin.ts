// @db-pool-intent: api
/**
 * PR9 split (Task f1425127) — extracted VERBATIM from server/routes.ts
 * (formerly inline at lines 2181–2670 + module helpers 143–162 at split time).
 *
 * Rate-limit monitor admin (/api/health/rate-limits*): summary, timeseries, events + CSV export mounts, by-user/by-ip drilldowns, alert thresholds, and warning percents.
 *
 * Mount-order contract: registerRateLimitAdminRoutes(app) is invoked from
 * registerRoutes() in server/routes.ts at the exact position the inline
 * registrations previously occupied, preserving global registration order.
 * Do not reorder registrations here and do not mount this module elsewhere.
 */
import type { Express } from "express";
import { and } from "drizzle-orm";
import { isAuthenticated } from "../middlewares/requireAuth";
import {
  getRateLimitSummary,
  clearRateLimitMetrics,
  getUserRateLimitBreakdown,
  getAnonymousRateLimitBreakdown,
  getUserTimeSeries,
  getIpTimeSeries,
  isAllowedTimeSeriesInterval,
  getAllowedTimeSeriesIntervals,
  setAlertThreshold,
  resetAlertThreshold,
  resetAllAlertThresholds,
  getAlertThresholds,
  setWarningPercent,
  getWarningPercents,
  computeEffectiveLimits,
} from "../services/rateLimitMonitor";
import {
  getTuningSuggestions,
  applySuggestion,
  runAutoTune,
  getAutoTuneConfig,
  updateAutoTuneConfig,
  getAdjustmentHistory,
} from "../services/rateLimitAutoTuner";
import { getEffectiveMultipliers, requireTeamLead, hasRole } from "./middleware";
import { storage } from "../storage";
import { insertActivityLogs } from "../storage/activityStorage";
import { blockedRateLimitEventsCsvHandler } from "./blockedRateLimitEventsCsv";
import { attachUserInfoToAudit } from "./auditAuxHelpers";
import { blockedRateLimitEventsByUserCsvHandler } from "./blockedRateLimitEventsByUserCsv";
function parseRangeQuery(
  rawStart: unknown,
  rawEnd: unknown,
): { start: number | null; end: number | null; error?: string } {
  const startProvided = rawStart !== undefined && rawStart !== "";
  const endProvided = rawEnd !== undefined && rawEnd !== "";
  if (!startProvided && !endProvided) return { start: null, end: null };
  if (!startProvided || !endProvided) {
    return { start: null, end: null, error: "rangeStart and rangeEnd must both be provided" };
  }
  const start = Number(rawStart);
  const end = Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { start: null, end: null, error: "rangeStart and rangeEnd must be numeric epoch ms" };
  }
  if (end <= start) {
    return { start: null, end: null, error: "rangeEnd must be greater than rangeStart" };
  }
  return { start, end };
}

export function registerRateLimitAdminRoutes(app: Express): void {
  app.get("/api/health/rate-limits", isAuthenticated, async (req: any, res) => {
    try {
      const summary = getRateLimitSummary();
      const tuning = getTuningSuggestions();
      const multipliers = await getEffectiveMultipliers();
      const effectiveLimits = computeEffectiveLimits(multipliers);
      const userId = req.user?.claims?.sub;
      const dbUser = userId ? await storage.getUser(userId) : null;
      const isAdmin = hasRole(dbUser?.role, "team_lead");
      if (!isAdmin) {
        const redacted = {
          ...summary,
          categories: Object.fromEntries(
            Object.entries(summary.categories).map(([key, cat]) => [
              key,
              {
                ...cat,
                topUsers: [],
                uniqueUsers: 0,
                recentEvents: cat.recentEvents.map((ev: any) => ({ ...ev, userId: null })),
              },
            ])
          ),
          tuningSuggestions: tuning.suggestions,
          autoTuneConfig: tuning.config,
          effectiveLimits,
        };
        return res.json(redacted);
      }
      res.json({ ...summary, tuningSuggestions: tuning.suggestions, autoTuneConfig: tuning.config, effectiveLimits });
    } catch (err: any) {
      console.error("[RateLimitMetrics] Error:", err.message);
      res.status(500).json({ error: "Failed to fetch rate limit metrics" });
    }
  });

  app.post("/api/health/rate-limits/reset", isAuthenticated, requireTeamLead, (_req: any, res) => {
    clearRateLimitMetrics();
    res.json({ message: "Rate limit metrics cleared" });
  });

  app.get("/api/health/rate-limits/suggestions", isAuthenticated, (req: any, res) => {
    try {
      const result = getTuningSuggestions();
      res.json(result);
    } catch (err: any) {
      console.error("[AutoTuner] Suggestions error:", err.message);
      res.status(500).json({ error: "Failed to generate tuning suggestions" });
    }
  });

  app.post("/api/health/rate-limits/apply-suggestion", isAuthenticated, requireTeamLead, (req: any, res) => {
    const { category, newMax } = req.body;
    if (!category || typeof newMax !== "number" || newMax < 1) {
      return res.status(400).json({ error: "category (string) and newMax (positive number) are required" });
    }
    const userName = req.user?.claims?.metadata?.name || req.user?.claims?.sub || "unknown";
    const result = applySuggestion(category, newMax, userName);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  });

  app.get("/api/health/rate-limits/auto-tune", isAuthenticated, (_req, res) => {
    res.json(getAutoTuneConfig());
  });

  app.put("/api/health/rate-limits/auto-tune", isAuthenticated, requireTeamLead, (req: any, res) => {
    try {
      const updated = updateAutoTuneConfig(req.body);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/health/rate-limits/auto-tune/run", isAuthenticated, requireTeamLead, (_req: any, res) => {
    try {
      const result = runAutoTune();
      res.json(result);
    } catch (err: any) {
      console.error("[AutoTuner] Run error:", err.message);
      res.status(500).json({ error: "Failed to run auto-tune" });
    }
  });

  app.get("/api/health/rate-limits/adjustments", isAuthenticated, (_req, res) => {
    res.json({ adjustments: getAdjustmentHistory() });
  });

  app.get("/api/health/rate-limits/by-user", isAuthenticated, requireTeamLead, (_req: any, res) => {
    try {
      const users = getUserRateLimitBreakdown();
      const anonymous = getAnonymousRateLimitBreakdown();
      res.json({ users, anonymous });
    } catch (err: any) {
      console.error("[RateLimitMetrics] User breakdown error:", err.message);
      res.status(500).json({ error: "Failed to fetch per-user rate limit metrics" });
    }
  });

  app.get("/api/health/rate-limits/events", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const range = parseRangeQuery(req.query.rangeStart, req.query.rangeEnd);
      if (range.error) return res.status(400).json({ error: range.error });

      const userIdRaw = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
      const ipRaw = typeof req.query.ip === "string" ? req.query.ip.trim() : "";
      const categoryRaw = typeof req.query.category === "string" ? req.query.category.trim() : "";

      const limitRaw = req.query.limit;
      let limit = 50;
      if (limitRaw !== undefined && limitRaw !== "") {
        const parsed = Number(limitRaw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return res.status(400).json({ error: "limit must be a positive number" });
        }
        limit = Math.min(Math.floor(parsed), 500);
      }

      const offsetRaw = req.query.offset;
      let offset = 0;
      if (offsetRaw !== undefined && offsetRaw !== "") {
        const parsed = Number(offsetRaw);
        if (!Number.isFinite(parsed) || parsed < 0) {
          return res.status(400).json({ error: "offset must be a non-negative number" });
        }
        offset = Math.floor(parsed);
      }

      const { listBlockedRateLimitEvents } = await import(
        "../storage/blockedRateLimitEventsStorage"
      );
      const result = await listBlockedRateLimitEvents(
        {
          userId: userIdRaw || null,
          ip: ipRaw || null,
          category: categoryRaw || null,
          rangeStart: range.start,
          rangeEnd: range.end,
        },
        limit,
        offset,
      );

      res.json({
        events: result.rows.map((row) => ({
          id: row.id,
          timestamp: row.timestamp,
          category: row.category,
          method: row.method,
          path: row.path,
          ip: row.ip,
          userId: row.userId,
        })),
        total: result.total,
        limit,
        offset,
      });
    } catch (err: any) {
      console.error("[RateLimitMetrics] List blocked events error:", err.message);
      res.status(500).json({ error: "Failed to list blocked rate limit events" });
    }
  });

  app.get(
    "/api/health/rate-limits/events.csv",
    isAuthenticated,
    requireTeamLead,
    blockedRateLimitEventsCsvHandler,
  );

  app.get("/api/health/rate-limits/by-user/:userId/timeseries", isAuthenticated, requireTeamLead, (req: any, res) => {
    try {
      const { userId } = req.params;
      const allowed = getAllowedTimeSeriesIntervals();
      const defaultInterval = allowed[0];
      const raw = req.query.intervalMs;
      let intervalMs = defaultInterval;
      if (raw !== undefined) {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || !isAllowedTimeSeriesInterval(parsed)) {
          return res.status(400).json({
            error: "Invalid intervalMs",
            allowed,
          });
        }
        intervalMs = parsed;
      }
      const range = parseRangeQuery(req.query.rangeStart, req.query.rangeEnd);
      if (range.error) return res.status(400).json({ error: range.error });
      const series = getUserTimeSeries(userId, intervalMs, range.start, range.end);
      res.json(series);
    } catch (err: any) {
      console.error("[RateLimitMetrics] Time series error:", err.message);
      res.status(500).json({ error: "Failed to fetch user time series" });
    }
  });

  app.get(
    "/api/health/rate-limits/by-user/:userId/events.csv",
    isAuthenticated,
    requireTeamLead,
    blockedRateLimitEventsByUserCsvHandler,
  );

  app.get("/api/health/rate-limits/by-ip/:ip/timeseries", isAuthenticated, requireTeamLead, (req: any, res) => {
    try {
      const { ip } = req.params;
      const allowed = getAllowedTimeSeriesIntervals();
      const defaultInterval = allowed[0];
      const raw = req.query.intervalMs;
      let intervalMs = defaultInterval;
      if (raw !== undefined) {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || !isAllowedTimeSeriesInterval(parsed)) {
          return res.status(400).json({
            error: "Invalid intervalMs",
            allowed,
          });
        }
        intervalMs = parsed;
      }
      const range = parseRangeQuery(req.query.rangeStart, req.query.rangeEnd);
      if (range.error) return res.status(400).json({ error: range.error });
      const series = getIpTimeSeries(ip, intervalMs, range.start, range.end);
      res.json(series);
    } catch (err: any) {
      console.error("[RateLimitMetrics] IP time series error:", err.message);
      res.status(500).json({ error: "Failed to fetch IP time series" });
    }
  });

  app.get("/api/health/rate-limits/thresholds", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    const thresholds = getAlertThresholds();
    const { getLastEditedFromAudit } = await import("./lastEditedHelper");
    const editedMap = await getLastEditedFromAudit({
      settingKey: "rate_limit_alert_threshold",
      scopes: Object.keys(thresholds),
    });
    const lastEdited: Record<string, unknown> = {};
    for (const cat of Object.keys(thresholds)) {
      lastEdited[cat] = editedMap.get(cat) ?? null;
    }
    res.json({ thresholds, lastEdited });
  });

  app.put("/api/health/rate-limits/thresholds", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const { category, threshold } = req.body;
    if (!category || typeof category !== "string") {
      return res.status(400).json({ error: "category is required" });
    }
    const numThreshold = Number(threshold);
    if (!Number.isFinite(numThreshold) || numThreshold < 1) {
      return res.status(400).json({ error: "threshold must be a positive number" });
    }
    const oldThreshold = getAlertThresholds()[category] ?? null;
    try {
      await setAlertThreshold(category, numThreshold);
    } catch (err: any) {
      console.error(`[RateLimitThresholds] PUT failed for ${category}:`, err?.message);
      return res.status(500).json({ error: "Failed to persist threshold" });
    }
    if (oldThreshold !== numThreshold) {
      const userId = req.user?.claims?.sub ?? null;
      try {
        await insertActivityLogs([{
          userId,
          actionType: "alert_threshold_updated",
          route: "/admin/rate-limits",
          actionDetail: `Updated alert threshold for ${category}: ${oldThreshold ?? "—"} → ${numThreshold}`,
          metadata: {
            category,
            oldValues: { [category]: oldThreshold },
            newValues: { [category]: numThreshold },
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[RateLimitThresholds] Audit log failed:", logErr?.message);
      }
      try {
        await storage.recordAdminSettingChange({
          settingKey: "rate_limit_alert_threshold",
          scope: category,
          changedBy: userId,
          oldValues: { threshold: oldThreshold },
          newValues: { threshold: numThreshold },
        });
      } catch (auditErr: any) {
        console.error("[RateLimitThresholds] Setting audit failed:", auditErr?.message);
      }
    }
    res.json({ category, threshold: numThreshold });
  });

  app.delete("/api/health/rate-limits/thresholds", isAuthenticated, requireTeamLead, async (req: any, res) => {
    let priorOverrides: { category: string; threshold: number }[] = [];
    try {
      const { listRateLimitThresholds } = await import("../storage/rateLimitThresholdsStorage");
      const rows = await listRateLimitThresholds();
      priorOverrides = rows.map((r) => ({ category: r.category, threshold: r.threshold }));
    } catch (preReadErr: any) {
      console.error(
        `[RateLimitThresholds] Failed to read existing thresholds before bulk reset:`,
        preReadErr?.message,
      );
    }
    try {
      await resetAllAlertThresholds();
    } catch (err: any) {
      console.error(`[RateLimitThresholds] DELETE all failed:`, err?.message);
      return res.status(500).json({ error: "Failed to reset all thresholds" });
    }
    const cleared = priorOverrides.map((o) => o.category);
    const userId = req.user?.claims?.sub ?? null;
    if (priorOverrides.length > 0) {
      try {
        await insertActivityLogs([{
          userId,
          actionType: "alert_threshold_reset_all",
          route: "/admin/rate-limits",
          actionDetail: `Reset all alert thresholds (${priorOverrides.length} categor${priorOverrides.length === 1 ? "y" : "ies"})`,
          metadata: {
            categories: priorOverrides.map((o) => o.category),
            oldValues: Object.fromEntries(priorOverrides.map((o) => [o.category, o.threshold])),
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[RateLimitThresholds] Audit log failed:", logErr?.message);
      }
      for (const prior of priorOverrides) {
        try {
          await storage.recordAdminSettingChange({
            settingKey: "rate_limit_alert_threshold",
            scope: prior.category,
            changedBy: userId,
            oldValues: { threshold: prior.threshold },
            newValues: { threshold: null, reset: true },
          });
        } catch (auditErr: any) {
          console.error("[RateLimitThresholds] Reset audit failed:", auditErr?.message);
        }
      }
    }
    res.json({ reset: true, clearedCount: priorOverrides.length, cleared });
  });

  app.delete("/api/health/rate-limits/thresholds/:category", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const { category } = req.params;
    if (!category || typeof category !== "string") {
      return res.status(400).json({ error: "category is required" });
    }
    let priorOverride: number | null = null;
    try {
      const { listRateLimitThresholds } = await import("../storage/rateLimitThresholdsStorage");
      const rows = await listRateLimitThresholds();
      const row = rows.find((r) => r.category === category);
      priorOverride = row ? row.threshold : null;
    } catch {}
    try {
      await resetAlertThreshold(category);
    } catch (err: any) {
      console.error(`[RateLimitThresholds] DELETE failed for ${category}:`, err?.message);
      return res.status(500).json({ error: "Failed to reset threshold" });
    }
    if (priorOverride !== null) {
      try {
        await storage.recordAdminSettingChange({
          settingKey: "rate_limit_alert_threshold",
          scope: category,
          changedBy: req.user?.claims?.sub ?? null,
          oldValues: { threshold: priorOverride },
          newValues: { threshold: null, reset: true },
        });
      } catch (auditErr: any) {
        console.error("[RateLimitThresholds] Reset audit failed:", auditErr?.message);
      }
    }
    res.json({ category, reset: true });
  });

  app.get("/api/health/rate-limits/thresholds/history", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
      const scope = typeof req.query.category === "string" && req.query.category.length > 0
        ? req.query.category
        : undefined;
      const entries = await storage.listAdminSettingAudit({
        settingKey: "rate_limit_alert_threshold",
        scope,
        limit,
      });
      const history = await attachUserInfoToAudit(entries);
      res.json({ history });
    } catch (err: any) {
      console.error("[RateLimitThresholds] History fetch failed:", err?.message);
      res.status(500).json({ error: "Failed to fetch threshold history" });
    }
  });

  app.get("/api/health/rate-limits/warning-percents", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    const percents = getWarningPercents();
    const { getLastEditedFromAudit } = await import("./lastEditedHelper");
    const editedMap = await getLastEditedFromAudit({
      settingKey: "rate_limit_warning_percent",
      scopes: Object.keys(percents),
    });
    const lastEdited: Record<string, unknown> = {};
    for (const cat of Object.keys(percents)) {
      lastEdited[cat] = editedMap.get(cat) ?? null;
    }
    res.json({ percents, lastEdited });
  });

  app.put("/api/health/rate-limits/warning-percents", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const { category, percent } = req.body;
    if (!category || typeof category !== "string") {
      return res.status(400).json({ error: "category is required" });
    }
    const numPercent = Number(percent);
    if (!Number.isFinite(numPercent) || numPercent < 1 || numPercent > 100) {
      return res.status(400).json({ error: "percent must be between 1 and 100" });
    }
    const oldPercent = getWarningPercents()[category] ?? null;
    try {
      setWarningPercent(category, numPercent);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
    if (oldPercent !== numPercent) {
      const userId = req.user?.claims?.sub ?? null;
      try {
        await insertActivityLogs([{
          userId,
          actionType: "warning_percent_updated",
          route: "/admin/rate-limits",
          actionDetail: `Updated warning percent for ${category}: ${oldPercent === null ? "—" : `${oldPercent}%`} → ${numPercent}%`,
          metadata: {
            category,
            oldValues: { [category]: oldPercent },
            newValues: { [category]: numPercent },
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[WarningPercents] Audit log failed:", logErr?.message);
      }
      try {
        await storage.recordAdminSettingChange({
          settingKey: "rate_limit_warning_percent",
          scope: category,
          changedBy: userId,
          oldValues: { percent: oldPercent },
          newValues: { percent: numPercent },
        });
      } catch (auditErr: any) {
        console.error("[WarningPercents] Setting audit failed:", auditErr?.message);
      }
    }
    res.json({ category, percent: numPercent });
  });

  app.get("/api/health/rate-limits/warning-percents/history", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
      const scope = typeof req.query.category === "string" && req.query.category.length > 0
        ? req.query.category
        : undefined;
      const entries = await storage.listAdminSettingAudit({
        settingKey: "rate_limit_warning_percent",
        scope,
        limit,
      });
      const history = await attachUserInfoToAudit(entries);
      res.json({ history });
    } catch (err: any) {
      console.error("[WarningPercents] History fetch failed:", err?.message);
      res.status(500).json({ error: "Failed to fetch warning percent history" });
    }
  });
}