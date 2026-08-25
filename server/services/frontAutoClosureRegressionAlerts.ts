/**
 * Task #1684 — Front auto-closure regression alerts.
 *
 * Sits next to `frontAnalyticsCoverageAlerts.ts` and fires when the
 * Front self-healing coverage loop (Task #1682) is running but not
 * making progress, or when the loop itself has gone quiet. Reuses the
 * existing notification registry — new id
 * `integration.front.auto_closure_regression`.
 *
 * Seven conditions (1, 2, 4, 5, 6 are per-month; 3, 7 are global):
 *   1. Ingest gap growth across N consecutive ticks.
 *   2. Apply gap growth across N consecutive ticks.
 *   3. Auto-healer silent (last summary older than N minutes).
 *   4. Repeated same-gate skips across N consecutive ticks.
 *   5. Recovery not converging — N ingest-recovery enqueues for the
 *      same month without the ingest gap shrinking.
 *   6. Unrecovered monthly errors — error row present for N consecutive
 *      ticks.
 *   7. Overnight window missed — skipped (overnight task not shipped).
 *
 * All thresholds are configurable via `system_settings`; the master
 * kill switch is `front_auto_closure_alerts_enabled`. Per-condition
 * dedupe uses `system_settings.front_auto_closure_alert_state`,
 * mirroring the pattern from `front_analytics_coverage_alert_state`.
 *
 * MEASUREMENT-ONLY: this file never writes to coverage tables or
 * orchestrator state. It only reads the persisted auto-closure
 * summary and the coverage cache.
 */
import { asc } from "drizzle-orm";
import { db } from "../db";
import {
  frontAnalyticsMonthlyCoverage,
  type FrontAnalyticsMonthlyCoverage,
} from "@shared/schema";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import {
  SETTING_STATE as AUTO_CLOSURE_STATE_KEY,
  SETTING_OVERNIGHT_ENABLED as AUTO_CLOSURE_OVERNIGHT_ENABLED_KEY,
  type AutoClosureMode,
  type AutoClosureRunSummary,
  type ParkedWindowEntry,
} from "./frontAutoClosure";

// ──────────────── Settings ────────────────

export const NOTIFICATION_ID = "integration.front.auto_closure_regression";
export const SETTING_ENABLED = "front_auto_closure_alerts_enabled";
export const SETTING_GAP_GROWTH_TICKS =
  "front_auto_closure_alert_gap_growth_consecutive_ticks";
export const SETTING_SILENT_MINUTES = "front_auto_closure_alert_silent_minutes";
export const SETTING_SAME_GATE_SKIP_TICKS =
  "front_auto_closure_alert_same_gate_skip_ticks";
export const SETTING_NO_CONVERGENCE_RUNS =
  "front_auto_closure_alert_no_convergence_runs";
export const SETTING_UNRECOVERED_RETRY_ATTEMPTS =
  "front_auto_closure_alert_unrecovered_retry_attempts";
// Task #1696 — `lastSelfError` non-null across N consecutive ticks.
export const SETTING_SELF_ERROR_TICKS =
  "front_auto_closure_alert_self_error_ticks";
// Task #1694 — expected upper bound (hours) between two consecutive
// overnight aggressive ticks. If `now - lastOvernightRanAt` exceeds
// this and overnight mode is enabled, fire `overnight_missed`.
export const SETTING_OVERNIGHT_WINDOW_HOURS =
  "front_auto_closure_alert_overnight_window_hours";
// Task #1904 — parked recovery window digest.
export const SETTING_PARKED_ENABLED =
  "front_auto_closure_alert_parked_enabled";
// Periodic "still parked" reminder cadence (hours). New parkings always fire
// regardless of this interval; this only governs the still-parked digest.
export const SETTING_PARKED_REMINDER_HOURS =
  "front_auto_closure_alert_parked_reminder_hours";
export const SETTING_STATE = "front_auto_closure_alert_state";

export const DEFAULTS = {
  enabled: true,
  gapGrowthTicks: 3,
  /** Default reflects 2× the 30-min coverage worker interval. */
  silentMinutes: 60,
  sameGateSkipTicks: 5,
  noConvergenceRuns: 3,
  unrecoveredRetryAttempts: 5,
  // Task #1696 — three sequential ticks with the orchestrator itself
  // throwing is enough to surface a self-healer regression.
  selfErrorTicks: 3,
  // Task #1694 — 28h = a 24h overnight cadence + ~4h grace for the
  // window start hour shifting, DST transitions, and one missed
  // coverage tick at the very edge of the window.
  overnightWindowHours: 28,
  // Task #1904 — parked recovery window digest.
  parkedEnabled: true,
  parkedReminderHours: 24,
} as const;

const HISTORY_PER_MONTH = 16;
const PERMONTH_STALE_DAYS = 14;
const RUNBOOK_LINK =
  "FRONT_ANALYTICS_COVERAGE.md#auto-closure-regression-alerts";
const COOLDOWN_MINUTES = 360;

// ──────────────── Helpers ────────────────

function parseBool(raw: string | null | undefined, fb: boolean): boolean {
  if (raw == null) return fb;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fb;
}

function parseNum(raw: string | null | undefined, fb: number): number {
  if (raw == null) return fb;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fb;
}

let configOverride: any | null = null;

