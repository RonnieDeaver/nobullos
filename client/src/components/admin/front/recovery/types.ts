// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { type LastEditedInfo } from "@/components/LastEditedBadge";
import { type FrontPlanLimitedFallback } from "@shared/frontConsoleMetrics";

export type IntegrationStatus = {
  front: { connected: boolean };
};

// Task #4196 — client mirrors of the recovery/coverage response shapes
// (server: frontHistoricalRecovery.ts RecoveryWindow/CoverageMonth/
// CoverageReport/WindowCheckpoint) so misspelled fields fail `npm run check`
// instead of breaking at runtime in the admin console.
export type RecoveryWindow = {
  label: string;
  afterTimestamp: number;
  beforeTimestamp: number;
};

export type CoverageMonth = {
  month: string;
  frontSyncCount: number;
  rawCommCount: number;
  pipelineEventCount: number;
  totalCoverage: number;
};

export type CoverageReport = {
  months: CoverageMonth[];
  gaps: RecoveryWindow[];
  totalFrontSync: number;
  totalRawComm: number;
  totalPipelineEvents: number;
  earliestRecord: string | null;
  latestRecord: string | null;
  generatedAt: string;
};

export type RecoveryWindowStatus =
  | "pending"
  | "running"
  | "complete"
  | "empty_source"
  | "blocked"
  | "partial"
  | "failed";

export type RecoveryReasonClassification =
  | "transient"
  | "non_transient"
  | "checkpoint_required"
  | "unknown";

export type RetryPressureAlertEntry = {
  at: string;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped"
    | "skipped_no_counters";
  totalRetries: number;
  threshold: number;
  skipReason?: string;
};

export type RecoveryJobWindow = {
  windowLabel: string;
  afterTimestamp: number;
  beforeTimestamp: number;
  status: RecoveryWindowStatus;
  statusReason: string | null;
  scanned: number;
  ingested: number;
  skipped: number;
  errors: string[];
  pages: number;
  lastPageUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  retriesByReason?: Record<string, number>;
  totalRetries?: number;
  tokenRefreshes?: number;
  retryPressureAlerts?: RetryPressureAlertEntry[];
  // Task #989: summary decoration added by summarizeRecoveryJob.
  humanStatusReason?: string;
  statusReasonClassification?: RecoveryReasonClassification;
};

export type RecoveryJobSummary = {
  jobId: string;
  status: string;
  statusReason?: string | null;
  dryRun?: boolean;
  startedAt: string;
  completedAt?: string | null;
  requestedCustomWindows?: RecoveryWindow[] | null;
  totals?: { scanned?: number; ingested?: number; skipped?: number; errors?: number; pages?: number };
  windows?: RecoveryJobWindow[];
  coverageReport?: CoverageReport | null;
  error?: string | null;
  // Task #989: explainability + lineage fields surfaced by summarizeRecoveryJob.
  partialReason?: string;
  humanPartialReason?: string;
  reasonClassification?: "transient" | "non_transient" | "checkpoint_required" | "unknown";
  hasResumableCheckpoint?: boolean;
  canResume?: boolean;
  canManualResume?: boolean;
  autoContinueMaxAttempts?: number;
  continuesJobId?: string;
  continuationType?: "manual" | "auto";
  autoContinueAttempt?: number;
  autoContinueLineageRootJobId?: string;
};
export type RecoveryJobsListResponse = { jobs: RecoveryJobSummary[] };
// Task #4326 — 202 payload from POST /api/integrations/front/historical-recovery/execute
// (server: frontHistoricalRecovery.ts execute route).
export type RecoveryExecuteResponse = { status: string; jobId: string; dryRun: boolean };
// Task #4196 — the live-job panel state: server status payloads always carry
// `startedAt`, but the locally-seeded "running" placeholders (execute/resume
// onSuccess) omit it, so the in-memory snapshot keeps it optional.
export type RecoveryJobSnapshot = Omit<RecoveryJobSummary, "startedAt"> & { startedAt?: string };
export type RecoveryClearResponse = { success: boolean; deleted: number; skipped: number };

