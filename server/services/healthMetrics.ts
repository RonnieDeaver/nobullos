// Task #1573 (Audit Track C): the 30s sampler writes through the worker
// pool (`db` is aliased to `workerDb`). `apiPool` and `probePool` are still
// imported separately because this file intentionally samples *their*
// latency by checking out a connection from each — that's the metric, not
// a misuse.
// @periodic-request-pool-exception: apiPool is imported to SAMPLE its counters — request-pool pressure metrics ARE the product here (audits/C-db-performance-findings.md P3d), never queries on it; all row writes go through workerDb (aliased db).
import { workerDb as db, apiPool, probePool, dbRetry, getTransientDbRecoveriesCount, getConnectionRecycleCount, withDbAttribution } from "../db";
import { sql } from "drizzle-orm";
import * as healthStore from "../storage/healthMetricsStorage";
import type {
  InsertHealthSample,
  InsertManualReserveWorkerSample,
  ManualReserveWorkerSampleRecord,
} from "@shared/schema";
import { getWorkloadOriginMetrics } from "./workloadManager";
import {
  deliverManualReserveAlerts,
  recordManualReserveTransition,
  pruneOldManualReserveAlertDispatches,
  pollManualReserveMuteEnd,
} from "./manualReserveAlerts";
import {
  startSupervisedSampler,
  stopSupervisedSampler,
} from "./supervisedSampler";

export interface ManualReserveWorkerSamplePoint {
  timestamp: number;
  worker: string;
  workloadClass: string;
  manualAcquires: number;
  manualDelayedByBackgroundCount: number;
  manualTimeoutCount: number;
  manualWaitAvgMs: number | null;
  manualWaitP95Ms: number | null;
}

interface PendingWorkerSample extends ManualReserveWorkerSamplePoint {}

const pendingWorkerSamples: PendingWorkerSample[] = [];
const MAX_PENDING_WORKER_SAMPLES = 5000;

export interface ManualReserveSnapshot {
  manualAcquires: number;
  manualDelayedByBackgroundCount: number;
  manualTimeoutCount: number;
  backgroundIngestionSaturationCount: number;
  manualWaitAvgMs: number | null;
  manualWaitP95Ms: number | null;
}

export interface HealthSample {
  timestamp: number;
  status: "ok" | "degraded" | "error";
  dbConnected: boolean;
  // Backwards-compatible alias for `dbRoundTripMs`. Older clients/exports
  // continue to read this field; new clients should prefer `dbRoundTripMs`.
  dbLatencyMs: number | null;
  // Task #813
  // True DB round-trip on the dedicated probe pool (max=1, isolated from
  // API/worker traffic). `dbLatencyMs` mirrors this value for compatibility.
  dbRoundTripMs: number | null;
  // Time spent waiting to acquire a connection from the main API pool. Rises
  // when the API pool is saturated by request traffic; does NOT mean the DB
  // itself is slow.
  apiPoolWaitMs: number | null;
  // Task #818 Phase 0: split the probe-pool acquire/connect cost out of the
  // wire round-trip. The probe pool is min=1, idleTimeoutMillis=0 so this
  // is normally ~0ms — when it is not, that means we paid for a fresh
  // handshake (Neon recycled a connection, etc.) and the gap between
  // `dbProbeConnectMs` and `dbRoundTripMs` is connect/handshake overhead,
  // not DB-side query latency. Lets the dashboard distinguish "DB is
  // slow" from "we just had to reconnect".
  dbProbeConnectMs: number | null;
  // Per-sample delta of transient DB errors that `dbRetry` recovered from
  // (e.g. Neon recycling a connection). Only counts recovered failures —
  // unrecovered ones still flow through the normal failure path.
  transientDbRecoveries: number;
  // Task #1255: per-sample delta of proactive DB connection recycles
  // performed by the Task #815 lifetime policy. Counts idle-sweep evictions
  // and on-release evictions of connections that lived past the configured
  // `DB_CONN_MAX_LIFETIME_MS`. Surfaced on the Health dashboard so
  // operators can confirm the recycle policy is firing without grepping
  // workflow logs. In-memory only (not persisted) — the underlying
  // counter is a process-level value that resets on restart.
  connectionRecycles: number;
  alerts: Alert[];
  manualReserve: ManualReserveSnapshot | null;
}

export interface Alert {
  metric: string;
  value: number;
  threshold: number;
  severity: "warning" | "critical";
  message: string;
}

export interface ThresholdConfig {
  dbLatencyWarningMs: number;
  dbLatencyCriticalMs: number;
  consecutiveFailuresWarning: number;
  consecutiveFailuresCritical: number;
  manualTimeoutWindowWarning: number;
  manualTimeoutWindowCritical: number;
  manualWaitP95WarningMs: number;
  manualWaitP95CriticalMs: number;
  backgroundIngestionSaturationWindowWarning: number;
  backgroundIngestionSaturationWindowCritical: number;
  manualDelayedByBackgroundWindowWarning: number;
  manualDelayedByBackgroundWindowCritical: number;
  perEntryPointManualTimeoutWindowWarning: number;
  perEntryPointManualTimeoutWindowCritical: number;
  perEntryPointManualDelayedByBackgroundWindowWarning: number;
  perEntryPointManualDelayedByBackgroundWindowCritical: number;
  /**
   * Number of sampler ticks (30s each) over which counter-delta alerts are
   * evaluated. Tunable via the admin UI (#712) so admins can widen or narrow
   * the reserve-pressure window without changing thresholds.
   */
  manualReserveWindowSamples: number;
  /**
   * Task #1261 — windowed alert on the dashboard's `apiPoolWaitMs` signal.
   * The API pool is shared by every request handler, so sustained high acquire
   * waits mean users are about to feel slow responses. The alert fires only
   * when *every* sample in the most recent `apiPoolWaitWindowSamples` window
   * is at or above the threshold, so a single noisy spike does not page.
   */
  apiPoolWaitWarningMs: number;
  apiPoolWaitCriticalMs: number;
  apiPoolWaitWindowSamples: number;
}

const DEFAULT_THRESHOLDS: ThresholdConfig = {
  dbLatencyWarningMs: 200,
  dbLatencyCriticalMs: 1000,
  consecutiveFailuresWarning: 2,
  consecutiveFailuresCritical: 5,
  manualTimeoutWindowWarning: 1,
  manualTimeoutWindowCritical: 5,
  manualWaitP95WarningMs: 5_000,
  manualWaitP95CriticalMs: 20_000,
  backgroundIngestionSaturationWindowWarning: 5,
  backgroundIngestionSaturationWindowCritical: 20,
  manualDelayedByBackgroundWindowWarning: 3,
  manualDelayedByBackgroundWindowCritical: 10,
  perEntryPointManualTimeoutWindowWarning: 1,
  perEntryPointManualTimeoutWindowCritical: 3,
  perEntryPointManualDelayedByBackgroundWindowWarning: 2,
  perEntryPointManualDelayedByBackgroundWindowCritical: 6,
  manualReserveWindowSamples: 10,
  // Task #1261 — defaults chosen so a single transient saturation spike does
  // not page, but a sustained ~2 minutes (4 ticks * 30s) of acquire waits
  // above the warning floor will. The 250ms warning and 1000ms critical
  // thresholds are well above steady-state idle (~0–5ms) and well below
  // anything users could ignore.
  apiPoolWaitWarningMs: 250,
  apiPoolWaitCriticalMs: 1000,
  apiPoolWaitWindowSamples: 4,
};

const MIN_API_POOL_WAIT_WINDOW_SAMPLES = 2;
const MAX_API_POOL_WAIT_WINDOW_SAMPLES = 120;

// At 30s sampling, 10 samples = ~5 minute rolling window for delta-based
// counter alerts (manualTimeoutCount, backgroundIngestionSaturationCount).
// Default; runtime value is `thresholds.manualReserveWindowSamples` (#712).
const DEFAULT_MANUAL_RESERVE_WINDOW_SAMPLES = 10;
const MIN_MANUAL_RESERVE_WINDOW_SAMPLES = 2;
const MAX_MANUAL_RESERVE_WINDOW_SAMPLES = 120;

