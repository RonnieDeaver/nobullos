/**
 * Task #1682 — Front self-healing coverage loop (core auto-closer).
 *
 * Orchestrator that runs after every `front_analytics_coverage_refresh`
 * tick. It inspects `front_analytics_monthly_coverage` and:
 *   1. Auto-retries recoverable error rows (calls `refreshMonth`).
 *   2. Auto-enqueues Front Historical Recovery for months whose ingest
 *      gap exceeds the configured threshold.
 *   3. Auto-nudges the canonical `front_webhook_apply` path for months
 *      whose apply gap exceeds the configured threshold (re-enqueues
 *      existing `source_event_log` / `work_result_log` pairs — never
 *      writes to `front_sync_emails` or `raw_communication_records`).
 *
 * MEASUREMENT + ORCHESTRATION ONLY. This file never invents a new
 * ingestion, normalize, or apply path. It only delegates to existing
 * primitives that already enforce normalization, dedupe, and write
 * policy. All gates are honored: master kill switch →
 * `KILL_SWITCH_NON_CRITICAL_SWEEPS` → `front_analytics_refresh_enabled`
 * → per-queue pause → DB pool pressure → permanent `unrecoverable`
 * flags → per-month cooldown → per-tick budgets.
 *
 * Overnight aggressive mode and regression alerts on the auto-healer
 * itself are explicitly out of scope (separate follow-up tasks).
 */
// @db-pool-intent: worker
// All call sites of runFrontAutoClosureTick wrap the tick in
// runWithWorkerDb (see handleFrontAutoClosureTick and the legacy
// embedded invocation inside handleFrontAnalyticsCoverageRefresh), so
// getDb() inside this file resolves to the worker pool via the
// AsyncLocalStorage context established by runWithWorkerDb. The
// per-call-site attribution is satisfied by the baseline file
// (scripts/lint-getdb-attribution.baseline.txt) because the
// surrounding handlers already declare the attribution namespace.
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db, getDb, isApiPoolUnderPressure, withDbAttribution } from "../db";
import {
  frontAnalyticsMonthlyCoverage,
  type FrontAnalyticsMonthlyCoverage,
} from "@shared/schema";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { PERF } from "../perfConfig";
import { isQueuePaused } from "./queueDrainControl";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";
import { workerLog } from "./workerLogger";
import {
  QUEUE_NAME as COVERAGE_QUEUE_NAME,
  SETTING_REFRESH_ENABLED,
  refreshMonth,
  currentMonthLabel,
} from "./frontAnalyticsCoverage";
import { frontAuthBreakerActive } from "./frontAuthBreaker";

// ──────────────── Settings ────────────────

export const SETTING_ENABLED = "front_auto_closure_enabled";
export const SETTING_RETRY_BUDGET = "front_auto_closure_retry_budget";
export const SETTING_INGEST_RECOVERY_BUDGET =
  "front_auto_closure_ingest_recovery_budget";
export const SETTING_APPLY_NUDGE_BUDGET =
  "front_auto_closure_apply_nudge_budget";
export const SETTING_INGEST_GAP_COUNT =
  "front_auto_closure_ingest_gap_threshold_count";
export const SETTING_INGEST_GAP_PCT =
  "front_auto_closure_ingest_gap_threshold_percent";
export const SETTING_APPLY_GAP_COUNT =
  "front_auto_closure_apply_gap_threshold_count";
export const SETTING_APPLY_GAP_PCT =
  "front_auto_closure_apply_gap_threshold_percent";
export const SETTING_COOLDOWN_MINUTES =
  "front_auto_closure_reenqueue_cooldown_minutes";
export const SETTING_MAX_RECOVERY_RUNS_PER_DAY =
  "front_auto_closure_max_recovery_runs_per_day";
// Task #1885 — park-after-N-dead-runs guard. A "dead run" is a window
// whose latest recovery checkpoint shows
// `safety_max_pages_reached_resume_available` AND `ingested === 0`
// (the canonical "scanned 25k, ingested zero, every page already a
// dupe" pattern documented in
// `docs/front-recovery-zero-ingest-2026-05-26.md`). When the streak
// reaches this many runs in a row we park the window so the
// auto-closure loop stops burning ~25k Front API requests per cycle
// on a window that cannot make forward progress under the current
// sort_by=date + page-cap combination. Set to 0 to disable parking.
export const SETTING_PARK_AFTER_DEAD_RUNS =
  "front_auto_closure_park_after_dead_runs";
// Task #1905 — auto-close dedupe-only dead recovery windows. When the
// recovery worker has hit `closeAfterDedupeOnlyRuns` consecutive dead
// runs (per the Task #1885 streak) AND the cumulative dedupe rate for
// the month is at/above `closeDedupePctMin` AND a sample of
// `front_sync_emails` for the month shows ≥ `closeAppliedPctMin` of
// rows already in `pipeline_state='applied'`, the row is marked
// `closed_via='webhook_dedupe'` and auto-closure stops treating it as
// a gap candidate. Set `closeAfterDedupeOnlyRuns=0` to disable.
export const SETTING_CLOSE_AFTER_DEDUPE_ONLY_RUNS =
  "front_auto_closure_close_after_dedupe_only_runs";
export const SETTING_CLOSE_DEDUPE_PCT_MIN =
  "front_auto_closure_close_dedupe_pct_min";
export const SETTING_CLOSE_APPLIED_PCT_MIN =
  "front_auto_closure_close_applied_pct_min";
export const SETTING_CLOSE_APPLIED_SAMPLE_MIN =
  "front_auto_closure_close_applied_sample_min";

// Task #1683 — overnight aggressive mode settings.
export const SETTING_OVERNIGHT_ENABLED = "front_auto_closure_overnight_enabled";
export const SETTING_OVERNIGHT_TIMEZONE = "front_auto_closure_timezone";
export const SETTING_OVERNIGHT_START_HOUR =
  "front_auto_closure_overnight_start_hour";
export const SETTING_OVERNIGHT_END_HOUR =
  "front_auto_closure_overnight_end_hour";
export const SETTING_OVERNIGHT_RETRY_BUDGET =
  "front_auto_closure_overnight_retry_budget";
export const SETTING_OVERNIGHT_INGEST_RECOVERY_BUDGET =
  "front_auto_closure_overnight_ingest_recovery_budget";
export const SETTING_OVERNIGHT_APPLY_NUDGE_BUDGET =
  "front_auto_closure_overnight_apply_nudge_budget";
// Task #1683 — dead-letter growth safety cutoff. When the Front
// pipeline's dead-letter count grows by more than this delta between
// two consecutive ticks the whole auto-closer short-circuits (in BOTH
// daytime and overnight modes) until the count stabilizes. Prevents
// overnight aggressive budgets from piling work onto a pipeline that
// is already shedding rows to the dead-letter queue.
export const SETTING_DEAD_LETTER_GROWTH_THRESHOLD =
  "front_auto_closure_dead_letter_growth_threshold";

/**
 * Persisted orchestrator state. Stored as JSON in the single
 * `front_auto_closure_state` system_settings row so the per-month
 * cooldown, last-run summary, and daily recovery-run counter survive
 * restarts.
 */
export const SETTING_STATE = "front_auto_closure_state";

const DEFAULTS = {
  enabled: true,
  // Warp-drain defaults (2026-05-26): the previous conservative values
  // (retryBudget=2, ingestRecoveryBudget=1, cooldownMinutes=360) meant
  // the auto-heal loop touched 1 month per ~17s tick and then locked
  // that month for 6 hours, so a 13-month / 123k-message ingest gap
  // would take weeks to drain even though the historical recovery
  // worker, Front rate-limit guard, same-response suppression, and
  // active-inbox filter were all already in place to keep aggressive
  // enqueues safe. Raising these here makes self-heal continuous by
  // default — operators can still throttle via system_settings keys
  // (`front_auto_closure_*`) if Front pushes back. See replit.md
  // "Front warp self-heal" for the rationale.
  retryBudget: 10,
  ingestRecoveryBudget: 25,
  applyNudgeBudget: 100,
  ingestGapCount: 500,
  ingestGapPct: 5.0,
  applyGapCount: 500,
  applyGapPct: 5.0,
  cooldownMinutes: 20,
  maxRecoveryRunsPerDay: null as number | null,
  // Task #1885 — three consecutive dead runs before the window is
  // parked. With a 20-minute per-month cooldown this gives a window
  // roughly an hour to demonstrate any forward progress before we
  // stop spending Front API budget on it.
  parkAfterDeadRuns: 3,
  // Task #1905 — close (resolve) the window after 2 consecutive dead
  // runs *if* apply-layer confirms the conversations already landed.
  // This is strictly less than `parkAfterDeadRuns` so a dedupe-only
  // resolved window closes before the park guard would otherwise just
  // freeze it. If the apply check fails the row keeps streaking toward
  // park instead. Set to 0 to disable the close path entirely.
  closeAfterDedupeOnlyRuns: 2,
  // 99% dedupe = "every page already known to NoBull".
  closeDedupePctMin: 0.99,
  // 95% applied across the apply-layer sample is the resolved
  // threshold; lower means the apply layer is still working through
  // the backlog and we should not declare the gap resolved.
  closeAppliedPctMin: 0.95,
  // Need at least this many front_sync_emails rows for the month
  // before the apply-layer ratio is statistically meaningful.
  closeAppliedSampleMin: 50,
  // Task #1683 — overnight aggressive mode defaults.
  overnightEnabled: true,
  overnightTimezone: "America/Chicago",
  overnightStartHour: 0,
  overnightEndHour: 5,
  overnightRetryBudget: 10,
  overnightIngestRecoveryBudget: 3,
  overnightApplyNudgeBudget: 500,
  deadLetterGrowthThreshold: 100,
};

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

function parseNum(raw: string | undefined | null, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseOptNum(
  raw: string | undefined | null,
  fallback: number | null,
): number | null {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function loadConfig() {
  const get = async (k: string) =>
    (await getSystemSetting(k).catch(() => null))?.value ?? null;
  return {
    enabled: parseBool(await get(SETTING_ENABLED), DEFAULTS.enabled),
    retryBudget: Math.max(
      0,
      Math.floor(parseNum(await get(SETTING_RETRY_BUDGET), DEFAULTS.retryBudget)),
    ),
    ingestRecoveryBudget: Math.max(
      0,
      Math.floor(
        parseNum(
          await get(SETTING_INGEST_RECOVERY_BUDGET),
          DEFAULTS.ingestRecoveryBudget,
        ),
      ),
    ),
    applyNudgeBudget: Math.max(
      0,
      Math.floor(
        parseNum(
          await get(SETTING_APPLY_NUDGE_BUDGET),
          DEFAULTS.applyNudgeBudget,
        ),
      ),
    ),
    ingestGapCount: Math.max(
      0,
      Math.floor(
        parseNum(await get(SETTING_INGEST_GAP_COUNT), DEFAULTS.ingestGapCount),
      ),
    ),
    ingestGapPct: parseNum(
      await get(SETTING_INGEST_GAP_PCT),
      DEFAULTS.ingestGapPct,
    ),
    applyGapCount: Math.max(
      0,
      Math.floor(
        parseNum(await get(SETTING_APPLY_GAP_COUNT), DEFAULTS.applyGapCount),
      ),
    ),
    applyGapPct: parseNum(
      await get(SETTING_APPLY_GAP_PCT),
      DEFAULTS.applyGapPct,
    ),
    cooldownMinutes: Math.max(
      0,
      Math.floor(
        parseNum(await get(SETTING_COOLDOWN_MINUTES), DEFAULTS.cooldownMinutes),
      ),
    ),
    maxRecoveryRunsPerDay: parseOptNum(
      await get(SETTING_MAX_RECOVERY_RUNS_PER_DAY),
      DEFAULTS.maxRecoveryRunsPerDay,
    ),
    parkAfterDeadRuns: Math.max(
      0,
      Math.floor(
        parseNum(
          await get(SETTING_PARK_AFTER_DEAD_RUNS),
          DEFAULTS.parkAfterDeadRuns,
        ),
      ),
    ),
    closeAfterDedupeOnlyRuns: Math.max(
      0,
      Math.floor(
        parseNum(
          await get(SETTING_CLOSE_AFTER_DEDUPE_ONLY_RUNS),
          DEFAULTS.closeAfterDedupeOnlyRuns,
        ),
      ),
    ),
    closeDedupePctMin: Math.min(
      1,
      Math.max(
        0,
        parseNum(
          await get(SETTING_CLOSE_DEDUPE_PCT_MIN),
          DEFAULTS.closeDedupePctMin,
        ),
      ),
    ),
    closeAppliedPctMin: Math.min(
      1,
      Math.max(
        0,
        parseNum(
          await get(SETTING_CLOSE_APPLIED_PCT_MIN),
          DEFAULTS.closeAppliedPctMin,
        ),
      ),
    ),
    closeAppliedSampleMin: Math.max(
      0,
      Math.floor(
        parseNum(
          await get(SETTING_CLOSE_APPLIED_SAMPLE_MIN),
          DEFAULTS.closeAppliedSampleMin,
        ),
      ),
    ),
    // Task #1683 — overnight aggressive mode config.
    overnightEnabled: parseBool(
      await get(SETTING_OVERNIGHT_ENABLED),
      DEFAULTS.overnightEnabled,
    ),
    overnightTimezone: sanitizeTimezone(
      (await get(SETTING_OVERNIGHT_TIMEZONE)) ?? DEFAULTS.overnightTimezone,
    ),
    overnightStartHour: clampHour(
      parseNum(
        await get(SETTING_OVERNIGHT_START_HOUR),
        DEFAULTS.overnightStartHour,
      ),
    ),
    overnightEndHour: clampHour(
      parseNum(
        await get(SETTING_OVERNIGHT_END_HOUR),
        DEFAULTS.overnightEndHour,
      ),
    ),
    overnightRetryBudget: Math.max(
      0,
      Math.floor(
        parseNum(
          await get(SETTING_OVERNIGHT_RETRY_BUDGET),
          DEFAULTS.overnightRetryBudget,
        ),
      ),
    ),
    overnightIngestRecoveryBudget: Math.max(
      0,
      Math.floor(
        parseNum(
          await get(SETTING_OVERNIGHT_INGEST_RECOVERY_BUDGET),
          DEFAULTS.overnightIngestRecoveryBudget,
        ),
      ),
    ),
    overnightApplyNudgeBudget: Math.max(
      0,
      Math.floor(
        parseNum(
          await get(SETTING_OVERNIGHT_APPLY_NUDGE_BUDGET),
          DEFAULTS.overnightApplyNudgeBudget,
        ),
      ),
    ),
    deadLetterGrowthThreshold: Math.max(
      0,
      Math.floor(
        parseNum(
          await get(SETTING_DEAD_LETTER_GROWTH_THRESHOLD),
          DEFAULTS.deadLetterGrowthThreshold,
        ),
      ),
    ),
    // Inherited analytics refresh gate. Folded into the config object so
    // tests can drive ticks past (or into) this gate via `configOverride`
    // without mutating the process-global `front_analytics_refresh_enabled`
    // setting that the live dev server also reads. Production behavior is
    // unchanged: the value is still read fresh from system_settings every
    // tick, at the same point in the flow as the standalone read it
    // replaced.
    analyticsRefreshEnabled: parseBool(
      await get(SETTING_REFRESH_ENABLED),
      true,
    ),
  };
}

/**
 * The resolved auto-closure configuration produced by {@link loadConfig}.
 * Exposed so tests can build a `configOverride` (a `Partial` of this) and
 * drive {@link runFrontAutoClosureTick} deterministically without writing
 * to the shared `system_settings` table — see the doc comment on
 * `runFrontAutoClosureTick`.
 */
export type FrontAutoClosureConfig = Awaited<ReturnType<typeof loadConfig>>;

// ──────────────── Task #1683: dead-letter growth safety cutoff ────────────────

/**
 * Test seam: when set, the dead-letter count gate calls this in place
 * of the real Postgres query so suites can simulate spikes without
 * polluting `work_result_log`. Production code never installs an
 * override.
 */
let __deadLetterCountOverride: (() => Promise<number>) | null = null;
export function __setFrontAutoClosureDeadLetterCountOverride(
  fn: (() => Promise<number>) | null,
): void {
  __deadLetterCountOverride = fn;
}

/**
 * Count of `work_result_log` rows currently in `dead_lettered` status
 * for Front pipeline sources. Cheap (indexed status filter) and safe —
 * the gate falls back to "skip the gate this tick" if the query throws,
 * so a transient DB blip cannot wedge the auto-closer.
 */
async function getFrontDeadLetterCount(): Promise<number> {
  if (__deadLetterCountOverride) return __deadLetterCountOverride();
  const result = await getDb().execute(sql`
    SELECT count(*)::int AS count
    FROM work_result_log
    WHERE status = 'dead_lettered'
      AND source_system LIKE 'front%'
  `);
  const row = (result as any).rows?.[0] ?? (result as any)[0];
  const c = Number(row?.count ?? 0);
  return Number.isFinite(c) ? c : 0;
}

// ──────────────── Task #1683: timezone-aware mode detector ────────────────

function clampHour(h: number): number {
  if (!Number.isFinite(h)) return 0;
  const n = Math.floor(h);
  if (n < 0) return 0;
  if (n > 23) return 23;
  return n;
}

/**
 * Validate a timezone string by attempting to construct an
 * Intl.DateTimeFormat with it. Falls back to America/Chicago when the
 * configured timezone is invalid so a misconfigured operator setting
 * can't silently break the mode detector.
 */
export function sanitizeTimezone(tz: string): string {
  const candidate = (tz ?? "").trim();
  if (!candidate) return DEFAULTS.overnightTimezone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULTS.overnightTimezone;
  }
}

/**
 * Return the hour-of-day (0-23) for `now` in the configured timezone.
 * Uses Intl.DateTimeFormat which honors DST transitions correctly.
 */
export function getHourInTimezone(now: Date, timezone: string): number {
  const tz = sanitizeTimezone(timezone);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "numeric",
  });
  const parts = fmt.formatToParts(now);
  const raw = parts.find((p) => p.type === "hour")?.value ?? "0";
  let h = parseInt(raw, 10);
  if (!Number.isFinite(h)) h = 0;
  if (h === 24) h = 0; // some engines emit "24" instead of "00"
  if (h < 0 || h > 23) h = 0;
  return h;
}

