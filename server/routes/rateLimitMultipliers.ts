// @db-pool-intent: api
/**
 * PR9 split (Task f1425127) — extracted VERBATIM from server/routes.ts
 * (formerly inline at lines 5380–5759 at split time).
 *
 * Rate-limit multiplier get/put + audit history, route-limiter inventory, blocked-IPs cap config, and the default block duration routes.
 *
 * Mount-order contract: registerRateLimitMultiplierRoutes(app) is invoked from
 * registerRoutes() in server/routes.ts at the exact position the inline
 * registrations previously occupied, preserving global registration order.
 * Do not reorder registrations here and do not mount this module elsewhere.
 */
import type { Express } from "express";
import { db } from "../db";
import { sql, inArray, eq, and } from "drizzle-orm";
import { isAuthenticated } from "../middlewares/requireAuth";
import {
  getBlockedIPs,
  computeEffectiveLimits,
  getDefaultBlockDurationMs,
  setDefaultBlockDurationMs,
  getDefaultBlockDurationFallbackMs,
} from "../services/rateLimitMonitor";
import {
  DEFAULT_ROLE_RATE_LIMIT_MULTIPLIERS,
  getEffectiveMultipliers,
  invalidateMultipliersCache,
  loadRateLimitMultipliers,
  requireTeamLead,
} from "./middleware";
import { storage } from "../storage";
import { insertActivityLogs } from "../storage/activityStorage";
import { attachUserInfoToAudit } from "./auditAuxHelpers";
export function registerRateLimitMultiplierRoutes(app: Express): void {
  app.get("/api/admin/rate-limit-multipliers", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = userId ? await storage.getUser(userId) : null;
      if (!user || (user.role !== "ceo" && user.role !== "team_lead")) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const effective = await getEffectiveMultipliers();
      const effectiveLimits = computeEffectiveLimits(effective);
      const { getLimiterConfigs } = await import("../services/rateLimitMonitor");
      const limiterConfigs = Object.fromEntries(getLimiterConfigs());
      const { resolveLastEditedUsers, buildLastEdited } = await import("./lastEditedHelper");
      const setting = await storage.getSystemSetting("rate_limit_multipliers");
      const userMap = await resolveLastEditedUsers([setting?.updatedBy ?? null]);
      const lastEdited = buildLastEdited(setting?.updatedAt, setting?.updatedBy, userMap);
      res.json({
        defaults: DEFAULT_ROLE_RATE_LIMIT_MULTIPLIERS,
        effective,
        effectiveLimits,
        limiterConfigs,
        lastEdited,
      });
    } catch (err: any) {
      console.error("[RateLimitMultipliers] GET error:", err.message);
      res.status(500).json({ error: "Failed to fetch multipliers" });
    }
  });

  app.put("/api/admin/rate-limit-multipliers", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = userId ? await storage.getUser(userId) : null;
      if (!user || (user.role !== "ceo" && user.role !== "team_lead")) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const { multipliers } = req.body;
      if (!multipliers || typeof multipliers !== "object") {
        return res.status(400).json({ error: "multipliers object is required" });
      }
      for (const [role, value] of Object.entries(multipliers)) {
        if (typeof value !== "number" || value < 0.1 || value > 100) {
          return res.status(400).json({ error: `Invalid multiplier for ${role}: must be a number between 0.1 and 100` });
        }
      }
      const oldValues = await getEffectiveMultipliers();
      await storage.setSystemSetting(
        "rate_limit_multipliers",
        JSON.stringify(multipliers),
        userId
      );
      invalidateMultipliersCache();
      await loadRateLimitMultipliers({ silent: true });
      const effective = await getEffectiveMultipliers();
      try {
        const changedRoles = Object.keys({ ...oldValues, ...effective }).filter(
          (r) => oldValues[r] !== effective[r]
        );
        await insertActivityLogs([{
          userId,
          actionType: "rate_limit_multipliers_updated",
          route: "/admin/rate-limits",
          actionDetail: changedRoles.length > 0
            ? `Updated rate limit multipliers for: ${changedRoles.join(", ")}`
            : "Saved rate limit multipliers (no changes)",
          metadata: { oldValues, newValues: effective, changedRoles },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[RateLimitMultipliers] Audit log failed:", logErr.message);
      }
      try {
        const changedRoles = Object.keys({ ...oldValues, ...effective }).filter(
          (r) => oldValues[r] !== effective[r]
        );
        for (const role of changedRoles) {
          await storage.recordAdminSettingChange({
            settingKey: "rate_limit_multipliers",
            scope: role,
            changedBy: userId ?? null,
            oldValues: { multiplier: oldValues[role] ?? null },
            newValues: { multiplier: effective[role] ?? null },
          });
        }
      } catch (auditErr: any) {
        console.error("[RateLimitMultipliers] Setting audit failed:", auditErr.message);
      }
      res.json({ effective });
    } catch (err: any) {
      console.error("[RateLimitMultipliers] PUT error:", err.message);
      res.status(500).json({ error: "Failed to update multipliers" });
    }
  });

  app.post("/api/admin/rate-limit-multipliers/reset", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = userId ? await storage.getUser(userId) : null;
      if (!user || (user.role !== "ceo" && user.role !== "team_lead")) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const oldValues = await getEffectiveMultipliers();
      await storage.setSystemSetting(
        "rate_limit_multipliers",
        JSON.stringify(DEFAULT_ROLE_RATE_LIMIT_MULTIPLIERS),
        userId
      );
      invalidateMultipliersCache();
      await loadRateLimitMultipliers({ silent: true });
      try {
        await insertActivityLogs([{
          userId,
          actionType: "rate_limit_multipliers_reset",
          route: "/admin/rate-limits",
          actionDetail: "Reset rate limit multipliers to defaults",
          metadata: { oldValues, newValues: DEFAULT_ROLE_RATE_LIMIT_MULTIPLIERS },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[RateLimitMultipliers] Audit log failed:", logErr.message);
      }
      try {
        const newValues: Record<string, number> = DEFAULT_ROLE_RATE_LIMIT_MULTIPLIERS;
        const changedRoles = Object.keys({ ...oldValues, ...newValues }).filter(
          (r) => oldValues[r] !== newValues[r]
        );
        for (const role of changedRoles) {
          await storage.recordAdminSettingChange({
            settingKey: "rate_limit_multipliers",
            scope: role,
            changedBy: userId ?? null,
            oldValues: { multiplier: oldValues[role] ?? null },
            newValues: { multiplier: newValues[role] ?? null, reset: true },
          });
        }
      } catch (auditErr: any) {
        console.error("[RateLimitMultipliers] Setting audit failed:", auditErr.message);
      }
      res.json({ effective: DEFAULT_ROLE_RATE_LIMIT_MULTIPLIERS });
    } catch (err: any) {
      console.error("[RateLimitMultipliers] Reset error:", err.message);
      res.status(500).json({ error: "Failed to reset multipliers" });
    }
  });

  app.get("/api/admin/rate-limit-multipliers/history", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = userId ? await storage.getUser(userId) : null;
      if (!user || (user.role !== "ceo" && user.role !== "team_lead")) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
      const scope = typeof req.query.role === "string" && req.query.role.length > 0
        ? req.query.role
        : undefined;
      const changedByQuery = typeof req.query.changedBy === "string"
        ? req.query.changedBy.trim()
        : "";

      let changedByIn: string[] | undefined;
      if (changedByQuery.length > 0) {
        const { users } = await import("@shared/schema");
        const term = `%${changedByQuery.toLowerCase()}%`;
        const matches = await db
          .select({ id: users.id })
          .from(users)
          .where(sql`
            lower(coalesce(${users.email}, '')) like ${term}
            or lower(coalesce(${users.firstName}, '')) like ${term}
            or lower(coalesce(${users.lastName}, '')) like ${term}
            or lower(trim(coalesce(${users.firstName}, '') || ' ' || coalesce(${users.lastName}, ''))) like ${term}
            or lower(${users.id}) like ${term}
          `)
          .limit(200);
        changedByIn = matches.map((m) => m.id);
      }

      const parseDate = (v: unknown): Date | undefined => {
        if (typeof v !== "string" || v.trim() === "") return undefined;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? undefined : d;
      };
      const changedAfter = parseDate(req.query.changedAfter);
      const changedBefore = parseDate(req.query.changedBefore);

      const entries = await storage.listAdminSettingAudit({
        settingKey: "rate_limit_multipliers",
        scope,
        changedByIn,
        changedAfter,
        changedBefore,
        limit,
      });
      const history = await attachUserInfoToAudit(entries);
      res.json({ history });
    } catch (err: any) {
      console.error("[RateLimitMultipliers] History fetch failed:", err?.message);
      res.status(500).json({ error: "Failed to fetch multiplier history" });
    }
  });

  app.get("/api/admin/route-limiters", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      const user = userId ? await storage.getUser(userId) : null;
      if (!user || (user.role !== "ceo" && user.role !== "team_lead")) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { computeLimitersForRoute } = await import("./limiterMounts");
      const { getLimiterConfigs } = await import("../services/rateLimitMonitor");
      const { getCachedRouteInventory } = await import("../services/routeInventoryCache");

      const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
      const inventory = await getCachedRouteInventory({ forceRefresh });
      const routes = inventory.routes;

      const limiterToCategory: Record<string, string> = {
        apiLimiter: "api",
        authLimiter: "auth",
        webhookLimiter: "webhook",
        writeLimiter: "write",
        uploadLimiter: "upload",
        adminLimiter: "admin",
        sensitiveWriteLimiter: "sensitiveWrite",
        aiLimiter: "ai",
      };

      const configsMap = getLimiterConfigs();
      const limiterConfigs: Record<string, { windowMs: number; max: number; roleAware: boolean; category: string }> = {};
      for (const [limiterName, category] of Object.entries(limiterToCategory)) {
        const cfg = configsMap.get(category);
        if (cfg) {
          limiterConfigs[limiterName] = { ...cfg, category };
        }
      }

      const enriched = routes.map((r: any) => {
        const inline = r.rateLimiterName ?? null;
        const info = computeLimitersForRoute(r.method, r.path, inline);
        return {
          method: r.method,
          path: r.path,
          file: r.file,
          line: r.line,
          protection: r.protection,
          limiters: info.limiters,
          notes: info.notes,
        };
      });

      const unprotected = enriched.filter((r: any) => r.limiters.length === 0);
      const byLimiter: Record<string, number> = {};
      for (const r of enriched) {
        for (const l of r.limiters) {
          byLimiter[l] = (byLimiter[l] || 0) + 1;
        }
      }

      res.json({
        total: enriched.length,
        routes: enriched,
        limiterConfigs,
        summary: {
          byLimiter,
          unprotectedCount: unprotected.length,
        },
        generatedAt: new Date(inventory.generatedAt).toISOString(),
        expiresAt: new Date(inventory.expiresAt).toISOString(),
        cacheTtlMs: inventory.ttlMs,
        cached: inventory.cached,
      });
    } catch (err: any) {
      console.error("[RouteLimiters] Error:", err.message);
      res.status(500).json({ error: "Failed to fetch route limiters" });
    }
  });

  app.get("/api/health/blocked-ips", isAuthenticated, async (req: any, res) => {
    try {
      const blocked = getBlockedIPs();
      let cap: number | null = null;
      let historyByIp: Record<string, number> = {};
      try {
        const { BLOCKED_IP_AUDIT_KEY, getBlockedIpAuditRetention } = await import(
          "../services/auditRetention"
        );
        const { adminSettingAudit } = await import("@shared/schema");
        const info = await getBlockedIpAuditRetention();
        cap = info.maxEntriesPerIp;
        if (blocked.length > 0) {
          const ips = blocked.map((b) => b.ip);
          const rows = await db
            .select({
              scope: adminSettingAudit.scope,
              total: sql<number>`count(*)::int`,
            })
            .from(adminSettingAudit)
            .where(
              and(
                eq(adminSettingAudit.settingKey, BLOCKED_IP_AUDIT_KEY),
                inArray(adminSettingAudit.scope, ips),
              ),
            )
            .groupBy(adminSettingAudit.scope);
          for (const r of rows) {
            if (r.scope) historyByIp[r.scope] = Number(r.total ?? 0);
          }
        }
      } catch (capErr: any) {
        console.error(
          "[BlockedIPs] Failed to compute history usage:",
          capErr?.message ?? capErr,
        );
      }
      const enriched = blocked.map((b) => ({
        ...b,
        historyEntries: historyByIp[b.ip] ?? 0,
      }));
      res.json({ blockedIPs: enriched, historyCap: cap });
    } catch (err: any) {
      console.error("[BlockedIPs] Error:", err.message);
      res.status(500).json({ error: "Failed to fetch blocked IPs" });
    }
  });

  app.get("/api/health/rate-limits/default-block-duration", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    const { resolveLastEditedUsers, buildLastEdited } = await import("./lastEditedHelper");
    const setting = await storage.getSystemSetting("rate_limit_default_block_duration_ms");
    const userMap = await resolveLastEditedUsers([setting?.updatedBy ?? null]);
    const lastEdited = buildLastEdited(setting?.updatedAt, setting?.updatedBy, userMap);
    res.json({
      durationMs: getDefaultBlockDurationMs(),
      fallbackMs: getDefaultBlockDurationFallbackMs(),
      lastEdited,
    });
  });

  app.put("/api/health/rate-limits/default-block-duration", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const { durationMs } = req.body ?? {};
    let value: number | null;
    if (durationMs === null || durationMs === undefined || durationMs === "" || durationMs === "permanent") {
      value = null;
    } else {
      const n = Number(durationMs);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: "durationMs must be a positive number or null for permanent" });
      }
      const MAX = 365 * 24 * 60 * 60 * 1000;
      if (n > MAX) {
        return res.status(400).json({ error: "durationMs cannot exceed 1 year" });
      }
      value = n;
    }
    const oldValue = getDefaultBlockDurationMs();
    const userId = req.user?.claims?.sub ?? null;
    try {
      await setDefaultBlockDurationMs(value, userId ?? undefined);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
    if (oldValue !== value) {
      try {
        await storage.recordAdminSettingChange({
          settingKey: "rate_limit_default_block_duration",
          scope: null,
          changedBy: userId,
          oldValues: { durationMs: oldValue },
          newValues: { durationMs: value },
        });
      } catch (auditErr: any) {
        console.error("[DefaultBlockDuration] Setting audit failed:", auditErr?.message);
      }
    }
    res.json({ durationMs: value });
  });
}