function effectiveWindowSamples(): number {
  const v = thresholds.manualReserveWindowSamples;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_MANUAL_RESERVE_WINDOW_SAMPLES;
  return Math.max(
    MIN_MANUAL_RESERVE_WINDOW_SAMPLES,
    Math.min(MAX_MANUAL_RESERVE_WINDOW_SAMPLES, Math.floor(v)),
  );
}

interface OriginCounterSnapshot {
  manualTimeoutCount: number;
  backgroundIngestionSaturationCount: number;
  manualDelayedByBackgroundCount: number;
}

const originCounterHistory: OriginCounterSnapshot[] = [];

// Task #1261 — rolling window of `apiPoolWaitMs` samples so the alert only
// fires after sustained pressure (every sample in the window above the
// threshold) rather than on a single noisy spike. NULL samples (acquire
// failed entirely) reset the window so we never fire on incomplete data.
const apiPoolWaitHistory: number[] = [];

interface PerWorkerCounterSnapshot {
  manualTimeoutCount: number;
  manualDelayedByBackgroundCount: number;
}

const perWorkerCounterHistory: Array<Map<string, PerWorkerCounterSnapshot>> = [];

const MAX_SAMPLES = 360;
const SAMPLE_INTERVAL_MS = 30_000;
const FLUSH_INTERVAL_MS = 5 * 60_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;

let samples: HealthSample[] = [];
let thresholds: ThresholdConfig = { ...DEFAULT_THRESHOLDS };
let consecutiveDbFailures = 0;
let lastManualReserveAlertsFiring = false;
let samplerStarted = false;
let lastFlushedTimestamp = 0;

const HEALTH_SAMPLER_NAME = "health_samples";
const HEALTH_FLUSH_NAME = "health_samples_flush";
const HEALTH_PRUNE_NAME = "health_samples_prune";

type WorkloadOriginMetricsLite = ReturnType<typeof getWorkloadOriginMetrics>;

function evaluateManualReserveAlerts(metrics: WorkloadOriginMetricsLite): Alert[] {
  const alerts: Alert[] = [];

  // p95 manual wait — direct value alert (no windowing required; the wait
  // sample buffer in workloadManager is already a rolling window of the last
  // ~200 manual acquires).
  const p95 = metrics.manualWait.p95Ms;
  if (p95 !== null) {
    if (p95 >= thresholds.manualWaitP95CriticalMs) {
      alerts.push({
        metric: "manual_wait_p95_ms",
        value: p95,
        threshold: thresholds.manualWaitP95CriticalMs,
        severity: "critical",
        message: `Manual sync p95 wait ${p95}ms exceeds critical threshold of ${thresholds.manualWaitP95CriticalMs}ms — background ingestion is starving user-triggered syncs`,
      });
    } else if (p95 >= thresholds.manualWaitP95WarningMs) {
      alerts.push({
        metric: "manual_wait_p95_ms",
        value: p95,
        threshold: thresholds.manualWaitP95WarningMs,
        severity: "warning",
        message: `Manual sync p95 wait ${p95}ms exceeds warning threshold of ${thresholds.manualWaitP95WarningMs}ms`,
      });
    }
  }

  // Window-delta alerts on cumulative counters.
  originCounterHistory.push({
    manualTimeoutCount: metrics.manualTimeoutCount,
    backgroundIngestionSaturationCount: metrics.backgroundIngestionSaturationCount,
    manualDelayedByBackgroundCount: metrics.manualDelayedByBackgroundCount,
  });
  const windowCap = effectiveWindowSamples();
  while (originCounterHistory.length > windowCap) {
    originCounterHistory.shift();
  }
  if (originCounterHistory.length >= 2) {
    const oldest = originCounterHistory[0];
    const current = originCounterHistory[originCounterHistory.length - 1];
    const timeoutDelta = Math.max(0, current.manualTimeoutCount - oldest.manualTimeoutCount);
    const saturationDelta = Math.max(
      0,
      current.backgroundIngestionSaturationCount - oldest.backgroundIngestionSaturationCount,
    );
    const delayedDelta = Math.max(
      0,
      current.manualDelayedByBackgroundCount - oldest.manualDelayedByBackgroundCount,
    );
    const windowMin = Math.round((originCounterHistory.length * SAMPLE_INTERVAL_MS) / 60_000);

    if (timeoutDelta >= thresholds.manualTimeoutWindowCritical) {
      alerts.push({
        metric: "manual_timeout_window",
        value: timeoutDelta,
        threshold: thresholds.manualTimeoutWindowCritical,
        severity: "critical",
        message: `${timeoutDelta} manual sync timeouts in last ~${windowMin}min (critical threshold: ${thresholds.manualTimeoutWindowCritical})`,
      });
    } else if (timeoutDelta >= thresholds.manualTimeoutWindowWarning) {
      alerts.push({
        metric: "manual_timeout_window",
        value: timeoutDelta,
        threshold: thresholds.manualTimeoutWindowWarning,
        severity: "warning",
        message: `${timeoutDelta} manual sync timeout(s) in last ~${windowMin}min (warning threshold: ${thresholds.manualTimeoutWindowWarning})`,
      });
    }

    if (delayedDelta >= thresholds.manualDelayedByBackgroundWindowCritical) {
      alerts.push({
        metric: "manual_delayed_by_background_window",
        value: delayedDelta,
        threshold: thresholds.manualDelayedByBackgroundWindowCritical,
        severity: "critical",
        message: `${delayedDelta} manual sync acquires were delayed by background work in last ~${windowMin}min (critical threshold: ${thresholds.manualDelayedByBackgroundWindowCritical})`,
      });
    } else if (delayedDelta >= thresholds.manualDelayedByBackgroundWindowWarning) {
      alerts.push({
        metric: "manual_delayed_by_background_window",
        value: delayedDelta,
        threshold: thresholds.manualDelayedByBackgroundWindowWarning,
        severity: "warning",
        message: `${delayedDelta} manual sync acquire(s) delayed by background work in last ~${windowMin}min (warning threshold: ${thresholds.manualDelayedByBackgroundWindowWarning})`,
      });
    }

    if (saturationDelta >= thresholds.backgroundIngestionSaturationWindowCritical) {
      alerts.push({
        metric: "background_ingestion_saturation_window",
        value: saturationDelta,
        threshold: thresholds.backgroundIngestionSaturationWindowCritical,
        severity: "critical",
        message: `Background ingestion held the manual reserve line ${saturationDelta} times in last ~${windowMin}min (critical threshold: ${thresholds.backgroundIngestionSaturationWindowCritical})`,
      });
    } else if (saturationDelta >= thresholds.backgroundIngestionSaturationWindowWarning) {
      alerts.push({
        metric: "background_ingestion_saturation_window",
        value: saturationDelta,
        threshold: thresholds.backgroundIngestionSaturationWindowWarning,
        severity: "warning",
        message: `Background ingestion held the manual reserve line ${saturationDelta} times in last ~${windowMin}min (warning threshold: ${thresholds.backgroundIngestionSaturationWindowWarning})`,
      });
    }
  }

  return alerts;
}