export type AutoClosureMode = "daytime" | "overnight";

/**
 * Decide whether the auto-closer is in daytime or overnight mode.
 *
 * - When overnight mode is disabled, always returns `"daytime"`.
 * - When start == end the window is empty — `"daytime"`.
 * - When start < end (e.g. 0..5) the window is `[start, end)` and the
 *   hour falls inside it.
 * - When start > end (wrap-around, e.g. 22..5) the window spans
 *   midnight: `hour >= start || hour < end`.
 *
 * The end hour is exclusive in both cases so a 0..5 setting covers
 * 00:00–04:59:59 (matching the task default phrasing "12:00–05:00").
 */
export function detectMode(opts: {
  now: Date;
  timezone: string;
  startHour: number;
  endHour: number;
  overnightEnabled: boolean;
}): AutoClosureMode {
  if (!opts.overnightEnabled) return "daytime";
  const start = clampHour(opts.startHour);
  const end = clampHour(opts.endHour);
  if (start === end) return "daytime";
  const h = getHourInTimezone(opts.now, opts.timezone);
  if (start < end) {
    return h >= start && h < end ? "overnight" : "daytime";
  }
  return h >= start || h < end ? "overnight" : "daytime";
}

// ──────────────── Persisted state ────────────────

interface SkipCounters {
  unrecoverable: number;
  cooldown: number;
  budget: number;
  in_flight: number;
  threshold: number;
  queue_paused: number;
  auth_failed: number;
  no_work_items: number;
  // Task #1885 — window is parked because its last N runs all hit the
  // page cap with zero forward progress.
  parked: number;
  // Task #2088 — window was auto-closed via the dedupe-only path
  // (`closed_via='webhook_dedupe'`). Previously folded into `parked`;
  // split out so the operator UI can show "parked" vs "closed (webhook
  // dedupe)" separately. Older persisted summaries lack this key, so
  // every reader must default it to 0.
  dedupe_closed: number;
}

export interface AutoClosureRunSummary {
  ranAt: string;
  enabled: boolean;
  skippedReason?: string;
  monthsInspected: number;
  errorsRetried: number;
  errorRetrySuccesses: number;
  ingestRecoveriesEnqueued: number;
  applyNudgesEnqueued: number;
  recoveryDailyCounter: number;
  skips: SkipCounters;
  errorsByReason: Record<string, number>;
  lastSelfError: string | null;
  monthsActed: string[];
  // Task #1683 — overnight aggressive mode.
  mode: AutoClosureMode;
  effectiveBudgets: {
    retry: number;
    ingestRecovery: number;
    applyNudge: number;
  };
}

// Task #1885 — per-month dead-run streak tracker. `lastCheckpointAt`
// is the `completedAt` of the most recent checkpoint we've already
// folded into the streak count, so subsequent ticks only re-evaluate
// when the recovery worker has actually emitted a fresh checkpoint.
export interface DeadRunStreakEntry {
  count: number;
  lastCheckpointAt: string | null;
}

// Task #2085 — per-window outcome of a search-strategy re-run (either
// the automatic pre-park escalation or the operator one-press re-arm).
// Stamped onto the parked entry / surfaced in status so Phase 3 panels
// can show what happened to each frozen month.
export interface SearchReArmOutcome {
  // "ingested"        — the search re-run pulled new conversations.
  // "resolved_covered" — the search re-run walked the whole window and
  //                      found nothing missing (the month is genuinely
  //                      covered now).
  // "still_empty"     — even under the search strategy the window hit
  //                      the page cap with 0 ingested (stays parked).
  // "error"           — the re-run failed / was blocked (stays parked).
  kind: "ingested" | "resolved_covered" | "still_empty" | "error";
  ingested?: number;
  at: string;
  source: "auto_escalation" | "operator_rearm";
  detail?: string;
}

// Task #2085 — record of an automatic pre-park search-strategy
// escalation that is in flight (a window cleared its legacy checkpoint
// and is re-running once under the search strategy before we decide to
// park it). Persisted so the escalation fires at most once per window
// and the park decision can wait for the escalated re-run to complete.
export interface SearchEscalationEntry {
  escalatedAt: string;
  // `completedAt` of the legacy dead-run checkpoint that triggered the
  // escalation. We only park after escalation once the checkpoint's
  // `completedAt` has advanced past this value (i.e. the escalated
  // search re-run actually produced a fresh checkpoint).
  triggeredByCheckpointAt: string | null;
  deadRunsAtEscalation: number;
}

// Task #1885 — parked window record. Persisted so an operator can
// see in the admin UI which windows are parked and why, and so the
// auto-closure loop continues to skip them across restarts.
export interface ParkedWindowEntry {
  parkedAt: string;
  reason: string;
  deadRuns: number;
  lastCheckpointAt: string | null;
  // Task #2085 — true once this window has already been migrated to the
  // search strategy via the automatic pre-park escalation, so it is
  // never escalated a second time.
  searchEscalated?: boolean;
  searchEscalatedAt?: string;
  // Task #2085 — latest search re-run outcome (auto escalation or
  // operator re-arm). Present on windows that stayed parked after a
  // search re-run; queryable by Phase 3.
  reArmOutcome?: SearchReArmOutcome;
  // Task #2230 — how many times in a row the re-arm of this window has
  // returned the transient `error` outcome (e.g. blocked:auth). Lets an
  // operator tell a window that keeps failing to recover (auth-blocked,
  // climbing count) apart from one that re-ran cleanly but found nothing
  // (`still_empty`). Incremented on each consecutive `error` re-arm;
  // reset to 0 the moment a re-arm produces any non-`error` outcome.
  reArmConsecutiveErrors?: number;
}

// Task #2088 — bounded park/unpark event breadcrumb log. This is
// observability only: it records *that* a window was parked or
// (auto/operator) un-parked and when, so the admin trends panel can
// chart "parked this period" / "auto-unparked this period". It does
// NOT change any recovery decision — the recovery behavior is driven
// entirely by `parkedWindows` / `deadRunStreak` as before. Capped so
// the persisted JSON blob can't grow unbounded; park events are rare.
export type ParkEventType = "parked" | "auto_unparked" | "operator_unparked";
export interface ParkEventEntry {
  at: string; // ISO timestamp
  month: string;
  type: ParkEventType;
  deadRuns?: number;
}
const PARK_EVENT_LOG_MAX = 300;

function recordParkEvent(state: PersistedState, ev: ParkEventEntry): void {
  if (!Array.isArray(state.parkEvents)) state.parkEvents = [];
  state.parkEvents.push(ev);
  if (state.parkEvents.length > PARK_EVENT_LOG_MAX) {
    state.parkEvents = state.parkEvents.slice(-PARK_EVENT_LOG_MAX);
  }
}

export interface PersistedState {
  lastSummary: AutoClosureRunSummary | null;
  cooldowns: Record<string, string>; // month -> ISO timestamp when cooldown lifts
  recoveryDay: string | null; // YYYY-MM-DD
  recoveryRunsToday: number;
  // Task #1885 — per-month dead-run streak counter and the set of
  // currently parked windows. Both are durable across restarts.
  deadRunStreak?: Record<string, DeadRunStreakEntry>;
  parkedWindows?: Record<string, ParkedWindowEntry>;
  // Task #2085 — in-flight automatic pre-park search escalations,
  // keyed by month. Durable across restarts so an escalation fires at
  // most once per window and the park decision can wait for the
  // escalated search re-run to land a fresh checkpoint.
  searchEscalations?: Record<string, SearchEscalationEntry>;
  // Task #2088 — bounded park/unpark breadcrumb log (observability only).
  parkEvents?: ParkEventEntry[];
  // Task #1683 — dead-letter growth sample from the previous tick.
  // Compared against the current tick's count to detect a spike; nulls
  // on first run / after manual state reset and the gate becomes
  // measure-only that tick.
  lastDeadLetterCount?: number | null;
  lastDeadLetterSampleAt?: string | null;
  // Task #1694 — most recent tick observed in overnight aggressive
  // mode. Consumed by `frontAutoClosureRegressionAlerts.ts` to detect
  // a missed overnight window. Recorded whenever the auto-closer
  // executes a tick whose computed mode is `overnight`, regardless of
  // whether the tick acted or short-circuited on a gate — the signal
  // is "the worker was alive during overnight hours", not "the worker
  // did work".
  lastOvernightRanAt?: string | null;
}

const EMPTY_STATE: PersistedState = {
  lastSummary: null,
  cooldowns: {},
  recoveryDay: null,
  recoveryRunsToday: 0,
  deadRunStreak: {},
  parkedWindows: {},
  searchEscalations: {},
  parkEvents: [],
  lastDeadLetterCount: null,
  lastDeadLetterSampleAt: null,
  lastOvernightRanAt: null,
};

/**
 * Pluggable backing store for the auto-closure orchestrator run-state
 * (the `deadRunStreak` / parked-window / escalation / last-summary blob
 * that normally lives in the global `front_auto_closure_state` setting).
 *
 * Production always uses the default DB-backed store (read via
 * {@link loadState}, written via {@link saveState}). Tests can inject an
 * in-memory store (see {@link createInMemoryStateStore}) so they can seed
 * and inspect streak/escalation state without read-modify-writing the
 * process-global setting that the always-on dev-server tick and sibling
 * suites also write — the same hermetic-isolation pattern as
 * `configOverride`. See `.agents/memory/test-db-pool-exit-and-contention.md`.
 */
export interface FrontAutoClosureStateStore {
  load(): Promise<PersistedState>;
  save(state: PersistedState): Promise<void>;
}

function cloneState(s: PersistedState): PersistedState {
  return JSON.parse(JSON.stringify(s)) as PersistedState;
}

/**
 * Build an in-memory {@link FrontAutoClosureStateStore} for tests. The
 * optional `seed` is shallow-merged over {@link EMPTY_STATE} so a suite
 * only specifies the keys it cares about (e.g. a primed `deadRunStreak`).
 * `load`/`save` deep-clone on the way in and out, mirroring the JSON
 * round-trip through `system_settings`, so neither the tick nor the test
 * can accidentally alias and mutate the other's copy. Test-only.
 */
export function createInMemoryStateStore(
  seed?: Partial<PersistedState>,
): FrontAutoClosureStateStore {
  let current: PersistedState = {
    ...EMPTY_STATE,
    cooldowns: {},
    ...(seed ? cloneState(seed as PersistedState) : {}),
  };
  return {
    load() {
      return Promise.resolve(cloneState(current));
    },
    save(s: PersistedState) {
      current = cloneState(s);
      return Promise.resolve();
    },
  };
}

// Test-only: when set, the module-global `loadState` / `saveState` route
// through this injected store instead of the `front_auto_closure_state`
// system setting. This lets suites that exercise code paths which cannot
// thread an explicit `stateStore` param — e.g. the prod-action registry
// handler, which calls `startParkedWindowReArmDrain` / `listReArmableParkedWindows`
// positionally — still run hermetically against an in-memory store. Each
// test process is its own child, so this process-local override never
// races the always-on dev-server tick (Task #2239). Production never sets
// it, so behavior is unchanged when null.
let testStateStoreOverride: FrontAutoClosureStateStore | null = null;
export function __setFrontAutoClosureStateStoreForTest(
  store: FrontAutoClosureStateStore | null,
): void {
  testStateStoreOverride = store;
}

