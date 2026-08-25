// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).

export type ManualReserveSnapshot = {
  manualAcquires: number;
  manualDelayedByBackgroundCount: number;
  manualTimeoutCount: number;
  backgroundIngestionSaturationCount: number;
  manualWaitAvgMs: number | null;
  manualWaitP95Ms: number | null;
};

export type HealthSample = {
  timestamp: number;
  status: "ok" | "degraded" | "error";
  dbConnected: boolean;
  // Backwards-compatible alias of `dbRoundTripMs` (server still emits it).
  dbLatencyMs: number | null;
  // Task #813: separated metrics surfaced from the server.
  dbRoundTripMs: number | null;
  apiPoolWaitMs: number | null;
  transientDbRecoveries: number;
  // Task #1255: per-sample delta of proactive DB connection recycles
  // performed by the Task #815 lifetime policy. Older payloads / DB-seeded
  // samples omit it, so treat it as optional and default to 0 in the UI.
  connectionRecycles?: number;
  alerts: Alert[];
  manualReserve: ManualReserveSnapshot | null;
};

export type Alert = {
  metric: string;
  value: number;
  threshold: number;
  severity: "warning" | "critical";
  message: string;
};

export type ManualReserveAlertDispatch = {
  timestamp: number;
  eventType?: "alert" | "muted" | "backed_up" | "all_clear" | "auto_muted" | "auto_unmuted";
  metric: string;
  severity: "warning" | "critical" | "info";
  message: string;
  value: number;
  threshold: number;
  status: "sent" | "failed" | "not_configured" | "muted" | "transition";
  detail?: string | null;
  mutedBy?: string | null;
  muteReason?: string | null;
  // Task #798 — operator-initiated retries write the actor + source onto the
  // dispatch row so the dashboard can render "Last resend by … at … (source)"
  // inline next to the Resend button.
  triggeredBy?: string | null;
  triggeredByName?: string | null;
  triggerSource?: string | null;
  isResend?: boolean;
};

export type ThresholdConfig = {
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
  manualReserveWindowSamples: number;
  // Task #1261
  apiPoolWaitWarningMs: number;
  apiPoolWaitCriticalMs: number;
  apiPoolWaitWindowSamples: number;
};

export type HealthSnapshot = {
  status: string;
  degraded?: string[];
  // Task #1070 — server tracks first-seen epoch ms per degraded entry so
  // the dashboard can render "degraded for Xm" next to each chip.
  degradedSince?: Record<string, number>;
  // Task #1070 — operator-tunable (env `HEALTH_DEGRADED_PULSE_MS`) pulse
  // threshold for critical entries; falls back to a built-in default.
  degradedPulseThresholdMs?: number;
  checks?: {
    workers?: {
      totalBudget?: number;
      activeSlots?: number;
      classes?: Record<string, { active: number; max: number }>;
      origin?: {
        manualAcquires: number;
        manualDelayedByBackgroundCount: number;
        manualTimeoutCount: number;
        backgroundIngestionSaturationCount: number;
        manualWait: { count: number; avgMs: number | null; maxMs: number | null; p95Ms: number | null };
        byWorker?: Array<{
          worker: string;
          workloadClass: string;
          manualAcquires: number;
          manualDelayedByBackgroundCount: number;
          manualTimeoutCount: number;
          manualWait: { count: number; avgMs: number | null; maxMs: number | null; p95Ms: number | null };
        }>;
      };
      // Task #1075 — per-class advisory-slot bypass instrumentation
      // sourced from `getLocalDominanceSlotMetrics()`. The
      // `advisory_slot_bypass_high` sub-check is computed from
      // `local_dominance_sync.windowBypassRate` (>10% over ≥20 samples).
      advisoryBypass?: {
        local_dominance_sync?: {
          windowSize: number;
          windowSamples: number;
          windowBypassCount: number;
          windowBypassRate: number;
          windowBypassByLabel: Record<string, number>;
          oldestSampleAgeMs: number | null;
          lifetime: {
            acquires: number;
            bypasses: number;
            bypassRate: number;
            bypassByLabel: Record<string, number>;
          };
        };
      };
    };
  };
};

export type ManualReserveWorkerSamplePoint = {
  timestamp: number;
  worker: string;
  workloadClass: string;
  manualAcquires: number;
  manualDelayedByBackgroundCount: number;
  manualTimeoutCount: number;
  manualWaitAvgMs: number | null;
  manualWaitP95Ms: number | null;
};

export type ManualReserveWorkerHistory = {
  since: number;
  sampleCount: number;
  workers: string[];
  samples: ManualReserveWorkerSamplePoint[];
};

export type HealthHistory = {
  sampleCount: number;
  oldestSample: number | null;
  newestSample: number | null;
  stats: {
    avgDbLatencyMs: number;
    minDbLatencyMs: number;
    maxDbLatencyMs: number;
    p95DbLatencyMs: number | null;
    dbFailureCount: number;
    degradedCount: number;
    errorCount: number;
    // Task #813
    avgApiPoolWaitMs?: number | null;
    maxApiPoolWaitMs?: number | null;
    p95ApiPoolWaitMs?: number | null;
    transientDbRecoveriesTotal?: number;
    // Task #1255: range total of proactive connection recycles performed
    // by the Task #815 lifetime policy. Counted from in-memory samples
    // since process start; older deploys may omit the field.
    connectionRecyclesTotal?: number;
  } | null;
  currentAlerts: Alert[];
  samples: HealthSample[];
};