function evaluatePerEntryPointManualReserveAlerts(metrics: WorkloadOriginMetricsLite): Alert[] {
  const alerts: Alert[] = [];

  const byWorker = metrics.byWorker ?? [];
  const snapshot = new Map<string, PerWorkerCounterSnapshot>();
  for (const w of byWorker) {
    snapshot.set(w.worker, {
      manualTimeoutCount: w.manualTimeoutCount,
      manualDelayedByBackgroundCount: w.manualDelayedByBackgroundCount,
    });
  }
  perWorkerCounterHistory.push(snapshot);
  const workerWindowCap = effectiveWindowSamples();
  while (perWorkerCounterHistory.length > workerWindowCap) {
    perWorkerCounterHistory.shift();
  }
  if (perWorkerCounterHistory.length < 2) return alerts;

  const oldest = perWorkerCounterHistory[0];
  const windowMin = Math.round((perWorkerCounterHistory.length * SAMPLE_INTERVAL_MS) / 60_000);

  for (const w of byWorker) {
    const old = oldest.get(w.worker) ?? {
      manualTimeoutCount: 0,
      manualDelayedByBackgroundCount: 0,
    };
    const timeoutDelta = Math.max(0, w.manualTimeoutCount - old.manualTimeoutCount);
    const delayedDelta = Math.max(
      0,
      w.manualDelayedByBackgroundCount - old.manualDelayedByBackgroundCount,
    );
    const avg = w.manualWait.avgMs;
    const p95 = w.manualWait.p95Ms;
    const waitSuffix =
      avg !== null || p95 !== null
        ? ` (avg ${avg ?? "n/a"}ms, p95 ${p95 ?? "n/a"}ms)`
        : "";

    if (timeoutDelta >= thresholds.perEntryPointManualTimeoutWindowCritical) {
      alerts.push({
        metric: `manual_entrypoint_timeout_window:${w.worker}`,
        value: timeoutDelta,
        threshold: thresholds.perEntryPointManualTimeoutWindowCritical,
        severity: "critical",
        message: `Entry point '${w.worker}' had ${timeoutDelta} manual sync timeout(s) in last ~${windowMin}min${waitSuffix} (critical threshold: ${thresholds.perEntryPointManualTimeoutWindowCritical})`,
      });
    } else if (timeoutDelta >= thresholds.perEntryPointManualTimeoutWindowWarning) {
      alerts.push({
        metric: `manual_entrypoint_timeout_window:${w.worker}`,
        value: timeoutDelta,
        threshold: thresholds.perEntryPointManualTimeoutWindowWarning,
        severity: "warning",
        message: `Entry point '${w.worker}' had ${timeoutDelta} manual sync timeout(s) in last ~${windowMin}min${waitSuffix} (warning threshold: ${thresholds.perEntryPointManualTimeoutWindowWarning})`,
      });
    }

    if (delayedDelta >= thresholds.perEntryPointManualDelayedByBackgroundWindowCritical) {
      alerts.push({
        metric: `manual_entrypoint_delayed_window:${w.worker}`,
        value: delayedDelta,
        threshold: thresholds.perEntryPointManualDelayedByBackgroundWindowCritical,
        severity: "critical",
        message: `Entry point '${w.worker}' had ${delayedDelta} manual sync acquire(s) delayed by background work in last ~${windowMin}min${waitSuffix} (critical threshold: ${thresholds.perEntryPointManualDelayedByBackgroundWindowCritical})`,
      });
    } else if (delayedDelta >= thresholds.perEntryPointManualDelayedByBackgroundWindowWarning) {
      alerts.push({
        metric: `manual_entrypoint_delayed_window:${w.worker}`,
        value: delayedDelta,
        threshold: thresholds.perEntryPointManualDelayedByBackgroundWindowWarning,
        severity: "warning",
        message: `Entry point '${w.worker}' had ${delayedDelta} manual sync acquire(s) delayed by background work in last ~${windowMin}min${waitSuffix} (warning threshold: ${thresholds.perEntryPointManualDelayedByBackgroundWindowWarning})`,
      });
    }
  }

  return alerts;
}

function effectiveApiPoolWaitWindow(): number {
  const v = thresholds.apiPoolWaitWindowSamples;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_THRESHOLDS.apiPoolWaitWindowSamples;
  return Math.max(
    MIN_API_POOL_WAIT_WINDOW_SAMPLES,
    Math.min(MAX_API_POOL_WAIT_WINDOW_SAMPLES, Math.floor(v)),
  );
}

/**
 * Task #1261 — windowed alert on `apiPoolWaitMs`.
 *
 * Pushes the current sample onto a rolling history capped at the live
 * `apiPoolWaitWindowSamples`. Once the history is full, the alert fires
 * iff *every* sample in the window is at or above the threshold. This
 * mirrors the cadence of the manual-reserve windowed alerts so a single
 * spike does not page.
 *
 * - NULL samples (acquire failure) clear the history so we never alert
 *   from incomplete data.
 * - The reported `value` is the minimum sample in the window — the worst
 *   *sustained* wait the sampler saw, which is what the threshold is
 *   defined against.
 * - Critical takes precedence over warning when both qualify.
 */
function evaluateApiPoolWaitAlerts(apiPoolWaitMs: number | null): Alert[] {
  const alerts: Alert[] = [];

  if (apiPoolWaitMs === null) {
    // Acquire failed entirely; reset so a future recovery does not falsely
    // count this gap toward a sustained-pressure window.
    apiPoolWaitHistory.length = 0;
    return alerts;
  }

  apiPoolWaitHistory.push(apiPoolWaitMs);
  const cap = effectiveApiPoolWaitWindow();
  while (apiPoolWaitHistory.length > cap) {
    apiPoolWaitHistory.shift();
  }

  // Require a full window before evaluating — otherwise the first slow
  // sample after a restart would page immediately.
  if (apiPoolWaitHistory.length < cap) return alerts;

  const worstSustained = Math.min(...apiPoolWaitHistory);
  const windowSec = Math.round((cap * SAMPLE_INTERVAL_MS) / 1000);
  const windowLabel = windowSec >= 60
    ? `~${Math.round(windowSec / 60)}min`
    : `~${windowSec}s`;

  if (worstSustained >= thresholds.apiPoolWaitCriticalMs) {
    alerts.push({
      metric: "api_pool_wait",
      value: worstSustained,
      threshold: thresholds.apiPoolWaitCriticalMs,
      severity: "critical",
      message:
        `API DB pool acquire wait ≥${worstSustained}ms across ${cap} consecutive samples ` +
        `(${windowLabel}) — pool is sustained-saturated (critical threshold ${thresholds.apiPoolWaitCriticalMs}ms)`,
    });
  } else if (worstSustained >= thresholds.apiPoolWaitWarningMs) {
    alerts.push({
      metric: "api_pool_wait",
      value: worstSustained,
      threshold: thresholds.apiPoolWaitWarningMs,
      severity: "warning",
      message:
        `API DB pool acquire wait ≥${worstSustained}ms across ${cap} consecutive samples ` +
        `(${windowLabel}) — pool nearing saturation (warning threshold ${thresholds.apiPoolWaitWarningMs}ms)`,
    });
  }

  return alerts;
}

function evaluateAlerts(dbConnected: boolean, dbLatencyMs: number | null): Alert[] {
  const alerts: Alert[] = [];

  if (!dbConnected) {
    consecutiveDbFailures++;
  } else {
    consecutiveDbFailures = 0;
  }

  if (dbLatencyMs !== null && dbLatencyMs > thresholds.dbLatencyCriticalMs) {
    alerts.push({
      metric: "db_latency",
      value: dbLatencyMs,
      threshold: thresholds.dbLatencyCriticalMs,
      severity: "critical",
      message: `DB latency ${dbLatencyMs}ms exceeds critical threshold of ${thresholds.dbLatencyCriticalMs}ms`,
    });
  } else if (dbLatencyMs !== null && dbLatencyMs > thresholds.dbLatencyWarningMs) {
    alerts.push({
      metric: "db_latency",
      value: dbLatencyMs,
      threshold: thresholds.dbLatencyWarningMs,
      severity: "warning",
      message: `DB latency ${dbLatencyMs}ms exceeds warning threshold of ${thresholds.dbLatencyWarningMs}ms`,
    });
  }

  if (consecutiveDbFailures >= thresholds.consecutiveFailuresCritical) {
    alerts.push({
      metric: "consecutive_db_failures",
      value: consecutiveDbFailures,
      threshold: thresholds.consecutiveFailuresCritical,
      severity: "critical",
      message: `${consecutiveDbFailures} consecutive DB failures (critical threshold: ${thresholds.consecutiveFailuresCritical})`,
    });
  } else if (consecutiveDbFailures >= thresholds.consecutiveFailuresWarning) {
    alerts.push({
      metric: "consecutive_db_failures",
      value: consecutiveDbFailures,
      threshold: thresholds.consecutiveFailuresWarning,
      severity: "warning",
      message: `${consecutiveDbFailures} consecutive DB failures (warning threshold: ${thresholds.consecutiveFailuresWarning})`,
    });
  }

  return alerts;
}