export type RecoveryMaxAgeResponse = {
  maxAgeDays: number;
  defaultDays: number;
  minDays: number;
  maxDays: number;
  lastEdited?: LastEditedInfo;
};

export type RecoverySweepStatusResponse = {
  running: boolean;
  inFlight: boolean;
  intervalMs: number;
  lastSweepAt: string | null;
  lastPrunedCount: number;
  lastError: string | null;
  // Task #989: auto-continue branch metrics from the most recent tick.
  lastAutoResumedCount?: number;
  lastSkippedCount?: number;
  lastContinuedJobIds?: string[];
  // Task #1708: paused-by-operator signals (kill-switch / queue-drain pause).
  paused?: boolean;
  pauseReasons?: string[];
};

export type RecoveryAutoContinueResponse = {
  maxAttempts: number;
  defaultAttempts: number;
  minAttempts: number;
  maxAttemptsAllowed: number;
  lastEdited?: LastEditedInfo;
};

export type RecoveryManualSweepEntry = {
  id: string;
  userId: string | null;
  userName: string | null;
  timestamp: string;
  prunedCount: number | null;
  lastError: string | null;
  route: string | null;
  sessionId: string | null;
  actionDetail: string | null;
  metadata: unknown;
};
export type RecoveryManualSweepHistoryResponse = { entries: RecoveryManualSweepEntry[] };

export type RecoveryPruneIntervalResponse = {
  intervalMinutes: number;
  defaultMinutes: number;
  minMinutes: number;
  maxMinutes: number;
  lastEdited?: LastEditedInfo;
};

export type RecoveryRetryAlertResponse = {
  enabled: boolean;
  totalRetriesThreshold: number;
  consecutiveWindowCount: number;
  consecutive5xxFloor: number;
  defaultEnabled: boolean;
  defaultThreshold: number;
  defaultConsecutiveWindowCount: number;
  defaultConsecutive5xxFloor: number;
  minThreshold: number;
  maxThreshold: number;
  minConsecutiveWindowCount: number;
  maxConsecutiveWindowCount: number;
  minConsecutive5xxFloor: number;
  maxConsecutive5xxFloor: number;
  thresholdLastEdited?: LastEditedInfo | null;
  enabledLastEdited?: LastEditedInfo | null;
  consecutiveWindowCountLastEdited?: LastEditedInfo | null;
  consecutive5xxFloorLastEdited?: LastEditedInfo | null;
};

// Task #4196 — client mirror of the GET /api/admin/front/analytics-coverage
// response (server: frontAnalyticsCoverage.ts CoverageSummary/CoverageSummaryMonth).
export type CoverageCompletenessStatus =
  | "covered"
  | "ingest-gap"
  | "apply-gap"
  | "in-progress"
  | "not-measured";

export type AnalyticsCoverageMonth = {
  month: string;
  frontTotalMessages: number;
  fetchedIntoNobull: number;
  appliedIntoNobull: number;
  ingestGap: number;
  applyGap: number;
  fetchedCoveragePct: number;
  appliedCoveragePct: number;
  pulledAt: string | null;
  isFinalizedMonth: boolean;
  frontAnalyticsStatus: string | null;
  frontAnalyticsError: string | null;
  unrecoverable: boolean;
  denominatorSource: string | null;
  denominatorUnit: string | null;
  numeratorUnit: string | null;
  analyticsMessagesInbound: number | null;
  unitsComparable: boolean;
  analyticsPlanLimitedAt: string | null;
  messagesInboundFront: number | null;
  messagesOutboundFront: number | null;
  messagesInboundLocal: number | null;
  messagesOutboundLocal: number | null;
  messagesInboundCoveragePct: number | null;
  messagesOutboundCoveragePct: number | null;
  messagesInboundGap: number | null;
  messagesOutboundGap: number | null;
  directionDataSource: string | null;
  reasonHuman: string | null;
  needsReconnect: boolean;
  completenessStatus: CoverageCompletenessStatus;
  completenessReason: string;
  closedVia: string | null;
  coverageConvergenceAttempts: number;
  deepSearchExhausted: boolean;
  planLimitedFallback: FrontPlanLimitedFallback | null;
  denominatorFloorExcess: number | null;
  denominatorFloorReconciliationNote: string | null;
};

