// @cross-instance-safe: enqueue-only tick — enqueues a dedupe-keyed work_queue job; the handler runs once per claim and duplicate enqueues collapse via wq_dedupe_key_idx.
/**
 * Task #2365 — Auto-upgrade older Front coverage months to message grain.
 *
 * Background. A finalized Front coverage row (Task #1837 / #1920 / #2290)
 * can publish its headline at one of several denominator grains, recorded
 * in `front_analytics_monthly_coverage.denominator_unit`:
 *   - `conversations_all`     — Task #1837 conversation-count search
 *                               fallback (plan-limited months).
 *   - `inbound_conversations` / `inbound_messages` — single-direction
 *                               Analytics rows that never got an outbound
 *                               denominator.
 *   - `messages_all`          — the real, both-direction MESSAGE-grain
 *                               denominator (Tasks #1920 / #2290).
 *
 * `messages_all` is the only grain that answers "did we capture 100% of
 * MESSAGES". The plan-limited / search-sourced months reach it only by
 * running the opt-in per-message enumeration walk
 * (`front_analytics_per_message_enum_enabled`) — and, until this task, a
 * human had to press the `reach_front_coverage_full_message_grain`
 * prod-action to drive each month there. This module is the bounded,
 * default-OFF *driver* that does that automatically on a cadence, exactly
 * like the Task #1984 close-gap and Task #2010 backfill drivers.
 *
 * What it does each tick:
 *   1. Reads finalized, already-pulled, non-current months whose
 *      `denominator_unit` is NOT yet `messages_all` (oldest first, so the
 *      backlog converges from the start of the table), up to a per-tick
 *      month budget.
 *   2. For each, calls `refreshMonth({ forceSearchFallback: true,
 *      forceRerun: true })` — the same search-fallback re-probe the
 *      prod-action uses. When the enumeration switch is ON that advances
 *      one bounded, resumable enumeration chunk; once the walk COMPLETES
 *      the row flips to `messages_all` (see `runSearchFallback` →
 *      `maybeRunPerMessageEnumeration` in `frontAnalyticsCoverage.ts`).
 *   3. Re-reads the row and reports whether the grain upgraded this tick
 *      or merely advanced (still walking).
 *
 * This is MEASUREMENT-ONLY: it re-probes the denominator and recomputes
 * the row, but it does NOT ingest missing messages — the #1984 / #2010
 * outbound-gap drivers own that numerator repair, so the two are
 * complementary and safe to run together. The enumeration walk it triggers
 * issues Front HTTP calls (Conversations Search → Messages list) entirely
 * outside any DB hold and is naturally rate-limited + auth-breaker-aware
 * via the shared Front client.
 *
 * Bounded + idempotent + gated, mirroring the sibling drivers:
 *   - default-OFF master switch,
 *   - per-tick month budget (1..MAX),
 *   - hard-gate on `front_analytics_per_message_enum_enabled` (without it
 *     the search fallback can never reach message grain — no-op with a
 *     reason instead of burning Front budget that cannot help),
 *   - honors queue-pause + `KILL_SWITCH_NON_CRITICAL_SWEEPS`,
 *   - no-ops while the Front auth breaker is open,
 *   - resumability comes for free from the per-month enumeration
 *     checkpoint owned by `frontAnalyticsCoverage.ts`,
 *   - persists a last-run JSON summary for the operator readout.
 */
import { sql } from "drizzle-orm";
import { workerDb } from "../db";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { PERF } from "../perfConfig";
import { isQueuePaused } from "./queueDrainControl";
import { frontAuthBreakerActive } from "./frontAuthBreaker";
import {
  refreshMonth,
  getExistingMonth,
  currentMonthLabel,
  isMessageGrainDenominator,
  DENOMINATOR_UNIT_MESSAGES_ALL,
} from "./frontAnalyticsCoverage";

export const QUEUE_NAME = "front_message_grain_upgrade";

/** Master enable switch. Default OFF — opt-in because the tick spawns
 * real Front enumeration HTTP traffic, not a pure cache read. */
export const SETTING_ENABLED = "front_message_grain_upgrade_enabled";

/** Per-tick budget: how many conversation-grain months to re-probe per
 * tick. Bounded 1..MAX so a backlog can never fan out unboundedly. */