function deriveStatus(dbConnected: boolean, alerts: Alert[]): "ok" | "degraded" | "error" {
  if (alerts.some((a) => a.severity === "critical")) return "error";
  if (!dbConnected) return "error";
  if (alerts.some((a) => a.severity === "warning")) return "degraded";
  return "ok";
}

async function captureManualReserve(): Promise<ManualReserveSnapshot | null> {
  try {
    const { getWorkloadOriginMetrics } = await import("./workloadManager");
    const m = getWorkloadOriginMetrics();
    return {
      manualAcquires: m.manualAcquires,
      manualDelayedByBackgroundCount: m.manualDelayedByBackgroundCount,
      manualTimeoutCount: m.manualTimeoutCount,
      backgroundIngestionSaturationCount: m.backgroundIngestionSaturationCount,
      manualWaitAvgMs: m.manualWait.avgMs,
      manualWaitP95Ms: m.manualWait.p95Ms,
    };
  } catch {
    return null;
  }
}

function captureManualReserveWorkerSamples(): void {
  try {
    const m = getWorkloadOriginMetrics();
    const ts = Date.now();
    for (const w of m.byWorker) {
      // Skip workers with zero activity to keep table small.
      if (
        w.manualAcquires === 0 &&
        w.manualDelayedByBackgroundCount === 0 &&
        w.manualTimeoutCount === 0 &&
        w.manualWait.count === 0
      ) {
        continue;
      }
      pendingWorkerSamples.push({
        timestamp: ts,
        worker: w.worker,
        workloadClass: w.workloadClass,
        manualAcquires: w.manualAcquires,
        manualDelayedByBackgroundCount: w.manualDelayedByBackgroundCount,
        manualTimeoutCount: w.manualTimeoutCount,
        manualWaitAvgMs: w.manualWait.avgMs,
        manualWaitP95Ms: w.manualWait.p95Ms,
      });
    }
    if (pendingWorkerSamples.length > MAX_PENDING_WORKER_SAMPLES) {
      pendingWorkerSamples.splice(0, pendingWorkerSamples.length - MAX_PENDING_WORKER_SAMPLES);
    }
  } catch (err: any) {
    console.error("[HealthMetrics] per-worker sample capture failed:", err?.message || err);
  }
}

async function flushManualReserveWorkerSamples(): Promise<number> {
  if (pendingWorkerSamples.length === 0) return 0;
  const batch = pendingWorkerSamples.splice(0, pendingWorkerSamples.length);
  try {
    const records: InsertManualReserveWorkerSample[] = batch.map((s) => ({
      timestamp: s.timestamp,
      worker: s.worker,
      workloadClass: s.workloadClass,
      manualAcquires: s.manualAcquires,
      manualDelayedByBackgroundCount: s.manualDelayedByBackgroundCount,
      manualTimeoutCount: s.manualTimeoutCount,
      manualWaitAvgMs: s.manualWaitAvgMs ?? undefined,
      manualWaitP95Ms: s.manualWaitP95Ms ?? undefined,
    }));
    // Task #813: wrap with dbRetry so transient Neon recycles do not lose
    // a batch of per-worker samples; restored batch on hard failure below.
    await dbRetry(
      () => healthStore.insertManualReserveWorkerSamples(records),
      "healthMetrics.flushPerWorker",
    );
    return records.length;
  } catch (err: any) {
    // Restore on failure so we retry on next flush.
    pendingWorkerSamples.unshift(...batch);
    if (pendingWorkerSamples.length > MAX_PENDING_WORKER_SAMPLES) {
      pendingWorkerSamples.splice(0, pendingWorkerSamples.length - MAX_PENDING_WORKER_SAMPLES);
    }
    console.error("[HealthMetrics] per-worker flush failed:", err?.message || err);
    return 0;
  }
}

async function pruneOldManualReserveWorkerSamples(): Promise<void> {
  try {
    const cutoff = Date.now() - RETENTION_MS;
    // Task #813
    const count = await dbRetry(
      () => healthStore.pruneManualReserveWorkerSamples(cutoff),
      "healthMetrics.prunePerWorker",
    );
    if (count > 0) {
      console.log(`[HealthMetrics] Pruned ${count} per-worker manual-reserve samples older than 7 days`);
    }
  } catch (err: any) {
    console.error("[HealthMetrics] per-worker prune failed:", err?.message || err);
  }
}

export async function getPersistedManualReserveWorkerHistory(
  sinceTimestamp: number,
): Promise<ManualReserveWorkerSamplePoint[]> {
  const rows: ManualReserveWorkerSampleRecord[] = await healthStore.getManualReserveWorkerSamplesSince(sinceTimestamp);
  return rows.map((r) => ({
    timestamp: r.timestamp,
    worker: r.worker,
    workloadClass: r.workloadClass,
    manualAcquires: r.manualAcquires,
    manualDelayedByBackgroundCount: r.manualDelayedByBackgroundCount,
    manualTimeoutCount: r.manualTimeoutCount,
    manualWaitAvgMs: r.manualWaitAvgMs ?? null,
    manualWaitP95Ms: r.manualWaitP95Ms ?? null,
  }));
}

export function getPendingManualReserveWorkerSamples(): ManualReserveWorkerSamplePoint[] {
  return pendingWorkerSamples.slice();
}

// Task #813: track recovery counter as a per-sample delta so the dashboard
// can show "transient recoveries since last sample".
let lastRecoveryCount = 0;
// Task #1255: same delta accounting for the Task #815 connection-recycle
// counter. Initialised lazily on first sample so the very first delta does
// not include recycles that happened before the sampler started.
let lastRecycleCount = 0;
let lastRecycleCountInitialised = false;