export type AnalyticsCoverageAllTime = {
  frontTotalMessages: number;
  fetchedIntoNobull: number;
  appliedIntoNobull: number;
  ingestGap: number;
  applyGap: number;
  fetchedCoveragePct: number;
  appliedCoveragePct: number;
  totalMonths: number;
  inScopeMonths: number;
  includedMonths: number;
  excludedWrongGrainMonths: number;
  excludedPreFloorMonths: number;
  inScopeCountedMonths: number;
  inScopeExcludedMonths: number;
};

export type AnalyticsCoverageSummary = {
  adoptionDate: string | null;
  allTime: AnalyticsCoverageAllTime;
  byMonth: AnalyticsCoverageMonth[];
  months: AnalyticsCoverageMonth[];
  thresholds: { monthFloorPct: number; dropDeltaPct: number };
  lastRefreshedAt: string | null;
  generatedAt: string;
  triggerGates: {
    refreshEnabled: boolean;
    queuePaused: boolean;
    killSwitchNonCriticalSweeps: boolean;
    blockedReason: string | null;
  };
};

// Task #4196 — client mirror of GET /api/admin/front/auto-closure/status
// (server: frontAutoClosure.ts AutoClosureStatus and friends).
export type AutoClosureMode = "daytime" | "overnight";

export type AutoClosureSkipCounters = {
  unrecoverable: number;
  cooldown: number;
  budget: number;
  in_flight: number;
  threshold: number;
  queue_paused: number;
  auth_failed: number;
  no_work_items: number;
  parked: number;
  // Older persisted summaries lack this key; readers default it to 0.
  dedupe_closed?: number;
};

export type AutoClosureRunSummary = {
  ranAt: string;
  enabled: boolean;
  skippedReason?: string;
  monthsInspected: number;
  errorsRetried: number;
  errorRetrySuccesses: number;
  ingestRecoveriesEnqueued: number;
  applyNudgesEnqueued: number;
  recoveryDailyCounter: number;
  skips: AutoClosureSkipCounters;
  errorsByReason: Record<string, number>;
  lastSelfError: string | null;
  monthsActed: string[];
  mode: AutoClosureMode;
  effectiveBudgets: { retry: number; ingestRecovery: number; applyNudge: number };
};

export type SearchReArmOutcome = {
  kind: "ingested" | "resolved_covered" | "still_empty" | "error";
  ingested?: number;
  at: string;
  source: "auto_escalation" | "operator_rearm";
  detail?: string;
};

export type ParkedWindowEntry = {
  parkedAt: string;
  reason: string;
  deadRuns: number;
  lastCheckpointAt: string | null;
  searchEscalated?: boolean;
  searchEscalatedAt?: string;
  reArmOutcome?: SearchReArmOutcome;
  reArmConsecutiveErrors?: number;
};

export type DeadRunStreakEntry = {
  count: number;
  lastCheckpointAt: string | null;
};

export type SearchEscalationEntry = {
  escalatedAt: string;
  triggeredByCheckpointAt: string | null;
  deadRunsAtEscalation: number;
};

export type ParkEventEntry = {
  at: string;
  month: string;
  type: "parked" | "auto_unparked" | "operator_unparked";
  deadRuns?: number;
};

