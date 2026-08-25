// @db-pool-intent: api
/**
 * PR9 split (Task f1425127) — extracted VERBATIM from server/routes.ts
 * (formerly inline at lines 278–1044 at split time).
 *
 * GET /api/health snapshot (degraded tracker), health_samples/notification-tables bootstrap DDL kick, history, manual-reserve summary, alert thresholds, mutes, flush status, db-attribution, db-metrics, request metrics, and the dev-only obs-demo routes.
 *
 * Mount-order contract: registerHealthCoreRoutes(app) is invoked from
 * registerRoutes() in server/routes.ts at the exact position the inline
 * registrations previously occupied, preserving global registration order.
 * Do not reorder registrations here and do not mount this module elsewhere.
 */
import type { Express } from "express";
import { type Server } from "http";
import { db, withDbAttribution } from "../../db";
import { sql, and } from "drizzle-orm";
import { isAuthenticated } from "../../middlewares/requireAuth";
import {
  startHealthSampler,
  getHealthHistory,
  getPersistedHealthHistory,
  getPersistedManualReserveWorkerHistory,
  getPendingManualReserveWorkerSamples,
  getHealthSummary,
  computeSummaryFromSamples,
  getThresholds,
  updateThresholds,
  resetThresholds,
  getFlushStatus,
} from "../../services/healthMetrics";
import {
  getManualReserveMuteState,
  setManualReserveMute,
  clearManualReserveMute,
  notifyManualReserveMuteWindowEnded,
} from "../../services/manualReserveAlerts";
import { getRateLimitSummaryCompact } from "../../services/rateLimitMonitor";
import { requireTeamLead } from "../middleware";
import { storage } from "../../storage";
export async function registerHealthCoreRoutes(app: Express): Promise<void> {
  const healthStartTime = Date.now();

  // Task #1070 / #1073 / #1074 — track first-seen timestamp for each
  // degraded sub-check entry across /api/health requests so the
  // dashboard can render "degraded for Xm" next to each chip and
  // visually emphasize entries that have been degraded for a long
  // time. State is persisted in `system_settings` under
  // `health_degraded_first_seen` (see `services/healthDegradedFirstSeen.ts`)
  // so the duration survives server restarts and deploys — without
  // persistence, operators triaging right after a deploy saw
  // "degraded for 5s" for issues that had actually been broken for
  // hours. Task #1073 wrapped this in `healthDegradedTracker` so the
  // background alert watcher and the route share both the evaluation
  // and the durable first-seen map. Durable per-incident tracking
  // still lives in `health_incidents`; this is just the lightweight
  // "right now" duration shown next to each chip and used to gate
  // alert firing.
  const {
    evaluateHealthChecks,
    recordDegradedSnapshot,
  } = await import("../../services/healthDegradedTracker");

  app.get("/api/health", async (_req, res) => {
    const { checks, degraded } = await evaluateHealthChecks();

    const rateLimits = getRateLimitSummaryCompact();

    const uptimeMs = Date.now() - healthStartTime;
    // Task #1067 — fail-soft for non-critical sub-checks. The Health
    // dashboard polls `/api/health` and the global query-cache toasts
    // "Server error" on any 500/502/503 response. Returning 503 for
    // transient, non-critical degradations (e.g. `scheduler_stale`
    // after a single missed cycle, `advisory_slot_bypass_high`,
    // `workers` momentarily unavailable during boot) made the System
    // Health page show that toast on every load.
    //
    // Critical liveness conditions still return 503 so external
    // monitors / probes that read the status code keep working:
    //   - `db`     → DB unreachable (the real liveness signal)
    //   - `tables` → required app tables missing (broken migration)
    // Everything else is surfaced in the response body via
    // `status: "degraded"` + `degraded: [...]` but does not flip the
    // HTTP status code. This is independent of, and does not change,
    // the Task #992 canonical-status semantics that drive
    // `/api/health/overview` (`currentStatus`).
    const CRITICAL_DEGRADATIONS = new Set(["db", "tables"]);
    const hasCriticalDegradation = degraded.some((d) =>
      CRITICAL_DEGRADATIONS.has(d),
    );
    const overallStatus = degraded.length === 0 ? "healthy" : "degraded";
    const statusCode = hasCriticalDegradation ? 503 : 200;

    // Task #1070 / #1073 / #1074 — reconcile first-seen tracking. Adds
    // new entries with the current timestamp, drops any entry that is
    // no longer degraded so the duration resets when the sub-check
    // recovers, and (when anything changed) persists the snapshot to
    // `system_settings` so the durations survive a server restart. The
    // tracker module wraps the persistent store so the background
    // alert watcher reads from the same map.
    const now = Date.now();
    const sinceMap = await recordDegradedSnapshot(degraded, now);
    const degradedSince: Record<string, number> | undefined =
      degraded.length > 0 ? sinceMap : undefined;

    // Task #1070 — pulse threshold for the dashboard's critical-entry
    // emphasis is operator-tunable via env (`HEALTH_DEGRADED_PULSE_MS`,
    // default 10 minutes). Surfaced in the response so the client picks
    // up changes on the next poll without a rebuild.
    const pulseEnv = Number(process.env.HEALTH_DEGRADED_PULSE_MS);
    const degradedPulseThresholdMs =
      Number.isFinite(pulseEnv) && pulseEnv > 0 ? pulseEnv : 10 * 60 * 1000;

    res.status(statusCode).json({
      status: overallStatus,
      uptimeMs,
      timestamp: new Date().toISOString(),
      degraded: degraded.length > 0 ? degraded : undefined,
      degradedSince,
      degradedPulseThresholdMs,
      checks,
      rateLimits,
    });
  });

  void withDbAttribution("startup:bootstrap", () =>
  db.execute(sql`
    CREATE TABLE IF NOT EXISTS health_samples (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      timestamp BIGINT NOT NULL,
      status VARCHAR(20) NOT NULL,
      db_connected BOOLEAN NOT NULL,
      db_latency_ms INTEGER,
      alerts JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `).then(() => db.execute(sql`CREATE INDEX IF NOT EXISTS idx_health_samples_timestamp ON health_samples (timestamp)`))
    .then(() => db.execute(sql`ALTER TABLE health_samples ADD COLUMN IF NOT EXISTS manual_reserve JSONB`))
    // Task #813: separated DB latency / pool wait / transient recovery metrics.
    .then(() => db.execute(sql`ALTER TABLE health_samples ADD COLUMN IF NOT EXISTS db_round_trip_ms INTEGER`))
    .then(() => db.execute(sql`ALTER TABLE health_samples ADD COLUMN IF NOT EXISTS api_pool_wait_ms INTEGER`))
    .then(() => db.execute(sql`ALTER TABLE health_samples ADD COLUMN IF NOT EXISTS transient_db_recoveries INTEGER`))
    .then(() => db.execute(sql`
      CREATE TABLE IF NOT EXISTS manual_reserve_worker_samples (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        worker VARCHAR(128) NOT NULL,
        workload_class VARCHAR(64) NOT NULL,
        manual_acquires INTEGER NOT NULL DEFAULT 0,
        manual_delayed_by_background_count INTEGER NOT NULL DEFAULT 0,
        manual_timeout_count INTEGER NOT NULL DEFAULT 0,
        manual_wait_avg_ms INTEGER,
        manual_wait_p95_ms INTEGER
      )
    `))
    .then(() => db.execute(sql`CREATE INDEX IF NOT EXISTS idx_manual_reserve_worker_samples_timestamp ON manual_reserve_worker_samples (timestamp)`))
    .then(() => db.execute(sql`CREATE INDEX IF NOT EXISTS idx_manual_reserve_worker_samples_worker_ts ON manual_reserve_worker_samples (worker, timestamp)`))
    .then(() => db.execute(sql`
      CREATE TABLE IF NOT EXISTS manual_reserve_alert_dispatches (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        event_type VARCHAR(24) NOT NULL DEFAULT 'alert',
        metric VARCHAR(128) NOT NULL,
        severity VARCHAR(16) NOT NULL,
        message TEXT NOT NULL,
        value INTEGER NOT NULL DEFAULT 0,
        threshold INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(24) NOT NULL,
        detail TEXT,
        muted_by VARCHAR(128),
        mute_reason TEXT
      )
    `))
    .then(() => db.execute(sql`CREATE INDEX IF NOT EXISTS idx_manual_reserve_alert_dispatches_ts ON manual_reserve_alert_dispatches (timestamp)`))
    .then(() => db.execute(sql`CREATE INDEX IF NOT EXISTS idx_manual_reserve_alert_dispatches_event_ts ON manual_reserve_alert_dispatches (event_type, timestamp)`))
    // Task #861 Phase 1: persist probe-pool connect cost as a first-class column.
    .then(() => db.execute(sql`ALTER TABLE health_samples ADD COLUMN IF NOT EXISTS db_probe_connect_ms INTEGER`))
    // Task #861 Phase 4: pool state attribution snapshots.
    .then(() => db.execute(sql`
      CREATE TABLE IF NOT EXISTS pool_state_samples (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        sampled_at BIGINT NOT NULL,
        pool_name VARCHAR(32) NOT NULL,
        total_count INTEGER NOT NULL DEFAULT 0,
        idle_count INTEGER NOT NULL DEFAULT 0,
        waiting_count INTEGER NOT NULL DEFAULT 0,
        max_count INTEGER NOT NULL DEFAULT 0,
        utilization_pct INTEGER NOT NULL DEFAULT 0,
        slow_acquires_in_interval INTEGER NOT NULL DEFAULT 0,
        slow_holds_in_interval INTEGER NOT NULL DEFAULT 0,
        top_hold_labels JSONB NOT NULL DEFAULT '[]'::jsonb,
        unknown_label_pct INTEGER NOT NULL DEFAULT 0
      )
    `))
    .then(() => db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pool_state_samples_sampled_at ON pool_state_samples (sampled_at)`))
    .then(() => db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pool_state_samples_pool_ts ON pool_state_samples (pool_name, sampled_at)`))
    // Task #861 Phase 3: incident grouping.
    .then(() => db.execute(sql`
      CREATE TABLE IF NOT EXISTS health_incidents (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        fingerprint VARCHAR(256) NOT NULL,
        metric VARCHAR(128) NOT NULL,
        severity VARCHAR(16) NOT NULL,
        title TEXT NOT NULL,
        first_seen_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        peak_value INTEGER NOT NULL DEFAULT 0,
        latest_value INTEGER NOT NULL DEFAULT 0,
        threshold INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'firing',
        acknowledged_by VARCHAR(128),
        acknowledged_at BIGINT,
        snoozed_until BIGINT,
        resolved_at BIGINT,
        sample_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `))
    .then(() => db.execute(sql`CREATE INDEX IF NOT EXISTS idx_health_incidents_fingerprint ON health_incidents (fingerprint)`))
    .then(() => db.execute(sql`CREATE INDEX IF NOT EXISTS idx_health_incidents_status_last_seen ON health_incidents (status, last_seen_at)`))
    .then(() => db.execute(sql`CREATE INDEX IF NOT EXISTS idx_health_incidents_metric_last_seen ON health_incidents (metric, last_seen_at)`))
    // Task #861 Phase 8: daily rollups.
    .then(() => db.execute(sql`
      CREATE TABLE IF NOT EXISTS health_daily_rollups (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        metric VARCHAR(64) NOT NULL,
        date VARCHAR(10) NOT NULL,
        sample_count INTEGER NOT NULL DEFAULT 0,
        ok_count INTEGER NOT NULL DEFAULT 0,
        degraded_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        p50 INTEGER,
        p95 INTEGER,
        p99 INTEGER,
        min_val INTEGER,
        max_val INTEGER,
        avg_val INTEGER,
        alert_count INTEGER NOT NULL DEFAULT 0,
        incident_count INTEGER NOT NULL DEFAULT 0,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `))
    .then(() => db.execute(sql`CREATE INDEX IF NOT EXISTS idx_health_daily_rollups_metric_date ON health_daily_rollups (metric, date)`))
    .then(() => db.execute(sql`CREATE INDEX IF NOT EXISTS idx_health_daily_rollups_date ON health_daily_rollups (date)`))
    .then(() => startHealthSampler())
    .then(() => withDbAttribution("startup:bootstrap-workers", async () => {
      // Task #861 Phase 4/8/9: start the new background workers after the
      // tables are created. Wrapped in a chained .then so they always
      // start *after* the schema bootstrap, never racing with column adds.
      try {
        const { startPoolStateSampler } = await import("../../services/poolStateSampler");
        startPoolStateSampler();
      } catch (err: any) {
        console.warn("[PoolStateSampler] start failed:", err?.message || err);
      }
      // Task #915 (913B): start the supervised-sampler watchdog *after* the
      // sampler loops have registered themselves. Probes are registered on
      // each loop, so the watchdog only needs to drive its own tick.
      try {
        const { startSamplerWatchdog } = await import("../../services/supervisedSampler");
        startSamplerWatchdog(60_000);
      } catch (err: any) {
        console.warn("[SamplerWatchdog] start failed:", err?.message || err);
      }
      // 913D: periodic incident auto-resolver. Fires an immediate sweep on
      // boot so any incidents stuck `firing` from before the lifecycle
      // engine existed are resolved as part of rollout.
      try {
        const { startIncidentAutoResolver } = await import("../../services/healthIncidents");
        startIncidentAutoResolver(60_000);
      } catch (err: any) {
        console.warn("[IncidentAutoResolver] start failed:", err?.message || err);
      }
      try {
        const { startHealthRollups } = await import("../../services/healthRollups");
        startHealthRollups();
      } catch (err: any) {
        console.warn("[HealthRollups] start failed:", err?.message || err);
      }
      try {
        const { startHealthSlackDigestScheduler } = await import("../../services/healthSlackDigest");
        startHealthSlackDigestScheduler();
      } catch (err: any) {
        console.warn("[HealthDigest] start failed:", err?.message || err);
      }
      try {
        const { startNotificationRetentionScheduler } = await import(
          "../../services/notifications/retentionJob"
        );
        startNotificationRetentionScheduler();
      } catch (err: any) {
        console.warn("[NotificationRetention] start failed:", err?.message || err);
      }
      try {
        const { ensureNotificationTables } = await import(
          "../../storage/notificationsStorage"
        );
        await ensureNotificationTables();
      } catch (err: any) {
        console.warn("[NotificationTables] ensure failed:", err?.message || err);
      }
    }))
    .catch((err) => console.error("[HealthMetrics] Startup failed:", err.message)),
  );

  app.get("/api/health/history", async (_req, res) => {
    try {
      const rawLimit = _req.query.limit ? parseInt(String(_req.query.limit), 10) : undefined;
      const limit = rawLimit && !isNaN(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
      const rawSince = _req.query.since ? parseInt(String(_req.query.since), 10) : undefined;
      const since = rawSince && !isNaN(rawSince) && rawSince > 0 ? rawSince : undefined;

      let history;
      let summary;
      if (since) {
        const persisted = await getPersistedHealthHistory(since);
        const inMemory = getHealthHistory();
        const persistedTimestamps = new Set(persisted.map(s => s.timestamp));
        const unflushed = inMemory.filter(s => s.timestamp >= since && !persistedTimestamps.has(s.timestamp));
        const merged = [...persisted, ...unflushed].sort((a, b) => a.timestamp - b.timestamp);
        history = limit ? merged.slice(-limit) : merged;
        summary = computeSummaryFromSamples(history);
      } else {
        history = getHealthHistory(limit);
        summary = getHealthSummary();
      }
      res.json({ ...summary, samples: history });
    } catch (err: any) {
      console.error("[HealthMetrics] History error:", err.message);
      res.status(500).json({ error: "Failed to fetch health history" });
    }
  });

  app.get("/api/health/manual-reserve/by-worker/history", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const rawSince = req.query.since ? parseInt(String(req.query.since), 10) : undefined;
      const since = rawSince && !isNaN(rawSince) && rawSince > 0
        ? rawSince
        : Date.now() - 6 * 60 * 60 * 1000; // default last 6h

      const persisted = await getPersistedManualReserveWorkerHistory(since);
      const pending = getPendingManualReserveWorkerSamples().filter(
        (p) => p.timestamp >= since,
      );
      const merged = [...persisted, ...pending].sort((a, b) => a.timestamp - b.timestamp);

      const workersSeen = new Set<string>();
      for (const r of merged) workersSeen.add(r.worker);

      res.json({
        since,
        sampleCount: merged.length,
        workers: Array.from(workersSeen).sort(),
        samples: merged,
      });
    } catch (err: any) {
      console.error("[HealthMetrics] per-worker history error:", err?.message || err);
      res.status(500).json({ error: "Failed to fetch per-worker manual reserve history" });
    }
  });

  app.get("/api/health/manual-reserve/by-worker/history/export", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const rawSince = req.query.since ? parseInt(String(req.query.since), 10) : undefined;
      const since = rawSince && !isNaN(rawSince) && rawSince > 0
        ? rawSince
        : Date.now() - 24 * 60 * 60 * 1000; // default last 24h
      const rawUntil = req.query.until ? parseInt(String(req.query.until), 10) : undefined;
      const until = rawUntil && !isNaN(rawUntil) && rawUntil > 0 && rawUntil >= since
        ? rawUntil
        : undefined;
      const rawWorker = req.query.worker;
      const workerValues: string[] = Array.isArray(rawWorker)
        ? rawWorker.map((v) => String(v))
        : rawWorker !== undefined
          ? [String(rawWorker)]
          : [];
      const workerFilters = Array.from(
        new Set(
          workerValues
            .flatMap((v) => v.split(","))
            .map((v) => v.trim())
            .filter((v) => v.length > 0),
        ),
      );
      const workerFilter = workerFilters.length === 1 ? workerFilters[0] : "";
      const format = String(req.query.format ?? "csv").toLowerCase() === "json" ? "json" : "csv";

      const persisted = await getPersistedManualReserveWorkerHistory(since);
      const pending = getPendingManualReserveWorkerSamples().filter((p) => p.timestamp >= since);
      let merged = [...persisted, ...pending].sort((a, b) => a.timestamp - b.timestamp);
      if (until !== undefined) {
        merged = merged.filter((s) => s.timestamp <= until);
      }
      if (workerFilters.length > 0) {
        const allowed = new Set(workerFilters);
        merged = merged.filter((s) => allowed.has(s.worker));
      }

      if (format === "json") {
        const exported = merged.map((s) => ({
          timestamp: s.timestamp,
          timestampIso: new Date(s.timestamp).toISOString(),
          worker: s.worker,
          workloadClass: s.workloadClass,
          manualAcquires: s.manualAcquires,
          manualDelayedByBackgroundCount: s.manualDelayedByBackgroundCount,
          manualTimeoutCount: s.manualTimeoutCount,
          manualWaitAvgMs: s.manualWaitAvgMs ?? null,
          manualWaitP95Ms: s.manualWaitP95Ms ?? null,
        }));
        const fnameJson =
          workerFilters.length === 1
            ? `manual-reserve-by-worker-${workerFilters[0].replace(/[^a-z0-9._-]/gi, "_")}.json`
            : workerFilters.length > 1
              ? "manual-reserve-by-worker-multi.json"
              : "manual-reserve-by-worker.json";
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${fnameJson}"`);
        res.send(JSON.stringify({
          exportedAt: new Date().toISOString(),
          since,
          until: until ?? null,
          worker: workerFilter || null,
          sampleCount: exported.length,
          samples: exported,
        }, null, 2));
        return;
      }

      const escapeCsv = (val: unknown): string => {
        const str = String(val ?? "");
        return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
      };
      const header = [
        "timestamp",
        "timestampIso",
        "worker",
        "workloadClass",
        "manualAcquires",
        "manualDelayedByBackgroundCount",
        "manualTimeoutCount",
        "manualWaitAvgMs",
        "manualWaitP95Ms",
      ].join(",");
      const rows = merged.map((s) =>
        [
          s.timestamp,
          new Date(s.timestamp).toISOString(),
          escapeCsv(s.worker),
          escapeCsv(s.workloadClass),
          s.manualAcquires,
          s.manualDelayedByBackgroundCount,
          s.manualTimeoutCount,
          s.manualWaitAvgMs ?? "",
          s.manualWaitP95Ms ?? "",
        ].join(","),
      );
      const csv = [header, ...rows].join("\n");

      const fname =
        workerFilters.length === 1
          ? `manual-reserve-by-worker-${workerFilters[0].replace(/[^a-z0-9._-]/gi, "_")}.csv`
          : workerFilters.length > 1
            ? "manual-reserve-by-worker-multi.csv"
            : "manual-reserve-by-worker.csv";
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
      res.send(csv);
    } catch (err: any) {
      console.error("[HealthMetrics] per-worker export error:", err?.message || err);
      res.status(500).json({ error: "Failed to export per-worker manual reserve history" });
    }
  });

  app.get("/api/health/history/export", async (req, res) => {
    try {
      const rawSince = req.query.since ? parseInt(String(req.query.since), 10) : undefined;
      const since = rawSince && !isNaN(rawSince) && rawSince > 0 ? rawSince : undefined;
      const format = String(req.query.format ?? "csv").toLowerCase() === "json" ? "json" : "csv";

      const effectiveSince = since ?? (Date.now() - 7 * 24 * 60 * 60 * 1000);
      const persisted = await getPersistedHealthHistory(effectiveSince);
      const inMemory = getHealthHistory();
      const persistedTimestamps = new Set(persisted.map(s => s.timestamp));
      const unflushed = inMemory.filter(s => s.timestamp >= effectiveSince && !persistedTimestamps.has(s.timestamp));
      const samples = [...persisted, ...unflushed].sort((a, b) => a.timestamp - b.timestamp);

      if (format === "json") {
        const exported = samples.map(s => ({
          timestamp: s.timestamp,
          timestampIso: new Date(s.timestamp).toISOString(),
          status: s.status,
          dbConnected: s.dbConnected,
          dbLatencyMs: s.dbLatencyMs,
          // Task #813
          dbRoundTripMs: s.dbRoundTripMs,
          apiPoolWaitMs: s.apiPoolWaitMs,
          transientDbRecoveries: s.transientDbRecoveries,
          // Task #1255
          connectionRecycles: s.connectionRecycles ?? 0,
          alerts: Array.isArray(s.alerts) ? s.alerts : [],
          manualReserve: s.manualReserve ?? null,
        }));
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=\"health-metrics-export.json\"");
        res.send(JSON.stringify({
          exportedAt: new Date().toISOString(),
          since: effectiveSince,
          sampleCount: exported.length,
          samples: exported,
        }, null, 2));
        return;
      }

      const escapeCsv = (val: unknown): string => {
        const str = String(val ?? "");
        return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
      };
      // Task #813: extend CSV with the new separated metrics. Keep
      // dbLatencyMs in place so external consumers don't break.
      const header = "timestamp,timestampIso,status,dbConnected,dbLatencyMs,dbRoundTripMs,apiPoolWaitMs,transientDbRecoveries,connectionRecycles,alertCount,alertSeverities,alertMessages";
      const rows = samples.map(s => {
        const alerts = Array.isArray(s.alerts) ? s.alerts : [];
        const latency = s.dbLatencyMs != null ? s.dbLatencyMs : "";
        const roundTrip = s.dbRoundTripMs != null ? s.dbRoundTripMs : "";
        const poolWait = s.apiPoolWaitMs != null ? s.apiPoolWaitMs : "";
        const recoveries = s.transientDbRecoveries ?? 0;
        // Task #1255
        const recycles = s.connectionRecycles ?? 0;
        const severities = alerts.map((a: any) => a.severity).join("; ");
        const messages = alerts.map((a: any) => `${a.metric}=${a.value} (>=${a.threshold}): ${a.message}`).join(" | ");
        return [
          s.timestamp,
          new Date(s.timestamp).toISOString(),
          s.status,
          s.dbConnected,
          latency,
          roundTrip,
          poolWait,
          recoveries,
          recycles,
          alerts.length,
          escapeCsv(severities),
          escapeCsv(messages),
        ].join(",");
      });
      const csv = [header, ...rows].join("\n");

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=\"health-metrics-export.csv\"");
      res.send(csv);
    } catch (err: any) {
      console.error("[HealthMetrics] Export error:", err.message);
      res.status(500).json({ error: "Failed to export health metrics" });
    }
  });

  app.get("/api/health/thresholds", isAuthenticated, (_req, res) => {
    res.json(getThresholds());
  });

  app.put("/api/health/thresholds", isAuthenticated, requireTeamLead, (req: any, res) => {
    try {
      const updated = updateThresholds(req.body);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/health/thresholds/reset", isAuthenticated, requireTeamLead, (_req: any, res) => {
    res.json(resetThresholds());
  });

  app.get("/api/health/manual-reserve-mute", isAuthenticated, async (_req: any, res) => {
    try {
      const state = await getManualReserveMuteState();
      res.json(state);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to load mute state" });
    }
  });

  app.post("/api/health/manual-reserve-mute", isAuthenticated, requireTeamLead, async (req: any, res) => {
    try {
      const { mutedUntil, reason } = req.body || {};
      if (typeof mutedUntil !== "number" || !Number.isFinite(mutedUntil)) {
        return res.status(400).json({ error: "mutedUntil (ms timestamp) is required" });
      }
      const userId = req.user?.claims?.sub ?? null;
      const state = await setManualReserveMute({
        mutedUntil,
        mutedBy: userId,
        reason: typeof reason === "string" ? reason : null,
      });
      res.json(state);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "Failed to set mute" });
    }
  });

  app.delete("/api/health/manual-reserve-mute", isAuthenticated, requireTeamLead, async (_req: any, res) => {
    try {
      // Snapshot the active mute (if any) BEFORE we clear it so the
      // mute-end Slack recap (Task #1195) has the original mutedAt /
      // mutedBy / reason to summarize. The recap dispatch is best-effort
      // — never block the operator's clear on Slack.
      const before = await getManualReserveMuteState();
      const state = await clearManualReserveMute();
      if (
        before.muted &&
        before.mutedAt !== null &&
        before.mutedUntil !== null &&
        before.source !== null
      ) {
        void notifyManualReserveMuteWindowEnded(
          {
            mutedAt: before.mutedAt,
            mutedUntil: before.mutedUntil,
            mutedBy: before.mutedBy,
            reason: before.reason,
            source: before.source,
            jobId: before.jobId,
            jobLabel: before.jobLabel,
          },
          "cleared_manual",
        ).catch((err) =>
          console.warn(
            "[manual-reserve-mute] manual-clear recap dispatch failed:",
            err?.message || err,
          ),
        );
      }
      res.json(state);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to clear mute" });
    }
  });

  app.get("/api/health/flush-status", isAuthenticated, (_req: any, res) => {
    res.json(getFlushStatus());
  });

  // Task #836 Phase 8: dashboard data for DB hold attribution, pool
  // pressure, kill switches, and background concurrency. Feeds the
  // Health dashboard panels added by the same task.
  app.get("/api/health/db-attribution", isAuthenticated, async (_req: any, res) => {
    try {
      const dbModule = await import("../../db");
      const wlModule = await import("../../services/workloadManager");
      // Task #836 Phase 8: `getTopDbHoldLabels` returns
      // `{ byCount, byMaxMs, byTotalMs, unknownPct }` — pre-computed
      // over the *full* per-pool stats, not just the top-N. We surface
      // `byCount` to the dashboard and reuse the helper's own
      // `unknownPct` rather than recomputing from the truncated top-N
      // (which would double-count `unknown` against an incomplete
      // sample base).
      const apiTop = dbModule.getTopDbHoldLabels("api", 15);
      const workerTop = dbModule.getTopDbHoldLabels("worker", 15);
      const counters = dbModule.getDbHoldLabelCounters();
      const apiFallbackLabelCount = dbModule.getApiFallbackLabelCount();
      const apiSnapshot = dbModule.getApiPoolSnapshot();
      const workerSnapshot = dbModule.getWorkerPoolSnapshot();
      const pressure = dbModule.isApiPoolUnderPressure();
      // Task #913C: per-pool attribution-quality summary so the
      // dashboard can plot the `unknown` share alongside the top-label
      // tables and prove the contract is being applied.
      const attributionQuality = dbModule.getDbAttributionQuality();
      const concurrency = wlModule.getBackgroundConcurrencySnapshot();
      const killSwitches = wlModule.getKillSwitchStatus();

      // The dashboard expects an `avgMs` per row alongside count/total/max.
      // Compute it once on the way out so the renderer doesn't have to.
      const withAvg = (
        rows: Array<{ label: string; count: number; totalMs: number; maxMs: number }>,
      ) =>
        rows.map((r) => ({
          ...r,
          avgMs: r.count > 0 ? Math.round((r.totalMs / r.count) * 10) / 10 : 0,
        }));

      res.json({
        api: {
          topByCount: withAvg(apiTop.byCount),
          topByTotalMs: withAvg(apiTop.byTotalMs),
          topByMaxMs: withAvg(apiTop.byMaxMs),
          unknownCount: counters.api.unknown,
          unknownPct: apiTop.unknownPct,
          fallbackLabelCount: apiFallbackLabelCount,
          poolSnapshot: apiSnapshot,
        },
        worker: {
          topByCount: withAvg(workerTop.byCount),
          topByTotalMs: withAvg(workerTop.byTotalMs),
          topByMaxMs: withAvg(workerTop.byMaxMs),
          unknownCount: counters.worker.unknown,
          unknownPct: workerTop.unknownPct,
          poolSnapshot: workerSnapshot,
        },
        pressure,
        concurrency,
        killSwitches,
        attributionQuality,
      });
    } catch (err: any) {
      console.error("[Health] db-attribution failed:", err?.message ?? err);
      res.status(500).json({ error: "Failed to load DB attribution" });
    }
  });

  // Task #1722 Phase 1.5 — Per-route DB-time observability (incl. p95).
  // Surfaces the in-memory sample buffer kept per attribution label by
  // `recordLabelStat` so operators can answer "which route is holding
  // the API pool the longest at the tail?" without sampling Postgres
  // logs. Read-only and cheap; never resets counters.
  app.get("/api/_internal/db-metrics", isAuthenticated, async (req: any, res) => {
    try {
      const dbModule = await import("../../db");
      const limit = Math.max(1, Math.min(100, parseInt(String(req.query?.limit ?? "25"), 10) || 25));
      const minCount = Math.max(1, parseInt(String(req.query?.minCount ?? "5"), 10) || 5);
      const apiByP95 = dbModule.getLabelTimingsByP95("api", limit, { minCount });
      const workerByP95 = dbModule.getLabelTimingsByP95("worker", limit, { minCount });
      const attributionQuality = dbModule.getDbAttributionQuality();
      res.json({
        generatedAt: new Date().toISOString(),
        minCount,
        api: { byP95: apiByP95, attribution: attributionQuality.api },
        worker: { byP95: workerByP95, attribution: attributionQuality.worker },
      });
    } catch (err: any) {
      console.error("[Health] /api/_internal/db-metrics failed:", err?.message ?? err);
      res.status(500).json({ error: "Failed to load DB metrics" });
    }
  });

  // Task #3816 — App-wide request spine: rolling per-route API latency /
  // error-rate metrics (fed by the access-log finish hook), regression-alert
  // state, and recent persisted 5-min windows. Powers the System Health
  // Console's "API Route Metrics" panel.
  app.get("/api/health/request-metrics", isAuthenticated, async (req: any, res) => {
    try {
      const { getRequestMetricsSummary, getPersistenceInfo, FLUSH_INTERVAL_MS } = await import(
        "../../services/requestMetrics"
      );
      const { getAlertStateSnapshot, CONFIG_SETTING_KEY } = await import(
        "../../services/requestMetricsAlerts"
      );
      const windowMs = Math.max(
        60_000,
        Math.min(3_600_000, parseInt(String(req.query?.windowMs ?? ""), 10) || 15 * 60_000),
      );
      const limit = Math.max(1, Math.min(200, parseInt(String(req.query?.limit ?? "50"), 10) || 50));
      const summary = getRequestMetricsSummary({ windowMs, limit });
      let recentWindows: unknown[] = [];
      if (req.query?.includeHistory === "1") {
        const { getApiRouteStatsWindowsSince } = await import("../../storage/healthMetricsStorage");
        recentWindows = await getApiRouteStatsWindowsSince(Date.now() - 6 * 3_600_000, 400);
      }
      res.json({
        ...summary,
        alerts: { ...getAlertStateSnapshot(), configSettingKey: CONFIG_SETTING_KEY },
        persistence: { ...getPersistenceInfo(), flushIntervalMs: FLUSH_INTERVAL_MS },
        recentWindows,
      });
    } catch (err: any) {
      console.error("[Health] /api/health/request-metrics failed:", err?.message ?? err);
      res.status(500).json({ error: "Failed to load request metrics" });
    }
  });

  // Task #3816 — dev-only synthetic routes proving the request spine end to
  // end: a tunable slow route (access-log line + p95 regression) and an
  // error route (global error middleware + error-rate alert). Never mounted
  // in production.
  if (process.env.NODE_ENV !== "production") {
    const { asyncHandler, HttpError } = await import("../../observability/httpErrors");
    app.get(
      "/api/_internal/obs-demo/slow",
      isAuthenticated,
      asyncHandler(async (req: any, res) => {
        const ms = Math.max(0, Math.min(10_000, parseInt(String(req.query?.ms ?? "2000"), 10) || 2000));
        await new Promise((resolve) => setTimeout(resolve, ms));
        res.json({ ok: true, sleptMs: ms, requestId: (req as any).requestId ?? null });
      }),
    );
    app.get(
      "/api/_internal/obs-demo/error",
      isAuthenticated,
      asyncHandler(async (req: any, _res) => {
        // Yield to the event loop first so the throw exercises the ASYNC
        // rejection path through asyncHandler → global error middleware
        // (a sync throw would be caught by Express itself even without
        // the wrapper, which is not what this demo is for).
        await new Promise((resolve) => setImmediate(resolve));
        if (String(req.query?.kind ?? "") === "http") {
          throw new HttpError(422, "Synthetic taxonomy error (obs-demo)", {
            details: { hint: "thrown via HttpError to exercise the 4xx path" },
          });
        }
        throw new Error("Synthetic uncaught route error (obs-demo)");
      }),
    );
  }
}