async function collectSample(): Promise<HealthSample> {
  let dbConnected = false;
  let dbRoundTripMs: number | null = null;
  let apiPoolWaitMs: number | null = null;
  let dbProbeConnectMs: number | null = null;

  // (1) True DB round-trip on the dedicated probe pool (max=1).
  //     We deliberately time only the SELECT 1 *after* a client has been
  //     acquired, so the metric reflects the wire round-trip itself and
  //     not any acquire/handshake overhead. The probe pool is configured
  //     with min=1 + idleTimeoutMillis=0 (see server/db.ts) and warmed at
  //     boot, so steady-state acquires are effectively free; this slicing
  //     is defense-in-depth so the metric stays clean even on the rare
  //     occasion the single connection has to be re-established.
  //
  //     Task #818 Phase 0: also capture the connect/acquire cost of the
  //     probe pool as a separate metric (`dbProbeConnectMs`). Steady-state
  //     this is ~0ms; a non-zero value isolates handshake overhead from
  //     true wire RTT so we can answer "is the DB slow or did we just
  //     reconnect?" without conflation.
  try {
    const probeAcquireStart = performance.now();
    const client = await probePool.connect();
    dbProbeConnectMs = Math.round(performance.now() - probeAcquireStart);
    try {
      const queryStart = performance.now();
      await client.query("SELECT 1");
      dbRoundTripMs = Math.round(performance.now() - queryStart);
    } finally {
      client.release();
    }
    dbConnected = true;
  } catch (err: any) {
    dbConnected = false;
    console.warn(
      `[HealthMetrics] DB probe failed: ${err?.message?.slice(0, 120) ?? String(err)}`,
    );
  }

  // (2) API pool acquire wait — separate metric. Captures connection-acquire
  //     time on the main API pool so dashboard can show pool saturation
  //     without misattributing it to DB slowness. Acquire failures are not
  //     fatal (they don't change dbConnected); they simply leave the metric
  //     null for this sample.
  try {
    const acquireStart = performance.now();
    const client = await apiPool.connect();
    apiPoolWaitMs = Math.round(performance.now() - acquireStart);
    client.release();
  } catch (err: any) {
    console.warn(
      `[HealthMetrics] API pool acquire failed during sample: ${err?.message?.slice(0, 120) ?? String(err)}`,
    );
  }

  // (3) Transient recovery delta since the previous sample.
  const currentRecoveryCount = getTransientDbRecoveriesCount();
  const transientDbRecoveriesDelta = Math.max(0, currentRecoveryCount - lastRecoveryCount);
  lastRecoveryCount = currentRecoveryCount;

  // (4) Task #1255: connection-recycle delta since the previous sample.
  //     `getConnectionRecycleCount()` is a process-level counter
  //     incremented every time the Task #815 lifetime policy retires a
  //     connection (either via the periodic idle sweep or on release of
  //     an over-aged client). Surface the delta per sample plus a running
  //     range total in the summary so operators can see at a glance that
  //     the recycle policy is firing as expected.
  const currentRecycleCount = getConnectionRecycleCount();
  const connectionRecyclesDelta = lastRecycleCountInitialised
    ? Math.max(0, currentRecycleCount - lastRecycleCount)
    : 0;
  lastRecycleCount = currentRecycleCount;
  lastRecycleCountInitialised = true;

  const dbAlerts = evaluateAlerts(dbConnected, dbRoundTripMs);
  // Task #1261 — windowed alert on sustained API-pool acquire waits. Lives
  // alongside the db-probe alerts so the dashboard shows pool saturation as
  // a first-class alert, not just a chart line.
  const apiPoolAlerts = evaluateApiPoolWaitAlerts(apiPoolWaitMs);
  let manualReserveAlerts: Alert[] = [];
  try {
    const originMetrics = originMetricsProviderForTest
      ? originMetricsProviderForTest()
      : getWorkloadOriginMetrics();
    manualReserveAlerts = [
      ...evaluateManualReserveAlerts(originMetrics),
      ...evaluatePerEntryPointManualReserveAlerts(originMetrics),
    ];
  } catch (err: any) {
    console.error("[HealthMetrics] manual reserve eval failed:", err?.message || err);
  }
  const alerts = [...dbAlerts, ...apiPoolAlerts, ...manualReserveAlerts];
  const status = deriveStatus(dbConnected, alerts);
  const manualReserve = await captureManualReserve();
  captureManualReserveWorkerSamples();

  // Detect alert state transitions for the audit timeline (#737). The mute
  // path still records its own dispatch row when alerts are firing during a
  // mute window; transitions are independent so operators can see when
  // pressure started or cleared regardless of mute state.
  const alertsFiring = manualReserveAlerts.length > 0;
  if (alertsFiring && !lastManualReserveAlertsFiring) {
    const summary = manualReserveAlerts
      .slice(0, 3)
      .map((a) => `${a.metric} (${a.severity})`)
      .join(", ");
    const more = manualReserveAlerts.length > 3 ? ` and ${manualReserveAlerts.length - 3} more` : "";
    recordManualReserveTransition(
      "backed_up",
      `Manual-reserve alert(s) started firing: ${summary}${more}`,
    );
  } else if (!alertsFiring && lastManualReserveAlertsFiring) {
    recordManualReserveTransition(
      "all_clear",
      "All manual-reserve alerts cleared",
    );
  }
  lastManualReserveAlertsFiring = alertsFiring;

  if (alertsFiring) {
    // Mute window check is now handled inside deliverManualReserveAlerts so
    // the suppressed alerts can be audit-recorded with mutedBy/until.
    deliverManualReserveAlerts(manualReserveAlerts).catch((err) =>
      console.error(
        "[HealthMetrics] manual reserve Slack delivery failed:",
        err?.message || err,
      ),
    );
  }

  // Task #1261 — Slack delivery for sustained API-pool-wait pressure. Routes
  // through the same notification type as manual-reserve starvation so admins
  // do not need to configure a second channel, but uses its own per-(metric,
  // severity) cooldown so a paging api_pool_wait alert never blocks a paging
  // manual_reserve alert (and vice versa).
  if (apiPoolAlerts.length > 0) {
    void deliverApiPoolWaitAlerts(apiPoolAlerts).catch((err) =>
      console.error(
        "[HealthMetrics] api pool wait Slack delivery failed:",
        err?.message || err,
      ),
    );
  }

  // Task #1195 — detect natural mute-window expiry and post a Slack recap
  // of what was suppressed. Best-effort; never block sampling on Slack.
  void pollManualReserveMuteEnd().catch((err) =>
    console.warn(
      "[HealthMetrics] manual reserve mute-end poll failed:",
      err?.message || err,
    ),
  );

  // Task #861 Phase 3: ingest every firing alert into the incidents table.
  // Repeated samples of the same fingerprint (`metric:severity:origin`)
  // collapse onto a single open incident instead of producing per-sample
  // noise. Failures here are best-effort; a flaky DB must not stop the
  // sampler from advancing.
  if (alerts.length > 0) {
    void (async () => {
      try {
        const incidents = await import("./healthIncidents");
        for (const alert of alerts) {
          const origin =
            alert.metric === "db_latency" || alert.metric === "consecutive_db_failures"
              ? "probe"
              : alert.metric === "api_pool_wait"
                ? "api_pool"
                : "manual_reserve";
          await incidents.ingestAlert({
            alert: { ...alert, origin, threshold: alert.threshold },
            value: alert.value,
            sampleTimestamp: Date.now(),
          });
        }
      } catch (err: any) {
        console.warn("[HealthMetrics] incident ingest failed:", err?.message || err);
      }
    })();
  }

  const sample: HealthSample = {
    timestamp: Date.now(),
    status,
    dbConnected,
    dbLatencyMs: dbRoundTripMs,
    dbRoundTripMs,
    apiPoolWaitMs,
    // Task #818 Phase 0: probe-pool acquire/connect cost as a separate
    // signal from the wire round-trip. Not persisted (kept in-memory
    // only) to avoid a schema change for an instrumentation metric.
    dbProbeConnectMs,
    transientDbRecoveries: transientDbRecoveriesDelta,
    connectionRecycles: connectionRecyclesDelta,
    alerts,
    manualReserve,
  };

  samples.push(sample);
  if (samples.length > MAX_SAMPLES) {
    samples = samples.slice(samples.length - MAX_SAMPLES);
  }

  if (alerts.length > 0) {
    console.log(
      `[HealthMetrics] ${status.toUpperCase()} — ${alerts.map((a) => a.message).join("; ")}`
    );
  }

  return sample;
}

// Task #1261 — local cooldown for api_pool_wait Slack delivery. Separate from
// the manual-reserve cooldown so the two alert families don't suppress each
// other. 15 min matches the manual-reserve COOLDOWN_MS.
const API_POOL_WAIT_SLACK_COOLDOWN_MS = 15 * 60_000;
const lastApiPoolWaitSentAt = new Map<string, number>();

function apiPoolAlertKey(a: Alert): string {
  return `${a.metric}:${a.severity}`;
}

