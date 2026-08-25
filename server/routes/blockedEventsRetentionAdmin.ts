import type { Express } from "express";
import { sql, and, eq } from "drizzle-orm";

import { db } from "../db";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";
import {
  getBlockedEventsRetentionMs,
  setBlockedEventsRetentionMs,
  getBlockedEventsRetentionDefaultMs,
  pruneBlockedRateLimitEventsNow,
  getRecentBlockedEventsPruneSweeps,
  BLOCKED_EVENTS_RETENTION_MIN_MS,
  BLOCKED_EVENTS_RETENTION_MAX_MS,
} from "../services/rateLimitMonitor";
import { attachUserInfoToAudit, isValidIpOrCidr } from "./auditAuxHelpers";

/**
 * Mounts the blocked-events retention + per-IP blocked-IP history admin
 * endpoints. Extracted from `server/routes.ts` so tests can mount the real
 * handlers (with auth stubbed) instead of duplicating the logic.
 *
 * The routes covered here are intentionally narrow:
 *   - GET    /api/health/rate-limits/blocked-events-retention
 *   - GET    /api/health/rate-limits/blocked-events-retention/preview
 *   - GET    /api/health/rate-limits/blocked-events-retention/history
 *   - PUT    /api/health/rate-limits/blocked-events-retention   (confirm:true gate)
 *   - GET    /api/health/blocked-ips/:ip/history                 (merged + retention block)
 */
