/**
 * Task #2784 — Google Ads Hygiene Audit routes.
 *
 * Admin-only (CEO-tier) surface: list connected accounts, trigger a new
 * audit run, fetch a specific past report, and list recent runs for a
 * customer. Read-only against Google Ads — the trigger endpoint only
 * *reads* live account data via `runGoogleAdsAudit`, it never writes
 * back to Google Ads.
 */

import type { Express } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireCeo, requireAccountManager } from "./middleware";
import { listGoogleAdsCustomers } from "../storage/googleAdsStorage";
import {
  getGoogleAdsAuditRun,
  listGoogleAdsAuditCheckResults,
  listGoogleAdsAuditRuns,
} from "../storage/googleAdsAuditStorage";
import {
  buildAuditReportFromRun,
  runGoogleAdsAudit,
} from "../services/googleAdsAuditEngine";
import { respondGoogleAdsDisconnected } from "./googleAdsDisconnected";

export function registerGoogleAdsAuditRoutes(app: Express): void {
  app.get(
    "/api/admin/google-ads-audit/accounts",
    isAuthenticated,
    requireAccountManager, // read-only: open to all staff (Task #4977)
    async (_req, res) => {
      try {
        const customers = await listGoogleAdsCustomers();
        res.json({
          accounts: customers
            .filter((c) => !c.isManager)
            .map((c) => ({
              customerId: c.customerId,
              descriptiveName: c.descriptiveName,
              status: c.status,
              nobullClientId: c.nobullClientId,
            })),
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/api/admin/google-ads-audit/:customerId/run",
    isAuthenticated,
    requireCeo,
    async (req: any, res) => {
      try {
        const { customerId } = req.params;
        const lookbackDays = Math.max(
          7,
          Math.min(Number(req.body?.lookbackDays) || 30, 90),
        );
        const report = await runGoogleAdsAudit(customerId, {
          lookbackDays,
          triggeredBy: req.user?.claims?.sub ?? null,
        });
        res.json({ report });
      } catch (error: any) {
        // Task #2794 — auth-dead credential → structured 503 the page can
        // render as a reconnect banner (presentation only, no state writes).
        if (respondGoogleAdsDisconnected(res, error)) return;
        console.error("[GoogleAdsAudit] run error:", error?.message || error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.get(
    "/api/admin/google-ads-audit/:customerId/runs",
    isAuthenticated,
    requireAccountManager, // read-only: open to all staff (Task #4977)
    async (req, res) => {
      try {
        const { customerId } = req.params;
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
        const runs = await listGoogleAdsAuditRuns(customerId, limit);
        res.json({ runs });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.get(
    "/api/admin/google-ads-audit/runs/:runId",
    isAuthenticated,
    requireAccountManager, // read-only: open to all staff (Task #4977)
    async (req, res) => {
      try {
        const { runId } = req.params;
        const run = await getGoogleAdsAuditRun(runId);
        if (!run) return res.status(404).json({ error: "Audit run not found" });
        const checkRows = await listGoogleAdsAuditCheckResults(runId);
        const report = await buildAuditReportFromRun(run, checkRows);
        res.json({ report, status: run.status, error: run.error ?? null });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  );
}