export type ReArmDrainStatus = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  processed: number;
  totalAtStart: number;
  progress: string;
  error: string | null;
  lastOutcomeKind: string | null;
};

export type AutoClosureStatus = {
  enabled: boolean;
  // Numeric/boolean tuning defaults and current config; the admin panel
  // never reads individual keys, so these stay structurally loose.
  defaults: Record<string, unknown>;
  config: Record<string, unknown>;
  lastSummary: AutoClosureRunSummary | null;
  cooldowns: Record<string, string>;
  recoveryDay: string | null;
  recoveryRunsToday: number;
  currentMode: AutoClosureMode;
  parkedWindows: Record<string, ParkedWindowEntry>;
  deadRunStreak: Record<string, DeadRunStreakEntry>;
  searchEscalations: Record<string, SearchEscalationEntry>;
  parkEvents: ParkEventEntry[];
  reArmDrains: Record<string, ReArmDrainStatus>;
  allReArmDrain: ReArmDrainStatus | null;
};

export type FrontAnalyticsCoverageAlertsResponse = {
  enabled: boolean;
  dropDeltaPct: number;
  monthFloorPct: number;
  completenessAlertsEnabled: boolean;
  floorRaiseAlertsEnabled: boolean;
  floorRaiseRegrowthPct: number;
  defaultEnabled: boolean;
  defaultDropDeltaPct: number;
  defaultMonthFloorPct: number;
  defaultCompletenessAlertsEnabled: boolean;
  defaultFloorRaiseAlertsEnabled: boolean;
  defaultFloorRaiseRegrowthPct: number;
  minDropDeltaPct: number;
  maxDropDeltaPct: number;
  minMonthFloorPct: number;
  maxMonthFloorPct: number;
  minFloorRaiseRegrowthPct: number;
  maxFloorRaiseRegrowthPct: number;
  enabledLastEdited?: LastEditedInfo | null;
  dropDeltaPctLastEdited?: LastEditedInfo | null;
  monthFloorPctLastEdited?: LastEditedInfo | null;
  completenessAlertsEnabledLastEdited?: LastEditedInfo | null;
  floorRaiseAlertsEnabledLastEdited?: LastEditedInfo | null;
  floorRaiseRegrowthPctLastEdited?: LastEditedInfo | null;
};

export type RecoverySettingHistoryEntry = {
  id: string;
  changedBy: string | null;
  changedByName: string | null;
  changedByEmail: string | null;
  oldValues: Record<string, number | null> | null;
  newValues: Record<string, number | null> | null;
  changedAt: string;
};

// Task #4211 — client mirrors for the remaining recovery readouts so a
// misspelled field fails `npm run check` instead of breaking at runtime.

// GET/PUT /api/admin/front/auto-closure/overnight
// (server: frontAutoClosure.ts overnight editor routes).
export type OvernightConfigValues = {
  enabled: boolean;
  timezone: string;
  startHour: number;
  endHour: number;
  retryBudget: number;
  ingestRecoveryBudget: number;
  applyNudgeBudget: number;
};

export type OvernightConfigBounds = {
  hourMin: number;
  hourMax: number;
  retryBudgetMin: number;
  retryBudgetMax: number;
  ingestRecoveryBudgetMin: number;
  ingestRecoveryBudgetMax: number;
  applyNudgeBudgetMin: number;
  applyNudgeBudgetMax: number;
};

export type OvernightConfigResponse = {
  currentMode: AutoClosureMode;
  config: OvernightConfigValues;
  defaults: OvernightConfigValues;
  bounds: OvernightConfigBounds;
  lastEdited: Record<keyof OvernightConfigValues, LastEditedInfo | null>;
};

export type OvernightConfigUpdateResponse = { config: OvernightConfigValues };