export const SETTING_MAX_MONTHS_PER_TICK =
  "front_message_grain_upgrade_max_months_per_tick";

const DEFAULT_MAX_MONTHS_PER_TICK = 1;
const MAX_MONTHS_PER_TICK_CAP = 12;

/** The per-message enumeration switch this driver depends on. Without it
 * ON the search fallback only ever produces a conversation-grain
 * denominator, so a tick can never upgrade a month — it's a hard-gap
 * reason, not a silent no-op. */
export const REQUIRED_ENUM_SWITCH =
  "front_analytics_per_message_enum_enabled" as const;

/** Persisted JSON summary of the most recent tick for the operator
 * readout (avoids scraping worker logs). */
export const SETTING_LAST_RUN = "front_message_grain_upgrade_last_run";

export const TICK_INTERVAL_MS = Number(
  process.env.FRONT_MESSAGE_GRAIN_UPGRADE_INTERVAL_MS || 60 * 60_000,
);

let interval: ReturnType<typeof setInterval> | null = null;

/**
 * Test seam. `upgradeMonth` re-probes a month through the real
 * `refreshMonth` search-fallback path, which issues live Front HTTP
 * traffic. Tests inject a deterministic stand-in (typically one that just
 * flips the row's `denominator_unit` in the DB) so the selection +
 * outcome logic can be pinned without a live Front. Production leaves it
 * null and uses the real `refreshMonth`.
 */
type RefreshMonthFn = typeof refreshMonth;
let refreshMonthOverride: RefreshMonthFn | null = null;
async function doRefreshMonth(
  ...args: Parameters<RefreshMonthFn>
): ReturnType<RefreshMonthFn> {
  return (refreshMonthOverride ?? refreshMonth)(...args);
}

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

async function loadMaxMonthsPerTick(): Promise<number> {
  const raw = (
    await getSystemSetting(SETTING_MAX_MONTHS_PER_TICK).catch(() => null)
  )?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_MONTHS_PER_TICK;
  return Math.min(MAX_MONTHS_PER_TICK_CAP, Math.floor(n));
}

export interface ConversationGrainMonth {
  month: string;
  monthStart: Date;
  monthEnd: Date;
  /** Current denominator grain (NULL when never set). */
  denominatorUnit: string | null;
  appliedCoveragePct: number | null;
}

function mapMonthRows(rows: unknown): ConversationGrainMonth[] {
  const list = ((rows as any).rows ?? (rows as unknown as any[])) as Array<{
    month: string;
    month_start: Date | string;
    month_end: Date | string;
    denominator_unit: string | null;
    applied_coverage_pct: number | string | null;
  }>;
  return list.map((r) => ({
    month: r.month,
    monthStart:
      r.month_start instanceof Date ? r.month_start : new Date(r.month_start),
    monthEnd:
      r.month_end instanceof Date ? r.month_end : new Date(r.month_end),
    denominatorUnit: r.denominator_unit ?? null,
    appliedCoveragePct:
      r.applied_coverage_pct == null ? null : Number(r.applied_coverage_pct),
  }));
}

/**
 * Read finalized, already-pulled, non-current coverage rows whose
 * denominator grain is NOT yet `messages_all`, oldest-first so the
 * backlog converges deterministically from the start of the table. Pure
 * read against the cached coverage table — no Front API call.
 *
 * `pulled_at IS NOT NULL` deliberately excludes never-measured months —
 * those are the normal first-pull worker's job; this driver only UPGRADES
 * the grain of a row that already has a measured (conversation-grain)
 * denominator.
 */
export async function selectMessageGrainUpgradeMonths(
  limit: number,
  now: Date = new Date(),
): Promise<ConversationGrainMonth[]> {
  const current = currentMonthLabel(now);
  const rows = await workerDb.execute(sql`
    SELECT month, month_start, month_end, denominator_unit, applied_coverage_pct
    FROM front_analytics_monthly_coverage
    WHERE is_finalized_month = true
      AND pulled_at IS NOT NULL
      AND month <> ${current}
      AND denominator_unit IS DISTINCT FROM ${DENOMINATOR_UNIT_MESSAGES_ALL}
    ORDER BY month ASC
    LIMIT ${limit}
  `);
  return mapMonthRows(rows);
}