export function registerBlockedEventsRetentionAdminRoutes(app: Express): void {
  app.get(
    "/api/health/rate-limits/blocked-events-retention",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      const { resolveLastEditedUsers, buildLastEdited } = await import("./lastEditedHelper");
      const setting = await storage.getSystemSetting("rate_limit_blocked_events_retention_ms");
      const userMap = await resolveLastEditedUsers([setting?.updatedBy ?? null]);
      const lastEdited = buildLastEdited(setting?.updatedAt, setting?.updatedBy, userMap);
      res.json({
        retentionMs: getBlockedEventsRetentionMs(),
        defaultMs: getBlockedEventsRetentionDefaultMs(),
        minMs: BLOCKED_EVENTS_RETENTION_MIN_MS,
        maxMs: BLOCKED_EVENTS_RETENTION_MAX_MS,
        lastEdited,
      });
    },
  );

  app.get(
    "/api/health/rate-limits/blocked-events-retention/preview",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      const raw = req.query?.retentionMs;
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return res.status(400).json({ error: "retentionMs must be an integer number of milliseconds" });
      }
      if (n < BLOCKED_EVENTS_RETENTION_MIN_MS || n > BLOCKED_EVENTS_RETENTION_MAX_MS) {
        return res.status(400).json({
          error: `retentionMs must be between ${BLOCKED_EVENTS_RETENTION_MIN_MS} (1 day) and ${BLOCKED_EVENTS_RETENTION_MAX_MS} (1 year)`,
        });
      }
      try {
        const { countBlockedRateLimitEventsOlderThan } = await import(
          "../storage/blockedRateLimitEventsStorage"
        );
        const cutoff = Date.now() - n;
        const affectedRows = await countBlockedRateLimitEventsOlderThan(cutoff);
        const currentMs = getBlockedEventsRetentionMs();
        res.json({
          retentionMs: n,
          currentRetentionMs: currentMs,
          shortening: n < currentMs,
          affectedRows,
          cutoffTimestamp: cutoff,
        });
      } catch (err: any) {
        console.error("[BlockedEventsRetention] Preview failed:", err?.message);
        res.status(500).json({ error: "Failed to preview retention impact" });
      }
    },
  );

  app.get(
    "/api/health/rate-limits/blocked-events-retention/sweeps",
    isAuthenticated,
    requireTeamLead,
    (_req: any, res) => {
      try {
        const sweeps = getRecentBlockedEventsPruneSweeps();
        res.json({ sweeps });
      } catch (err: any) {
        console.error("[BlockedEventsRetention] Sweeps fetch failed:", err?.message);
        res.status(500).json({ error: "Failed to fetch prune sweep history" });
      }
    },
  );

  app.get(
    "/api/health/rate-limits/blocked-events-retention/history",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
        const entries = await storage.listAdminSettingAudit({
          settingKey: "rate_limit_blocked_events_retention",
          limit,
        });
        const history = await attachUserInfoToAudit(entries);
        res.json({ history });
      } catch (err: any) {
        console.error("[BlockedEventsRetention] History fetch failed:", err?.message);
        res.status(500).json({ error: "Failed to fetch retention history" });
      }
    },
  );

  app.post(
    "/api/health/rate-limits/blocked-events-retention/prune",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const result = await pruneBlockedRateLimitEventsNow();
        res.json({
          deleted: result.deleted,
          durationMs: result.durationMs,
          cutoffTimestamp: result.cutoff,
          retentionMs: getBlockedEventsRetentionMs(),
        });
      } catch (err: any) {
        console.error("[BlockedEventsRetention] On-demand prune failed:", err?.message);
        res.status(500).json({ error: "Failed to run prune sweep" });
      }
    },
  );

  app.put(
    "/api/health/rate-limits/blocked-events-retention",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      const { retentionMs, confirm } = req.body ?? {};
      const n = Number(retentionMs);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return res.status(400).json({ error: "retentionMs must be an integer number of milliseconds" });
      }
      if (n < BLOCKED_EVENTS_RETENTION_MIN_MS || n > BLOCKED_EVENTS_RETENTION_MAX_MS) {
        return res.status(400).json({
          error: `retentionMs must be between ${BLOCKED_EVENTS_RETENTION_MIN_MS} (1 day) and ${BLOCKED_EVENTS_RETENTION_MAX_MS} (1 year)`,
        });
      }
      const oldValue = getBlockedEventsRetentionMs();

      // Destructive-action confirmation: when shortening retention, require an
      // explicit confirm flag and surface a row-count estimate so admins know
      // how many blocked-event rows the next prune will delete.
      if (n < oldValue && confirm !== true) {
        try {
          const { countBlockedRateLimitEventsOlderThan } = await import(
            "../storage/blockedRateLimitEventsStorage"
          );
          const cutoff = Date.now() - n;
          const affectedRows = await countBlockedRateLimitEventsOlderThan(cutoff);
          return res.status(409).json({
            error: "confirmation_required",
            requiresConfirm: true,
            affectedRows,
            currentRetentionMs: oldValue,
            retentionMs: n,
            message:
              `Shortening blocked-event retention will permanently delete ${affectedRows} ` +
              `row(s) older than the new window. Re-submit with confirm:true to proceed.`,
          });
        } catch (err: any) {
          console.error("[BlockedEventsRetention] Confirm preview failed:", err?.message);
          return res.status(500).json({ error: "Failed to estimate retention impact" });
        }
      }

      const userId = req.user?.claims?.sub ?? null;
      try {
        await setBlockedEventsRetentionMs(n, userId ?? undefined);
      } catch (err: any) {
        return res.status(400).json({ error: err.message });
      }
      if (oldValue !== n) {
        try {
          await storage.recordAdminSettingChange({
            settingKey: "rate_limit_blocked_events_retention",
            scope: null,
            changedBy: userId,
            oldValues: { retentionMs: oldValue },
            newValues: { retentionMs: n },
          });
        } catch (auditErr: any) {
          console.error("[BlockedEventsRetention] Setting audit failed:", auditErr?.message);
        }
      }
      res.json({ retentionMs: n });
    },
  );

  app.get("/api/health/blocked-ips/:ip/history", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const ipParam = req.params.ip;
    if (!ipParam || typeof ipParam !== "string") {
      return res.status(400).json({ error: "IP address is required" });
    }
    const ip = ipParam.trim();
    if (!isValidIpOrCidr(ip)) {
      return res.status(400).json({ error: "Invalid IP address or CIDR range" });
    }
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
      const { BLOCKED_IP_AUDIT_TRIMMED_KEY, BLOCKED_IP_AUDIT_KEY, getBlockedIpAuditRetention } =
        await import("../services/auditRetention");
      const { adminSettingAudit } = await import("@shared/schema");
      const [entries, trimEntries, retentionInfo, blockedCountRow, trimAggRow] = await Promise.all([
        storage.listAdminSettingAudit({
          settingKey: BLOCKED_IP_AUDIT_KEY,
          scope: ip,
          limit,
        }),
        storage.listAdminSettingAudit({
          settingKey: BLOCKED_IP_AUDIT_TRIMMED_KEY,
          scope: ip,
          limit,
        }),
        getBlockedIpAuditRetention(),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(adminSettingAudit)
          .where(
            and(
              eq(adminSettingAudit.settingKey, BLOCKED_IP_AUDIT_KEY),
              eq(adminSettingAudit.scope, ip),
            ),
          )
          .then((rows) => rows[0]),
        db
          .select({
            total: sql<number>`count(*)::int`,
            trimmedSum: sql<number>`coalesce(sum((new_values->>'trimmedCount')::int), 0)::int`,
          })
          .from(adminSettingAudit)
          .where(
            and(
              eq(adminSettingAudit.settingKey, BLOCKED_IP_AUDIT_TRIMMED_KEY),
              eq(adminSettingAudit.scope, ip),
            ),
          )
          .then((rows) => rows[0]),
      ]);
      const merged = [...entries, ...trimEntries].sort((a, b) => {
        const at = a.changedAt ? new Date(a.changedAt as any).getTime() : 0;
        const bt = b.changedAt ? new Date(b.changedAt as any).getTime() : 0;
        return bt - at;
      }).slice(0, limit);
      const history = await attachUserInfoToAudit(merged);
      const totalBlockedIpEntries = Number(blockedCountRow?.total ?? 0);
      const totalTrimEvents = Number(trimAggRow?.total ?? 0);
      const trimmedTotal = Number(trimAggRow?.trimmedSum ?? 0);
      const shownBlockedIpEntries = merged.filter(
        (e) => e.settingKey === BLOCKED_IP_AUDIT_KEY,
      ).length;
      const cap = retentionInfo.maxEntriesPerIp;
      const trimmedConfirmed = totalTrimEvents > 0;
      const atCap = totalBlockedIpEntries >= cap;
      const truncated = trimmedConfirmed || atCap;
      res.json({
        history,
        retention: {
          cap,
          source: retentionInfo.source,
          shownBlockedIpEntries,
          totalBlockedIpEntries,
          trimmedTotal,
          trimmedConfirmed,
          atCap,
          truncated,
        },
      });
    } catch (err: any) {
      console.error("[BlockedIPs] History fetch failed:", err?.message);
      res.status(500).json({ error: "Failed to fetch blocked IP history" });
    }
  });
}
