/**
 * Task #2785 — Google Ads Hygiene: Keyword Intel, LSA Dashboard, Budget
 * Pacing & Alerts routes.
 *
 * All endpoints require the CEO role (same as the foundation audit routes
 * in `googleAdsAudit.ts`). Mounted under `/api/admin/google-ads-hygiene/`.
 */

import type { Express } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireCeo, requireAccountManager } from "./middleware";
import {
  computeAndSaveAlerts,
  computeBudgetPacing,
  fetchLsaDashboard,
  runKeywordIntel,
} from "../services/googleAdsHygieneService";
import {
  clearClickUpLinkageForAlert,
  getGoogleAdsHygieneAlert,
  getLatestKeywordIntelRunAt,
  listGoogleAdsHygieneAlerts,
  listLatestKeywordIntelResults,
  resolveGoogleAdsHygieneAlert,
  updateGoogleAdsHygieneAlert,
} from "../storage/googleAdsHygieneStorage";
import type { GoogleAdsHygieneAlert } from "@shared/schema";
import {
  createClickUpTask,
  getClickUpTask,
  isClickUpConfigured,
} from "../services/clickUpClient";
import { respondGoogleAdsDisconnected } from "./googleAdsDisconnected";

export function registerGoogleAdsHygieneRoutes(app: Express): void {
  // ─── Budget Pacing ───────────────────────────────────────────────────────

  app.get(
    "/api/admin/google-ads-hygiene/:customerId/pacing",
    isAuthenticated,
    requireAccountManager, // read-only: open to all staff (Task #4977)
    async (req, res) => {
      try {
        const { customerId } = req.params;
        const summary = await computeBudgetPacing(customerId);
        res.json({ pacing: summary });
      } catch (error: any) {
        // Task #2794 — auth-dead credential → structured 503 the page can
        // render as a reconnect banner (presentation only, no state writes).
        if (respondGoogleAdsDisconnected(res, error)) return;
        console.error("[AdsHygiene] pacing error:", error?.message || error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // ─── LSA Dashboard ───────────────────────────────────────────────────────

  app.get(
    "/api/admin/google-ads-hygiene/:customerId/lsa",
    isAuthenticated,
    requireAccountManager, // read-only: open to all staff (Task #4977)
    async (req, res) => {
      try {
        const { customerId } = req.params;
        const dashboard = await fetchLsaDashboard(customerId);
        res.json({ lsa: dashboard });
      } catch (error: any) {
        if (respondGoogleAdsDisconnected(res, error)) return;
        console.error("[AdsHygiene] LSA error:", error?.message || error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // ─── Keyword Intel ───────────────────────────────────────────────────────

  app.post(
    "/api/admin/google-ads-hygiene/:customerId/keyword-intel/run",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const { customerId } = req.params;
        const lookbackDays = Math.max(
          7,
          Math.min(Number(req.body?.lookbackDays) || 30, 90),
        );
        const result = await runKeywordIntel(customerId, lookbackDays);
        res.json({ result });
      } catch (error: any) {
        if (respondGoogleAdsDisconnected(res, error)) return;
        console.error("[AdsHygiene] keyword-intel error:", error?.message || error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.get(
    "/api/admin/google-ads-hygiene/:customerId/keyword-intel/results",
    isAuthenticated,
    requireAccountManager, // read-only: open to all staff (Task #4977)
    async (req, res) => {
      try {
        const { customerId } = req.params;
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 1000));
        const [results, runAt] = await Promise.all([
          listLatestKeywordIntelResults(customerId, limit),
          getLatestKeywordIntelRunAt(customerId),
        ]);
        res.json({ results, runAt: runAt?.toISOString() ?? null });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  // ─── Alerts ──────────────────────────────────────────────────────────────

  app.get(
    "/api/admin/google-ads-hygiene/:customerId/alerts",
    isAuthenticated,
    requireAccountManager, // read-only: open to all staff (Task #4977)
    async (req, res) => {
      try {
        const { customerId } = req.params;
        const includeResolved = req.query.includeResolved === "true";
        const alerts = await listGoogleAdsHygieneAlerts(customerId, { includeResolved });
        res.json({
          alerts,
          clickupConfigured: isClickUpConfigured(),
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/api/admin/google-ads-hygiene/:customerId/alerts/compute",
    isAuthenticated,
    requireCeo,
    async (req, res) => {
      try {
        const { customerId } = req.params;
        const alerts = await computeAndSaveAlerts(customerId);
        res.json({
          alerts,
          count: alerts.length,
          clickupConfigured: isClickUpConfigured(),
        });
      } catch (error: any) {
        if (respondGoogleAdsDisconnected(res, error)) return;
        console.error("[AdsHygiene] alerts/compute error:", error?.message || error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/api/admin/google-ads-hygiene/alerts/:alertId/resolve",
    isAuthenticated,
    requireCeo,
    async (req, res) => {
      try {
        const { alertId } = req.params;
        const updated = await resolveGoogleAdsHygieneAlert(alertId);
        if (!updated) return res.status(404).json({ error: "Alert not found" });
        res.json({ alert: updated });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  // ─── ClickUp task creation for an alert ─────────────────────────────────

  app.post(
    "/api/admin/google-ads-hygiene/alerts/:alertId/clickup",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const { alertId } = req.params;
        const alert = await getGoogleAdsHygieneAlert(alertId);
        if (!alert) return res.status(404).json({ error: "Alert not found" });
        if (alert.clickupTaskId) {
          // Already created — refresh its status
          const statusResult = await getClickUpTask(alert.clickupTaskId);
          if (!statusResult.configured) {
            return res.json({ alert, clickupConfigured: false, reason: statusResult.reason });
          }
          const updated = await updateGoogleAdsHygieneAlert(alertId, {
            clickupTaskStatus: statusResult.task.status,
            clickupTaskUrl: statusResult.task.url ?? undefined,
          });
          return res.json({ alert: updated ?? alert, clickupConfigured: true });
        }

        const description = [
          alert.detail ?? "",
          alert.measuredValue ? `\nMeasured: ${alert.measuredValue}` : "",
          alert.campaignName ? `\nCampaign: ${alert.campaignName}` : "",
          `\nGenerated by NoBull OS Google Ads Hygiene module.`,
        ]
          .join("")
          .trim();

        const createResult = await createClickUpTask({
          name: alert.title,
          description,
        });

        if (!createResult.configured) {
          return res.json({ alert, clickupConfigured: false, reason: createResult.reason });
        }

        const updated = await updateGoogleAdsHygieneAlert(alertId, {
          clickupTaskId: createResult.task.id,
          clickupTaskStatus: createResult.task.status,
          clickupTaskUrl: createResult.task.url ?? undefined,
        });

        res.json({ alert: updated ?? alert, clickupConfigured: true, task: createResult.task });
      } catch (error: any) {
        console.error("[AdsHygiene] clickup error:", error?.message || error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  // ─── ClickUp task status refresh ─────────────────────────────────────────

  app.post(
    "/api/admin/google-ads-hygiene/alerts/:alertId/clickup/refresh",
    isAuthenticated,
    requireCeo,
    async (req, res) => {
      try {
        const { alertId } = req.params;
        const alert = await getGoogleAdsHygieneAlert(alertId);
        if (!alert) return res.status(404).json({ error: "Alert not found" });
        if (!alert.clickupTaskId) {
          return res.status(400).json({ error: "No ClickUp task linked to this alert" });
        }
        const result = await getClickUpTask(alert.clickupTaskId);
        if (!result.configured) {
          return res.json({ alert, clickupConfigured: false, reason: result.reason });
        }

        // If the ClickUp task is now closed/completed, clear the linkage so
        // the UI reverts to showing a "Create task" button for the alert.
        const closedStatuses = new Set(["complete", "closed", "done"]);
        const isClosed = closedStatuses.has((result.task.status ?? "").toLowerCase());
        let updated: GoogleAdsHygieneAlert | undefined;
        if (isClosed) {
          updated = await clearClickUpLinkageForAlert(alertId);
        } else {
          updated = await updateGoogleAdsHygieneAlert(alertId, {
            clickupTaskStatus: result.task.status,
            clickupTaskUrl: result.task.url ?? undefined,
          });
        }
        res.json({ alert: updated ?? alert, clickupConfigured: true, task: result.task, cleared: isClosed });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  );
}