async function loadState(): Promise<PersistedState> {
  if (testStateStoreOverride) return testStateStoreOverride.load();
  const raw = (await getSystemSetting(SETTING_STATE).catch(() => null))?.value;
  if (!raw) return { ...EMPTY_STATE, cooldowns: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      lastSummary: parsed.lastSummary ?? null,
      cooldowns:
        parsed.cooldowns && typeof parsed.cooldowns === "object"
          ? parsed.cooldowns
          : {},
      recoveryDay: parsed.recoveryDay ?? null,
      recoveryRunsToday:
        typeof parsed.recoveryRunsToday === "number"
          ? parsed.recoveryRunsToday
          : 0,
      deadRunStreak:
        parsed.deadRunStreak && typeof parsed.deadRunStreak === "object"
          ? parsed.deadRunStreak
          : {},
      parkedWindows:
        parsed.parkedWindows && typeof parsed.parkedWindows === "object"
          ? parsed.parkedWindows
          : {},
      searchEscalations:
        parsed.searchEscalations && typeof parsed.searchEscalations === "object"
          ? parsed.searchEscalations
          : {},
      parkEvents: Array.isArray(parsed.parkEvents) ? parsed.parkEvents : [],
      lastDeadLetterCount:
        typeof parsed.lastDeadLetterCount === "number"
          ? parsed.lastDeadLetterCount
          : null,
      lastDeadLetterSampleAt: parsed.lastDeadLetterSampleAt ?? null,
      lastOvernightRanAt: parsed.lastOvernightRanAt ?? null,
    };
  } catch {
    return { ...EMPTY_STATE, cooldowns: {} };
  }
}

async function saveState(s: PersistedState): Promise<void> {
  if (testStateStoreOverride) {
    await testStateStoreOverride.save(s);
    return;
  }
  await setSystemSetting(SETTING_STATE, JSON.stringify(s), "system").catch(
    (err: any) => {
      console.warn(
        `[FrontAutoClosure] failed to persist state: ${err?.message ?? err}`,
      );
    },
  );
}

// ──────────────── Helpers ────────────────

function newSkipCounters(): SkipCounters {
  return {
    unrecoverable: 0,
    cooldown: 0,
    budget: 0,
    in_flight: 0,
    threshold: 0,
    queue_paused: 0,
    auth_failed: 0,
    no_work_items: 0,
    parked: 0,
    dedupe_closed: 0,
  };
}

function monthBoundaries(month: string): {
  monthStart: Date;
  monthEnd: Date;
} {
  const [yy, mm] = month.split("-").map(Number);
  return {
    monthStart: new Date(Date.UTC(yy, mm - 1, 1, 0, 0, 0, 0)),
    monthEnd: new Date(Date.UTC(yy, mm, 1, 0, 0, 0, 0)),
  };
}

function isAuthFailureError(row: FrontAnalyticsMonthlyCoverage): boolean {
  const msg = row.frontAnalyticsError ?? "";
  return msg.startsWith("front_analytics_auth_failed");
}

function isRateLimitError(row: { frontAnalyticsError: string | null }): boolean {
  const msg = row.frontAnalyticsError ?? "";
  return msg.startsWith("front_analytics_rate_limited");
}

/**
 * Returns true if any coverage row recorded a Front 429 within the
 * recent window (default 15 minutes). The auto-closure tick defers
 * the entire tick when this is true so refreshMonth + recovery don't
 * pile on a limiter that's already throttling Front access.
 */
async function loadRecentCoverageErrors(): Promise<
  Array<{ frontAnalyticsError: string | null; updatedAt: Date | null }>
> {
  const result = await getDb().execute(sql`
    SELECT front_analytics_error AS "frontAnalyticsError",
           updated_at             AS "updatedAt"
    FROM front_analytics_monthly_coverage
    WHERE front_analytics_error IS NOT NULL
      AND updated_at > NOW() - INTERVAL '15 minutes'
    LIMIT 100
  `);
  const rows = ((result as any).rows ?? (result as unknown as any[])) as any[];
  return rows.map((r) => ({
    frontAnalyticsError: r.frontAnalyticsError ?? null,
    updatedAt: r.updatedAt ? new Date(r.updatedAt) : null,
  }));
}

function rowsHaveRecentRateLimit(
  rows: Array<{ frontAnalyticsError: string | null }>,
): boolean {
  return rows.some(isRateLimitError);
}

/**
 * Worker lease health proxy. If the `front_analytics_coverage_refresh`
 * queue has recorded `stale_lease_exhaustion` terminations in the
 * last 10 minutes, worker leases are flapping and we should defer the
 * entire tick rather than pile recovery + apply work on a worker pool
 * that's already losing leases. The dispatcher records terminations
 * in `work_queue.completion_reason` and `work_queue.status='failed'`.
 */
async function isCoverageLeaseUnhealthy(now: Date): Promise<boolean> {
  const result = await getDb().execute(sql`
    SELECT 1
    FROM work_queue
    WHERE queue_name = ${COVERAGE_QUEUE_NAME}
      AND status = 'failed'
      AND completion_reason IN (
        'stale_lease_exhaustion',
        'max_processing_exhaustion',
        'startup_stale_recovery'
      )
      AND COALESCE(completed_at, updated_at) > ${new Date(
        now.getTime() - 10 * 60_000,
      ).toISOString()}
    LIMIT 1
  `);
  const rows = ((result as any).rows ?? (result as unknown as any[])) as any[];
  return rows.length > 0;
}

function todayUtc(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}-${String(now.getUTCDate()).padStart(2, "0")}`;
}

function isCooldownActive(
  state: PersistedState,
  month: string,
  now: Date,
): boolean {
  const liftIso = state.cooldowns[month];
  if (!liftIso) return false;
  const lift = new Date(liftIso);
  if (!Number.isFinite(lift.getTime())) return false;
  return lift.getTime() > now.getTime();
}

function setCooldown(
  state: PersistedState,
  month: string,
  cooldownMinutes: number,
  now: Date,
): void {
  if (cooldownMinutes <= 0) return;
  state.cooldowns[month] = new Date(
    now.getTime() + cooldownMinutes * 60_000,
  ).toISOString();
}

// ──────────────── Task #1885: park dead recovery windows ────────────────

/**
 * Compute the `system_settings` key under which
 * `frontHistoricalRecovery.saveCheckpoint` persists a window's
 * checkpoint. Mirrors the un-exported `checkpointKey` helper in that
 * module — kept in sync via the matching shape (drops every
 * non-alphanumeric character from the windowLabel).
 */
function recoveryCheckpointKey(windowLabel: string): string {
  return `front_recovery_checkpoint_${windowLabel.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

function autoClosureWindowLabel(month: string): string {
  return `auto_closure:${month}`;
}

interface RecoveryCheckpointShape {
  ingested?: number;
  scanned?: number;
  status?: string;
  statusReason?: string | null;
  completedAt?: string | null;
  // Task #2085 — the saved resume cursor. Its endpoint tells us which
  // strategy produced the dead run: legacy enumeration cursors start
  // with `/conversations?…`, search-strategy cursors with
  // `/conversations/search/…`. A page-cap dead run under the *legacy*
  // strategy is the one that benefits from migrating to search.
  lastPageUrl?: string | null;
}

async function readRecoveryCheckpoint(
  month: string,
): Promise<RecoveryCheckpointShape | null> {
  const key = recoveryCheckpointKey(autoClosureWindowLabel(month));
  const raw = (await getSystemSetting(key).catch(() => null))?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RecoveryCheckpointShape;
  } catch {
    return null;
  }
}

/**
 * "Dead run" classifier — matches the canonical
 * `safety_max_pages_reached_resume_available scanned=N ingested=0`
 * checkpoint shape documented in
 * `docs/front-recovery-zero-ingest-2026-05-26.md`. Any other shape
 * (some forward progress, transient pause, auth blocker, etc.) is
 * NOT a dead run — even a single ingested row is forward progress
 * and resets the streak.
 */
export function isDeadRunCheckpoint(cp: RecoveryCheckpointShape | null): boolean {
  if (!cp) return false;
  const reason = cp.statusReason ?? "";
  if (!reason.includes("safety_max_pages_reached_resume_available")) return false;
  const ingested = typeof cp.ingested === "number" ? cp.ingested : 0;
  return ingested === 0;
}

/**
 * Task #2085 — a dead run that is pinned to the *legacy* `/conversations`
 * enumeration endpoint. These are the windows that the search-strategy
 * migration was built for: a window resumed from a saved legacy cursor
 * keeps enumerating by last-activity date, so re-bumped already-ingested
 * threads saturate the head of the page list and the page cap fires
 * before the missing tail is reached. A dead run already on the search
 * endpoint (`/conversations/search/…`) returns false — escalating it
 * would not change the strategy.
 */