async function deliverApiPoolWaitAlerts(alerts: Alert[]): Promise<void> {
  if (alerts.length === 0) return;
  const now = Date.now();
  const fresh = alerts.filter((a) => {
    const last = lastApiPoolWaitSentAt.get(apiPoolAlertKey(a)) ?? 0;
    return now - last >= API_POOL_WAIT_SLACK_COOLDOWN_MS;
  });
  if (fresh.length === 0) return;

  const critical = fresh.some((a) => a.severity === "critical");
  const text =
    `API DB pool acquire saturation:\n` +
    fresh.map((a) => `- [${a.severity.toUpperCase()}] ${a.message}`).join("\n");
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          (critical ? ":rotating_light: " : ":warning: ") +
          `*API DB pool sustained-saturation*\n` +
          `Every request handler shares this pool — sustained acquire waits ` +
          `mean users are about to see slow responses.`,
      },
    },
    {
      type: "section",
      fields: fresh.map((a) => ({
        type: "mrkdwn",
        text: `*${a.metric}* (${a.severity})\n${a.value}ms (threshold: ${a.threshold}ms)`,
      })),
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `Tune via the *Alert Thresholds* card on the Health dashboard ` +
          `(\`apiPoolWaitWarningMs\`, \`apiPoolWaitCriticalMs\`, ` +
          `\`apiPoolWaitWindowSamples\`).`,
      },
    },
  ];

  try {
    const { notifyByType } = await import("./notifications/dispatcher");
    const result = await notifyByType(
      "usage.manual_reserve.starvation",
      {
        text,
        blocks,
        preview: fresh.map((a) => ({ metric: a.metric, severity: a.severity })),
      },
      { triggerSource: "alert_service", bypassDedupe: true },
    );
    // Whatever the dispatcher decides (delivered / no channel / disconnected
    // / disabled), respect the cooldown so we don't retry every sampler tick.
    if (
      result.delivered ||
      result.status === "skipped_no_channel" ||
      result.status === "skipped_slack_disconnected" ||
      result.status === "skipped_disabled"
    ) {
      for (const a of fresh) lastApiPoolWaitSentAt.set(apiPoolAlertKey(a), now);
    }
  } catch (err: any) {
    console.warn(
      "[HealthMetrics] api_pool_wait Slack dispatch failed:",
      err?.message || err,
    );
  }
}

export async function flushToDb(options?: { throwOnError?: boolean }): Promise<number> {
  const unflushed = samples.filter((s) => s.timestamp > lastFlushedTimestamp);
  if (unflushed.length === 0) return 0;

  try {
    const records: InsertHealthSample[] = unflushed.map((s) => ({
      timestamp: s.timestamp,
      status: s.status,
      dbConnected: s.dbConnected,
      dbLatencyMs: s.dbLatencyMs ?? undefined,
      dbRoundTripMs: s.dbRoundTripMs ?? undefined,
      apiPoolWaitMs: s.apiPoolWaitMs ?? undefined,
      // Task #861 Phase 1: persist probe-connect cost so post-hoc review
      // can isolate handshake/reconnect cost from wire round-trip cost.
      dbProbeConnectMs: s.dbProbeConnectMs ?? undefined,
      transientDbRecoveries: s.transientDbRecoveries,
      alerts: s.alerts,
      manualReserve: s.manualReserve ?? undefined,
    }));

    // Task #813: wrap flush in dbRetry so a Neon recycle mid-flush is
    // recovered transparently instead of being charged to dbFailures.
    // Insert is the only op so duplicate insertion only happens if the
    // server response was lost after commit — acceptable trade-off for
    // a metrics-only table.
    await dbRetry(
      () => healthStore.insertHealthSamples(records),
      "healthMetrics.flush",
    );
    lastFlushedTimestamp = unflushed[unflushed.length - 1].timestamp;
    console.log(`[HealthMetrics] Flushed ${unflushed.length} samples to DB`);
    return unflushed.length;
  } catch (err: any) {
    // Task #836 Phase 10: healthMetrics.flush is now soft-fail. On a
    // hard failure (transient retries already exhausted by dbRetry),
    // we advance `lastFlushedTimestamp` to the end of the failed
    // batch so the next tick does not re-attempt the same rows on top
    // of the new batch. The trade-off — losing this batch of metrics
    // samples — is preferable to a continuously-growing in-memory
    // queue that retries on every flush interval and amplifies the
    // outage. The retry is implicit: the *next* batch will be flushed
    // normally on the next tick.
    console.error("[HealthMetrics] Flush failed (dropping batch):", err?.message ?? String(err));
    lastFlushedTimestamp = unflushed[unflushed.length - 1].timestamp;
    if (options?.throwOnError) throw err;
    return 0;
  }
}

async function pruneOldSamples(): Promise<void> {
  try {
    const cutoff = Date.now() - RETENTION_MS;
    // Task #813: prune is a periodic worker DB op — wrap with dbRetry so a
    // Neon recycle does not surface as a hard failure / dbFailures bump.
    const count = await dbRetry(
      () => healthStore.pruneHealthSamples(cutoff),
      "healthMetrics.prune",
    );
    if (count > 0) {
      console.log(`[HealthMetrics] Pruned ${count} samples older than 7 days`);
    }
  } catch (err: any) {
    console.error("[HealthMetrics] Prune failed:", err.message);
  }
}

async function seedFromDb(): Promise<void> {
  try {
    const rows = await healthStore.getRecentHealthSamples(MAX_SAMPLES);
    if (rows.length > 0) {
      samples = rows.map((r) => ({
        timestamp: r.timestamp,
        status: r.status as HealthSample["status"],
        dbConnected: r.dbConnected,
        dbLatencyMs: r.dbLatencyMs ?? r.dbRoundTripMs ?? null,
        dbRoundTripMs: r.dbRoundTripMs ?? r.dbLatencyMs ?? null,
        apiPoolWaitMs: r.apiPoolWaitMs ?? null,
        // Task #861 Phase 1: now persisted; older rows backfill as NULL.
        dbProbeConnectMs: r.dbProbeConnectMs ?? null,
        transientDbRecoveries: r.transientDbRecoveries ?? 0,
        // Task #1255: not persisted — always 0 for rows seeded from DB.
        connectionRecycles: 0,
        alerts: (r.alerts ?? []) as Alert[],
        manualReserve: (r.manualReserve ?? null) as ManualReserveSnapshot | null,
      }));
      lastFlushedTimestamp = rows[rows.length - 1].timestamp;
      console.log(`[HealthMetrics] Seeded ${rows.length} samples from DB`);
    }
  } catch (err: any) {
    console.error("[HealthMetrics] Seed from DB failed:", err.message);
  }
}

export async function startHealthSampler(): Promise<void> {
  if (samplerStarted) return;
  samplerStarted = true;

  await seedFromDb();

  // Task #915 (913B): each loop runs under the supervised-sampler runtime so
  // a thrown tick can no longer kill its loop. The watchdog (registered
  // separately in routes.ts) guarantees the writer is observed to be making
  // progress against `health_samples`; if it stalls, an incident fires.
  // Task #913C: wrap each tick body in a `maintenance:` attribution scope
  // so the periodic sampler/flush/prune work is identifiable in the
  // pool-state samples instead of falling through as `unknown`.
  startSupervisedSampler({
    name: HEALTH_SAMPLER_NAME,
    intervalMs: SAMPLE_INTERVAL_MS,
    tick: async () => {
      // collectSample owns its own internal try/catch around the DB probe;
      // anything that escapes (e.g. an internal logic error) bubbles to the
      // supervised-sampler wrapper, which records the failure and re-fires
      // on the next interval rather than killing the loop.
      await withDbAttribution("maintenance:health-metrics-sample", () =>
        collectSample(),
      );
    },
    // Watchdog: heartbeat-driven (Task #992). The previous freshnessProbe
    // read MAX(timestamp) from `health_samples`, but rows only land
    // post-flush (every 5 min), so the probe was systematically stale
    // between flushes and produced false-positive stall incidents that
    // flapped open/closed each flush cycle. The supervised-sampler now
    // observes the in-memory `lastTickSucceededAt` heartbeat directly,
    // which is updated synchronously on every successful tick and
    // therefore gives an accurate view of writer liveness without any
    // flush-window budgeting.
    //
    // The probe is left registered in diagnostic-only mode so the
    // dashboard can still surface the persisted-row freshness for
    // post-mortem; the watchdog decision itself is heartbeat-based.
    freshnessProbe: async () => {
      try {
        return await healthStore.getMaxTimestamp("health_samples", "timestamp");
      } catch {
        return null;
      }
    },
    maxStalenessMs: SAMPLE_INTERVAL_MS * 4,
    tickTimeoutMs: 60_000,
  });

  startSupervisedSampler({
    name: HEALTH_FLUSH_NAME,
    intervalMs: FLUSH_INTERVAL_MS,
    initialDelayMs: FLUSH_INTERVAL_MS,
    tick: async () => {
      await withDbAttribution("maintenance:health-metrics-flush", async () => {
        await flushToDb();
        await flushManualReserveWorkerSamples();
      });
    },
  });

  startSupervisedSampler({
    name: HEALTH_PRUNE_NAME,
    intervalMs: PRUNE_INTERVAL_MS,
    initialDelayMs: 0,
    tick: async () => {
      await withDbAttribution("maintenance:health-metrics-prune", async () => {
        await pruneOldSamples();
        await pruneOldManualReserveWorkerSamples();
        await pruneOldManualReserveAlertDispatches(RETENTION_MS);
      });
    },
  });

  console.log(
    `[HealthMetrics] Sampler started — interval ${SAMPLE_INTERVAL_MS / 1000}s, buffer size ${MAX_SAMPLES}, flush every ${FLUSH_INTERVAL_MS / 60000}min, retain 7 days`
  );
}