/**
 * Read a single coverage row by `month` (YYYY-MM) regardless of its
 * current grain. Used by the operator-scoped "Upgrade this month" action:
 * the operator explicitly targets one row, so we re-drive exactly that
 * month and let the shared per-month logic report the outcome
 * (`already_message_grain` when the row is already at message grain).
 * Returns an empty list when the month has no coverage row. Pure read.
 */
export async function selectMessageGrainUpgradeMonthForMonth(
  month: string,
): Promise<ConversationGrainMonth[]> {
  const rows = await workerDb.execute(sql`
    SELECT month, month_start, month_end, denominator_unit, applied_coverage_pct
    FROM front_analytics_monthly_coverage
    WHERE month = ${month}
    LIMIT 1
  `);
  return mapMonthRows(rows);
}

/**
 * Verdict for an operator-scoped "Upgrade this month" request. The
 * scheduled selector only ever picks eligible months, but a direct API
 * caller could pass any `month`, so the trigger route validates the target
 * against the SAME eligibility filters the selector uses
 * (finalized + already-pulled + non-current + sub-`messages_all`) before
 * enqueuing — an ineligible month is rejected with a plain-English reason
 * rather than burning a no-op worker job.
 */
export type ScopedMonthIneligibleCode =
  | "not_found"
  | "current_month"
  | "not_finalized"
  | "not_pulled"
  | "already_message_grain";

export type ScopedMonthEligibility =
  | { eligible: true }
  | { eligible: false; code: ScopedMonthIneligibleCode; reason: string };

/**
 * Classify whether a single `month` (YYYY-MM) is a valid upgrade target.
 * Reads only the columns the selector filters on. Pure read against the
 * cached coverage table — no Front API call.
 */
export async function classifyScopedMonthEligibility(
  month: string,
  now: Date = new Date(),
): Promise<ScopedMonthEligibility> {
  const current = currentMonthLabel(now);
  const rows = await workerDb.execute(sql`
    SELECT is_finalized_month, pulled_at, denominator_unit
    FROM front_analytics_monthly_coverage
    WHERE month = ${month}
    LIMIT 1
  `);
  const row = ((rows as any).rows ?? (rows as unknown as any[]))[0] as
    | {
        is_finalized_month: boolean | null;
        pulled_at: Date | string | null;
        denominator_unit: string | null;
      }
    | undefined;
  if (!row) {
    return {
      eligible: false,
      code: "not_found",
      reason: `No coverage row exists for ${month} yet, so there is nothing to upgrade.`,
    };
  }
  if (month === current) {
    return {
      eligible: false,
      code: "current_month",
      reason: `${month} is the current, still-open month; only finalized past months can be upgraded.`,
    };
  }
  if (row.is_finalized_month !== true) {
    return {
      eligible: false,
      code: "not_finalized",
      reason: `${month} is not finalized yet, so it can't be upgraded.`,
    };
  }
  if (row.pulled_at == null) {
    return {
      eligible: false,
      code: "not_pulled",
      reason: `${month} has never been measured, so there is no grain to upgrade. Run a coverage refresh first.`,
    };
  }
  if (isMessageGrainDenominator(row.denominator_unit)) {
    return {
      eligible: false,
      code: "already_message_grain",
      reason: `${month} is already at message grain (messages_all); no upgrade is needed.`,
    };
  }
  return { eligible: true };
}

export type UpgradeMonthOutcome =
  | "upgraded"
  | "advanced"
  | "already_message_grain"
  | "error";

export interface UpgradeMonthAttempt {
  month: string;
  outcome: UpgradeMonthOutcome;
  /** Grain before this tick. */
  beforeUnit: string | null;
  /** Grain after this tick. */
  afterUnit: string | null;
  /** Applied coverage % after this tick (for the readout). */
  appliedCoveragePct: number | null;
  /** Front error code when `outcome === "error"`. */
  errorCode?: string;
}

export interface MessageGrainUpgradeTickResult {
  ranAt: string;
  enabled: boolean;
  paused: boolean;
  /** True when the per-message enumeration switch is ON (required). */
  enumEnabled: boolean;
  maxMonthsPerTick: number;
  candidateMonths: number;
  attempted: UpgradeMonthAttempt[];
  reason?: string;
  /** Present when scoped to a single operator-chosen month. */
  scopedMonth?: string;
}

/**
 * Persist the most recent tick summary so the operator status route can
 * surface what the upgrader last did. Never throws — a persistence
 * failure must not fail the tick.
 */
