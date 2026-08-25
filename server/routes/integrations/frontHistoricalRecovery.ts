/**
 * Integrations routes — historical recovery (execute, jobs, coverage, windows, settings + audit histories, retry alerts).
 * Extracted verbatim from server/routes/integrations.ts (Task #4152 / F6
 * split; original lines 3206–3702, 3723–4436); sections: historical recovery (execute, jobs, coverage, windows, settings + audit histories, retry alerts).
 * Mounted by registerIntegrationRoutes in ../integrations.ts — route order is
 * preserved by the aggregator's call sequence; the only in-slice edit is
 * dynamic-import specifier depth (./ -> ../, ../ -> ../../).
 */
import type { Express } from "express";
import { storage } from "../../storage";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireAccountManager, requireTeamLead } from "../middleware";
import { insertActivityLogs } from "../../storage/activityStorage";
import { buildRecoverySettingHistory } from "./helpers";
import type { AuthenticatedRequest } from "../requestContext";

export function registerIntegrationsFrontHistoricalRecoveryRoutes(app: Express) {
  app.get("/api/integrations/front/historical-recovery/coverage", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { generateCoverageReport } = await import("../../services/frontHistoricalRecovery");
      const report = await generateCoverageReport();
      res.json(report);
    } catch (error: any) {
      console.error("[Integrations] Coverage report error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/front/historical-recovery/execute", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest, res) => {
    try {
      const { runHistoricalRecovery } = await import("../../services/frontHistoricalRecovery");
      const { dryRun, customWindows } = (req.body || {}) as { dryRun?: unknown; customWindows?: unknown };
      let validatedWindows: Array<{ label: string; afterTimestamp: number; beforeTimestamp: number }> | undefined;
      if (Array.isArray(customWindows)) {
        validatedWindows = [];
        for (const w of customWindows) {
          if (typeof w.label !== "string" || typeof w.afterTimestamp !== "number" || typeof w.beforeTimestamp !== "number") {
            return res.status(400).json({ error: "Each custom window must have label (string), afterTimestamp (number), beforeTimestamp (number)" });
          }
          if (w.afterTimestamp >= w.beforeTimestamp) {
            return res.status(400).json({ error: `Window "${w.label}": afterTimestamp must be less than beforeTimestamp` });
          }
          validatedWindows.push({ label: w.label, afterTimestamp: w.afterTimestamp, beforeTimestamp: w.beforeTimestamp });
        }
      }
      const jobId = await runHistoricalRecovery({
        dryRun: dryRun === true,
        customWindows: validatedWindows,
      });
      return res.status(202).json({ status: "running", jobId, dryRun: dryRun === true });
    } catch (error: any) {
      // Both legacy "already running" and the new RECOVERY_CAP_REACHED
      // typed error represent expected concurrency contention — map to 409
      // so operators see a calm "try again" instead of an alarming 500.
      if (error?.code === "RECOVERY_CAP_REACHED" || error?.message?.includes("already running")) {
        return res.status(409).json({ error: error.message });
      }
      console.error("[Integrations] Historical recovery error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/front/historical-recovery/status/:jobId", isAuthenticated, requireAccountManager, async (req: any, res) => {
    const { getRecoveryJob, summarizeRecoveryJob } = await import("../../services/frontHistoricalRecovery");
    const job = await getRecoveryJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Recovery job not found" });
    res.set("Cache-Control", "no-store");
    return res.json(await summarizeRecoveryJob(job));
  });

  app.get("/api/integrations/front/historical-recovery/jobs", isAuthenticated, requireAccountManager, async (req: any, res) => {
    const { listRecoveryJobs, summarizeRecoveryJob } = await import("../../services/frontHistoricalRecovery");
    const jobs = await listRecoveryJobs();
    const enriched = await Promise.all(jobs.map((j) => summarizeRecoveryJob(j)));
    res.json({ jobs: enriched });
  });

  // Task #989: manual Resume / Run again entry point. `mode=resume` keeps
  // saved per-window cursors so the new run picks up from the last page;
  // `mode=run_again` clears them so the windows restart from page 1.
  app.post("/api/integrations/front/historical-recovery/:jobId/resume", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<{ jobId: string }, { mode?: unknown; dryRun?: unknown }>, res) => {
    try {
      const mode = req.body?.mode === "run_again" ? "run_again" : "resume";
      const { resumeRecoveryJob } = await import("../../services/frontHistoricalRecovery");
      const result = await resumeRecoveryJob(req.params.jobId, mode, {
        dryRun: req.body?.dryRun === true ? true : undefined,
        continuationType: "manual",
      });
      try {
        await insertActivityLogs([{
          userId: req.user?.claims?.sub ?? null,
          actionType: "front_recovery_manual_resume",
          route: "/api/integrations/front/historical-recovery/:jobId/resume",
          actionDetail: `${mode === "resume" ? "Resumed" : "Re-ran"} Front recovery job ${req.params.jobId} → ${result.jobId} (${result.windows} window(s))`,
          metadata: {
            mode,
            sourceJobId: req.params.jobId,
            newJobId: result.jobId,
            windows: result.windows,
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[Integrations] Recovery resume audit log failed:", logErr?.message);
      }
      return res.json({ success: true, ...result });
    } catch (error: any) {
      const message = error instanceof Error ? error.message : "Unknown error";
      // RECOVERY_CAP_REACHED (new typed error from runHistoricalRecovery)
      // and the legacy "already running"/"still active" strings all map to
      // 409 so the operator sees calm back-pressure rather than a 500.
      const isCapReached = error?.code === "RECOVERY_CAP_REACHED" || /cap reached/i.test(message);
      const status = /not found/i.test(message)
        ? 404
        : isCapReached || /already running|still active/i.test(message)
        ? 409
        : /not resumable|no reconstructable/i.test(message)
        ? 400
        : 500;
      return res.status(status).json({ error: message });
    }
  });

  app.delete("/api/integrations/front/historical-recovery/jobs/:jobId", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<{ jobId: string }>, res) => {
    try {
      const { deleteRecoveryJob } = await import("../../services/frontHistoricalRecovery");
      const snapshot = await deleteRecoveryJob(req.params.jobId);
      try {
        await insertActivityLogs([{
          userId: req.user?.claims?.sub ?? null,
          actionType: "front_recovery_job_deleted",
          route: "/api/integrations/front/historical-recovery/jobs/:jobId",
          actionDetail: snapshot
            ? `Deleted Front recovery job ${req.params.jobId}`
            : `Attempted to delete Front recovery job ${req.params.jobId} (no matching job found)`,
          metadata: { jobId: req.params.jobId, count: snapshot ? 1 : 0, jobStatus: snapshot?.status, startedAt: snapshot?.startedAt },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[Integrations] Recovery delete audit log failed:", logErr?.message);
      }
      return res.json({ success: true, jobId: req.params.jobId });
    } catch (error) {
      const { RecoveryJobRunningError } = await import("../../services/frontHistoricalRecovery");
      if (error instanceof RecoveryJobRunningError) {
        return res.status(409).json({ error: error.message });
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[Integrations] Delete recovery job error:", error);
      return res.status(500).json({ error: message });
    }
  });

  app.delete("/api/integrations/front/historical-recovery/jobs", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest, res) => {
    try {
      const { clearRecoveryJobs } = await import("../../services/frontHistoricalRecovery");
      const result = await clearRecoveryJobs();
      try {
        await insertActivityLogs([{
          userId: req.user?.claims?.sub ?? null,
          actionType: "front_recovery_jobs_cleared",
          route: "/api/integrations/front/historical-recovery/jobs",
          actionDetail: `Cleared ${result.deleted} Front recovery job(s)${result.skipped ? `, ${result.skipped} skipped (still running)` : ""}`,
          metadata: {
            deletedCount: result.deleted,
            skippedCount: result.skipped,
            deletedJobIds: result.deletedIds,
            skippedJobIds: result.skippedIds,
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[Integrations] Recovery clear audit log failed:", logErr?.message);
      }
      return res.json({ success: true, deleted: result.deleted, skipped: result.skipped });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[Integrations] Clear recovery jobs error:", error);
      return res.status(500).json({ error: message });
    }
  });

  // Task #1091 — admin-only "Acknowledge alert / Clear alert history"
  // for a single recovery window. Wipes the persisted
  // `retryPressureAlerts` array and the in-memory dedupe key so a
  // re-evaluation can fire a fresh alert if the threshold is crossed
  // again. Audited via activityLogs (who/when) so the alert trail
  // isn't silently lost.
  app.post(
    "/api/integrations/front/historical-recovery/jobs/:jobId/windows/:windowLabel/clear-alerts",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<{ jobId: string; windowLabel: string }>, res) => {
      const { jobId, windowLabel } = req.params;
      try {
        const { clearWindowRetryPressureAlerts } = await import(
          "../../services/frontHistoricalRecovery"
        );
        const result = await clearWindowRetryPressureAlerts(
          jobId,
          windowLabel,
        );
        try {
          await insertActivityLogs([{
            userId: req.user?.claims?.sub ?? null,
            actionType: "front_recovery_window_alerts_cleared",
            route:
              "/api/integrations/front/historical-recovery/jobs/:jobId/windows/:windowLabel/clear-alerts",
            actionDetail: `Cleared ${result.alertsCleared} retry-pressure alert event(s) on Front recovery job ${jobId} window ${result.windowLabel}`,
            metadata: {
              jobId,
              windowLabel: result.windowLabel,
              alertsCleared: result.alertsCleared,
              singleWindowDedupeCleared: result.singleWindowDedupeCleared,
              consecutivePatternsCleared: result.consecutivePatternsCleared,
            },
            sessionId: null,
            duration: null,
            timestamp: new Date(),
          }]);
        } catch (logErr: any) {
          console.error(
            "[Integrations] Recovery clear-window-alerts audit log failed:",
            logErr?.message,
          );
        }
        return res.json({ success: true, ...result });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        const status = /not found/i.test(message) ? 404 : 500;
        return res.status(status).json({ error: message });
      }
    },
  );

  app.get("/api/integrations/front/historical-recovery/sweep-status", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      const { getRecoveryPruneSweepStatus } = await import("../../services/frontHistoricalRecovery");
      res.set("Cache-Control", "no-store");
      return res.json(getRecoveryPruneSweepStatus());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  app.get("/api/integrations/front/historical-recovery/manual-sweep-history", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { getActivityLogs } = await import("../../storage/activityStorage");
      const limitRaw = Number(req.query?.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 25) : 5;
      const onlyFailedRaw = req.query?.onlyFailed;
      const onlyFailed = onlyFailedRaw === "true" || onlyFailedRaw === "1";
      const result = await getActivityLogs({
        actionType: "front_recovery_manual_prune_sweep",
        limit,
        requireMetadataLastError: onlyFailed,
      });
      const entries = result.data.map((row) => {
        const meta = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
        const prunedFromMeta = typeof meta.prunedCount === "number" ? meta.prunedCount : null;
        const lastErrorFromMeta = typeof meta.lastError === "string" ? meta.lastError : null;
        return {
          id: row.id,
          userId: row.userId,
          userName: row.userName ?? null,
          timestamp: row.timestamp,
          prunedCount: prunedFromMeta,
          lastError: lastErrorFromMeta,
          route: row.route ?? null,
          sessionId: row.sessionId ?? null,
          actionDetail: row.actionDetail ?? null,
          metadata: row.metadata ?? null,
        };
      });
      res.set("Cache-Control", "no-store");
      return res.json({ entries });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  app.post("/api/integrations/front/historical-recovery/run-sweep", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest, res) => {
    try {
      const { triggerRecoveryPruneSweepNow, getRecoveryPruneSweepStatus } = await import("../../services/frontHistoricalRecovery");
      const result = await triggerRecoveryPruneSweepNow();
      if (!result.ran && result.alreadyInFlight) {
        return res.status(409).json({
          error: "A prune sweep is already in flight.",
          alreadyInFlight: true,
          status: getRecoveryPruneSweepStatus(),
        });
      }
      try {
        await insertActivityLogs([{
          userId: req.user?.claims?.sub ?? null,
          actionType: "front_recovery_manual_prune_sweep",
          route: "/api/integrations/front/historical-recovery/run-sweep",
          actionDetail: `Manually triggered Front recovery prune sweep (pruned ${result.prunedCount})`,
          metadata: {
            prunedCount: result.prunedCount,
            lastError: result.lastError,
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[Integrations] Manual prune sweep audit log failed:", logErr?.message);
      }
      return res.json({
        success: true,
        ran: result.ran,
        prunedCount: result.prunedCount,
        lastSweepAt: result.lastSweepAt,
        lastError: result.lastError,
        status: getRecoveryPruneSweepStatus(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[Integrations] Manual prune sweep error:", error);
      return res.status(500).json({ error: message });
    }
  });

  app.get("/api/integrations/front/historical-recovery/max-age", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      const {
        getRecoveryMaxAgeDays,
        DEFAULT_RECOVERY_MAX_AGE_DAYS,
        MIN_RECOVERY_MAX_AGE_DAYS,
        MAX_RECOVERY_MAX_AGE_DAYS,
        RECOVERY_MAX_AGE_DAYS_KEY,
      } = await import("../../services/frontHistoricalRecovery");
      const maxAgeDays = await getRecoveryMaxAgeDays();
      const { storage } = await import("../../storage");
      const setting = await storage.getSystemSetting(RECOVERY_MAX_AGE_DAYS_KEY);
      const { resolveLastEditedUsers, buildLastEdited } = await import("../lastEditedHelper");
      const userMap = await resolveLastEditedUsers([setting?.updatedBy]);
      return res.json({
        maxAgeDays,
        defaultDays: DEFAULT_RECOVERY_MAX_AGE_DAYS,
        minDays: MIN_RECOVERY_MAX_AGE_DAYS,
        maxDays: MAX_RECOVERY_MAX_AGE_DAYS,
        lastEdited: setting
          ? buildLastEdited(setting.updatedAt, setting.updatedBy, userMap)
          : null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  app.put("/api/integrations/front/historical-recovery/max-age", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<Record<string, string>, { maxAgeDays?: unknown }>, res) => {
    const { setRecoveryMaxAgeDays, getRecoveryMaxAgeDays, pruneExpiredRecoveryJobs } = await import("../../services/frontHistoricalRecovery");
    const days = Number(req.body?.maxAgeDays);
    const updatedBy = req.user?.claims?.sub || req.user?.id || "system";
    let oldValue: number | null = null;
    try {
      oldValue = await getRecoveryMaxAgeDays();
    } catch {
      oldValue = null;
    }
    let saved: number;
    try {
      saved = await setRecoveryMaxAgeDays(days, String(updatedBy));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid value";
      return res.status(400).json({ error: message });
    }
    if (oldValue !== saved) {
      try {
        await insertActivityLogs([{
          userId: req.user?.claims?.sub ?? null,
          actionType: "front_recovery_max_age_updated",
          route: "/api/integrations/front/historical-recovery/max-age",
          actionDetail: `Updated Front recovery max age: ${oldValue ?? "—"} → ${saved} day(s)`,
          metadata: {
            oldValues: { maxAgeDays: oldValue },
            newValues: { maxAgeDays: saved },
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[Integrations] Recovery max-age audit log failed:", logErr?.message);
      }
      try {
        const { RECOVERY_MAX_AGE_DAYS_KEY } = await import("../../services/frontHistoricalRecovery");
        await storage.recordAdminSettingChange({
          settingKey: RECOVERY_MAX_AGE_DAYS_KEY,
          scope: null,
          changedBy: req.user?.claims?.sub ?? null,
          oldValues: { maxAgeDays: oldValue },
          newValues: { maxAgeDays: saved },
        });
      } catch (auditErr: any) {
        console.error("[Integrations] Recovery max-age setting audit failed:", auditErr?.message);
      }
    }
    try {
      const pruneResult = await pruneExpiredRecoveryJobs();
      return res.json({ maxAgeDays: saved, pruned: pruneResult.pruned });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[Integrations] Recovery max-age prune error:", error);
      return res.status(500).json({ error: message, maxAgeDays: saved });
    }
  });

  app.get("/api/integrations/front/historical-recovery/prune-interval", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      const {
        getRecoveryPruneIntervalMinutes,
        DEFAULT_RECOVERY_PRUNE_INTERVAL_MINUTES,
        MIN_RECOVERY_PRUNE_INTERVAL_MINUTES,
        MAX_RECOVERY_PRUNE_INTERVAL_MINUTES,
        RECOVERY_PRUNE_INTERVAL_MINUTES_KEY,
      } = await import("../../services/frontHistoricalRecovery");
      const intervalMinutes = await getRecoveryPruneIntervalMinutes();
      const { storage } = await import("../../storage");
      const setting = await storage.getSystemSetting(RECOVERY_PRUNE_INTERVAL_MINUTES_KEY);
      const { resolveLastEditedUsers, buildLastEdited } = await import("../lastEditedHelper");
      const userMap = await resolveLastEditedUsers([setting?.updatedBy]);
      return res.json({
        intervalMinutes,
        defaultMinutes: DEFAULT_RECOVERY_PRUNE_INTERVAL_MINUTES,
        minMinutes: MIN_RECOVERY_PRUNE_INTERVAL_MINUTES,
        maxMinutes: MAX_RECOVERY_PRUNE_INTERVAL_MINUTES,
        lastEdited: setting
          ? buildLastEdited(setting.updatedAt, setting.updatedBy, userMap)
          : null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  app.put("/api/integrations/front/historical-recovery/prune-interval", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<Record<string, string>, { intervalMinutes?: unknown }>, res) => {
    const {
      setRecoveryPruneIntervalMinutes,
      getRecoveryPruneIntervalMinutes,
      restartRecoveryPruneSweepFromSettings,
    } = await import("../../services/frontHistoricalRecovery");
    const minutes = Number(req.body?.intervalMinutes);
    const updatedBy = req.user?.claims?.sub || req.user?.id || "system";
    let oldValue: number | null = null;
    try {
      oldValue = await getRecoveryPruneIntervalMinutes();
    } catch {
      oldValue = null;
    }
    let saved: number;
    try {
      saved = await setRecoveryPruneIntervalMinutes(minutes, String(updatedBy));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid value";
      return res.status(400).json({ error: message });
    }
    let restartError: string | null = null;
    try {
      await restartRecoveryPruneSweepFromSettings({ runImmediately: false });
    } catch (err: any) {
      restartError = err?.message ? String(err.message) : "Failed to restart sweep timer";
      console.error("[Integrations] Failed to restart recovery prune sweep:", restartError);
    }
    if (oldValue !== saved) {
      try {
        await insertActivityLogs([{
          userId: req.user?.claims?.sub ?? null,
          actionType: "front_recovery_prune_interval_updated",
          route: "/api/integrations/front/historical-recovery/prune-interval",
          actionDetail: `Updated Front recovery prune interval: ${oldValue ?? "—"} → ${saved} min`,
          metadata: {
            oldValues: { intervalMinutes: oldValue },
            newValues: { intervalMinutes: saved },
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[Integrations] Recovery prune-interval audit log failed:", logErr?.message);
      }
      try {
        const { RECOVERY_PRUNE_INTERVAL_MINUTES_KEY } = await import("../../services/frontHistoricalRecovery");
        await storage.recordAdminSettingChange({
          settingKey: RECOVERY_PRUNE_INTERVAL_MINUTES_KEY,
          scope: null,
          changedBy: req.user?.claims?.sub ?? null,
          oldValues: { intervalMinutes: oldValue },
          newValues: { intervalMinutes: saved },
        });
      } catch (auditErr: any) {
        console.error("[Integrations] Recovery prune-interval setting audit failed:", auditErr?.message);
      }
    }
    if (restartError) {
      return res.status(500).json({ intervalMinutes: saved, restartError });
    }
    return res.json({ intervalMinutes: saved });
  });


  app.get("/api/integrations/front/historical-recovery/max-age/history", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { RECOVERY_MAX_AGE_DAYS_KEY } = await import("../../services/frontHistoricalRecovery");
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 5, 50));
      const history = await buildRecoverySettingHistory(RECOVERY_MAX_AGE_DAYS_KEY, limit);
      return res.json({ history });
    } catch (err: any) {
      console.error("[Integrations] Recovery max-age history fetch failed:", err?.message);
      return res.status(500).json({ error: "Failed to fetch max-age history" });
    }
  });

  // Post-#1787 throughput follow-up: GET / PUT for the Front recovery
  // ingest-concurrency setting + Phase 3 tuning kill switch.
  // Replaces the operator-run `scripts/flip-front-recovery-tuning-on.ts`
  // with a UI surface on the Front Historical Recovery panel.
  app.get(
    "/api/integrations/front/historical-recovery/tuning",
    isAuthenticated,
    requireAccountManager,
    async (_req: any, res) => {
      try {
        const { getFrontRecoveryTuning } = await import(
          "../../services/frontRecoveryTuning"
        );
        const { storage } = await import("../../storage");
        const snapshot = getFrontRecoveryTuning();
        const concurrencySetting = await storage.getSystemSetting(
          "front_recovery_ingest_concurrency",
        );
        const tuningSwitchSetting = await storage.getSystemSetting(
          "front_recovery_pool_threshold_tuning_enabled",
        );
        const { resolveLastEditedUsers, buildLastEdited } = await import(
          "../lastEditedHelper"
        );
        const userMap = await resolveLastEditedUsers([
          concurrencySetting?.updatedBy,
          tuningSwitchSetting?.updatedBy,
        ]);
        return res.json({
          ingestConcurrency: snapshot.ingestConcurrency,
          tuningEnabled: snapshot.tuningEnabled,
          minConcurrency: 1,
          maxConcurrency: 5,
          defaultConcurrency: 1,
          concurrencyLastEdited: concurrencySetting
            ? buildLastEdited(
                concurrencySetting.updatedAt,
                concurrencySetting.updatedBy,
                userMap,
              )
            : null,
          tuningEnabledLastEdited: tuningSwitchSetting
            ? buildLastEdited(
                tuningSwitchSetting.updatedAt,
                tuningSwitchSetting.updatedBy,
                userMap,
              )
            : null,
        });
      } catch (err: any) {
        return res
          .status(500)
          .json({ error: err?.message ?? "Failed to load recovery tuning" });
      }
    },
  );

  app.put(
    "/api/integrations/front/historical-recovery/tuning",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { ingestConcurrency?: unknown; tuningEnabled?: unknown }>, res) => {
      try {
        const { storage } = await import("../../storage");
        const { setPoolEpicSwitch } = await import(
          "../../services/poolEpicKillSwitches"
        );
        const { getFrontRecoveryTuning } = await import(
          "../../services/frontRecoveryTuning"
        );
        const actor =
          req.user?.claims?.sub || req.user?.username || req.user?.id || "system";

        const changes: Array<{ key: string; oldValue: any; newValue: any }> = [];

        if (req.body?.ingestConcurrency !== undefined) {
          const raw = Number(req.body.ingestConcurrency);
          if (!Number.isInteger(raw) || raw < 1 || raw > 5) {
            return res.status(400).json({
              error: "ingestConcurrency must be an integer in [1, 5]",
            });
          }
          const before = await storage.getSystemSetting(
            "front_recovery_ingest_concurrency",
          );
          const beforeVal = before?.value ?? null;
          if (beforeVal !== String(raw)) {
            await storage.setSystemSetting(
              "front_recovery_ingest_concurrency",
              String(raw),
              String(actor),
            );
            changes.push({
              key: "front_recovery_ingest_concurrency",
              oldValue: beforeVal,
              newValue: String(raw),
            });
          }
        }

        if (req.body?.tuningEnabled !== undefined) {
          if (typeof req.body.tuningEnabled !== "boolean") {
            return res
              .status(400)
              .json({ error: "tuningEnabled must be boolean" });
          }
          const before = await storage.getSystemSetting(
            "front_recovery_pool_threshold_tuning_enabled",
          );
          const beforeVal = before?.value ?? null;
          const target = req.body.tuningEnabled ? "true" : "false";
          if (beforeVal !== target) {
            await setPoolEpicSwitch(
              "front_recovery_pool_threshold_tuning_enabled",
              req.body.tuningEnabled,
              String(actor),
            );
            changes.push({
              key: "front_recovery_pool_threshold_tuning_enabled",
              oldValue: beforeVal,
              newValue: target,
            });
          }
        }

        for (const ch of changes) {
          try {
            await insertActivityLogs([
              {
                userId: req.user?.claims?.sub ?? null,
                actionType: "front_recovery_tuning_updated",
                route: "/api/integrations/front/historical-recovery/tuning",
                actionDetail: `Updated ${ch.key}: ${ch.oldValue ?? "<unset>"} → ${ch.newValue}`,
                metadata: {
                  oldValues: { [ch.key]: ch.oldValue },
                  newValues: { [ch.key]: ch.newValue },
                },
                sessionId: null,
                duration: null,
                timestamp: new Date(),
              },
            ]);
          } catch (logErr: any) {
            console.error(
              "[Integrations] Recovery tuning audit log failed:",
              logErr?.message,
            );
          }
          try {
            await storage.recordAdminSettingChange({
              settingKey: ch.key,
              scope: null,
              changedBy: req.user?.claims?.sub ?? null,
              oldValues: { [ch.key]: ch.oldValue },
              newValues: { [ch.key]: ch.newValue },
            });
          } catch (auditErr: any) {
            console.error(
              "[Integrations] Recovery tuning setting audit failed:",
              auditErr?.message,
            );
          }
        }

        const snapshot = getFrontRecoveryTuning();
        return res.json({
          ingestConcurrency: snapshot.ingestConcurrency,
          tuningEnabled: snapshot.tuningEnabled,
          changes: changes.length,
        });
      } catch (err: any) {
        return res
          .status(500)
          .json({ error: err?.message ?? "Failed to update recovery tuning" });
      }
    },
  );

  // Task #2720 — GET / PUT for the applied-conversation materializer's two
  // per-tick Front API call budgets (Task #2714's `system_settings` knobs).
  // These are the throughput dial behind the Front Console "Bring it to 100%"
  // backfill. This surfaces them on the Front Historical Recovery panel so a
  // non-technical operator can nudge the backfill speed from a screen instead
  // of writing raw `system_settings` rows. Blank → reset to in-code default.
  app.get(
    "/api/integrations/front/historical-recovery/materializer-budget",
    isAuthenticated,
    requireAccountManager,
    async (_req: any, res) => {
      try {
        const {
          SETTING_MATERIALIZER_CONVERSATION_BUDGET,
          SETTING_MATERIALIZER_MESSAGE_PAGE_BUDGET,
          MATERIALIZER_CONVERSATION_BUDGET_MAX,
          MATERIALIZER_MESSAGE_PAGE_BUDGET_MAX,
          resolveMaterializerBudget,
        } = await import("../../services/frontAppliedConvMaterializer");
        const {
          ENUM_CONVERSATIONS_PER_TICK_DEFAULT,
          ENUM_MESSAGE_PAGES_PER_TICK_DEFAULT,
        } = await import("../../services/frontAnalyticsClient");
        const { storage } = await import("../../storage");
        const convSetting = await storage.getSystemSetting(
          SETTING_MATERIALIZER_CONVERSATION_BUDGET,
        );
        const msgPageSetting = await storage.getSystemSetting(
          SETTING_MATERIALIZER_MESSAGE_PAGE_BUDGET,
        );
        const resolved = resolveMaterializerBudget(
          convSetting?.value,
          msgPageSetting?.value,
        );
        const { resolveLastEditedUsers, buildLastEdited } = await import(
          "../lastEditedHelper"
        );
        const userMap = await resolveLastEditedUsers([
          convSetting?.updatedBy,
          msgPageSetting?.updatedBy,
        ]);
        return res.json({
          conversationBudget: resolved.conversationBudget,
          messagePageBudget: resolved.messagePageBudget,
          defaultConversationBudget: ENUM_CONVERSATIONS_PER_TICK_DEFAULT,
          defaultMessagePageBudget: ENUM_MESSAGE_PAGES_PER_TICK_DEFAULT,
          maxConversationBudget: MATERIALIZER_CONVERSATION_BUDGET_MAX,
          maxMessagePageBudget: MATERIALIZER_MESSAGE_PAGE_BUDGET_MAX,
          // true only when the operator has overridden the in-code default —
          // lets the UI render a blank input (= using default) vs the override.
          conversationBudgetOverridden: !!convSetting,
          messagePageBudgetOverridden: !!msgPageSetting,
          conversationBudgetLastEdited: convSetting
            ? buildLastEdited(
                convSetting.updatedAt,
                convSetting.updatedBy,
                userMap,
              )
            : null,
          messagePageBudgetLastEdited: msgPageSetting
            ? buildLastEdited(
                msgPageSetting.updatedAt,
                msgPageSetting.updatedBy,
                userMap,
              )
            : null,
        });
      } catch (err: any) {
        return res.status(500).json({
          error: err?.message ?? "Failed to load materializer budget",
        });
      }
    },
  );

  app.put(
    "/api/integrations/front/historical-recovery/materializer-budget",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { conversationBudget?: unknown; messagePageBudget?: unknown }>, res) => {
      try {
        const {
          SETTING_MATERIALIZER_CONVERSATION_BUDGET,
          SETTING_MATERIALIZER_MESSAGE_PAGE_BUDGET,
          MATERIALIZER_CONVERSATION_BUDGET_MAX,
          MATERIALIZER_MESSAGE_PAGE_BUDGET_MAX,
          resolveMaterializerBudget,
        } = await import("../../services/frontAppliedConvMaterializer");
        const { storage } = await import("../../storage");
        const actor =
          req.user?.claims?.sub || req.user?.username || req.user?.id || "system";

        const isBlank = (v: any): boolean =>
          v === null ||
          v === undefined ||
          (typeof v === "string" && v.trim() === "");

        const fields = [
          {
            present: req.body?.conversationBudget !== undefined,
            raw: req.body?.conversationBudget,
            key: SETTING_MATERIALIZER_CONVERSATION_BUDGET,
            max: MATERIALIZER_CONVERSATION_BUDGET_MAX,
            label: "conversationBudget",
          },
          {
            present: req.body?.messagePageBudget !== undefined,
            raw: req.body?.messagePageBudget,
            key: SETTING_MATERIALIZER_MESSAGE_PAGE_BUDGET,
            max: MATERIALIZER_MESSAGE_PAGE_BUDGET_MAX,
            label: "messagePageBudget",
          },
        ];

        // Validation pass — reject before any write so a bad second field can't
        // leave the first half-applied. A blank value is valid (= reset).
        for (const f of fields) {
          if (!f.present || isBlank(f.raw)) continue;
          const n = Number(f.raw);
          if (!Number.isInteger(n) || n < 1 || n > f.max) {
            return res.status(400).json({
              error: `${f.label} must be an integer in [1, ${f.max}] or blank to reset to default`,
            });
          }
        }

        const changes: Array<{ key: string; oldValue: any; newValue: any }> = [];

        // Write pass.
        for (const f of fields) {
          if (!f.present) continue;
          const before = await storage.getSystemSetting(f.key);
          const beforeVal = before?.value ?? null;
          if (isBlank(f.raw)) {
            if (beforeVal !== null) {
              await storage.deleteSystemSetting(f.key);
              changes.push({ key: f.key, oldValue: beforeVal, newValue: null });
            }
            continue;
          }
          const target = String(Number(f.raw));
          if (beforeVal !== target) {
            await storage.setSystemSetting(f.key, target, String(actor));
            changes.push({ key: f.key, oldValue: beforeVal, newValue: target });
          }
        }

        for (const ch of changes) {
          try {
            await insertActivityLogs([
              {
                userId: req.user?.claims?.sub ?? null,
                actionType: "front_materializer_budget_updated",
                route:
                  "/api/integrations/front/historical-recovery/materializer-budget",
                actionDetail: `Updated ${ch.key}: ${ch.oldValue ?? "<unset>"} → ${ch.newValue ?? "<default>"}`,
                metadata: {
                  oldValues: { [ch.key]: ch.oldValue },
                  newValues: { [ch.key]: ch.newValue },
                },
                sessionId: null,
                duration: null,
                timestamp: new Date(),
              },
            ]);
          } catch (logErr: any) {
            console.error(
              "[Integrations] Materializer budget audit log failed:",
              logErr?.message,
            );
          }
          try {
            await storage.recordAdminSettingChange({
              settingKey: ch.key,
              scope: null,
              changedBy: req.user?.claims?.sub ?? null,
              oldValues: { [ch.key]: ch.oldValue },
              newValues: { [ch.key]: ch.newValue },
            });
          } catch (auditErr: any) {
            console.error(
              "[Integrations] Materializer budget setting audit failed:",
              auditErr?.message,
            );
          }
        }

        const convSetting = await storage.getSystemSetting(
          SETTING_MATERIALIZER_CONVERSATION_BUDGET,
        );
        const msgPageSetting = await storage.getSystemSetting(
          SETTING_MATERIALIZER_MESSAGE_PAGE_BUDGET,
        );
        const resolved = resolveMaterializerBudget(
          convSetting?.value,
          msgPageSetting?.value,
        );
        return res.json({
          conversationBudget: resolved.conversationBudget,
          messagePageBudget: resolved.messagePageBudget,
          changes: changes.length,
        });
      } catch (err: any) {
        return res.status(500).json({
          error: err?.message ?? "Failed to update materializer budget",
        });
      }
    },
  );

  // Task #989: GET / PUT / history for the auto-continue max attempts cap.
  app.get("/api/integrations/front/historical-recovery/auto-continue-max-attempts", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      const {
        getRecoveryAutoContinueMaxAttempts,
        DEFAULT_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS,
        MIN_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS,
        MAX_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS,
        RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS_KEY,
      } = await import("../../services/frontHistoricalRecovery");
      const maxAttempts = await getRecoveryAutoContinueMaxAttempts();
      const setting = await storage.getSystemSetting(RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS_KEY);
      const { resolveLastEditedUsers, buildLastEdited } = await import("../lastEditedHelper");
      const userMap = await resolveLastEditedUsers([setting?.updatedBy]);
      return res.json({
        maxAttempts,
        defaultAttempts: DEFAULT_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS,
        minAttempts: MIN_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS,
        maxAttemptsAllowed: MAX_RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS,
        lastEdited: setting
          ? buildLastEdited(setting.updatedAt, setting.updatedBy, userMap)
          : null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  app.put("/api/integrations/front/historical-recovery/auto-continue-max-attempts", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<Record<string, string>, { maxAttempts?: unknown }>, res) => {
    const {
      getRecoveryAutoContinueMaxAttempts,
      setRecoveryAutoContinueMaxAttempts,
      RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS_KEY,
    } = await import("../../services/frontHistoricalRecovery");
    const value = Number(req.body?.maxAttempts);
    const updatedBy = req.user?.claims?.sub || req.user?.id || "system";
    let oldValue: number | null = null;
    try {
      oldValue = await getRecoveryAutoContinueMaxAttempts();
    } catch {
      oldValue = null;
    }
    let saved: number;
    try {
      saved = await setRecoveryAutoContinueMaxAttempts(value, String(updatedBy));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid value";
      return res.status(400).json({ error: message });
    }
    if (oldValue !== saved) {
      try {
        await insertActivityLogs([{
          userId: req.user?.claims?.sub ?? null,
          actionType: "front_recovery_auto_continue_max_attempts_updated",
          route: "/api/integrations/front/historical-recovery/auto-continue-max-attempts",
          actionDetail: `Updated Front recovery auto-continue max attempts: ${oldValue ?? "—"} → ${saved}`,
          metadata: {
            oldValues: { maxAttempts: oldValue },
            newValues: { maxAttempts: saved },
          },
          sessionId: null,
          duration: null,
          timestamp: new Date(),
        }]);
      } catch (logErr: any) {
        console.error("[Integrations] Recovery auto-continue audit log failed:", logErr?.message);
      }
      try {
        await storage.recordAdminSettingChange({
          settingKey: RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS_KEY,
          scope: null,
          changedBy: req.user?.claims?.sub ?? null,
          oldValues: { maxAttempts: oldValue },
          newValues: { maxAttempts: saved },
        });
      } catch (auditErr: any) {
        console.error("[Integrations] Recovery auto-continue setting audit failed:", auditErr?.message);
      }
    }
    return res.json({ maxAttempts: saved });
  });

  app.get("/api/integrations/front/historical-recovery/auto-continue-max-attempts/history", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS_KEY } = await import("../../services/frontHistoricalRecovery");
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 5, 50));
      const history = await buildRecoverySettingHistory(RECOVERY_AUTO_CONTINUE_MAX_ATTEMPTS_KEY, limit);
      return res.json({ history });
    } catch (err: any) {
      console.error("[Integrations] Recovery auto-continue history fetch failed:", err?.message);
      return res.status(500).json({ error: "Failed to fetch auto-continue history" });
    }
  });

  app.get("/api/integrations/front/historical-recovery/prune-interval/history", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { RECOVERY_PRUNE_INTERVAL_MINUTES_KEY } = await import("../../services/frontHistoricalRecovery");
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 5, 50));
      const history = await buildRecoverySettingHistory(RECOVERY_PRUNE_INTERVAL_MINUTES_KEY, limit);
      return res.json({ history });
    } catch (err: any) {
      console.error("[Integrations] Recovery prune-interval history fetch failed:", err?.message);
      return res.status(500).json({ error: "Failed to fetch prune-interval history" });
    }
  });

  // Task #1023 — retry-pressure alert config (threshold + enabled flag).
  app.get(
    "/api/integrations/front/historical-recovery/retry-alert",
    isAuthenticated,
    requireAccountManager,
    async (_req: any, res) => {
      try {
        const {
          getFrontRecoveryRetryAlertConfig,
          DEFAULTS,
          MIN_TOTAL_RETRIES_THRESHOLD,
          MAX_TOTAL_RETRIES_THRESHOLD,
          MIN_CONSECUTIVE_WINDOW_COUNT,
          MAX_CONSECUTIVE_WINDOW_COUNT,
          MIN_CONSECUTIVE_5XX_FLOOR,
          MAX_CONSECUTIVE_5XX_FLOOR,
          SETTING_TOTAL_RETRIES_THRESHOLD,
          SETTING_ENABLED,
          SETTING_CONSECUTIVE_WINDOW_COUNT,
          SETTING_CONSECUTIVE_5XX_FLOOR,
        } = await import("../../services/frontRecoveryRetryAlerts");
        const cfg = await getFrontRecoveryRetryAlertConfig();
        const [
          thresholdSetting,
          enabledSetting,
          consecutiveCountSetting,
          consecutive5xxFloorSetting,
        ] = await Promise.all([
          storage.getSystemSetting(SETTING_TOTAL_RETRIES_THRESHOLD),
          storage.getSystemSetting(SETTING_ENABLED),
          storage.getSystemSetting(SETTING_CONSECUTIVE_WINDOW_COUNT),
          storage.getSystemSetting(SETTING_CONSECUTIVE_5XX_FLOOR),
        ]);
        const { resolveLastEditedUsers, buildLastEdited } = await import("../lastEditedHelper");
        const userMap = await resolveLastEditedUsers([
          thresholdSetting?.updatedBy,
          enabledSetting?.updatedBy,
          consecutiveCountSetting?.updatedBy,
          consecutive5xxFloorSetting?.updatedBy,
        ]);
        return res.json({
          enabled: cfg.enabled,
          totalRetriesThreshold: cfg.totalRetriesThreshold,
          consecutiveWindowCount: cfg.consecutiveWindowCount,
          consecutive5xxFloor: cfg.consecutive5xxFloor,
          defaultEnabled: DEFAULTS.enabled,
          defaultThreshold: DEFAULTS.totalRetriesThreshold,
          defaultConsecutiveWindowCount: DEFAULTS.consecutiveWindowCount,
          defaultConsecutive5xxFloor: DEFAULTS.consecutive5xxFloor,
          minThreshold: MIN_TOTAL_RETRIES_THRESHOLD,
          maxThreshold: MAX_TOTAL_RETRIES_THRESHOLD,
          minConsecutiveWindowCount: MIN_CONSECUTIVE_WINDOW_COUNT,
          maxConsecutiveWindowCount: MAX_CONSECUTIVE_WINDOW_COUNT,
          minConsecutive5xxFloor: MIN_CONSECUTIVE_5XX_FLOOR,
          maxConsecutive5xxFloor: MAX_CONSECUTIVE_5XX_FLOOR,
          thresholdLastEdited: thresholdSetting
            ? buildLastEdited(thresholdSetting.updatedAt, thresholdSetting.updatedBy, userMap)
            : null,
          enabledLastEdited: enabledSetting
            ? buildLastEdited(enabledSetting.updatedAt, enabledSetting.updatedBy, userMap)
            : null,
          consecutiveWindowCountLastEdited: consecutiveCountSetting
            ? buildLastEdited(consecutiveCountSetting.updatedAt, consecutiveCountSetting.updatedBy, userMap)
            : null,
          consecutive5xxFloorLastEdited: consecutive5xxFloorSetting
            ? buildLastEdited(consecutive5xxFloorSetting.updatedAt, consecutive5xxFloorSetting.updatedBy, userMap)
            : null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return res.status(500).json({ error: message });
      }
    },
  );

  app.put(
    "/api/integrations/front/historical-recovery/retry-alert",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<Record<string, string>, { enabled?: unknown; totalRetriesThreshold?: unknown; consecutiveWindowCount?: unknown; consecutive5xxFloor?: unknown }>, res) => {
      try {
        const {
          getFrontRecoveryRetryAlertConfig,
          setFrontRecoveryRetryAlertEnabled,
          setFrontRecoveryRetryAlertThreshold,
          setFrontRecoveryConsecutiveWindowCount,
          setFrontRecoveryConsecutive5xxFloor,
          SETTING_ENABLED,
          SETTING_TOTAL_RETRIES_THRESHOLD,
          SETTING_CONSECUTIVE_WINDOW_COUNT,
          SETTING_CONSECUTIVE_5XX_FLOOR,
        } = await import("../../services/frontRecoveryRetryAlerts");
        const updatedBy = req.user?.claims?.sub || req.user?.id || "system";
        const before = await getFrontRecoveryRetryAlertConfig();

        let savedEnabled = before.enabled;
        let savedThreshold = before.totalRetriesThreshold;
        let savedConsecutiveCount = before.consecutiveWindowCount;
        let savedConsecutive5xxFloor = before.consecutive5xxFloor;

        if (typeof req.body?.enabled === "boolean") {
          savedEnabled = await setFrontRecoveryRetryAlertEnabled(
            req.body.enabled,
            String(updatedBy),
          );
        }
        if (req.body?.totalRetriesThreshold != null) {
          const n = Number(req.body.totalRetriesThreshold);
          savedThreshold = await setFrontRecoveryRetryAlertThreshold(
            n,
            String(updatedBy),
          );
        }
        if (req.body?.consecutiveWindowCount != null) {
          const n = Number(req.body.consecutiveWindowCount);
          savedConsecutiveCount = await setFrontRecoveryConsecutiveWindowCount(
            n,
            String(updatedBy),
          );
        }
        if (req.body?.consecutive5xxFloor != null) {
          const n = Number(req.body.consecutive5xxFloor);
          savedConsecutive5xxFloor = await setFrontRecoveryConsecutive5xxFloor(
            n,
            String(updatedBy),
          );
        }

        if (before.enabled !== savedEnabled) {
          try {
            await storage.recordAdminSettingChange({
              settingKey: SETTING_ENABLED,
              scope: null,
              changedBy: req.user?.claims?.sub ?? null,
              oldValues: { enabled: before.enabled },
              newValues: { enabled: savedEnabled },
            });
          } catch (auditErr: any) {
            console.error(
              "[Integrations] Front retry-alert enabled audit failed:",
              auditErr?.message,
            );
          }
        }
        if (before.totalRetriesThreshold !== savedThreshold) {
          try {
            await storage.recordAdminSettingChange({
              settingKey: SETTING_TOTAL_RETRIES_THRESHOLD,
              scope: null,
              changedBy: req.user?.claims?.sub ?? null,
              oldValues: { totalRetriesThreshold: before.totalRetriesThreshold },
              newValues: { totalRetriesThreshold: savedThreshold },
            });
          } catch (auditErr: any) {
            console.error(
              "[Integrations] Front retry-alert threshold audit failed:",
              auditErr?.message,
            );
          }
        }
        if (before.consecutiveWindowCount !== savedConsecutiveCount) {
          try {
            await storage.recordAdminSettingChange({
              settingKey: SETTING_CONSECUTIVE_WINDOW_COUNT,
              scope: null,
              changedBy: req.user?.claims?.sub ?? null,
              oldValues: { consecutiveWindowCount: before.consecutiveWindowCount },
              newValues: { consecutiveWindowCount: savedConsecutiveCount },
            });
          } catch (auditErr: any) {
            console.error(
              "[Integrations] Front retry-alert consecutive window count audit failed:",
              auditErr?.message,
            );
          }
        }
        if (before.consecutive5xxFloor !== savedConsecutive5xxFloor) {
          try {
            await storage.recordAdminSettingChange({
              settingKey: SETTING_CONSECUTIVE_5XX_FLOOR,
              scope: null,
              changedBy: req.user?.claims?.sub ?? null,
              oldValues: { consecutive5xxFloor: before.consecutive5xxFloor },
              newValues: { consecutive5xxFloor: savedConsecutive5xxFloor },
            });
          } catch (auditErr: any) {
            console.error(
              "[Integrations] Front retry-alert consecutive 5xx floor audit failed:",
              auditErr?.message,
            );
          }
        }

        return res.json({
          enabled: savedEnabled,
          totalRetriesThreshold: savedThreshold,
          consecutiveWindowCount: savedConsecutiveCount,
          consecutive5xxFloor: savedConsecutive5xxFloor,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid value";
        return res.status(400).json({ error: message });
      }
    },
  );

}
