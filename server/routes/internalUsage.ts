import type { Express } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireTeamLead } from "./middleware";
import {
  computeInternalUsageReport,
  computeWinTrackingReport,
  type InternalUsageWindow,
} from "../storage/internalUsageStorage";

/**
 * Task #3721 — internal tool-usage tracker.
 *
 * Leadership-only (team_lead and up) read endpoint powering the
 * /admin/internal-usage page: per-tool usage totals overall, per team
 * member, and a per-member client × tool matrix over each member's
 * assigned clients (zero-activity clients included so gaps are visible).
 *
 * Task #4872 — `days` accepts the literal "all" for the entire recorded
 * history (aggregation is query-time over never-pruned tables, so
 * pre-launch rows are countable); numeric values keep the strict 1–365
 * clamp with the historical default of 30.
 */
export function registerInternalUsageRoutes(app: Express) {
  app.get("/api/internal-usage", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const rawParam = String(req.query.days ?? "30");
      let days: InternalUsageWindow;
      if (rawParam === "all") {
        days = "all";
      } else {
        const rawDays = Number.parseInt(rawParam, 10);
        days = Number.isFinite(rawDays) ? Math.min(365, Math.max(1, rawDays)) : 30;
      }
      const report = await computeInternalUsageReport(days);
      res.json(report);
    } catch (error) {
      console.error("Error computing internal usage report:", error);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Task #4874 — weekly win cadence tracker. Same leadership gate as the
  // usage report above; fixed 8-week UTC-calendar-week window computed
  // server-side (no params), deliberately independent of the `days` range so
  // the cadence target stays comparable week over week.
  app.get("/api/internal-usage/wins-weekly", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const report = await computeWinTrackingReport();
      res.json(report);
    } catch (error) {
      console.error("Error computing win tracking report:", error);
      res.status(500).json({ error: "Server error" });
    }
  });
}