async function loadConfig() {
  if (configOverride) return configOverride;
  const get = async (k: string) =>
    (await getSystemSetting(k).catch(() => null))?.value ?? null;
  return {
    enabled: parseBool(await get(SETTING_ENABLED), DEFAULTS.enabled),
    gapGrowthTicks: Math.max(
      2,
      Math.floor(
        parseNum(await get(SETTING_GAP_GROWTH_TICKS), DEFAULTS.gapGrowthTicks),
      ),
    ),
    silentMinutes: Math.max(
      1,
      Math.floor(
        parseNum(await get(SETTING_SILENT_MINUTES), DEFAULTS.silentMinutes),
      ),
    ),
    sameGateSkipTicks: Math.max(
      2,
      Math.floor(
        parseNum(
          await get(SETTING_SAME_GATE_SKIP_TICKS),
          DEFAULTS.sameGateSkipTicks,
        ),
      ),
    ),
    noConvergenceRuns: Math.max(
      2,
      Math.floor(
        parseNum(
          await get(SETTING_NO_CONVERGENCE_RUNS),
          DEFAULTS.noConvergenceRuns,
        ),
      ),
    ),
    unrecoveredRetryAttempts: Math.max(
      2,
      Math.floor(
        parseNum(
          await get(SETTING_UNRECOVERED_RETRY_ATTEMPTS),
          DEFAULTS.unrecoveredRetryAttempts,
        ),
      ),
    ),
    selfErrorTicks: Math.max(
      2,
      Math.floor(
        parseNum(await get(SETTING_SELF_ERROR_TICKS), DEFAULTS.selfErrorTicks),
      ),
    ),
    overnightWindowHours: Math.max(
      1,
      parseNum(
        await get(SETTING_OVERNIGHT_WINDOW_HOURS),
        DEFAULTS.overnightWindowHours,
      ),
    ),
    // Read the overnight kill switch directly from the auto-closure
    // namespace so this alerter doesn't fire `overnight_missed` while
    // operators have intentionally disabled overnight mode.
    overnightEnabled: parseBool(
      await get(AUTO_CLOSURE_OVERNIGHT_ENABLED_KEY),
      true,
    ),
    parkedEnabled: parseBool(
      await get(SETTING_PARKED_ENABLED),
      DEFAULTS.parkedEnabled,
    ),
    parkedReminderHours: Math.max(
      1,
      parseNum(
        await get(SETTING_PARKED_REMINDER_HOURS),
        DEFAULTS.parkedReminderHours,
      ),
    ),
  };
}

// ──────────────── Persisted state ────────────────

export type RegressionCondition =
  | "ingest_growth"
  | "apply_growth"
  | "silent"
  | "same_gate_skip"
  | "no_convergence"
  | "unrecovered_errors"
  // Task #1696 — orchestrator-self regressions.
  | "self_error_persistent"
  | "overnight_window_idle"
  // Task #1694 — overnight aggressive tick missed beyond the window.
  | "overnight_missed"
  // Task #1904 — parked recovery windows digest.
  | "windows_parked";

type GlobalCondition =
  | "silent"
  | "same_gate_skip"
  | "self_error_persistent"
  | "overnight_window_idle"
  | "overnight_missed"
  | "windows_parked";

interface PerMonthHistoryEntry {
  ranAt: string;
  ingestGap: number;
  applyGap: number;
  hadError: boolean;
  unrecoverable: boolean;
  errorMessage: string | null;
  wasActedOn: boolean;
  cooldownIso: string | null;
  /** Whether the gap a cooldown indicates a recovery enqueue at this tick. */
  recoveryEnqueuedThisTick: boolean;
}

interface PerMonthState {
  history: PerMonthHistoryEntry[];
  alerted: Partial<Record<RegressionCondition, string>>;
  lastSeenIso: string;
}

interface RecentFiredEntry {
  firedAt: string;
  condition: RegressionCondition;
  month: string | null;
  detail: string;
  delivered: boolean;
  skipReason?: string;
}

/**
 * Task #1696 — accumulated progress + gap signal during the most
 * recent overnight window. `progressTotal` is the running sum of
 * `ingestRecoveriesEnqueued + applyNudgesEnqueued + errorRetrySuccesses`
 * across ticks observed while `summary.mode === "overnight"`.
 * `hadGapsAtAnyTick` becomes true if any coverage row had a positive
 * ingest or apply gap at any tick during the window. The alerter
 * evaluates the window on the overnight→daytime transition, then
 * clears this state.
 */
interface OvernightWindowState {
  startedAtRanAt: string;
  endedAtRanAt: string | null;
  tickCount: number;
  progressTotal: number;
  hadGapsAtAnyTick: boolean;
}

interface RegressionAlertState {
  /** ISO of the most recent auto-closure summary.ranAt we observed. */
  lastObservedRanAt: string | null;
  /** ISO of the most recent runFrontAutoClosureRegressionAlertCheck call. */
  lastEvaluatedAt: string | null;
  perMonth: Record<string, PerMonthState>;
  sameSkipReason: string | null;
  sameSkipStreak: number;
  globalAlerted: Partial<Record<GlobalCondition, string>>;
  recentFired: RecentFiredEntry[];
  // Task #1696 — consecutive-tick streak of non-null `lastSelfError`.
  selfErrorStreak: number;
  // Task #1696 — overnight-window tracking.
  lastObservedMode: AutoClosureMode | null;
  overnightWindow: OvernightWindowState | null;
  // Task #1904 — months reported as parked in the most recent digest,
  // so we can detect "newly parked since last digest" on the next run.
  lastReportedParkedMonths: string[];
}

const RECENT_FIRED_LIMIT = 25;

function emptyState(): RegressionAlertState {
  return {
    lastObservedRanAt: null,
    lastEvaluatedAt: null,
    perMonth: {},
    sameSkipReason: null,
    sameSkipStreak: 0,
    globalAlerted: {},
    recentFired: [],
    selfErrorStreak: 0,
    lastObservedMode: null,
    overnightWindow: null,
    lastReportedParkedMonths: [],
  };
}

let stateOverride: RegressionAlertState | null = null;

