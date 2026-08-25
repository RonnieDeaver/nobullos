// @db-pool-intent: api
/**
 * PR9 split (Task f1425127) — extracted VERBATIM from server/routes.ts
 * (formerly inline at lines 1046–1418 at split time).
 *
 * Kill-switch + pool-epic switch toggles, metrics flush/overview/rollups, SEMrush ghost cleanup + import ghosts, freshness, pool-state, sampler runtime state, and the health incidents list/ack/snooze/resolve routes.
 *
 * Mount-order contract: registerHealthOpsAndIncidentRoutes(app) is invoked from
 * registerRoutes() in server/routes.ts at the exact position the inline
 * registrations previously occupied, preserving global registration order.
 * Do not reorder registrations here and do not mount this module elsewhere.
 */
import type { Express } from "express";
import { db } from "../../db";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { flushToDb } from "../../services/healthMetrics";
import { requireTeamLead } from "../middleware";
import { storage } from "../../storage";
export function registerHealthOpsAndIncidentRoutes(app: Express): void {
  // Task #836 Phase 2 (post-review): runtime kill-switch toggles. The
  // env-var defaults (`PERF.KILL_SWITCH_*`) are still honored as the
  // fallback, but operators can override any switch in real time
  // through this endpoint. Overrides persist to `system_settings` so
  // they survive process restarts; the active value is reflected
  // immediately on the dashboard via `/api/health/db-attribution`.
  app.post("/api/health/kill-switches", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { setKillSwitch, getKillSwitchSnapshot, KILL_SWITCH_NAMES } = await import("../../services/killSwitches");
      const { name, value } = req.body || {};
      if (!KILL_SWITCH_NAMES.includes(name)) {
        return res.status(400).json({ error: `Unknown kill switch: ${name}` });
      }
      if (typeof value !== "boolean") {
        return res.status(400).json({ error: "value must be boolean" });
      }
      const actor = req.user?.username || req.user?.id || "unknown";
      await setKillSwitch(name, value, actor);
      console.log(`[KillSwitches] ${actor} set ${name}=${value}`);
      const snapshot = await getKillSwitchSnapshot();
      res.json({ success: true, killSwitches: snapshot });
    } catch (err: any) {
      console.error("[KillSwitches] toggle failed:", err?.message ?? err);
      res.status(500).json({ error: "Failed to toggle kill switch" });
    }
  });

  // Task #1727 — Pool epic Phase 0 safety switches. Read + write the
  // seven settings-table switches added by the DB Pool Stability epic.
  // GET returns the snapshot used by the admin dashboard; POST flips a
  // single switch (in-memory update is immediate; settings-table write
  // is awaited so the rollback is durable across restarts).
  app.get("/api/health/pool-epic-switches", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { getPoolEpicSwitchSnapshot } = await import("../../services/poolEpicKillSwitches");
      res.json({ success: true, poolEpicSwitches: await getPoolEpicSwitchSnapshot() });
    } catch (err: any) {
      console.error("[PoolEpicKillSwitches] snapshot failed:", err?.message ?? err);
      res.status(500).json({ error: "Failed to read pool epic switches" });
    }
  });

  app.post("/api/health/pool-epic-switches", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const {
        setPoolEpicSwitch,
        getPoolEpicSwitchSnapshot,
        POOL_EPIC_SWITCH_NAMES,
      } = await import("../../services/poolEpicKillSwitches");
      const { name, value } = req.body || {};
      if (!POOL_EPIC_SWITCH_NAMES.includes(name)) {
        return res.status(400).json({ error: `Unknown pool epic switch: ${name}` });
      }
      if (typeof value !== "boolean") {
        return res.status(400).json({ error: "value must be boolean" });
      }
      const actor = req.user?.username || req.user?.id || "unknown";
      await setPoolEpicSwitch(name, value, actor);
      console.log(`[PoolEpicKillSwitches] ${actor} set ${name}=${value}`);
      const snapshot = await getPoolEpicSwitchSnapshot();
      res.json({ success: true, poolEpicSwitches: snapshot });
    } catch (err: any) {
      console.error("[PoolEpicKillSwitches] toggle failed:", err?.message ?? err);
      res.status(500).json({ error: "Failed to toggle pool epic switch" });
    }
  });

  app.post("/api/health/flush", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const flushedCount = await flushToDb({ throwOnError: true });
      res.json({ success: true, flushedCount, message: flushedCount > 0 ? `Flushed ${flushedCount} samples to database` : "No pending samples to flush" });
    } catch (err: any) {
      console.error("[HealthMetrics] Manual flush failed:", err.message);
      res.status(500).json({ error: "Failed to flush health metrics" });
    }
  });

  // ─── Task #861 endpoints ─────────────────────────────────────────────

  // Phase 6/7 — overview / SLO / regression
  app.get("/api/health/overview", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { computeOverview } = await import("../../services/healthOverview");
      const result = await computeOverview();
      res.json(result);
    } catch (err: any) {
      console.error("[HealthOverview] failed:", err?.message ?? err);
      res.status(500).json({ error: "Failed to compute overview" });
    }
  });

  app.get("/api/health/rollups", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const days = Math.min(Math.max(parseInt(String(req.query.days ?? "30"), 10) || 30, 1), 90);
      const { getDailyRollupSeries } = await import("../../services/healthOverview");
      res.json({ days, series: await getDailyRollupSeries(days) });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch rollups" });
    }
  });

  // Task #758 — surface the SEMrush ghost-cleanup daily counter so
  // operators can see drift trends in the Health dashboard. Reads the
  // shared `health_daily_rollups` table filtered by metric, plus the
  // last-run summary persisted in `system_settings`.
  app.get(
    "/api/health/semrush-ghost-cleanup",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const days = Math.min(
          Math.max(parseInt(String(req.query.days ?? "30"), 10) || 30, 1),
          90,
        );
        const sinceDate = ((): string => {
          const d = new Date(Date.now() - days * 24 * 60 * 60_000);
          return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        })();
        const { getDailyRollupsSince } = await import(
          "../../storage/healthMetricsStorage"
        );
        const {
          HEALTH_METRIC,
          readLastSemrushGhostCleanupRun,
          isSemrushGhostCleanupEnabled,
        } = await import("../../services/semrushGhostCleanup");
        const [rows, lastRunRead, enabled] = await Promise.all([
          getDailyRollupsSince(sinceDate, HEALTH_METRIC),
          readLastSemrushGhostCleanupRun(),
          isSemrushGhostCleanupEnabled(),
        ]);
        const series = rows.map((r) => ({
          date: r.date,
          scanned: r.sampleCount,
          ghosts: r.alertCount,
          deleted: r.incidentCount,
        }));
        // `lastRun` is the parsed summary or null (contract preserved).
        // `lastRunStatus` distinguishes "never_run" (normal on a fresh
        // deploy) from "unreadable" (a persisted-value parse failure →
        // real persistence bug), with `lastRunError` carrying the
        // plain-English reason when unreadable.
        res.json({
          days,
          enabled,
          lastRun: lastRunRead.lastRun,
          lastRunStatus: lastRunRead.status,
          ...(lastRunRead.error ? { lastRunError: lastRunRead.error } : {}),
          series,
        });
      } catch (err: any) {
        console.error(
          "[SemrushGhostCleanup] rollups endpoint failed:",
          err?.message ?? err,
        );
        res
          .status(500)
          .json({ error: "Failed to fetch semrush ghost cleanup rollups" });
      }
    },
  );

  // Task #1221 — toggle the daily SEMrush ghost-cleanup auto-run.
  // The same setting key is read by `isSemrushGhostCleanupEnabled()` in
  // `server/services/semrushGhostCleanup.ts`.
  app.put(
    "/api/health/semrush-ghost-cleanup",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        if (typeof req.body?.enabled !== "boolean") {
          return res.status(400).json({ error: "enabled (boolean) is required" });
        }
        const { setSystemSetting } = await import("../../storage/settingsStorage");
        const { SETTING_ENABLED, isSemrushGhostCleanupEnabled } = await import(
          "../../services/semrushGhostCleanup"
        );
        const by = req.user?.claims?.sub ?? "unknown";
        await setSystemSetting(
          SETTING_ENABLED,
          req.body.enabled ? "true" : "false",
          by,
        );
        const enabled = await isSemrushGhostCleanupEnabled();
        res.json({ ok: true, enabled });
      } catch (err: any) {
        console.error(
          "[SemrushGhostCleanup] toggle endpoint failed:",
          err?.message ?? err,
        );
        res
          .status(500)
          .json({ error: "Failed to update semrush ghost cleanup toggle" });
      }
    },
  );

  // Task #1222 — surface the daily import-ghosts snapshot (auto-discovered
  // client_contacts + import_entity_suggestions queue counts) so operators
  // can see drift without running `scripts/cleanup-import-ghosts.ts`.
  app.get(
    "/api/health/import-ghosts-snapshot",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const days = Math.min(
          Math.max(parseInt(String(req.query.days ?? "30"), 10) || 30, 1),
          90,
        );
        const sinceDate = ((): string => {
          const d = new Date(Date.now() - days * 24 * 60 * 60_000);
          return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        })();
        const { getDailyRollupsSince } = await import(
          "../../storage/healthMetricsStorage"
        );
        const {
          HEALTH_METRIC,
          readLastImportGhostsSnapshot,
          isImportGhostsSnapshotEnabled,
        } = await import("../../services/importGhostsSnapshot");
        const [rows, lastRunRead, enabled] = await Promise.all([
          getDailyRollupsSince(sinceDate, HEALTH_METRIC),
          readLastImportGhostsSnapshot(),
          isImportGhostsSnapshotEnabled(),
        ]);
        const series = rows.map((r) => {
          const meta = (r.metadata ?? {}) as Record<string, unknown>;
          return {
            date: r.date,
            scannedContacts: r.sampleCount,
            ghostContacts: r.alertCount,
            unusedContacts: r.incidentCount,
            pendingSuggestionsCount:
              typeof meta.pendingSuggestionsCount === "number"
                ? (meta.pendingSuggestionsCount as number)
                : 0,
            suggestionGroupsCount:
              typeof meta.suggestionGroupsCount === "number"
                ? (meta.suggestionGroupsCount as number)
                : 0,
          };
        });
        // `lastRun` is the parsed summary or null (contract preserved).
        // `lastRunStatus` distinguishes "never_run" (normal on a fresh
        // deploy) from "unreadable" (a persisted-value parse failure →
        // real persistence bug), with `lastRunError` carrying the
        // plain-English reason when unreadable.
        res.json({
          days,
          enabled,
          lastRun: lastRunRead.lastRun,
          lastRunStatus: lastRunRead.status,
          ...(lastRunRead.error ? { lastRunError: lastRunRead.error } : {}),
          series,
        });
      } catch (err: any) {
        console.error(
          "[ImportGhostsSnapshot] rollups endpoint failed:",
          err?.message ?? err,
        );
        res
          .status(500)
          .json({ error: "Failed to fetch import ghosts snapshot" });
      }
    },
  );

  // Phase 2 — telemetry freshness
  app.get("/api/health/freshness", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { getFreshness } = await import("../../services/healthRollups");
      res.json({ freshness: await getFreshness() });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch freshness" });
    }
  });

  // Phase 4 — pool state samples
  app.get("/api/health/pool-state", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const sinceRaw = parseInt(String(req.query.since ?? ""), 10);
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0
        ? sinceRaw
        : Date.now() - 6 * 60 * 60 * 1000;
      const poolName = typeof req.query.pool === "string" ? String(req.query.pool) : undefined;
      const healthStore = await import("../../storage/healthMetricsStorage");
      const [series, latest] = await Promise.all([
        healthStore.getPoolStateSamplesSince(since, poolName),
        healthStore.getLatestPoolStateSamples(),
      ]);
      res.json({ since, latest, series });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch pool state" });
    }
  });

  // Task #915 (913B) — supervised sampler runtime state.
  app.get("/api/health/samplers", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      const { getSupervisedSamplerStates } = await import("../../services/supervisedSampler");
      const states = getSupervisedSamplerStates();
      res.json({
        now: Date.now(),
        samplers: states,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch sampler runtime state" });
    }
  });

  // Phase 3 — incidents (list / ack / snooze / resolve)
  app.get("/api/health/incidents", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const incidents = await import("../../services/healthIncidents");
      const sinceRaw = parseInt(String(req.query.since ?? ""), 10);
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0
        ? sinceRaw
        : Date.now() - 7 * 24 * 60 * 60 * 1000;
      const open = await incidents.listOpenIncidents();
      const recent = await incidents.listRecentIncidents(since);
      res.json({ open, recent, since });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch incidents" });
    }
  });

  app.post("/api/health/incidents/:id/ack", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
      const incidents = await import("../../services/healthIncidents");
      const by = req.user?.claims?.sub ?? "unknown";
      const updated = await incidents.ackIncident(id, by);
      if (!updated) return res.status(404).json({ error: "incident not found" });
      res.json({ incident: updated });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to ack incident" });
    }
  });

  app.post("/api/health/incidents/:id/snooze", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
      const minutes = Math.min(Math.max(parseInt(String(req.body?.minutes ?? "60"), 10) || 60, 5), 24 * 60);
      const until = Date.now() + minutes * 60_000;
      const incidents = await import("../../services/healthIncidents");
      const by = req.user?.claims?.sub ?? "unknown";
      const updated = await incidents.snoozeIncident(id, until, by);
      if (!updated) return res.status(404).json({ error: "incident not found" });
      res.json({ incident: updated, snoozedUntil: until });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to snooze incident" });
    }
  });

  app.post("/api/health/incidents/:id/resolve", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
      const incidents = await import("../../services/healthIncidents");
      const by = req.user?.claims?.sub ?? "unknown";
      const updated = await incidents.resolveIncident(id, by);
      if (!updated) return res.status(404).json({ error: "incident not found" });
      res.json({ incident: updated });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to resolve incident" });
    }
  });
}