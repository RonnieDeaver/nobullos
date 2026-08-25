/**
 * Integrations routes — work-queue admin (status, dead-letter, stuck / starvation, timings, workload, retention).
 * Extracted verbatim from server/routes/integrations.ts (Task #4152 / F6
 * split; original lines 6510–7239); sections: work-queue admin (status, dead-letter, stuck / starvation, timings, workload, retention).
 * Mounted by registerIntegrationRoutes in ../integrations.ts — route order is
 * preserved by the aggregator's call sequence; the only in-slice edit is
 * dynamic-import specifier depth (./ -> ../, ../ -> ../../).
 */
import type { Express } from "express";
import { storage } from "../../storage";
import { db } from "../../db";
import { inArray } from "drizzle-orm";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireAccountManager, requireTeamLead } from "../middleware";
import { insertActivityLogs } from "../../storage/activityStorage";
import { buildRecoverySettingHistory } from "./helpers";
import type { AuthenticatedRequest } from "../requestContext";

export function registerIntegrationsWorkQueueRoutes(app: Express) {
  app.get("/api/integrations/work-queue/dead-letter/queue-names", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { getDeadLetterQueueNames } = await import("../../services/workScheduler");
      const queueNames = await getDeadLetterQueueNames();
      res.json({ queueNames });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/work-queue/dead-letter", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { getDeadLetteredJobs } = await import("../../services/workScheduler");
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const queueName = req.query.queueName as string | undefined;
      const result = await getDeadLetteredJobs({ limit, offset, queueName });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/integrations/work-queue/dead-letter/:id/replay", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<{ id: string }>, res) => {
    try {
      const { replayDeadLetteredJob } = await import("../../services/workScheduler");
      const operatorId = req.user?.claims?.sub || req.user?.id || "unknown";
      const operatorUsername = req.user?.claims?.metadata?.username || req.user?.username || "unknown";
      const job = await replayDeadLetteredJob(req.params.id, { operatorId, operatorUsername });
      res.json({ success: true, job });
    } catch (error: any) {
      // F10 (Task #4156): normalize before classification — a non-Error throw
      // used to crash this catch (`.includes` on undefined), turning a clean
      // 404 into an opaque 500. Same 404-vs-500 split, same `error` string
      // for Error throws.
      const msg = typeof error?.message === "string" && error.message ? error.message : String(error);
      if (msg.includes("not found") || msg.includes("not in dead_letter")) {
        return res.status(404).json({ error: msg });
      }
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/integrations/work-queue/dead-letter/replay-all", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<Record<string, string>, { queueName?: unknown; dryRun?: unknown; maxBatchSize?: unknown }>, res) => {
    try {
      const { bulkReplayDeadLetteredJobs, BulkReplayCapExceededError } = await import("../../services/workScheduler");
      const queueName = req.body?.queueName as string | undefined;
      const dryRun = req.body?.dryRun === true;
      const rawMaxBatch = req.body?.maxBatchSize;
      const maxBatchSize = typeof rawMaxBatch === "number" && Number.isFinite(rawMaxBatch) && rawMaxBatch > 0
        ? Math.floor(rawMaxBatch)
        : undefined;
      const operatorId = req.user?.claims?.sub || req.user?.id || "unknown";
      const operatorUsername = req.user?.claims?.metadata?.username || req.user?.username || "unknown";

      try {
        const result = await bulkReplayDeadLetteredJobs({ queueName, dryRun, maxBatchSize, operatorId, operatorUsername });
        res.json({ success: true, dryRun, queueName: queueName ?? null, ...result });
      } catch (err: any) {
        if (err instanceof BulkReplayCapExceededError) {
          return res.status(400).json({
            success: false,
            error: err.message,
            code: "bulk_replay_cap_exceeded",
            matchCount: err.matchCount,
            cap: err.cap,
            hint: "Retry with dryRun=true to preview, narrow by queueName, or replay individual jobs via /dead-letter/:id/replay.",
          });
        }
        throw err;
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/work-queue/stale-lease-thresholds", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      const { getStaleLeaseThresholds, DEFAULT_STALE_LEASE_THRESHOLDS, STALE_LEASE_THRESHOLDS_KEY } = await import("../../services/staleLeaseThresholds");
      const { resolveLastEditedUsers, buildLastEdited } = await import("../lastEditedHelper");
      const thresholds = await getStaleLeaseThresholds();
      const setting = await storage.getSystemSetting(STALE_LEASE_THRESHOLDS_KEY);
      const userMap = await resolveLastEditedUsers([setting?.updatedBy]);
      res.json({
        thresholds,
        defaults: DEFAULT_STALE_LEASE_THRESHOLDS,
        lastEdited: { thresholds: buildLastEdited(setting?.updatedAt, setting?.updatedBy, userMap) },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/work-queue/stale-lease-thresholds/history", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 10, 50));
      const entries = await storage.listStaleLeaseThresholdAudit(limit);
      const userIds = Array.from(new Set(entries.map(e => e.changedBy).filter((id): id is string => !!id)));
      const userMap = new Map<string, { id: string; firstName: string | null; lastName: string | null; email: string | null }>();
      if (userIds.length > 0) {
        const { users } = await import("@shared/schema");
        const rows = await db.select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        }).from(users).where(inArray(users.id, userIds));
        for (const u of rows) userMap.set(u.id, u);
      }
      const history = entries.map(e => {
        const u = e.changedBy ? userMap.get(e.changedBy) : null;
        const name = u ? [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || u.id : null;
        return {
          id: e.id,
          changedBy: e.changedBy,
          changedByName: name,
          changedByEmail: u?.email ?? null,
          oldValues: e.oldValues,
          newValues: e.newValues,
          changedAt: e.changedAt,
        };
      });
      res.json({ history });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/integrations/work-queue/stale-lease-thresholds", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<Record<string, string>, { staleWarning?: unknown; staleCritical?: unknown; exhaustedWarning?: unknown; exhaustedCritical?: unknown; leaseCutoffMs?: unknown }>, res) => {
    try {
      const { setStaleLeaseThresholds, DEFAULT_STALE_LEASE_THRESHOLDS } = await import("../../services/staleLeaseThresholds");
      const body = req.body ?? {};
      const merged = {
        staleWarning: Number(body.staleWarning ?? DEFAULT_STALE_LEASE_THRESHOLDS.staleWarning),
        staleCritical: Number(body.staleCritical ?? DEFAULT_STALE_LEASE_THRESHOLDS.staleCritical),
        exhaustedWarning: Number(body.exhaustedWarning ?? DEFAULT_STALE_LEASE_THRESHOLDS.exhaustedWarning),
        exhaustedCritical: Number(body.exhaustedCritical ?? DEFAULT_STALE_LEASE_THRESHOLDS.exhaustedCritical),
        leaseCutoffMs: Number(body.leaseCutoffMs ?? DEFAULT_STALE_LEASE_THRESHOLDS.leaseCutoffMs),
      };
      const userId = req.user?.claims?.sub;
      const saved = await setStaleLeaseThresholds(merged, userId);
      res.json({ thresholds: saved });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/integrations/work-queue/timings", isAuthenticated, requireAccountManager, async (_req: any, res) => {
    try {
      const { getQueueTimings, DEFAULT_QUEUE_TIMINGS, QUEUE_TIMING_BOUNDS } = await import("../../services/queueTimingSettings");
      const timings = await getQueueTimings();
      res.json({ timings, defaults: DEFAULT_QUEUE_TIMINGS, bounds: QUEUE_TIMING_BOUNDS });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/work-queue/timings/history", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 10, 50));
      const { resolveThroughputWindowMs } = await import("../../services/queueTimingThroughput");
      const windowMs = resolveThroughputWindowMs(req.query.windowMs);
      const entries = await storage.listQueueTimingAudit(limit);
      const userIds = Array.from(new Set(entries.map(e => e.changedBy).filter((id): id is string => !!id)));
      const userMap = new Map<string, { id: string; firstName: string | null; lastName: string | null; email: string | null }>();
      if (userIds.length > 0) {
        const { users } = await import("@shared/schema");
        const rows = await db.select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        }).from(users).where(inArray(users.id, userIds));
        for (const u of rows) userMap.set(u.id, u);
      }

      // Throughput is aggregated DB-side via COUNT(*) FILTER per entry — see
      // server/services/queueTimingThroughput.ts. We intentionally do NOT
      // pull completed work_queue rows into Node memory here; under heavy
      // traffic the previous in-memory approach produced incorrect numbers.
      let throughputByEntry: Map<string, {
        windowMs: number;
        before: number | null;
        after: number | null;
        status: "ok" | "pending" | "no_baseline";
      }> = new Map();
      if (entries.length > 0) {
        try {
          const { computeThroughputForEntries } = await import("../../services/queueTimingThroughput");
          throughputByEntry = await computeThroughputForEntries(entries, windowMs);
        } catch (err: any) {
          // If throughput computation fails, return entries without throughput rather than failing the whole request.
          console.error("[QueueTimingHistory] throughput computation failed:", err?.message || err);
          throughputByEntry = new Map();
        }
      }

      const history = entries.map(e => {
        const u = e.changedBy ? userMap.get(e.changedBy) : null;
        const name = u ? [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || u.id : null;
        return {
          id: e.id,
          changedBy: e.changedBy,
          changedByName: name,
          changedByEmail: u?.email ?? null,
          oldValues: e.oldValues,
          newValues: e.newValues,
          changedAt: e.changedAt,
          throughput: throughputByEntry.get(e.id) ?? null,
        };
      });
      res.json({ history });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/integrations/work-queue/timings", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<Record<string, string>, { pollIntervalMs?: unknown; heartbeatIntervalMs?: unknown; baseBackoffMs?: unknown; maxBackoffMs?: unknown }>, res) => {
    try {
      const { setQueueTimings } = await import("../../services/queueTimingSettings");
      const body = req.body ?? {};
      const userId = req.user?.claims?.sub;
      const saved = await setQueueTimings(
        {
          pollIntervalMs: body.pollIntervalMs !== undefined ? Number(body.pollIntervalMs) : undefined,
          heartbeatIntervalMs: body.heartbeatIntervalMs !== undefined ? Number(body.heartbeatIntervalMs) : undefined,
          baseBackoffMs: body.baseBackoffMs !== undefined ? Number(body.baseBackoffMs) : undefined,
          maxBackoffMs: body.maxBackoffMs !== undefined ? Number(body.maxBackoffMs) : undefined,
        },
        userId,
      );
      res.json({ timings: saved });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/integrations/work-queue/audit-prune-events", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 50));
      const { listPruneEvents } = await import("../../services/auditPruneEvents");
      const {
        getStaleLeaseThresholdAuditRetention,
        STALE_LEASE_THRESHOLD_AUDIT_RETENTION_DEFAULTS,
        AUDIT_RETENTION_BOUNDS,
      } = await import("../../services/staleLeaseThresholds");
      const {
        getQueueTimingAuditRetention,
        QUEUE_TIMING_AUDIT_RETENTION_DEFAULTS,
        QUEUE_TIMING_AUDIT_RETENTION_BOUNDS,
      } = await import("../../services/queueTimingSettings");
      const { getAuditRetentionDays } = await import("../../services/auditRetention");
      const [adminEvents, staleEvents, queueEvents, staleRetention, queueRetention, auditRetentionInfo] = await Promise.all([
        listPruneEvents("admin_setting_audit", limit),
        listPruneEvents("stale_lease_threshold_audit", limit),
        listPruneEvents("queue_timing_audit", limit),
        getStaleLeaseThresholdAuditRetention(),
        getQueueTimingAuditRetention(),
        getAuditRetentionDays(),
      ]);

      const userIds = Array.from(new Set(
        [...adminEvents, ...staleEvents, ...queueEvents]
          .map((e) => e.triggeredBy)
          .filter((id): id is string => !!id && id !== "system"),
      ));
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
        } catch {
          // best-effort display-name enrichment — rows render with raw
          // operator IDs if this lookup fails (F10 disposition: retained)
        }
      }
      const enrich = (e: any) => ({
        ...e,
        triggeredByName: e.triggeredBy ? (userMap.get(e.triggeredBy) ?? null) : null,
      });

      res.json({
        adminSettingAudit: {
          events: adminEvents.map(enrich),
          retention: {
            maxEntries: 0,
            maxAgeDays: auditRetentionInfo.retentionDays,
          },
        },
        staleLeaseThresholdAudit: {
          events: staleEvents.map(enrich),
          retention: staleRetention,
          defaults: STALE_LEASE_THRESHOLD_AUDIT_RETENTION_DEFAULTS,
          bounds: AUDIT_RETENTION_BOUNDS,
        },
        queueTimingAudit: {
          events: queueEvents.map(enrich),
          retention: queueRetention,
          defaults: QUEUE_TIMING_AUDIT_RETENTION_DEFAULTS,
          bounds: QUEUE_TIMING_AUDIT_RETENTION_BOUNDS,
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/integrations/work-queue/audit-prune-events/stale-lease-threshold-audit/retention", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<Record<string, string>, { maxEntries?: unknown; maxAgeDays?: unknown }>, res) => {
    try {
      const { setStaleLeaseThresholdAuditRetention } = await import("../../services/staleLeaseThresholds");
      const body = req.body ?? {};
      const userId = req.user?.claims?.sub;
      const saved = await setStaleLeaseThresholdAuditRetention(
        {
          maxEntries: body.maxEntries !== undefined ? Number(body.maxEntries) : undefined,
          maxAgeDays: body.maxAgeDays !== undefined ? Number(body.maxAgeDays) : undefined,
        },
        userId,
      );
      res.json({ retention: saved });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.put("/api/integrations/work-queue/audit-prune-events/queue-timing-audit/retention", isAuthenticated, requireTeamLead, async (req: AuthenticatedRequest<Record<string, string>, { maxEntries?: unknown; maxAgeDays?: unknown }>, res) => {
    try {
      const { setQueueTimingAuditRetention } = await import("../../services/queueTimingSettings");
      const body = req.body ?? {};
      const userId = req.user?.claims?.sub;
      const saved = await setQueueTimingAuditRetention(
        {
          maxEntries: body.maxEntries !== undefined ? Number(body.maxEntries) : undefined,
          maxAgeDays: body.maxAgeDays !== undefined ? Number(body.maxAgeDays) : undefined,
        },
        userId,
      );
      res.json({ retention: saved });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Task #1184: history of admin edits to the two audit-retention setting keys
  // exposed by the audit-prune-events block in OperationalHealthCards. Mirrors
  // `buildRecoverySettingHistory` and reuses `listAdminSettingAudit` plus the
  // shared user-resolution helper.
  app.get(
    "/api/integrations/work-queue/audit-prune-events/stale-lease-threshold-audit/retention/history",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const { STALE_LEASE_THRESHOLD_AUDIT_RETENTION_KEY } = await import(
          "../../services/staleLeaseThresholds"
        );
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 10, 50));
        const history = await buildRecoverySettingHistory(
          STALE_LEASE_THRESHOLD_AUDIT_RETENTION_KEY,
          limit,
        );
        return res.json({ history });
      } catch (err: any) {
        console.error(
          "[Integrations] Stale-lease audit retention history fetch failed:",
          err?.message,
        );
        return res
          .status(500)
          .json({ error: "Failed to fetch retention history" });
      }
    },
  );

  app.get(
    "/api/integrations/work-queue/audit-prune-events/queue-timing-audit/retention/history",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const { QUEUE_TIMING_AUDIT_RETENTION_KEY } = await import(
          "../../services/queueTimingSettings"
        );
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 10, 50));
        const history = await buildRecoverySettingHistory(
          QUEUE_TIMING_AUDIT_RETENTION_KEY,
          limit,
        );
        return res.json({ history });
      } catch (err: any) {
        console.error(
          "[Integrations] Queue-timing audit retention history fetch failed:",
          err?.message,
        );
        return res
          .status(500)
          .json({ error: "Failed to fetch retention history" });
      }
    },
  );

  /**
   * Read-only preview of how many rows the proposed retention bounds would
   * remove on the next prune (Task #1185). Drives the "Saving will drop ~N
   * rows" hint next to the Save button in the audit retention editor. Never
   * mutates anything.
   */
  app.get("/api/integrations/work-queue/audit-prune-events/preview", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const tableParam = String(req.query.table ?? "");
      if (tableParam !== "stale" && tableParam !== "queue") {
        return res.status(400).json({ error: "table must be 'stale' or 'queue'" });
      }
      const parseBound = (raw: unknown, bounds: { min: number; max: number }) => {
        if (raw === undefined || raw === null || raw === "") return undefined;
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
        if (n < bounds.min || n > bounds.max) return null;
        return n;
      };
      if (tableParam === "stale") {
        const { AUDIT_RETENTION_BOUNDS } = await import("../../services/staleLeaseThresholds");
        const maxEntries = parseBound(req.query.maxEntries, AUDIT_RETENTION_BOUNDS.maxEntries);
        const maxAgeDays = parseBound(req.query.maxAgeDays, AUDIT_RETENTION_BOUNDS.maxAgeDays);
        if (maxEntries === null || maxAgeDays === null) {
          return res.status(400).json({ error: "maxEntries / maxAgeDays out of range" });
        }
        const estimate = await storage.estimatePruneStaleLeaseThresholdAudit({ maxEntries, maxAgeDays });
        return res.json(estimate);
      } else {
        const { QUEUE_TIMING_AUDIT_RETENTION_BOUNDS } = await import("../../services/queueTimingSettings");
        const maxEntries = parseBound(req.query.maxEntries, QUEUE_TIMING_AUDIT_RETENTION_BOUNDS.maxEntries);
        const maxAgeDays = parseBound(req.query.maxAgeDays, QUEUE_TIMING_AUDIT_RETENTION_BOUNDS.maxAgeDays);
        if (maxEntries === null || maxAgeDays === null) {
          return res.status(400).json({ error: "maxEntries / maxAgeDays out of range" });
        }
        const estimate = await storage.estimatePruneQueueTimingAudit({ maxEntries, maxAgeDays });
        return res.json(estimate);
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/integrations/work-queue/status", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const { getQueueStatus, getDispatchCountersSnapshot } = await import("../../services/workScheduler");
      const { getClassStatus, getTotalActiveSlots, getActiveWorkersList } = await import("../../services/workloadManager");
      const { getRepairDispatcherStatus } = await import("../../services/repairDispatcher");
      const { getStaleLeaseThresholds, STALE_LEASE_THRESHOLDS_KEY } = await import("../../services/staleLeaseThresholds");
      const { getQueueTimings, DEFAULT_QUEUE_TIMINGS, QUEUE_TIMING_BOUNDS, QUEUE_TIMING_SETTINGS_KEY } = await import("../../services/queueTimingSettings");
      const { resolveLastEditedUsers, buildLastEdited } = await import("../lastEditedHelper");
      const { PERF: statusPerf } = await import("../../perfConfig");
      const queueStatus = await getQueueStatus();
      const staleLeaseThresholds = await getStaleLeaseThresholds();
      const [staleLeaseThresholdsSetting, queueTimingsSetting] = await Promise.all([
        storage.getSystemSetting(STALE_LEASE_THRESHOLDS_KEY),
        storage.getSystemSetting(QUEUE_TIMING_SETTINGS_KEY),
      ]);
      const queueStatusUserMap = await resolveLastEditedUsers([
        staleLeaseThresholdsSetting?.updatedBy,
        queueTimingsSetting?.updatedBy,
      ]);
      const queueTimings = await getQueueTimings();
      const classStatus = getClassStatus();
      const repairStatus = getRepairDispatcherStatus();
      let inventorySyncState = null;
      try {
        const { getInventoryState } = await import("../../services/semrushInventorySync");
        inventorySyncState = getInventoryState();
      } catch {
        // best-effort: inventory sync state is an optional panel in this
        // status payload; null means "unavailable" (F10 disposition: retained)
      }
      res.json({
        featureFlags: {
          repairQueueEnabled: statusPerf.REPAIR_QUEUE_ENABLED,
          repairDispatcherEnabled: statusPerf.REPAIR_DISPATCHER_ENABLED,
          interactiveRepairEnqueueEnabled: statusPerf.INTERACTIVE_REPAIR_ENQUEUE_ENABLED,
          zoomEventIngestEnabled: statusPerf.ZOOM_EVENT_INGEST_ENABLED,
          zoomReconciliationEnabled: statusPerf.ZOOM_RECONCILIATION_ENABLED,
          frontEventIngestEnabled: statusPerf.FRONT_EVENT_INGEST_ENABLED,
          frontReconciliationEnabled: statusPerf.FRONT_RECONCILIATION_ENABLED,
          semrushInventorySyncEnabled: statusPerf.SEMRUSH_INVENTORY_SYNC_ENABLED,
          semrushReportRefreshEnabled: statusPerf.SEMRUSH_REPORT_REFRESH_ENABLED,
          durableApplyEnabled: statusPerf.DURABLE_APPLY_ENABLED,
          legacyDirectMutationFrontEnabled: statusPerf.LEGACY_DIRECT_MUTATION_FRONT_ENABLED,
          legacyDirectMutationZoomEnabled: statusPerf.LEGACY_DIRECT_MUTATION_ZOOM_ENABLED,
          legacyDirectMutationSemrushEnabled: statusPerf.LEGACY_DIRECT_MUTATION_SEMRUSH_ENABLED,
        },
        slotBudgets: classStatus,
        totalActiveSlots: getTotalActiveSlots(),
        activeSlotWorkers: getActiveWorkersList(),
        schedulerActiveByClass: queueStatus.activeByClass,
        queueDepths: queueStatus.depths,
        queueDepthsByClass: queueStatus.depthsByClass,
        activeLeasedByClass: queueStatus.activeLeasedByClass,
        recentCompletions: queueStatus.recentCompletions,
        recentFailures: queueStatus.recentFailures,
        recentDeadLettered: queueStatus.recentDeadLettered,
        staleJobs: queueStatus.staleJobs,
        oldestPendingAgeMs: queueStatus.oldestPendingAgeMs,
        averageLeaseDurationMs: queueStatus.averageLeaseDurationMs,
        retryDistribution: queueStatus.retryDistribution,
        starvationWarnings: queueStatus.starvationWarnings,
        dispatchCounters: getDispatchCountersSnapshot(),
        slotHoldMetrics: queueStatus.slotHoldMetrics,
        staleLeaseExhaustion: queueStatus.staleLeaseExhaustion,
        staleLeaseThresholds,
        staleLeaseThresholdsLastEdited: buildLastEdited(staleLeaseThresholdsSetting?.updatedAt, staleLeaseThresholdsSetting?.updatedBy, queueStatusUserMap),
        queueTimings,
        queueTimingDefaults: DEFAULT_QUEUE_TIMINGS,
        queueTimingBounds: QUEUE_TIMING_BOUNDS,
        queueTimingsLastEdited: buildLastEdited(queueTimingsSetting?.updatedAt, queueTimingsSetting?.updatedBy, queueStatusUserMap),
        repairDispatcher: repairStatus,
        semrushInventorySync: inventorySyncState ? {
          isRunning: inventorySyncState.isRunning,
          hasPreviousInventory: !!inventorySyncState.previousInventory,
          campaignCount: inventorySyncState.previousInventory?.campaigns.length ?? 0,
          lastFetchedAt: inventorySyncState.previousInventory?.fetchedAt ?? null,
        } : null,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Task #1048: stuck-processing inventory. Lists rows in 'leased'/'processing'
  // with their lease age, heartbeat age, processing age, and the per-queue
  // max-processing ceiling — so operators can see which jobs the next
  // recoverStaleLeases sweep will reclaim and which are still healthy.
  app.get(
    "/api/integrations/work-queue/stuck-processing",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        // Task #1573 (Audit Track C, Pool Ownership Map): this is a
        // request-scoped admin lookup, not background work. Use the api
        // pool (`db`) so it doesn't consume worker-pool capacity.
        const { db } = await import("../../db");
        const { sql: dsql } = await import("drizzle-orm");
        const { getEffectiveMaxProcessingMap } = await import(
          "../../services/queueMaxProcessing"
        );
        const limit = Math.max(
          1,
          Math.min(Number(req.query.limit) || 100, 500),
        );
        const rawMinAge = Number(req.query.minAgeMs);
        const minAgeMs =
          Number.isFinite(rawMinAge) && rawMinAge > 0 ? rawMinAge : 0;

        const result = await db.execute(dsql`
          SELECT
            id,
            queue_name,
            workload_class,
            status,
            attempt_count,
            max_attempts,
            lease_owner,
            leased_at,
            lease_expires_at,
            heartbeat_at,
            EXTRACT(EPOCH FROM (NOW() - leased_at)) * 1000 AS processing_age_ms,
            EXTRACT(EPOCH FROM (NOW() - heartbeat_at)) * 1000 AS heartbeat_age_ms,
            EXTRACT(EPOCH FROM (lease_expires_at - NOW())) * 1000 AS lease_remaining_ms
          FROM work_queue
          WHERE status IN ('leased', 'processing')
            AND leased_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (NOW() - leased_at)) * 1000 >= ${minAgeMs}
          ORDER BY leased_at ASC
          LIMIT ${limit}
        `);

        const maxMap = await getEffectiveMaxProcessingMap();
        const fallback = maxMap.default;
        const rows = (result.rows as any[]).map((r) => {
          const queueName = String(r.queue_name);
          const maxProcessingMs = maxMap[queueName] ?? fallback;
          const processingAgeMs = Number(r.processing_age_ms);
          const heartbeatAgeMs =
            r.heartbeat_age_ms == null ? null : Number(r.heartbeat_age_ms);
          const leaseRemainingMs =
            r.lease_remaining_ms == null
              ? null
              : Number(r.lease_remaining_ms);
          const overByMs = processingAgeMs - maxProcessingMs;
          const willReclaim = overByMs > 0 || (leaseRemainingMs ?? 0) < 0;
          return {
            id: r.id,
            queueName,
            workloadClass: r.workload_class,
            status: r.status,
            attemptCount: Number(r.attempt_count),
            maxAttempts: Number(r.max_attempts),
            leaseOwner: r.lease_owner,
            leasedAt: r.leased_at,
            leaseExpiresAt: r.lease_expires_at,
            heartbeatAt: r.heartbeat_at,
            processingAgeMs,
            heartbeatAgeMs,
            leaseRemainingMs,
            maxProcessingMs,
            overMaxByMs: overByMs > 0 ? overByMs : 0,
            willReclaim,
          };
        });

        const grouped: Record<
          string,
          { queueName: string; count: number; maxProcessingMs: number; oldestProcessingAgeMs: number }
        > = {};
        for (const r of rows) {
          const g = grouped[r.queueName] ?? {
            queueName: r.queueName,
            count: 0,
            maxProcessingMs: r.maxProcessingMs,
            oldestProcessingAgeMs: 0,
          };
          g.count++;
          if (r.processingAgeMs > g.oldestProcessingAgeMs) {
            g.oldestProcessingAgeMs = r.processingAgeMs;
          }
          grouped[r.queueName] = g;
        }

        res.json({
          rows,
          byQueue: Object.values(grouped),
          maxProcessingMap: maxMap,
          countOverMax: rows.filter((r) => r.willReclaim).length,
          totalRows: rows.length,
        });
      } catch (error: any) {
        console.error(
          "[WorkQueue] stuck-processing fetch failed:",
          error?.message,
        );
        res
          .status(500)
          .json({ error: "Failed to load stuck processing jobs" });
      }
    },
  );

  // Task #1071: operator-initiated single-row reclaim. Releases one
  // stuck work_queue lease immediately instead of waiting for the next
  // recoverStaleLeases sweep. Mirrors recoverStaleLeases bookkeeping
  // (attempt_count + 1; exhaust at max_attempts; otherwise back to
  // pending with lease fields cleared) and writes an audit log entry
  // capturing operator + job id + previous lease owner.
  app.post(
    "/api/integrations/work-queue/:id/reclaim",
    isAuthenticated,
    requireTeamLead,
    async (req: AuthenticatedRequest<{ id: string }>, res) => {
      try {
        const { forceReclaimJob, ForceReclaimNotEligibleError } = await import(
          "../../services/workQueueLease"
        );
        const operatorId = req.user?.claims?.sub || req.user?.id || "unknown";
        const operatorUsername =
          req.user?.claims?.metadata?.username ||
          req.user?.username ||
          "unknown";
        try {
          const result = await forceReclaimJob(req.params.id, {
            operatorId,
            operatorUsername,
          });
          // Durable audit trail: persist operator + job + previous lease
          // owner to user_activity_logs so dashboards/audits can query it
          // long after the in-process worker logs have rotated.
          try {
            const { insertActivityLogs } = await import(
              "../../storage/activityStorage"
            );
            await insertActivityLogs([
              {
                userId: operatorId === "unknown" ? null : operatorId,
                actionType: "work_queue.force_reclaim",
                route: "/admin/system-health",
                actionDetail: `Force-reclaimed job ${result.jobId} (${result.queueName}/${result.workloadClass}) → ${result.outcome}`,
                metadata: {
                  jobId: result.jobId,
                  queueName: result.queueName,
                  workloadClass: result.workloadClass,
                  outcome: result.outcome,
                  previousLeaseOwner: result.previousLeaseOwner,
                  previousLeasedAt: result.previousLeasedAt,
                  previousLeaseExpiresAt: result.previousLeaseExpiresAt,
                  attemptCount: result.attemptCount,
                  maxAttempts: result.maxAttempts,
                  operatorUsername,
                },
              },
            ]);
          } catch (auditErr: any) {
            console.error(
              "[WorkQueue] force-reclaim audit log insert failed:",
              auditErr?.message,
            );
          }
          res.json({ success: true, ...result });
        } catch (err: any) {
          if (err instanceof ForceReclaimNotEligibleError) {
            return res.status(409).json({
              success: false,
              error: err.message,
              code: "not_eligible",
              currentStatus: err.currentStatus,
            });
          }
          throw err;
        }
      } catch (error: any) {
        console.error(
          "[WorkQueue] force-reclaim failed:",
          error?.message,
        );
        res
          .status(500)
          .json({ success: false, error: error?.message ?? "reclaim failed" });
      }
    },
  );

}
