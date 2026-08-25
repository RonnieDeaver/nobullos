// @db-pool-intent: api
/**
 * PR9 split (Task f1425127) — extracted VERBATIM from server/routes.ts
 * (formerly inline at lines 4338–4851 at split time).
 *
 * Retention admin for rate-limit alert notifications and pending digest alerts: config get/put, prune previews, and manual prune-now routes.
 *
 * Mount-order contract: registerRateLimitRetentionRoutes(app) is invoked from
 * registerRoutes() in server/routes.ts at the exact position the inline
 * registrations previously occupied, preserving global registration order.
 * Do not reorder registrations here and do not mount this module elsewhere.
 */
import type { Express } from "express";
import { db } from "../db";
import { eq, desc, and } from "drizzle-orm";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";
import { storage } from "../storage";
import { attachUserInfoToAudit } from "./auditAuxHelpers";
export function registerRateLimitRetentionRoutes(app: Express): void {
  app.get(
    "/api/health/rate-limits/notification-retention",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const {
          getConfiguredRateLimitNotificationRetentionDays,
          getDefaultRateLimitNotificationRetentionDays,
          getFallbackRateLimitNotificationRetentionDays,
          getMaxRateLimitNotificationRetentionDays,
        } = await import("../services/rateLimitNotificationRetention");
        const {
          getAlertNotificationsRangeStats,
          countAlertNotificationsOlderThan,
        } = await import("../storage/rateLimitAlertNotificationsStorage");
        const { resolveLastEditedUsers, buildLastEdited } = await import(
          "./lastEditedHelper"
        );
        const setting = await storage.getSystemSetting(
          "rate_limit_notification_retention_days",
        );
        const retentionDays = await getConfiguredRateLimitNotificationRetentionDays();
        const userMap = await resolveLastEditedUsers([setting?.updatedBy ?? null]);
        const lastEdited = buildLastEdited(
          setting?.updatedAt,
          setting?.updatedBy,
          userMap,
        );
        let configuredRetentionDays: number | null = null;
        const rawConfigured = setting?.value?.trim();
        if (rawConfigured) {
          const parsed = Number.parseInt(rawConfigured, 10);
          if (Number.isInteger(parsed) && parsed >= 1) {
            configuredRetentionDays = parsed;
          }
        }
        const stats = await getAlertNotificationsRangeStats();
        const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const overdueRows = await countAlertNotificationsOlderThan(cutoffMs);
        // Optional preview: estimate how many rows would be pruned at a
        // proposed shorter retention. Surfaced to the UI so admins see the
        // impact before saving.
        let previewDays: number | null = null;
        let previewOverdue: number | null = null;
        const rawPreview = req.query?.previewDays;
        if (rawPreview != null && rawPreview !== "") {
          const n = Number(rawPreview);
          if (Number.isInteger(n) && n >= 1) {
            previewDays = n;
            const previewCutoff = Date.now() - n * 24 * 60 * 60 * 1000;
            previewOverdue = await countAlertNotificationsOlderThan(previewCutoff);
          }
        }
        res.json({
          retentionDays,
          configuredRetentionDays,
          defaultRetentionDays: getDefaultRateLimitNotificationRetentionDays(),
          fallbackRetentionDays: getFallbackRateLimitNotificationRetentionDays(),
          maxRetentionDays: getMaxRateLimitNotificationRetentionDays(),
          lastEdited,
          stats: {
            totalRows: stats.totalRows,
            oldestAttemptedAt: stats.oldestAttemptedAt,
            newestAttemptedAt: stats.newestAttemptedAt,
            overdueRows,
          },
          preview:
            previewDays != null
              ? { retentionDays: previewDays, overdueRows: previewOverdue ?? 0 }
              : null,
        });
      } catch (err: any) {
        console.error(
          "[RateLimitNotificationRetention] GET retention failed:",
          err.message,
        );
        res.status(500).json({ error: "Failed to load notification retention" });
      }
    },
  );

  app.put(
    "/api/health/rate-limits/notification-retention",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      const { retentionDays } = req.body ?? {};
      let value: number | null;
      if (
        retentionDays === null ||
        retentionDays === undefined ||
        retentionDays === ""
      ) {
        value = null;
      } else {
        const n = Number(retentionDays);
        if (!Number.isInteger(n) || n < 1) {
          return res
            .status(400)
            .json({ error: "retentionDays must be a positive integer or null" });
        }
        value = n;
      }
      try {
        const {
          setConfiguredRateLimitNotificationRetentionDays,
        } = await import("../services/rateLimitNotificationRetention");
        const previousSetting = await storage.getSystemSetting(
          "rate_limit_notification_retention_days",
        );
        let previousConfigured: number | null = null;
        const prevRaw = previousSetting?.value?.trim();
        if (prevRaw) {
          const parsed = Number.parseInt(prevRaw, 10);
          if (Number.isInteger(parsed) && parsed >= 1) {
            previousConfigured = parsed;
          }
        }
        const userId = req.user?.claims?.sub ?? null;
        const effective = await setConfiguredRateLimitNotificationRetentionDays(
          value,
          userId ?? undefined,
        );
        if (previousConfigured !== value) {
          try {
            await storage.recordAdminSettingChange({
              settingKey: "rate_limit_notification_retention_days",
              scope: null,
              changedBy: userId,
              oldValues: { retentionDays: previousConfigured },
              newValues: { retentionDays: value },
            });
          } catch (auditErr: any) {
            console.error(
              "[RateLimitNotificationRetention] Setting audit failed:",
              auditErr?.message,
            );
          }
        }
        res.json({ retentionDays: effective, configuredRetentionDays: value });
      } catch (err: any) {
        console.error(
          "[RateLimitNotificationRetention] PUT retention failed:",
          err.message,
        );
        res.status(400).json({ error: err.message || "Failed to update retention" });
      }
    },
  );

  // On-demand notification-history cleanup. Mirrors the nightly scheduled
  // prune but lets admins run it immediately from the UI (e.g. right after
  // shortening retention) without waiting for the cron tick.
  app.post(
    "/api/health/rate-limits/notification-retention/prune",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const {
          pruneOldRateLimitAlertNotificationsOnDemand,
          OnDemandPruneBusyError,
        } = await import("../services/rateLimitNotificationRetention");
        const rawOverride = req.body?.retentionDays;
        let override: number | undefined;
        if (rawOverride != null && rawOverride !== "") {
          const n = Number(rawOverride);
          if (!Number.isInteger(n) || n < 1) {
            return res
              .status(400)
              .json({ error: "retentionDays must be a positive integer" });
          }
          override = n;
        }
        try {
          const actorId = req.user?.claims?.sub ?? null;
          const result = await pruneOldRateLimitAlertNotificationsOnDemand(
            override,
            { triggeredBy: "on_demand", actorId },
          );
          console.log(
            `[RateLimitNotificationRetention] On-demand prune by user=${actorId ?? "unknown"} ` +
              `deleted=${result.deleted} retention=${result.retentionDays}d ` +
              `cutoff=${new Date(result.cutoffMs).toISOString()} ` +
              `duration=${result.durationMs}ms`,
          );
          res.json({
            deleted: result.deleted,
            retentionDays: result.retentionDays,
            cutoffMs: result.cutoffMs,
            durationMs: result.durationMs,
          });
        } catch (err: any) {
          if (err instanceof OnDemandPruneBusyError) {
            return res.status(429).json({ error: err.message });
          }
          throw err;
        }
      } catch (err: any) {
        console.error(
          "[RateLimitNotificationRetention] On-demand prune failed:",
          err?.message ?? err,
        );
        res
          .status(500)
          .json({ error: err?.message || "Failed to prune notification history" });
      }
    },
  );

  // History log of past notification-history cleanup runs (Task #1117).
  // Renders the "Recent cleanups" section on the admin Notification History
  // card and is exposed for export/filtering. One row per run; the prune
  // service writes a row after every scheduled or on-demand prune (success
  // or failure) via `recordPruneHistory`.
  app.get(
    "/api/health/rate-limits/notification-retention/history",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { listRateLimitNotificationPruneHistory } = await import(
          "../storage/rateLimitNotificationPruneHistoryStorage"
        );
        const { resolveLastEditedUsers } = await import(
          "./lastEditedHelper"
        );
        const rawLimit = req.query?.limit;
        let limit = 10;
        if (rawLimit != null && rawLimit !== "") {
          const n = Number(rawLimit);
          if (Number.isInteger(n) && n >= 1) {
            limit = Math.min(n, 200);
          }
        }
        const rows = await listRateLimitNotificationPruneHistory(limit);
        const userMap = await resolveLastEditedUsers(
          rows.map((r) => r.actorId),
        );
        const items = rows.map((r) => {
          const ranAt: Date | string | number = r.ranAt;
          const ranAtMs =
            ranAt instanceof Date ? ranAt.getTime() : new Date(ranAt).getTime();
          const actor = r.actorId ? userMap.get(r.actorId) ?? null : null;
          return {
            id: String(r.id),
            ranAtMs,
            triggeredBy: r.triggeredBy,
            actor: actor
              ? {
                  id: actor.id,
                  firstName: actor.firstName,
                  lastName: actor.lastName,
                  email: actor.email,
                }
              : null,
            actorId: r.actorId ?? null,
            retentionDays: r.retentionDays,
            cutoffMs: Number(r.cutoffMs),
            deletedRows: r.deletedRows,
            durationMs: r.durationMs,
            status: r.status,
            errorMessage: r.errorMessage ?? null,
          };
        });
        res.json({ items, limit });
      } catch (err: any) {
        console.error(
          "[RateLimitNotificationRetention] GET history failed:",
          err?.message ?? err,
        );
        res.status(500).json({ error: err?.message || "Failed to load cleanup history" });
      }
    },
  );

  // Pending-digest-alert retention: same shape as notification-retention but
  // for the queued warnings between digest flushes.
  app.get(
    "/api/health/rate-limits/pending-digest-retention",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const {
          getConfiguredPendingDigestAlertsRetentionDays,
          getDefaultPendingDigestAlertsRetentionDays,
          getFallbackPendingDigestAlertsRetentionDays,
          getMaxPendingDigestAlertsRetentionDays,
        } = await import("../services/pendingDigestAlertsRetention");
        const {
          getPendingDigestAlertsStats,
          countPendingDigestAlertsOlderThan,
        } = await import("../storage/pendingDigestAlertsStorage");
        const { resolveLastEditedUsers, buildLastEdited } = await import(
          "./lastEditedHelper"
        );
        const setting = await storage.getSystemSetting(
          "pending_digest_alerts_retention_days",
        );
        const retentionDays = await getConfiguredPendingDigestAlertsRetentionDays();
        const userMap = await resolveLastEditedUsers([setting?.updatedBy ?? null]);
        const lastEdited = buildLastEdited(
          setting?.updatedAt,
          setting?.updatedBy,
          userMap,
        );
        let configuredRetentionDays: number | null = null;
        const rawConfigured = setting?.value?.trim();
        if (rawConfigured) {
          const parsed = Number.parseInt(rawConfigured, 10);
          if (Number.isInteger(parsed) && parsed >= 1) {
            configuredRetentionDays = parsed;
          }
        }
        const stats = await getPendingDigestAlertsStats();
        const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const overdueRows = await countPendingDigestAlertsOlderThan(cutoffMs);
        let previewDays: number | null = null;
        let previewOverdue: number | null = null;
        const rawPreview = req.query?.previewDays;
        if (rawPreview != null && rawPreview !== "") {
          const n = Number(rawPreview);
          if (Number.isInteger(n) && n >= 1) {
            previewDays = n;
            const previewCutoff = Date.now() - n * 24 * 60 * 60 * 1000;
            previewOverdue = await countPendingDigestAlertsOlderThan(previewCutoff);
          }
        }
        res.json({
          retentionDays,
          configuredRetentionDays,
          defaultRetentionDays: getDefaultPendingDigestAlertsRetentionDays(),
          fallbackRetentionDays: getFallbackPendingDigestAlertsRetentionDays(),
          maxRetentionDays: getMaxPendingDigestAlertsRetentionDays(),
          lastEdited,
          stats: {
            totalRows: stats.totalRows,
            oldestQueuedAt: stats.oldestQueuedAt,
            newestQueuedAt: stats.newestQueuedAt,
            overdueRows,
          },
          preview:
            previewDays != null
              ? { retentionDays: previewDays, overdueRows: previewOverdue ?? 0 }
              : null,
        });
      } catch (err: any) {
        console.error(
          "[PendingDigestAlertsRetention] GET retention failed:",
          err?.message ?? err,
        );
        res
          .status(500)
          .json({ error: "Failed to load pending digest retention" });
      }
    },
  );

  app.put(
    "/api/health/rate-limits/pending-digest-retention",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      const { retentionDays } = req.body ?? {};
      let value: number | null;
      if (
        retentionDays === null ||
        retentionDays === undefined ||
        retentionDays === ""
      ) {
        value = null;
      } else {
        const n = Number(retentionDays);
        if (!Number.isInteger(n) || n < 1) {
          return res
            .status(400)
            .json({ error: "retentionDays must be a positive integer or null" });
        }
        value = n;
      }
      try {
        const {
          setConfiguredPendingDigestAlertsRetentionDays,
        } = await import("../services/pendingDigestAlertsRetention");
        const previousSetting = await storage.getSystemSetting(
          "pending_digest_alerts_retention_days",
        );
        let previousConfigured: number | null = null;
        const prevRaw = previousSetting?.value?.trim();
        if (prevRaw) {
          const parsed = Number.parseInt(prevRaw, 10);
          if (Number.isInteger(parsed) && parsed >= 1) {
            previousConfigured = parsed;
          }
        }
        const userId = req.user?.claims?.sub ?? null;
        const effective = await setConfiguredPendingDigestAlertsRetentionDays(
          value,
          userId ?? undefined,
        );
        if (previousConfigured !== value) {
          try {
            await storage.recordAdminSettingChange({
              settingKey: "pending_digest_alerts_retention_days",
              scope: null,
              changedBy: userId,
              oldValues: { retentionDays: previousConfigured },
              newValues: { retentionDays: value },
            });
          } catch (auditErr: any) {
            console.error(
              "[PendingDigestAlertsRetention] Setting audit failed:",
              auditErr?.message,
            );
          }
        }
        res.json({ retentionDays: effective, configuredRetentionDays: value });
      } catch (err: any) {
        console.error(
          "[PendingDigestAlertsRetention] PUT retention failed:",
          err?.message ?? err,
        );
        res
          .status(400)
          .json({ error: err?.message || "Failed to update retention" });
      }
    },
  );

  app.get(
    "/api/health/rate-limits/pending-digest-retention/history",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { ensureAdminSettingAuditTable } = await import(
          "../storage/settingsStorage"
        );
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
          .where(
            eq(
              adminSettingAudit.settingKey,
              "pending_digest_alerts_retention_days",
            ),
          )
          .orderBy(desc(adminSettingAudit.changedAt))
          .limit(20);
        const history = await attachUserInfoToAudit(entries);
        res.json({ history });
      } catch (err: any) {
        console.error(
          "[PendingDigestAlertsRetention] History fetch failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to fetch pending digest retention history" });
      }
    },
  );

  app.post(
    "/api/health/rate-limits/pending-digest-retention/prune",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { prunePendingDigestAlerts } = await import(
          "../services/pendingDigestAlertsRetention"
        );
        const rawOverride = req.body?.retentionDays;
        let override: number | undefined;
        if (rawOverride != null && rawOverride !== "") {
          const n = Number(rawOverride);
          if (!Number.isInteger(n) || n < 1) {
            return res
              .status(400)
              .json({ error: "retentionDays must be a positive integer" });
          }
          override = n;
        }
        const result = await prunePendingDigestAlerts(override);
        res.json({
          deleted: result.deleted,
          retentionDays: result.retentionDays,
          cutoffMs: result.cutoffMs,
        });
      } catch (err: any) {
        console.error(
          "[PendingDigestAlertsRetention] On-demand prune failed:",
          err?.message ?? err,
        );
        res
          .status(500)
          .json({
            error: err?.message || "Failed to prune pending digest alerts",
          });
      }
    },
  );
}