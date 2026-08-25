// Task #2686 — Live Data tab API routes.
//
// Thin read API: returns the stored snapshot for a client (latest values
// + trend + per-metric status/reason + last-refreshed time). An admin can
// optionally trigger an immediate on-demand pull for one client.
//
// Auth: gated by canAccessRIS (the same gate as the RIS routes — anyone
// with the reporting_expert function or higher authority can view).

import type { Express } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { canAccessRIS, canManageRIS } from "../auth/permissions";
import { storage } from "../storage";
import {
  getLatestLiveDataSnapshot,
  getLiveDataTrend,
} from "../storage/liveDataStorage";
import { runWithWorkerDb } from "../db";
import { runLiveDataPull, liveDataCurrentPeriod } from "../services/liveData/liveDataPull";
import { isBigQueryConfigured } from "../services/ris/bigQueryClient";
import type { User } from "@shared/schema";

export function registerLiveDataRoutes(app: Express): void {
  async function loadUser(req: any, res: any): Promise<User | null> {
    const userId = req.user?.claims?.sub;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    const user = await storage.getUser(userId);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    return user;
  }

  // ─── GET /api/live-data/clients/:clientId ──────────────────────────
  // Returns the latest snapshot + 6-period trend for the client.
  // Optional ?period=YYYY-MM overrides the default (current month).
  app.get(
    "/api/live-data/clients/:clientId",
    isAuthenticated,
    async (req: any, res) => {
      const user = await loadUser(req, res);
      if (!user) return;
      if (!(await canAccessRIS(user))) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const { clientId } = req.params;
      const periodRaw = req.query.period;
      const period =
        typeof periodRaw === "string" && /^\d{4}-\d{2}$/.test(periodRaw)
          ? periodRaw
          : liveDataCurrentPeriod();

      try {
        const client = await storage.getClient(clientId);
        if (!client) {
          return res.status(404).json({ error: "Client not found" });
        }

        const [snapshot, trend, userCanManage] = await Promise.all([
          getLatestLiveDataSnapshot(clientId, period),
          getLiveDataTrend(clientId, 6),
          canManageRIS(user),
        ]);

        res.json({
          clientId,
          period,
          bigQueryConfigured: isBigQueryConfigured(),
          bigQueryKeyConfigured: !!client.bigQueryClientKey,
          canManage: userCanManage,
          snapshot: snapshot
            ? {
                id: snapshot.id,
                period: snapshot.period,
                fetchedAt: snapshot.fetchedAt,
                overallStatus: snapshot.overallStatus,
                metrics: snapshot.metrics,
              }
            : null,
          trend: trend.map((s) => ({
            period: s.period,
            fetchedAt: s.fetchedAt,
            overallStatus: s.overallStatus,
            metrics: s.metrics,
          })),
        });
      } catch (err: any) {
        console.error("[liveData] GET snapshot failed:", err);
        res.status(500).json({ error: "Failed to load Live Data snapshot" });
      }
    },
  );

  // ─── POST /api/live-data/clients/:clientId/refresh ─────────────────
  // Admin-triggered on-demand pull for one client.
  app.post(
    "/api/live-data/clients/:clientId/refresh",
    isAuthenticated,
    async (req: any, res) => {
      const user = await loadUser(req, res);
      if (!user) return;
      if (!(await canManageRIS(user))) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const { clientId } = req.params;

      try {
        const client = await storage.getClient(clientId);
        if (!client) {
          return res.status(404).json({ error: "Client not found" });
        }

        const summary = await runWithWorkerDb(() =>
          runLiveDataPull({ clientId }),
        );

        res.json({ ok: true, summary });
      } catch (err: any) {
        console.error("[liveData] on-demand refresh failed:", err);
        res.status(500).json({ error: "Failed to refresh Live Data" });
      }
    },
  );
}