async function persistLastRun(
  result: MessageGrainUpgradeTickResult,
): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(result));
  } catch (err: any) {
    console.warn(
      `[FrontMessageGrainUpgrade] Failed to persist last-run summary: ${
        err?.message ?? err
      }`,
    );
  }
}

export type LastUpgradeRunStatus = "ok" | "never_run" | "unreadable";

export interface LastUpgradeRunRead {
  lastRun: MessageGrainUpgradeTickResult | null;
  status: LastUpgradeRunStatus;
  error?: string;
}

/**
 * Read the persisted last-run summary and classify the outcome so the
 * operator status route can tell "never ran" (normal on a fresh deploy)
 * apart from "stored value unreadable" (a persistence regression). Never
 * throws — a settings-read failure is reported as `unreadable`.
 */
export async function readLastMessageGrainUpgradeRun(): Promise<LastUpgradeRunRead> {
  let raw: string | undefined;
  try {
    raw = (await getSystemSetting(SETTING_LAST_RUN))?.value?.trim();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[FrontMessageGrainUpgrade] Failed to read last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }
  if (!raw) return { lastRun: null, status: "never_run" };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { lastRun: parsed as MessageGrainUpgradeTickResult, status: "ok" };
    }
    const message = "stored last-run value was not a JSON object";
    console.warn(`[FrontMessageGrainUpgrade] ${message}`);
    return { lastRun: null, status: "unreadable", error: message };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[FrontMessageGrainUpgrade] Failed to parse last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }
}

/**
 * Re-probe a single month via the search fallback and report whether its
 * grain upgraded to `messages_all` this tick. MEASUREMENT-ONLY — never
 * throws (a per-month failure is captured as an `error` attempt so the
 * tick keeps going).
 */
async function upgradeMonth(
  m: ConversationGrainMonth,
): Promise<UpgradeMonthAttempt> {
  const beforeUnit = m.denominatorUnit;
  if (isMessageGrainDenominator(beforeUnit)) {
    return {
      month: m.month,
      outcome: "already_message_grain",
      beforeUnit,
      afterUnit: beforeUnit,
      appliedCoveragePct: m.appliedCoveragePct,
    };
  }
  try {
    const res = await doRefreshMonth({
      month: m.month,
      monthStart: m.monthStart,
      monthEnd: m.monthEnd,
      isCurrentMonth: false,
      forceSearchFallback: true,
      forceRerun: true,
    });
    const after = await getExistingMonth(m.month);
    const afterUnit = after?.denominatorUnit ?? beforeUnit;
    const appliedCoveragePct = after?.appliedCoveragePct ?? m.appliedCoveragePct;
    if (res.outcome === "front_error") {
      return {
        month: m.month,
        outcome: "error",
        beforeUnit,
        afterUnit,
        appliedCoveragePct,
        ...(res.errorCode ? { errorCode: res.errorCode } : {}),
      };
    }
    const upgraded =
      isMessageGrainDenominator(afterUnit) &&
      !isMessageGrainDenominator(beforeUnit);
    return {
      month: m.month,
      outcome: upgraded ? "upgraded" : "advanced",
      beforeUnit,
      afterUnit,
      appliedCoveragePct,
    };
  } catch (err: any) {
    console.warn(
      `[FrontMessageGrainUpgrade] month=${m.month} upgrade tick failed: ${
        err?.message ?? err
      }`,
    );
    return {
      month: m.month,
      outcome: "error",
      beforeUnit,
      afterUnit: beforeUnit,
      appliedCoveragePct: m.appliedCoveragePct,
      errorCode: "upgrade_tick_failed",
    };
  }
}

/**
 * One upgrade pass. Reads conversation-grain months, then re-probes each
 * via the search fallback (advancing one bounded enumeration chunk per
 * month) so the grain converges toward `messages_all`. Never throws on a
 * per-month failure; the next tick retries. Persists the summary as the
 * last-run readout before returning.
 */
export async function runMessageGrainUpgradeTick(opts?: {
  now?: Date;
  /** When set, scope to this single month (YYYY-MM). */
  month?: string;
}): Promise<MessageGrainUpgradeTickResult> {
  const result = await computeMessageGrainUpgradeTick(opts);
  await persistLastRun(result);
  return result;
}