async function loadState(): Promise<RegressionAlertState> {
  if (stateOverride) return stateOverride;
  const row = await getSystemSetting(SETTING_STATE).catch(() => null);
  if (!row?.value) return emptyState();
  try {
    const parsed = JSON.parse(row.value) as Partial<RegressionAlertState>;
    return {
      lastObservedRanAt: parsed.lastObservedRanAt ?? null,
      lastEvaluatedAt: parsed.lastEvaluatedAt ?? null,
      perMonth:
        parsed.perMonth && typeof parsed.perMonth === "object"
          ? (parsed.perMonth as Record<string, PerMonthState>)
          : {},
      sameSkipReason: parsed.sameSkipReason ?? null,
      sameSkipStreak:
        typeof parsed.sameSkipStreak === "number" ? parsed.sameSkipStreak : 0,
      globalAlerted: parsed.globalAlerted ?? {},
      recentFired: Array.isArray(parsed.recentFired)
        ? (parsed.recentFired as RecentFiredEntry[]).slice(-RECENT_FIRED_LIMIT)
        : [],
      selfErrorStreak:
        typeof parsed.selfErrorStreak === "number" ? parsed.selfErrorStreak : 0,
      lastObservedMode: parsed.lastObservedMode ?? null,
      overnightWindow: parsed.overnightWindow ?? null,
      lastReportedParkedMonths: Array.isArray(parsed.lastReportedParkedMonths)
        ? (parsed.lastReportedParkedMonths as string[]).filter(
            (m) => typeof m === "string",
          )
        : [],
    };
  } catch {
    return emptyState();
  }
}

async function saveState(s: RegressionAlertState): Promise<void> {
  if (stateOverride) {
    stateOverride = s;
    return;
  }
  await setSystemSetting(SETTING_STATE, JSON.stringify(s), "system");
}

// ──────────────── Auto-closure inputs ────────────────

interface AutoClosureStateSnapshot {
  lastSummary: AutoClosureRunSummary | null;
  cooldowns: Record<string, string>;
  // Task #1694 — most recent tick observed in overnight mode (set by
  // `frontAutoClosure.persistSummary`). `null` until overnight mode
  // ships or has been observed at least once.
  lastOvernightRanAt: string | null;
  // Task #1904 — currently parked recovery windows (month → entry).
  parkedWindows: Record<string, ParkedWindowEntry>;
}

let snapshotOverride: AutoClosureStateSnapshot | null = null;

async function loadAutoClosureSnapshot(): Promise<AutoClosureStateSnapshot> {
  if (snapshotOverride) return snapshotOverride;
  const row = await getSystemSetting(AUTO_CLOSURE_STATE_KEY).catch(() => null);
  if (!row?.value)
    return {
      lastSummary: null,
      cooldowns: {},
      lastOvernightRanAt: null,
      parkedWindows: {},
    };
  try {
    const parsed = JSON.parse(row.value);
    return {
      lastSummary: parsed.lastSummary ?? null,
      cooldowns: parsed.cooldowns ?? {},
      lastOvernightRanAt: parsed.lastOvernightRanAt ?? null,
      parkedWindows:
        parsed.parkedWindows && typeof parsed.parkedWindows === "object"
          ? (parsed.parkedWindows as Record<string, ParkedWindowEntry>)
          : {},
    };
  } catch {
    return {
      lastSummary: null,
      cooldowns: {},
      lastOvernightRanAt: null,
      parkedWindows: {},
    };
  }
}

async function loadCoverageRows(): Promise<FrontAnalyticsMonthlyCoverage[]> {
  return (await db
    .select()
    .from(frontAnalyticsMonthlyCoverage)
    .orderBy(asc(frontAnalyticsMonthlyCoverage.month))) as FrontAnalyticsMonthlyCoverage[];
}

// ──────────────── Notification dispatch ────────────────

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: {
    triggerSource: string;
    bypassDedupe?: boolean;
    metadata?: Record<string, unknown>;
  },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;

async function dispatch(
  text: string,
  metadata: Record<string, unknown>,
): Promise<{ delivered: boolean; skipReason?: string }> {
  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      NOTIFICATION_ID,
      { text, preview: text.slice(0, 300) },
      { triggerSource: "alert_service", metadata },
    );
    return {
      delivered: r.delivered,
      skipReason: r.delivered ? undefined : (r.skipReason ?? r.status),
    };
  } catch (err: any) {
    return {
      delivered: false,
      skipReason: `dispatch_error:${err?.message ?? "unknown"}`,
    };
  }
}

// ──────────────── Payload builders ────────────────

function gapPct(gap: number, denom: number): number {
  if (denom <= 0) return 0;
  return Math.min(100, (gap / denom) * 100);
}

function oldestAffectedFromHistory(
  history: PerMonthHistoryEntry[],
  windowSize: number,
): string | null {
  const slice = history.slice(-windowSize);
  return slice[0]?.ranAt ?? null;
}

function buildPayloadLines(opts: {
  condition: RegressionCondition;
  month: string | null;
  gapType?: "ingest" | "apply";
  gapCount?: number;
  gapPct?: number;
  oldestAffected?: string | null;
  lastAction?: string | null;
  lastSkipReason?: string | null;
  extra?: string[];
}): string {
  const lines: string[] = [];
  lines.push(`:warning: *Front auto-closure regression — ${opts.condition}*`);
  if (opts.month) lines.push(`• Month: ${opts.month}`);
  if (opts.gapType) {
    lines.push(
      `• Gap: ${opts.gapType} — ${opts.gapCount?.toLocaleString() ?? "?"} (${(
        opts.gapPct ?? 0
      ).toFixed(2)}%)`,
    );
  }
  if (opts.oldestAffected) {
    lines.push(`• Oldest affected tick: ${opts.oldestAffected}`);
  }
  if (opts.lastAction != null) {
    lines.push(`• Last action: ${opts.lastAction ?? "none"}`);
  }
  if (opts.lastSkipReason) {
    lines.push(`• Last skip reason: ${opts.lastSkipReason}`);
  }
  if (opts.extra) for (const e of opts.extra) lines.push(`• ${e}`);
  lines.push(`• Runbook: ${RUNBOOK_LINK}`);
  return lines.join("\n");
}

// ──────────────── Condition logic ────────────────

function isMonotonicallyGrowing(values: number[]): boolean {
  if (values.length < 2) return false;
  let grew = false;
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1]) return false;
    if (values[i] > values[i - 1]) grew = true;
  }
  return grew;
}

function lastActionFor(entry: PerMonthHistoryEntry | undefined): string {
  if (!entry) return "none";
  if (entry.recoveryEnqueuedThisTick) return "ingest_recovery_enqueued";
  if (entry.wasActedOn) return "acted_on";
  return "no_action";
}