export function isLegacyStrategyDeadRun(
  cp: RecoveryCheckpointShape | null,
): boolean {
  if (!isDeadRunCheckpoint(cp)) return false;
  const lastPageUrl = cp?.lastPageUrl ?? "";
  if (!lastPageUrl) return false;
  if (/\/conversations\/search\//.test(lastPageUrl)) return false;
  return /\/conversations\?/.test(lastPageUrl);
}

/**
 * Task #2085 — gate the automatic pre-park search escalation. It only
 * makes sense when the search-strategy path is actually enabled (the
 * same switch `buildInitialPath` consults); otherwise clearing the
 * checkpoint would just rebuild the legacy enumeration and loop.
 */
function isSearchEscalationEnabled(): boolean {
  return isPoolEpicSwitchEnabled(
    "front_recovery_sparse_month_search_strategy_enabled",
  );
}

/**
 * Inspect the most recent recovery checkpoint for `month` and update
 * the per-month dead-run streak. Returns the streak entry post-update
 * so the caller can decide whether to park.
 *
 * Only re-counts when `completedAt` advances — if the recovery worker
 * hasn't written a new checkpoint since our last tick we leave the
 * counter alone (the previous run is still in-flight from our POV).
 */
function updateDeadRunStreak(
  state: PersistedState,
  month: string,
  cp: RecoveryCheckpointShape | null,
): DeadRunStreakEntry {
  if (!state.deadRunStreak) state.deadRunStreak = {};
  const prev: DeadRunStreakEntry = state.deadRunStreak[month] ?? {
    count: 0,
    lastCheckpointAt: null,
  };
  const cpCompletedAt = cp?.completedAt ?? null;
  // No checkpoint yet — nothing to evaluate.
  if (!cp || !cpCompletedAt) {
    state.deadRunStreak[month] = prev;
    return prev;
  }
  // Same checkpoint we already counted — don't double-count.
  if (prev.lastCheckpointAt === cpCompletedAt) {
    return prev;
  }
  const next: DeadRunStreakEntry = isDeadRunCheckpoint(cp)
    ? { count: prev.count + 1, lastCheckpointAt: cpCompletedAt }
    : { count: 0, lastCheckpointAt: cpCompletedAt };
  state.deadRunStreak[month] = next;
  return next;
}

function isParked(state: PersistedState, month: string): boolean {
  return !!state.parkedWindows?.[month];
}

// ──────────────── Task #1905: close dedupe-only resolved windows ────────────────

/**
 * Test seam mirroring `__deadLetterCountOverride`. When set, the
 * apply-layer sample query is replaced so unit tests can exercise the
 * close path without seeding `front_sync_emails` rows. Production
 * code never installs an override.
 */
let __applyLayerSampleOverride:
  | ((monthStart: Date, monthEnd: Date) => Promise<{ total: number; applied: number }>)
  | null = null;
export function __setFrontAutoClosureApplyLayerSampleOverride(
  fn:
    | ((monthStart: Date, monthEnd: Date) => Promise<{ total: number; applied: number }>)
    | null,
): void {
  __applyLayerSampleOverride = fn;
}

async function sampleApplyLayerForMonth(
  monthStart: Date,
  monthEnd: Date,
): Promise<{ total: number; applied: number }> {
  if (__applyLayerSampleOverride) {
    return __applyLayerSampleOverride(monthStart, monthEnd);
  }
  const result = await withDbAttribution(
    "front_auto_closure:dedupe_only_close_apply_sample",
    () => getDb().execute(sql`
      SELECT
        COUNT(*)::int                                           AS "total",
        COUNT(*) FILTER (WHERE pipeline_state = 'applied')::int AS "applied"
      FROM front_sync_emails
      WHERE last_message_at >= ${monthStart.toISOString()}
        AND last_message_at <  ${monthEnd.toISOString()}
    `),
  );
  const row = ((result as any).rows ?? (result as unknown as any[]))[0] ?? {};
  const total = Number(row.total ?? 0);
  const applied = Number(row.applied ?? 0);
  return {
    total: Number.isFinite(total) ? total : 0,
    applied: Number.isFinite(applied) ? applied : 0,
  };
}

export interface DedupeOnlyCloseDecision {
  closed: boolean;
  reason: string;
  dedupePct: number;
  appliedSample: { total: number; applied: number };
}

/**
 * Decide whether the window for `month` is dedupe-only resolved
 * (phantom gap already covered by the live webhook path) and, if so,
 * write `closed_via='webhook_dedupe'` back to
 * `front_analytics_monthly_coverage` and clear the dead-run streak.
 *
 * Preconditions checked by caller:
 *   • `cfg.closeAfterDedupeOnlyRuns > 0`
 *   • streak count >= `cfg.closeAfterDedupeOnlyRuns`
 *   • row is currently an ingest candidate (otherwise we'd never get
 *     here from the enqueue loop).
 */
async function maybeCloseDedupeOnlyWindow(
  state: PersistedState,
  row: FrontAnalyticsMonthlyCoverage,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
): Promise<DedupeOnlyCloseDecision> {
  const decision: DedupeOnlyCloseDecision = {
    closed: false,
    reason: "",
    dedupePct: 0,
    appliedSample: { total: 0, applied: 0 },
  };

  const { getRecoveryCumulative } = await import("./frontHistoricalRecovery");
  const cumulative = await getRecoveryCumulative().catch(() => ({ months: {} }));
  const cm = (cumulative.months as Record<string, { last_observed_dedupe_pct?: number }> | undefined)?.[row.month];
  const lastDedupePct = cm?.last_observed_dedupe_pct ?? 0;
  decision.dedupePct = lastDedupePct;

  if (lastDedupePct < cfg.closeDedupePctMin) {
    decision.reason = `dedupe_pct_below_min:${lastDedupePct.toFixed(3)}<${cfg.closeDedupePctMin.toFixed(3)}`;
    return decision;
  }

  const { monthStart, monthEnd } = monthBoundaries(row.month);
  const sample = await sampleApplyLayerForMonth(monthStart, monthEnd).catch(
    () => ({ total: 0, applied: 0 }),
  );
  decision.appliedSample = sample;

  if (sample.total < cfg.closeAppliedSampleMin) {
    decision.reason = `sample_too_small:${sample.total}<${cfg.closeAppliedSampleMin}`;
    return decision;
  }
  const appliedPct = sample.total > 0 ? sample.applied / sample.total : 0;
  if (appliedPct < cfg.closeAppliedPctMin) {
    decision.reason = `apply_pct_below_min:${appliedPct.toFixed(3)}<${cfg.closeAppliedPctMin.toFixed(3)}`;
    return decision;
  }

  // All preconditions met — write back the closure attribution. We do
  // NOT zero `ingest_gap` here: the next coverage refresh tick is the
  // authoritative source for the gap math, and resetting it would
  // mask a genuine future regression. The candidate filter relies on
  // `closed_via` alone.
  await withDbAttribution(
    "front_auto_closure:dedupe_only_close_writeback",
    () => getDb().execute(sql`
      UPDATE front_analytics_monthly_coverage
      SET closed_via = 'webhook_dedupe',
          updated_at = NOW()
      WHERE month = ${row.month}
    `),
  );

  // Clear the dead-run streak so an operator-triggered re-enqueue
  // (e.g. after un-park) doesn't immediately re-trip the close path
  // on stale state.
  if (state.deadRunStreak?.[row.month]) {
    delete state.deadRunStreak[row.month];
  }
  // Clear the per-month cooldown so the next refresh tick can run
  // without waiting; the row is no longer a recovery candidate so
  // the cooldown is moot, but tidying state keeps the admin UI clean.
  if (state.cooldowns[row.month]) {
    delete state.cooldowns[row.month];
  }

  decision.closed = true;
  decision.reason = `dedupe_pct=${lastDedupePct.toFixed(3)} applied_pct=${appliedPct.toFixed(3)} sample=${sample.total}`;
  return decision;
}

/**
 * Task #1890 — decide whether a currently-parked window should be
 * auto-unparked on this tick. Two release triggers:
 *
 *   1. The operator cleared the per-window recovery checkpoint
 *      (`front_recovery_checkpoint_*` row deleted, typically via
 *      `runHistoricalRecovery({ resumeMode: "clear_checkpoints" })`).
 *      That is an unambiguous "start this window over" signal.
 *   2. A fresh checkpoint has been written since the parked entry was
 *      recorded AND it shows forward progress (not another dead run).
 *      Any new ingested rows mean the underlying blocker (page-cap
 *      saturation on already-seen convs) has cleared.
 *
 * A still-dead-pattern checkpoint at the same `completedAt` as when
 * we parked must NOT trigger an unpark — that is exactly the
 * condition the park was designed to back off from. Returning `null`
 * means "keep parked".
 */
export function shouldAutoUnparkWindow(
  parked: ParkedWindowEntry | undefined,
  cp: RecoveryCheckpointShape | null,
): { reason: "checkpoint_cleared" | "checkpoint_advanced_with_progress" } | null {
  if (!parked) return null;
  if (cp === null) return { reason: "checkpoint_cleared" };
  if (
    cp.completedAt != null &&
    cp.completedAt !== parked.lastCheckpointAt &&
    !isDeadRunCheckpoint(cp)
  ) {
    return { reason: "checkpoint_advanced_with_progress" };
  }
  return null;
}

function parkWindow(
  state: PersistedState,
  month: string,
  entry: ParkedWindowEntry,
): void {
  if (!state.parkedWindows) state.parkedWindows = {};
  state.parkedWindows[month] = entry;
}

/**
 * Operator un-park: clears the parked entry AND the dead-run streak
 * so the window is fully re-evaluated from scratch on the next tick.
 * Idempotent — un-parking an unknown month is a no-op.
 */
export async function unparkRecoveryWindow(
  month: string,
  stateStore?: FrontAutoClosureStateStore,
): Promise<{
  unparked: boolean;
  month: string;
}> {
  const load = stateStore ? () => stateStore.load() : loadState;
  const save = stateStore ? (s: PersistedState) => stateStore.save(s) : saveState;
  const state = await load();
  let changed = false;
  const wasParked = !!state.parkedWindows?.[month];
  if (state.parkedWindows?.[month]) {
    delete state.parkedWindows[month];
    changed = true;
  }
  if (wasParked) {
    // Task #2088 — breadcrumb for the trends panel's "operator-unparked
    // this period" series. Observability only.
    recordParkEvent(state, {
      at: new Date().toISOString(),
      month,
      type: "operator_unparked",
    });
  }
  // Task #1905 — also clear `closed_via` so an operator un-park makes
  // the row eligible for ingest recovery again. Without this clear the
  // candidate filter would keep skipping the row even after the
  // streak / parked entry were reset.
  try {
    const r: any = await withDbAttribution(
      "front_auto_closure:unpark_clear_closed_via",
      () => getDb().execute(sql`
        UPDATE front_analytics_monthly_coverage
        SET closed_via = NULL,
            updated_at = NOW()
        WHERE month = ${month}
          AND closed_via IS NOT NULL
      `),
    );
    const affected = Number(r?.rowCount ?? r?.rows?.length ?? 0);
    if (affected > 0) changed = true;
  } catch (err: any) {
    console.warn(
      `[FrontAutoClosure] unparkRecoveryWindow: failed to clear closed_via for ${month}: ${err?.message ?? err}`,
    );
  }
  if (state.deadRunStreak?.[month]) {
    delete state.deadRunStreak[month];
    changed = true;
  }
  // Task #2085 — also drop any in-flight search-escalation marker so a
  // fully reset window can escalate again if it dead-runs under the
  // legacy strategy in the future.
  if (state.searchEscalations?.[month]) {
    delete state.searchEscalations[month];
    changed = true;
  }
  if (changed) {
    await save(state);
  }
  return { unparked: changed, month };
}

function pruneStaleCooldowns(state: PersistedState, now: Date): void {
  for (const [m, iso] of Object.entries(state.cooldowns)) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t) || t < now.getTime() - 7 * 24 * 60 * 60_000) {
      delete state.cooldowns[m];
    }
  }
}

// ──────────────── Action: retry error rows ────────────────