// GET /api/admin/front/auto-closure/regression-alert-status
// (server: frontAutoClosureRegressionAlerts.ts RegressionAlertStatus).
export type RegressionCondition =
  | "ingest_growth"
  | "apply_growth"
  | "silent"
  | "same_gate_skip"
  | "no_convergence"
  | "unrecovered_errors"
  | "self_error_persistent"
  | "overnight_window_idle"
  | "overnight_missed"
  | "windows_parked";

export type RegressionArmedDedupe = {
  scope: "global" | "month";
  condition: RegressionCondition;
  month: string | null;
  firedAt: string;
  expiresAt: string;
};

export type RegressionRecentFiredEntry = {
  firedAt: string;
  condition: RegressionCondition;
  month: string | null;
  detail: string;
  delivered: boolean;
  skipReason?: string;
};

export type RegressionAlertStatusResponse = {
  enabled: boolean;
  killSwitchKey: string;
  thresholds: {
    gapGrowthTicks: number;
    silentMinutes: number;
    sameGateSkipTicks: number;
    noConvergenceRuns: number;
    unrecoveredRetryAttempts: number;
  };
  // Numeric/boolean tuning defaults; the panel never reads individual keys.
  defaults: Record<string, number | boolean>;
  cooldownMinutes: number;
  historyPerMonth: number;
  notificationId: string;
  lastEvaluatedAt: string | null;
  lastObservedRanAt: string | null;
  sameSkipReason: string | null;
  sameSkipStreak: number;
  armedDedupes: RegressionArmedDedupe[];
  recentFired: RegressionRecentFiredEntry[];
  perMonthHistoryCount: number;
};

export type RegressionAlertDecision =
  | "skipped_disabled"
  | "skipped_no_data"
  | "skipped_baseline_seeded"
  | "skipped_no_change"
  | "skipped_send_failed"
  | "alerted";

export type RegressionFiredAlert = {
  condition: RegressionCondition;
  month: string | null;
  detail: string;
};

export type RegressionAlertCheckResult = {
  evaluatedAt: string;
  enabled: boolean;
  decision: RegressionAlertDecision;
  fired: RegressionFiredAlert[];
  skipReason?: string;
};

// POST /api/admin/front/auto-closure/regression-alert-status/re-evaluate
export type RegressionAlertReevaluateResponse = {
  result: RegressionAlertCheckResult;
  status: RegressionAlertStatusResponse;
};

// Shared last-run classification for the driver status readouts
// ("never_run" is normal on a fresh deploy; "unreadable" = persistence bug).
export type DriverLastRunStatus = "ok" | "never_run" | "unreadable";

// 202 payloads from the operator "Run now" trigger routes.
export type DriverRunEnqueuedResponse = { status: string; jobId: string };
export type ScopedDriverRunEnqueuedResponse = {
  status: string;
  jobId: string;
  month: string | null;
};

// GET /api/admin/front/analytics-coverage/finish-message-grain-driver-status
// (server: frontFinishMessageGrainDriver.ts FinishMessageGrainTickResult).
export type FinishMessageGrainTickResult = {
  ranAt: string;
  enabled: boolean;
  paused: boolean;
  killSwitch: boolean;
  breakerOpen: boolean;
  applied: boolean;
  outcomeState?: "applied" | "not-needed" | "blocked" | "error";
  detail?: string;
  rowsAffected?: number;
  reason?: string;
};

export type FinishMessageGrainDriverStatusResponse = {
  config: {
    enabled: boolean;
    paused: boolean;
    killSwitchNonCriticalSweeps: boolean;
    frontAuthBreakerOpen: boolean;
  };
  lastRun: FinishMessageGrainTickResult | null;
  lastRunStatus: DriverLastRunStatus;
  lastRunError?: string;
};

// GET /api/admin/front/analytics-coverage/message-grain-upgrade-status
// (server: frontMessageGrainUpgrader.ts MessageGrainUpgradeTickResult).
export type UpgradeMonthOutcome =
  | "upgraded"
  | "advanced"
  | "already_message_grain"
  | "error";

