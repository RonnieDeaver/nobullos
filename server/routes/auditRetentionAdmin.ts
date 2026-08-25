// @db-pool-intent: api
/**
 * PR9 split (Task f1425127) — extracted VERBATIM from server/routes.ts
 * (formerly inline at lines 2672–3592 at split time).
 *
 * Admin audit-retention config (/api/admin/audit-retention*), blocked-IP audit retention + trim-alert config/history, audit-prune anomaly config, client-contacts audit retention, audit stats and single-entry fetch.
 *
 * Mount-order contract: registerAuditRetentionAdminRoutes(app) is invoked from
 * registerRoutes() in server/routes.ts at the exact position the inline
 * registrations previously occupied, preserving global registration order.
 * Do not reorder registrations here and do not mount this module elsewhere.
 */
import type { Express } from "express";
import { db } from "../db";
import { inArray, eq, desc, and } from "drizzle-orm";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";
import { storage } from "../storage";
import { attachUserInfoToAudit } from "./auditAuxHelpers";
export function registerAuditRetentionAdminRoutes(app: Express): void {
  app.get("/api/admin/audit-retention", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const {
        getAuditRetentionDays,
      } = await import("../services/auditRetention");
      const { resolveLastEditedUsers, buildLastEdited } = await import("./lastEditedHelper");
      const info = await getAuditRetentionDays();
      const userMap = await resolveLastEditedUsers([info.updatedBy]);
      const lastEdited = buildLastEdited(info.updatedAt, info.updatedBy, userMap);
      res.json({
        retentionDays: info.retentionDays,
        source: info.source,
        defaultDays: info.defaultDays,
        envDays: info.envDays,
        minDays: info.minDays,
        maxDays: info.maxDays,
        lastEdited,
      });
    } catch (err: any) {
      console.error("[AuditRetention] GET failed:", err?.message);
      res.status(500).json({ error: "Failed to load audit retention setting" });
    }
  });

  app.put("/api/admin/audit-retention", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const raw = req.body?.retentionDays;
      const days = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
      const {
        setAuditRetentionDays,
        AuditRetentionValidationError,
      } = await import("../services/auditRetention");
      const userId = req.user?.claims?.sub ?? null;
      let info;
      try {
        info = await setAuditRetentionDays(days, userId);
      } catch (validationErr: any) {
        if (validationErr instanceof AuditRetentionValidationError) {
          return res.status(400).json({ error: validationErr.message });
        }
        throw validationErr;
      }
      const { resolveLastEditedUsers, buildLastEdited } = await import("./lastEditedHelper");
      const userMap = await resolveLastEditedUsers([info.updatedBy]);
      const lastEdited = buildLastEdited(info.updatedAt, info.updatedBy, userMap);
      res.json({
        retentionDays: info.retentionDays,
        source: info.source,
        defaultDays: info.defaultDays,
        envDays: info.envDays,
        minDays: info.minDays,
        maxDays: info.maxDays,
        lastEdited,
      });
    } catch (err: any) {
      console.error("[AuditRetention] PUT failed:", err?.message);
      res.status(500).json({ error: "Failed to update audit retention setting" });
    }
  });

  app.get("/api/admin/blocked-ip-audit-retention", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { getBlockedIpAuditRetention } = await import("../services/auditRetention");
      const { resolveLastEditedUsers, buildLastEdited } = await import("./lastEditedHelper");
      const info = await getBlockedIpAuditRetention();
      const userMap = await resolveLastEditedUsers([info.updatedBy]);
      const lastEdited = buildLastEdited(info.updatedAt, info.updatedBy, userMap);
      res.json({
        maxEntriesPerIp: info.maxEntriesPerIp,
        source: info.source,
        defaultMax: info.defaultMax,
        envMax: info.envMax,
        minMax: info.minMax,
        maxMax: info.maxMax,
        lastEdited,
      });
    } catch (err: any) {
      console.error("[BlockedIpAuditRetention] GET failed:", err?.message);
      res.status(500).json({ error: "Failed to load blocked IP audit retention setting" });
    }
  });

  app.put("/api/admin/blocked-ip-audit-retention", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const raw = req.body?.maxEntriesPerIp;
      const value = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
      const {
        setBlockedIpAuditMaxPerIp,
        getBlockedIpAuditRetention,
        AuditRetentionValidationError,
      } = await import("../services/auditRetention");
      const userId = req.user?.claims?.sub ?? null;
      try {
        await setBlockedIpAuditMaxPerIp(value, userId);
      } catch (validationErr: any) {
        if (validationErr instanceof AuditRetentionValidationError) {
          return res.status(400).json({ error: validationErr.message });
        }
        throw validationErr;
      }
      const info = await getBlockedIpAuditRetention();
      const { resolveLastEditedUsers, buildLastEdited } = await import("./lastEditedHelper");
      const userMap = await resolveLastEditedUsers([info.updatedBy]);
      const lastEdited = buildLastEdited(info.updatedAt, info.updatedBy, userMap);
      res.json({
        maxEntriesPerIp: info.maxEntriesPerIp,
        source: info.source,
        defaultMax: info.defaultMax,
        envMax: info.envMax,
        minMax: info.minMax,
        maxMax: info.maxMax,
        lastEdited,
      });
    } catch (err: any) {
      console.error("[BlockedIpAuditRetention] PUT failed:", err?.message);
      res.status(500).json({ error: "Failed to update blocked IP audit retention setting" });
    }
  });

  // Task #780 — out-of-band trim notifications config (email + throttling).
  app.get(
    "/api/admin/blocked-ip-trim-alert-config",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { getBlockedIpTrimAlertConfig, DEFAULTS } = await import(
          "../services/blockedIpTrimAlerts"
        );
        const cfg = await getBlockedIpTrimAlertConfig();
        res.json({
          enabled: cfg.enabled,
          email: cfg.email,
          emailRecipients: cfg.emailRecipients,
          minTrims: cfg.minTrims,
          batchWindowSeconds: cfg.batchWindowSeconds,
          perIpCooldownMinutes: cfg.perIpCooldownMinutes,
          overrides: cfg.overrides,
          defaults: DEFAULTS,
        });
      } catch (err: any) {
        console.error("[BlockedIpTrimAlert] GET config failed:", err?.message);
        res.status(500).json({ error: "Failed to load trim-alert config" });
      }
    },
  );

  app.put(
    "/api/admin/blocked-ip-trim-alert-config",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const {
          getBlockedIpTrimAlertConfig,
          SETTING_ENABLED,
          SETTING_EMAIL,
          SETTING_MIN_TRIMS,
          SETTING_BATCH_WINDOW,
          SETTING_COOLDOWN,
          SETTING_OVERRIDES,
          validateScopePattern,
        } = await import("../services/blockedIpTrimAlerts");
        const { setSystemSetting } = await import("../storage/settingsStorage");
        const userId = req.user?.claims?.sub ?? null;
        const body = req.body ?? {};
        const before = await getBlockedIpTrimAlertConfig();

        if (typeof body.enabled === "boolean") {
          await setSystemSetting(
            SETTING_ENABLED,
            body.enabled ? "true" : "false",
            userId ?? undefined,
          );
        }
        if (typeof body.email === "string") {
          await setSystemSetting(SETTING_EMAIL, body.email.trim(), userId ?? undefined);
        }
        if (body.minTrims !== undefined) {
          const n = Number.parseInt(String(body.minTrims), 10);
          if (!Number.isFinite(n) || n <= 0 || n > 100_000) {
            return res
              .status(400)
              .json({ error: "minTrims must be a positive integer ≤ 100000" });
          }
          await setSystemSetting(SETTING_MIN_TRIMS, String(n), userId ?? undefined);
        }
        if (body.batchWindowSeconds !== undefined) {
          const n = Number.parseInt(String(body.batchWindowSeconds), 10);
          if (!Number.isFinite(n) || n < 5 || n > 3600) {
            return res.status(400).json({
              error: "batchWindowSeconds must be between 5 and 3600",
            });
          }
          await setSystemSetting(SETTING_BATCH_WINDOW, String(n), userId ?? undefined);
        }
        if (body.perIpCooldownMinutes !== undefined) {
          const n = Number.parseInt(String(body.perIpCooldownMinutes), 10);
          if (!Number.isFinite(n) || n <= 0 || n > 7 * 24 * 60) {
            return res.status(400).json({
              error: "perIpCooldownMinutes must be between 1 and 10080",
            });
          }
          await setSystemSetting(SETTING_COOLDOWN, String(n), userId ?? undefined);
        }
        if (body.overrides !== undefined) {
          if (!Array.isArray(body.overrides)) {
            return res
              .status(400)
              .json({ error: "overrides must be an array" });
          }
          if (body.overrides.length > 100) {
            return res
              .status(400)
              .json({ error: "overrides limited to 100 entries" });
          }
          const cleaned: Array<{
            scopePattern: string;
            minTrims?: number;
            perIpCooldownMinutes?: number;
          }> = [];
          for (let i = 0; i < body.overrides.length; i++) {
            const raw = body.overrides[i];
            if (!raw || typeof raw !== "object") {
              return res
                .status(400)
                .json({ error: `overrides[${i}] must be an object` });
            }
            const scopePattern =
              typeof raw.scopePattern === "string" ? raw.scopePattern.trim() : "";
            if (!scopePattern) {
              return res.status(400).json({
                error: `overrides[${i}].scopePattern is required`,
              });
            }
            if (scopePattern.length > 200) {
              return res.status(400).json({
                error: `overrides[${i}].scopePattern is too long`,
              });
            }
            // Validate that the pattern itself is well-formed (CIDR parses,
            // glob compiles). Rejects e.g. `1.2.3.0/99` or `1.2.3.0/abc` so a
            // typo never silently becomes a never-matching override.
            const patternErr = validateScopePattern(scopePattern);
            if (patternErr) {
              return res.status(400).json({
                error: `overrides[${i}].scopePattern is invalid: ${patternErr}`,
              });
            }
            const entry: { scopePattern: string; minTrims?: number; perIpCooldownMinutes?: number } = {
              scopePattern,
            };
            if (raw.minTrims !== undefined && raw.minTrims !== null && raw.minTrims !== "") {
              const n = Number.parseInt(String(raw.minTrims), 10);
              if (!Number.isFinite(n) || n <= 0 || n > 100_000) {
                return res.status(400).json({
                  error: `overrides[${i}].minTrims must be a positive integer ≤ 100000`,
                });
              }
              entry.minTrims = n;
            }
            if (
              raw.perIpCooldownMinutes !== undefined &&
              raw.perIpCooldownMinutes !== null &&
              raw.perIpCooldownMinutes !== ""
            ) {
              const n = Number.parseInt(String(raw.perIpCooldownMinutes), 10);
              if (!Number.isFinite(n) || n < 0 || n > 7 * 24 * 60) {
                return res.status(400).json({
                  error: `overrides[${i}].perIpCooldownMinutes must be between 0 and 10080`,
                });
              }
              entry.perIpCooldownMinutes = n;
            }
            if (entry.minTrims === undefined && entry.perIpCooldownMinutes === undefined) {
              return res.status(400).json({
                error: `overrides[${i}] must set at least one of minTrims / perIpCooldownMinutes`,
              });
            }
            cleaned.push(entry);
          }
          await setSystemSetting(
            SETTING_OVERRIDES,
            JSON.stringify(cleaned),
            userId ?? undefined,
          );
        }

        const after = await getBlockedIpTrimAlertConfig();
        // Audit row so changes show up in the existing admin-setting audit
        // surfaces.
        try {
          await storage.recordAdminSettingChange({
            settingKey: "blocked_ip_trim_alert_config",
            scope: null,
            changedBy: userId && userId !== "system" ? userId : null,
            oldValues: {
              enabled: before.enabled,
              email: before.email,
              minTrims: before.minTrims,
              batchWindowSeconds: before.batchWindowSeconds,
              perIpCooldownMinutes: before.perIpCooldownMinutes,
              overrides: before.overrides,
            },
            newValues: {
              enabled: after.enabled,
              email: after.email,
              minTrims: after.minTrims,
              batchWindowSeconds: after.batchWindowSeconds,
              perIpCooldownMinutes: after.perIpCooldownMinutes,
              overrides: after.overrides,
            },
          });
        } catch {}

        res.json({
          enabled: after.enabled,
          email: after.email,
          emailRecipients: after.emailRecipients,
          minTrims: after.minTrims,
          batchWindowSeconds: after.batchWindowSeconds,
          perIpCooldownMinutes: after.perIpCooldownMinutes,
          overrides: after.overrides,
        });
      } catch (err: any) {
        console.error("[BlockedIpTrimAlert] PUT config failed:", err?.message);
        res.status(500).json({ error: "Failed to update trim-alert config" });
      }
    },
  );

  app.post(
    "/api/admin/blocked-ip-trim-alert-config/test",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { sendBlockedIpTrimAlertTest } = await import(
          "../services/blockedIpTrimAlerts"
        );
        const r = await sendBlockedIpTrimAlertTest();
        res.json({ result: r });
      } catch (err: any) {
        console.error("[BlockedIpTrimAlert] test send failed:", err?.message);
        res.status(500).json({ error: "Failed to send test alert" });
      }
    },
  );

  // Task #1237 — manual flush of the pending trim-alert buffer. Wraps
  // `triggerBlockedIpTrimAlertFlushNow` so admins can force the next batch
  // through without waiting for the batch-window timer.
  app.post(
    "/api/admin/blocked-ip-trim-alert-config/flush",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { triggerBlockedIpTrimAlertFlushNow } = await import(
          "../services/blockedIpTrimAlerts"
        );
        const r = await triggerBlockedIpTrimAlertFlushNow();
        res.json({ result: r });
      } catch (err: any) {
        console.error("[BlockedIpTrimAlert] manual flush failed:", err?.message);
        res.status(500).json({ error: "Failed to flush pending trim alerts" });
      }
    },
  );

  // Task #1237 — recent `usage.blocked_ip_audit.trimmed` delivery history,
  // sourced from `notification_deliveries` via the canonical dispatcher.
  app.get(
    "/api/admin/blocked-ip-trim-alert-history",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { NOTIFICATION_ID } = await import(
          "../services/blockedIpTrimAlerts"
        );
        const { listNotificationDeliveries } = await import(
          "../storage/notificationsStorage"
        );
        const limitParam = Number.parseInt(String(req.query?.limit ?? ""), 10);
        const limit =
          Number.isFinite(limitParam) && limitParam > 0
            ? Math.min(limitParam, 100)
            : 20;
        const rows = await listNotificationDeliveries(NOTIFICATION_ID, limit);
        const deliveries = rows.map((r) => {
          const meta = (r.metadataJson ?? null) as
            | Record<string, unknown>
            | null;
          const skipReason =
            meta && typeof meta.skipReason === "string"
              ? (meta.skipReason as string)
              : null;
          const totalTrimmed =
            meta && typeof meta.totalTrimmed === "number"
              ? (meta.totalTrimmed as number)
              : null;
          const scopes =
            meta && typeof meta.scopes === "number"
              ? (meta.scopes as number)
              : null;
          const cap =
            meta && typeof meta.cap === "number" ? (meta.cap as number) : null;
          const createdAtIso =
            r.createdAt instanceof Date
              ? r.createdAt.toISOString()
              : new Date(r.createdAt).toISOString();
          return {
            id: r.id,
            createdAt: createdAtIso,
            status: r.status,
            channelId: r.channelId,
            channelName: r.channelName,
            errorMessage: r.errorMessage,
            errorCode: r.errorCode,
            skipReason,
            triggerSource: r.triggerSource,
            scopes,
            totalTrimmed,
            cap,
          };
        });
        res.json({ notificationId: NOTIFICATION_ID, deliveries });
      } catch (err: any) {
        console.error(
          "[BlockedIpTrimAlert] history read failed:",
          err?.message,
        );
        res.status(500).json({ error: "Failed to fetch trim-alert history" });
      }
    },
  );

  // Task #1219 — admin-tunable audit-prune anomaly alert thresholds.
  app.get(
    "/api/admin/audit-prune-anomaly-config",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const {
          getAuditPruneAnomalyConfig,
          SETTING_ENABLED,
          SETTING_MIN_ROWS,
          SETTING_RATIO,
          SETTING_BASELINE_WINDOW,
          SETTING_COOLDOWN,
          AUDIT_PRUNE_ANOMALY_DEFAULTS,
        } = await import("../services/auditPruneAnomalyAlerts");
        const cfg = await getAuditPruneAnomalyConfig();
        const { resolveLastEditedUsers, buildLastEdited } = await import(
          "./lastEditedHelper"
        );
        const settingKeys = [
          SETTING_ENABLED,
          SETTING_MIN_ROWS,
          SETTING_RATIO,
          SETTING_BASELINE_WINDOW,
          SETTING_COOLDOWN,
        ];
        const settings = await Promise.all(
          settingKeys.map((k) => storage.getSystemSetting(k).catch(() => null)),
        );
        const updatedBys = settings
          .map((s) => s?.updatedBy ?? null)
          .filter((v): v is string => !!v);
        const userMap = await resolveLastEditedUsers(updatedBys);
        const toMs = (v: Date | string | null | undefined): number => {
          if (!v) return 0;
          const d = v instanceof Date ? v : new Date(v);
          const t = d.getTime();
          return Number.isFinite(t) ? t : 0;
        };
        const newest = settings
          .filter((s): s is NonNullable<typeof s> => !!s && !!s.updatedAt)
          .sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt))[0];
        const lastEdited = buildLastEdited(
          newest?.updatedAt ?? null,
          newest?.updatedBy ?? null,
          userMap,
        );
        res.json({
          enabled: cfg.enabled,
          minRows: cfg.minRows,
          ratioMultiplier: cfg.ratioMultiplier,
          baselineWindow: cfg.baselineWindow,
          cooldownMinutes: cfg.cooldownMinutes,
          defaults: AUDIT_PRUNE_ANOMALY_DEFAULTS,
          bounds: {
            minRowsMin: 1,
            minRowsMax: 10_000_000,
            ratioMultiplierMin: 1,
            ratioMultiplierMax: 1000,
            baselineWindowMin: 1,
            baselineWindowMax: 1000,
            cooldownMinutesMin: 1,
            cooldownMinutesMax: 7 * 24 * 60,
          },
          lastEdited,
        });
      } catch (err: any) {
        console.error(
          "[AuditPruneAnomalyConfig] GET failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to load audit-prune anomaly config" });
      }
    },
  );

  app.put(
    "/api/admin/audit-prune-anomaly-config",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const {
          getAuditPruneAnomalyConfig,
          SETTING_ENABLED,
          SETTING_MIN_ROWS,
          SETTING_RATIO,
          SETTING_BASELINE_WINDOW,
          SETTING_COOLDOWN,
          AUDIT_PRUNE_ANOMALY_CONFIG_AUDIT_KEY,
        } = await import("../services/auditPruneAnomalyAlerts");
        const { setSystemSetting } = await import("../storage/settingsStorage");
        const userId = req.user?.claims?.sub ?? null;
        const body = req.body ?? {};

        // Validate every provided field BEFORE writing anything so a malformed
        // later field can't leave earlier ones partially persisted.
        const writes: Array<{ key: string; value: string }> = [];
        if (typeof body.enabled === "boolean") {
          writes.push({ key: SETTING_ENABLED, value: body.enabled ? "true" : "false" });
        }
        if (body.minRows !== undefined) {
          const n = Number.parseInt(String(body.minRows), 10);
          if (!Number.isFinite(n) || n < 1 || n > 10_000_000) {
            return res
              .status(400)
              .json({ error: "minRows must be an integer between 1 and 10000000" });
          }
          writes.push({ key: SETTING_MIN_ROWS, value: String(n) });
        }
        if (body.ratioMultiplier !== undefined) {
          const n = Number.parseFloat(String(body.ratioMultiplier));
          if (!Number.isFinite(n) || n < 1 || n > 1000) {
            return res.status(400).json({
              error: "ratioMultiplier must be a number between 1 and 1000",
            });
          }
          writes.push({ key: SETTING_RATIO, value: String(n) });
        }
        if (body.baselineWindow !== undefined) {
          const n = Number.parseInt(String(body.baselineWindow), 10);
          if (!Number.isFinite(n) || n < 1 || n > 1000) {
            return res.status(400).json({
              error: "baselineWindow must be an integer between 1 and 1000",
            });
          }
          writes.push({ key: SETTING_BASELINE_WINDOW, value: String(n) });
        }
        if (body.cooldownMinutes !== undefined) {
          const n = Number.parseInt(String(body.cooldownMinutes), 10);
          if (!Number.isFinite(n) || n < 1 || n > 7 * 24 * 60) {
            return res.status(400).json({
              error: "cooldownMinutes must be an integer between 1 and 10080",
            });
          }
          writes.push({ key: SETTING_COOLDOWN, value: String(n) });
        }

        const before = await getAuditPruneAnomalyConfig();
        for (const w of writes) {
          await setSystemSetting(w.key, w.value, userId ?? undefined);
        }

        const after = await getAuditPruneAnomalyConfig();
        try {
          await storage.recordAdminSettingChange({
            settingKey: AUDIT_PRUNE_ANOMALY_CONFIG_AUDIT_KEY,
            scope: null,
            changedBy: userId && userId !== "system" ? userId : null,
            oldValues: {
              enabled: before.enabled,
              minRows: before.minRows,
              ratioMultiplier: before.ratioMultiplier,
              baselineWindow: before.baselineWindow,
              cooldownMinutes: before.cooldownMinutes,
            },
            newValues: {
              enabled: after.enabled,
              minRows: after.minRows,
              ratioMultiplier: after.ratioMultiplier,
              baselineWindow: after.baselineWindow,
              cooldownMinutes: after.cooldownMinutes,
            },
          });
        } catch (auditErr: any) {
          console.error(
            "[AuditPruneAnomalyConfig] audit log failed:",
            auditErr?.message,
          );
        }

        res.json({
          enabled: after.enabled,
          minRows: after.minRows,
          ratioMultiplier: after.ratioMultiplier,
          baselineWindow: after.baselineWindow,
          cooldownMinutes: after.cooldownMinutes,
        });
      } catch (err: any) {
        console.error(
          "[AuditPruneAnomalyConfig] PUT failed:",
          err?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to update audit-prune anomaly config" });
      }
    },
  );

  app.get("/api/admin/audit-retention/history", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
      const { ADMIN_AUDIT_RETENTION_KEY, BLOCKED_IP_AUDIT_MAX_PER_IP_KEY, AUDIT_PRUNE_MANUAL_KEY } = await import("../services/auditRetention");
      const { AUDIT_PRUNE_ANOMALY_CONFIG_AUDIT_KEY } = await import(
        "../services/auditPruneAnomalyAlerts"
      );
      const [daysEntries, ipEntries, manualPruneEntries, anomalyEntries] = await Promise.all([
        storage.listAdminSettingAudit({ settingKey: ADMIN_AUDIT_RETENTION_KEY, limit }),
        storage.listAdminSettingAudit({ settingKey: BLOCKED_IP_AUDIT_MAX_PER_IP_KEY, limit }),
        storage.listAdminSettingAudit({ settingKey: AUDIT_PRUNE_MANUAL_KEY, limit }),
        storage.listAdminSettingAudit({ settingKey: AUDIT_PRUNE_ANOMALY_CONFIG_AUDIT_KEY, limit }),
      ]);
      const merged = [...daysEntries, ...ipEntries, ...manualPruneEntries, ...anomalyEntries].sort((a, b) => {
        const at = a.changedAt ? new Date(a.changedAt).getTime() : 0;
        const bt = b.changedAt ? new Date(b.changedAt).getTime() : 0;
        return bt - at;
      }).slice(0, limit);
      const history = await attachUserInfoToAudit(merged);
      res.json({ history });
    } catch (err: any) {
      console.error("[AuditRetention] History fetch failed:", err?.message);
      res.status(500).json({ error: "Failed to fetch audit retention history" });
    }
  });

  app.get("/api/admin/audit-retention/prune-events", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
      const { listPruneEvents } = await import("../services/auditPruneEvents");
      type PruneTable = import("../services/auditPruneEvents").PruneTable;
      type PruneEvent = import("../services/auditPruneEvents").PruneEvent;
      const { getBlockedIpAuditRetention, getClientContactsAuditRetention } = await import("../services/auditRetention");
      const {
        getAuditPruneAnomalyConfig,
        summarizePruneEventDecision,
      } = await import("../services/auditPruneAnomalyAlerts");
      const [adminEvents, staleEvents, queueEvents, blockedIpEvents, clientContactsEvents, blockedIpInfo, clientContactsInfo, anomalyConfig] = await Promise.all([
        listPruneEvents("admin_setting_audit", limit),
        listPruneEvents("stale_lease_threshold_audit", limit),
        listPruneEvents("queue_timing_audit", limit),
        listPruneEvents("blocked_ip_audit", limit),
        listPruneEvents("client_contacts_audit", limit),
        getBlockedIpAuditRetention(),
        getClientContactsAuditRetention(),
        getAuditPruneAnomalyConfig(),
      ]);

      // Per-table "successful alert dispatch timestamps" sourced from
      // notification_deliveries (Task #1218). The dispatcher records the
      // per-row `metadata_json.table` for `infra.audit_prune.unusually_large_delete`
      // so we can group deliveries by audit table and pass them into the
      // summarizer for *event-time* (not wall-clock) cooldown decisions.
      type DeliveryMetadata = { table?: PruneTable | string };
      const deliveriesByTable = new Map<string, string[]>();
      try {
        const { notificationDeliveries } = await import("@shared/models/notifications");
        const recentRows = await db
          .select({
            createdAt: notificationDeliveries.createdAt,
            metadataJson: notificationDeliveries.metadataJson,
          })
          .from(notificationDeliveries)
          .where(
            and(
              eq(
                notificationDeliveries.notificationId,
                "infra.audit_prune.unusually_large_delete",
              ),
              eq(notificationDeliveries.status, "success"),
            ),
          )
          .orderBy(desc(notificationDeliveries.createdAt))
          .limit(200);
        for (const row of recentRows) {
          const meta = (row.metadataJson ?? null) as DeliveryMetadata | null;
          const t = meta && typeof meta.table === "string" ? meta.table : null;
          if (!t) continue;
          const iso =
            row.createdAt instanceof Date
              ? row.createdAt.toISOString()
              : String(row.createdAt);
          const list = deliveriesByTable.get(t);
          if (list) list.push(iso);
          else deliveriesByTable.set(t, [iso]);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[AuditRetention] last-alerted lookup failed:", msg);
      }

      const summarize = (table: PruneTable, events: PruneEvent[]) =>
        summarizePruneEventDecision(events, anomalyConfig, {
          deliveryTimestamps: deliveriesByTable.get(table) ?? [],
        });

      const userIds = Array.from(new Set(
        [...adminEvents, ...staleEvents, ...queueEvents, ...blockedIpEvents, ...clientContactsEvents]
          .map((e) => e.triggeredBy)
          .filter((id): id is string => !!id && id !== "system"),
      ));
      const userMap = new Map<string, string>();
      if (userIds.length > 0) {
        const { users } = await import("@shared/schema");
        const rows = await db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(users)
          .where(inArray(users.id, userIds));
        for (const u of rows) {
          const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
          userMap.set(u.id, name || u.email || u.id);
        }
      }
      const enrich = (e: any) => ({
        ...e,
        triggeredByName: e.triggeredBy ? (userMap.get(e.triggeredBy) ?? null) : null,
      });

      res.json({
        adminSettingAudit: {
          events: adminEvents.map(enrich),
          anomaly: summarize("admin_setting_audit", adminEvents),
        },
        staleLeaseThresholdAudit: {
          events: staleEvents.map(enrich),
          anomaly: summarize("stale_lease_threshold_audit", staleEvents),
        },
        queueTimingAudit: {
          events: queueEvents.map(enrich),
          anomaly: summarize("queue_timing_audit", queueEvents),
        },
        blockedIpAudit: {
          events: blockedIpEvents.map(enrich),
          maxEntriesPerIp: blockedIpInfo.maxEntriesPerIp,
          anomaly: summarize("blocked_ip_audit", blockedIpEvents),
        },
        clientContactsAudit: {
          events: clientContactsEvents.map(enrich),
          retentionDays: clientContactsInfo.retentionDays,
          minPerContact: clientContactsInfo.minPerContact,
          anomaly: summarize("client_contacts_audit", clientContactsEvents),
        },
        anomalyConfig,
      });
    } catch (err: any) {
      console.error("[AuditRetention] Prune events fetch failed:", err?.message);
      res.status(500).json({ error: "Failed to fetch audit prune events" });
    }
  });

  app.post("/api/admin/audit-retention/prune-now", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { triggerAuditPruneNow } = await import("../services/auditRetention");
      const userId = req.user?.claims?.sub ?? null;
      const result = await triggerAuditPruneNow(userId);
      if (!result) {
        return res.status(409).json({ error: "A prune is already running. Try again in a moment." });
      }
      // Include the most recent blocked_ip and client_contacts_audit prune
      // counts for operator parity (those are pruned in the same run but
      // tracked separately).
      let blockedIpDeleted: number | null = null;
      let clientContactsDeleted: number | null = null;
      try {
        const { listPruneEvents } = await import("../services/auditPruneEvents");
        const [recentIp, recentCc] = await Promise.all([
          listPruneEvents("blocked_ip_audit", 1),
          listPruneEvents("client_contacts_audit", 1),
        ]);
        blockedIpDeleted = recentIp[0]?.removed ?? 0;
        clientContactsDeleted = recentCc[0]?.removed ?? 0;
      } catch {}
      res.json({
        result: {
          ...result,
          blockedIpAuditDeleted: blockedIpDeleted,
          clientContactsAuditDeleted: clientContactsDeleted,
        },
      });
    } catch (err: any) {
      console.error("[AuditRetention] Manual prune failed:", err?.message);
      res.status(500).json({ error: "Failed to run audit prune" });
    }
  });

  // Task #1000 — read/write the per-contact retention policy and stats,
  // and trigger a focused prune of just client_contacts_audit.
  app.get("/api/admin/client-contacts-audit-retention", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { getClientContactsAuditRetention, getClientContactsAuditStats } = await import("../services/auditRetention");
      const [info, stats] = await Promise.all([
        getClientContactsAuditRetention(),
        getClientContactsAuditStats(),
      ]);
      res.json({
        retentionDays: info.retentionDays,
        retentionDaysSource: info.retentionDaysSource,
        retentionDaysUpdatedAt: info.retentionDaysUpdatedAt,
        minPerContact: info.minPerContact,
        minPerContactSource: info.minPerContactSource,
        minPerContactUpdatedAt: info.minPerContactUpdatedAt,
        defaultRetentionDays: info.defaultRetentionDays,
        defaultMinPerContact: info.defaultMinPerContact,
        minDays: info.minDays,
        maxDays: info.maxDays,
        minPerContactMin: info.minPerContactMin,
        minPerContactMax: info.minPerContactMax,
        stats,
      });
    } catch (err: any) {
      console.error("[AuditRetention] client_contacts retention GET failed:", err?.message);
      res.status(500).json({ error: "Failed to fetch client_contacts retention" });
    }
  });

  app.put("/api/admin/client-contacts-audit-retention", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { setClientContactsAuditRetention, AuditRetentionValidationError } = await import("../services/auditRetention");
      const userId = req.user?.claims?.sub ?? null;
      const { retentionDays, minPerContact } = req.body ?? {};
      const patch: { retentionDays?: number; minPerContact?: number } = {};
      if (retentionDays !== undefined) patch.retentionDays = Number(retentionDays);
      if (minPerContact !== undefined) patch.minPerContact = Number(minPerContact);
      try {
        const next = await setClientContactsAuditRetention(patch, userId);
        res.json(next);
      } catch (err: any) {
        if (err instanceof AuditRetentionValidationError) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
    } catch (err: any) {
      console.error("[AuditRetention] client_contacts retention PUT failed:", err?.message);
      res.status(500).json({ error: "Failed to update client_contacts retention" });
    }
  });

  app.post("/api/admin/client-contacts-audit-retention/prune-now", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { triggerClientContactsAuditPruneNow } = await import("../services/auditRetention");
      const userId = req.user?.claims?.sub ?? null;
      const result = await triggerClientContactsAuditPruneNow(userId);
      if (!result) {
        return res.status(409).json({ error: "A client_contacts prune is already running. Try again in a moment." });
      }
      res.json({ result });
    } catch (err: any) {
      console.error("[AuditRetention] client_contacts manual prune failed:", err?.message);
      res.status(500).json({ error: "Failed to run client_contacts audit prune" });
    }
  });

  app.get("/api/admin/audit-retention/stats", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { getAuditRetentionStats } = await import("../services/auditRetention");
      let previewDays: number | null = null;
      const raw = req.query.previewDays;
      if (raw !== undefined && raw !== "") {
        const n = Number.parseInt(String(raw), 10);
        if (Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 3650) {
          previewDays = n;
        }
      }
      const stats = await getAuditRetentionStats(previewDays);
      res.json(stats);
    } catch (err: any) {
      console.error("[AuditRetention] Stats fetch failed:", err?.message);
      res.status(500).json({ error: "Failed to fetch audit retention stats" });
    }
  });

  app.get("/api/admin/audit-retention/audit/:id", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const id = String(req.params.id ?? "").trim();
      if (!id) return res.status(400).json({ error: "id is required" });
      const entry = await storage.getAdminSettingAuditById(id);
      if (!entry) return res.status(404).json({ error: "Audit entry not found" });
      const [enriched] = await attachUserInfoToAudit([entry as any]);
      res.json({ entry: enriched });
    } catch (err: any) {
      console.error("[AuditRetention] Audit row fetch failed:", err?.message);
      res.status(500).json({ error: "Failed to fetch audit entry" });
    }
  });
}