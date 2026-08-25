// @db-pool-intent: api
/**
 * PR9 split (Task f1425127) — extracted VERBATIM from server/routes.ts
 * (formerly inline at lines 1659–2025 at split time).
 *
 * DB server-side diagnostics (slow queries / indexes / bloat), markdown health report export, health digest config + manual trigger, and the manual-reserve digest config/history routes.
 *
 * Mount-order contract: registerHealthDiagnosticsAndDigestRoutes(app) is invoked from
 * registerRoutes() in server/routes.ts at the exact position the inline
 * registrations previously occupied, preserving global registration order.
 * Do not reorder registrations here and do not mount this module elsewhere.
 */
import type { Express } from "express";
import { db } from "../../db";
import { and } from "drizzle-orm";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireTeamLead } from "../middleware";
import { storage } from "../../storage";
export function registerHealthDiagnosticsAndDigestRoutes(app: Express): void {
  // Phase 5 — DB server-side metrics (admin-gated, cached, timeout-protected)
  app.get("/api/health/db/slow-queries", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { getSlowQueries } = await import("../../services/dbServerMetrics");
      res.json(await getSlowQueries());
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch slow queries" });
    }
  });

  app.get("/api/health/db/locks", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { getLocks } = await import("../../services/dbServerMetrics");
      res.json(await getLocks());
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch lock waits" });
    }
  });

  app.get("/api/health/db/table-health", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { getTableHealth } = await import("../../services/dbServerMetrics");
      res.json(await getTableHealth());
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch table health" });
    }
  });

  // Task #3814 — per-table size trend (covered high-churn tables), fed by
  // the table-size watchdog's table_size_samples rows.
  app.get("/api/health/db/table-size-trend", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
      const { buildTableSizeTrendSummary } = await import("../../services/tableSizeWatchdog");
      res.json(await buildTableSizeTrendSummary(days * 24 * 60 * 60_000));
    } catch (err: any) {
      console.error("[TableSizeTrend] failed:", err?.message ?? err);
      res.status(500).json({ error: "Failed to fetch table size trend" });
    }
  });

  app.get("/api/health/db/metric-availability", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { getMetricAvailability } = await import("../../services/dbServerMetrics");
      res.json(await getMetricAvailability());
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch metric availability" });
    }
  });

  // Phase 10 — Markdown export
  app.get("/api/health/report", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const range = (req.query.range === "7d" ? "7d" : "24h") as "24h" | "7d";
      const { buildHealthReportMarkdown } = await import("../../services/healthReportExport");
      const md = await buildHealthReportMarkdown(range);
      const filename = `health-report-${range}-${new Date().toISOString().slice(0, 10)}.md`;
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(md);
    } catch (err: any) {
      console.error("[HealthReportExport] failed:", err?.message ?? err);
      res.status(500).json({ error: "Failed to build report" });
    }
  });

  // Phase 9 — digest config + manual trigger
  app.get("/api/health/digest/config", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { getSystemSetting } = await import("../../storage/settingsStorage");
      const [enabled, hour, snoozedUntil, channel, lastSent] = await Promise.all([
        getSystemSetting("health.digest.enabled"),
        getSystemSetting("health.digest.hour_utc"),
        getSystemSetting("health.digest.snoozed_until"),
        getSystemSetting("health.digest.channel"),
        getSystemSetting("health.digest.last_sent_date"),
      ]);
      res.json({
        enabled: enabled?.value === "true",
        hourUtc: hour?.value ? Number(hour.value) : 14,
        snoozedUntil: snoozedUntil?.value ? Number(snoozedUntil.value) : null,
        channel: channel?.value ?? null,
        lastSentDate: lastSent?.value ?? null,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch digest config" });
    }
  });

  app.put("/api/health/digest/config", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { setSystemSetting, deleteSystemSetting } = await import("../../storage/settingsStorage");
      const by = req.user?.claims?.sub ?? "unknown";
      if (req.body?.enabled !== undefined) {
        await setSystemSetting("health.digest.enabled", req.body.enabled ? "true" : "false", by);
      }
      if (req.body?.hourUtc !== undefined) {
        const h = Number(req.body.hourUtc);
        if (!Number.isFinite(h) || h < 0 || h > 23) {
          return res.status(400).json({ error: "hourUtc must be 0..23" });
        }
        await setSystemSetting("health.digest.hour_utc", String(Math.floor(h)), by);
      }
      if (req.body?.channel !== undefined) {
        const v = String(req.body.channel ?? "").trim();
        if (v) await setSystemSetting("health.digest.channel", v, by);
        else await deleteSystemSetting("health.digest.channel");
      }
      if (req.body?.snoozeMinutes !== undefined) {
        const m = Number(req.body.snoozeMinutes);
        if (m > 0) {
          await setSystemSetting("health.digest.snoozed_until", String(Date.now() + m * 60_000), by);
        } else {
          await deleteSystemSetting("health.digest.snoozed_until");
        }
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to update digest config" });
    }
  });

  app.post("/api/health/digest/send-now", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { maybeSendDigest } = await import("../../services/healthSlackDigest");
      const r = await maybeSendDigest();
      res.json(r);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to send digest" });
    }
  });

  // Task #711 — Slack digest summarizing recent reserve-pressure spikes.
  app.get(
    "/api/health/manual-reserve-digest/config",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { getManualReserveDigestConfig } = await import(
          "../../services/manualReserveDigest"
        );
        const config = await getManualReserveDigestConfig();
        res.json(config);
      } catch (err: any) {
        console.error(
          "[manual-reserve-digest] config read failed:",
          err?.message || err,
        );
        res.status(500).json({ error: "Failed to fetch digest config" });
      }
    },
  );

  app.put(
    "/api/health/manual-reserve-digest/config",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { setSystemSetting, deleteSystemSetting } = await import(
          "../../storage/settingsStorage"
        );
        const {
          SETTING_ENABLED,
          SETTING_CADENCE,
          SETTING_HOUR,
          SETTING_WEEKDAY,
          SETTING_WINDOW_HOURS,
          SETTING_CHANNEL,
          SETTING_SNOOZED,
          SETTING_METRICS,
          parseMetricsSetting,
        } = await import("../../services/manualReserveDigest");
        const by = req.user?.claims?.sub ?? "unknown";
        const body = req.body ?? {};
        if (body.enabled !== undefined) {
          await setSystemSetting(SETTING_ENABLED, body.enabled ? "true" : "false", by);
        }
        if (body.cadence !== undefined) {
          const v = String(body.cadence).trim().toLowerCase();
          if (v !== "daily" && v !== "weekly") {
            return res.status(400).json({ error: "cadence must be 'daily' or 'weekly'" });
          }
          await setSystemSetting(SETTING_CADENCE, v, by);
        }
        if (body.hourUtc !== undefined) {
          const h = Number(body.hourUtc);
          if (!Number.isFinite(h) || h < 0 || h > 23) {
            return res.status(400).json({ error: "hourUtc must be 0..23" });
          }
          await setSystemSetting(SETTING_HOUR, String(Math.floor(h)), by);
        }
        if (body.weekdayUtc !== undefined) {
          const d = Number(body.weekdayUtc);
          if (!Number.isFinite(d) || d < 0 || d > 6) {
            return res.status(400).json({ error: "weekdayUtc must be 0..6 (Sun=0)" });
          }
          await setSystemSetting(SETTING_WEEKDAY, String(Math.floor(d)), by);
        }
        if (body.windowHours !== undefined) {
          const w = Number(body.windowHours);
          if (!Number.isFinite(w) || w < 1 || w > 24 * 14) {
            return res.status(400).json({ error: "windowHours must be 1..336" });
          }
          await setSystemSetting(SETTING_WINDOW_HOURS, String(Math.floor(w)), by);
        }
        if (body.channel !== undefined) {
          const v = String(body.channel ?? "").trim();
          if (v) await setSystemSetting(SETTING_CHANNEL, v, by);
          else await deleteSystemSetting(SETTING_CHANNEL);
        }
        if (body.metrics !== undefined) {
          // Task #1181 — Accept array OR comma-separated string. Empty list
          // clears the setting and restores the legacy "all metrics" mode.
          const raw = Array.isArray(body.metrics)
            ? body.metrics.map((s: any) => String(s ?? "")).join(",")
            : String(body.metrics ?? "");
          const list = parseMetricsSetting(raw);
          for (const name of list) {
            if (name.length > 200) {
              return res.status(400).json({ error: "metric name too long (max 200 chars)" });
            }
            if (!/^[A-Za-z0-9_:.\-]+$/.test(name)) {
              return res
                .status(400)
                .json({ error: `invalid metric name: ${name}` });
            }
          }
          if (list.length > 50) {
            return res.status(400).json({ error: "too many metrics (max 50)" });
          }
          if (list.length > 0) {
            await setSystemSetting(SETTING_METRICS, list.join(","), by);
          } else {
            await deleteSystemSetting(SETTING_METRICS);
          }
        }
        if (body.snoozeMinutes !== undefined) {
          const m = Number(body.snoozeMinutes);
          if (m > 0) {
            await setSystemSetting(
              SETTING_SNOOZED,
              String(Date.now() + m * 60_000),
              by,
            );
          } else {
            await deleteSystemSetting(SETTING_SNOOZED);
          }
        }
        res.json({ ok: true });
      } catch (err: any) {
        console.error(
          "[manual-reserve-digest] config write failed:",
          err?.message || err,
        );
        res.status(500).json({ error: "Failed to update digest config" });
      }
    },
  );

  app.post(
    "/api/health/manual-reserve-digest/send-now",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        const { sendManualReserveDigest } = await import(
          "../../services/manualReserveDigest"
        );
        const r = await sendManualReserveDigest({
          triggerSource: "manual",
          bypassSchedule: true,
        });
        res.json(r);
      } catch (err: any) {
        console.error(
          "[manual-reserve-digest] send-now failed:",
          err?.message || err,
        );
        res.status(500).json({ error: "Failed to send digest" });
      }
    },
  );

  app.get(
    "/api/health/manual-reserve-digest/preview",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { buildDigestSummary, formatDigestText, getManualReserveDigestConfig } =
          await import("../../services/manualReserveDigest");
        const config = await getManualReserveDigestConfig();
        const overrideHours = Number.parseInt(String(req.query?.windowHours ?? ""), 10);
        const windowHours =
          Number.isFinite(overrideHours) && overrideHours > 0 && overrideHours <= 24 * 14
            ? overrideHours
            : config.windowHours;
        const summary = await buildDigestSummary(windowHours, undefined, config.metrics);
        const message = formatDigestText(summary, config.cadence);
        res.json({ summary, message, cadence: config.cadence });
      } catch (err: any) {
        console.error(
          "[manual-reserve-digest] preview failed:",
          err?.message || err,
        );
        res.status(500).json({ error: "Failed to build digest preview" });
      }
    },
  );

  // Task #1183 — recent send history for the reserve-pressure digest, so admins
  // can see what was sent (and whether delivery succeeded/failed) without
  // leaving the Health Dashboard.
  app.get(
    "/api/health/manual-reserve-digest/history",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const { NOTIFICATION_ID } = await import(
          "../../services/manualReserveDigest"
        );
        const { listNotificationDeliveries } = await import(
          "../../storage/notificationsStorage"
        );
        const limitParam = Number.parseInt(String(req.query?.limit ?? ""), 10);
        const limit =
          Number.isFinite(limitParam) && limitParam > 0
            ? Math.min(limitParam, 50)
            : 10;
        const rows = await listNotificationDeliveries(NOTIFICATION_ID, limit);
        const deliveries = rows.map((r) => {
          const meta = (r.metadataJson ?? null) as
            | Record<string, unknown>
            | null;
          const skipReason =
            meta && typeof meta.skipReason === "string"
              ? (meta.skipReason as string)
              : null;
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
          };
        });
        res.json({ notificationId: NOTIFICATION_ID, deliveries });
      } catch (err: any) {
        console.error(
          "[manual-reserve-digest] history read failed:",
          err?.message || err,
        );
        res.status(500).json({ error: "Failed to fetch digest history" });
      }
    },
  );
}