async function retryErrorRows(
  rows: FrontAnalyticsMonthlyCoverage[],
  budget: number,
  summary: AutoClosureRunSummary,
  now: Date,
): Promise<void> {
  if (budget <= 0) return;
  // KILL_SWITCH_AUTO_RETRY suppresses every automatic retry path
  // (including this one). When tripped we record the skip reason in
  // skips.budget so the admin panel surfaces it as a "gates" skip.
  if (PERF.KILL_SWITCH_AUTO_RETRY) {
    summary.skips.budget += rows.filter((r) => !!r.frontAnalyticsError).length;
    summary.errorsByReason["gate:kill_switch_auto_retry"] =
      (summary.errorsByReason["gate:kill_switch_auto_retry"] ?? 0) + 1;
    return;
  }
  const candidates = rows.filter(
    (r) =>
      !!r.frontAnalyticsError &&
      !r.unrecoverable &&
      !isAuthFailureError(r),
  );

  // Count skips for visibility.
  for (const r of rows) {
    if (r.frontAnalyticsError && r.unrecoverable) {
      summary.skips.unrecoverable++;
    } else if (r.frontAnalyticsError && isAuthFailureError(r)) {
      summary.skips.auth_failed++;
    }
  }

  // Oldest erroring months first so a long-stuck month gets attention.
  candidates.sort((a, b) => a.month.localeCompare(b.month));

  for (const row of candidates) {
    if (summary.errorsRetried >= budget) {
      summary.skips.budget++;
      continue;
    }
    // Charge the retry-attempt budget BEFORE invoking refreshMonth so a
    // failure-heavy condition (every attempt throws) cannot exceed the
    // intended per-tick attempt budget. The success counter is separate.
    summary.errorsRetried++;
    summary.monthsActed.push(row.month);
    const { monthStart, monthEnd } = monthBoundaries(row.month);
    const isCurrent = row.month === currentMonthLabel(now);
    try {
      const result = await refreshMonth({
        month: row.month,
        monthStart,
        monthEnd,
        isCurrentMonth: isCurrent,
        runId: `auto_closure_retry:${now.toISOString()}`,
      });
      if (result.outcome === "ok" || result.outcome === "ok_current_upsert") {
        summary.errorRetrySuccesses++;
      } else if (result.outcome === "front_error") {
        const code = result.errorCode ?? "front_analytics_report_failed";
        summary.errorsByReason[code] = (summary.errorsByReason[code] ?? 0) + 1;
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      summary.errorsByReason[`retry_throw:${msg.slice(0, 80)}`] =
        (summary.errorsByReason[`retry_throw:${msg.slice(0, 80)}`] ?? 0) + 1;
    }
  }
}

// ──────────────── Action: enqueue Historical Recovery for ingest gaps ────────────────

interface IngestCandidate {
  row: FrontAnalyticsMonthlyCoverage;
  ingestGapPct: number;
  isCurrent: boolean;
}

function isIngestCandidate(
  row: FrontAnalyticsMonthlyCoverage,
  cfg: { ingestGapCount: number; ingestGapPct: number },
): boolean {
  if (row.frontTotalMessages <= 0) return false;
  if (row.ingestGap <= 0) return false;
  // Task #1905 — any non-null `closed_via` marks the row as resolved
  // via a non-recovery path (e.g. `webhook_dedupe`). Skip so the
  // auto-closure loop stops re-enqueuing recoveries for a phantom gap.
  if (row.closedVia) return false;
  const pct = (row.ingestGap / row.frontTotalMessages) * 100;
  return row.ingestGap >= cfg.ingestGapCount || pct >= cfg.ingestGapPct;
}

async function enqueueIngestRecoveries(
  rows: FrontAnalyticsMonthlyCoverage[],
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  state: PersistedState,
  summary: AutoClosureRunSummary,
  now: Date,
  mode: AutoClosureMode = "daytime",
): Promise<void> {
  if (cfg.ingestRecoveryBudget <= 0) return;
  // Historical recovery is the canonical "large backfill" path. When
  // the global large-backfills kill switch is tripped we must NOT
  // auto-enqueue more — the operator has explicitly suppressed this
  // class of work.
  if (PERF.KILL_SWITCH_LARGE_BACKFILLS) {
    summary.errorsByReason["gate:kill_switch_large_backfills"] =
      (summary.errorsByReason["gate:kill_switch_large_backfills"] ?? 0) + 1;
    return;
  }
  // Pause-gate the downstream pipeline that runHistoricalRecovery
  // feeds. Recovery ingests new Front messages that then flow through
  // front_webhook_normalize → front_webhook_apply. If either of those
  // queues is paused for operator drain, enqueuing recovery just
  // builds backlog the operator is intentionally draining. Surface
  // the skip via skips.queue_paused so the admin panel reflects it.
  for (const downstream of [
    "front_webhook_normalize",
    "front_webhook_apply",
  ]) {
    if (isQueuePaused(downstream)) {
      summary.skips.queue_paused++;
      summary.errorsByReason[`gate:queue_paused:${downstream}`] =
        (summary.errorsByReason[`gate:queue_paused:${downstream}`] ?? 0) + 1;
      return;
    }
  }

  // Daily counter reset.
  const today = todayUtc(now);
  if (state.recoveryDay !== today) {
    state.recoveryDay = today;
    state.recoveryRunsToday = 0;
  }
  const dailyCap = cfg.maxRecoveryRunsPerDay;
  if (dailyCap != null && state.recoveryRunsToday >= dailyCap) {
    // All ingest candidates skipped under "budget" if any.
    return;
  }

  const currentMonth = currentMonthLabel(now);
  const candidates: IngestCandidate[] = [];
  for (const row of rows) {
    if (row.unrecoverable) continue;
    if (isAuthFailureError(row)) continue;
    if (!isIngestCandidate(row, cfg)) continue;
    candidates.push({
      row,
      ingestGapPct: (row.ingestGap / Math.max(1, row.frontTotalMessages)) * 100,
      isCurrent: row.month === currentMonth,
    });
  }

  // Daytime: current month first → oldest large gap → largest %.
  // Overnight (Task #1683): drop the current-month boost so the oldest
  // historical gaps are drained first; the current month is still
  // covered by the normal coverage refresh tick.
  candidates.sort((a, b) => {
    if (mode !== "overnight" && a.isCurrent !== b.isCurrent) {
      return a.isCurrent ? -1 : 1;
    }
    if (a.row.month !== b.row.month) return a.row.month.localeCompare(b.row.month);
    return b.ingestGapPct - a.ingestGapPct;
  });

  // Warp-drain (2026-05-26): the engine now allows up to
  // `front_recovery_max_concurrent_jobs` (default 3) concurrent recovery
  // jobs so a multi-month gap can drain in parallel. We track running
  // count vs. cap across the loop so a tick with budget > 1 can enqueue
  // multiple recoveries (one per month) up to the engine's cap, but
  // never exceed it. The downstream engine enforces the same cap as a
  // belt-and-suspenders guard.
  const { listRecoveryJobs, runHistoricalRecovery, getMaxConcurrentRecoveryJobsForAutoClosure } =
    await import("./frontHistoricalRecovery");
  const existingJobs = await listRecoveryJobs().catch(() => []);
  let runningCount = existingJobs.filter((j) => j.status === "running").length;
  const recoveryCap = await getMaxConcurrentRecoveryJobsForAutoClosure();

  for (const c of candidates) {
    if (summary.ingestRecoveriesEnqueued >= cfg.ingestRecoveryBudget) {
      summary.skips.budget++;
      continue;
    }
    if (dailyCap != null && state.recoveryRunsToday >= dailyCap) {
      summary.skips.budget++;
      continue;
    }
    // Task #1885 — never re-enqueue a parked window. Operator must
    // explicitly un-park (via the admin UI or `unparkRecoveryWindow`)
    // before this window is eligible again.
    //
    // Task #1890 — also auto-unpark when the operator has cleared the
    // per-window recovery checkpoint (`front_recovery_checkpoint_*`
    // deleted via `runHistoricalRecovery({ resumeMode:
    // "clear_checkpoints" })`) OR a fresh checkpoint has shown forward
    // progress since the parked entry was written. Either is an
    // unambiguous operator-driven "I want this window re-evaluated"
    // signal; without this, operators would have to both clear the
    // checkpoint AND call the un-park CEO action to release a window.
    if (isParked(state, c.row.month)) {
      const parked = state.parkedWindows![c.row.month];
      const cp = await readRecoveryCheckpoint(c.row.month).catch(() => null);
      const unpark = shouldAutoUnparkWindow(parked, cp);
      if (unpark) {
        delete state.parkedWindows![c.row.month];
        if (state.deadRunStreak) delete state.deadRunStreak[c.row.month];
        // Task #2085 — a cleared/advanced checkpoint is an operator
        // "re-evaluate this" signal; drop any escalation marker too so
        // the window starts from a clean slate.
        if (state.searchEscalations) delete state.searchEscalations[c.row.month];
        recordParkEvent(state, {
          at: now.toISOString(),
          month: c.row.month,
          type: "auto_unparked",
          deadRuns: parked?.deadRuns,
        });
        workerLog({
          worker: "front_auto_closure",
          event: "reconciliation_completed",
          details: {
            subevent: "ingest_recovery_window_auto_unparked",
            month: c.row.month,
            reason: unpark.reason,
            previously_parked_at: parked?.parkedAt ?? null,
            previously_dead_runs: parked?.deadRuns ?? null,
          },
        });
        // Fall through to normal evaluation on this tick.
      } else {
        summary.skips.parked++;
        continue;
      }
    }
    if (isCooldownActive(state, c.row.month, now)) {
      summary.skips.cooldown++;
      continue;
    }
    if (runningCount >= recoveryCap) {
      summary.skips.in_flight++;
      continue;
    }
    // Task #1885 — inspect the latest recovery checkpoint to detect
    // "scanned 25k, ingested zero, every page already a dupe" runs.
    // After `parkAfterDeadRuns` such runs in a row we park the window
    // so the auto-closure loop stops burning Front API budget on it.
    if (cfg.parkAfterDeadRuns > 0 || cfg.closeAfterDedupeOnlyRuns > 0) {
      const cp = await readRecoveryCheckpoint(c.row.month).catch(() => null);
      const streak = updateDeadRunStreak(state, c.row.month, cp);
      // Task #2085 — once a window makes forward progress the streak
      // resets to 0; any in-flight search escalation succeeded, so drop
      // its marker. (The escalated re-run is what produced this
      // progress.)
      if (streak.count === 0 && state.searchEscalations?.[c.row.month]) {
        delete state.searchEscalations[c.row.month];
      }
      // Task #1905 — try the dedupe-only-resolved close path *before*
      // parking. A successful close writes `closed_via='webhook_dedupe'`
      // back to the coverage row and we move on; a failed close (apply
      // layer didn't confirm) falls through to the park guard so the
      // window still stops burning Front API budget on the next
      // streak tick.
      if (
        cfg.closeAfterDedupeOnlyRuns > 0 &&
        streak.count >= cfg.closeAfterDedupeOnlyRuns
      ) {
        try {
          const decision = await maybeCloseDedupeOnlyWindow(state, c.row, cfg);
          if (decision.closed) {
            // Task #2088 — count dedupe-only closes in their own
            // counter so the admin UI can show "parked" vs "closed
            // (webhook dedupe)" separately. (Previously folded into
            // `skips.parked`.)
            summary.skips.dedupe_closed++;
            workerLog({
              worker: "front_auto_closure",
              event: "reconciliation_skipped",
              details: {
                subevent: "ingest_recovery_window_closed_via_webhook_dedupe",
                month: c.row.month,
                dead_runs: streak.count,
                threshold: cfg.closeAfterDedupeOnlyRuns,
                last_checkpoint_at: streak.lastCheckpointAt,
                dedupe_pct: decision.dedupePct,
                applied_sample_total: decision.appliedSample.total,
                applied_sample_applied: decision.appliedSample.applied,
              },
            });
            continue;
          } else {
            summary.errorsByReason[
              `dedupe_only_close_skipped:${decision.reason.slice(0, 80)}`
            ] =
              (summary.errorsByReason[
                `dedupe_only_close_skipped:${decision.reason.slice(0, 80)}`
              ] ?? 0) + 1;
          }
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          summary.errorsByReason[
            `dedupe_only_close_failed:${msg.slice(0, 80)}`
          ] =
            (summary.errorsByReason[
              `dedupe_only_close_failed:${msg.slice(0, 80)}`
            ] ?? 0) + 1;
        }
      }
      if (cfg.parkAfterDeadRuns > 0 && streak.count >= cfg.parkAfterDeadRuns) {
        const existingEscalation = state.searchEscalations?.[c.row.month];
        if (!existingEscalation) {
          if (isSearchEscalationEnabled() && isLegacyStrategyDeadRun(cp)) {
            const { monthStart, monthEnd } = monthBoundaries(c.row.month);
            try {
              const jobId = await runHistoricalRecovery({
                customWindows: [
                  {
                    label: autoClosureWindowLabel(c.row.month),
                    afterTimestamp: Math.floor(monthStart.getTime() / 1000),
                    beforeTimestamp: Math.floor(monthEnd.getTime() / 1000),
                  },
                ],
                resumeMode: "clear_checkpoints",
              });
              if (!state.searchEscalations) state.searchEscalations = {};
              state.searchEscalations[c.row.month] = {
                escalatedAt: now.toISOString(),
                triggeredByCheckpointAt:
                  cp?.completedAt ?? streak.lastCheckpointAt ?? null,
                deadRunsAtEscalation: streak.count,
              };
              summary.ingestRecoveriesEnqueued++;
              summary.monthsActed.push(c.row.month);
              state.recoveryRunsToday++;
              runningCount++;
              setCooldown(state, c.row.month, cfg.cooldownMinutes, now);
              workerLog({
                worker: "front_auto_closure",
                event: "job_enqueued",
                details: {
                  subevent: "ingest_recovery_window_search_escalated",
                  month: c.row.month,
                  job_id: jobId,
                  dead_runs: streak.count,
                  threshold: cfg.parkAfterDeadRuns,
                  triggered_by_checkpoint_at: cp?.completedAt ?? null,
                },
              });
            } catch (err: any) {
              // Escalation could not be enqueued (e.g. the recovery
              // concurrency cap). Do NOT record a marker — a later tick
              // retries the escalation cleanly.
              const msg = err?.message ?? String(err);
              const k = `search_escalation_failed:${msg.slice(0, 80)}`;
              summary.errorsByReason[k] =
                (summary.errorsByReason[k] ?? 0) + 1;
            }
            continue;
          }
          // Not eligible for escalation (already on the search strategy,
          // the switch is off, or a non-page-cap dead run) — park as
          // before.
          parkWindow(state, c.row.month, {
            parkedAt: now.toISOString(),
            reason: `dead_run_streak:${streak.count}_runs_safety_max_pages_reached_resume_available_ingested=0`,
            deadRuns: streak.count,
            lastCheckpointAt: streak.lastCheckpointAt,
          });
          recordParkEvent(state, {
            at: now.toISOString(),
            month: c.row.month,
            type: "parked",
            deadRuns: streak.count,
          });
          summary.skips.parked++;
          workerLog({
            worker: "front_auto_closure",
            event: "reconciliation_skipped",
            details: {
              subevent: "ingest_recovery_window_parked",
              month: c.row.month,
              dead_runs: streak.count,
              threshold: cfg.parkAfterDeadRuns,
              last_checkpoint_at: streak.lastCheckpointAt,
            },
          });
          continue;
        }
        // Escalation already in flight. Park only once the escalated
        // search re-run has actually landed a NEW dead-run checkpoint
        // (its `completedAt` has advanced past the one that triggered
        // the escalation). Until then, wait — never re-escalate, never
        // park prematurely.
        const escalatedRunLanded =
          cp?.completedAt != null &&
          cp.completedAt !== existingEscalation.triggeredByCheckpointAt;
        if (isDeadRunCheckpoint(cp) && escalatedRunLanded) {
          parkWindow(state, c.row.month, {
            parkedAt: now.toISOString(),
            reason: `dead_run_streak:${streak.count}_runs_safety_max_pages_reached_resume_available_ingested=0_post_search_escalation`,
            deadRuns: streak.count,
            lastCheckpointAt: streak.lastCheckpointAt,
            searchEscalated: true,
            searchEscalatedAt: existingEscalation.escalatedAt,
            reArmOutcome: {
              kind: "still_empty",
              ingested: 0,
              at: now.toISOString(),
              source: "auto_escalation",
            },
          });
          recordParkEvent(state, {
            at: now.toISOString(),
            month: c.row.month,
            type: "parked",
            deadRuns: streak.count,
          });
          // The in-flight escalation has resolved into a park; the
          // parked entry now carries the `searchEscalated` marker, so
          // drop the transient escalation entry.
          if (state.searchEscalations) {
            delete state.searchEscalations[c.row.month];
          }
          summary.skips.parked++;
          workerLog({
            worker: "front_auto_closure",
            event: "reconciliation_skipped",
            details: {
              subevent: "ingest_recovery_window_parked_after_search_escalation",
              month: c.row.month,
              dead_runs: streak.count,
              threshold: cfg.parkAfterDeadRuns,
              last_checkpoint_at: streak.lastCheckpointAt,
              escalated_at: existingEscalation.escalatedAt,
            },
          });
          continue;
        }
        // Escalated re-run has not yet produced a fresh dead-run
        // checkpoint — wait for it without acting on this window.
        summary.skips.in_flight++;
        continue;
      }
    }
    const { monthStart, monthEnd } = monthBoundaries(c.row.month);
    try {
      const jobId = await runHistoricalRecovery({
        customWindows: [
          {
            label: `auto_closure:${c.row.month}`,
            afterTimestamp: Math.floor(monthStart.getTime() / 1000),
            beforeTimestamp: Math.floor(monthEnd.getTime() / 1000),
          },
        ],
      });
      summary.ingestRecoveriesEnqueued++;
      summary.monthsActed.push(c.row.month);
      state.recoveryRunsToday++;
      // Track our own enqueues against the cap so a single tick can
      // enqueue multiple recoveries (one per gap month) without racing
      // the engine's downstream cap check.
      runningCount++;
      setCooldown(state, c.row.month, cfg.cooldownMinutes, now);
      workerLog({
        worker: "front_auto_closure",
        event: "job_enqueued",
        details: {
          subevent: "ingest_recovery_enqueued",
          month: c.row.month,
          ingest_gap: c.row.ingestGap,
          ingest_gap_pct: c.ingestGapPct.toFixed(2),
          recovery_job_id: jobId,
          daily_count: state.recoveryRunsToday,
        },
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // Expected concurrency back-pressure (legacy "already running" string
      // or the new RECOVERY_CAP_REACHED typed error) is in_flight, NOT a
      // self-error. Treating cap-reached as a self-error would falsely
      // trip frontAutoClosureRegressionAlerts under healthy contention.
      const isCapReached = err?.code === "RECOVERY_CAP_REACHED" || /cap reached/i.test(msg);
      if (/already running/i.test(msg) || isCapReached) {
        summary.skips.in_flight++;
        // Cooldown still applies so we don't hammer the engine.
        setCooldown(state, c.row.month, cfg.cooldownMinutes, now);
      } else {
        summary.errorsByReason[`ingest_recovery:${msg.slice(0, 80)}`] =
          (summary.errorsByReason[`ingest_recovery:${msg.slice(0, 80)}`] ?? 0) + 1;
        summary.lastSelfError = msg.slice(0, 500);
      }
    }
  }
}

// ──────────────── Action: nudge front_webhook_apply for apply gaps ────────────────

interface ApplyWorkItem {
  sourceEventId: string;
  workResultId: string;
  conversationId: string | null;
}

async function findUnappliedWorkItemsForMonth(
  monthStart: Date,
  monthEnd: Date,
  limit: number,
): Promise<ApplyWorkItem[]> {
  // Find front_sync_emails rows in this month that have not reached
  // the 'applied' terminal state, then join to the canonical
  // source_event_log / work_result_log pair that the apply handler
  // consumes. Only completed normalize results (`status='completed'`,
  // `result_type='communication_result'`) are eligible — anything else
  // would not be a valid front_webhook_apply payload.
  const rows = await getDb().execute(sql`
    SELECT
      sel.id            AS "sourceEventId",
      wrl.id            AS "workResultId",
      fse.conversation_id AS "conversationId"
    FROM front_sync_emails fse
    JOIN work_result_log wrl
      ON wrl.result_json->>'conversationId' = fse.conversation_id
    JOIN source_event_log sel
      ON sel.id = wrl.source_event_id
    WHERE fse.pipeline_state IS DISTINCT FROM 'applied'
      AND fse.last_message_at >= ${monthStart.toISOString()}
      AND fse.last_message_at <  ${monthEnd.toISOString()}
      AND wrl.status = 'completed'
      AND wrl.result_type = 'communication_result'
      AND sel.source_system = 'front'
    ORDER BY fse.last_message_at ASC
    LIMIT ${limit}
  `);
  const out: ApplyWorkItem[] = [];
  for (const r of ((rows as any).rows ?? (rows as unknown as any[])) as any[]) {
    if (!r?.sourceEventId || !r?.workResultId) continue;
    out.push({
      sourceEventId: String(r.sourceEventId),
      workResultId: String(r.workResultId),
      conversationId: r.conversationId ? String(r.conversationId) : null,
    });
  }
  return out;
}

function isApplyCandidate(
  row: FrontAnalyticsMonthlyCoverage,
  cfg: { applyGapCount: number; applyGapPct: number },
): boolean {
  if (row.applyGap <= 0) return false;
  const denom = row.fetchedIntoNobull > 0 ? row.fetchedIntoNobull : 0;
  const pct = denom > 0 ? (row.applyGap / denom) * 100 : 0;
  return row.applyGap >= cfg.applyGapCount || pct >= cfg.applyGapPct;
}

const APPLY_QUEUE_NAME = "front_webhook_apply";

async function nudgeApplyGaps(
  rows: FrontAnalyticsMonthlyCoverage[],
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  summary: AutoClosureRunSummary,
  now: Date,
  mode: AutoClosureMode = "daytime",
): Promise<void> {
  if (cfg.applyNudgeBudget <= 0) return;
  if (isQueuePaused(APPLY_QUEUE_NAME)) {
    summary.skips.queue_paused++;
    return;
  }

  const currentMonth = currentMonthLabel(now);
  // Skip permanent-failure months. `unrecoverable=true` means the row
  // is permanently dead (manual operator decision required) and an
  // active auth failure means the apply pipeline cannot reach Front
  // until credentials are rotated. Nudging either case just generates
  // noise on the apply queue.
  const candidates = rows
    .filter((r) => {
      if (r.unrecoverable) {
        summary.skips.unrecoverable++;
        return false;
      }
      if (isAuthFailureError(r)) {
        summary.skips.auth_failed++;
        return false;
      }
      return isApplyCandidate(r, cfg);
    })
    .sort((a, b) => {
      const aCur = a.month === currentMonth;
      const bCur = b.month === currentMonth;
      // Overnight (Task #1683): drain oldest gaps first; daytime keeps
      // the current month boost so live coverage stays fresh.
      if (mode !== "overnight" && aCur !== bCur) return aCur ? -1 : 1;
      if (a.month !== b.month) return a.month.localeCompare(b.month);
      return b.applyGap - a.applyGap;
    });

  if (candidates.length === 0) return;

  const { enqueueJob } = await import("./workScheduler");
  let remaining = cfg.applyNudgeBudget;

  for (const row of candidates) {
    if (remaining <= 0) {
      summary.skips.budget++;
      continue;
    }
    const { monthStart, monthEnd } = monthBoundaries(row.month);
    const items = await findUnappliedWorkItemsForMonth(
      monthStart,
      monthEnd,
      Math.min(remaining, row.applyGap),
    );
    if (items.length === 0) {
      summary.skips.no_work_items++;
      continue;
    }
    let enqueuedForMonth = 0;
    for (const item of items) {
      if (remaining <= 0) break;
      try {
        // Reuse the canonical dedupeKey used everywhere else by the
        // Front pipeline (`apply:${sourceEventId}`). If a job for the
        // same source event is already pending the workScheduler
        // dedupes it — we don't double-enqueue.
        await enqueueJob({
          queueName: APPLY_QUEUE_NAME,
          workloadClass: "front_ingestion",
          priority: 75,
          payload: {
            sourceEventId: item.sourceEventId,
            workResultId: item.workResultId,
            conversationId: item.conversationId,
            triggeredBy: "front_auto_closure",
          },
          dedupeKey: `apply:${item.sourceEventId}`,
        });
        enqueuedForMonth++;
        remaining--;
        summary.applyNudgesEnqueued++;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        summary.errorsByReason[`apply_nudge:${msg.slice(0, 80)}`] =
          (summary.errorsByReason[`apply_nudge:${msg.slice(0, 80)}`] ?? 0) + 1;
        summary.lastSelfError = msg.slice(0, 500);
      }
    }
    if (enqueuedForMonth > 0) {
      summary.monthsActed.push(row.month);
      workerLog({
        worker: "front_auto_closure",
        event: "job_enqueued",
        details: {
          subevent: "apply_nudge_enqueued",
          month: row.month,
          enqueued: enqueuedForMonth,
          apply_gap: row.applyGap,
        },
      });
    }
  }
}

// ──────────────── Tick entry point ────────────────

/**
 * Run one auto-closure tick. Bounded; non-throwing (records the
 * `lastSelfError` instead of bubbling so the surrounding coverage
 * refresh tick is never broken by an orchestrator bug).
 */
// In-process re-entrancy guard. The tick is now driven by two paths:
// (1) the dedicated `front_auto_closure_tick` scheduler in
// `frontAutoClosureScheduler.ts` (~60s cadence), and (2) the legacy
// embedded invocation at the tail of `handleFrontAnalyticsCoverageRefresh`
// kept as a defensive backup. Both paths can in theory land on the same
// process tick. The queue-level in-flight check protects the scheduler
// from itself but does NOT protect against the embedded call running
// concurrently with a queue-dispatched tick. This boolean closes the
// gap: only one tick runs at a time per process; concurrent callers
// receive a no-op summary tagged with `skipped_reentrant` and the
// original tick proceeds undisturbed.
let tickInProgress = false;

/**
 * Run one auto-closure tick.
 *
 * `configOverride` (test-only) lets a suite drive the tick with an
 * explicit, in-memory config instead of mutating the process-global
 * `system_settings` rows that {@link loadConfig} reads. This makes the
 * auto-closure suites immune to shared-setting collisions: two suites
 * (or a suite and the always-on dev-server tick) can run concurrently
 * without clobbering each other's `front_auto_closure_*` config. The
 * override is shallow-merged over the freshly loaded config, so a suite
 * only needs to specify the keys it cares about. Production callers never
 * pass it. See `.agents/memory/test-db-pool-exit-and-contention.md`.
 */
export async function runFrontAutoClosureTick(opts?: {
  now?: Date;
  configOverride?: Partial<FrontAutoClosureConfig>;
  // Test-only: drive the tick's orchestrator run-state (deadRunStreak /
  // parked windows / escalation markers / last summary) through an
  // injected in-memory store instead of the process-global
  // `front_auto_closure_state` setting. Production omits it. See
  // {@link FrontAutoClosureStateStore}.
  stateStore?: FrontAutoClosureStateStore;
}): Promise<AutoClosureRunSummary> {
  const now = opts?.now ?? new Date();
  if (tickInProgress) {
    return {
      ranAt: now.toISOString(),
      enabled: true,
      monthsInspected: 0,
      errorsRetried: 0,
      errorRetrySuccesses: 0,
      ingestRecoveriesEnqueued: 0,
      applyNudgesEnqueued: 0,
      recoveryDailyCounter: 0,
      skips: newSkipCounters(),
      errorsByReason: {},
      lastSelfError: "skipped_reentrant",
      monthsActed: [],
      mode: "daytime",
      effectiveBudgets: { retry: 0, ingestRecovery: 0, applyNudge: 0 },
    };
  }
  tickInProgress = true;
  try {
    return await runFrontAutoClosureTickInner(opts);
  } finally {
    tickInProgress = false;
  }
}

async function runFrontAutoClosureTickInner(opts?: {
  now?: Date;
  configOverride?: Partial<FrontAutoClosureConfig>;
  stateStore?: FrontAutoClosureStateStore;
}): Promise<AutoClosureRunSummary> {
  const now = opts?.now ?? new Date();
  // Tests may inject an in-memory orchestrator-state store so streak /
  // escalation / parked-window state never touches the global
  // `front_auto_closure_state` setting. Production uses the DB-backed
  // loadState/saveState pair.
  const stateStore = opts?.stateStore;
  const saveFn: (s: PersistedState) => Promise<void> = stateStore
    ? (s) => stateStore.save(s)
    : saveState;
  const summary: AutoClosureRunSummary = {
    ranAt: now.toISOString(),
    enabled: true,
    monthsInspected: 0,
    errorsRetried: 0,
    errorRetrySuccesses: 0,
    ingestRecoveriesEnqueued: 0,
    applyNudgesEnqueued: 0,
    recoveryDailyCounter: 0,
    skips: newSkipCounters(),
    errorsByReason: {},
    lastSelfError: null,
    monthsActed: [],
    mode: "daytime",
    effectiveBudgets: { retry: 0, ingestRecovery: 0, applyNudge: 0 },
  };

  let state: PersistedState = { ...EMPTY_STATE, cooldowns: {} };
  try {
    state = stateStore ? await stateStore.load() : await loadState();
  } catch (err: any) {
    summary.lastSelfError = `load_state: ${err?.message ?? err}`;
  }

  try {
    // Tests may supply an in-memory `configOverride` (shallow-merged over
    // the freshly loaded config) so they can drive the tick without
    // mutating shared `system_settings`. Production passes nothing.
    const cfg: FrontAutoClosureConfig = {
      ...(await loadConfig()),
      ...(opts?.configOverride ?? {}),
    };
    summary.enabled = cfg.enabled;

    // Task #1694 — compute mode up front so even gated/early-bail
    // ticks report the correct mode and persist `lastOvernightRanAt`.
    // The regression alerter uses that timestamp to detect missed
    // overnight windows; if we only set it after the gates, an
    // overnight tick that bailed on (e.g.) the dead-letter growth
    // gate would look identical to "the worker never woke during
    // overnight hours" and falsely fire `overnight_missed`.
    summary.mode = detectMode({
      now,
      timezone: cfg.overnightTimezone,
      startHour: cfg.overnightStartHour,
      endHour: cfg.overnightEndHour,
      overnightEnabled: cfg.overnightEnabled,
    });

    // ── Gates ──
    if (!cfg.enabled) {
      summary.skippedReason = `${SETTING_ENABLED}=false`;
      summary.lastSelfError = state.lastSummary?.lastSelfError ?? null;
      await persistSummary(state, summary, saveFn);
      return summary;
    }
    if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
      summary.skippedReason = "KILL_SWITCH_NON_CRITICAL_SWEEPS=true";
      await persistSummary(state, summary, saveFn);
      return summary;
    }
    // Inherit the existing analytics refresh kill switch — disabling
    // analytics also disables its self-healing loop. Read via the config
    // object (folded in by loadConfig) so a `configOverride` can drive
    // this gate in tests without writing the shared setting.
    if (!cfg.analyticsRefreshEnabled) {
      summary.skippedReason = `${SETTING_REFRESH_ENABLED}=false`;
      await persistSummary(state, summary, saveFn);
      return summary;
    }
    if (isQueuePaused(COVERAGE_QUEUE_NAME)) {
      summary.skippedReason = "coverage queue paused via queue_drain_state";
      await persistSummary(state, summary, saveFn);
      return summary;
    }
    const pressure = isApiPoolUnderPressure();
    if (pressure.underPressure) {
      summary.skippedReason = `api_pool_under_pressure:${pressure.reasons.join(",")}`;
      await persistSummary(state, summary, saveFn);
      return summary;
    }

    // Worker lease health proxy — if the coverage refresh worker itself
    // has recent `stale_lease_exhaustion` terminations on its queue,
    // worker leases are flapping. Auto-closure should defer until the
    // pool stabilizes; otherwise we just pile recovery + apply work on
    // top of an already wedged worker pool.
    const leaseUnhealthy = await isCoverageLeaseUnhealthy(now).catch(
      () => false,
    );
    if (leaseUnhealthy) {
      summary.skippedReason = "worker_lease_unhealthy";
      await persistSummary(state, summary, saveFn);
      return summary;
    }

    // Task #2100 — Front auth-dead deferral. When the global auth
    // breaker is open, Front's OAuth refresh token has been terminally
    // rejected (invalid_grant) and only an operator reconnect can fix
    // it. Skip the whole self-heal tick so we don't enqueue refreshMonth
    // / runHistoricalRecovery / apply work that can only fail and
    // re-flood the logs. Mirrors the SEMrush sweep `paused_auth`
    // short-circuit. The breaker auto-closes on the next successful
    // probe (operator reconnect), so this clears without a restart.
    if (frontAuthBreakerActive()) {
      summary.skippedReason = "front_auth_dead";
      summary.skips.auth_failed++;
      await persistSummary(state, summary, saveFn);
      return summary;
    }

    // Front Analytics rate-limit deferral — if any recent coverage row
    // recorded a Front 429 we back off the whole tick so refreshMonth
    // and runHistoricalRecovery don't immediately re-trip the limiter.
    if (rowsHaveRecentRateLimit(await loadRecentCoverageErrors())) {
      summary.skippedReason = "front_analytics_rate_limited";
      await persistSummary(state, summary, saveFn);
      return summary;
    }

    // Task #1683 — dead-letter growth safety cutoff. Sample the Front
    // pipeline dead-letter count and compare against the previous
    // tick's sample. A positive delta larger than the configured
    // threshold means the pipeline is actively shedding rows to the
    // dead-letter queue; piling more retries / recoveries / nudges on
    // top would just amplify the spike. Applies to BOTH daytime and
    // overnight modes — overnight's larger budgets make this gate
    // especially important. The first sample after state reset is
    // measure-only (no previous count to compare to) so we never gate
    // on phantom growth from a missing baseline.
    const dlCount = await getFrontDeadLetterCount().catch(() => null);
    if (
      dlCount != null &&
      state.lastDeadLetterCount != null &&
      cfg.deadLetterGrowthThreshold > 0
    ) {
      const growth = dlCount - state.lastDeadLetterCount;
      if (growth > cfg.deadLetterGrowthThreshold) {
        summary.skippedReason = `front_dead_letter_growth:${growth}>${cfg.deadLetterGrowthThreshold}`;
        // Refresh the baseline so the gate clears as soon as the
        // pipeline stops growing — we don't want a single historical
        // spike to wedge the loop forever.
        state.lastDeadLetterCount = dlCount;
        state.lastDeadLetterSampleAt = now.toISOString();
        await persistSummary(state, summary, saveFn);
        return summary;
      }
    }
    if (dlCount != null) {
      state.lastDeadLetterCount = dlCount;
      state.lastDeadLetterSampleAt = now.toISOString();
    }

    // ── Task #1683: compute effective budgets from the mode that
    //    Task #1694 already stamped on the summary above. ──
    const mode = summary.mode;
    const effectiveRetryBudget =
      mode === "overnight" ? cfg.overnightRetryBudget : cfg.retryBudget;
    const effectiveIngestRecoveryBudget =
      mode === "overnight"
        ? cfg.overnightIngestRecoveryBudget
        : cfg.ingestRecoveryBudget;
    const effectiveApplyNudgeBudget =
      mode === "overnight"
        ? cfg.overnightApplyNudgeBudget
        : cfg.applyNudgeBudget;
    summary.effectiveBudgets = {
      retry: effectiveRetryBudget,
      ingestRecovery: effectiveIngestRecoveryBudget,
      applyNudge: effectiveApplyNudgeBudget,
    };

    // Build an action-cfg view that swaps in the effective budgets so
    // downstream helpers honor the overnight overrides without
    // re-reading system_settings.
    const actionCfg = {
      ...cfg,
      retryBudget: effectiveRetryBudget,
      ingestRecoveryBudget: effectiveIngestRecoveryBudget,
      applyNudgeBudget: effectiveApplyNudgeBudget,
    };

    // ── Inspect ──
    pruneStaleCooldowns(state, now);
    if (state.recoveryDay !== todayUtc(now)) {
      state.recoveryDay = todayUtc(now);
      state.recoveryRunsToday = 0;
    }
    // Task #1869 Step 3 — Run the OAuth-race auto-unblock pass on every
    // tick before we look at coverage rows. Gated by the
    // `front_auto_unblock_enabled` kill switch (default ON). The pass is
    // a no-op when there are no `blocked` rows with auth-race reasons,
    // and a no-op when the `/me` probe says Front is genuinely
    // disconnected (those rows are left alone so the real-disconnect
    // alert still fires). Surface the summary on the tick so operators
    // can see auto-unblock activity in worker logs.
    try {
      const { tryAutoUnblockPoisonedCheckpoints } = await import("./frontHistoricalRecovery");
      const unblockSummary = await tryAutoUnblockPoisonedCheckpoints();
      if (unblockSummary.scanned > 0 || unblockSummary.unblocked > 0) {
        summary.errorsByReason[`auto_unblock:scanned=${unblockSummary.scanned}_unblocked=${unblockSummary.unblocked}_probe=${unblockSummary.probeOutcome}`] = 1;
      }
    } catch (unblockErr: any) {
      summary.errorsByReason[`auto_unblock_failed:${(unblockErr?.message ?? String(unblockErr)).slice(0, 80)}`] = 1;
    }

    const rows = (await db
      .select()
      .from(frontAnalyticsMonthlyCoverage)
      .orderBy(asc(frontAnalyticsMonthlyCoverage.month))) as FrontAnalyticsMonthlyCoverage[];
    summary.monthsInspected = rows.length;

    // ── Actions ──
    await retryErrorRows(rows, actionCfg.retryBudget, summary, now);
    await enqueueIngestRecoveries(rows, actionCfg, state, summary, now, mode);
    await nudgeApplyGaps(rows, actionCfg, summary, now, mode);

    summary.recoveryDailyCounter = state.recoveryRunsToday;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    summary.lastSelfError = msg.slice(0, 500);
    summary.errorsByReason[`tick:${msg.slice(0, 80)}`] =
      (summary.errorsByReason[`tick:${msg.slice(0, 80)}`] ?? 0) + 1;
    console.warn(`[FrontAutoClosure] tick failed: ${msg}`);
  }

  workerLog({
    worker: "front_auto_closure",
    event: "worker_completed",
    details: {
      subevent: "tick_complete",
      enabled: summary.enabled,
      months_inspected: summary.monthsInspected,
      errors_retried: summary.errorsRetried,
      error_retry_successes: summary.errorRetrySuccesses,
      ingest_recoveries: summary.ingestRecoveriesEnqueued,
      apply_nudges: summary.applyNudgesEnqueued,
      months_acted: Array.from(new Set(summary.monthsActed)),
      skips: summary.skips,
      errors_by_reason: summary.errorsByReason,
      last_self_error: summary.lastSelfError,
      skipped_reason: summary.skippedReason ?? null,
    },
  });

  await persistSummary(state, summary, saveFn);
  return summary;
}

async function persistSummary(
  state: PersistedState,
  summary: AutoClosureRunSummary,
  // Defaults to the DB-backed saveState; the tick passes the injected
  // in-memory store's save when a `stateStore` override is in play so the
  // run-state never round-trips through the global setting.
  save: (s: PersistedState) => Promise<void> = saveState,
): Promise<void> {
  state.lastSummary = summary;
  // Task #1694 — stamp `lastOvernightRanAt` whenever a tick was
  // observed in overnight mode, even if every action was gated out.
  // The regression alerter treats this as proof the worker woke
  // during the configured overnight window.
  if (summary.mode === "overnight") {
    state.lastOvernightRanAt = summary.ranAt;
  }
  await save(state);
}

// ──────────────── Read-only status (for admin panel) ────────────────

export interface AutoClosureStatus {
  enabled: boolean;
  defaults: typeof DEFAULTS;
  config: Awaited<ReturnType<typeof loadConfig>>;
  lastSummary: AutoClosureRunSummary | null;
  cooldowns: Record<string, string>;
  recoveryDay: string | null;
  recoveryRunsToday: number;
  // Task #1683 — current mode at the time the admin panel queries
  // status, so the UI can render "mode: overnight" even between ticks.
  currentMode: AutoClosureMode;
  // Task #1885 — parked recovery windows + per-month dead-run streaks
  // so the admin UI can show what's parked and why.
  parkedWindows: Record<string, ParkedWindowEntry>;
  deadRunStreak: Record<string, DeadRunStreakEntry>;
  // Task #2085 — in-flight automatic pre-park search escalations so the
  // admin panel can show which parked-threshold windows are currently
  // being re-run once under the search strategy before any park.
  searchEscalations: Record<string, SearchEscalationEntry>;
  // Task #2088 — recent park/unpark breadcrumb log (bounded), so the
  // admin console / trends panel can show period activity.
  parkEvents: ParkEventEntry[];
  // Task #2118 — per-window re-arm drain state (in-memory, best-effort)
  // keyed by month, so the admin panel can show whether a specific
  // month's `rearm_parked_front_recovery_window_${month}` drain is
  // currently running and what its last outcome was. Only populated for
  // months that have (or recently had) a per-window drain this process;
  // a process restart clears it (the work itself is durable in the DB).
  reArmDrains: Record<string, ReArmDrainStatus>;
  // Task #2148 — all-windows re-arm drain state (in-memory, best-effort)
  // for the `rearm_parked_front_recovery_windows` action so the parked
  // header can show running/finished progress for "Re-arm all", mirroring
  // the per-window badges. Null until an all-windows drain runs this
  // process; a restart clears it (the work itself is durable in the DB).
  allReArmDrain: ReArmDrainStatus | null;
}

// Task #2118 — lightweight, JSON-safe view of a single per-window re-arm
// background drain for the admin panel. Mirrors the in-memory
// `DrainState` from prodActionBackgroundDrain but only the fields the UI
// needs, with ISO timestamps instead of epoch millis.
export interface ReArmDrainStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  processed: number;
  totalAtStart: number;
  progress: string;
  error: string | null;
  // The dominant outcome kind recorded in the drain's per-key tally
  // (e.g. "re_armed", "still_empty", "unparked"). Null until a chunk
  // records one.
  lastOutcomeKind: string | null;
}

export async function getFrontAutoClosureStatus(opts?: {
  now?: Date;
  // Test-only: shallow-merged over the freshly loaded config so suites
  // can assert on `currentMode` / `config` deterministically without
  // mutating shared `system_settings` (Task #2157). Production omits it.
  configOverride?: Partial<FrontAutoClosureConfig>;
  // Test-only: read run-state (lastSummary / parked windows / streaks)
  // from an injected in-memory store instead of the global
  // `front_auto_closure_state` setting, so a suite can assert on the
  // state the tick it drove produced — without racing the dev-server
  // tick's global writes. Production omits it.
  stateStore?: FrontAutoClosureStateStore;
}): Promise<AutoClosureStatus> {
  const now = opts?.now ?? new Date();
  const [loadedCfg, state] = await Promise.all([
    loadConfig(),
    opts?.stateStore ? opts.stateStore.load() : loadState(),
  ]);
  const cfg: FrontAutoClosureConfig = {
    ...loadedCfg,
    ...(opts?.configOverride ?? {}),
  };
  const currentMode = detectMode({
    now,
    timezone: cfg.overnightTimezone,
    startHour: cfg.overnightStartHour,
    endHour: cfg.overnightEndHour,
    overnightEnabled: cfg.overnightEnabled,
  });
  const parkedWindows = state.parkedWindows ?? {};
  const drainMod = await import("./prodActionBackgroundDrain");
  const reArmDrains = collectReArmDrainStatuses(
    drainMod,
    Object.keys(parkedWindows),
  );
  // Task #2148 — project the all-windows re-arm drain (no month suffix)
  // so the parked header can show running/finished progress for the
  // "Re-arm all" press, reusing the same single-drain projection.
  const allReArmDrain = projectReArmDrain(
    drainMod,
    drainMod.getDrainState("rearm_parked_front_recovery_windows"),
  );
  return {
    enabled: cfg.enabled,
    defaults: DEFAULTS,
    config: cfg,
    lastSummary: state.lastSummary,
    cooldowns: state.cooldowns,
    recoveryDay: state.recoveryDay,
    recoveryRunsToday: state.recoveryRunsToday,
    currentMode,
    parkedWindows,
    deadRunStreak: state.deadRunStreak ?? {},
    searchEscalations: state.searchEscalations ?? {},
    parkEvents: state.parkEvents ?? [],
    reArmDrains,
    allReArmDrain,
  };
}

// Task #2118 — build the per-window re-arm drain status map the admin
// panel renders. The drain state lives in-memory in
// prodActionBackgroundDrain keyed by the per-month action id
// (`rearm_parked_front_recovery_window_${month}`); this reads it without
// touching the DB and projects only the fields the UI needs. A month is
// only included if a per-window drain exists this process; restarts drop
// it (the row falls back to its persisted `reArmOutcome`).
function collectReArmDrainStatuses(
  mod: typeof import("./prodActionBackgroundDrain"),
  months: string[],
): Record<string, ReArmDrainStatus> {
  const out: Record<string, ReArmDrainStatus> = {};
  for (const month of months) {
    const status = projectReArmDrain(
      mod,
      mod.getDrainState(`rearm_parked_front_recovery_window_${month}`),
    );
    if (status) out[month] = status;
  }
  return out;
}

// Task #2118 / #2148 — project a single in-memory `DrainState` into the
// JSON-safe `ReArmDrainStatus` the admin panel renders. Shared by both the
// per-window map and the all-windows drain. Returns null when no drain
// exists for the given action this process.
function projectReArmDrain(
  mod: typeof import("./prodActionBackgroundDrain"),
  drain: ReturnType<typeof mod.getDrainState>,
): ReArmDrainStatus | null {
  if (!drain) return null;
  const perKeyEntries = Object.entries(drain.perKey);
  // The dominant outcome kind = the key with the highest tally.
  const lastOutcomeKind = perKeyEntries.length
    ? perKeyEntries.sort((a, b) => b[1] - a[1])[0][0]
    : null;
  return {
    running: drain.finishedAt === null,
    startedAt: new Date(drain.startedAt).toISOString(),
    finishedAt: drain.finishedAt
      ? new Date(drain.finishedAt).toISOString()
      : null,
    processed: drain.processed,
    totalAtStart: drain.totalAtStart,
    progress: mod.formatDrainProgress(drain),
    error: drain.error,
    lastOutcomeKind,
  };
}

// Task #2088 — read-only summary for the admin trends panel. Combines
// the point-in-time parked-window set with the bounded park-event log
// to produce the three series the panel charts. Pure read; never
// mutates state.
export interface FrontParkSummary {
  currentlyParked: number;
  parkedWindows: Array<{
    month: string;
    parkedAt: string;
    deadRuns: number;
    lastCheckpointAt: string | null;
    reason: string;
  }>;
  periodStart: string;
  parkedInPeriod: number;
  autoUnparkedInPeriod: number;
  operatorUnparkedInPeriod: number;
}

export async function getFrontParkSummary(opts?: {
  sinceMs?: number;
  stateStore?: FrontAutoClosureStateStore;
}): Promise<FrontParkSummary> {
  const cutoff =
    typeof opts?.sinceMs === "number"
      ? opts.sinceMs
      : Date.now() - 7 * 24 * 60 * 60_000;
  const state = await (opts?.stateStore ? opts.stateStore.load() : loadState());
  const events = state.parkEvents ?? [];
  let parkedInPeriod = 0;
  let autoUnparkedInPeriod = 0;
  let operatorUnparkedInPeriod = 0;
  for (const ev of events) {
    const t = new Date(ev.at).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (ev.type === "parked") parkedInPeriod++;
    else if (ev.type === "auto_unparked") autoUnparkedInPeriod++;
    else if (ev.type === "operator_unparked") operatorUnparkedInPeriod++;
  }
  const pw = state.parkedWindows ?? {};
  const parkedWindows = Object.entries(pw)
    .map(([month, e]) => ({
      month,
      parkedAt: e.parkedAt,
      deadRuns: e.deadRuns,
      lastCheckpointAt: e.lastCheckpointAt,
      reason: e.reason,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
  return {
    currentlyParked: Object.keys(pw).length,
    parkedWindows,
    periodStart: new Date(cutoff).toISOString(),
    parkedInPeriod,
    autoUnparkedInPeriod,
    operatorUnparkedInPeriod,
  };
}

// ──────────────── Task #1695: overnight aggressive-mode editor ────────────────

/**
 * Bounds the admin editor enforces for each overnight tunable. The
 * upper budget bounds are deliberately conservative — the overnight
 * mode is meant to be aggressive within reason, not unbounded, and
 * uncapped budgets could pile work onto a stressed pipeline. If a
 * site needs higher ceilings the operator can still edit
 * `system_settings` directly; the API editor refuses values outside
 * these ranges so a slip in the admin UI cannot wedge production.
 */
export const OVERNIGHT_HOUR_MIN = 0;
export const OVERNIGHT_HOUR_MAX = 23;
export const OVERNIGHT_RETRY_BUDGET_MIN = 0;
export const OVERNIGHT_RETRY_BUDGET_MAX = 200;
export const OVERNIGHT_INGEST_RECOVERY_BUDGET_MIN = 0;
export const OVERNIGHT_INGEST_RECOVERY_BUDGET_MAX = 50;
export const OVERNIGHT_APPLY_NUDGE_BUDGET_MIN = 0;
export const OVERNIGHT_APPLY_NUDGE_BUDGET_MAX = 5000;

export interface OvernightConfigUpdate {
  enabled?: boolean;
  timezone?: string;
  startHour?: number;
  endHour?: number;
  retryBudget?: number;
  ingestRecoveryBudget?: number;
  applyNudgeBudget?: number;
}

function validateTimezoneStrict(tz: string): string {
  const candidate = (tz ?? "").trim();
  if (!candidate) {
    throw new Error("timezone is required");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
  } catch {
    throw new Error(`invalid timezone "${candidate}"`);
  }
  return candidate;
}

function validateHour(name: string, raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n) {
    throw new Error(`${name} must be an integer between ${OVERNIGHT_HOUR_MIN} and ${OVERNIGHT_HOUR_MAX}`);
  }
  if (n < OVERNIGHT_HOUR_MIN || n > OVERNIGHT_HOUR_MAX) {
    throw new Error(`${name} must be between ${OVERNIGHT_HOUR_MIN} and ${OVERNIGHT_HOUR_MAX}`);
  }
  return n;
}

function validateBudget(name: string, raw: unknown, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  if (n < min || n > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return n;
}

/**
 * Apply (and persist) a set of overnight-mode setting updates. Each
 * field is validated at the API boundary; the whole update is
 * rejected if any field is invalid. Returns the post-write effective
 * config (loaded fresh via `loadConfig()`).
 */
export async function updateOvernightConfig(
  update: OvernightConfigUpdate,
  updatedBy: string,
): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const writes: Array<{ key: string; value: string }> = [];
  if (update.enabled !== undefined) {
    if (typeof update.enabled !== "boolean") {
      throw new Error("enabled must be a boolean");
    }
    writes.push({ key: SETTING_OVERNIGHT_ENABLED, value: update.enabled ? "true" : "false" });
  }
  if (update.timezone !== undefined) {
    const tz = validateTimezoneStrict(String(update.timezone));
    writes.push({ key: SETTING_OVERNIGHT_TIMEZONE, value: tz });
  }
  if (update.startHour !== undefined) {
    writes.push({
      key: SETTING_OVERNIGHT_START_HOUR,
      value: String(validateHour("startHour", update.startHour)),
    });
  }
  if (update.endHour !== undefined) {
    writes.push({
      key: SETTING_OVERNIGHT_END_HOUR,
      value: String(validateHour("endHour", update.endHour)),
    });
  }
  if (update.retryBudget !== undefined) {
    writes.push({
      key: SETTING_OVERNIGHT_RETRY_BUDGET,
      value: String(
        validateBudget(
          "retryBudget",
          update.retryBudget,
          OVERNIGHT_RETRY_BUDGET_MIN,
          OVERNIGHT_RETRY_BUDGET_MAX,
        ),
      ),
    });
  }
  if (update.ingestRecoveryBudget !== undefined) {
    writes.push({
      key: SETTING_OVERNIGHT_INGEST_RECOVERY_BUDGET,
      value: String(
        validateBudget(
          "ingestRecoveryBudget",
          update.ingestRecoveryBudget,
          OVERNIGHT_INGEST_RECOVERY_BUDGET_MIN,
          OVERNIGHT_INGEST_RECOVERY_BUDGET_MAX,
        ),
      ),
    });
  }
  if (update.applyNudgeBudget !== undefined) {
    writes.push({
      key: SETTING_OVERNIGHT_APPLY_NUDGE_BUDGET,
      value: String(
        validateBudget(
          "applyNudgeBudget",
          update.applyNudgeBudget,
          OVERNIGHT_APPLY_NUDGE_BUDGET_MIN,
          OVERNIGHT_APPLY_NUDGE_BUDGET_MAX,
        ),
      ),
    });
  }

  for (const w of writes) {
    await setSystemSetting(w.key, w.value, updatedBy);
  }
  return loadConfig();
}

// ──────────── Task #2085: operator one-press re-arm of parked windows ────────────

/**
 * Classify the checkpoint of a search-strategy re-run into a re-arm
 * outcome. Shared by the operator re-arm path so the worker event and
 * the stamped `reArmOutcome` agree.
 */
function classifyReArmCheckpoint(
  cp: {
    status: string;
    statusReason: string | null;
    ingested: number;
  },
  source: SearchReArmOutcome["source"],
  at: string,
): SearchReArmOutcome {
  const ingested = typeof cp.ingested === "number" ? cp.ingested : 0;
  if (ingested > 0) {
    return { kind: "ingested", ingested, at, source };
  }
  if (cp.status === "complete" || cp.status === "empty_source") {
    // Walked the whole window under the search strategy and found
    // nothing missing — the month is genuinely covered now.
    return { kind: "resolved_covered", ingested: 0, at, source };
  }
  if (
    cp.status === "partial" &&
    (cp.statusReason ?? "").includes("safety_max_pages_reached_resume_available")
  ) {
    // Even the search strategy hit the page cap with 0 ingested — stays
    // parked.
    return { kind: "still_empty", ingested: 0, at, source };
  }
  // blocked / failed / anything else — the re-run could not complete.
  return {
    kind: "error",
    ingested: 0,
    at,
    source,
    detail: `${cp.status}${cp.statusReason ? `:${cp.statusReason}` : ""}`,
  };
}

/**
 * Is a parked window eligible to be (re-)armed in a drain epoch that
 * started at `sinceIso`? Eligible when it is parked and has NOT already
 * been operator-re-armed during this same epoch (its last
 * `operator_rearm` outcome, if any, predates `sinceIso`). This is what
 * lets the background drain terminate: a window that re-runs and stays
 * parked (`error`) is stamped with `at >= sinceIso`, so it is not
 * re-picked for the rest of the epoch.
 *
 * Convergence: a window already proven `still_empty` (it walked the
 * whole month under the search strategy and ingested nothing) is
 * permanently ineligible — re-running it would just dead-run again. This
 * matters because the status/countPending caller passes a *fresh*
 * `sinceIso` on every poll; without this terminal exclusion such windows
 * would be re-offered forever and the `rearm_parked_front_recovery_windows`
 * action could never settle to "not needed". If genuinely-new data later
 * lands for the month, the auto-closure loop unparks it via its
 * fresh-checkpoint trigger (`decideAutoUnpark`), independent of re-arm.
 */
function isReArmEligible(entry: ParkedWindowEntry, sinceIso: string): boolean {
  const outcome = entry.reArmOutcome;
  if (!outcome) return true;
  if (outcome.kind === "still_empty") return false;
  if (outcome.source !== "operator_rearm") return true;
  return outcome.at < sinceIso;
}

/**
 * List the parked months eligible for an operator re-arm in the epoch
 * that started at `sinceIso`. Read-only.
 */
export async function listReArmableParkedWindows(
  sinceIso: string,
  stateStore?: FrontAutoClosureStateStore,
): Promise<string[]> {
  const state = await (stateStore ? stateStore.load() : loadState());
  const parked = state.parkedWindows ?? {};
  return Object.entries(parked)
    .filter(([, entry]) => isReArmEligible(entry, sinceIso))
    .map(([month]) => month)
    .sort();
}

/**
 * Re-arm a single parked window: re-run it once, fresh (no resume), so
 * `buildInitialPath` rebuilds under the search strategy (when the
 * `front_recovery_sparse_month_search_strategy_enabled` switch is on),
 * then act on the outcome:
 *   • ingested / resolved_covered → unpark the window.
 *   • still_empty / error         → keep it parked and stamp the
 *                                   `reArmOutcome` so the drain doesn't
 *                                   re-pick it this epoch and Phase 3
 *                                   can show what happened.
 *
 * Returns the classified outcome, or `null` when the month was not
 * actually parked (e.g. already unparked by another path).
 *
 * The heavy Front walk happens inside `runTargetedWindowBackfill` (its
 * own throttling / page budget); state writes here are short and never
 * span the external walk.
 */
export async function reArmOneParkedWindow(
  month: string,
  actorId: string | null,
  sinceIso: string,
  stateStore?: FrontAutoClosureStateStore,
): Promise<{ month: string; outcome: SearchReArmOutcome | null }> {
  const load = stateStore ? () => stateStore.load() : loadState;
  const save = stateStore ? (s: PersistedState) => stateStore.save(s) : saveState;
  // Re-read state right before acting so concurrent unparks are seen.
  const pre = await load();
  const entry = pre.parkedWindows?.[month];
  if (!entry) {
    return { month, outcome: null };
  }
  if (!isReArmEligible(entry, sinceIso)) {
    return { month, outcome: entry.reArmOutcome ?? null };
  }

  const { runTargetedWindowBackfill } = await import(
    "./frontHistoricalRecovery"
  );
  const { monthStart, monthEnd } = monthBoundaries(month);
  const jobId = `auto_closure_rearm_${month}_${Date.now()}`;
  const cp = await runTargetedWindowBackfill(
    {
      label: autoClosureWindowLabel(month),
      afterTimestamp: Math.floor(monthStart.getTime() / 1000),
      beforeTimestamp: Math.floor(monthEnd.getTime() / 1000),
    },
    { resume: false, jobId },
  );

  const at = new Date().toISOString();
  const outcome = classifyReArmCheckpoint(cp, "operator_rearm", at);

  if (outcome.kind === "ingested" || outcome.kind === "resolved_covered") {
    // Forward progress (new rows) or proven-covered — release the
    // window so the auto-closer resumes normal handling.
    await unparkRecoveryWindow(month, stateStore);
  } else {
    // Stays parked — stamp the outcome (short DB hold, no external work).
    const post = await load();
    const cur = post.parkedWindows?.[month];
    if (cur) {
      // Task #2230 — maintain the consecutive-error streak so an operator
      // can tell an auth-blocked window (count climbing) apart from one
      // that re-ran cleanly but found nothing (`still_empty`). Increment
      // on a transient `error`; reset on any other (here, `still_empty`).
      cur.reArmConsecutiveErrors =
        outcome.kind === "error"
          ? (cur.reArmConsecutiveErrors ?? 0) + 1
          : 0;
      cur.reArmOutcome = outcome;
      cur.searchEscalated = true;
      cur.searchEscalatedAt = cur.searchEscalatedAt ?? at;
      await save(post);
    }
  }

  workerLog({
    worker: "front_auto_closure",
    event: "job_completed",
    details: {
      subevent: "ingest_recovery_window_operator_rearm",
      month,
      actor_id: actorId,
      outcome: outcome.kind,
      ingested: outcome.ingested ?? 0,
      checkpoint_status: cp.status,
      checkpoint_reason: cp.statusReason,
    },
  });

  return { month, outcome };
}

export interface ReArmDrainResult {
  state: "started" | "already-running" | "nothing-to-do" | "switch_off";
  detail: string;
  totalParked: number;
}

/**
 * Start (or join) the background drain that re-arms every parked Front
 * recovery window once under the search strategy. Shared by the CEO
 * prod-action and the Team-Lead recovery-panel route so both surfaces
 * drive exactly one drain implementation.
 *
 * The heavy per-window Front walks run on the worker pool inside the
 * drain loop (one window per chunk); this call returns immediately.
 */
export async function startParkedWindowReArmDrain(
  actorId: string | null,
  stateStore?: FrontAutoClosureStateStore,
): Promise<ReArmDrainResult> {
  // The search strategy switch must be on — otherwise a re-run would
  // just rebuild the legacy enumeration and dead-run again.
  if (!isSearchEscalationEnabled()) {
    return {
      state: "switch_off",
      detail:
        "The search strategy switch (front_recovery_sparse_month_search_strategy_enabled) is OFF. Turn it on first, otherwise re-arming would just rebuild the legacy enumeration.",
      totalParked: 0,
    };
  }
  const { startBackgroundDrain } = await import("./prodActionBackgroundDrain");
  // Epoch for this drain: a window re-armed during this run is stamped
  // with `at >= sinceIso`, so it stops being eligible and the drain
  // terminates after a single pass over the parked set.
  const sinceIso = new Date().toISOString();
  const out = await startBackgroundDrain(
    {
      actionId: "rearm_parked_front_recovery_windows",
      actionTitle: "Re-arm parked Front recovery windows",
      attributionLabel: "maintenance:prod-actions-rearm-parked-front-windows",
      unit: "window(s)",
      countPending: async () => {
        const months = await listReArmableParkedWindows(sinceIso, stateStore);
        return months.length;
      },
      runChunk: async () => {
        const months = await listReArmableParkedWindows(sinceIso, stateStore);
        if (months.length === 0) return { processed: 0 };
        const { outcome } = await reArmOneParkedWindow(
          months[0],
          actorId,
          sinceIso,
          stateStore,
        );
        // A null outcome means the window was no longer parked when we
        // reached it (raced an unpark) — still count it as processed so
        // the drain advances.
        const key = outcome?.kind ?? "skipped";
        return { processed: 1, perKey: { [key]: 1 } };
      },
    },
    actorId,
  );
  return {
    state: out.state,
    detail: out.detail,
    totalParked: out.totalAtStart,
  };
}

/**
 * Task #2098 — Start (or join) a background drain that re-arms a SINGLE
 * parked Front recovery window under the search strategy. This is the
 * per-window analogue of `startParkedWindowReArmDrain`: operators who
 * want to re-drive just one suspect month (a specific YYYY-MM that
 * recently parked) get a cheaper, targeted action instead of re-running
 * the whole parked set.
 *
 * Each month gets its own `actionId` (`..._${month}`) so per-window
 * presses are independent of each other and of the all-windows drain
 * (no cross-month single-flight collision). The heavy Front walk runs on
 * the worker pool inside `reArmOneParkedWindow`; this call returns
 * immediately. Convergence mirrors the all-drain: a window re-armed this
 * epoch is stamped `at >= sinceIso` (or unparked / proven `still_empty`)
 * so `isReArmEligible` returns false on the next poll and the drain
 * terminates after a single pass.
 */
export async function startOneParkedWindowReArmDrain(
  month: string,
  actorId: string | null,
  stateStore?: FrontAutoClosureStateStore,
): Promise<ReArmDrainResult> {
  // The search strategy switch must be on — otherwise a re-run would
  // just rebuild the legacy enumeration and dead-run again.
  if (!isSearchEscalationEnabled()) {
    return {
      state: "switch_off",
      detail:
        "The search strategy switch (front_recovery_sparse_month_search_strategy_enabled) is OFF. Turn it on first, otherwise re-arming would just rebuild the legacy enumeration.",
      totalParked: 0,
    };
  }
  const { startBackgroundDrain } = await import("./prodActionBackgroundDrain");
  const sinceIso = new Date().toISOString();
  const out = await startBackgroundDrain(
    {
      actionId: `rearm_parked_front_recovery_window_${month}`,
      actionTitle: `Re-arm parked Front recovery window ${month}`,
      attributionLabel:
        "maintenance:prod-actions-rearm-parked-front-window",
      unit: "window(s)",
      countPending: async () => {
        const state = await (stateStore ? stateStore.load() : loadState());
        const entry = state.parkedWindows?.[month];
        if (!entry) return 0;
        return isReArmEligible(entry, sinceIso) ? 1 : 0;
      },
      runChunk: async () => {
        const state = await (stateStore ? stateStore.load() : loadState());
        const entry = state.parkedWindows?.[month];
        if (!entry || !isReArmEligible(entry, sinceIso)) {
          return { processed: 0 };
        }
        const { outcome } = await reArmOneParkedWindow(
          month,
          actorId,
          sinceIso,
          stateStore,
        );
        const key = outcome?.kind ?? "skipped";
        return { processed: 1, perKey: { [key]: 1 } };
      },
    },
    actorId,
  );
  return {
    state: out.state,
    detail: out.detail,
    totalParked: out.totalAtStart,
  };
}

export const __frontAutoClosureTestHelpers = {
  loadConfig,
  loadState,
  saveState,
  isIngestCandidate,
  isApplyCandidate,
  monthBoundaries,
  newSkipCounters,
  EMPTY_STATE,
  DEFAULTS,
  // Task #1885
  recoveryCheckpointKey,
  autoClosureWindowLabel,
  readRecoveryCheckpoint,
  updateDeadRunStreak,
  // Task #1905
  maybeCloseDedupeOnlyWindow,
  sampleApplyLayerForMonth,
  // Task #1890
  shouldAutoUnparkWindow,
  // Task #2085
  isDeadRunCheckpoint,
  isLegacyStrategyDeadRun,
  isSearchEscalationEnabled,
  classifyReArmCheckpoint,
  isReArmEligible,
  // Task #2118 — re-arm progress badge projection.
  collectReArmDrainStatuses,
};

// Silence unused-import warnings for symbols intentionally exported by
// modules but not directly referenced after refactors.
void and;
void desc;
void eq;
void isNotNull;