export type UpgradeMonthAttempt = {
  month: string;
  outcome: UpgradeMonthOutcome;
  beforeUnit: string | null;
  afterUnit: string | null;
  appliedCoveragePct: number | null;
  errorCode?: string;
};

export type MessageGrainUpgradeTickResult = {
  ranAt: string;
  enabled: boolean;
  paused: boolean;
  enumEnabled: boolean;
  maxMonthsPerTick: number;
  candidateMonths: number;
  attempted: UpgradeMonthAttempt[];
  reason?: string;
  scopedMonth?: string;
};

export type MessageGrainPendingMonth = {
  month: string;
  denominatorUnit: string | null;
  appliedCoveragePct: number | null;
};

export type MessageGrainUpgradeStatusResponse = {
  config: {
    enabled: boolean;
    enumEnabled: boolean;
    enumSwitch: string;
    paused: boolean;
    killSwitchNonCriticalSweeps: boolean;
    frontAuthBreakerOpen: boolean;
    maxMonthsPerTick: number;
  };
  lastRun: MessageGrainUpgradeTickResult | null;
  lastRunStatus: DriverLastRunStatus;
  lastRunError?: string;
  pendingMonths: MessageGrainPendingMonth[];
};

// GET /api/admin/front/analytics-coverage/outbound-gap-status
// (server: frontOutboundGapCloser.ts OutboundGapCloseTickResult and friends).
export type GapMonthOutcome =
  | "recovery_triggered"
  | "already_closed"
  | "front_count_unknown"
  | "deferred_recovery_cap";

export type GapMonthAttempt = {
  month: string;
  outcome: GapMonthOutcome;
  remainingGap: number | null;
  recoveryJobId?: string;
};

export type OutboundGapCloseTickResult = {
  ranAt: string;
  enabled: boolean;
  paused: boolean;
  materializationEnabled: boolean;
  maxMonthsPerTick: number;
  candidateMonths: number;
  attempted: GapMonthAttempt[];
  reason?: string;
  scopedMonth?: string;
};

export type UnreadableAlertConfig = {
  cooldownMinutes: number;
  muted: boolean;
  defaultCooldownMinutes: number;
  minCooldownMinutes: number;
  maxCooldownMinutes: number;
};

export type OutboundGapMonthRow = {
  month: string;
  messagesOutboundFront: number | null;
  messagesOutboundLocal: number | null;
  messagesOutboundGap: number | null;
};

export type OutboundGapStatusResponse = {
  config: {
    enabled: boolean;
    materializationEnabled: boolean;
    materializationSwitch: string;
    paused: boolean;
    killSwitchNonCriticalSweeps: boolean;
    maxMonthsPerTick: number;
    unreadableAlert: UnreadableAlertConfig;
  };
  lastRun: OutboundGapCloseTickResult | null;
  lastRunStatus: DriverLastRunStatus;
  lastRunError?: string;
  gapMonths: OutboundGapMonthRow[];
};

// POST /api/admin/front/analytics-coverage/unreadable-alert-config
export type UnreadableAlertConfigUpdateResponse = UnreadableAlertConfig;

// Legacy full-backfill (frontConsole.ts) — POST /api/integrations/front/full-backfill
// + GET /api/integrations/front/full-backfill/status/:jobId. `result` carries
// only the progress counters while running; errors/blocked appear on the
// terminal snapshot.
export type FullBackfillProgress = {
  scanned: number;
  ingested: number;
  skipped: number;
  pages: number;
};

export type FullBackfillResult = FullBackfillProgress & {
  errors?: string[];
  blocked?: boolean;
  blockedReason?: string;
};

export type FullBackfillStartResponse = { status: string; jobId: string };

export type FullBackfillJobStatusResponse = {
  status: "running" | "complete" | "failed";
  result?: FullBackfillResult;
  error?: string;
  updatedAt?: number;
  _ts: number;
};