// ──────────────── Tick observation ────────────────

interface ObservationInputs {
  summary: AutoClosureRunSummary | null;
  cooldowns: Record<string, string>;
  coverageByMonth: Map<string, FrontAnalyticsMonthlyCoverage>;
}

function appendTickObservation(
  state: RegressionAlertState,
  inputs: ObservationInputs,
  now: Date,
): boolean {
  const { summary, cooldowns, coverageByMonth } = inputs;
  if (!summary) return false;
  // Idempotent: skip if we've already recorded this ranAt.
  if (
    state.lastObservedRanAt &&
    state.lastObservedRanAt === summary.ranAt
  ) {
    return false;
  }

  const actedSet = new Set(summary.monthsActed ?? []);
  // Build per-month observation from the union of:
  //   - months in coverage cache (so error rows / gap rows surface)
  //   - months in current cooldowns (so recovery-not-converging tracks them)
  //   - months acted on this tick
  const months = new Set<string>([
    ...coverageByMonth.keys(),
    ...Object.keys(cooldowns),
    ...actedSet,
  ]);

  for (const month of months) {
    const row = coverageByMonth.get(month);
    const prior = state.perMonth[month];
    const priorCooldownIso =
      prior?.history[prior.history.length - 1]?.cooldownIso ?? null;
    const newCooldownIso = cooldowns[month] ?? null;
    const recoveryEnqueuedThisTick =
      newCooldownIso !== null && newCooldownIso !== priorCooldownIso;
    const entry: PerMonthHistoryEntry = {
      ranAt: summary.ranAt,
      ingestGap: row?.ingestGap ?? 0,
      applyGap: row?.applyGap ?? 0,
      hadError: !!row?.frontAnalyticsError,
      unrecoverable: !!row?.unrecoverable,
      errorMessage: row?.frontAnalyticsError ?? null,
      wasActedOn: actedSet.has(month),
      cooldownIso: newCooldownIso,
      recoveryEnqueuedThisTick,
    };
    const next: PerMonthState = prior
      ? { ...prior }
      : { history: [], alerted: {}, lastSeenIso: summary.ranAt };
    next.history = [...next.history, entry].slice(-HISTORY_PER_MONTH);
    next.lastSeenIso = summary.ranAt;
    state.perMonth[month] = next;
  }

  // Prune months we haven't seen in PERMONTH_STALE_DAYS.
  const cutoff = now.getTime() - PERMONTH_STALE_DAYS * 24 * 60 * 60_000;
  for (const [m, s] of Object.entries(state.perMonth)) {
    const t = new Date(s.lastSeenIso).getTime();
    if (!Number.isFinite(t) || t < cutoff) {
      delete state.perMonth[m];
    }
  }

  // Same-gate skip streak.
  const reason = summary.skippedReason ?? null;
  if (reason) {
    if (state.sameSkipReason === reason) {
      state.sameSkipStreak++;
    } else {
      state.sameSkipReason = reason;
      state.sameSkipStreak = 1;
    }
  } else {
    state.sameSkipReason = null;
    state.sameSkipStreak = 0;
    delete state.globalAlerted.same_gate_skip;
  }

  // Task #1696 — self-error streak. Counts consecutive ticks (by
  // distinct ranAt) where the orchestrator surfaced a `lastSelfError`.
  // A clean tick resets the streak and clears the dedupe stamp so the
  // alerter rearms once the next regression occurs.
  if (summary.lastSelfError) {
    state.selfErrorStreak++;
  } else {
    state.selfErrorStreak = 0;
    delete state.globalAlerted.self_error_persistent;
  }

  // Task #1696 — overnight window tracking. We accumulate progress and
  // gap signal during every overnight tick and evaluate on the
  // overnight→daytime transition. The mode field always exists on
  // recent summaries; older summaries (pre-Task #1683) default to
  // "daytime" which simply means we never observe an overnight window.
  const currentMode: AutoClosureMode = summary.mode ?? "daytime";
  const anyGap = Array.from(coverageByMonth.values()).some(
    (r) => (r.ingestGap ?? 0) > 0 || (r.applyGap ?? 0) > 0,
  );
  const tickProgress =
    (summary.ingestRecoveriesEnqueued ?? 0) +
    (summary.applyNudgesEnqueued ?? 0) +
    (summary.errorRetrySuccesses ?? 0);

  if (currentMode === "overnight") {
    if (state.overnightWindow == null) {
      state.overnightWindow = {
        startedAtRanAt: summary.ranAt,
        endedAtRanAt: null,
        tickCount: 0,
        progressTotal: 0,
        hadGapsAtAnyTick: false,
      };
    }
    state.overnightWindow.tickCount++;
    state.overnightWindow.progressTotal += tickProgress;
    if (anyGap) state.overnightWindow.hadGapsAtAnyTick = true;
    state.overnightWindow.endedAtRanAt = summary.ranAt;
  } else if (
    currentMode === "daytime" &&
    state.lastObservedMode === "overnight" &&
    state.overnightWindow != null
  ) {
    // Window just ended — leave `overnightWindow` populated so the
    // evaluator below can fire on it. The evaluator clears it after
    // inspecting (or after dedupe cooldown).
    state.overnightWindow.endedAtRanAt =
      state.overnightWindow.endedAtRanAt ?? summary.ranAt;
  }
  state.lastObservedMode = currentMode;

  state.lastObservedRanAt = summary.ranAt;
  return true;
}

// ──────────────── Dedupe ────────────────

function cooldownActive(
  iso: string | undefined,
  now: Date,
  minutes = COOLDOWN_MINUTES,
): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < minutes * 60_000;
}

function clearMonthAlertedIfResolved(
  state: RegressionAlertState,
  month: string,
  condition: RegressionCondition,
  conditionStillTrue: boolean,
): void {
  if (!conditionStillTrue) {
    const m = state.perMonth[month];
    if (m?.alerted[condition]) delete m.alerted[condition];
  }
}