export function stopHealthSampler(): void {
  if (!samplerStarted) return;
  samplerStarted = false;
  stopSupervisedSampler(HEALTH_SAMPLER_NAME);
  stopSupervisedSampler(HEALTH_FLUSH_NAME);
  stopSupervisedSampler(HEALTH_PRUNE_NAME);
  flushToDb().catch((err) =>
    console.error("[HealthMetrics] Final flush failed:", err.message)
  );
  flushManualReserveWorkerSamples().catch((err) =>
    console.error("[HealthMetrics] Final per-worker flush failed:", err?.message || err)
  );
}

export function getHealthHistory(limit?: number): HealthSample[] {
  const count = Math.min(limit || MAX_SAMPLES, MAX_SAMPLES);
  return samples.slice(-count);
}

export async function getPersistedHealthHistory(sinceTimestamp: number, limit?: number): Promise<HealthSample[]> {
  const rows = await healthStore.getHealthSamplesSince(sinceTimestamp);
  const mapped: HealthSample[] = rows.map((r) => ({
    timestamp: r.timestamp,
    status: r.status as HealthSample["status"],
    dbConnected: r.dbConnected,
    dbLatencyMs: r.dbLatencyMs ?? r.dbRoundTripMs ?? null,
    dbRoundTripMs: r.dbRoundTripMs ?? r.dbLatencyMs ?? null,
    apiPoolWaitMs: r.apiPoolWaitMs ?? null,
    // Task #861 Phase 1: now persisted; older rows backfill as NULL.
    dbProbeConnectMs: r.dbProbeConnectMs ?? null,
    transientDbRecoveries: r.transientDbRecoveries ?? 0,
    // Task #1255: not persisted — always 0 for rows fetched from DB.
    connectionRecycles: 0,
    alerts: (r.alerts ?? []) as Alert[],
    manualReserve: (r.manualReserve ?? null) as ManualReserveSnapshot | null,
  }));
  if (limit) {
    return mapped.slice(-limit);
  }
  return mapped;
}

export function computeSummaryFromSamples(sampleSet: HealthSample[]) {
  if (sampleSet.length === 0) {
    return { sampleCount: 0, oldestSample: null, newestSample: null, stats: null, currentAlerts: [] };
  }

  const latencies = sampleSet
    .filter((s) => s.dbLatencyMs !== null)
    .map((s) => s.dbLatencyMs!);

  // Task #813: separately summarise pool-wait so the dashboard can display
  // saturation independently of DB round-trip latency.
  const poolWaits = sampleSet
    .filter((s) => s.apiPoolWaitMs !== null && s.apiPoolWaitMs !== undefined)
    .map((s) => s.apiPoolWaitMs!);

  const transientRecoveriesTotal = sampleSet.reduce(
    (sum, s) => sum + (s.transientDbRecoveries ?? 0),
    0,
  );

  // Task #1255: range total for proactive connection recycles. Only in-memory
  // samples contribute non-zero deltas (DB-seeded samples carry 0), so the
  // total reflects recycles observed since the current process started — same
  // semantics operators are used to from `transientDbRecoveriesTotal`.
  const connectionRecyclesTotal = sampleSet.reduce(
    (sum, s) => sum + (s.connectionRecycles ?? 0),
    0,
  );

  const baseStats = latencies.length > 0
    ? {
        avgDbLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
        minDbLatencyMs: Math.min(...latencies),
        maxDbLatencyMs: Math.max(...latencies),
        p95DbLatencyMs: latencies.slice().sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)] ?? null,
        dbFailureCount: sampleSet.filter((s) => !s.dbConnected).length,
        degradedCount: sampleSet.filter((s) => s.status === "degraded").length,
        errorCount: sampleSet.filter((s) => s.status === "error").length,
      }
    : null;

  const poolStats = poolWaits.length > 0
    ? {
        avgApiPoolWaitMs: Math.round(poolWaits.reduce((a, b) => a + b, 0) / poolWaits.length),
        maxApiPoolWaitMs: Math.max(...poolWaits),
        p95ApiPoolWaitMs: poolWaits.slice().sort((a, b) => a - b)[Math.floor(poolWaits.length * 0.95)] ?? null,
      }
    : { avgApiPoolWaitMs: null, maxApiPoolWaitMs: null, p95ApiPoolWaitMs: null };

  const stats = baseStats
    ? {
        ...baseStats,
        ...poolStats,
        transientDbRecoveriesTotal: transientRecoveriesTotal,
        // Task #1255
        connectionRecyclesTotal,
      }
    : null;

  const newest = sampleSet[sampleSet.length - 1];

  return {
    sampleCount: sampleSet.length,
    oldestSample: sampleSet[0].timestamp,
    newestSample: newest.timestamp,
    stats,
    currentAlerts: newest.alerts,
  };
}

export function getHealthSummary() {
  return computeSummaryFromSamples(samples);
}

export function getFlushStatus(): { pendingCount: number; lastFlushedTimestamp: number | null } {
  const pendingCount = samples.filter((s) => s.timestamp > lastFlushedTimestamp).length;
  return {
    pendingCount,
    lastFlushedTimestamp: lastFlushedTimestamp > 0 ? lastFlushedTimestamp : null,
  };
}

export function getThresholds(): ThresholdConfig {
  return { ...thresholds };
}

