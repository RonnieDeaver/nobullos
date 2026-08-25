// @db-pool-intent: api
/**
 * PR9 split (Task f1425127) — extracted VERBATIM from server/routes.ts
 * (formerly inline at lines 2027–2179 + module helpers 168–222 at split time).
 *
 * Manual-reserve alert admin: recent dispatches list, alert config, test-dispatch, history CSV export, and the resend route (handleManualReserveAlertsResend stays exported for test mounting).
 *
 * Mount-order contract: registerManualReserveAlertsAdminRoutes(app) is invoked from
 * registerRoutes() in server/routes.ts at the exact position the inline
 * registrations previously occupied, preserving global registration order.
 * Do not reorder registrations here and do not mount this module elsewhere.
 */
import type { Express } from "express";
import { db } from "../../db";
import { inArray } from "drizzle-orm";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireTeamLead } from "../middleware";
/**
 * Exported so integration tests (tests/alert-resend-routes.test.ts, Task #799)
 * can mount the real handler on a minimal Express app without pulling in the
 * entire registerRoutes bundle.
 */
export async function handleManualReserveAlertsResend(req: any, res: any) {
  try {
    const { resendManualReserveAlert } = await import("../../services/manualReserveAlerts");
    const timestamp = Number(req.body?.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return res.status(400).json({ error: "Missing or invalid 'timestamp'" });
    }
    const metric = typeof req.body?.metric === "string" ? req.body.metric : undefined;
    const rawSeverity = typeof req.body?.severity === "string" ? req.body.severity : undefined;
    const severity: "warning" | "critical" | undefined =
      rawSeverity === "warning" || rawSeverity === "critical" ? rawSeverity : undefined;
    const triggerActorId = req.user?.claims?.sub ?? null;
    const result = await resendManualReserveAlert({
      timestamp,
      metric,
      severity,
      actorId: triggerActorId,
      source: "admin_ui",
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        return res.status(404).json({ error: "Alert dispatch not found in recent history" });
      }
      if (result.reason === "not_eligible") {
        return res.status(409).json({
          error: result.message || "Alert is not eligible for resend",
        });
      }
      if (result.reason === "cooldown") {
        return res.status(429).json({
          error: result.message || "Resend is cooling down",
          cooldownRemainingMs: result.cooldownRemainingMs,
        });
      }
      if (result.reason === "in_flight") {
        return res.status(409).json({
          error: result.message || "Resend already in progress",
        });
      }
      if (result.reason === "broadcast_failed") {
        return res.status(502).json({ error: result.message || "Broadcast failed" });
      }
      return res.status(500).json({ error: "Resend failed" });
    }
    res.json({ ok: true, dispatch: result.dispatch });
  } catch (err: any) {
    console.error("[manual-reserve-alerts] resend failed:", err?.message || err);
    res.status(500).json({ error: err?.message || "Internal error" });
  }
}

export function registerManualReserveAlertsAdminRoutes(app: Express): void {
  app.get("/api/health/manual-reserve-alerts", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { getRecentManualReserveAlertDispatches } = await import("../../services/manualReserveAlerts");
      const limitParam = parseInt(String(req.query?.limit ?? ""), 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 100;

      const sinceRaw = parseInt(String(req.query?.since ?? ""), 10);
      const sinceTimestamp = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : undefined;

      const splitCsv = (raw: unknown): string[] | undefined => {
        if (raw === undefined || raw === null || raw === "") return undefined;
        const arr = String(raw)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        return arr.length > 0 ? arr : undefined;
      };
      const eventTypes = splitCsv(req.query?.eventType);
      const severities = splitCsv(req.query?.severity);
      const metric = req.query?.metric ? String(req.query.metric).trim() || undefined : undefined;

      const dispatches = await getRecentManualReserveAlertDispatches({
        limit,
        sinceTimestamp,
        eventTypes,
        severities,
        metric,
      });

      const userIds = Array.from(
        new Set(
          dispatches
            .map((d) => d.triggeredBy)
            .filter((id): id is string => !!id && id !== "system"),
        ),
      );
      const userMap = new Map<string, string>();
      if (userIds.length > 0) {
        try {
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
        } catch (lookupErr: unknown) {
          const msg = lookupErr instanceof Error ? lookupErr.message : String(lookupErr);
          console.warn(
            "[manual-reserve-alerts] triggeredBy user lookup failed; serving ids only:",
            msg,
          );
        }
      }
      const enriched = dispatches.map((d) => ({
        ...d,
        triggeredByName: d.triggeredBy ? (userMap.get(d.triggeredBy) ?? null) : null,
      }));
      res.json({ dispatches: enriched });
    } catch (err: any) {
      console.error("[manual-reserve-alerts] failed to read dispatch history:", err?.message || err);
      res.status(500).json({ error: "Failed to load manual reserve alert history" });
    }
  });

  app.get("/api/health/manual-reserve-alerts.csv", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { getRecentManualReserveAlertDispatches } = await import("../../services/manualReserveAlerts");
      const limitParam = parseInt(String(req.query?.limit ?? ""), 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 500;

      const sinceRaw = parseInt(String(req.query?.since ?? ""), 10);
      const sinceTimestamp = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : undefined;

      const splitCsv = (raw: unknown): string[] | undefined => {
        if (raw === undefined || raw === null || raw === "") return undefined;
        const arr = String(raw)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        return arr.length > 0 ? arr : undefined;
      };
      const eventTypes = splitCsv(req.query?.eventType);
      const severities = splitCsv(req.query?.severity);
      const metric = req.query?.metric ? String(req.query.metric).trim() || undefined : undefined;

      const dispatches = await getRecentManualReserveAlertDispatches({
        limit,
        sinceTimestamp,
        eventTypes,
        severities,
        metric,
      });

      const escape = (val: unknown): string => {
        if (val === null || val === undefined) return "";
        const s = String(val);
        if (/[",\r\n]/.test(s)) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };
      const headers = [
        "timestamp",
        "eventType",
        "metric",
        "severity",
        "value",
        "threshold",
        "status",
        "detail",
        "mutedBy",
        "muteReason",
      ];
      const filename = `manual-reserve-alerts-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.write(headers.join(",") + "\r\n");
      for (const d of dispatches) {
        const row = [
          new Date(d.timestamp).toISOString(),
          d.eventType ?? "alert",
          d.metric,
          d.severity,
          d.value,
          d.threshold,
          d.status,
          d.detail ?? "",
          d.mutedBy ?? "",
          d.muteReason ?? "",
        ];
        res.write(row.map(escape).join(",") + "\r\n");
      }
      res.end();
    } catch (err: any) {
      console.error("[manual-reserve-alerts] failed to export CSV:", err?.message || err);
      res.status(500).json({ error: "Failed to export manual reserve alert history" });
    }
  });

  app.post(
    "/api/health/manual-reserve-alerts/resend",
    isAuthenticated,
    requireTeamLead,
    handleManualReserveAlertsResend,
  );
}