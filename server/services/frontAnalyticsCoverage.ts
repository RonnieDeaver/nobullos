// @cross-instance-safe: enqueue-only tick — enqueues a dedupe-keyed work_queue job; the handler runs once per claim and duplicate enqueues collapse via wq_dedupe_key_idx.
/**
 * Task #1643 — Front Analytics all-time coverage worker + summary helper.
 *
 * This is the only place that:
 *   - exposes the coverage floor — a HARD-CODED constant
 *     (`FRONT_ADOPTION_DATE`), never derived or persisted (Task #2481)
 *   - calls the Front Analytics client to populate `front_total_messages`
 *   - recomputes the local `fetched_into_nobull` / `applied_into_nobull`
 *     counts from `front_sync_emails` / `raw_communication_records`
 *   - upserts cache rows in `front_analytics_monthly_coverage`
 *
 * The summary helper (`getFrontAnalyticsCoverageSummary`) is the cached,
 * read-only aggregator the dashboard hits — it NEVER calls Front and
 * NEVER recomputes counts.
 *
 * MEASUREMENT-ONLY: nothing in this file writes into `front_sync_emails`,
 * `raw_communication_records`, or any other pipeline table.
 *
 * @db-pool-intent: ambient — shared coverage read/measurement helper.
 * `getFrontAnalyticsCoverageSummary` inherits its pool from whatever
 * caller wrapped it: API request handlers run on the `api` pool, while
 * the `reach_front_coverage_full_message_grain` prod-action drains it
 * under `runWithWorkerDb(...)` so it correctly lands on the `worker`
 * pool. Using `getDb()` (not the bare `db` import) is also what lets the
 * isolated-schema test harness redirect the read.
 */
import { and, eq, lt, sql } from "drizzle-orm";
// @periodic-request-pool-exception: the periodic tick only ENQUEUES work-queue jobs (heavy scans run on the worker pool via queue handlers); the direct db import serves this module's request-path coverage-read exports.
import { db, getDb, withDbAttribution } from "../db";
import {
  frontAnalyticsMonthlyCoverage,
  type FrontAnalyticsMonthlyCoverage,
} from "@shared/schema";
import {
  frontPlanLimitedFallback,
  type FrontPlanLimitedFallback,
} from "@shared/frontConsoleMetrics";
import {
  getSystemSetting,
  setSystemSetting,
  deleteSystemSetting,
} from "../storage/settingsStorage";
import { PERF } from "../perfConfig";
import { isQueuePaused } from "./queueDrainControl";
import { firstTriggerBlockedReason } from "./frontTriggerBlockedReasons";
import { frontAuthBreakerActive } from "./frontAuthBreaker";
import { getValidFrontAccessToken, FrontAuthError } from "./frontIntegration";
import {
  pullMonthlyMessageCountResolved,
  pullMonthlyMessageCountViaSearchFallbackResolved,
  pullMonthlyMessagesByDirectionResolved,
  enumerateMonthlyMessagesByDirectionTickResolved,
  explainFrontAnalyticsError,
  FrontAnalyticsError,
  isPlanLimitSnippet,
  type SearchFallbackResult,
  type EnumerationCheckpoint,
  type EnumerationTickResult,
} from "./frontAnalyticsClient";

/**
 * Task #1681 — denominator-source / -unit constants. The two columns
 * (`denominator_source`, `denominator_unit`) are nullable on the
 * coverage row; legacy rows without explicit values are treated as
 * the Analytics defaults.
 */
export const DENOMINATOR_SOURCE_ANALYTICS = "analytics_reports" as const;
export const DENOMINATOR_SOURCE_SEARCH = "search_conversations" as const;
export const DENOMINATOR_UNIT_MESSAGES = "inbound_messages" as const;
/**
 * Task #1681 legacy — value previously written by the search fallback
 * before Task #1709 dropped the unsupported `is:inbound` modifier on
 * Front's search API. Old rows that have NOT been re-pulled or
 * recomputed under Task #1837 still carry this value.
 */
export const DENOMINATOR_UNIT_CONVERSATIONS = "inbound_conversations" as const;
/**
 * Task #1837 — unified unit for both the numerator and the new primary
 * denominator (Conversations Search, all directions). Any pair of
 * fields with this unit can be compared directly for coverage %.
 */
export const DENOMINATOR_UNIT_CONVERSATIONS_ALL = "conversations_all" as const;
export const NUMERATOR_UNIT_CONVERSATIONS_ALL = "conversations_all" as const;

/**
 * Task #1920 — message-grain denominator unit. Written when the
 * per-message enumeration (`GET /conversations/{id}/messages`) has fully
 * measured a search-sourced month, so `front_total_messages` carries an
 * actual inbound+outbound *message* count rather than a conversation
 * count. Comparable to the per-direction message numerator, NOT to
 * `conversations_all`; the UI/alerts must not mix the two.
 */
export const DENOMINATOR_UNIT_MESSAGES_ALL = "messages_all" as const;

/**
 * Task #1920 — a coverage row whose denominator is message-grain
 * (`messages_all`) MUST keep a message-grain numerator on every (re)write.
 * Centralizing this single predicate keeps all write paths — the recompute
 * sweeps AND both failure-persistence branches — from silently downgrading a
 * message-grain row to conversation-grain `fetched/applied` counts (which
 * would corrupt the coverage % and undo the message-grain headline).
 */
export function isMessageGrainDenominator(
  denominatorUnit: string | null | undefined,
): boolean {
  return denominatorUnit === DENOMINATOR_UNIT_MESSAGES_ALL;
}

/**
 * Task #1920 — recoverable auth-blocked status value. A coverage probe
 * that 401s while the Front auth breaker is CLOSED (i.e. a transient
 * bad-token window, not a genuine disconnect) lands here with
 * `unrecoverable=false` so the worker auto-re-probes it once auth is
 * healthy instead of freezing the month forever.
 */
export const FRONT_ANALYTICS_STATUS_AUTH_BLOCKED = "auth_blocked" as const;

/**
 * Task #1920 — how long to wait before re-probing an auth-blocked month.
 * Auth restoration is operator-driven and we want fast recovery once
 * Front auth is healthy again, so this is short (default 6h) compared to
 * the 7-day plan-limit cooldown.
 */
export const AUTH_BLOCKED_REPROBE_TTL_MS = Number(
  process.env.FRONT_ANALYTICS_AUTH_BLOCKED_REPROBE_TTL_MS || 6 * 60 * 60_000,
);

/**
 * Task #1837 — two unit values are considered comparable when both
 * resolve to "conversations, all directions". The legacy
 * `inbound_conversations` value (Task #1681) is treated as equivalent
 * for back-compat read paths because Task #1709 already proved the
 * search query was counting all directions, not just inbound.
 */
export function isComparableUnit(unit: string | null | undefined): boolean {
  return (
    unit === DENOMINATOR_UNIT_CONVERSATIONS_ALL ||
    unit === DENOMINATOR_UNIT_CONVERSATIONS
  );
}

export function unitsMatch(
  numeratorUnit: string | null | undefined,
  denominatorUnit: string | null | undefined,
): boolean {
  if (!numeratorUnit || !denominatorUnit) return false;
  if (numeratorUnit === denominatorUnit) return true;
  return isComparableUnit(numeratorUnit) && isComparableUnit(denominatorUnit);
}

/**
 * Task #1681 — re-probe Analytics for plan-limited months ~weekly so
 * an operator plan upgrade automatically heals the cache without
 * manual intervention. Override via env for tests.
 */
export const PLAN_LIMIT_REPROBE_TTL_MS = Number(
  process.env.FRONT_ANALYTICS_PLAN_LIMIT_REPROBE_TTL_MS || 7 * 24 * 60 * 60_000,
);

export const QUEUE_NAME = "front_analytics_coverage_refresh";

// Task #2481 made the Front coverage floor a hard-coded constant
// (`FRONT_ADOPTION_DATE`), so this `system_settings` key is no longer read
// or written by any floor logic. The export is deliberately RETAINED only
// so the one-off `purge_dead_front_adoption_date_setting` prod-action
// (Task #2483) and the Task #2481 regression tests can name the dead row
// they delete / prove is never written.
export const SETTING_ADOPTION_DATE = "front_adoption_date";
export const SETTING_REFRESH_ENABLED = "front_analytics_refresh_enabled";
export const SETTING_REFRESH_LOOKBACK_CURRENT_ONLY =
  "front_analytics_refresh_lookback_current_month_only";

// Task #1787 (Stage 1) — measurement-cadence settings. The legacy
// `front_analytics_refresh_enabled` (above) is the emergency master
// kill switch and remains the operator-pause path; these new keys
// govern HOW OFTEN measurement runs in steady state when the master
// switch is on.
export const SETTING_MEASUREMENT_REFRESH_ENABLED =
  "front_analytics_measurement_refresh_enabled";
export const SETTING_CURRENT_MONTH_REFRESH_INTERVAL_HOURS =
  "front_analytics_current_month_refresh_interval_hours";
export const SETTING_INCOMPLETE_MONTH_REFRESH_INTERVAL_HOURS =
  "front_analytics_incomplete_month_refresh_interval_hours";
export const SETTING_FINALIZED_MONTH_SKIP_ENABLED =
  "front_analytics_finalized_month_skip_enabled";
export const SETTING_PLAN_LIMITED_REPROBE_INTERVAL_DAYS =
  "front_analytics_plan_limited_reprobe_interval_days";

// Task #1983 — opt-in master switch for the per-message enumeration
// fallback. The walk is a heavy Front-API surface (Conversations Search
// → Messages for every plan-limited month) so it stays OFF unless an
// operator turns it on. When OFF, plan-limited months keep showing
// "not yet measured" for the per-direction denominators exactly as
// before.
export const SETTING_PER_MESSAGE_ENUM_ENABLED =
  "front_analytics_per_message_enum_enabled";
// Per-month resumable checkpoint key prefix (one `system_settings` row
// per month). Stored as JSON; never holds secrets or PII.
export const SETTING_ENUM_CHECKPOINT_PREFIX =
  "front_analytics_enum_checkpoint:";

const DEFAULT_CURRENT_MONTH_INTERVAL_HOURS = 6;
const DEFAULT_INCOMPLETE_MONTH_INTERVAL_HOURS = 24;
const DEFAULT_PLAN_LIMITED_REPROBE_DAYS = 7;

interface MeasurementCadence {
  measurementEnabled: boolean;
  currentMonthIntervalMs: number;
  incompleteMonthIntervalMs: number;
  finalizedSkipEnabled: boolean;
  planLimitedReprobeMs: number;
}

function parseHoursSetting(raw: string | null | undefined, fallbackHours: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallbackHours * 3600_000;
  return n * 3600_000;
}

function parseDaysSetting(raw: string | null | undefined, fallbackDays: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallbackDays * 86400_000;
  return n * 86400_000;
}

async function loadMeasurementCadence(): Promise<MeasurementCadence> {
  const [measurement, current, incomplete, finalized, planLimited] =
    await Promise.all([
      getSystemSetting(SETTING_MEASUREMENT_REFRESH_ENABLED).catch(() => null),
      getSystemSetting(SETTING_CURRENT_MONTH_REFRESH_INTERVAL_HOURS).catch(
        () => null,
      ),
      getSystemSetting(SETTING_INCOMPLETE_MONTH_REFRESH_INTERVAL_HOURS).catch(
        () => null,
      ),
      getSystemSetting(SETTING_FINALIZED_MONTH_SKIP_ENABLED).catch(() => null),
      getSystemSetting(SETTING_PLAN_LIMITED_REPROBE_INTERVAL_DAYS).catch(
        () => null,
      ),
    ]);
  return {
    measurementEnabled: parseBool(measurement?.value, true),
    currentMonthIntervalMs: parseHoursSetting(
      current?.value,
      DEFAULT_CURRENT_MONTH_INTERVAL_HOURS,
    ),
    incompleteMonthIntervalMs: parseHoursSetting(
      incomplete?.value,
      DEFAULT_INCOMPLETE_MONTH_INTERVAL_HOURS,
    ),
    finalizedSkipEnabled: parseBool(finalized?.value, true),
    planLimitedReprobeMs: parseDaysSetting(
      planLimited?.value,
      DEFAULT_PLAN_LIMITED_REPROBE_DAYS,
    ),
  };
}

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

// ──────────────── Adoption date (Task #2481 — fixed floor) ────────────────

/**
 * Task #2481 — the Front coverage floor is a FIXED business decision
 * (July 2025, established by Task #2369) and is hard-coded here as the
 * single source of truth. There is NO code path — worker auto-derivation,
 * operator route, or UI control — that can change it.
 *
 * Why hard-coded: the floor used to live in a mutable
 * `system_settings.front_adoption_date` row. `ensureFrontAdoptionDate()`
 * only left it alone *while that row existed*; if the row went missing the
 * next worker tick silently re-derived the floor from
 * `MIN(source_event_log.received_at)` for Front. Because Front webhook
 * event-logging only began 2026-04-16, that auto-derivation regressed the
 * floor from `2025-07-01` down to `2026-04-16`, dropping ~9 months of real
 * Front history (Jul 2025–Mar 2026, tens of thousands of conversations)
 * out of all coverage math. Hard-coding the constant eliminates that entire
 * regression class.
 *
 * Any lingering `system_settings.front_adoption_date` row is DEAD/IGNORED —
 * left in place but never read or written by this module.
 */
export const FRONT_ADOPTION_DATE = "2025-07-01";

/**
 * Returns the fixed coverage adoption date (`FRONT_ADOPTION_DATE`).
 * Task #2481 — performs no `source_event_log` query and no
 * `system_settings` read/write; it simply returns the constant. Kept as an
 * async function so existing callers are unchanged. Never returns null.
 */
export function ensureFrontAdoptionDate(): Promise<string> {
  return Promise.resolve(FRONT_ADOPTION_DATE);
}

// ──────────────── Month math ────────────────

export interface MonthBoundary {
  month: string;
  monthStart: Date;
  monthEnd: Date;
}

export function listMonthsFromAdoption(
  adoptionDate: string,
  now: Date = new Date(),
): MonthBoundary[] {
  const start = new Date(adoptionDate);
  if (!Number.isFinite(start.getTime())) return [];
  const months: MonthBoundary[] = [];
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  const endY = now.getUTCFullYear();
  const endM = now.getUTCMonth();
  while (y < endY || (y === endY && m <= endM)) {
    const monthStart = new Date(Date.UTC(y, m, 1));
    const monthEnd = new Date(Date.UTC(y, m + 1, 1));
    months.push({
      month: `${y}-${String(m + 1).padStart(2, "0")}`,
      monthStart,
      monthEnd,
    });
    m++;
    if (m === 12) {
      m = 0;
      y++;
    }
  }
  return months;
}

export function currentMonthLabel(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ──────────────── Local counts ────────────────

async function countFetchedForMonth(
  monthStart: Date,
  monthEnd: Date,
): Promise<number> {
  const rows = await withDbAttribution(
    "frontAnalyticsCoverage:countFetched",
    () =>
      getDb().execute(sql`
        SELECT COUNT(*)::int AS n
        FROM front_sync_emails
        WHERE last_message_at >= ${monthStart.toISOString()}
          AND last_message_at <  ${monthEnd.toISOString()}
      `),
  );
  const r = ((rows as any).rows ?? (rows as unknown as any[]))[0];
  return Number(r?.n ?? 0) || 0;
}

/**
 * Task #1974 — per-direction local message counts. The numerator for
 * the new inbound % / outbound % cells comes from
 * `raw_communication_records.direction` (∈ inbound / outbound /
 * internal). Source filter is the same as `countFetchedForMonth` so
 * the per-direction sum is comparable to Front's
 * `num_messages_received` + `num_messages_sent`.
 *
 * `internal` is excluded on purpose — Analytics doesn't bill internal
 * comments as either received or sent, so including them would skew
 * coverage % above 100. Rows with a NULL `direction` (legacy /
 * pre-direction-backfill writes) also fall out; they are exposed
 * separately via the existing `countAppliedForMonth` if needed.
 */
async function countMessagesByDirectionForMonth(
  monthStart: Date,
  monthEnd: Date,
): Promise<{ inbound: number; outbound: number }> {
  const rows = await withDbAttribution(
    "frontAnalyticsCoverage:countByDirection",
    () =>
      getDb().execute(sql`
        SELECT direction, COUNT(*)::int AS n
        FROM raw_communication_records
        WHERE source_type = 'front_email'
          AND direction IN ('inbound', 'outbound')
          AND timestamp IS NOT NULL
          AND timestamp >= ${monthStart.toISOString()}
          AND timestamp <  ${monthEnd.toISOString()}
        GROUP BY direction
      `),
  );
  const list = ((rows as any).rows ?? (rows as unknown as any[])) as Array<{
    direction: string;
    n: number;
  }>;
  let inbound = 0;
  let outbound = 0;
  for (const r of list) {
    if (r.direction === "inbound") inbound = Number(r.n) || 0;
    if (r.direction === "outbound") outbound = Number(r.n) || 0;
  }
  return { inbound, outbound };
}

/** Task #1974 — `direction_data_source` enum values. */
export const DIRECTION_DATA_SOURCE_ANALYTICS = "analytics_reports";
export const DIRECTION_DATA_SOURCE_PER_MESSAGE = "per_message_enumeration";

function computeDirectionCoverage(
  frontCount: number | null,
  localCount: number,
): { pct: number | null; gap: number | null } {
  if (frontCount == null) return { pct: null, gap: null };
  const denom = frontCount > 0 ? frontCount : 0;
  const pct = denom === 0 ? 0 : Math.min(100, (localCount / denom) * 100);
  const gap = Math.max(0, frontCount - localCount);
  return { pct, gap };
}

/**
 * Task #2290 — build a MESSAGE-grain headline (denominator + numerator)
 * from Front's per-direction message counts and the comparable local
 * message total. This is the SINGLE shared construction used by every
 * write path that has both Front-side direction counts:
 *   1. the in-plan Analytics path (`pullMonthlyMessagesByDirection`),
 *   2. the search-fallback path once per-message enumeration completes,
 *   3. the free recompute/backfill conversion.
 *
 * Centralizing it keeps the numerator grain locked to the denominator
 * grain (both `messages_all`) so a month can never silently regress to a
 * conversation-count stand-in — see the coverage-numerator/denominator
 * grain invariant. At message grain `raw_communication_records` IS the
 * materialized message mirror, so fetched == applied == the local
 * message total and the headline applyGap equals the true missing-message
 * count.
 */
/**
 * Task #2795 — denominator floor invariant for message-grain months.
 * The persisted denominator is always at least the local unique-message count
 * for that month, since those local rows are verified proof those messages
 * exist. This prevents applied/denominator > 1 (never >100%).
 *
 * Returns `denominator = max(frontCount, localMessageTotal)` and
 * `floorExcess = max(0, localMessageTotal - frontCount)` — how many more
 * local messages we hold than Front's enumerated total.
 */
function applyMessageGrainDenominatorFloor(
  frontCount: number,
  localMessageTotal: number,
): { denominator: number; floorExcess: number } {
  const denominator = Math.max(frontCount, localMessageTotal);
  const floorExcess = Math.max(0, localMessageTotal - frontCount);
  return { denominator, floorExcess };
}

function buildMessageGrainHeadline(args: {
  inboundFront: number;
  outboundFront: number;
  localInbound: number;
  localOutbound: number;
}): {
  denominator: number;
  fetched: number;
  applied: number;
  denominatorUnit: string;
  numeratorUnit: string;
  denominatorFloorExcess: number;
} {
  const localMessageTotal = args.localInbound + args.localOutbound;
  const frontCount = args.inboundFront + args.outboundFront;
  const { denominator, floorExcess } = applyMessageGrainDenominatorFloor(
    frontCount,
    localMessageTotal,
  );
  return {
    denominator,
    fetched: localMessageTotal,
    applied: localMessageTotal,
    denominatorUnit: DENOMINATOR_UNIT_MESSAGES_ALL,
    numeratorUnit: DENOMINATOR_UNIT_MESSAGES_ALL,
    denominatorFloorExcess: floorExcess,
  };
}

// ──────────── Per-message enumeration fallback (Task #1983) ────────────
//
// Plan-limited months have no Analytics per-direction denominators. When
// the opt-in `front_analytics_per_message_enum_enabled` switch is on, we
// walk Conversations Search → Messages (see
// `enumerateMonthlyMessagesByDirectionTick` in the client) and count
// messages per direction at message grain. The walk is far larger than a
// single tick, so it advances one bounded chunk per coverage tick and
// resumes from a per-month checkpoint stored in `system_settings`. Until
// the walk completes the Front per-direction counts stay at their prior
// value (NULL → "not yet measured") so the panel never shows a
// misleading partial denominator.

/** Result the search-fallback path folds into its single row upsert. */
interface EnumOutcome {
  inboundFront: number | null;
  outboundFront: number | null;
  directionDataSource: string | null;
}

// In-process guard: never run two enumeration walks for the same month
// at once (a worker tick racing an operator manual retry). The loser
// simply skips enumeration for this call and keeps the existing values.
const enumerationInFlight = new Set<string>();

function enumCheckpointKey(month: string): string {
  return `${SETTING_ENUM_CHECKPOINT_PREFIX}${month}`;
}

async function loadEnumCheckpoint(
  month: string,
): Promise<EnumerationCheckpoint | null> {
  const raw = (
    await getSystemSetting(enumCheckpointKey(month)).catch(() => null)
  )?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EnumerationCheckpoint;
  } catch {
    // Corrupt checkpoint → start the month over rather than wedging.
    return null;
  }
}

