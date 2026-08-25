// @db-pool-intent: api
/**
 * PR9 split (Task f1425127) — extracted VERBATIM from server/routes.ts
 * (formerly inline at lines 5763–5961 at split time).
 *
 * Operator IP blocking: block-ip, per-IP expiry update, unblock-ip, blocked-IP activity feed, and trim-notification listing.
 *
 * Mount-order contract: registerIpBlockingRoutes(app) is invoked from
 * registerRoutes() in server/routes.ts at the exact position the inline
 * registrations previously occupied, preserving global registration order.
 * Do not reorder registrations here and do not mount this module elsewhere.
 */
import type { Express } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { blockIP, unblockIP, updateBlockExpiry, getBlockedIPs, getDefaultBlockDurationMs } from "../services/rateLimitMonitor";
import { requireTeamLead } from "./middleware";
import { storage } from "../storage";
import { isValidIpOrCidr, attachUserInfoToAudit } from "./auditAuxHelpers";
export function registerIpBlockingRoutes(app: Express): void {
  app.post("/api/health/block-ip", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const { ip, reason, durationMs } = req.body;
    if (!ip || typeof ip !== "string") {
      return res.status(400).json({ error: "IP address is required" });
    }
    const trimmed = ip.trim();
    if (!isValidIpOrCidr(trimmed)) {
      return res.status(400).json({ error: "Invalid IP address or CIDR range" });
    }
    let duration: number | undefined;
    if (durationMs === undefined) {
      const def = getDefaultBlockDurationMs();
      if (def != null) duration = def;
    } else if (durationMs !== null) {
      const n = Number(durationMs);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: "durationMs must be a positive number" });
      }
      const MAX = 365 * 24 * 60 * 60 * 1000;
      if (n > MAX) {
        return res.status(400).json({ error: "durationMs cannot exceed 1 year" });
      }
      duration = n;
    }
    try {
      const added = await blockIP(trimmed, reason, duration);
      if (!added) {
        return res.status(409).json({ error: "IP is already blocked" });
      }
      const userId = req.user?.claims?.sub ?? null;
      const blockedEntry = getBlockedIPs().find((b) => b.ip === trimmed);
      try {
        await storage.recordAdminSettingChange({
          settingKey: "blocked_ip",
          scope: trimmed,
          changedBy: userId,
          oldValues: { blocked: false },
          newValues: {
            blocked: true,
            action: "block",
            expiresAt: blockedEntry?.expiresAt ?? null,
            reason: reason ?? null,
          },
        });
        try {
          const { pruneBlockedIpAuditForScope } = await import("../services/auditRetention");
          void pruneBlockedIpAuditForScope(trimmed);
        } catch (importErr: any) { console.error("[BlockedIPs] per-IP prune failed:", importErr?.message ?? importErr); }
      } catch (auditErr: any) {
        console.error("[BlockedIPs] Block audit failed:", auditErr?.message);
      }
      res.json({ message: `IP ${ip} has been blocked`, blockedIPs: getBlockedIPs() });
    } catch (err: any) {
      console.error("[BlockedIPs] Block error:", err.message);
      res.status(500).json({ error: "Failed to persist blocked IP" });
    }
  });

  app.patch("/api/health/blocked-ips/:ip/expiry", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const ipParam = req.params.ip;
    if (!ipParam || typeof ipParam !== "string") {
      return res.status(400).json({ error: "IP address is required" });
    }
    const ip = ipParam.trim();
    if (!isValidIpOrCidr(ip)) {
      return res.status(400).json({ error: "Invalid IP address or CIDR range" });
    }
    const { durationMs } = req.body ?? {};
    let duration: number | null = null;
    if (durationMs !== undefined && durationMs !== null) {
      const n = Number(durationMs);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: "durationMs must be a positive number" });
      }
      const MAX = 365 * 24 * 60 * 60 * 1000;
      if (n > MAX) {
        return res.status(400).json({ error: "durationMs cannot exceed 1 year" });
      }
      duration = n;
    }
    const oldEntry = getBlockedIPs().find((b) => b.ip === ip);
    const oldExpiresAt = oldEntry?.expiresAt ?? null;
    try {
      const result = await updateBlockExpiry(ip, duration);
      if (result === "not_found") {
        return res.status(404).json({ error: "IP is not currently blocked" });
      }
      const userId = req.user?.claims?.sub ?? null;
      const newEntry = getBlockedIPs().find((b) => b.ip === ip);
      const newExpiresAt = newEntry?.expiresAt ?? null;
      if (oldExpiresAt !== newExpiresAt) {
        try {
          await storage.recordAdminSettingChange({
            settingKey: "blocked_ip",
            scope: ip,
            changedBy: userId,
            oldValues: { expiresAt: oldExpiresAt },
            newValues: { action: "update_expiry", expiresAt: newExpiresAt },
          });
          try {
            const { pruneBlockedIpAuditForScope } = await import("../services/auditRetention");
            void pruneBlockedIpAuditForScope(ip);
          } catch (importErr: any) { console.error("[BlockedIPs] per-IP prune failed:", importErr?.message ?? importErr); }
        } catch (auditErr: any) {
          console.error("[BlockedIPs] Expiry audit failed:", auditErr?.message);
        }
      }
      res.json({
        message: duration == null ? `IP ${ip} is now permanent` : `IP ${ip} expiry updated`,
        blockedIPs: getBlockedIPs(),
      });
    } catch (err: any) {
      console.error("[BlockedIPs] Update expiry error:", err.message);
      res.status(500).json({ error: "Failed to update block expiry" });
    }
  });

  app.post("/api/health/unblock-ip", isAuthenticated, requireTeamLead, async (req: any, res) => {
    const { ip } = req.body;
    if (!ip || typeof ip !== "string") {
      return res.status(400).json({ error: "IP address is required" });
    }
    const trimmedIp = ip.trim();
    const oldEntry = getBlockedIPs().find((b) => b.ip === trimmedIp);
    try {
      const removed = await unblockIP(trimmedIp);
      if (!removed) {
        return res.status(404).json({ error: "IP was not in the block list" });
      }
      const userId = req.user?.claims?.sub ?? null;
      try {
        await storage.recordAdminSettingChange({
          settingKey: "blocked_ip",
          scope: trimmedIp,
          changedBy: userId,
          oldValues: {
            blocked: true,
            expiresAt: oldEntry?.expiresAt ?? null,
            reason: oldEntry?.reason ?? null,
          },
          newValues: { blocked: false, action: "unblock" },
        });
        try {
          const { pruneBlockedIpAuditForScope } = await import("../services/auditRetention");
          void pruneBlockedIpAuditForScope(trimmedIp);
        } catch (importErr: any) { console.error("[BlockedIPs] per-IP prune failed:", importErr?.message ?? importErr); }
      } catch (auditErr: any) {
        console.error("[BlockedIPs] Unblock audit failed:", auditErr?.message);
      }
      res.json({ message: `IP ${ip} has been unblocked`, blockedIPs: getBlockedIPs() });
    } catch (err: any) {
      console.error("[BlockedIPs] Unblock error:", err.message);
      res.status(500).json({ error: "Failed to remove blocked IP" });
    }
  });

  app.get("/api/health/blocked-ips/activity", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
      const entries = await storage.listAdminSettingAudit({
        settingKey: "blocked_ip",
        limit,
      });
      const activity = await attachUserInfoToAudit(entries);
      res.json({ activity });
    } catch (err: any) {
      console.error("[BlockedIPs] Activity feed fetch failed:", err?.message);
      res.status(500).json({ error: "Failed to fetch blocked IP activity" });
    }
  });

  app.get(
    "/api/health/blocked-ips/trim-notifications",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
        const { BLOCKED_IP_AUDIT_TRIMMED_KEY, getBlockedIpAuditRetention } = await import(
          "../services/auditRetention"
        );
        const [entries, info] = await Promise.all([
          storage.listAdminSettingAudit({
            settingKey: BLOCKED_IP_AUDIT_TRIMMED_KEY,
            limit,
          }),
          getBlockedIpAuditRetention(),
        ]);
        res.json({
          notifications: entries,
          cap: info.maxEntriesPerIp,
          source: info.source,
        });
      } catch (err: any) {
        console.error("[BlockedIPs] Trim notifications fetch failed:", err?.message);
        res.status(500).json({ error: "Failed to fetch trim notifications" });
      }
    },
  );
}