// ──────────────── Evaluation ────────────────

export type RegressionAlertDecision =
  | "skipped_disabled"
  | "skipped_no_data"
  | "skipped_baseline_seeded"
  | "skipped_no_change"
  | "skipped_send_failed"
  | "alerted";

export interface FiredAlert {
  condition: RegressionCondition;
  month: string | null;
  detail: string;
}

export interface RegressionAlertCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  decision: RegressionAlertDecision;
  fired: FiredAlert[];
  skipReason?: string;
}

export async function runFrontAutoClosureRegressionAlertCheck(
  now: number = Date.now(),
): Promise<RegressionAlertCheckResult> {
  const cfg = await loadConfig();
  const result: RegressionAlertCheckResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: cfg.enabled,
    decision: "skipped_no_data",
    fired: [],
  };

  if (!cfg.enabled) {
    // Persist lastEvaluatedAt even when disabled so the admin UI can show
    // the panel is being polled.
    try {
      const s = await loadState();
      s.lastEvaluatedAt = result.evaluatedAt;
      await saveState(s);
    } catch {}
    result.decision = "skipped_disabled";
    result.skipReason = `${SETTING_ENABLED}=false`;
    return result;
  }

  const [state, snapshot, rows] = await Promise.all([
    loadState(),
    loadAutoClosureSnapshot(),
    loadCoverageRows(),
  ]);
  const coverageByMonth = new Map(rows.map((r) => [r.month, r]));
  const summary = snapshot.lastSummary;

  if (!summary) {
    result.skipReason = "no auto-closure summary persisted yet";
    return result;
  }

  state.lastEvaluatedAt = result.evaluatedAt;
  // First observation seeds baseline without firing.
  const wasFirstObservation = state.lastObservedRanAt === null;
  const observedNewTick = appendTickObservation(
    state,
    {
      summary,
      cooldowns: snapshot.cooldowns,
      coverageByMonth,
    },
    new Date(now),
  );

  if (wasFirstObservation) {
    await saveState(state);
    result.decision = "skipped_baseline_seeded";
    result.skipReason = "first observation — baseline established";
    return result;
  }

  // ── Condition 3 / 7: global (silent + overnight not shipped) ──
  const summaryRanAtMs = new Date(summary.ranAt).getTime();
  const silentForMinutes = Number.isFinite(summaryRanAtMs)
    ? (now - summaryRanAtMs) / 60_000
    : Infinity;
  if (silentForMinutes > cfg.silentMinutes) {
    if (!cooldownActive(state.globalAlerted.silent, new Date(now))) {
      result.fired.push({
        condition: "silent",
        month: null,
        detail: buildPayloadLines({
          condition: "silent",
          month: null,
          oldestAffected: summary.ranAt,
          extra: [
            `Auto-healer last ran ${silentForMinutes.toFixed(1)} min ago (threshold ${cfg.silentMinutes} min)`,
          ],
        }),
      });
      state.globalAlerted.silent = new Date(now).toISOString();
    }
  } else if (
    state.globalAlerted.silent &&
    silentForMinutes <= cfg.silentMinutes
  ) {
    delete state.globalAlerted.silent;
  }

  // ── Condition 7 (Task #1694): overnight aggressive window missed ──
  //
  // Fires when overnight mode is enabled but no overnight tick has
  // been observed within the configured window. The reference point
  // is `snapshot.lastOvernightRanAt`; when null (overnight mode just
  // enabled, never run), we fall back to the alerter's own
  // `lastObservedRanAt` so the regression alerter doesn't fire
  // immediately the first time overnight mode is turned on — we want
  // proof at least one full window has elapsed since we started
  // watching.
  if (cfg.overnightEnabled) {
    const overnightReferenceIso =
      snapshot.lastOvernightRanAt ?? state.lastObservedRanAt;
    const overnightReferenceMs = overnightReferenceIso
      ? new Date(overnightReferenceIso).getTime()
      : NaN;
    if (Number.isFinite(overnightReferenceMs)) {
      const hoursSinceOvernight =
        (now - overnightReferenceMs) / (60 * 60_000);
      if (hoursSinceOvernight > cfg.overnightWindowHours) {
        if (
          !cooldownActive(state.globalAlerted.overnight_missed, new Date(now))
        ) {
          const sourceLabel = snapshot.lastOvernightRanAt
            ? "last overnight tick"
            : "baseline observation";
          result.fired.push({
            condition: "overnight_missed",
            month: null,
            detail: buildPayloadLines({
              condition: "overnight_missed",
              month: null,
              oldestAffected: overnightReferenceIso ?? null,
              extra: [
                `Overnight mode enabled but no overnight tick observed for ${hoursSinceOvernight.toFixed(
                  1,
                )}h (threshold ${cfg.overnightWindowHours}h, since ${sourceLabel})`,
              ],
            }),
          });
          state.globalAlerted.overnight_missed = new Date(now).toISOString();
        }
      } else if (state.globalAlerted.overnight_missed) {
        delete state.globalAlerted.overnight_missed;
      }
    }
  } else if (state.globalAlerted.overnight_missed) {
    // Operator disabled overnight mode — clear the dedupe stamp so it
    // doesn't survive into the next time overnight is re-enabled.
    delete state.globalAlerted.overnight_missed;
  }

  // ── Condition 4: same-gate skip streak ──
  if (
    state.sameSkipReason &&
    state.sameSkipStreak >= cfg.sameGateSkipTicks &&
    !cooldownActive(state.globalAlerted.same_gate_skip, new Date(now))
  ) {
    result.fired.push({
      condition: "same_gate_skip",
      month: null,
      detail: buildPayloadLines({
        condition: "same_gate_skip",
        month: null,
        lastSkipReason: state.sameSkipReason,
        extra: [
          `Skipped ${state.sameSkipStreak} consecutive ticks with the same reason (threshold ${cfg.sameGateSkipTicks})`,
        ],
      }),
    });
    state.globalAlerted.same_gate_skip = new Date(now).toISOString();
  }

  // ── Task #1696 — self-error persistent ──
  // Orchestrator threw / set `lastSelfError` on N consecutive ticks.
  // The streak is maintained in appendTickObservation; a clean tick
  // clears both the streak and the dedupe stamp so the alerter rearms.
  if (
    state.selfErrorStreak >= cfg.selfErrorTicks &&
    !cooldownActive(state.globalAlerted.self_error_persistent, new Date(now))
  ) {
    const lastErr = summary.lastSelfError ?? "unknown";
    result.fired.push({
      condition: "self_error_persistent",
      month: null,
      detail: buildPayloadLines({
        condition: "self_error_persistent",
        month: null,
        extra: [
          `Auto-healer surfaced \`lastSelfError\` on ${state.selfErrorStreak} consecutive ticks (threshold ${cfg.selfErrorTicks})`,
          `Last error: ${lastErr.slice(0, 200)}`,
        ],
      }),
    });
    state.globalAlerted.self_error_persistent = new Date(now).toISOString();
  }

  // ── Task #1696 — overnight window idle ──
  // The overnight window just ended (overnight→daytime transition is
  // detected in appendTickObservation, which leaves `overnightWindow`
  // populated with `endedAtRanAt` set). Fire when the window made zero
  // progress (no recoveries, no nudges, no error retry successes) AND
  // some coverage gap was visible during the window. Once evaluated we
  // clear the window state regardless of fire/dedupe so the next
  // overnight window starts fresh.
  if (
    state.overnightWindow != null &&
    state.lastObservedMode === "daytime" &&
    state.overnightWindow.endedAtRanAt != null
  ) {
    const w = state.overnightWindow;
    const idle = w.progressTotal === 0 && w.hadGapsAtAnyTick;
    if (
      idle &&
      !cooldownActive(state.globalAlerted.overnight_window_idle, new Date(now))
    ) {
      result.fired.push({
        condition: "overnight_window_idle",
        month: null,
        detail: buildPayloadLines({
          condition: "overnight_window_idle",
          month: null,
          oldestAffected: w.startedAtRanAt,
          lastSkipReason: state.sameSkipReason,
          extra: [
            `Overnight window ${w.startedAtRanAt} → ${w.endedAtRanAt} ran ${w.tickCount} tick(s) with zero progress while coverage gaps remained`,
          ],
        }),
      });
      state.globalAlerted.overnight_window_idle = new Date(now).toISOString();
    }
    // Always clear the window state once the daytime transition has
    // been evaluated — we only want one alert per overnight window.
    state.overnightWindow = null;
  }

  // ── Task #1904 — parked recovery windows digest ──
  // Surface parked months in the regression-alert digest so on-call
  // operators learn about them without visiting the admin UI.
  // Fires when (a) at least one month has been parked since the last
  // digest (always — bypasses the periodic interval), or (b) the
  // periodic reminder interval has elapsed and any window is still
  // parked. When the parked set is empty we clear both the dedupe
  // stamp and the "last reported" memory so the next parking re-fires
  // immediately.
  if (cfg.parkedEnabled) {
    const parkedEntries = Object.entries(snapshot.parkedWindows).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    const parkedMonths = parkedEntries.map(([m]) => m);
    if (parkedMonths.length === 0) {
      if (state.globalAlerted.windows_parked) {
        delete state.globalAlerted.windows_parked;
      }
      if (state.lastReportedParkedMonths.length > 0) {
        state.lastReportedParkedMonths = [];
      }
    } else {
      const prevReported = new Set(state.lastReportedParkedMonths);
      const newlyParked = parkedMonths.filter((m) => !prevReported.has(m));
      const reminderActive = cooldownActive(
        state.globalAlerted.windows_parked,
        new Date(now),
        cfg.parkedReminderHours * 60,
      );
      const shouldFire = newlyParked.length > 0 || !reminderActive;
      if (shouldFire) {
        const lines: string[] = [];
        if (newlyParked.length > 0) {
          lines.push(
            `Newly parked since last digest: ${newlyParked.join(", ")}`,
          );
        }
        lines.push(
          `Still parked (${parkedMonths.length}): ${parkedMonths.join(", ")}`,
        );
        for (const [month, entry] of parkedEntries) {
          lines.push(
            `${month}: parked ${entry.parkedAt} — ${entry.deadRuns} dead run(s); reason=${entry.reason}`,
          );
        }
        lines.push(
          "Un-park via POST /api/admin/front/auto-closure/unpark { month } " +
            "or call unparkRecoveryWindow(month) — clears the parked entry " +
            "AND the dead-run streak so the window is re-evaluated next tick.",
        );
        result.fired.push({
          condition: "windows_parked",
          month: null,
          detail: buildPayloadLines({
            condition: "windows_parked",
            month: null,
            extra: lines,
          }),
        });
        state.globalAlerted.windows_parked = new Date(now).toISOString();
        state.lastReportedParkedMonths = parkedMonths;
      }
    }
  }

  // ── Per-month conditions ──
  for (const [month, pm] of Object.entries(state.perMonth)) {
    const row = coverageByMonth.get(month);
    const denomFront = row?.frontTotalMessages ?? 0;
    const denomFetched = row?.fetchedIntoNobull ?? 0;
    const lastEntry = pm.history[pm.history.length - 1];

    // 1. Ingest growth
    {
      const window = pm.history.slice(-cfg.gapGrowthTicks);
      const condition =
        window.length >= cfg.gapGrowthTicks &&
        isMonotonicallyGrowing(window.map((h) => h.ingestGap));
      if (
        condition &&
        !cooldownActive(pm.alerted.ingest_growth, new Date(now))
      ) {
        result.fired.push({
          condition: "ingest_growth",
          month,
          detail: buildPayloadLines({
            condition: "ingest_growth",
            month,
            gapType: "ingest",
            gapCount: lastEntry?.ingestGap ?? 0,
            gapPct: gapPct(lastEntry?.ingestGap ?? 0, denomFront),
            oldestAffected: oldestAffectedFromHistory(
              pm.history,
              cfg.gapGrowthTicks,
            ),
            lastAction: lastActionFor(lastEntry),
            lastSkipReason: state.sameSkipReason,
          }),
        });
        pm.alerted.ingest_growth = new Date(now).toISOString();
      } else {
        clearMonthAlertedIfResolved(state, month, "ingest_growth", condition);
      }
    }

    // 2. Apply growth
    {
      const window = pm.history.slice(-cfg.gapGrowthTicks);
      const condition =
        window.length >= cfg.gapGrowthTicks &&
        isMonotonicallyGrowing(window.map((h) => h.applyGap));
      if (
        condition &&
        !cooldownActive(pm.alerted.apply_growth, new Date(now))
      ) {
        result.fired.push({
          condition: "apply_growth",
          month,
          detail: buildPayloadLines({
            condition: "apply_growth",
            month,
            gapType: "apply",
            gapCount: lastEntry?.applyGap ?? 0,
            gapPct: gapPct(lastEntry?.applyGap ?? 0, denomFetched),
            oldestAffected: oldestAffectedFromHistory(
              pm.history,
              cfg.gapGrowthTicks,
            ),
            lastAction: lastActionFor(lastEntry),
            lastSkipReason: state.sameSkipReason,
          }),
        });
        pm.alerted.apply_growth = new Date(now).toISOString();
      } else {
        clearMonthAlertedIfResolved(state, month, "apply_growth", condition);
      }
    }

    // 5. Recovery not converging: N recovery enqueues observed in the
    //    history window, and the ingest gap of the most recent enqueue is
    //    >= the ingest gap recorded at the first enqueue in the window.
    {
      const recoveryEntries = pm.history.filter(
        (h) => h.recoveryEnqueuedThisTick,
      );
      const recent = recoveryEntries.slice(-cfg.noConvergenceRuns);
      const condition =
        recent.length >= cfg.noConvergenceRuns &&
        (recent[recent.length - 1].ingestGap >= recent[0].ingestGap ||
          (lastEntry?.ingestGap ?? 0) >= recent[0].ingestGap);
      if (
        condition &&
        !cooldownActive(pm.alerted.no_convergence, new Date(now))
      ) {
        result.fired.push({
          condition: "no_convergence",
          month,
          detail: buildPayloadLines({
            condition: "no_convergence",
            month,
            gapType: "ingest",
            gapCount: lastEntry?.ingestGap ?? 0,
            gapPct: gapPct(lastEntry?.ingestGap ?? 0, denomFront),
            oldestAffected: recent[0]?.ranAt ?? null,
            lastAction: lastActionFor(lastEntry),
            extra: [
              `Recovery enqueued ${recent.length}× in the window without ingest gap shrinking`,
            ],
          }),
        });
        pm.alerted.no_convergence = new Date(now).toISOString();
      } else {
        clearMonthAlertedIfResolved(state, month, "no_convergence", condition);
      }
    }

    // 6. Unrecovered monthly errors: N consecutive history entries with
    //    an error. Unrecoverable rows are excluded — operators silence
    //    those by design.
    {
      const window = pm.history.slice(-cfg.unrecoveredRetryAttempts);
      const condition =
        window.length >= cfg.unrecoveredRetryAttempts &&
        window.every((h) => h.hadError && !h.unrecoverable);
      if (
        condition &&
        !cooldownActive(pm.alerted.unrecovered_errors, new Date(now))
      ) {
        result.fired.push({
          condition: "unrecovered_errors",
          month,
          detail: buildPayloadLines({
            condition: "unrecovered_errors",
            month,
            oldestAffected: window[0]?.ranAt ?? null,
            lastAction: lastActionFor(lastEntry),
            extra: [
              `Error persisted across ${window.length} consecutive ticks: ${
                lastEntry?.errorMessage?.slice(0, 200) ?? "unknown"
              }`,
            ],
          }),
        });
        pm.alerted.unrecovered_errors = new Date(now).toISOString();
      } else {
        clearMonthAlertedIfResolved(
          state,
          month,
          "unrecovered_errors",
          condition,
        );
      }
    }
  }

  if (result.fired.length === 0) {
    await saveState(state);
    if (observedNewTick) {
      result.decision = "skipped_no_change";
    } else {
      result.decision = "skipped_no_change";
      result.skipReason = "no new tick since last evaluation";
    }
    return result;
  }

  // Dispatch (one Slack post per alert so each carries its own runbook
  // link and payload — mirrors how the existing drop/floor alert works
  // when multiple sub-conditions fire).
  let anyDelivered = false;
  let lastSkip: string | undefined;
  for (const fired of result.fired) {
    const r = await dispatch(fired.detail, {
      event: "auto_closure_regression",
      condition: fired.condition,
      month: fired.month,
    });
    state.recentFired = [
      ...state.recentFired,
      {
        firedAt: new Date(now).toISOString(),
        condition: fired.condition,
        month: fired.month,
        detail: fired.detail,
        delivered: r.delivered,
        skipReason: r.delivered ? undefined : r.skipReason,
      },
    ].slice(-RECENT_FIRED_LIMIT);
    if (r.delivered) {
      anyDelivered = true;
    } else {
      lastSkip = r.skipReason;
      // Roll back the dedupe stamp so we retry next tick.
      if (fired.month) {
        const pm = state.perMonth[fired.month];
        if (pm) delete pm.alerted[fired.condition];
      } else if (
        fired.condition === "silent" ||
        fired.condition === "same_gate_skip" ||
        fired.condition === "self_error_persistent" ||
        fired.condition === "overnight_missed"
      ) {
        delete state.globalAlerted[fired.condition];
      } else if (fired.condition === "windows_parked") {
        // Task #1904 — roll back dedupe stamp AND `lastReportedParkedMonths`
        // so the next tick re-fires the same digest until delivery
        // succeeds. Otherwise a send-failure would silently "consume"
        // the newly-parked signal.
        delete state.globalAlerted.windows_parked;
        state.lastReportedParkedMonths = state.lastReportedParkedMonths.filter(
          () => false,
        );
      } else if (fired.condition === "overnight_window_idle") {
        // The window state was cleared during evaluation so a retry
        // can't re-evaluate it; clearing the dedupe stamp alone would
        // never re-fire. Best-effort: clear the stamp so a *future*
        // overnight window isn't suppressed by a stale send-fail
        // dedupe. The lost alert for this particular window is
        // logged via the surrounding decision=skipped_send_failed.
        delete state.globalAlerted[fired.condition];
      }
    }
  }

  await saveState(state);
  if (anyDelivered) {
    result.decision = "alerted";
  } else {
    result.decision = "skipped_send_failed";
    result.skipReason = lastSkip;
  }
  return result;
}

