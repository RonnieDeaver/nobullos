/**
 * Task #4645 — Sustained Slack-outage detector + in-app escalation.
 *
 * Prod context (audits/slack-outage-diagnosis-2026-08-12.md): every Slack
 * channel delivery has failed with `channel_not_found` for the entire life
 * of the delivery ledger. The per-channel 6h self-alert fired, but its
 * constant dedupe key collapsed every repeat into one buried unread bell
 * row — so the outage sat unnoticed for weeks. This module is the aggregate
 * alarm: it watches recorded delivery outcomes and, when Slack is failing
 * persistently across the board, opens ONE durable escalation that
 * re-alerts responsible admins in-app DAILY (fresh bell row per outage-day)
 * with the outage day-count and a deep link to the Slack notifications
 * console. Recovery (any successful delivery newer than the last failure)
 * closes the state automatically.
 *
 * Design notes:
 *  - Signal = `notification_deliveries` rows with status success/failed
 *    ONLY. All `skipped_*` statuses (kill switch, disconnected, no channel,
 *    dedupe) are non-observations: paused periods can neither open nor
 *    close the outage.
 *  - Durable state = one singleton `notification_health_state` row under a
 *    synthetic notification id, so streak/day-count/last-alert survive
 *    restarts and autoscale siblings (state is read fresh each evaluate).
 *  - Escalation goes through the in-app inbox ONLY (`notifyUser`) — never
 *    through Slack, which is the broken path. Inbox dedupe keys embed the
 *    outage instance + day number, so each outage-day produces exactly one
 *    fresh row per admin even if evaluation runs hundreds of times.
 *  - Triggers = event-driven hooks from the dispatcher after it records an
 *    outcome (throttled), a lazy read-time refresh from the console route,
 *    AND a 6h cross-instance-singleton periodic evaluator (booted from
 *    schedulerInits). The events keep the state fresh while traffic flows;
 *    the periodic pass guarantees the daily re-alert even when a quiet or
 *    freshly-restarted deployment records zero further delivery attempts
 *    and no admin opens the console.
 *  - Test-inert: under NODE_ENV=test / TEST_SMOKE the dispatcher hook and
 *    console read no-op unless a test explicitly enables them, so sibling
 *    suites driving the dispatcher can't open real state or spam seeded
 *    admins. `evaluateSlackOutage` itself stays directly callable with
 *    injected deps (goingQuietAlert pattern).
 */
import {
  getSlackOutcomeStats,
  getHealthState,
  upsertHealthState,
  type SlackOutcomeStats,
  type SlackOutcomeTopFailing,
} from "../../storage/notificationsStorage";
import type { NotificationHealthState } from "@shared/schema";
import { registerModuleStateResetForTest } from "../moduleStateReset";
import { runWithWorkerDb, withDbAttribution } from "../../db";

export const SLACK_OUTAGE_NOTIFICATION_ID = "system.slack.outage";
export const SLACK_OUTAGE_STATE_DEDUPE_KEY = "slack.outage.sustained";
/** Inbox rows are keyed `slack.outage.sustained:<openStamp>:day<N>:<uid>` —
 *  tests MUST scope asserts by this prefix, never by total counts. */
export const SLACK_OUTAGE_INBOX_DEDUPE_PREFIX = "slack.outage.sustained:";
export const SLACK_OUTAGE_CONSOLE_PATH = "/admin/slack/notifications";

export const SLACK_OUTAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SLACK_OUTAGE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
export const SLACK_OUTAGE_LOOKBACK_DAYS = 30;
/** Minimum success+failed observations in the window before we may open. */
export const SLACK_OUTAGE_MIN_ATTEMPTS = 10;
export const SLACK_OUTAGE_MIN_FAILURE_RATE = 0.95;
/** The uninterrupted failure streak must be at least this old to open. */
export const SLACK_OUTAGE_MIN_STREAK_MS = 24 * 60 * 60 * 1000;
export const SLACK_OUTAGE_REALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const EVAL_THROTTLE_MS = 60_000;

export interface SlackOutageStatus {
  active: boolean;
  openedAt: string | null;
  failingSince: string | null;
  /** Whole days of uninterrupted failure (floor), ≥1 while active. */
  dayCount: number | null;
  /** Display-ready day count — caps at the lookback horizon ("30+"). */
  dayCountLabel: string | null;
  windowAttempts: number;
  windowFailures: number;
  windowSuccesses: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastErrorMessage: string | null;
  topFailing: SlackOutcomeTopFailing[];
  lastEscalatedAt: string | null;
}