async function saveEnumCheckpoint(
  month: string,
  cp: EnumerationCheckpoint,
): Promise<void> {
  await setSystemSetting(
    enumCheckpointKey(month),
    JSON.stringify(cp),
    "system",
  );
}

async function clearEnumCheckpoint(month: string): Promise<void> {
  await deleteSystemSetting(enumCheckpointKey(month)).catch(() => {});
}

async function maybeRunPerMessageEnumeration(args: {
  month: string;
  monthStart: Date;
  monthEnd: Date;
  existing: FrontAnalyticsMonthlyCoverage | undefined;
  /**
   * Task #2482 — when true, advance the walk even if the global
   * `front_analytics_per_message_enum_enabled` switch is OFF. The
   * reach-coverage prod-action sets this so a single press can re-measure
   * the in-scope dropped-history months to message grain without flipping
   * the global switch. All other bounds (per-tick budget, per-month cap,
   * in-flight guard, truncation handling) are unchanged.
   */
  force?: boolean;
}): Promise<EnumOutcome> {
  const { month, monthStart, monthEnd, existing } = args;
  const fallback: EnumOutcome = {
    inboundFront: existing?.messagesInboundFront ?? null,
    outboundFront: existing?.messagesOutboundFront ?? null,
    directionDataSource: existing?.directionDataSource ?? null,
  };

  // Opt-in only — heavy Front-API surface stays OFF unless an operator
  // turns it on, OR a caller explicitly forces it (Task #2482: the
  // reach-coverage prod-action re-measuring the in-scope dropped history).
  const enumEnabled = parseBool(
    (await getSystemSetting(SETTING_PER_MESSAGE_ENUM_ENABLED).catch(
      () => null,
    ))?.value,
    false,
  );
  if (!enumEnabled && !args.force) return fallback;

  // Already measured via enumeration → nothing left to do.
  if (existing?.directionDataSource === DIRECTION_DATA_SOURCE_PER_MESSAGE) {
    return fallback;
  }

  if (enumerationInFlight.has(month)) return fallback;
  enumerationInFlight.add(month);
  try {
    const checkpoint = await loadEnumCheckpoint(month);
    let tick: EnumerationTickResult;
    try {
      tick = await enumerateMonthlyMessagesByDirectionTickResolved({
        monthStart,
        monthEnd,
        checkpoint,
        conversationBudget: PERF.FRONT_ANALYTICS_ENUM_CONVERSATIONS_PER_TICK,
        messagePageBudget: PERF.FRONT_ANALYTICS_ENUM_MESSAGE_PAGES_PER_TICK,
      });
    } catch (err) {
      // Auth / rate-limit / transient — keep the existing checkpoint so
      // the next tick resumes from the same place; surface nothing (the
      // row stays "not yet measured").
      console.warn(
        `[FrontAnalyticsCoverage] month=${month} per-message enumeration tick failed (will resume next tick): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return fallback;
    }

    if (tick.done) {
      // A truncated walk (per-month conversation cap or per-conversation
      // page cap) produced an UNDERCOUNT — it must never be published as
      // a real measured denominator. Clear the checkpoint (the cap won't
      // resolve itself on a retry) but leave the per-direction columns
      // unmeasured so the UI keeps showing "not yet measured".
      await clearEnumCheckpoint(month);
      if (tick.checkpoint.truncated) {
        console.warn(
          `[FrontAnalyticsCoverage] month=${month} per-message enumeration truncated (processed=${tick.checkpoint.processedConversationCount}); leaving per-direction counts unmeasured`,
        );
        return fallback;
      }
      return {
        inboundFront: tick.checkpoint.inboundCount,
        outboundFront: tick.checkpoint.outboundCount,
        directionDataSource: DIRECTION_DATA_SOURCE_PER_MESSAGE,
      };
    }

    // Not done — persist progress, leave the per-direction counts
    // unmeasured until the walk completes.
    await saveEnumCheckpoint(month, tick.checkpoint);
    return fallback;
  } finally {
    enumerationInFlight.delete(month);
  }
}

async function countAppliedForMonth(
  monthStart: Date,
  monthEnd: Date,
): Promise<number> {
  // Task #1837 — count DISTINCT Front conversations (not raw rows).
  // `raw_communication_records` carries one row per Front message, so a
  // straight COUNT(*) is in "messages" units and is not comparable
  // against the conversation-keyed denominator. `external_thread_id`
  // is the Front conversation id for `source_type='front_email'` rows
  // (see `server/services/frontWebhookIngestion.ts`'s
  // `externalThreadId: normalized.conversationId` write).
  const rows = await withDbAttribution(
    "frontAnalyticsCoverage:countApplied",
    () =>
      getDb().execute(sql`
        SELECT COUNT(DISTINCT external_thread_id)::int AS n
        FROM raw_communication_records
        WHERE source_type = 'front_email'
          AND external_thread_id IS NOT NULL
          AND timestamp IS NOT NULL
          AND timestamp >= ${monthStart.toISOString()}
          AND timestamp <  ${monthEnd.toISOString()}
      `),
  );
  const r = ((rows as any).rows ?? (rows as unknown as any[]))[0];
  return Number(r?.n ?? 0) || 0;
}

// ──────────────── Per-month refresh ────────────────

export type MonthRefreshOutcome =
  | "ok"
  | "ok_current_upsert"
  | "ok_search_fallback"
  | "skipped_existing_finalized"
  | "skipped_unrecoverable"
  | "front_error";

export interface MonthRefreshResult {
  month: string;
  outcome: MonthRefreshOutcome;
  errorCode?: string;
  errorMessage?: string;
  unrecoverable?: boolean;
  frontTotalMessages?: number;
  fetchedIntoNobull?: number;
  appliedIntoNobull?: number;
  /** Task #1681 — surfaced so callers/route can pill source. */
  denominatorSource?: string | null;
  denominatorUnit?: string | null;
  /** Task #1780 — surfaced so manual-retry toast/UI can show fresh pulled-at. */
  pulledAt?: string | null;
  /** Task #1780 — surfaced so the row badge can refresh after a manual retry. */
  frontAnalyticsStatus?: string | null;
  /** Task #1780 — persisted error string (post-prefix `<code>: <message>`). */
  frontAnalyticsError?: string | null;
}

/**
 * Task #1675 — classify a typed Front Analytics error as
 * unrecoverable (don't retry every tick) vs. transient (do retry).
 *
 * Unrecoverable: auth failures (401/403) — operator must reconnect or
 * grant the missing scope; and 4xx/410 from the report endpoint
 * (typically "out of retention"). Anything 5xx, timeout, rate-limited,
 * partial, or unexpected-shape stays retriable so a flake doesn't
 * permanently stick a month.
 */
export function isUnrecoverableErrorCode(
  code: string,
  status?: number,
): boolean {
  if (code === "front_analytics_auth_failed") return true;
  // Task #1681 — `front_analytics_plan_limited` is NOT unrecoverable:
  // the search-API fallback handles it, and we re-probe Analytics
  // weekly in case the workspace plan is upgraded.
  if (code === "front_analytics_plan_limited") return false;
  // Task #2743 — a transient transport abort/timeout that exhausted its
  // bounded retry budget is NOT unrecoverable: it is re-tried next tick,
  // exactly like `front_analytics_rate_limited`. Explicit so the intent is
  // clear even though unknown codes already default to recoverable below.
  if (code === "front_analytics_transport_failed") return false;
  if (code === "front_analytics_report_failed") {
    if (typeof status === "number" && status >= 400 && status < 500) {
      return true;
    }
  }
  return false;
}

/**
 * Task #1709 — true when a row was stamped
 * `front_analytics_auth_failed` + `unrecoverable=true` ONLY because
 * the old (narrow / 200-char truncated) `isPlanLimitSnippet` matcher
 * missed an envelope-wrapped plan-history 403 body. Those rows are
 * now misclassified — they should route to the search fallback. The
 * broadened detector + 1 KB body snippet means the persisted error
 * string contains the literal plan-history phrase. We use that
 * substring match as the discriminator: rows stuck for legitimate
 * reasons (missing OAuth scope, revoked token, etc.) do NOT contain
 * the phrase and stay unrecoverable.
 *
 * Returning `true` means the worker tick and manual Retry should
 * treat the row as recoverable and let `refreshMonth` re-run it; a
 * successful Analytics pull or search-fallback pull will then
 * naturally clear `unrecoverable` via the normal write path.
 */
export function shouldReEvaluateMisclassifiedUnrecoverable(
  existing: FrontAnalyticsMonthlyCoverage | undefined,
): boolean {
  if (!existing?.unrecoverable) return false;
  const err = existing.frontAnalyticsError;
  if (!err) return false;
  if (!err.startsWith("front_analytics_auth_failed")) return false;
  return isPlanLimitSnippet(err);
}

/**
 * Task #1920 — Front auth is currently healthy enough to justify
 * re-probing an auth-blocked month. The auth-dead breaker is the
 * authoritative durable signal: while it is open Front's refresh token
 * is terminally rejected and any probe will 401 again, so we keep backing
 * off. A closed breaker means a probe has a real chance to succeed.
 */
export function isFrontAuthHealthy(): boolean {
  return !frontAuthBreakerActive();
}

/**
 * Task #1920 — classify a probe failure into the persisted recoverability
 * fields. A 401 (`front_analytics_auth_failed`) is only TERMINAL when the
 * Front auth breaker is open (refresh token genuinely revoked / Front
 * disconnected). Otherwise it is a transient/auth-blocked condition that
 * must auto-recover once auth is healthy — never a permanent freeze.
 * Non-auth codes defer to the existing `isUnrecoverableErrorCode` policy.
 */
export function classifyProbeFailure(
  code: string,
  status?: number,
): { unrecoverable: boolean; authBlocked: boolean } {
  if (code === "front_analytics_auth_failed") {
    // Task #1920 — only a confirmed 401 is the recoverable transient
    // bad-token window. A non-plan-limit 403 (the plan-limit 403 is routed
    // to `front_analytics_plan_limited` upstream and never reaches here) is a
    // genuine missing-scope / forbidden condition that retrying never heals,
    // so it stays terminal until an operator reconnects Front with the right
    // scopes. Anything that is not a confirmed 401 is treated as terminal.
    if (status !== 401) {
      return { unrecoverable: true, authBlocked: false };
    }
    if (frontAuthBreakerActive()) {
      // Genuine terminal disconnect — operator must reconnect Front.
      return { unrecoverable: true, authBlocked: false };
    }
    // Transient bad-token window — recoverable, auto-re-probe.
    return { unrecoverable: false, authBlocked: true };
  }
  return {
    unrecoverable: isUnrecoverableErrorCode(code, status),
    authBlocked: false,
  };
}

/**
 * Task #1920 — true when a row is frozen on a GENUINE 401
 * (`front_analytics_auth_failed`, NOT the plan-history misclassification
 * handled by `shouldReEvaluateMisclassifiedUnrecoverable`) and Front auth
 * is healthy again, so the worker should re-probe it (via the search
 * fallback) instead of skipping it forever. This is the auto-recovery
 * path the genuine-401 freeze never had: pre-Task #1920 a transient 401
 * during a bad-token window stamped `unrecoverable=true` and the worker
 * skipped the row on every subsequent tick even after auth was restored.
 *
 * Returning true means the worker tick should treat the row as
 * recoverable and let `refreshMonth` re-run it; a successful search pull
 * then clears `unrecoverable` via the normal write path.
 */
export function shouldReEvaluateAuthBlocked(
  existing: FrontAnalyticsMonthlyCoverage | undefined,
): boolean {
  if (!existing?.unrecoverable) return false;
  const err = existing.frontAnalyticsError;
  if (!err) return false;
  if (!err.startsWith("front_analytics_auth_failed")) return false;
  // Plan-history misclassifications are handled by the dedicated path.
  if (isPlanLimitSnippet(err)) return false;
  // Task #1920 — a genuine 403 (missing scope / forbidden) is terminal, not a
  // transient bad-token window. Never re-probe it on the auth-blocked path, or
  // an auth-healthy worker would re-hit the same 403 every tick. The persisted
  // failure message embeds the HTTP status (`... auth failed (403)`); a true
  // recoverable 401 carries `(401)` instead, so it still re-evaluates below.
  if (/auth failed \(403\)/.test(err)) return false;
  return isFrontAuthHealthy();
}

/**
 * Task #1920 — pull the Analytics denominator with a single inline
 * force-refresh-and-retry on a 401. The May 26–27 incident proved a
 * transient bad-token window can 401 a probe that a fresh token would
 * have served; rotating the access token once and retrying clears that
 * case before any classification/persistence decision is made. If the
 * breaker is open we do NOT retry (genuine disconnect — let it surface).
 */
// Test-only seam for the forced token refresh below. The refresh purpose
// (`front_analytics_coverage_401_retry`) is AUTHORITATIVE, so a real
// refresh failure here trips the global Front auth-dead breaker — under
// the routine test sweep that live Front OAuth POST (with the shared
// live credentials) could fail on transient token churn and sabotage
// every later Front scenario in the run. Under NODE_ENV=test the live
// refresh is therefore never attempted: suites either install an
// override (to script success/failure deterministically) or, by
// default, the forced refresh fails locally with a NON-terminal
// transient error so the original 401 is surfaced without any network
// call and without tripping the breaker. Production always takes the
// real `getValidFrontAccessToken` path (override is null and the
// NODE_ENV guard is off).
let __forceRefreshOverrideForTest: (() => Promise<void>) | null = null;
export function __setAnalyticsForceRefreshOverrideForTest(
  fn: (() => Promise<void>) | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setAnalyticsForceRefreshOverrideForTest is test-only");
  }
  __forceRefreshOverrideForTest = fn;
}

async function forceRefreshFrontTokenForAuthRetry(): Promise<void> {
  if (__forceRefreshOverrideForTest) {
    await __forceRefreshOverrideForTest();
    return;
  }
  if (process.env.NODE_ENV === "test") {
    // No override installed: fail the forced refresh locally (non-terminal,
    // no HTTP, no breaker trip) so the caller surfaces the original 401.
    throw new FrontAuthError(
      "front_refresh_failed_transient",
      "test-mode: live Front force-refresh disabled (install __setAnalyticsForceRefreshOverrideForTest to script this path)",
    );
  }
  await getValidFrontAccessToken({
    forceRefresh: true,
    purpose: "front_analytics_coverage_401_retry",
  });
}

async function pullAnalyticsWithAuthRetry(args: {
  monthStart: Date;
  monthEnd: Date;
}): Promise<{ value: number; reportId: string | null; status: string }> {
  try {
    return await pullMonthlyMessageCountResolved(args);
  } catch (err) {
    const code = err instanceof FrontAnalyticsError ? err.code : null;
    if (code === "front_analytics_auth_failed" && !frontAuthBreakerActive()) {
      try {
        await forceRefreshFrontTokenForAuthRetry();
      } catch {
        // The forced refresh itself failed — surface the original 401 so
        // the caller classifies it (breaker may now be open).
        throw err;
      }
      // Retry exactly once with the rotated token.
      return await pullMonthlyMessageCountResolved(args);
    }
    throw err;
  }
}

/**
 * Task #1681 — true if `analyticsPlanLimitedAt` is set and within the
 * re-probe TTL. When true the worker skips the Analytics submit and
 * goes straight to the search fallback (saves one guaranteed-403
 * roundtrip per tick). Cleared on the next successful Analytics
 * pull (`refreshMonth` sets `analyticsPlanLimitedAt: null`).
 */
function shouldSkipAnalyticsForPlanLimit(
  existing: FrontAnalyticsMonthlyCoverage | undefined,
  now: Date,
): boolean {
  const ts = existing?.analyticsPlanLimitedAt;
  if (!ts) return false;
  const ageMs = now.getTime() - ts.getTime();
  return ageMs >= 0 && ageMs < PLAN_LIMIT_REPROBE_TTL_MS;
}

/**
 * Task #1681 — inverse of `shouldSkipAnalyticsForPlanLimit`. True when
 * the row has a plan-limit memo that has aged past the TTL. The
 * worker uses this to re-include "finalized via search" rows in the
 * missing-completed batch so Analytics gets re-probed weekly.
 */
function isPlanLimitMemoStale(
  existing: FrontAnalyticsMonthlyCoverage | undefined,
  now: Date,
): boolean {
  const ts = existing?.analyticsPlanLimitedAt;
  if (!ts) return false;
  return now.getTime() - ts.getTime() >= PLAN_LIMIT_REPROBE_TTL_MS;
}

/**
 * Task #1780 — explicit helper for the "row is already finalized and
 * has nothing to re-pull" condition. Centralises what the worker tick
 * uses to short-circuit clean finalized completed months, so the
 * operator-vs-worker contract reads as a single named predicate at
 * the call site:
 *
 *   worker tick + clean finalized row        → skip (efficient)
 *   operator retry + any row                 → force re-run (intent)
 *
 * A row counts as "clean finalized" when ALL of these hold:
 *   - it is not the current month (current month is always upserted)
 *   - the row exists, is finalized, and has a non-null pulledAt
 *   - it has no persisted Front analytics error
 *   - any plan-limit memo is still within the re-probe TTL (a stale
 *     memo means we owe Analytics another probe to see if a plan
 *     upgrade healed the row)
 */
function isExistingFinalizedClean(
  existing: FrontAnalyticsMonthlyCoverage | undefined,
  isCurrentMonth: boolean,
  now: Date,
): boolean {
  if (isCurrentMonth) return false;
  if (!existing) return false;
  if (!existing.isFinalizedMonth) return false;
  if (!existing.pulledAt) return false;
  if (existing.frontAnalyticsError) return false;
  if (isPlanLimitMemoStale(existing, now)) return false;
  return true;
}

function computeCoverage(opts: {
  frontTotal: number;
  fetched: number;
  applied: number;
}): {
  ingestGap: number;
  applyGap: number;
  fetchedCoveragePct: number;
  appliedCoveragePct: number;
} {
  const ingestGap = Math.max(0, opts.frontTotal - opts.fetched);
  const applyGap = Math.max(0, opts.fetched - opts.applied);
  const denom = opts.frontTotal > 0 ? opts.frontTotal : 0;
  const fetchedCoveragePct =
    denom === 0 ? 0 : Math.min(100, (opts.fetched / denom) * 100);
  const appliedCoveragePct =
    denom === 0 ? 0 : Math.min(100, (opts.applied / denom) * 100);
  return {
    ingestGap,
    applyGap,
    fetchedCoveragePct,
    appliedCoveragePct,
  };
}

/**
 * Task #2087 — derived per-month *completeness* status.
 *
 * Before this task the coverage table only distinguished `final`
 * (`is_finalized_month=true` → denominator was measured) from
 * `current` / `error`. "Final" read as "done" to operators even when a
 * month had a huge ingest gap (e.g. 2026-04: 21,130 expected /
 * 1,858 fetched ≈ 19k missing) — masking the gap. This function
 * derives a single status that separates *measurement finalized* from
 * *ingest/apply actually complete*, using ONLY fields already present
 * on the row (no new Front call, no new mixed-unit denominator):
 *
 *   - `not-measured` — denominator absent, untrusted (units not
 *     comparable), never pulled, or stuck on a terminal auth/permanent
 *     failure. Surfaces "needs re-probe" instead of a false 0/100%.
 *   - `in-progress`  — the month is still settling: it is the current
 *     calendar month, the denominator is not finalized yet, or a pull
 *     is `pending`.
 *   - `ingest-gap`   — finalized + measured but Front has materially
 *     more messages than NoBull ever fetched (the masked case).
 *   - `apply-gap`    — finalized + measured but a material share of
 *     fetched messages were never applied.
 *   - `covered`      — finalized + measured with no material gap on any
 *     axis (ingest, apply, or per-direction inbound/outbound).
 *
 * `is_finalized_month` semantics are intentionally left untouched (it
 * still means "denominator measured"); this status sits alongside it.
 */
export type CoverageCompletenessStatus =
  | "covered"
  | "ingest-gap"
  | "apply-gap"
  | "in-progress"
  | "not-measured";

/**
 * A gap is "material" when it is at least this many percentage points
 * of the denominator (i.e. coverage on that axis is below
 * `100 − COVERAGE_MATERIAL_GAP_PCT`). Overridable for tests / tuning.
 */
export const COVERAGE_MATERIAL_GAP_PCT = (() => {
  const n = Number(process.env.FRONT_ANALYTICS_COVERAGE_MATERIAL_GAP_PCT);
  return Number.isFinite(n) && n >= 0 ? n : 5;
})();

export interface CoverageCompleteness {
  status: CoverageCompletenessStatus;
  reason: string;
}

export interface DeriveCompletenessInput {
  isCurrentMonth: boolean;
  isFinalizedMonth: boolean;
  pulledAt: Date | string | null;
  frontTotalMessages: number;
  ingestGap: number;
  applyGap: number;
  unitsComparable: boolean;
  frontAnalyticsStatus: string | null;
  frontAnalyticsError: string | null;
  needsReconnect: boolean;
  unrecoverable: boolean;
  messagesInboundCoveragePct: number | null;
  messagesOutboundCoveragePct: number | null;
}

export function deriveCoverageCompleteness(
  input: DeriveCompletenessInput,
): CoverageCompleteness {
  const materialPct =
    Number.isFinite(COVERAGE_MATERIAL_GAP_PCT) && COVERAGE_MATERIAL_GAP_PCT >= 0
      ? COVERAGE_MATERIAL_GAP_PCT
      : 5;
  const coveredFloor = 100 - materialPct;

  // 1. not-measured — the denominator can't be trusted, so neither can
  //    any coverage % derived from it. Lead with this so a missing /
  //    auth-failed month is never silently rendered as covered or 100%.
  const hasError = !!input.frontAnalyticsError;
  // Task #1920 — a recoverable auth-blocked month has a denominator we
  // can't trust yet, but it is NOT a permanent failure: it auto-re-probes
  // via search once Front auth is healthy. Surface it as not-measured with
  // a self-healing reason so operators don't mistake it for a dead month.
  if (input.frontAnalyticsStatus === FRONT_ANALYTICS_STATUS_AUTH_BLOCKED) {
    return {
      status: "not-measured",
      reason:
        "Denominator not measured — Front auth was blocked; auto-re-probing once auth is healthy.",
    };
  }
  if (hasError && (input.needsReconnect || input.unrecoverable)) {
    return {
      status: "not-measured",
      reason: input.needsReconnect
        ? "Denominator not measured — reconnect Front to re-probe."
        : "Denominator not measured — measurement failed permanently; needs re-probe.",
    };
  }
  if (!input.pulledAt) {
    return {
      status: "not-measured",
      reason: "Denominator not measured yet — needs a pull.",
    };
  }
  if (!input.unitsComparable) {
    return {
      status: "not-measured",
      reason: "Denominator units not comparable — needs re-probe.",
    };
  }

  // 2. in-progress — measurement is still settling. A non-finalized
  //    month (current month, or any month whose denominator hasn't been
  //    finalized) is not "done", but it isn't a confirmed gap either.
  if (input.frontAnalyticsStatus === "pending") {
    return { status: "in-progress", reason: "Measurement in progress." };
  }
  if (input.isCurrentMonth || !input.isFinalizedMonth) {
    return {
      status: "in-progress",
      reason: "Month still accumulating — denominator not finalized.",
    };
  }

  // 3. finalized + measured — classify against the real gaps. Ingest
  //    gap (Front has them, never fetched) takes precedence over apply
  //    gap (fetched, never applied), matching the alert recommendation.
  const denom = input.frontTotalMessages > 0 ? input.frontTotalMessages : 0;
  const ingestGapPct = denom > 0 ? (input.ingestGap / denom) * 100 : 0;
  const applyGapPct = denom > 0 ? (input.applyGap / denom) * 100 : 0;
  const inboundShort =
    typeof input.messagesInboundCoveragePct === "number" &&
    input.messagesInboundCoveragePct < coveredFloor;
  const outboundShort =
    typeof input.messagesOutboundCoveragePct === "number" &&
    input.messagesOutboundCoveragePct < coveredFloor;

  if (ingestGapPct >= materialPct) {
    return {
      status: "ingest-gap",
      reason: `Front has ~${Math.round(input.ingestGap).toLocaleString()} messages NoBull never fetched.`,
    };
  }
  if (applyGapPct >= materialPct) {
    return {
      status: "apply-gap",
      reason: `~${Math.round(input.applyGap).toLocaleString()} fetched messages were never applied.`,
    };
  }
  if (inboundShort || outboundShort) {
    const which = [
      inboundShort ? "inbound" : null,
      outboundShort ? "outbound" : null,
    ]
      .filter(Boolean)
      .join(" & ");
    return {
      status: "ingest-gap",
      reason: `Per-direction shortfall (${which}) below ${coveredFloor}% — messages still missing.`,
    };
  }
  return { status: "covered", reason: "Ingest and apply complete." };
}

export async function getExistingMonth(
  month: string,
): Promise<FrontAnalyticsMonthlyCoverage | undefined> {
  const [row] = await db
    .select()
    .from(frontAnalyticsMonthlyCoverage)
    .where(eq(frontAnalyticsMonthlyCoverage.month, month));
  return row as FrontAnalyticsMonthlyCoverage | undefined;
}

/**
 * Task #2434 — convergence budget for the
 * `reach_front_coverage_full_message_grain` prod-action. Once a month's
 * `coverageConvergenceAttempts` reaches this cap the sweep
 * (`shouldSweepFrontCoverageMonth`) excludes it permanently, so the action
 * converges instead of re-counting a month that can never reach
 * 100%-of-messages.
 */
export const FRONT_COVERAGE_CONVERGENCE_CAP = 3;

/**
 * Outcome of a single `reachFrontCoverageFullForMonth` drive, used to
 * advance the per-month convergence budget:
 *   - `progress`        — coverage advanced (after>before) or rows were
 *                         ingested ⇒ reset the budget to 0.
 *   - `auth_blocked`    — Front auth is down (breaker active or the row is
 *                         `auth_blocked`) ⇒ leave the budget UNCHANGED;
 *                         auth-down is recoverable, not "unreachable".
 *   - `unreachable`     — a clean (non-error) drive made no progress ⇒ there
 *                         is genuinely nothing more to fetch / the month is
 *                         plan-limited to conversation grain ⇒ jump straight
 *                         to the cap (terminal).
 *   - `transient_error` — the recovery threw (`recovery_error: …`) ⇒ bump
 *                         the budget by one (bounded at the cap).
 */
export type FrontCoverageConvergenceOutcome =
  | "progress"
  | "auth_blocked"
  | "unreachable"
  | "transient_error";

/**
 * Pure budget-advance decision (extracted for unit testing). Returns the
 * NEW attempt count, or `null` to mean "leave the stored value unchanged".
 */
export function nextCoverageConvergenceAttempts(
  current: number,
  outcome: FrontCoverageConvergenceOutcome,
): number | null {
  switch (outcome) {
    case "progress":
      return current === 0 ? null : 0;
    case "auth_blocked":
      return null;
    case "unreachable":
      return FRONT_COVERAGE_CONVERGENCE_CAP;
    case "transient_error":
      return Math.min(current + 1, FRONT_COVERAGE_CONVERGENCE_CAP);
  }
}

/**
 * Pure outcome-derivation for a single `reachFrontCoverageFullForMonth` drive
 * (extracted for unit testing). Maps the raw drive signals onto the
 * convergence outcome fed to `nextCoverageConvergenceAttempts`.
 *
 * `ingested` is the COMBINED progress count: Step 2.5's materialized per-message
 * rows PLUS Step 3's recovery ingest. Either path being non-zero means the month
 * made real progress this tick, so `progressed` is true and the outcome is
 * "progress" — even when Step 3 (`runTargetedWindowBackfill`) returned 0 because
 * every conversation was already applied. This is the Task #2711 safeguard:
 * a month whose materializer inserted rows must NOT be retired as "unreachable"
 * just because the recovery half found nothing new to fetch.
 *
 * Precedence (first match wins):
 *   progressed (after>before OR ingested>0 OR grain advanced) ⇒ "progress"
 *   authBlocked (breaker active or row=auth_blocked)          ⇒ "auth_blocked"
 *   materializer still in progress (Task #2708)               ⇒ "auth_blocked"
 *   recovery threw (status starts "recovery_error")           ⇒ "transient_error"
 *   clean drive, no progress                                  ⇒ "unreachable"
 */
export function deriveCoverageConvergenceOutcome(args: {
  before: number;
  after: number;
  ingested: number;
  grainAdvanced: boolean;
  authBlocked: boolean;
  status: string;
}): FrontCoverageConvergenceOutcome {
  const progressed =
    args.after > args.before || args.ingested > 0 || args.grainAdvanced;
  if (progressed) return "progress";
  if (args.authBlocked) return "auth_blocked";
  // materializer_in_progress is non-terminal — leave attempts unchanged.
  if (args.status === "materializer_in_progress") return "auth_blocked";
  if (args.status.startsWith("recovery_error")) return "transient_error";
  return "unreachable";
}

/**
 * Persist a month's convergence-attempt count. Uses `getDb()` so it runs
 * on the worker pool when called from the prod-action drain.
 */
export async function setCoverageConvergenceAttempts(
  month: string,
  attempts: number,
): Promise<void> {
  await withDbAttribution("frontAnalyticsCoverage:setConvergenceAttempts", () =>
    getDb()
      .update(frontAnalyticsMonthlyCoverage)
      .set({ coverageConvergenceAttempts: attempts, updatedAt: new Date() })
      .where(eq(frontAnalyticsMonthlyCoverage.month, month)),
  );
}

/**
 * Task #2745 — persist (or clear) a month's terminal deep-search-exhausted
 * marker. `exhausted=true` stamps `deep_search_exhausted_at=now()`; `false`
 * clears it back to NULL (called on any real progress so a revived month
 * re-opens). Uses `getDb()` so it runs on the worker pool when called from the
 * prod-action drain. Idempotent: writing the same state is harmless.
 */
export async function setCoverageDeepSearchExhausted(
  month: string,
  exhausted: boolean,
): Promise<void> {
  await withDbAttribution("frontAnalyticsCoverage:setDeepSearchExhausted", () =>
    getDb()
      .update(frontAnalyticsMonthlyCoverage)
      .set({
        deepSearchExhaustedAt: exhausted ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(frontAnalyticsMonthlyCoverage.month, month)),
  );
}

/**
 * Task #1692 — operator override to forcibly clear the plan-limit
 * memo on a single month so the next `refreshMonth` call re-probes
 * Analytics instead of going straight to the search fallback. Useful
 * right after a Front plan upgrade so operators don't have to wait
 * out the `PLAN_LIMIT_REPROBE_TTL_MS` (default 7d) cooldown.
 *
 * Returns true if a row was updated.
 */
export async function clearPlanLimitMemo(month: string): Promise<boolean> {
  const result = await db
    .update(frontAnalyticsMonthlyCoverage)
    .set({ analyticsPlanLimitedAt: null, updatedAt: new Date() })
    .where(eq(frontAnalyticsMonthlyCoverage.month, month));
  const rowCount = (result as any)?.rowCount;
  return typeof rowCount === "number" ? rowCount > 0 : true;
}

/**
 * Refresh a single month. Honors the immutability rule for finalized
 * completed months (existing row with a non-null `pulledAt` and
 * `isFinalizedMonth=true` is skipped). Current-month rows are always
 * upserted.
 */
export async function refreshMonth(opts: {
  month: string;
  monthStart: Date;
  monthEnd: Date;
  isCurrentMonth: boolean;
  runId?: string;
  /**
   * Task #1691 — when true, skip the Analytics submit entirely and go
   * straight to the search-API fallback. Used by the operator-facing
   * Retry button on plan-limited rows so a single click immediately
   * populates the denominator (the same path the one-shot
   * `scripts/backfill_front_search_fallback_2025.ts` would take via the
   * memoized fast path) without waiting on a guaranteed-403 Analytics
   * roundtrip and without depending on the plan-limit memo being set.
   * Also re-arms `unrecoverable=true` rows whose error contains the
   * plan-history phrase (`auth_failed` misclassifications).
   */
  forceSearchFallback?: boolean;
  /**
   * Task #1780 — operator-initiated bypass of the finalized-row
   * short-circuit. When `true`, `refreshMonth` re-runs the pull even
   * for a clean finalized row so manual Retry / Retry (search) /
   * Re-probe Analytics always honour the operator's "do it now"
   * intent. All other safety gates (kill switches, queue pause,
   * permission checks, plan-limit memo) still apply.
   *
   * Must NOT be set from the worker tick — the worker stays efficient
   * by skipping clean finalized rows. Only the operator-facing
   * endpoints in `server/routes/integrations.ts` set this.
   */
  forceRerun?: boolean;
  /**
   * Task #2482 — force the per-message enumeration walk to advance for this
   * month even when the global `front_analytics_per_message_enum_enabled`
   * switch is OFF. Set only by the `reach_front_coverage_full_message_grain`
   * prod-action (and its self-heal cadence) so a single operator press can
   * re-measure the in-scope dropped-history months to message grain without
   * also flipping the global enumeration switch. Always paired with
   * `forceSearchFallback`. Has no effect on the normal worker tick (which
   * never sets it).
   */
  forcePerMessageEnum?: boolean;
  /** Tests inject a fixed clock so plan-limit TTL math is deterministic. */
  now?: Date;
}): Promise<MonthRefreshResult> {
  const now = opts.now ?? new Date();
  const existing = await getExistingMonth(opts.month);
  // Task #1780 — operator-vs-worker contract:
  //   worker tick + clean finalized row → skip (efficient)
  //   operator retry + any row          → force rerun unless a safety
  //                                       gate (kill switch / queue
  //                                       pause / auth) blocks earlier.
  // `forceRerun` is only ever set by the manual-retry endpoints; the
  // worker tick and the auto-closure retry path never set it.
  // `forceSearchFallback` is also an operator-only flag and likewise
  // bypasses the short-circuit so the search path actually runs.
  if (
    !opts.forceRerun &&
    !opts.forceSearchFallback &&
    isExistingFinalizedClean(existing, opts.isCurrentMonth, now)
  ) {
    return { month: opts.month, outcome: "skipped_existing_finalized" };
  }

  // Task #1691 — operator chose to skip Analytics. Go straight to
  // search fallback without burning the submit slot.
  if (opts.forceSearchFallback) {
    return await runSearchFallback({
      opts,
      existing,
      now,
      planLimitMessage: "operator forced search fallback (Retry)",
    });
  }

  // Task #1920 — a month frozen on a genuine 401 that is now auth-healthy
  // re-probes via the search fallback (mirrors the plan-limit memoized
  // path). Search uses the same token; if it succeeds it writes a real
  // denominator and clears `unrecoverable`, un-sticking the month. Skip
  // this auto-route when the operator forced a manual re-run — they get
  // the full analytics-first re-probe instead.
  if (!opts.forceRerun && shouldReEvaluateAuthBlocked(existing)) {
    return await runSearchFallback({
      opts,
      existing,
      now,
      planLimitMessage: "auth-blocked re-probe (front auth healthy)",
    });
  }

  // Task #1681 — short-circuit doomed Analytics submits for months
  // already memoized as plan-limited within the re-probe TTL. Goes
  // straight to the search fallback.
  const skipAnalytics = shouldSkipAnalyticsForPlanLimit(existing, now);

  let frontTotal: number;
  let reportId: string | null = null;
  let frontStatus: string;
  if (!skipAnalytics) {
    try {
      // Task #1920 — force-refresh-and-retry once on a 401 before
      // deciding the row is failed.
      const r = await pullAnalyticsWithAuthRetry({
        monthStart: opts.monthStart,
        monthEnd: opts.monthEnd,
      });
      frontTotal = r.value;
      reportId = r.reportId;
      frontStatus = r.status;
    } catch (err) {
      const code =
        err instanceof FrontAnalyticsError
          ? err.code
          : "front_analytics_report_failed";
      const status =
        err instanceof FrontAnalyticsError ? err.status : undefined;

      // Task #1681 — plan-limited 403 triggers the search-API fallback
      // instead of marking the month as a failure.
      if (code === "front_analytics_plan_limited") {
        return await runSearchFallback({
          opts,
          existing,
          now,
          planLimitMessage: err instanceof Error ? err.message : String(err),
        });
      }

      const message = err instanceof Error ? err.message : String(err);
      // Task #1920 — a 401 is only terminal when the auth breaker is open;
      // otherwise it is a recoverable `auth_blocked` state the worker
      // auto-re-probes once auth is healthy (never a permanent freeze).
      const { unrecoverable, authBlocked } = classifyProbeFailure(code, status);
      const failureStatus = authBlocked
        ? FRONT_ANALYTICS_STATUS_AUTH_BLOCKED
        : "error";
      // Persist failure state so the dashboard / SQL Q6 / next tick all see why.
      // Task #1920 — a message-grain row keeps its message-keyed numerator on
      // failure too: recompute it from local MESSAGE totals (free, local-only)
      // rather than the conversation-grain counters, or a failed re-probe (e.g.
      // a current-month retry) would write conversation counts into a
      // messages_all row and silently corrupt its coverage %.
      const existingIsMessagesAll = isMessageGrainDenominator(
        existing?.denominatorUnit,
      );
      let fetched: number;
      let applied: number;
      if (existingIsMessagesAll) {
        const dirLocal = await countMessagesByDirectionForMonth(
          opts.monthStart,
          opts.monthEnd,
        );
        fetched = dirLocal.inbound + dirLocal.outbound;
        applied = fetched;
      } else {
        fetched = await countFetchedForMonth(opts.monthStart, opts.monthEnd);
        applied = await countAppliedForMonth(opts.monthStart, opts.monthEnd);
      }
      const existingTotal = existing?.frontTotalMessages ?? 0;
      // Task #2795 — apply denominator floor for message-grain rows so a
      // failure re-probe never stores a denominator below the local count.
      const failureFrontTotal = existingIsMessagesAll
        ? Math.max(existingTotal, fetched)
        : existingTotal;
      const failureDenominatorFloorExcess = existingIsMessagesAll
        ? Math.max(0, fetched - existingTotal)
        : (existing?.denominatorFloorExcess ?? null);
      const cov = computeCoverage({
        frontTotal: failureFrontTotal,
        fetched,
        applied,
      });
      const errorMessage = `${code}: ${message.slice(0, 500)}`;
      await upsertMonthRow({
        month: opts.month,
        monthStart: opts.monthStart,
        monthEnd: opts.monthEnd,
        frontTotalMessages: failureFrontTotal,
        fetchedIntoNobull: fetched,
        appliedIntoNobull: applied,
        ...cov,
        // Task #1780 — stamp the attempt time on failure so the
        // dashboard's "Last refreshed" reflects the most recent retry,
        // not the last successful pull. The denominator stays at the
        // prior value (we have no fresher number), but the timestamp
        // tells operators their click registered.
        pulledAt: now,
        sourceRunId: opts.runId ?? null,
        isFinalizedMonth: existing?.isFinalizedMonth ?? false,
        frontAnalyticsReportId: existing?.frontAnalyticsReportId ?? null,
        frontAnalyticsStatus: failureStatus,
        frontAnalyticsError: errorMessage,
        unrecoverable,
        denominatorSource: existing?.denominatorSource ?? null,
        denominatorUnit: existing?.denominatorUnit ?? null,
        numeratorUnit: existingIsMessagesAll
          ? DENOMINATOR_UNIT_MESSAGES_ALL
          : NUMERATOR_UNIT_CONVERSATIONS_ALL,
        analyticsMessagesInbound: existing?.analyticsMessagesInbound ?? null,
        analyticsPlanLimitedAt: existing?.analyticsPlanLimitedAt ?? null,
        denominatorFloorExcess: failureDenominatorFloorExcess,
      });
      return {
        month: opts.month,
        outcome: "front_error",
        errorCode: code,
        errorMessage,
        unrecoverable,
        denominatorSource: existing?.denominatorSource ?? null,
        denominatorUnit: existing?.denominatorUnit ?? null,
        pulledAt: now.toISOString(),
        frontAnalyticsStatus: failureStatus,
        frontAnalyticsError: errorMessage,
      };
    }
  } else {
    // Memoized plan-limit; go straight to search fallback.
    return await runSearchFallback({
      opts,
      existing,
      now,
      planLimitMessage: "memoized: analytics_plan_limited_at within TTL",
    });
  }

  const fetched = await countFetchedForMonth(opts.monthStart, opts.monthEnd);
  const applied = await countAppliedForMonth(opts.monthStart, opts.monthEnd);
  // Task #1783 — Front Analytics returns `status: "done" | "partial"`, but the
  // dashboard badge only recognizes `"ok" | "search" | "search_truncated"` as
  // success states (everything else falls through to the rose "error" badge).
  // Normalize on write so the column only ever stores values the UI knows
  // about. `"partial"` still returned a numeric value upstream, so it's also
  // a success for our purposes — we log it for visibility instead of
  // surfacing a state the badge can't render.
  const normalizedStatus = "ok";
  if (frontStatus === "partial") {
    console.warn(
      `[FrontAnalyticsCoverage] month=${opts.month} Front reported status=partial; persisting as "ok" (denominator is still numeric).`,
    );
  }

  // Task #1837 — Analytics Reports gives inbound *messages*; that is
  // not unit-comparable to the conversation-keyed numerator. ALSO pull
  // Conversations Search to get the units-comparable denominator
  // ("conversations, all directions"). The Analytics value is kept
  // as a secondary diagnostic in `analytics_messages_inbound`.
  let primaryDenominator = frontTotal;
  let denominatorSource: string = DENOMINATOR_SOURCE_ANALYTICS;
  let denominatorUnit: string = DENOMINATOR_UNIT_MESSAGES;
  let searchStatusSuffix: string | null = null;
  let analyticsMessagesInbound: number | null = frontTotal;
  // Task #1974 — per-direction Front-side counts. Pull both Analytics
  // metrics; if either side plan-limits or otherwise fails, leave the
  // pair NULL (the UI badges this as "outbound not yet measured"
  // rather than rendering misleading 100% / 0% rows). The
  // per-message-enumeration fallback that would fill these on plan-
  // limited months is scaffolded but not yet wired — see
  // FRONT_ANALYTICS_COVERAGE.md.
  let messagesInboundFront: number | null = null;
  let messagesOutboundFront: number | null = null;
  let directionDataSource: string | null = null;
  try {
    const dir = await pullMonthlyMessagesByDirectionResolved({
      monthStart: opts.monthStart,
      monthEnd: opts.monthEnd,
    });
    messagesInboundFront = dir.inbound.value;
    messagesOutboundFront = dir.outbound.value;
    directionDataSource = DIRECTION_DATA_SOURCE_ANALYTICS;
    // Mirror into the legacy diagnostic so callers that only read the
    // older column still see the same number.
    analyticsMessagesInbound = messagesInboundFront;
  } catch (err) {
    // Either side failed — leave per-direction Front counts NULL.
    // This is intentional: a partial pair (one side known, the other
    // unknown) would compute a misleading 0% on the unknown side. The
    // overall denominator (search-conversations) still gets pulled
    // below, so the legacy aggregate coverage % is unaffected.
    console.warn(
      `[FrontAnalyticsCoverage] month=${opts.month} per-direction Analytics pull failed; leaving inbound/outbound Front counts NULL:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Task #2290 — when BOTH Front-side per-direction message counts are
  // known (the Analytics in-plan path succeeded for inbound AND
  // outbound), the month has a true message-grain denominator and we
  // publish the headline at message grain below. In that case the
  // conversation-grain Conversations Search companion pull is redundant
  // — its count would be discarded for the headline — so we SKIP it,
  // saving a whole search pagination against Front's tight proportional
  // rate limit (Task #1767). We only fall back to the search-conversation
  // denominator when the per-direction pull was unavailable.
  const directionKnown =
    messagesInboundFront != null && messagesOutboundFront != null;
  if (!directionKnown) {
    try {
      const search = await pullMonthlyMessageCountViaSearchFallbackResolved({
        monthStart: opts.monthStart,
        monthEnd: opts.monthEnd,
      });
      primaryDenominator = search.count;
      denominatorSource = DENOMINATOR_SOURCE_SEARCH;
      denominatorUnit = DENOMINATOR_UNIT_CONVERSATIONS_ALL;
      if (search.truncated) {
        searchStatusSuffix = `search_truncated: stopped at ${search.pagesFetched} pages (cap)`;
      }
    } catch (err) {
      // Search-side failure is non-fatal — we still have the Analytics
      // value to persist. Log and fall through with the Analytics
      // denominator (which is in messages units, so the UI will badge
      // the row as "Units not comparable" until the next successful
      // search-conversations pull).
      console.warn(
        `[FrontAnalyticsCoverage] month=${opts.month} Analytics succeeded but search-conversations companion pull failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const isFinalized = !opts.isCurrentMonth;
  const pulledAt = new Date();

  // Task #1974 — per-direction local counts + derived %/gap. Reuses
  // the local raw_communication_records.direction column, so this is
  // always a single grouped query — no extra Front budget consumed.
  const dirLocal = await countMessagesByDirectionForMonth(
    opts.monthStart,
    opts.monthEnd,
  );
  const inboundCov = computeDirectionCoverage(
    messagesInboundFront,
    dirLocal.inbound,
  );
  const outboundCov = computeDirectionCoverage(
    messagesOutboundFront,
    dirLocal.outbound,
  );

  // Task #2290 — publish the headline at MESSAGE grain whenever both
  // Front-side direction counts are known, so every in-plan month
  // reports a message denominator + numerator split inbound/outbound
  // (no month silently using conversation counts). Falls back to the
  // conversation-grain search denominator only when direction data is
  // unavailable.
  let headlineDenominator = primaryDenominator;
  let headlineFetched = fetched;
  let headlineApplied = applied;
  let headlineDenominatorSource = denominatorSource;
  let headlineDenominatorUnit: string = denominatorUnit;
  let headlineNumeratorUnit: string = NUMERATOR_UNIT_CONVERSATIONS_ALL;
  let headlineDenominatorFloorExcess = 0;
  if (directionKnown) {
    const h = buildMessageGrainHeadline({
      inboundFront: messagesInboundFront!,
      outboundFront: messagesOutboundFront!,
      localInbound: dirLocal.inbound,
      localOutbound: dirLocal.outbound,
    });
    headlineDenominator = h.denominator;
    headlineFetched = h.fetched;
    headlineApplied = h.applied;
    // The denominator is the Analytics per-direction sum.
    headlineDenominatorSource = DENOMINATOR_SOURCE_ANALYTICS;
    headlineDenominatorUnit = h.denominatorUnit;
    headlineNumeratorUnit = h.numeratorUnit;
    headlineDenominatorFloorExcess = h.denominatorFloorExcess;
  }

  const cov = computeCoverage({
    frontTotal: headlineDenominator,
    fetched: headlineFetched,
    applied: headlineApplied,
  });

  await upsertMonthRow({
    month: opts.month,
    monthStart: opts.monthStart,
    monthEnd: opts.monthEnd,
    frontTotalMessages: headlineDenominator,
    fetchedIntoNobull: headlineFetched,
    appliedIntoNobull: headlineApplied,
    ...cov,
    pulledAt,
    sourceRunId: opts.runId ?? null,
    isFinalizedMonth: isFinalized,
    frontAnalyticsReportId: reportId,
    frontAnalyticsStatus: searchStatusSuffix ? "search_truncated" : normalizedStatus,
    frontAnalyticsError: searchStatusSuffix,
    // Successful pull always clears the unrecoverable flag — e.g.
    // operator re-auth or scope grant means a previously permanent
    // 403 is now fixable, so the worker should resume normal cadence.
    unrecoverable: false,
    denominatorSource: headlineDenominatorSource,
    denominatorUnit: headlineDenominatorUnit,
    numeratorUnit: headlineNumeratorUnit,
    analyticsMessagesInbound,
    // Clear plan-limit memo on a successful Analytics pull.
    analyticsPlanLimitedAt: null,
    messagesInboundFront,
    messagesOutboundFront,
    messagesInboundLocal: dirLocal.inbound,
    messagesOutboundLocal: dirLocal.outbound,
    messagesInboundCoveragePct: inboundCov.pct,
    messagesOutboundCoveragePct: outboundCov.pct,
    messagesInboundGap: inboundCov.gap,
    messagesOutboundGap: outboundCov.gap,
    directionDataSource,
    denominatorFloorExcess: headlineDenominatorFloorExcess,
  });
  return {
    month: opts.month,
    outcome: opts.isCurrentMonth ? "ok_current_upsert" : "ok",
    frontTotalMessages: headlineDenominator,
    fetchedIntoNobull: headlineFetched,
    appliedIntoNobull: headlineApplied,
    denominatorSource: headlineDenominatorSource,
    denominatorUnit: headlineDenominatorUnit,
    pulledAt: pulledAt.toISOString(),
    frontAnalyticsStatus: searchStatusSuffix ? "search_truncated" : normalizedStatus,
    frontAnalyticsError: searchStatusSuffix,
  };
}

/**
 * Task #1681 — search-API fallback path. Invoked either after a fresh
 * `front_analytics_plan_limited` from Analytics OR for a row whose
 * `analyticsPlanLimitedAt` is still within the re-probe TTL.
 *
 * On success: persists the row with `denominator_source =
 * search_conversations`, `denominator_unit = inbound_conversations`,
 * stamps `analytics_plan_limited_at = now` so subsequent ticks skip
 * the doomed Analytics submit, and finalizes completed months.
 *
 * On failure: persists `front_analytics_error` with the search-side
 * error code so operators can see why the fallback also failed.
 * `unrecoverable` stays false so the worker re-tries.
 */
async function runSearchFallback(args: {
  opts: {
    month: string;
    monthStart: Date;
    monthEnd: Date;
    isCurrentMonth: boolean;
    runId?: string;
    /** Task #2482 — propagate the forced-enumeration intent. */
    forcePerMessageEnum?: boolean;
  };
  existing: FrontAnalyticsMonthlyCoverage | undefined;
  now: Date;
  planLimitMessage: string;
}): Promise<MonthRefreshResult> {
  const { opts, existing, now, planLimitMessage } = args;
  let search: SearchFallbackResult;
  try {
    search = await pullMonthlyMessageCountViaSearchFallbackResolved({
      monthStart: opts.monthStart,
      monthEnd: opts.monthEnd,
    });
  } catch (err) {
    const code =
      err instanceof FrontAnalyticsError
        ? err.code
        : "front_analytics_search_failed";
    const status =
      err instanceof FrontAnalyticsError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    // Task #1920 — the search fallback uses the same Front token, so a 401
    // here is classified identically: terminal only when the auth breaker
    // is open, else a recoverable `auth_blocked` state.
    const { unrecoverable, authBlocked } = classifyProbeFailure(code, status);
    const failureStatus = authBlocked
      ? FRONT_ANALYTICS_STATUS_AUTH_BLOCKED
      : "error";
    // Task #1920 — same message-grain guard as the Analytics failure path: a
    // failed search re-probe on a messages_all row must keep a message-grain
    // numerator, never conversation-grain counts.
    const existingIsMessagesAll = isMessageGrainDenominator(
      existing?.denominatorUnit,
    );
    let fetched: number;
    let applied: number;
    if (existingIsMessagesAll) {
      const dirLocal = await countMessagesByDirectionForMonth(
        opts.monthStart,
        opts.monthEnd,
      );
      fetched = dirLocal.inbound + dirLocal.outbound;
      applied = fetched;
    } else {
      fetched = await countFetchedForMonth(opts.monthStart, opts.monthEnd);
      applied = await countAppliedForMonth(opts.monthStart, opts.monthEnd);
    }
    const existingTotal = existing?.frontTotalMessages ?? 0;
    // Task #2795 — apply denominator floor for message-grain rows so a
    // failure re-probe never stores a denominator below the local count.
    const searchFailureFrontTotal = existingIsMessagesAll
      ? Math.max(existingTotal, fetched)
      : existingTotal;
    const searchFailureDenominatorFloorExcess = existingIsMessagesAll
      ? Math.max(0, fetched - existingTotal)
      : (existing?.denominatorFloorExcess ?? null);
    const cov = computeCoverage({
      frontTotal: searchFailureFrontTotal,
      fetched,
      applied,
    });
    const errorMessage = `${code}: ${message.slice(0, 500)} (analytics: ${planLimitMessage.slice(0, 200)})`;
    await upsertMonthRow({
      month: opts.month,
      monthStart: opts.monthStart,
      monthEnd: opts.monthEnd,
      frontTotalMessages: searchFailureFrontTotal,
      fetchedIntoNobull: fetched,
      appliedIntoNobull: applied,
      ...cov,
      // Task #1780 — same as the Analytics failure path: stamp the
      // attempt time so the dashboard reflects the latest retry, not
      // the last successful pull.
      pulledAt: now,
      sourceRunId: opts.runId ?? null,
      isFinalizedMonth: existing?.isFinalizedMonth ?? false,
      frontAnalyticsReportId: existing?.frontAnalyticsReportId ?? null,
      frontAnalyticsStatus: failureStatus,
      frontAnalyticsError: errorMessage,
      unrecoverable,
      denominatorSource: existing?.denominatorSource ?? null,
      denominatorUnit: existing?.denominatorUnit ?? null,
      // Task #1837 — numerator unit is fixed by how we count it now,
      // independent of denominator state, so persist it on every write.
      // Task #1920 — a messages_all row keeps its message-grain numerator unit.
      numeratorUnit: existingIsMessagesAll
        ? DENOMINATOR_UNIT_MESSAGES_ALL
        : NUMERATOR_UNIT_CONVERSATIONS_ALL,
      analyticsMessagesInbound: existing?.analyticsMessagesInbound ?? null,
      // Refresh the plan-limit memo so the next tick still goes search-
      // first (avoids re-burning the Analytics submit slot). Task #1920 —
      // do NOT set this on an auth_blocked failure: the row is not plan-
      // limited, and memoizing it would suppress the analytics re-probe
      // once auth is healthy again.
      analyticsPlanLimitedAt: authBlocked
        ? (existing?.analyticsPlanLimitedAt ?? null)
        : now,
      denominatorFloorExcess: searchFailureDenominatorFloorExcess,
    });
    return {
      month: opts.month,
      outcome: "front_error",
      errorCode: code,
      errorMessage,
      unrecoverable,
      denominatorSource: existing?.denominatorSource ?? null,
      denominatorUnit: existing?.denominatorUnit ?? null,
      pulledAt: now.toISOString(),
      frontAnalyticsStatus: failureStatus,
      frontAnalyticsError: errorMessage,
    };
  }

  const fetched = await countFetchedForMonth(opts.monthStart, opts.monthEnd);
  const applied = await countAppliedForMonth(opts.monthStart, opts.monthEnd);
  // Task #1974 — refresh per-direction local counts even on the
  // search-fallback path; Front-side per-direction counts stay at
  // their last-known value (or NULL) since plan-limited months can't
  // hit Analytics. When the per-message-enumeration fallback is wired
  // it will populate the Front side here.
  const dirLocal = await countMessagesByDirectionForMonth(
    opts.monthStart,
    opts.monthEnd,
  );
  // Task #1983 — plan-limited months have no Analytics per-direction
  // denominators. When enabled, advance one bounded, resumable chunk of
  // the per-message enumeration walk. This issues Front HTTP calls and
  // runs entirely OUTSIDE any DB hold (no transaction is open here). Its
  // checkpoint reads/writes are independent awaits.
  const enumOutcome = await maybeRunPerMessageEnumeration({
    month: opts.month,
    monthStart: opts.monthStart,
    monthEnd: opts.monthEnd,
    existing,
    // Task #2482 — the reach-coverage prod-action forces the walk even when
    // the global enumeration switch is OFF, so the in-scope dropped-history
    // months can be re-measured to message grain by a single press.
    force: opts.forcePerMessageEnum ?? false,
  });
  const inboundFront = enumOutcome.inboundFront;
  const outboundFront = enumOutcome.outboundFront;
  const inboundCov = computeDirectionCoverage(inboundFront, dirLocal.inbound);
  const outboundCov = computeDirectionCoverage(outboundFront, dirLocal.outbound);
  const isFinalized = !opts.isCurrentMonth;
  const statusLabel = search.truncated ? "search_truncated" : "search";

  // Task #1920 Step 2 — message-grain headline denominator.
  //
  // The conversation-count search fallback (Task #1837) answers "what
  // fraction of conversations did we capture", but the real coverage
  // question is "did we get 100% of MESSAGES". Once the per-message
  // enumeration walk has COMPLETED for this month we know Front's
  // message-grain total (inbound + outbound) and the comparable local
  // message total, so we publish the headline denominator/numerator at
  // message grain. Coverage then compares messages-to-messages and the
  // unit-mismatch badge stays green (numeratorUnit === denominatorUnit).
  //
  // Until enumeration completes we keep the conversation-grain headline:
  // search.count conversations vs the distinct-conversation local
  // numerator, which is itself unit-comparable (Task #1837).
  const enumComplete =
    enumOutcome.directionDataSource === DIRECTION_DATA_SOURCE_PER_MESSAGE &&
    inboundFront != null &&
    outboundFront != null;
  let headlineDenominator = search.count;
  let headlineFetched = fetched;
  let headlineApplied = applied;
  let headlineDenominatorUnit: string = DENOMINATOR_UNIT_CONVERSATIONS_ALL;
  let headlineNumeratorUnit: string = NUMERATOR_UNIT_CONVERSATIONS_ALL;
  let headlineDenominatorFloorExcess = 0;
  if (enumComplete) {
    // At message grain raw_communication_records IS the materialized
    // message mirror, so fetched == applied == the local message total;
    // the headline applyGap then equals the true missing-message count.
    // Task #2795 — apply denominator floor so local count never exceeds
    // the stored denominator (prevents >100% applied).
    const localMessageTotal = dirLocal.inbound + dirLocal.outbound;
    const { denominator, floorExcess } = applyMessageGrainDenominatorFloor(
      inboundFront! + outboundFront!,
      localMessageTotal,
    );
    headlineDenominator = denominator;
    headlineFetched = localMessageTotal;
    headlineApplied = localMessageTotal;
    headlineDenominatorUnit = DENOMINATOR_UNIT_MESSAGES_ALL;
    headlineNumeratorUnit = DENOMINATOR_UNIT_MESSAGES_ALL;
    headlineDenominatorFloorExcess = floorExcess;
  }
  const cov = computeCoverage({
    frontTotal: headlineDenominator,
    fetched: headlineFetched,
    applied: headlineApplied,
  });
  await upsertMonthRow({
    month: opts.month,
    monthStart: opts.monthStart,
    monthEnd: opts.monthEnd,
    frontTotalMessages: headlineDenominator,
    fetchedIntoNobull: headlineFetched,
    appliedIntoNobull: headlineApplied,
    ...cov,
    pulledAt: now,
    sourceRunId: opts.runId ?? null,
    isFinalizedMonth: isFinalized,
    // Search fallback has no analytics report id.
    frontAnalyticsReportId: null,
    frontAnalyticsStatus: statusLabel,
    frontAnalyticsError: search.truncated
      ? `search_truncated: stopped at ${search.pagesFetched} pages (cap)`
      : null,
    unrecoverable: false,
    denominatorSource: DENOMINATOR_SOURCE_SEARCH,
    denominatorUnit: headlineDenominatorUnit,
    numeratorUnit: headlineNumeratorUnit,
    // Search-fallback path means Analytics is unavailable for this
    // month (plan-limited). Preserve any earlier diagnostic value;
    // do not overwrite with null.
    analyticsMessagesInbound: existing?.analyticsMessagesInbound ?? null,
    analyticsPlanLimitedAt: now,
    messagesInboundFront: inboundFront,
    messagesOutboundFront: outboundFront,
    messagesInboundLocal: dirLocal.inbound,
    messagesOutboundLocal: dirLocal.outbound,
    messagesInboundCoveragePct: inboundCov.pct,
    messagesOutboundCoveragePct: outboundCov.pct,
    messagesInboundGap: inboundCov.gap,
    messagesOutboundGap: outboundCov.gap,
    directionDataSource: enumOutcome.directionDataSource,
    denominatorFloorExcess: headlineDenominatorFloorExcess,
  });
  return {
    month: opts.month,
    outcome: "ok_search_fallback",
    frontTotalMessages: search.count,
    fetchedIntoNobull: fetched,
    appliedIntoNobull: applied,
    denominatorSource: DENOMINATOR_SOURCE_SEARCH,
    denominatorUnit: DENOMINATOR_UNIT_CONVERSATIONS_ALL,
    pulledAt: now.toISOString(),
    frontAnalyticsStatus: statusLabel,
    frontAnalyticsError: search.truncated
      ? `search_truncated: stopped at ${search.pagesFetched} pages (cap)`
      : null,
  };
}

interface UpsertRow {
  month: string;
  monthStart: Date;
  monthEnd: Date;
  frontTotalMessages: number;
  fetchedIntoNobull: number;
  appliedIntoNobull: number;
  ingestGap: number;
  applyGap: number;
  fetchedCoveragePct: number;
  appliedCoveragePct: number;
  pulledAt: Date | null;
  sourceRunId: string | null;
  isFinalizedMonth: boolean;
  frontAnalyticsReportId: string | null;
  frontAnalyticsStatus: string | null;
  frontAnalyticsError: string | null;
  unrecoverable: boolean;
  // Task #1681 — explicit `null` clears the column on update; leave
  // `undefined` to preserve the existing value.
  denominatorSource: string | null;
  denominatorUnit: string | null;
  // Task #1837 — explicit `null` clears the column on update; leave
  // `undefined` (omit from the call site) to preserve.
  numeratorUnit: string | null;
  analyticsMessagesInbound: number | null;
  analyticsPlanLimitedAt: Date | null;
  // Task #1974 — per-direction columns. `undefined` preserves prior
  // value; `null` clears. The four `_pct` / `_gap` derived fields
  // mirror the same convention so the read path doesn't have to
  // recompute them on each request.
  messagesInboundFront?: number | null;
  messagesOutboundFront?: number | null;
  messagesInboundLocal?: number | null;
  messagesOutboundLocal?: number | null;
  messagesInboundCoveragePct?: number | null;
  messagesOutboundCoveragePct?: number | null;
  messagesInboundGap?: number | null;
  messagesOutboundGap?: number | null;
  directionDataSource?: string | null;
  /** Task #2795 — denominator floor excess; undefined preserves prior value. */
  denominatorFloorExcess?: number | null;
}

async function upsertMonthRow(row: UpsertRow): Promise<void> {
  await withDbAttribution("frontAnalyticsCoverage:upsertMonthRow", () =>
    getDb()
    .insert(frontAnalyticsMonthlyCoverage)
    .values({
      month: row.month,
      monthStart: row.monthStart,
      monthEnd: row.monthEnd,
      frontTotalMessages: row.frontTotalMessages,
      fetchedIntoNobull: row.fetchedIntoNobull,
      appliedIntoNobull: row.appliedIntoNobull,
      ingestGap: row.ingestGap,
      applyGap: row.applyGap,
      fetchedCoveragePct: row.fetchedCoveragePct,
      appliedCoveragePct: row.appliedCoveragePct,
      pulledAt: row.pulledAt ?? undefined,
      sourceRunId: row.sourceRunId ?? undefined,
      isFinalizedMonth: row.isFinalizedMonth,
      frontAnalyticsReportId: row.frontAnalyticsReportId ?? undefined,
      frontAnalyticsStatus: row.frontAnalyticsStatus ?? undefined,
      frontAnalyticsError: row.frontAnalyticsError ?? undefined,
      unrecoverable: row.unrecoverable,
      denominatorSource: row.denominatorSource ?? undefined,
      denominatorUnit: row.denominatorUnit ?? undefined,
      numeratorUnit: row.numeratorUnit ?? undefined,
      analyticsMessagesInbound: row.analyticsMessagesInbound ?? undefined,
      analyticsPlanLimitedAt: row.analyticsPlanLimitedAt ?? undefined,
      messagesInboundFront: row.messagesInboundFront ?? undefined,
      messagesOutboundFront: row.messagesOutboundFront ?? undefined,
      messagesInboundLocal: row.messagesInboundLocal ?? undefined,
      messagesOutboundLocal: row.messagesOutboundLocal ?? undefined,
      messagesInboundCoveragePct: row.messagesInboundCoveragePct ?? undefined,
      messagesOutboundCoveragePct: row.messagesOutboundCoveragePct ?? undefined,
      messagesInboundGap: row.messagesInboundGap ?? undefined,
      messagesOutboundGap: row.messagesOutboundGap ?? undefined,
      directionDataSource: row.directionDataSource ?? undefined,
      denominatorFloorExcess: row.denominatorFloorExcess ?? undefined,
    })
    .onConflictDoUpdate({
      target: frontAnalyticsMonthlyCoverage.month,
      set: {
        monthStart: row.monthStart,
        monthEnd: row.monthEnd,
        frontTotalMessages: row.frontTotalMessages,
        fetchedIntoNobull: row.fetchedIntoNobull,
        appliedIntoNobull: row.appliedIntoNobull,
        ingestGap: row.ingestGap,
        applyGap: row.applyGap,
        fetchedCoveragePct: row.fetchedCoveragePct,
        appliedCoveragePct: row.appliedCoveragePct,
        pulledAt: row.pulledAt ?? undefined,
        sourceRunId: row.sourceRunId ?? undefined,
        isFinalizedMonth: row.isFinalizedMonth,
        frontAnalyticsReportId: row.frontAnalyticsReportId ?? undefined,
        frontAnalyticsStatus: row.frontAnalyticsStatus ?? undefined,
        frontAnalyticsError: row.frontAnalyticsError,
        unrecoverable: row.unrecoverable,
        denominatorSource: row.denominatorSource,
        denominatorUnit: row.denominatorUnit,
        numeratorUnit: row.numeratorUnit,
        analyticsMessagesInbound: row.analyticsMessagesInbound,
        analyticsPlanLimitedAt: row.analyticsPlanLimitedAt,
        messagesInboundFront: row.messagesInboundFront ?? undefined,
        messagesOutboundFront: row.messagesOutboundFront ?? undefined,
        messagesInboundLocal: row.messagesInboundLocal ?? undefined,
        messagesOutboundLocal: row.messagesOutboundLocal ?? undefined,
        messagesInboundCoveragePct:
          row.messagesInboundCoveragePct ?? undefined,
        messagesOutboundCoveragePct:
          row.messagesOutboundCoveragePct ?? undefined,
        messagesInboundGap: row.messagesInboundGap ?? undefined,
        messagesOutboundGap: row.messagesOutboundGap ?? undefined,
        directionDataSource: row.directionDataSource ?? undefined,
        denominatorFloorExcess: row.denominatorFloorExcess ?? undefined,
        updatedAt: new Date(),
      },
    }),
  );
}

// ──────────────── Refresh tick ────────────────

export interface CoverageRefreshTickResult {
  ranAt: string;
  enabled: boolean;
  paused: boolean;
  adoptionDate: string | null;
  attempted: MonthRefreshResult[];
  reason?: string;
}

/**
 * One refresh tick: pulls up to N missing completed months plus the
 * current month. Bounded; honors kill switches and queue drain.
 */
export async function runCoverageRefreshTick(opts?: {
  now?: Date;
}): Promise<CoverageRefreshTickResult> {
  const now = opts?.now ?? new Date();
  const enabled = parseBool(
    (await getSystemSetting(SETTING_REFRESH_ENABLED).catch(() => null))?.value,
    true,
  );
  const paused = isQueuePaused(QUEUE_NAME);
  const result: CoverageRefreshTickResult = {
    ranAt: now.toISOString(),
    enabled,
    paused,
    adoptionDate: null,
    attempted: [],
  };
  if (!enabled) {
    result.reason = "refresh disabled in system_settings";
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

  // Task #1787 (Stage 1) — measurement-cadence master. Additive to the
  // legacy `front_analytics_refresh_enabled` emergency switch: when this
  // is OFF, the entire tick is a no-op even if the legacy switch is ON.
  const cadence = await loadMeasurementCadence();
  if (!cadence.measurementEnabled) {
    result.reason = "measurement refresh disabled in system_settings";
    return result;
  }

  // Task #2481 — the floor is the hard-coded `FRONT_ADOPTION_DATE`, so
  // `ensureFrontAdoptionDate()` always returns a non-null value (the old
  // `if (!adoption)` no-source-event-log bailout is dead and was removed in
  // Task #2483).
  const adoption = await ensureFrontAdoptionDate();
  result.adoptionDate = adoption;

  const months = listMonthsFromAdoption(adoption, now);
  if (months.length === 0) return result;

  const currentMonth = currentMonthLabel(now);
  const completed = months.filter((m) => m.month !== currentMonth);
  const current = months.find((m) => m.month === currentMonth);

  // Task #1787 (Stage 1) — current-month cadence gate. Skip the
  // re-pull if we pulled within `current_month_refresh_interval_hours`.
  let currentDue = true;
  let currentExisting: FrontAnalyticsMonthlyCoverage | undefined;
  if (current) {
    currentExisting = await getExistingMonth(current.month);
    if (
      currentExisting?.pulledAt &&
      now.getTime() - currentExisting.pulledAt.getTime() <
        cadence.currentMonthIntervalMs
    ) {
      currentDue = false;
    }
  }

  // Find which completed months still need a pull (no row OR row has
  // a persisted error OR row has never been pulled).
  const missingCompleted: MonthBoundary[] = [];
  for (const m of completed) {
    const existing = await getExistingMonth(m.month);
    // Task #1787 (Stage 1) — finalized clean historical months are
    // skipped automatically when `front_analytics_finalized_month_skip_enabled`
    // is on (default). Operator manual Retry endpoints call
    // `refreshMonth` directly so they bypass this gate.
    if (
      cadence.finalizedSkipEnabled &&
      isExistingFinalizedClean(existing, false, now)
    ) {
      continue;
    }
    // Task #1787 (Stage 1) — incomplete-month cadence gate. An
    // incomplete prior month with a recent successful pull is not due
    // yet. Rows with an error always fall through to the legacy
    // inclusion clause below so they retry.
    if (
      existing?.pulledAt &&
      !existing.frontAnalyticsError &&
      !existing.isFinalizedMonth &&
      now.getTime() - existing.pulledAt.getTime() <
        cadence.incompleteMonthIntervalMs
    ) {
      continue;
    }
    // Task #1675 — skip rows marked permanently unrecoverable so they
    // stop burning a refresh slot every tick. The operator can re-arm
    // a month by hitting POST /refresh-month, which clears the flag
    // on success.
    //
    // Task #1709 exception — rows that were stamped
    // `front_analytics_auth_failed` + `unrecoverable=true` ONLY
    // because the old plan-limit detector missed an envelope-wrapped
    // 403 body are now misclassified. Re-arm them on the next tick
    // so the search fallback can run; rows unrecoverable for
    // legitimate reasons (missing scope, revoked token) stay skipped.
    if (
      existing?.unrecoverable &&
      !shouldReEvaluateMisclassifiedUnrecoverable(existing) &&
      // Task #1920 — un-stick a month frozen on a genuine 401 once Front
      // auth is healthy again, so it re-probes via the search fallback.
      !shouldReEvaluateAuthBlocked(existing)
    ) {
      continue;
    }
    if (
      !existing ||
      !existing.pulledAt ||
      !existing.isFinalizedMonth ||
      existing.frontAnalyticsError ||
      // Task #1681 — re-probe rows finalized via the search fallback
      // once their plan-limit memo ages past the TTL, in case the
      // workspace plan was upgraded and Analytics is now available.
      isPlanLimitMemoStale(existing, now)
    ) {
      missingCompleted.push(m);
    }
  }

  const currentOnly = parseBool(
    (await getSystemSetting(SETTING_REFRESH_LOOKBACK_CURRENT_ONLY).catch(
      () => null,
    ))?.value,
    true,
  );

  const runId = `tick:${now.toISOString()}`;
  // Refresh current month when due per cadence (Task #1787 Stage 1).
  if (current && currentDue) {
    const r = await refreshMonth({
      month: current.month,
      monthStart: current.monthStart,
      monthEnd: current.monthEnd,
      isCurrentMonth: true,
      runId,
    });
    result.attempted.push(r);
  }
  // Back-fill missing completed months, capped per tick.
  if (!currentOnly || missingCompleted.length > 0) {
    const slots = PERF.FRONT_ANALYTICS_COVERAGE_MAX_MONTHS_PER_TICK;
    const batch = missingCompleted.slice(0, slots);
    for (const m of batch) {
      const r = await refreshMonth({
        month: m.month,
        monthStart: m.monthStart,
        monthEnd: m.monthEnd,
        isCurrentMonth: false,
        runId,
      });
      result.attempted.push(r);
    }
  }
  return result;
}

// ──────────────── Read-only summary ────────────────

export interface CoverageSummaryMonth {
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
  /** Task #1675 — surfaced so the panel can show a non-retrying badge. */
  unrecoverable: boolean;
  /** Task #1681 — surfaced so the panel can pill the denominator source/unit. */
  denominatorSource: string | null;
  denominatorUnit: string | null;
  /**
   * Task #1837 — surfaced so the panel can badge rows where the
   * numerator and denominator are in different units (i.e. the row
   * pre-dates this task and the denominator was Analytics messages).
   */
  numeratorUnit: string | null;
  /** Task #1837 — secondary diagnostic from Analytics Reports. */
  analyticsMessagesInbound: number | null;
  /**
   * Task #1837 — derived server-side so the panel doesn't have to know
   * the legacy / new unit equivalences. True when both unit columns
   * are set and resolve to the same conceptual unit.
   */
  unitsComparable: boolean;
  analyticsPlanLimitedAt: string | null;
  /**
   * Task #1974 — per-direction message coverage. `*Front` and `*Local`
   * are the raw counts; `*CoveragePct` / `*Gap` are derived from the
   * pair. Any field may be NULL when the row has not yet been pulled
   * with per-direction data (plan-limited months or pre-#1974 rows).
   */
  messagesInboundFront: number | null;
  messagesOutboundFront: number | null;
  messagesInboundLocal: number | null;
  messagesOutboundLocal: number | null;
  messagesInboundCoveragePct: number | null;
  messagesOutboundCoveragePct: number | null;
  messagesInboundGap: number | null;
  messagesOutboundGap: number | null;
  directionDataSource: string | null;
  /**
   * Task #1974 — operator-facing plain-English explanation of
   * `frontAnalyticsError`. NULL for healthy rows. Derived via
   * `explainFrontAnalyticsError` so the panel doesn't have to embed
   * error-code knowledge.
   */
  reasonHuman: string | null;
  /**
   * Task #1974 — true when the operator-fix for `frontAnalyticsError`
   * is "click Reconnect Front". Panel renders the Reconnect button
   * when this is true.
   */
  needsReconnect: boolean;
  /**
   * Task #2087 — derived completeness status (covered / ingest-gap /
   * apply-gap / in-progress / not-measured). Separates "denominator
   * measured" (`isFinalizedMonth`) from "ingest/apply actually
   * complete" so a gap month is never rendered as done. Derived
   * server-side via `deriveCoverageCompleteness` so the panel render
   * stays dumb. `completenessReason` is the plain-English explanation.
   */
  completenessStatus: CoverageCompletenessStatus;
  completenessReason: string;
  /**
   * Task #2088 — auto-close attribution. `"webhook_dedupe"` means the
   * auto-closer closed this dead recovery window because every page was
   * already ingested via the live Front webhook path (see
   * `frontAutoClosure.maybeCloseDedupeOnlyWindow`). NULL for normal
   * (open) rows. Surfaced so the panel can render a distinct
   * "closed (webhook dedupe)" badge and filter on it.
   */
  closedVia: string | null;
  /**
   * Task #2434 — per-month convergence budget for the
   * `reach_front_coverage_full_message_grain` sweep. When it reaches
   * `FRONT_COVERAGE_CONVERGENCE_CAP` the month is excluded as
   * permanently-unreachable so the action converges.
   */
  coverageConvergenceAttempts: number;
  /**
   * Task #2745 — true when the row's `deep_search_exhausted_at` marker is set:
   * reach's deep per-message search enumeration ran to exhaustion for this
   * (non-plan-limited, message-grain) month and still left an un-fetchable
   * ingest gap. The sweep retires such a month (converges) and the "Bring it
   * to 100%" headline parks its residual ingest gap out of reachable work.
   * False for everything else.
   */
  deepSearchExhausted: boolean;
  /**
   * Task #2669 — non-null ONLY for plan-limited months whose denominator is a
   * conversation count (Front's plan blocks per-message history for them). When
   * set, the panel renders this clearly-labeled conversation-grain fallback
   * ("X of Y conversations — …") instead of a misleading message-grain %.
   * Strict message-grain months (and non-plan-limited search rows) are null and
   * render their normal %. Presentation-only; derived via
   * `frontPlanLimitedFallback`. Never mixes grains.
   */
  planLimitedFallback: FrontPlanLimitedFallback | null;
  /**
   * Task #2795 — denominator floor excess.
   * Non-null / >0 when the local unique-message count for this month exceeded
   * the Front-enumerated total. The stored `frontTotalMessages` was raised to
   * the local count (the floor invariant). This field stores the excess so the
   * Advanced operator panel can surface a per-month reconciliation note.
   * NULL = floor not yet computed or no excess. 0 = checked, no excess.
   */
  denominatorFloorExcess: number | null;
  /**
   * Task #2795 — plain-English reconciliation note when the denominator floor
   * was applied (non-null only when `denominatorFloorExcess > 0`). Surfaced in
   * the Advanced operator tools to explain why the denominator exceeds the
   * Front-enumerated total.
   */
  denominatorFloorReconciliationNote: string | null;
}

export interface CoverageSummary {
  adoptionDate: string | null;
  allTime: {
    frontTotalMessages: number;
    fetchedIntoNobull: number;
    appliedIntoNobull: number;
    ingestGap: number;
    applyGap: number;
    fetchedCoveragePct: number;
    appliedCoveragePct: number;
    /**
     * Task #2440 — month-coverage diagnostics so an operator can tell at a
     * glance how complete the all-time headline is. Task #2436 silently
     * excludes pre-floor and not-yet-message-grain months from the totals
     * above; these counts surface that exclusion.
     *
     * - `totalMonths`: every cached coverage row.
     * - `inScopeMonths`: rows at or after the adoption floor (M).
     * - `includedMonths`: in-scope rows that genuinely contribute to the
     *   all-time totals — i.e. message-grain (N).
     * - `excludedWrongGrainMonths`: in-scope rows excluded because their
     *   denominator is not yet message grain (K) — run the upgrade sweep.
     * - `excludedPreFloorMonths`: rows before the adoption floor — run the
     *   `purge_pre_floor_front_coverage_rows` action to tidy them up.
     *
     * Task #2439 — all-time-scope confirmation aliases. `inScopeCountedMonths`
     * (== `includedMonths`) and `inScopeExcludedMonths` (== `excludedWrongGrainMonths`)
     * name the same split for the in-scope confirmation banner + the
     * `backfillInScopeMessageGrain()` execution path; `inScopeExcludedMonths === 0`
     * is the done-state (every in-scope month counts). Driving the stragglers to
     * message grain (Tasks #2290 / #2365 / #2369) converges it.
     */
    totalMonths: number;
    inScopeMonths: number;
    includedMonths: number;
    excludedWrongGrainMonths: number;
    excludedPreFloorMonths: number;
    inScopeCountedMonths: number;
    inScopeExcludedMonths: number;
  };
  byMonth: CoverageSummaryMonth[];
  /** Alias of `byMonth`, exposed for the dashboard. */
  months: CoverageSummaryMonth[];
  thresholds: {
    monthFloorPct: number;
    dropDeltaPct: number;
  };
  lastRefreshedAt: string | null;
  generatedAt: string;
  /**
   * Task #2250 — the live state of the three gates the manual
   * refresh-month / reprobe-month / recompute trigger routes share, so
   * the panel can render an inline "why is this disabled" reason BEFORE
   * the operator presses a button that can only 503. `blockedReason`
   * reuses the same shared wording the 503 toast shows (or null when
   * every gate is clear).
   */
  triggerGates: {
    refreshEnabled: boolean;
    queuePaused: boolean;
    killSwitchNonCriticalSweeps: boolean;
    blockedReason: string | null;
  };
}

/**
 * Task #2795 — derive a plain-English reconciliation note for the Advanced
 * operator panel when the denominator floor was applied (floorExcess > 0).
 * Returns null when there is no excess or the excess is not positive.
 *
 * Task #2818 — the search-variant wording says "threads" (never
 * "conversations") so the note can render as VISIBLE text in the Front
 * console without tripping the Task #2603 no-conversation-vocabulary
 * render guard. Do not reintroduce "conversation(s)" here: the console
 * now shows this note as tap-visible text, not just a hover tooltip.
 */
function buildFloorReconciliationNote(
  floorExcess: number | null,
  denominatorSource: string | null,
): string | null {
  if (!floorExcess || floorExcess <= 0) return null;
  if (denominatorSource === DENOMINATOR_SOURCE_ANALYTICS) {
    return `${floorExcess.toLocaleString()} local messages exceed Front Analytics — likely imported via Front's Import Message endpoint (excluded from Analytics Reports).`;
  }
  return `${floorExcess.toLocaleString()} local messages exceed Front's search-enumerated count — likely in threads that no longer appear in search (deleted, spam, or imported).`;
}

/**
 * Cache-only aggregator. Does NOT call Front Analytics. Does NOT
 * recompute counts. Safe to call from the dashboard request path.
 */
export async function getFrontAnalyticsCoverageSummary(): Promise<CoverageSummary> {
  // Task #2481 — the floor is the hard-coded constant, not the
  // (now dead/ignored) `system_settings.front_adoption_date` row.
  const adoption = FRONT_ADOPTION_DATE;
  const rows = (await withDbAttribution(
    "frontAnalyticsCoverage:getSummary",
    () =>
      getDb()
        .select()
        .from(frontAnalyticsMonthlyCoverage)
        .orderBy(frontAnalyticsMonthlyCoverage.month),
  )) as FrontAnalyticsMonthlyCoverage[];
  let totalFront = 0;
  let totalFetched = 0;
  let totalApplied = 0;
  // Task #2440 — month-coverage diagnostics (see CoverageSummary.allTime).
  // Task #2439's in-scope confirmation split is derived from these counters
  // in the return (inScopeCountedMonths == includedMonths,
  // inScopeExcludedMonths == excludedWrongGrainMonths).
  let inScopeMonths = 0;
  let includedMonths = 0;
  let excludedWrongGrainMonths = 0;
  let excludedPreFloorMonths = 0;
  let lastRefreshed: Date | null = null;
  const currentMonth = currentMonthLabel();
  // Task #2436 — adoption floor (YYYY-MM prefix) for the all-time totals.
  // `byMonth` still returns EVERY cached row (the dashboard + many
  // consumers depend on that, and the adoption floor is consumer-side by
  // design); only the all-time accumulator is floored.
  const adoptionFloorMonth = adoption ? adoption.slice(0, 7) : null;
  const byMonth: CoverageSummaryMonth[] = rows.map((r) => {
    if (r.pulledAt && (!lastRefreshed || r.pulledAt > lastRefreshed)) {
      lastRefreshed = r.pulledAt;
    }
    // Task #2436 — the all-time card must never sum a message-grain
    // numerator against a conversation-grain denominator (which is how
    // numerator > denominator overflow happened: every historical row is
    // labeled `conversations_all` but stores message-count numerators).
    // A month contributes to the all-time totals ONLY when (1) it is at or
    // after the adoption floor and (2) it is genuinely message-grain, so
    // the numerator and denominator always share a grain. Sub-floor and
    // still-conversation-grain months are excluded — the latter are driven
    // to message grain by the existing auto-upgrade machinery (Tasks
    // #2290 / #2365) and then start contributing.
    const atOrAfterFloor =
      adoptionFloorMonth == null || r.month >= adoptionFloorMonth;
    const contributesToAllTime =
      atOrAfterFloor && isMessageGrainDenominator(r.denominatorUnit);
    // Task #2440 — tally month-coverage diagnostics alongside the totals.
    // Task #2439's in-scope split (counted vs excluded) is derived from
    // these counters in the return; `inScopeMonths` mirrors exactly what the
    // accumulator floors on, so excludedWrongGrainMonths is precisely the set
    // of in-scope months omitted purely because they are not yet message-grain.
    if (atOrAfterFloor) {
      inScopeMonths += 1;
      if (contributesToAllTime) {
        includedMonths += 1;
      } else {
        excludedWrongGrainMonths += 1;
      }
    } else {
      excludedPreFloorMonths += 1;
    }
    // Task #2795 — in-memory denominator floor safety net. If a message-grain
    // row has appliedIntoNobull > frontTotalMessages (stale stored denominator),
    // raise the effective front total in-memory so the API response never
    // displays >100%. The stored value is corrected on the next write cycle
    // (refreshMonth / recomputeLocalCounts / recomputeAllMonths all apply the
    // floor at write time). Only applies to message-grain rows.
    const isMessageGrain = isMessageGrainDenominator(r.denominatorUnit);
    const appliedAboveStored =
      isMessageGrain && r.appliedIntoNobull > r.frontTotalMessages;
    const effectiveFrontTotal = appliedAboveStored
      ? r.appliedIntoNobull
      : r.frontTotalMessages;
    const storedFloorExcess = r.denominatorFloorExcess ?? null;
    const effectiveFloorExcess = appliedAboveStored
      ? Math.max(storedFloorExcess ?? 0, r.appliedIntoNobull - r.frontTotalMessages)
      : storedFloorExcess;
    // Recalculate derived coverage fields when the floor raised the denominator.
    const effectiveDerived = appliedAboveStored
      ? computeCoverage({
          frontTotal: effectiveFrontTotal,
          fetched: r.fetchedIntoNobull,
          applied: r.appliedIntoNobull,
        })
      : {
          ingestGap: r.ingestGap,
          applyGap: r.applyGap,
          fetchedCoveragePct: r.fetchedCoveragePct,
          appliedCoveragePct: r.appliedCoveragePct,
        };

    if (contributesToAllTime) {
      totalFront += effectiveFrontTotal;
      totalFetched += r.fetchedIntoNobull;
      totalApplied += r.appliedIntoNobull;
    }
    const unitsComparable = unitsMatch(r.numeratorUnit, r.denominatorUnit);
    const explained = explainFrontAnalyticsError(r.frontAnalyticsError);
    const needsReconnect = explained?.needsReconnect ?? false;
    // Task #2087 — derive completeness from the row's existing fields so
    // a finalized-but-gappy month is never shown as done.
    const completeness = deriveCoverageCompleteness({
      isCurrentMonth: r.month === currentMonth,
      isFinalizedMonth: r.isFinalizedMonth,
      pulledAt: r.pulledAt ?? null,
      frontTotalMessages: effectiveFrontTotal,
      ingestGap: effectiveDerived.ingestGap,
      applyGap: effectiveDerived.applyGap,
      unitsComparable,
      frontAnalyticsStatus: r.frontAnalyticsStatus ?? null,
      frontAnalyticsError: r.frontAnalyticsError ?? null,
      needsReconnect,
      unrecoverable: r.unrecoverable ?? false,
      messagesInboundCoveragePct: r.messagesInboundCoveragePct ?? null,
      messagesOutboundCoveragePct: r.messagesOutboundCoveragePct ?? null,
    });
    return {
      month: r.month,
      frontTotalMessages: effectiveFrontTotal,
      fetchedIntoNobull: r.fetchedIntoNobull,
      appliedIntoNobull: r.appliedIntoNobull,
      ingestGap: effectiveDerived.ingestGap,
      applyGap: effectiveDerived.applyGap,
      fetchedCoveragePct: effectiveDerived.fetchedCoveragePct,
      appliedCoveragePct: effectiveDerived.appliedCoveragePct,
      pulledAt: r.pulledAt ? r.pulledAt.toISOString() : null,
      isFinalizedMonth: r.isFinalizedMonth,
      frontAnalyticsStatus: r.frontAnalyticsStatus ?? null,
      frontAnalyticsError: r.frontAnalyticsError ?? null,
      unrecoverable: r.unrecoverable ?? false,
      denominatorSource: r.denominatorSource ?? null,
      denominatorUnit: r.denominatorUnit ?? null,
      numeratorUnit: r.numeratorUnit ?? null,
      analyticsMessagesInbound: r.analyticsMessagesInbound ?? null,
      unitsComparable,
      analyticsPlanLimitedAt: r.analyticsPlanLimitedAt
        ? r.analyticsPlanLimitedAt.toISOString()
        : null,
      messagesInboundFront: r.messagesInboundFront ?? null,
      messagesOutboundFront: r.messagesOutboundFront ?? null,
      messagesInboundLocal: r.messagesInboundLocal ?? null,
      messagesOutboundLocal: r.messagesOutboundLocal ?? null,
      messagesInboundCoveragePct: r.messagesInboundCoveragePct ?? null,
      messagesOutboundCoveragePct: r.messagesOutboundCoveragePct ?? null,
      messagesInboundGap: r.messagesInboundGap ?? null,
      messagesOutboundGap: r.messagesOutboundGap ?? null,
      directionDataSource: r.directionDataSource ?? null,
      // Task #1974 — plain-English error + reconnect flag derived
      // server-side so panel render stays dumb.
      reasonHuman: explained?.message ?? null,
      needsReconnect,
      // Task #2087 — completeness status separating "denominator
      // measured" from "ingest/apply actually complete".
      completenessStatus: completeness.status,
      completenessReason: completeness.reason,
      // Task #2088 — close-state attribution for the panel badge/filter.
      closedVia: r.closedVia ?? null,
      // Task #2434 — convergence budget so the sweep can terminally exclude
      // a month that can never reach 100%-of-messages.
      coverageConvergenceAttempts: r.coverageConvergenceAttempts ?? 0,
      // Task #2745 — terminal deep-search-exhausted marker (non-null ⇒ true).
      deepSearchExhausted: r.deepSearchExhaustedAt != null,
      // Task #2669 — honest conversation-grain fallback for plan-limited months
      // (null for everything else; never mixes grains). Derived presentation-only.
      planLimitedFallback: frontPlanLimitedFallback({
        analyticsPlanLimitedAt: r.analyticsPlanLimitedAt
          ? r.analyticsPlanLimitedAt.toISOString()
          : null,
        denominatorUnit: r.denominatorUnit ?? null,
        fetchedIntoNobull: r.fetchedIntoNobull,
        frontTotalMessages: effectiveFrontTotal,
        fetchedCoveragePct: effectiveDerived.fetchedCoveragePct,
      }),
      // Task #2795 — floor excess and reconciliation note for the Advanced
      // operator panel; null when no excess or not yet computed.
      denominatorFloorExcess: effectiveFloorExcess,
      denominatorFloorReconciliationNote: buildFloorReconciliationNote(
        effectiveFloorExcess,
        r.denominatorSource ?? null,
      ),
    };
  });
  const cov = computeCoverage({
    frontTotal: totalFront,
    fetched: totalFetched,
    applied: totalApplied,
  });
  const monthFloorPct = Number(
    (await getSystemSetting("front_analytics_month_floor_pct").catch(
      () => null,
    ))?.value ?? 95.0,
  );
  const dropDeltaPct = Number(
    (await getSystemSetting("front_analytics_coverage_drop_delta_pct").catch(
      () => null,
    ))?.value ?? 2.0,
  );
  // Task #2250 — compute the three shared trigger gates (master refresh
  // setting, queue-drain pause, non-critical-sweeps kill switch) so the
  // panel can disable the refresh-month / reprobe-month / recompute
  // buttons with an inline reason. `refreshEnabled` defaults ON when the
  // setting is unset, matching the route handlers.
  const refreshEnabledSetting = await getSystemSetting(
    SETTING_REFRESH_ENABLED,
  ).catch(() => null);
  const refreshEnabled =
    refreshEnabledSetting?.value == null
      ? true
      : refreshEnabledSetting.value === "true";
  const queuePaused = isQueuePaused(QUEUE_NAME);
  const killSwitchNonCriticalSweeps = PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS;
  const triggerGates = {
    refreshEnabled,
    queuePaused,
    killSwitchNonCriticalSweeps,
    blockedReason: firstTriggerBlockedReason({
      refreshEnabled,
      refreshSetting: SETTING_REFRESH_ENABLED,
      queuePaused,
      queueName: QUEUE_NAME,
      killSwitchNonCriticalSweeps,
    }),
  };
  return {
    adoptionDate: adoption,
    allTime: {
      frontTotalMessages: totalFront,
      fetchedIntoNobull: totalFetched,
      appliedIntoNobull: totalApplied,
      ...cov,
      // Task #2440 — month-coverage diagnostics.
      totalMonths: rows.length,
      inScopeMonths,
      includedMonths,
      excludedWrongGrainMonths,
      excludedPreFloorMonths,
      // Task #2439 — in-scope confirmation aliases over the #2440 counters.
      // `inScopeCountedMonths` == `includedMonths`; `inScopeExcludedMonths`
      // (== `excludedWrongGrainMonths`) is the count of at/after-floor months
      // still omitted purely because they are not yet message-grain; 0 means
      // the headline counts every in-scope month.
      inScopeCountedMonths: includedMonths,
      inScopeExcludedMonths: excludedWrongGrainMonths,
    },
    byMonth,
    months: byMonth,
    thresholds: {
      monthFloorPct: Number.isFinite(monthFloorPct) ? monthFloorPct : 95.0,
      dropDeltaPct: Number.isFinite(dropDeltaPct) ? dropDeltaPct : 2.0,
    },
    lastRefreshedAt: lastRefreshed
      ? (lastRefreshed as Date).toISOString()
      : null,
    generatedAt: new Date().toISOString(),
    triggerGates,
  };
}

// ──────────────── Task #2436 — pre-floor row cleanup ────────────────
//
// The all-time coverage card must never surface pre-adoption-floor months
// (the worst-overflow historical-recovery months). The consumer-side floor
// filter in `getFrontAnalyticsCoverageSummary` is the durable guard, but the
// stale rows still sit in `front_analytics_monthly_coverage`. These helpers
// back the idempotent CEO prod-action that physically purges them. Scope is
// strictly months BEFORE the adoption floor (`front_adoption_date` → YYYY-MM
// prefix), so re-running matches zero rows once cleaned. When no adoption
// date is set there is no floor, so nothing is ever deleted.

/**
 * Task #2674 — true when a non-message-grain coverage month is TERMINALLY
 * plan-limited: Front's analytics plan does not expose its per-message history
 * (the `analyticsPlanLimitedAt` memo is set), so neither the free relabel nor
 * the forced per-message enumeration can EVER lift its denominator to message
 * grain (`messages_all`). Such a month must be excluded from the
 * `finish_front_message_grain_coverage` candidate set
 * (`listInScopeNonMessageGrainMonths`), or that action's "pending" count never
 * reaches zero — the perpetual-pending bug for the terminal 2025-07 adoption
 * floor month.
 *
 * This is a TERMINAL EXEMPTION WITH A REVIVAL PATH, not a permanent silent
 * drop of convertible work: the plan-limit memo is cleared automatically by the
 * next successful Analytics pull (`refreshMonth` sets `analyticsPlanLimitedAt:
 * null`, e.g. after a Front plan upgrade exposes per-message history). The
 * moment the memo clears the month gains per-direction message data and
 * re-enters the candidate set. Mirrors the plan-limited retirement the sibling
 * `reach_front_coverage_full_message_grain` sweep applies via
 * `shouldSweepFrontCoverageMonth` (Task #2499) — except this grain-only action
 * needs no convergence-budget guard: plan-limited alone is terminal for GRAIN
 * (the convergence budget is a numerator concern that this action never drives).
 */
export function isTerminalPlanLimitedForMessageGrain(
  analyticsPlanLimitedAt: string | Date | null | undefined,
): boolean {
  return analyticsPlanLimitedAt != null;
}

/**
 * Task #2439 — list the in-scope (at/after the adoption floor) coverage
 * months that are NOT yet message-grain AND can still be driven there — i.e.
 * the targets the `finish_front_message_grain_coverage` action must converge.
 * These drive to message grain (Tasks #2290 / #2365 / #2369) so every
 * convertible in-scope month re-enters the all-time total. Pure read over the
 * cached coverage table — no Front call.
 *
 * Task #2674 — terminally plan-limited months
 * (`isTerminalPlanLimitedForMessageGrain`) are EXCLUDED: Front's plan can never
 * expose their per-message history, so they can never reach message grain and
 * keeping them here would make the consolidating action perpetually "pending".
 * The all-time accumulator still counts them in `allTime.inScopeExcludedMonths`
 * (they genuinely aren't in the message-grain headline), so this list is now a
 * subset of that count — the *convertible* excluded months only.
 */
export interface InScopeExcludedCoverageMonth {
  month: string;
  denominatorUnit: string | null;
  appliedCoveragePct: number;
  completenessStatus: CoverageCompletenessStatus;
}

export async function listInScopeNonMessageGrainMonths(): Promise<{
  floorMonth: string;
  months: InScopeExcludedCoverageMonth[];
  /**
   * Task #2674 — in-scope, non-message-grain months excluded from `months`
   * because they are terminally plan-limited (can never reach message grain).
   * Surfaced so the consolidating action can word its done-state honestly
   * ("converged, except N terminally plan-limited month(s)") instead of
   * claiming every in-scope month is message-grain.
   */
  terminalPlanLimitedMonths: string[];
}> {
  const floorMonth = await getAdoptionFloorMonth();
  const summary = await getFrontAnalyticsCoverageSummary();
  const inScopeNonMessageGrain = summary.byMonth.filter(
    (m) => m.month >= floorMonth && !isMessageGrainDenominator(m.denominatorUnit),
  );
  const months = inScopeNonMessageGrain
    .filter((m) => !isTerminalPlanLimitedForMessageGrain(m.analyticsPlanLimitedAt))
    .map((m) => ({
      month: m.month,
      denominatorUnit: m.denominatorUnit,
      appliedCoveragePct: m.appliedCoveragePct,
      completenessStatus: m.completenessStatus,
    }));
  const terminalPlanLimitedMonths = inScopeNonMessageGrain
    .filter((m) => isTerminalPlanLimitedForMessageGrain(m.analyticsPlanLimitedAt))
    .map((m) => m.month);
  return { floorMonth, months, terminalPlanLimitedMonths };
}

export interface BackfillInScopeMessageGrainResult {
  floorMonth: string | null;
  /** In-scope, non-message-grain rows at the START of the run (the work set). */
  examined: number;
  /** Rows converted to a message-grain denominator this run. */
  upgraded: number;
  /**
   * In-scope months STILL non-message-grain after the run. These rows lack
   * the per-direction Front message counts a free conversion needs, so they
   * cannot be relabeled without a Front re-pull — drive them with the
   * `reach_front_coverage_full_message_grain` sweep / Task #2365 upgrader.
   */
  stillExcludedMonths: string[];
}

/**
 * Task #2439 — backfill in-scope (at/after the adoption floor) historical
 * coverage rows to a message-grain (`messages_all`) denominator so they
 * re-enter the all-time total instead of being silently excluded by the
 * Task #2436 grain gate.
 *
 * This reuses the EXISTING free conversion machinery rather than duplicating
 * the headline math: `recomputeAllMonths({ frontPullsBudget: 0 })` performs
 * Task #2290's per-direction → message-grain relabel in place for every row
 * that already carries both Front-side per-direction message counts, with
 * ZERO Front API calls (budget 0 forbids the Path-B re-pull). It is therefore
 * idempotent — a second run upgrades nothing further — and safe to run from a
 * read-only-prod dev workspace (it only relabels rows that already hold the
 * data). Rows without per-direction counts cannot be converted for free and
 * are reported in `stillExcludedMonths` for the heavy Front-re-pull driver.
 *
 * MEASUREMENT/RELABEL-ONLY: never writes `front_sync_emails` /
 * `raw_communication_records`.
 */
export async function backfillInScopeMessageGrain(): Promise<BackfillInScopeMessageGrainResult> {
  const before = await listInScopeNonMessageGrainMonths();
  const examined = before.months.length;
  // Free, Front-call-free in-place conversion of every eligible row.
  await recomputeAllMonths({ frontPullsBudget: 0 });
  const after = await listInScopeNonMessageGrainMonths();
  const stillExcludedMonths = after.months.map((m) => m.month);
  return {
    floorMonth: after.floorMonth,
    examined,
    upgraded: examined - stillExcludedMonths.length,
    stillExcludedMonths,
  };
}

/**
 * Resolve the adoption floor as a `YYYY-MM` prefix. Task #2481 — derived
 * from the hard-coded `FRONT_ADOPTION_DATE`, so it is always non-null and
 * never depends on `system_settings`. Task #2483 narrowed the return type
 * to a plain `string` now that the null-floor case is impossible.
 */
export function getAdoptionFloorMonth(): Promise<string> {
  return Promise.resolve(FRONT_ADOPTION_DATE.slice(0, 7));
}

/**
 * Count cached coverage rows strictly BEFORE the adoption floor. The floor
 * is the hard-coded `FRONT_ADOPTION_DATE` (Task #2481), so it is always
 * present. Pure read.
 */
export async function countPreFloorCoverageRows(): Promise<{
  floorMonth: string;
  count: number;
}> {
  const floorMonth = await getAdoptionFloorMonth();
  const result = await withDbAttribution(
    "frontAnalyticsCoverage:countPreFloor",
    () =>
      getDb().execute(sql`
        SELECT COUNT(*)::int AS n
        FROM front_analytics_monthly_coverage
        WHERE month < ${floorMonth}
      `),
  );
  const count = Number((result.rows as any[])[0]?.n ?? 0);
  return { floorMonth, count };
}

/**
 * Delete cached coverage rows strictly BEFORE the adoption floor.
 * Idempotent — a second call matches zero rows. The floor is the hard-coded
 * `FRONT_ADOPTION_DATE` (Task #2481), so it is always present.
 */
export async function deletePreFloorCoverageRows(): Promise<{
  floorMonth: string;
  deleted: number;
}> {
  const floorMonth = await getAdoptionFloorMonth();
  const result = await withDbAttribution(
    "frontAnalyticsCoverage:deletePreFloor",
    () =>
      getDb().execute(sql`
        DELETE FROM front_analytics_monthly_coverage
        WHERE month < ${floorMonth}
        RETURNING id
      `),
  );
  const deleted = result.rowCount ?? (result.rows as any[]).length;
  return { floorMonth, deleted };
}

// ─── Task #2801 — denominator-floor DB repair (stale-row overflow) ───────
//
// The Task #2795 floor invariant (`front_total_messages` ≥ local message
// count for message-grain rows) is enforced at every write path AND by the
// in-memory safety net in `getFrontAnalyticsCoverageSummary`. But a row
// written BEFORE the floor shipped (or by any straggler path) can still sit
// in the DB with `front_total_messages < applied_into_nobull` until its next
// write. These helpers repair the latent violation in place: re-upsert every
// violating message-grain row through `applyMessageGrainDenominatorFloor` so
// the STORED denominator satisfies the invariant permanently, not just at
// read time. For message-grain rows `applied_into_nobull` IS the local
// unique-message total (fetched == applied == local, see
// `buildMessageGrainHeadline`), so it is the correct floor input — no
// recount, no Front API call, pure cache-table repair.

/**
 * Count message-grain rows whose STORED denominator violates the floor
 * invariant (`front_total_messages < applied_into_nobull`). Done-state is 0.
 */
export async function countMessageGrainFloorViolations(): Promise<number> {
  const result = await withDbAttribution(
    "frontAnalyticsCoverage:countFloorViolations",
    () =>
      getDb().execute(sql`
        SELECT COUNT(*)::int AS n
        FROM front_analytics_monthly_coverage
        WHERE denominator_unit = ${DENOMINATOR_UNIT_MESSAGES_ALL}
          AND front_total_messages < applied_into_nobull
      `),
  );
  return Number((result.rows as any[])[0]?.n ?? 0);
}

export interface RepairFloorRowResult {
  month: string;
  previousFrontTotal: number;
  flooredFrontTotal: number;
  floorExcess: number;
}

export interface RepairMessageGrainFloorResult {
  scanned: number;
  repaired: RepairFloorRowResult[];
  errors: { month: string; errorMessage: string }[];
}

/**
 * Task #2801 — repair every message-grain row whose stored
 * `front_total_messages` is below `applied_into_nobull` by re-upserting it
 * through `applyMessageGrainDenominatorFloor`. Preserves every other column
 * (Front-side per-direction counts, statuses, plan-limit markers) and
 * recomputes only the derived gap/% fields from the floored denominator.
 * Idempotent: once repaired, the WHERE clause matches zero rows. ZERO Front
 * API calls.
 */
export async function repairMessageGrainFloorViolations(): Promise<RepairMessageGrainFloorResult> {
  const rows = (await withDbAttribution(
    "frontAnalyticsCoverage:selectFloorViolations",
    () =>
      getDb()
        .select()
        .from(frontAnalyticsMonthlyCoverage)
        .where(
          and(
            eq(
              frontAnalyticsMonthlyCoverage.denominatorUnit,
              DENOMINATOR_UNIT_MESSAGES_ALL,
            ),
            lt(
              frontAnalyticsMonthlyCoverage.frontTotalMessages,
              frontAnalyticsMonthlyCoverage.appliedIntoNobull,
            ),
          ),
        )
        .orderBy(frontAnalyticsMonthlyCoverage.month),
  )) as FrontAnalyticsMonthlyCoverage[];

  const repaired: RepairFloorRowResult[] = [];
  const errors: { month: string; errorMessage: string }[] = [];
  for (const r of rows) {
    try {
      // For message-grain rows applied_into_nobull IS the local
      // unique-message total — the same floor input every write path uses.
      const { denominator: floored, floorExcess } =
        applyMessageGrainDenominatorFloor(
          r.frontTotalMessages,
          r.appliedIntoNobull,
        );
      const cov = computeCoverage({
        frontTotal: floored,
        fetched: r.fetchedIntoNobull,
        applied: r.appliedIntoNobull,
      });
      await upsertMonthRow({
        month: r.month,
        monthStart: r.monthStart,
        monthEnd: r.monthEnd,
        frontTotalMessages: floored,
        fetchedIntoNobull: r.fetchedIntoNobull,
        appliedIntoNobull: r.appliedIntoNobull,
        ...cov,
        pulledAt: r.pulledAt,
        sourceRunId: r.sourceRunId ?? null,
        isFinalizedMonth: r.isFinalizedMonth,
        frontAnalyticsReportId: r.frontAnalyticsReportId ?? null,
        frontAnalyticsStatus: r.frontAnalyticsStatus ?? null,
        frontAnalyticsError: r.frontAnalyticsError ?? null,
        unrecoverable: r.unrecoverable,
        denominatorSource: r.denominatorSource ?? null,
        denominatorUnit: DENOMINATOR_UNIT_MESSAGES_ALL,
        numeratorUnit: DENOMINATOR_UNIT_MESSAGES_ALL,
        analyticsMessagesInbound: r.analyticsMessagesInbound ?? null,
        analyticsPlanLimitedAt: r.analyticsPlanLimitedAt ?? null,
        // Keep the larger of the stored excess and this repair's excess so a
        // previously computed reconciliation note is never shrunk by a repair
        // pass that saw a smaller residual violation.
        denominatorFloorExcess: Math.max(
          r.denominatorFloorExcess ?? 0,
          floorExcess,
        ),
      });
      repaired.push({
        month: r.month,
        previousFrontTotal: r.frontTotalMessages,
        flooredFrontTotal: floored,
        floorExcess,
      });
    } catch (err) {
      errors.push({
        month: r.month,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { scanned: rows.length, repaired, errors };
}

// ──────────────── Task #1837 — units backfill / recompute ────────────────

export interface RecomputeMonthResult {
  month: string;
  /**
   * - `relabel-only` — denominator already conversation-keyed; only
   *   the unit string + local numerator were rewritten. No Front call.
   * - `repulled` — denominator was messages (or unknown), so we
   *   called Conversations Search to get a units-comparable
   *   denominator; replaces `front_total_messages` and moves the
   *   prior Analytics value into `analytics_messages_inbound`.
   * - `not-comparable` — denominator is messages-units AND we are out
   *   of Front-pull budget (or it failed). Numerator unit is still
   *   stamped so the UI badges the row. Re-run with more budget.
   * - `error` — recompute failed; the prior row is unchanged.
   */
  outcome: "relabel-only" | "repulled" | "not-comparable" | "error";
  errorMessage?: string;
}

export interface RecomputeAllMonthsResult {
  attempted: number;
  results: RecomputeMonthResult[];
  frontPullsUsed: number;
  frontPullsBudget: number;
}

/**
 * Task #1837 — operator-triggered backfill that walks every row in
 * `front_analytics_monthly_coverage`, recomputes the numerator
 * (distinct conversations) from local DB, and unifies the unit
 * columns.
 *
 * For rows whose denominator is already comparable (legacy
 * `inbound_conversations` from a search-fallback pull, or
 * already-new `conversations_all`), this is a free relabel — no Front
 * call.
 *
 * For rows whose denominator is in `inbound_messages` units (Analytics
 * Reports), this calls Conversations Search to fetch a units-comparable
 * denominator. Bounded by `frontPullsBudget` so a single click can't
 * fan out into an unbounded firehose; operators can re-run to consume
 * additional budget.
 *
 * MEASUREMENT-ONLY: never writes to `front_sync_emails` /
 * `raw_communication_records`.
 */
export async function recomputeAllMonths(opts?: {
  /** Default 12 Front pulls per invocation. */
  frontPullsBudget?: number;
}): Promise<RecomputeAllMonthsResult> {
  const budget = Math.max(0, opts?.frontPullsBudget ?? 12);
  const rows = (await withDbAttribution(
    "frontAnalyticsCoverage:recomputeAllMonths",
    () =>
      getDb()
        .select()
        .from(frontAnalyticsMonthlyCoverage)
        .orderBy(frontAnalyticsMonthlyCoverage.month),
  )) as FrontAnalyticsMonthlyCoverage[];

  const results: RecomputeMonthResult[] = [];
  let pullsUsed = 0;

  for (const r of rows) {
    try {
      const monthStart = r.monthStart;
      const monthEnd = r.monthEnd;
      const fetched = await countFetchedForMonth(monthStart, monthEnd);
      const applied = await countAppliedForMonth(monthStart, monthEnd);
      // Task #1974 — recompute per-direction local counts on every
      // recompute pass (no Front budget cost). Front-side per-direction
      // counts are preserved as-is; recompute does not re-pull Analytics.
      const dirLocal = await countMessagesByDirectionForMonth(
        monthStart,
        monthEnd,
      );
      const dirInboundFront = r.messagesInboundFront ?? null;
      const dirOutboundFront = r.messagesOutboundFront ?? null;
      const dirInboundCov = computeDirectionCoverage(
        dirInboundFront,
        dirLocal.inbound,
      );
      const dirOutboundCov = computeDirectionCoverage(
        dirOutboundFront,
        dirLocal.outbound,
      );
      const dirCols = {
        messagesInboundFront: dirInboundFront,
        messagesOutboundFront: dirOutboundFront,
        messagesInboundLocal: dirLocal.inbound,
        messagesOutboundLocal: dirLocal.outbound,
        messagesInboundCoveragePct: dirInboundCov.pct,
        messagesOutboundCoveragePct: dirOutboundCov.pct,
        messagesInboundGap: dirInboundCov.gap,
        messagesOutboundGap: dirOutboundCov.gap,
        directionDataSource: r.directionDataSource ?? null,
      };

      // Task #1920 Step 2 — message-grain rows: the denominator is
      // already message-keyed (per-message enumeration completed). Recompute
      // the local message numerator (free, no Front budget) and PRESERVE the
      // message-grain denominator. Without this branch a messages_all row
      // would fall through to Path B and get re-pulled back to conversations,
      // silently undoing the message-grain headline on every recompute pass.
      if (isMessageGrainDenominator(r.denominatorUnit)) {
        const localMessageTotal = dirLocal.inbound + dirLocal.outbound;
        // Task #2795 — apply denominator floor: the stored denominator must be
        // at least the local unique-message count so applied ≤ denominator.
        const { denominator: floored, floorExcess } =
          applyMessageGrainDenominatorFloor(r.frontTotalMessages, localMessageTotal);
        const cov = computeCoverage({
          frontTotal: floored,
          fetched: localMessageTotal,
          applied: localMessageTotal,
        });
        await upsertMonthRow({
          month: r.month,
          monthStart,
          monthEnd,
          frontTotalMessages: floored,
          fetchedIntoNobull: localMessageTotal,
          appliedIntoNobull: localMessageTotal,
          ...cov,
          pulledAt: r.pulledAt,
          sourceRunId: r.sourceRunId ?? null,
          isFinalizedMonth: r.isFinalizedMonth,
          frontAnalyticsReportId: r.frontAnalyticsReportId ?? null,
          frontAnalyticsStatus: r.frontAnalyticsStatus ?? null,
          frontAnalyticsError: r.frontAnalyticsError ?? null,
          unrecoverable: r.unrecoverable,
          denominatorSource: r.denominatorSource ?? null,
          denominatorUnit: DENOMINATOR_UNIT_MESSAGES_ALL,
          numeratorUnit: DENOMINATOR_UNIT_MESSAGES_ALL,
          analyticsMessagesInbound: r.analyticsMessagesInbound ?? null,
          analyticsPlanLimitedAt: r.analyticsPlanLimitedAt ?? null,
          ...dirCols,
          denominatorFloorExcess: floorExcess,
        });
        results.push({ month: r.month, outcome: "relabel-only" });
        continue;
      }

      // Task #2290 — FREE message-grain conversion. The row already
      // carries BOTH Front-side per-direction message counts (an
      // Analytics in-plan pull, or a completed per-message enumeration),
      // but its headline is still conversation/messages-units grain
      // (written by pre-#2290 code, or a search-fallback headline). Upgrade
      // it to a message-grain headline IN PLACE with ZERO Front calls — the
      // throttled backfill that corrects historical rows without waiting
      // for the next scheduled refresh. Rows already at message grain are
      // handled by the branch above; rows WITHOUT direction data fall
      // through to Path A/B.
      if (dirInboundFront != null && dirOutboundFront != null) {
        const h = buildMessageGrainHeadline({
          inboundFront: dirInboundFront,
          outboundFront: dirOutboundFront,
          localInbound: dirLocal.inbound,
          localOutbound: dirLocal.outbound,
        });
        const cov = computeCoverage({
          frontTotal: h.denominator,
          fetched: h.fetched,
          applied: h.applied,
        });
        await upsertMonthRow({
          month: r.month,
          monthStart,
          monthEnd,
          frontTotalMessages: h.denominator,
          fetchedIntoNobull: h.fetched,
          appliedIntoNobull: h.applied,
          ...cov,
          pulledAt: r.pulledAt,
          sourceRunId: r.sourceRunId ?? null,
          isFinalizedMonth: r.isFinalizedMonth,
          frontAnalyticsReportId: r.frontAnalyticsReportId ?? null,
          frontAnalyticsStatus: r.frontAnalyticsStatus ?? null,
          frontAnalyticsError: r.frontAnalyticsError ?? null,
          unrecoverable: r.unrecoverable,
          // The denominator is now the per-direction message sum; stamp
          // its true source so the diagnostic stays honest.
          denominatorSource:
            r.directionDataSource === DIRECTION_DATA_SOURCE_ANALYTICS
              ? DENOMINATOR_SOURCE_ANALYTICS
              : (r.denominatorSource ?? null),
          denominatorUnit: h.denominatorUnit,
          numeratorUnit: h.numeratorUnit,
          analyticsMessagesInbound: r.analyticsMessagesInbound ?? null,
          analyticsPlanLimitedAt: r.analyticsPlanLimitedAt ?? null,
          ...dirCols,
          denominatorFloorExcess: h.denominatorFloorExcess,
        });
        results.push({ month: r.month, outcome: "relabel-only" });
        continue;
      }

      // Path A — denominator is already conversation-keyed. Free relabel.
      if (isComparableUnit(r.denominatorUnit)) {
        const cov = computeCoverage({
          frontTotal: r.frontTotalMessages,
          fetched,
          applied,
        });
        await upsertMonthRow({
          month: r.month,
          monthStart,
          monthEnd,
          frontTotalMessages: r.frontTotalMessages,
          fetchedIntoNobull: fetched,
          appliedIntoNobull: applied,
          ...cov,
          pulledAt: r.pulledAt,
          sourceRunId: r.sourceRunId ?? null,
          isFinalizedMonth: r.isFinalizedMonth,
          frontAnalyticsReportId: r.frontAnalyticsReportId ?? null,
          frontAnalyticsStatus: r.frontAnalyticsStatus ?? null,
          frontAnalyticsError: r.frontAnalyticsError ?? null,
          unrecoverable: r.unrecoverable,
          denominatorSource: r.denominatorSource ?? null,
          denominatorUnit: DENOMINATOR_UNIT_CONVERSATIONS_ALL,
          numeratorUnit: NUMERATOR_UNIT_CONVERSATIONS_ALL,
          analyticsMessagesInbound: r.analyticsMessagesInbound ?? null,
          analyticsPlanLimitedAt: r.analyticsPlanLimitedAt ?? null,
          ...dirCols,
        });
        results.push({ month: r.month, outcome: "relabel-only" });
        continue;
      }

      // Path B — denominator is messages or unknown. Need a Front pull
      // for a comparable denominator. Budget-gated.
      if (pullsUsed >= budget) {
        // Stamp numerator unit so the UI badge fires; leave denominator
        // alone.
        const cov = computeCoverage({
          frontTotal: r.frontTotalMessages,
          fetched,
          applied,
        });
        await upsertMonthRow({
          month: r.month,
          monthStart,
          monthEnd,
          frontTotalMessages: r.frontTotalMessages,
          fetchedIntoNobull: fetched,
          appliedIntoNobull: applied,
          ...cov,
          pulledAt: r.pulledAt,
          sourceRunId: r.sourceRunId ?? null,
          isFinalizedMonth: r.isFinalizedMonth,
          frontAnalyticsReportId: r.frontAnalyticsReportId ?? null,
          frontAnalyticsStatus: r.frontAnalyticsStatus ?? null,
          frontAnalyticsError: r.frontAnalyticsError ?? null,
          unrecoverable: r.unrecoverable,
          denominatorSource: r.denominatorSource ?? null,
          denominatorUnit: r.denominatorUnit ?? null,
          numeratorUnit: NUMERATOR_UNIT_CONVERSATIONS_ALL,
          analyticsMessagesInbound: r.analyticsMessagesInbound ?? null,
          analyticsPlanLimitedAt: r.analyticsPlanLimitedAt ?? null,
          ...dirCols,
        });
        results.push({ month: r.month, outcome: "not-comparable" });
        continue;
      }

      try {
        const search = await pullMonthlyMessageCountViaSearchFallbackResolved({
          monthStart,
          monthEnd,
        });
        pullsUsed += 1;
        const cov = computeCoverage({
          frontTotal: search.count,
          fetched,
          applied,
        });
        // Move the prior Analytics-messages value into the diagnostic
        // column iff the prior denominator was messages-units.
        const priorAnalytics =
          r.denominatorUnit === DENOMINATOR_UNIT_MESSAGES
            ? r.frontTotalMessages
            : (r.analyticsMessagesInbound ?? null);
        await upsertMonthRow({
          month: r.month,
          monthStart,
          monthEnd,
          frontTotalMessages: search.count,
          fetchedIntoNobull: fetched,
          appliedIntoNobull: applied,
          ...cov,
          pulledAt: new Date(),
          sourceRunId: r.sourceRunId ?? null,
          isFinalizedMonth: r.isFinalizedMonth,
          frontAnalyticsReportId: r.frontAnalyticsReportId ?? null,
          frontAnalyticsStatus: search.truncated ? "search_truncated" : (r.frontAnalyticsStatus ?? "search"),
          frontAnalyticsError: search.truncated
            ? `search_truncated: stopped at ${search.pagesFetched} pages (cap)`
            : null,
          unrecoverable: false,
          denominatorSource: DENOMINATOR_SOURCE_SEARCH,
          denominatorUnit: DENOMINATOR_UNIT_CONVERSATIONS_ALL,
          numeratorUnit: NUMERATOR_UNIT_CONVERSATIONS_ALL,
          analyticsMessagesInbound: priorAnalytics,
          analyticsPlanLimitedAt: r.analyticsPlanLimitedAt ?? null,
          ...dirCols,
        });
        results.push({ month: r.month, outcome: "repulled" });
      } catch (err) {
        pullsUsed += 1; // Count the attempt so a broken token doesn't loop forever.
        results.push({
          month: r.month,
          outcome: "not-comparable",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      results.push({
        month: r.month,
        outcome: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    attempted: rows.length,
    results,
    frontPullsUsed: pullsUsed,
    frontPullsBudget: budget,
  };
}

// ─────── Task #2145 — local-only count recompute for finalized months ───────

export interface LocalCountRecomputeMonthResult {
  month: string;
  changed: boolean;
  before: { fetched: number; applied: number };
  after: { fetched: number; applied: number };
}

export interface RecomputeLocalCountsResult {
  /** Finalized, non-current rows considered. */
  attempted: number;
  /** Rows whose local counts differed and were (or would be) rewritten. */
  changed: number;
  results: LocalCountRecomputeMonthResult[];
}

/**
 * Task #2145 — pure-local recompute of the `fetched` / `applied` (and
 * per-direction local) counts for every *finalized historical* coverage
 * row, keeping each row's existing Front-side denominator untouched.
 *
 * Why this exists: the cache rows for finalized months (e.g. 2026-01..04)
 * were last pulled on 2026-05-20 — before the `front_sync_emails` mirror
 * finished backfilling those months — so their cached `fetched`/`applied`
 * numbers badly undercount the now-complete local data (e.g. 2026-03:
 * ~4,179 cached vs ~7,903 live; 2026-01: 12 vs ~5,426). The
 * finalized-month-skip cadence (Task #1787) then treats them as done, so
 * the normal refresh never revisits them. This re-counts the now-complete
 * local mirror so the dashboard's older-month coverage % reflects live
 * data.
 *
 * Constraints honored:
 *  - ZERO Front API calls. It only re-counts local tables
 *    (`front_sync_emails`, `raw_communication_records`) and reuses the
 *    Front-side denominator already on the row, so it can never re-trigger
 *    the Analytics firehose the de-cadencing work (Task #1787)
 *    deliberately tamed.
 *  - Bounded: only finalized, non-current rows (a handful of months).
 *  - Idempotent: a row whose recomputed local counts already match its
 *    stored values is left untouched (`changed=false`), so a second run
 *    converges to zero changes.
 *  - Current / not-yet-finalized months are skipped on purpose — the
 *    normal cadence owns those, and their live counts change constantly
 *    (which would otherwise keep this action perpetually "pending").
 *
 * Resolves its DB handle via `getDb()` (wrapped in `withDbAttribution`)
 * exactly like its sibling `recomputeAllMonths`, so it honors the test
 * sandbox's isolated schema and the request/worker pool attribution
 * instead of pinning the API pool via the static `db` import. The DB work
 * is a few bounded COUNT queries + at most one UPDATE per finalized month.
 *
 * @param opts.dryRun when true, reports what WOULD change without writing
 *   (used by the prod-action `status()` precheck).
 * @param opts.onlyMonths when provided, restricts the recompute to these
 *   month labels (still intersected with the finalized + non-current
 *   filter). Used for hermetic tests and targeted operator recomputes;
 *   omit it to refresh every finalized historical month.
 */
export async function recomputeLocalCountsAllMonths(opts?: {
  dryRun?: boolean;
  now?: Date;
  onlyMonths?: string[];
}): Promise<RecomputeLocalCountsResult> {
  const dryRun = opts?.dryRun ?? false;
  const now = opts?.now ?? new Date();
  const currentMonth = currentMonthLabel(now);
  const onlyMonths = opts?.onlyMonths ? new Set(opts.onlyMonths) : null;

  const rows = (await withDbAttribution(
    "frontAnalyticsCoverage:recomputeLocalCountsAllMonths",
    () =>
      getDb()
        .select()
        .from(frontAnalyticsMonthlyCoverage)
        .orderBy(frontAnalyticsMonthlyCoverage.month),
  )) as FrontAnalyticsMonthlyCoverage[];

  const targets = rows.filter(
    (r) =>
      r.isFinalizedMonth === true &&
      r.month !== currentMonth &&
      (onlyMonths === null || onlyMonths.has(r.month)),
  );

  const results: LocalCountRecomputeMonthResult[] = [];
  let changedCount = 0;

  for (const r of targets) {
    const monthStart = r.monthStart;
    const monthEnd = r.monthEnd;
    const dirLocal = await countMessagesByDirectionForMonth(
      monthStart,
      monthEnd,
    );
    // Task #1920 — a message-grain row carries a message-keyed denominator, so
    // its numerator must be the local MESSAGE total, not the conversation-grain
    // fetched/applied counters. Writing conversation counts into message-labeled
    // fields (units are preserved verbatim below) would corrupt the coverage %
    // and silently undo the message-grain headline on every local-count
    // refresh. Mirrors the messages_all branch in `recomputeAllMonths`.
    const isMessagesAll = isMessageGrainDenominator(r.denominatorUnit);
    const localMessageTotal = dirLocal.inbound + dirLocal.outbound;
    const fetched = isMessagesAll
      ? localMessageTotal
      : await countFetchedForMonth(monthStart, monthEnd);
    const applied = isMessagesAll
      ? localMessageTotal
      : await countAppliedForMonth(monthStart, monthEnd);

    // Task #2795 — apply denominator floor for message-grain rows so the
    // stored denominator is never below the local count (prevents >100%).
    const flooredFrontTotal = isMessagesAll
      ? Math.max(r.frontTotalMessages, localMessageTotal)
      : r.frontTotalMessages;
    const recomputeFloorExcess = isMessagesAll
      ? Math.max(0, localMessageTotal - r.frontTotalMessages)
      : null;

    const changed =
      flooredFrontTotal !== r.frontTotalMessages ||
      fetched !== r.fetchedIntoNobull ||
      applied !== r.appliedIntoNobull ||
      dirLocal.inbound !== (r.messagesInboundLocal ?? null) ||
      dirLocal.outbound !== (r.messagesOutboundLocal ?? null);

    results.push({
      month: r.month,
      changed,
      before: { fetched: r.fetchedIntoNobull, applied: r.appliedIntoNobull },
      after: { fetched, applied },
    });

    if (!changed) continue;
    changedCount += 1;
    if (dryRun) continue;

    const cov = computeCoverage({
      frontTotal: flooredFrontTotal,
      fetched,
      applied,
    });
    const dirInboundFront = r.messagesInboundFront ?? null;
    const dirOutboundFront = r.messagesOutboundFront ?? null;
    const dirInboundCov = computeDirectionCoverage(
      dirInboundFront,
      dirLocal.inbound,
    );
    const dirOutboundCov = computeDirectionCoverage(
      dirOutboundFront,
      dirLocal.outbound,
    );

    await upsertMonthRow({
      month: r.month,
      monthStart,
      monthEnd,
      // Task #2795 — denominator floor applied for message-grain rows; NO re-pull.
      frontTotalMessages: flooredFrontTotal,
      fetchedIntoNobull: fetched,
      appliedIntoNobull: applied,
      ...cov,
      pulledAt: r.pulledAt,
      sourceRunId: r.sourceRunId ?? null,
      isFinalizedMonth: r.isFinalizedMonth,
      frontAnalyticsReportId: r.frontAnalyticsReportId ?? null,
      frontAnalyticsStatus: r.frontAnalyticsStatus ?? null,
      frontAnalyticsError: r.frontAnalyticsError ?? null,
      unrecoverable: r.unrecoverable,
      // Preserve units verbatim — this is a count refresh, not a relabel.
      denominatorSource: r.denominatorSource ?? null,
      denominatorUnit: r.denominatorUnit ?? null,
      numeratorUnit: r.numeratorUnit ?? null,
      analyticsMessagesInbound: r.analyticsMessagesInbound ?? null,
      analyticsPlanLimitedAt: r.analyticsPlanLimitedAt ?? null,
      messagesInboundFront: dirInboundFront,
      messagesOutboundFront: dirOutboundFront,
      messagesInboundLocal: dirLocal.inbound,
      messagesOutboundLocal: dirLocal.outbound,
      messagesInboundCoveragePct: dirInboundCov.pct,
      messagesOutboundCoveragePct: dirOutboundCov.pct,
      messagesInboundGap: dirInboundCov.gap,
      messagesOutboundGap: dirOutboundCov.gap,
      directionDataSource: r.directionDataSource ?? null,
      denominatorFloorExcess: recomputeFloorExcess,
    });
  }

  return { attempted: targets.length, changed: changedCount, results };
}

// ──────────────── Scheduler ────────────────

const TICK_INTERVAL_MS = 30 * 60_000;
let interval: ReturnType<typeof setInterval> | null = null;

/**
 * Task #1644 — enqueue (rather than execute) the coverage refresh tick
 * so it runs through the fair multi-queue scheduler. Idempotency is
 * per refresh-window bucket so overlapping scheduler ticks (or a
 * manual operator refresh landing on the same bucket) collapse to a
 * single row in `work_queue`. The handler
 * (`handleFrontAnalyticsCoverageRefresh` in workQueueHandlers.ts)
 * runs `runCoverageRefreshTick` and honors `isQueuePaused`,
 * `front_analytics_refresh_enabled`, and
 * `KILL_SWITCH_NON_CRITICAL_SWEEPS` inside the tick itself.
 */
/**
 * Task #1787 (Stage 1) — "is anything due?" check used by the timer
 * before enqueueing. Returns true when any month is due per the new
 * cadence settings. Cheap: at most O(months) row reads from the
 * already-cached `front_analytics_monthly_coverage` table; no Front
 * API calls.
 */
async function anyMonthDueForRefresh(now: Date = new Date()): Promise<boolean> {
  const cadence = await loadMeasurementCadence();
  if (!cadence.measurementEnabled) return false;
  // Task #2481 — the floor is the hard-coded constant; no system_settings read.
  const adoption = FRONT_ADOPTION_DATE;
  const months = listMonthsFromAdoption(adoption, now);
  if (months.length === 0) return false;
  const currentMonth = currentMonthLabel(now);
  for (const m of months) {
    const existing = await getExistingMonth(m.month);
    const isCurrent = m.month === currentMonth;
    if (isCurrent) {
      if (
        !existing?.pulledAt ||
        now.getTime() - existing.pulledAt.getTime() >=
          cadence.currentMonthIntervalMs
      ) {
        return true;
      }
      continue;
    }
    if (cadence.finalizedSkipEnabled && isExistingFinalizedClean(existing, false, now)) {
      continue;
    }
    if (
      existing?.unrecoverable &&
      !shouldReEvaluateMisclassifiedUnrecoverable(existing) &&
      !shouldReEvaluateAuthBlocked(existing)
    ) {
      continue;
    }
    if (
      !existing ||
      !existing.pulledAt ||
      !existing.isFinalizedMonth ||
      existing.frontAnalyticsError ||
      isPlanLimitMemoStale(existing, now)
    ) {
      // Apply incomplete-month cadence gate.
      if (
        existing?.pulledAt &&
        !existing.frontAnalyticsError &&
        !existing.isFinalizedMonth &&
        now.getTime() - existing.pulledAt.getTime() <
          cadence.incompleteMonthIntervalMs
      ) {
        continue;
      }
      return true;
    }
  }
  return false;
}

async function enqueueScheduledTick(): Promise<void> {
  try {
    // Task #1787 (Stage 1) — emergency-paused queue: skip enqueue and
    // log a structured reason instead of letting the dedupe key absorb it.
    if (isQueuePaused(QUEUE_NAME)) {
      console.log(
        `[FrontAnalyticsCoverage] front_analytics_refresh_enqueue_skipped_queue_paused queue=${QUEUE_NAME} reason=queue_drain_state ts=${new Date().toISOString()}`,
      );
      return;
    }
    // Task #1787 (Stage 1) — due-check skip: avoid enqueueing a job
    // that would no-op inside `runCoverageRefreshTick`. Conservative on
    // error: if the due check throws, fall through and enqueue (the
    // tick itself will safely no-op).
    let due = true;
    try {
      due = await anyMonthDueForRefresh();
    } catch (err: any) {
      console.warn(
        `[FrontAnalyticsCoverage] due-check failed, enqueueing anyway: ${err?.message ?? err}`,
      );
    }
    if (!due) {
      return;
    }
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
      `[FrontAnalyticsCoverage] enqueue scheduled tick failed: ${
        err?.message ?? err
      }`,
    );
  }
}

export function startFrontAnalyticsCoverageScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void enqueueScheduledTick();
  }, TICK_INTERVAL_MS);
  console.log(
    `[FrontAnalyticsCoverage] enqueue scheduler started (enqueue every ${
      TICK_INTERVAL_MS / 60_000
    }min, max ${PERF.FRONT_ANALYTICS_COVERAGE_MAX_MONTHS_PER_TICK} backfill months/tick) — work runs in worker pool via ${QUEUE_NAME} queue`,
  );
}

export function stopFrontAnalyticsCoverageScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __frontAnalyticsCoverageTestHelpers = {
  computeCoverage,
  deriveCoverageCompleteness,
  enqueueScheduledTick,
  applyMessageGrainDenominatorFloor,
};