// ──────────────── Status (read-only, for admin UI) ────────────────

export interface RegressionAlertStatusArmedDedupe {
  scope: "global" | "month";
  condition: RegressionCondition | "silent" | "same_gate_skip";
  month: string | null;
  firedAt: string;
  expiresAt: string;
}

export interface RegressionAlertStatus {
  enabled: boolean;
  killSwitchKey: string;
  thresholds: {
    gapGrowthTicks: number;
    silentMinutes: number;
    sameGateSkipTicks: number;
    noConvergenceRuns: number;
    unrecoveredRetryAttempts: number;
  };
  defaults: typeof DEFAULTS;
  cooldownMinutes: number;
  historyPerMonth: number;
  notificationId: string;
  lastEvaluatedAt: string | null;
  lastObservedRanAt: string | null;
  sameSkipReason: string | null;
  sameSkipStreak: number;
  armedDedupes: RegressionAlertStatusArmedDedupe[];
  recentFired: RecentFiredEntry[];
  perMonthHistoryCount: number;
}

export async function getFrontAutoClosureRegressionAlertStatus(
  now: number = Date.now(),
): Promise<RegressionAlertStatus> {
  const [cfg, state] = await Promise.all([loadConfig(), loadState()]);
  const cooldownMs = COOLDOWN_MINUTES * 60_000;
  const armed: RegressionAlertStatusArmedDedupe[] = [];
  const pushArmed = (
    scope: "global" | "month",
    condition: RegressionAlertStatusArmedDedupe["condition"],
    month: string | null,
    iso: string | undefined,
  ) => {
    if (!iso) return;
    const firedAtMs = new Date(iso).getTime();
    if (!Number.isFinite(firedAtMs)) return;
    if (now - firedAtMs >= cooldownMs) return;
    armed.push({
      scope,
      condition,
      month,
      firedAt: iso,
      expiresAt: new Date(firedAtMs + cooldownMs).toISOString(),
    });
  };
  pushArmed("global", "silent", null, state.globalAlerted.silent);
  pushArmed(
    "global",
    "same_gate_skip",
    null,
    state.globalAlerted.same_gate_skip,
  );
  pushArmed(
    "global",
    "overnight_missed",
    null,
    state.globalAlerted.overnight_missed,
  );
  // Task #1904 — surface parked-window digest dedupe with its own
  // (longer) cooldown so the admin status panel reports a correct
  // expiry instead of the default 6h.
  if (state.globalAlerted.windows_parked) {
    const iso = state.globalAlerted.windows_parked;
    const firedAtMs = new Date(iso).getTime();
    const parkedCooldownMs = cfg.parkedReminderHours * 60 * 60_000;
    if (
      Number.isFinite(firedAtMs) &&
      now - firedAtMs < parkedCooldownMs
    ) {
      armed.push({
        scope: "global",
        condition: "windows_parked",
        month: null,
        firedAt: iso,
        expiresAt: new Date(firedAtMs + parkedCooldownMs).toISOString(),
      });
    }
  }
  for (const [month, pm] of Object.entries(state.perMonth)) {
    for (const [cond, iso] of Object.entries(pm.alerted)) {
      pushArmed("month", cond as RegressionCondition, month, iso);
    }
  }
  armed.sort((a, b) => (a.firedAt < b.firedAt ? 1 : -1));

  return {
    enabled: cfg.enabled,
    killSwitchKey: SETTING_ENABLED,
    thresholds: {
      gapGrowthTicks: cfg.gapGrowthTicks,
      silentMinutes: cfg.silentMinutes,
      sameGateSkipTicks: cfg.sameGateSkipTicks,
      noConvergenceRuns: cfg.noConvergenceRuns,
      unrecoveredRetryAttempts: cfg.unrecoveredRetryAttempts,
    },
    defaults: DEFAULTS,
    cooldownMinutes: COOLDOWN_MINUTES,
    historyPerMonth: HISTORY_PER_MONTH,
    notificationId: NOTIFICATION_ID,
    lastEvaluatedAt: state.lastEvaluatedAt,
    lastObservedRanAt: state.lastObservedRanAt,
    sameSkipReason: state.sameSkipReason,
    sameSkipStreak: state.sameSkipStreak,
    armedDedupes: armed,
    recentFired: [...state.recentFired].slice(-RECENT_FIRED_LIMIT).reverse(),
    perMonthHistoryCount: Object.keys(state.perMonth).length,
  };
}

// ──────────────── Test helpers ────────────────

export const __frontAutoClosureRegressionAlertsTestHelpers = {
  NOTIFICATION_ID,
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  setSnapshotOverrideForTests(
    snapshot: AutoClosureStateSnapshot | null,
  ): void {
    snapshotOverride = snapshot;
  },
  // Bypass the system_settings-backed state load/save round-trip so the
  // test process is fully insulated from background workers running the
  // same alerter on the shared dev DB. Pass `emptyState()` shape to seed
  // a fresh state, or `null` to restore production behaviour.
  setStateOverrideForTests(state: RegressionAlertState | null): void {
    stateOverride = state;
  },
  emptyStateForTests(): RegressionAlertState {
    return emptyState();
  },
  setConfigOverrideForTests(cfg: any | null): void {
    configOverride = cfg;
  },
  HISTORY_PER_MONTH,
};