export function updateThresholds(updates: Partial<ThresholdConfig>): ThresholdConfig {
  const candidate = { ...thresholds };

  if (updates.dbLatencyWarningMs !== undefined) {
    if (typeof updates.dbLatencyWarningMs !== "number" || updates.dbLatencyWarningMs <= 0) {
      throw new Error("dbLatencyWarningMs must be a positive number");
    }
    candidate.dbLatencyWarningMs = updates.dbLatencyWarningMs;
  }
  if (updates.dbLatencyCriticalMs !== undefined) {
    if (typeof updates.dbLatencyCriticalMs !== "number" || updates.dbLatencyCriticalMs <= 0) {
      throw new Error("dbLatencyCriticalMs must be a positive number");
    }
    candidate.dbLatencyCriticalMs = updates.dbLatencyCriticalMs;
  }
  if (updates.consecutiveFailuresWarning !== undefined) {
    if (
      typeof updates.consecutiveFailuresWarning !== "number" ||
      updates.consecutiveFailuresWarning < 1 ||
      !Number.isInteger(updates.consecutiveFailuresWarning)
    ) {
      throw new Error("consecutiveFailuresWarning must be a positive integer");
    }
    candidate.consecutiveFailuresWarning = updates.consecutiveFailuresWarning;
  }
  if (updates.consecutiveFailuresCritical !== undefined) {
    if (
      typeof updates.consecutiveFailuresCritical !== "number" ||
      updates.consecutiveFailuresCritical < 1 ||
      !Number.isInteger(updates.consecutiveFailuresCritical)
    ) {
      throw new Error("consecutiveFailuresCritical must be a positive integer");
    }
    candidate.consecutiveFailuresCritical = updates.consecutiveFailuresCritical;
  }
  type NumericKey =
    | "manualTimeoutWindowWarning"
    | "manualTimeoutWindowCritical"
    | "manualWaitP95WarningMs"
    | "manualWaitP95CriticalMs"
    | "backgroundIngestionSaturationWindowWarning"
    | "backgroundIngestionSaturationWindowCritical"
    | "manualDelayedByBackgroundWindowWarning"
    | "manualDelayedByBackgroundWindowCritical"
    | "perEntryPointManualTimeoutWindowWarning"
    | "perEntryPointManualTimeoutWindowCritical"
    | "perEntryPointManualDelayedByBackgroundWindowWarning"
    | "perEntryPointManualDelayedByBackgroundWindowCritical";

  const assignPositiveInt = (key: NumericKey, value: number | undefined): void => {
    if (value === undefined) return;
    if (typeof value !== "number" || value < 1 || !Number.isInteger(value)) {
      throw new Error(`${key} must be a positive integer`);
    }
    candidate[key] = value;
  };
  const assignPositiveMs = (key: NumericKey, value: number | undefined): void => {
    if (value === undefined) return;
    if (typeof value !== "number" || value <= 0) {
      throw new Error(`${key} must be a positive number`);
    }
    candidate[key] = value;
  };

  assignPositiveInt("manualTimeoutWindowWarning", updates.manualTimeoutWindowWarning);
  assignPositiveInt("manualTimeoutWindowCritical", updates.manualTimeoutWindowCritical);
  assignPositiveInt(
    "backgroundIngestionSaturationWindowWarning",
    updates.backgroundIngestionSaturationWindowWarning,
  );
  assignPositiveInt(
    "backgroundIngestionSaturationWindowCritical",
    updates.backgroundIngestionSaturationWindowCritical,
  );
  assignPositiveMs("manualWaitP95WarningMs", updates.manualWaitP95WarningMs);
  assignPositiveMs("manualWaitP95CriticalMs", updates.manualWaitP95CriticalMs);
  assignPositiveInt(
    "manualDelayedByBackgroundWindowWarning",
    updates.manualDelayedByBackgroundWindowWarning,
  );
  assignPositiveInt(
    "manualDelayedByBackgroundWindowCritical",
    updates.manualDelayedByBackgroundWindowCritical,
  );
  assignPositiveInt(
    "perEntryPointManualTimeoutWindowWarning",
    updates.perEntryPointManualTimeoutWindowWarning,
  );
  assignPositiveInt(
    "perEntryPointManualTimeoutWindowCritical",
    updates.perEntryPointManualTimeoutWindowCritical,
  );
  assignPositiveInt(
    "perEntryPointManualDelayedByBackgroundWindowWarning",
    updates.perEntryPointManualDelayedByBackgroundWindowWarning,
  );
  assignPositiveInt(
    "perEntryPointManualDelayedByBackgroundWindowCritical",
    updates.perEntryPointManualDelayedByBackgroundWindowCritical,
  );

  // Task #1261 — api_pool_wait thresholds (ms gauges) and window (samples).
  if (updates.apiPoolWaitWarningMs !== undefined) {
    if (typeof updates.apiPoolWaitWarningMs !== "number" || updates.apiPoolWaitWarningMs <= 0) {
      throw new Error("apiPoolWaitWarningMs must be a positive number");
    }
    candidate.apiPoolWaitWarningMs = updates.apiPoolWaitWarningMs;
  }
  if (updates.apiPoolWaitCriticalMs !== undefined) {
    if (typeof updates.apiPoolWaitCriticalMs !== "number" || updates.apiPoolWaitCriticalMs <= 0) {
      throw new Error("apiPoolWaitCriticalMs must be a positive number");
    }
    candidate.apiPoolWaitCriticalMs = updates.apiPoolWaitCriticalMs;
  }
  if (updates.apiPoolWaitWindowSamples !== undefined) {
    const w = updates.apiPoolWaitWindowSamples;
    if (typeof w !== "number" || !Number.isInteger(w)) {
      throw new Error("apiPoolWaitWindowSamples must be an integer");
    }
    if (w < MIN_API_POOL_WAIT_WINDOW_SAMPLES || w > MAX_API_POOL_WAIT_WINDOW_SAMPLES) {
      throw new Error(
        `apiPoolWaitWindowSamples must be between ${MIN_API_POOL_WAIT_WINDOW_SAMPLES} and ${MAX_API_POOL_WAIT_WINDOW_SAMPLES}`,
      );
    }
    candidate.apiPoolWaitWindowSamples = w;
  }

  if (updates.manualReserveWindowSamples !== undefined) {
    const w = updates.manualReserveWindowSamples;
    if (typeof w !== "number" || !Number.isInteger(w)) {
      throw new Error("manualReserveWindowSamples must be an integer");
    }
    if (w < MIN_MANUAL_RESERVE_WINDOW_SAMPLES || w > MAX_MANUAL_RESERVE_WINDOW_SAMPLES) {
      throw new Error(
        `manualReserveWindowSamples must be between ${MIN_MANUAL_RESERVE_WINDOW_SAMPLES} and ${MAX_MANUAL_RESERVE_WINDOW_SAMPLES}`,
      );
    }
    candidate.manualReserveWindowSamples = w;
  }

  if (candidate.apiPoolWaitWarningMs >= candidate.apiPoolWaitCriticalMs) {
    throw new Error("apiPoolWaitWarningMs must be less than apiPoolWaitCriticalMs");
  }
  if (candidate.dbLatencyWarningMs >= candidate.dbLatencyCriticalMs) {
    throw new Error("dbLatencyWarningMs must be less than dbLatencyCriticalMs");
  }
  if (candidate.consecutiveFailuresWarning >= candidate.consecutiveFailuresCritical) {
    throw new Error("consecutiveFailuresWarning must be less than consecutiveFailuresCritical");
  }
  if (candidate.manualTimeoutWindowWarning >= candidate.manualTimeoutWindowCritical) {
    throw new Error("manualTimeoutWindowWarning must be less than manualTimeoutWindowCritical");
  }
  if (candidate.manualWaitP95WarningMs >= candidate.manualWaitP95CriticalMs) {
    throw new Error("manualWaitP95WarningMs must be less than manualWaitP95CriticalMs");
  }
  if (
    candidate.backgroundIngestionSaturationWindowWarning >=
    candidate.backgroundIngestionSaturationWindowCritical
  ) {
    throw new Error(
      "backgroundIngestionSaturationWindowWarning must be less than backgroundIngestionSaturationWindowCritical",
    );
  }
  if (
    candidate.manualDelayedByBackgroundWindowWarning >=
    candidate.manualDelayedByBackgroundWindowCritical
  ) {
    throw new Error(
      "manualDelayedByBackgroundWindowWarning must be less than manualDelayedByBackgroundWindowCritical",
    );
  }
  if (
    candidate.perEntryPointManualTimeoutWindowWarning >=
    candidate.perEntryPointManualTimeoutWindowCritical
  ) {
    throw new Error(
      "perEntryPointManualTimeoutWindowWarning must be less than perEntryPointManualTimeoutWindowCritical",
    );
  }
  if (
    candidate.perEntryPointManualDelayedByBackgroundWindowWarning >=
    candidate.perEntryPointManualDelayedByBackgroundWindowCritical
  ) {
    throw new Error(
      "perEntryPointManualDelayedByBackgroundWindowWarning must be less than perEntryPointManualDelayedByBackgroundWindowCritical",
    );
  }

  thresholds = candidate;
  return { ...thresholds };
}

let originMetricsProviderForTest: (() => WorkloadOriginMetricsLite) | null = null;

export function __resetManualReserveWindowForTest(): void {
  originCounterHistory.length = 0;
  perWorkerCounterHistory.length = 0;
  // Task #1261 — also reset the api_pool_wait rolling window so tests that
  // saturate the pool don't carry sample history from prior tests.
  apiPoolWaitHistory.length = 0;
  lastApiPoolWaitSentAt.clear();
}

export function __setOriginMetricsProviderForTest(
  fn: (() => WorkloadOriginMetricsLite) | null,
): void {
  originMetricsProviderForTest = fn;
}

export async function __test_collectSample(): Promise<HealthSample> {
  return collectSample();
}

export function resetThresholds(): ThresholdConfig {
  thresholds = { ...DEFAULT_THRESHOLDS };
  return { ...thresholds };
}