interface SlackOutageDeps {
  getStats: (opts: {
    windowMs: number;
    lookbackMs: number;
    now?: Date;
  }) => Promise<SlackOutcomeStats>;
  getState: () => Promise<NotificationHealthState | undefined>;
  upsertState: (patch: {
    state: "healthy" | "unhealthy";
    failureType?: string | null;
    lastNotifiedAt?: Date | null;
    metadataJson?: unknown;
  }) => Promise<unknown>;
  getResponsibleAdmins: () => Promise<string[]>;
  notifyUser: (
    userId: string,
    opts: {
      category: string;
      title: string;
      body?: string;
      deepLink?: string;
      dedupeKey?: string;
      metadata?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  /** Cluster-wide singleton lock for the periodic pass — null = another
   *  instance owns this tick. Injected so tests can fake contention. */
  acquireEvaluatorLock: () => Promise<{ release: () => Promise<void> } | null>;
}

const defaultDeps: SlackOutageDeps = {
  getStats: (opts) => getSlackOutcomeStats(opts),
  getState: () =>
    getHealthState(SLACK_OUTAGE_NOTIFICATION_ID, SLACK_OUTAGE_STATE_DEDUPE_KEY),
  upsertState: (patch) =>
    upsertHealthState({
      notificationId: SLACK_OUTAGE_NOTIFICATION_ID,
      dedupeKey: SLACK_OUTAGE_STATE_DEDUPE_KEY,
      ...patch,
    }),
  getResponsibleAdmins: async () => {
    const { getResponsibleAdminsForAlert } = await import("./recipients");
    return getResponsibleAdminsForAlert();
  },
  notifyUser: async (userId, opts) => {
    const { notifyUser } = await import("./userInbox");
    return notifyUser(userId, opts as Parameters<typeof notifyUser>[1]);
  },
  acquireEvaluatorLock: async () => {
    const { acquireWorkerSingletonLock } = await import("../crossInstanceLock");
    const { CROSS_INSTANCE_LOCK_MAX_HOLD_MS } = await import("../workerConfig");
    return acquireWorkerSingletonLock("slack-outage-evaluator", "[slackOutage]", {
      maxHoldMs: CROSS_INSTANCE_LOCK_MAX_HOLD_MS.slack_outage_evaluator,
    });
  },
};

let deps: SlackOutageDeps = { ...defaultDeps };

// Module state — throttle bookkeeping + last computed status. All of this is
// advisory cache only; the DURABLE truth lives in notification_health_state.
let lastEvalStartedMs = 0;
let evalInFlight: Promise<SlackOutageStatus> | null = null;
let lastStatus: SlackOutageStatus | null = null;
let testHookEnabled = false;

/** Under the test runner the automatic hooks are inert unless a test opts in
 *  — otherwise sibling suites driving the dispatcher would open real outage
 *  state and spam their seeded admins (zero-notify asserts). */
function testInert(): boolean {
  return (
    (process.env.NODE_ENV === "test" || !!process.env.TEST_SMOKE) &&
    !testHookEnabled
  );
}

/**
 * Dispatcher hook — called (fire-and-forget) after a success/failed delivery
 * outcome is recorded. Failures evaluate at most once per throttle interval;
 * successes only evaluate when an outage might be open (prompt close) or
 * right after boot (unknown state), so the healthy steady state costs ~zero.
 */
export function noteSlackDeliveryOutcome(outcome: "success" | "failure"): void {
  if (testInert()) return;
  if (outcome === "success") {
    if (lastStatus && !lastStatus.active) return;
  } else if (Date.now() - lastEvalStartedMs < EVAL_THROTTLE_MS) {
    return;
  }
  void evaluateSlackOutage({ trigger: outcome }).catch(() => {});
}

/**
 * Console read — throttled lazy refresh so the banner stays fresh without a
 * periodic job. Returns the cached status when a recent evaluation exists.
 * Never throws; returns the last known status (or null) on failure.
 */
export async function getSlackOutageStatusForConsole(): Promise<SlackOutageStatus | null> {
  if (testInert()) return null;
  try {
    if (lastStatus && Date.now() - lastEvalStartedMs < EVAL_THROTTLE_MS) {
      return lastStatus;
    }
    return await evaluateSlackOutage({ trigger: "console_read" });
  } catch {
    return lastStatus;
  }
}

// ── Periodic evaluator (completion-review hardening) ────────────────────────
//
// The dispatcher hooks + console reads above are event-driven: after an
// outage opens, a quiet or freshly-restarted deployment with ZERO further
// delivery attempts and no console visits would keep the durable unhealthy
// row but never emit the next day-N re-alert. This interval guarantees the
// daily cadence from durable state alone. Each pass takes the cluster-wide
// worker-singleton advisory lock, so exactly ONE autoscale instance
// evaluates per tick, and runs on the worker pool with scheduler
// attribution like every other periodic job.
export const SLACK_OUTAGE_EVALUATOR_INTERVAL_MS = 6 * 60 * 60 * 1000;

let evaluatorTimer: ReturnType<typeof setInterval> | null = null;

/** One guarded evaluator pass — exported directly for tests (inject
 *  `acquireEvaluatorLock` via the deps seam). Returns null when a sibling
 *  instance holds the lock or the pass failed; never throws/rejects. */
export async function runSlackOutagePeriodicEvaluationOnce(
  opts: { now?: Date } = {},
): Promise<SlackOutageStatus | null> {
  let lock: { release: () => Promise<void> } | null = null;
  try {
    lock = await deps.acquireEvaluatorLock();
    if (!lock) return null; // another instance owns this pass
    return await runWithWorkerDb(() =>
      withDbAttribution("scheduler:slack-outage-evaluator", () =>
        evaluateSlackOutage({ now: opts.now, trigger: "periodic" }),
      ),
    );
  } catch (err: any) {
    console.warn(
      `[slackOutage] periodic evaluation failed: ${err?.message ?? err}`,
    );
    return null;
  } finally {
    if (lock) {
      try {
        await lock.release();
      } catch {
        /* release is best-effort — the maxHoldMs watchdog reclaims it */
      }
    }
  }
}

/** Boot entry (server/boot/schedulerInits.ts). Test-inert: under the test
 *  runner the interval never arms — suites drive the pass fn directly. */
export function startSlackOutageEvaluator(): void {
  if (process.env.NODE_ENV === "test" || process.env.TEST_SMOKE) {
    console.log("[slackOutage] test env — periodic evaluator disabled");
    return;
  }
  if (evaluatorTimer) return;
  evaluatorTimer = setInterval(() => {
    // fire-and-forget: the pass logs its own failures and never rejects.
    void runSlackOutagePeriodicEvaluationOnce();
  }, SLACK_OUTAGE_EVALUATOR_INTERVAL_MS);
  evaluatorTimer.unref?.();
  // First pass immediately (boot is already staggered by the scheduler
  // offsets) so a restart can't defer an overdue day-N re-alert another 6h.
  void runSlackOutagePeriodicEvaluationOnce();
}

export function stopSlackOutageEvaluator(): void {
  if (evaluatorTimer) clearInterval(evaluatorTimer);
  evaluatorTimer = null;
}

/** Single-flight wrapper — concurrent triggers share one evaluation. */
export function evaluateSlackOutage(
  opts: { now?: Date; trigger?: string } = {},
): Promise<SlackOutageStatus> {
  if (evalInFlight) return evalInFlight;
  const p = doEvaluate(opts).finally(() => {
    evalInFlight = null;
  });
  evalInFlight = p;
  return p;
}

function parseMetaDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function computeDayCount(failingSince: Date, now: Date): number {
  const days = Math.floor(
    (now.getTime() - failingSince.getTime()) / (24 * 60 * 60 * 1000),
  );
  return Math.max(1, days);
}

function dayCountLabel(dayCount: number): string {
  return dayCount >= SLACK_OUTAGE_LOOKBACK_DAYS
    ? `${SLACK_OUTAGE_LOOKBACK_DAYS}+`
    : String(dayCount);
}

/** YYYYMMDD stamp identifying the outage instance in inbox dedupe keys. */
function dayStamp(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function buildStatus(args: {
  active: boolean;
  stats: SlackOutcomeStats;
  openedAt?: Date | null;
  failingSince?: Date | null;
  now: Date;
  lastEscalatedAt?: Date | null;
}): SlackOutageStatus {
  const { active, stats, now } = args;
  const failingSince = active ? (args.failingSince ?? null) : null;
  const dayCount = active && failingSince ? computeDayCount(failingSince, now) : null;
  return {
    active,
    openedAt: active ? (args.openedAt?.toISOString() ?? null) : null,
    failingSince: failingSince?.toISOString() ?? null,
    dayCount,
    dayCountLabel: dayCount != null ? dayCountLabel(dayCount) : null,
    windowAttempts: stats.windowFailures + stats.windowSuccesses,
    windowFailures: stats.windowFailures,
    windowSuccesses: stats.windowSuccesses,
    lastFailureAt: stats.lastFailureAt?.toISOString() ?? null,
    lastSuccessAt: stats.lastSuccessAt?.toISOString() ?? null,
    lastErrorMessage: stats.lastErrorMessage,
    topFailing: stats.topFailing,
    lastEscalatedAt: args.lastEscalatedAt?.toISOString() ?? null,
  };
}

async function doEvaluate(opts: {
  now?: Date;
  trigger?: string;
}): Promise<SlackOutageStatus> {
  lastEvalStartedMs = Date.now();
  const now = opts.now ?? new Date();
  try {
    const stats = await deps.getStats({
      windowMs: SLACK_OUTAGE_WINDOW_MS,
      lookbackMs: SLACK_OUTAGE_LOOKBACK_MS,
      now,
    });
    const state = await deps.getState();
    const meta = (state?.metadataJson ?? {}) as Record<string, unknown>;
    const isOpen = state?.state === "unhealthy";

    const attempts = stats.windowFailures + stats.windowSuccesses;
    const failureRate = attempts > 0 ? stats.windowFailures / attempts : 0;
    const streakOldEnough =
      stats.failingSince != null &&
      now.getTime() - stats.failingSince.getTime() >= SLACK_OUTAGE_MIN_STREAK_MS;
    const failuresAreCurrent =
      stats.lastFailureAt != null &&
      (stats.lastSuccessAt == null ||
        stats.lastFailureAt.getTime() > stats.lastSuccessAt.getTime());
    const openCondition =
      attempts >= SLACK_OUTAGE_MIN_ATTEMPTS &&
      failureRate >= SLACK_OUTAGE_MIN_FAILURE_RATE &&
      streakOldEnough &&
      failuresAreCurrent;
    const closeCondition =
      stats.lastSuccessAt != null &&
      (stats.lastFailureAt == null ||
        stats.lastSuccessAt.getTime() > stats.lastFailureAt.getTime());

    if (isOpen) {
      if (closeCondition) {
        await deps.upsertState({
          state: "healthy",
          failureType: "slack_outage",
          metadataJson: {
            ...meta,
            closedAt: now.toISOString(),
            closedByTrigger: opts.trigger ?? null,
          },
        });
        console.log(
          `[slackOutage] recovered — Slack deliveries succeeding again (last success ${stats.lastSuccessAt?.toISOString()})`,
        );
        lastStatus = buildStatus({ active: false, stats, now });
        return lastStatus;
      }

      // Still open. Stored values keep day-count stable even as the SQL
      // lookback horizon slides underneath the streak.
      const openedAt =
        parseMetaDate(meta.openedAt) ?? state?.transitionedAt ?? now;
      const failingSince =
        parseMetaDate(meta.failingSince) ?? stats.failingSince ?? openedAt;
      const openStamp =
        (typeof meta.openedDayStamp === "string" && meta.openedDayStamp) ||
        dayStamp(openedAt);
      const dayCount = computeDayCount(failingSince, now);
      const lastNotified = state?.lastNotifiedAt ?? null;
      let lastEscalatedAt: Date | null = lastNotified;
      if (
        !lastNotified ||
        now.getTime() - lastNotified.getTime() >= SLACK_OUTAGE_REALERT_INTERVAL_MS
      ) {
        await escalate({ dayCount, stats, failingSince, openStamp });
        await deps.upsertState({
          state: "unhealthy",
          failureType: "slack_outage",
          lastNotifiedAt: now,
          metadataJson: { ...meta, lastRealertDay: dayCount },
        });
        lastEscalatedAt = now;
        console.log(
          `[slackOutage] daily re-alert — day ${dayCount}, ${stats.windowFailures}/${attempts} failed in 24h`,
        );
      }
      lastStatus = buildStatus({
        active: true,
        stats,
        openedAt,
        failingSince,
        now,
        lastEscalatedAt,
      });
      return lastStatus;
    }

    if (openCondition) {
      const failingSince = stats.failingSince ?? now;
      const openStamp = dayStamp(now);
      const dayCount = computeDayCount(failingSince, now);
      await escalate({ dayCount, stats, failingSince, openStamp });
      await deps.upsertState({
        state: "unhealthy",
        failureType: "slack_outage",
        lastNotifiedAt: now,
        metadataJson: {
          openedAt: now.toISOString(),
          failingSince: failingSince.toISOString(),
          openedDayStamp: openStamp,
        },
      });
      console.warn(
        `[slackOutage] OPENED — ${stats.windowFailures}/${attempts} Slack deliveries failed in 24h, failing since ${failingSince.toISOString()}`,
      );
      lastStatus = buildStatus({
        active: true,
        stats,
        openedAt: now,
        failingSince,
        now,
        lastEscalatedAt: now,
      });
      return lastStatus;
    }

    lastStatus = buildStatus({ active: false, stats, now });
    return lastStatus;
  } catch (err: any) {
    console.warn(
      `[slackOutage] evaluation failed (${opts.trigger ?? "unknown"}): ${err?.message ?? err}`,
    );
    return (
      lastStatus ??
      buildStatus({
        active: false,
        stats: {
          windowFailures: 0,
          windowSuccesses: 0,
          lastFailureAt: null,
          lastSuccessAt: null,
          failingSince: null,
          topFailing: [],
          lastErrorMessage: null,
        },
        now,
      })
    );
  }
}

/** Fan the day-N escalation to responsible admins — in-app inbox ONLY (the
 *  Slack path is exactly what's broken). Best-effort per recipient. */
async function escalate(args: {
  dayCount: number;
  stats: SlackOutcomeStats;
  failingSince: Date;
  openStamp: string;
}): Promise<void> {
  const { dayCount, stats, failingSince, openStamp } = args;
  const admins = await deps.getResponsibleAdmins();
  if (admins.length === 0) {
    console.warn(
      "[slackOutage] no responsible admins found — escalation has no recipients",
    );
    return;
  }
  const attempts = stats.windowFailures + stats.windowSuccesses;
  const top = stats.topFailing[0] ?? null;
  const daysLabel = dayCountLabel(dayCount);
  const title = `Slack alerting outage — day ${daysLabel}`;
  const body =
    `Slack notifications have been failing for ${daysLabel} day(s): ` +
    `${stats.windowFailures} of ${attempts} deliveries failed in the last 24h` +
    (stats.lastErrorMessage ? ` (latest error: ${stats.lastErrorMessage})` : "") +
    `.` +
    (top?.channelId
      ? ` Failing deliveries target Slack channel "${top.channelId}".`
      : "") +
    ` Open the Slack notifications console, pick a channel the NoBull bot is a member of, ` +
    `save it, then press "Send test" — a successful test clears this alert automatically. ` +
    `This alert repeats daily until Slack deliveries succeed again.`;
  for (const uid of admins) {
    try {
      await deps.notifyUser(uid, {
        category: "system",
        title,
        body,
        deepLink: SLACK_OUTAGE_CONSOLE_PATH,
        dedupeKey: `${SLACK_OUTAGE_INBOX_DEDUPE_PREFIX}${openStamp}:day${dayCount}:${uid}`,
        metadata: {
          failingSince: failingSince.toISOString(),
          dayCount,
          windowFailures: stats.windowFailures,
          windowAttempts: attempts,
          channelId: top?.channelId ?? null,
        },
      });
    } catch (err: any) {
      console.warn(
        `[slackOutage] escalation notify failed for user ${uid}: ${err?.message ?? err}`,
      );
    }
  }
}

// ── Test seams (ESM live-binding workaround, goingQuietAlert pattern) ───────

export function __setSlackOutageDepsForTest(
  overrides: Partial<SlackOutageDeps>,
): void {
  deps = { ...deps, ...overrides };
}

export function __resetSlackOutageDepsForTest(): void {
  deps = { ...defaultDeps };
}

/** Opt the automatic hooks (dispatcher + console read) back in for a test. */
export function __setSlackOutageTestHookEnabled(v: boolean): void {
  testHookEnabled = v;
}

export function __resetSlackOutageDetectorStateForTest(): void {
  lastEvalStartedMs = 0;
  evalInFlight = null;
  lastStatus = null;
  testHookEnabled = false;
}

registerModuleStateResetForTest("slackOutageDetector", () => {
  stopSlackOutageEvaluator();
  __resetSlackOutageDetectorStateForTest();
  __resetSlackOutageDepsForTest();
});