async function computeMessageGrainUpgradeTick(opts?: {
  now?: Date;
  month?: string;
}): Promise<MessageGrainUpgradeTickResult> {
  const now = opts?.now ?? new Date();
  const scopedMonth = opts?.month;
  const enabled = parseBool(
    (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
    false,
  );
  const paused = isQueuePaused(QUEUE_NAME);
  const enumEnabled = parseBool(
    (await getSystemSetting(REQUIRED_ENUM_SWITCH).catch(() => null))?.value,
    false,
  );
  const maxMonthsPerTick = await loadMaxMonthsPerTick();
  const result: MessageGrainUpgradeTickResult = {
    ranAt: now.toISOString(),
    enabled,
    paused,
    enumEnabled,
    maxMonthsPerTick,
    candidateMonths: 0,
    attempted: [],
    ...(scopedMonth ? { scopedMonth } : {}),
  };

  if (!enabled) {
    result.reason = "upgrader disabled in system_settings";
    return result;
  }
  if (paused) {
    result.reason = "queue paused via queue_drain_state";
    return result;
  }
  if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
    result.reason = "KILL_SWITCH_NON_CRITICAL_SWEEPS=true";
    return result;
  }
  if (!enumEnabled) {
    // Hard gate: without per-message enumeration the search fallback can
    // never reach message grain, so a run cannot help. No-op instead of
    // burning Front budget.
    result.reason = `per-message enumeration disabled — flip ${REQUIRED_ENUM_SWITCH} ON first`;
    return result;
  }
  if (frontAuthBreakerActive()) {
    result.reason = "front auth breaker open — reconnect Front first";
    return result;
  }

  const candidates = scopedMonth
    ? await selectMessageGrainUpgradeMonthForMonth(scopedMonth)
    : await selectMessageGrainUpgradeMonths(maxMonthsPerTick, now);
  result.candidateMonths = candidates.length;
  if (candidates.length === 0) {
    result.reason = scopedMonth
      ? `month ${scopedMonth} has no coverage row to upgrade`
      : "no finalized months below messages_all grain";
    return result;
  }

  for (const m of candidates) {
    result.attempted.push(await upgradeMonth(m));
  }
  return result;
}

async function enqueueScheduledTick(): Promise<void> {
  try {
    if (isQueuePaused(QUEUE_NAME)) {
      console.log(
        `[FrontMessageGrainUpgrade] enqueue_skipped_queue_paused queue=${QUEUE_NAME} reason=queue_drain_state ts=${new Date().toISOString()}`,
      );
      return;
    }
    // Cheap due-check: skip enqueue entirely when disabled so a default-
    // OFF deploy never piles up no-op jobs.
    const enabled = parseBool(
      (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
      false,
    );
    if (!enabled) return;
    const { enqueueJob } = await import("./workScheduler");
    const bucket = Math.floor(Date.now() / TICK_INTERVAL_MS);
    await enqueueJob({
      queueName: QUEUE_NAME,
      workloadClass: "maintenance",
      priority: 200,
      payload: { trigger: "scheduled", bucket },
      dedupeKey: `${QUEUE_NAME}:scheduled:${bucket}`,
      maxAttempts: 2,
    });
  } catch (err: any) {
    console.warn(
      `[FrontMessageGrainUpgrade] enqueue scheduled tick failed: ${
        err?.message ?? err
      }`,
    );
  }
}

export function startFrontMessageGrainUpgradeScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void enqueueScheduledTick();
  }, TICK_INTERVAL_MS);
  console.log(
    `[FrontMessageGrainUpgrade] enqueue scheduler started (every ${
      TICK_INTERVAL_MS / 60_000
    }min; default OFF via ${SETTING_ENABLED}) — work runs in worker pool via ${QUEUE_NAME} queue`,
  );
}

export function stopFrontMessageGrainUpgradeScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __frontMessageGrainUpgradeTestHelpers = {
  enqueueScheduledTick,
  loadMaxMonthsPerTick,
  upgradeMonth,
  /** Inject a deterministic `refreshMonth` stand-in (or null to restore the
   * real one) so tests can pin selection + outcome logic without live Front
   * HTTP traffic. */
  setRefreshMonthOverride(fn: RefreshMonthFn | null): void {
    refreshMonthOverride = fn;
  },
};
