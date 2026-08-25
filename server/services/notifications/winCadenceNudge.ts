/**
 * Task #4888 — weekly win-cadence nudge for account managers.
 *
 * Task #4874 shipped the visible weekly win tracker (Internal Usage page):
 * leadership can see which account managers met "at least 1 win/week", but
 * nothing tells the AM themselves. This module closes the loop: shortly
 * after a UTC week closes (Monday 00:00 UTC), every account manager who
 * logged ZERO counted wins in the just-closed week gets an in-app bell
 * nudge, and each team lead gets one summary row naming the misses — so
 * the cadence self-corrects without leadership policing the page.
 *
 * Design notes (mirrors slackOutageDetector, the review-approved pattern):
 *  - Delivery is driven by a lock-guarded PERIODIC evaluator over durable
 *    state — never event-driven triggers alone (review-rejected before).
 *    A 6h interval + boot catch-up pass takes the cluster-wide worker
 *    singleton advisory lock, so exactly ONE autoscale instance evaluates
 *    per tick, on the worker pool with scheduler attribution.
 *  - Week math + exclusions are computeWinTrackingReport's, verbatim: UTC
 *    Monday week buckets, demo/archived clients and retracted (archived
 *    status) entries never count, AM-only targets (`isAccountManager`).
 *  - Durable state = one singleton `notification_health_state` row under a
 *    synthetic notification id. Its metadata records the last fully-nudged
 *    week plus the per-user ledger for the week in flight, so restarts and
 *    partially-failed passes retry ONLY the recipients that never got
 *    their row. `state` stays "healthy" — this is a cadence ledger, not a
 *    health streak.
 *  - Inbox dedupe keys are week+user scoped (`wins.cadence.missed:
 *    <weekStamp>:<uid>`), never constant, so each missed week produces
 *    exactly one fresh bell row per person even if evaluation runs
 *    hundreds of times (constant keys collapse into one buried unread row
 *    — the Task #4645 lesson).
 *  - Bell-only (`notifyUser`): the Slack-channel dispatcher broadcasts to
 *    admin channels, which is the wrong surface for a personal nudge.
 *  - Test-inert: under NODE_ENV=test / TEST_SMOKE the interval never arms;
 *    suites drive the pass function directly with injected deps.
 */
import {
  computeWinTrackingReport,
  getUtcWeekStart,
  type WinTrackingReport,
} from "../../storage/internalUsageStorage";
import {
  getHealthState,
  upsertHealthState,
} from "../../storage/notificationsStorage";
import type { NotificationHealthState } from "@shared/schema";
import { registerModuleStateResetForTest } from "../moduleStateReset";
import { runWithWorkerDb, withDbAttribution } from "../../db";

export const WIN_CADENCE_NOTIFICATION_ID = "system.wins.weekly_cadence";
export const WIN_CADENCE_STATE_DEDUPE_KEY = "wins.weekly_cadence";
/** Per-AM nudge rows are keyed `wins.cadence.missed:<weekStamp>:<uid>` —
 *  tests MUST scope asserts by this prefix, never by total counts. */
export const WIN_CADENCE_INBOX_DEDUPE_PREFIX = "wins.cadence.missed:";
/** Team-lead summary rows: `wins.cadence.missed-summary:<weekStamp>:<uid>`. */
export const WIN_CADENCE_SUMMARY_DEDUPE_PREFIX = "wins.cadence.missed-summary:";
export const WIN_CADENCE_PAGE_PATH = "/admin/internal-usage";

export const WIN_CADENCE_EVALUATOR_INTERVAL_MS = 6 * 60 * 60 * 1000;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface WinCadenceDeps {
  computeReport: (now: Date) => Promise<WinTrackingReport>;
  getState: () => Promise<NotificationHealthState | undefined>;
  upsertState: (patch: {
    state: "healthy" | "unhealthy";
    failureType?: string | null;
    lastNotifiedAt?: Date | null;
    metadataJson?: unknown;
  }) => Promise<unknown>;
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

const defaultDeps: WinCadenceDeps = {
  computeReport: (now) => computeWinTrackingReport(now),
  getState: () =>
    getHealthState(WIN_CADENCE_NOTIFICATION_ID, WIN_CADENCE_STATE_DEDUPE_KEY),
  upsertState: (patch) =>
    upsertHealthState({
      notificationId: WIN_CADENCE_NOTIFICATION_ID,
      dedupeKey: WIN_CADENCE_STATE_DEDUPE_KEY,
      ...patch,
    }),
  notifyUser: async (userId, opts) => {
    const { notifyUser } = await import("./userInbox");
    return notifyUser(userId, opts as Parameters<typeof notifyUser>[1]);
  },
  acquireEvaluatorLock: async () => {
    const { acquireWorkerSingletonLock } = await import("../crossInstanceLock");
    const { CROSS_INSTANCE_LOCK_MAX_HOLD_MS } = await import("../workerConfig");
    return acquireWorkerSingletonLock("win-cadence-nudge", "[winCadence]", {
      maxHoldMs: CROSS_INSTANCE_LOCK_MAX_HOLD_MS.win_cadence_nudge,
    });
  },
};

let deps: WinCadenceDeps = { ...defaultDeps };
let evaluatorTimer: ReturnType<typeof setInterval> | null = null;

export interface WinCadenceEvaluationResult {
  /** ISO week-start of the just-closed UTC week that was evaluated. */
  closedWeekStart: string;
  /** True when this pass had nothing left to do (week already fully nudged). */
  alreadyComplete: boolean;
  /** AM userIds that missed the closed week (zero counted wins). */
  missedUserIds: string[];
  /** Recipients nudged BY THIS PASS (excludes ledger-skipped ones). */
  nudgedUserIds: string[];
  /** Team leads that received the summary row in this pass. */
  summarizedLeadIds: string[];
  /** Recipients whose notify failed this pass (retried next tick). */
  failedUserIds: string[];
}

/** YYYYMMDD stamp of the closed week's Monday — the week instance id used
 *  in every dedupe key for that week. */
export function winCadenceWeekStamp(weekStart: Date): string {
  return weekStart.toISOString().slice(0, 10).replace(/-/g, "");
}

function displayName(m: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  userId: string;
}): string {
  return (
    `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim() || m.email || m.userId
  );
}

function fmtWeekRange(weekStart: Date): string {
  const end = new Date(weekStart.getTime() + WEEK_MS - 24 * 60 * 60 * 1000);
  const fmt = (d: Date) =>
    d.toISOString().slice(0, 10); // YYYY-MM-DD, UTC — same calendar the target uses
  return `${fmt(weekStart)} – ${fmt(end)} (UTC week)`;
}

/**
 * One evaluation of the just-closed UTC week. Idempotent: the durable
 * ledger (notification_health_state metadata) records, per week, which
 * recipients already got their row, so re-runs, restarts and autoscale
 * siblings can never double-nudge the same person+week. Never throws.
 */
export async function evaluateWinCadence(
  now: Date = new Date(),
): Promise<WinCadenceEvaluationResult | null> {
  try {
    const currentWeekStart = getUtcWeekStart(now);
    const closedWeekStart = new Date(currentWeekStart.getTime() - WEEK_MS);
    const closedIso = closedWeekStart.toISOString();
    const stamp = winCadenceWeekStamp(closedWeekStart);

    const state = await deps.getState();
    const meta = (state?.metadataJson ?? {}) as Record<string, unknown>;
    if (meta.completedWeekStart === closedIso) {
      return {
        closedWeekStart: closedIso,
        alreadyComplete: true,
        missedUserIds: [],
        nudgedUserIds: [],
        summarizedLeadIds: [],
        failedUserIds: [],
      };
    }
    // Per-week ledger of already-delivered recipients (AM nudges and lead
    // summaries share it — lead ids are prefixed to avoid collisions).
    const ledger = new Set<string>(
      meta.ledgerWeekStart === closedIso && Array.isArray(meta.ledger)
        ? (meta.ledger as string[])
        : [],
    );

    const report = await deps.computeReport(now);
    // The closed week is the second-to-last grid cell; verify rather than
    // assume so a future grid change can't silently nudge the wrong week.
    const closedIdx = report.weeks.findIndex((w) => w.start === closedIso);
    if (closedIdx === -1) {
      console.warn(
        `[winCadence] closed week ${closedIso} not in tracking grid — skipping pass`,
      );
      return null;
    }

    const missed = report.members.filter(
      (m) => m.isAccountManager && m.weeks[closedIdx].count === 0,
    );
    const teamLeads = report.members.filter((m) => (m.role ?? "") === "team_lead");

    const nudgedUserIds: string[] = [];
    const summarizedLeadIds: string[] = [];
    const failedUserIds: string[] = [];
    const weekLabel = fmtWeekRange(closedWeekStart);

    for (const m of missed) {
      if (ledger.has(m.userId)) continue;
      try {
        await deps.notifyUser(m.userId, {
          category: "system",
          title: "Weekly win target missed",
          body:
            `You logged no wins for ${weekLabel} — the target is at least one ` +
            `win per week. Log a win from a client's Intelligence Feed ` +
            `(win/progress entry) to keep the cadence on track this week.`,
          deepLink: WIN_CADENCE_PAGE_PATH,
          dedupeKey: `${WIN_CADENCE_INBOX_DEDUPE_PREFIX}${stamp}:${m.userId}`,
          metadata: { weekStart: closedIso, weekStamp: stamp },
        });
        ledger.add(m.userId);
        nudgedUserIds.push(m.userId);
      } catch (err: any) {
        failedUserIds.push(m.userId);
        console.warn(
          `[winCadence] nudge failed for user ${m.userId}: ${err?.message ?? err}`,
        );
      }
    }

    if (missed.length > 0) {
      const names = missed.map(displayName).sort((a, b) => a.localeCompare(b));
      for (const lead of teamLeads) {
        const ledgerKey = `lead:${lead.userId}`;
        if (ledger.has(ledgerKey)) continue;
        try {
          await deps.notifyUser(lead.userId, {
            category: "system",
            title: `Weekly win target missed by ${missed.length} account manager${missed.length === 1 ? "" : "s"}`,
            body:
              `No wins logged for ${weekLabel}: ${names.join(", ")}. ` +
              `Each of them has been nudged directly.`,
            deepLink: WIN_CADENCE_PAGE_PATH,
            dedupeKey: `${WIN_CADENCE_SUMMARY_DEDUPE_PREFIX}${stamp}:${lead.userId}`,
            metadata: {
              weekStart: closedIso,
              weekStamp: stamp,
              missedUserIds: missed.map((m) => m.userId),
            },
          });
          ledger.add(ledgerKey);
          summarizedLeadIds.push(lead.userId);
        } catch (err: any) {
          failedUserIds.push(lead.userId);
          console.warn(
            `[winCadence] lead summary failed for user ${lead.userId}: ${err?.message ?? err}`,
          );
        }
      }
    }

    const complete = failedUserIds.length === 0;
    await deps.upsertState({
      state: "healthy",
      failureType: "win_cadence",
      lastNotifiedAt: nudgedUserIds.length + summarizedLeadIds.length > 0 ? now : undefined,
      metadataJson: {
        // Completed stamp advances ONLY when every recipient succeeded —
        // otherwise the in-flight ledger keeps the week open for retry.
        completedWeekStart: complete ? closedIso : (meta.completedWeekStart ?? null),
        ledgerWeekStart: closedIso,
        ledger: Array.from(ledger),
        missedCount: missed.length,
        lastEvaluatedAt: now.toISOString(),
      },
    });

    if (nudgedUserIds.length > 0 || summarizedLeadIds.length > 0) {
      console.log(
        `[winCadence] week ${stamp}: ${missed.length} AM(s) missed target — ` +
          `nudged ${nudgedUserIds.length}, summarized to ${summarizedLeadIds.length} lead(s)` +
          (failedUserIds.length ? `, ${failedUserIds.length} failed (will retry)` : ""),
      );
    }

    return {
      closedWeekStart: closedIso,
      alreadyComplete: false,
      missedUserIds: missed.map((m) => m.userId),
      nudgedUserIds,
      summarizedLeadIds,
      failedUserIds,
    };
  } catch (err: any) {
    console.warn(`[winCadence] evaluation failed: ${err?.message ?? err}`);
    return null;
  }
}

/** One guarded evaluator pass — exported directly for tests (inject
 *  `acquireEvaluatorLock` via the deps seam). Returns null when a sibling
 *  instance holds the lock or the pass failed; never throws/rejects. */
export async function runWinCadenceNudgePassOnce(
  opts: { now?: Date } = {},
): Promise<WinCadenceEvaluationResult | null> {
  let lock: { release: () => Promise<void> } | null = null;
  try {
    lock = await deps.acquireEvaluatorLock();
    if (!lock) return null; // another instance owns this pass
    return await runWithWorkerDb(() =>
      withDbAttribution("scheduler:win-cadence-nudge", () =>
        evaluateWinCadence(opts.now ?? new Date()),
      ),
    );
  } catch (err: any) {
    console.warn(`[winCadence] periodic pass failed: ${err?.message ?? err}`);
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
export function startWinCadenceNudgeScheduler(): void {
  if (process.env.NODE_ENV === "test" || process.env.TEST_SMOKE) {
    console.log("[winCadence] test env — periodic evaluator disabled");
    return;
  }
  if (evaluatorTimer) return;
  evaluatorTimer = setInterval(() => {
    // fire-and-forget: the pass logs its own failures and never rejects.
    void runWinCadenceNudgePassOnce();
  }, WIN_CADENCE_EVALUATOR_INTERVAL_MS);
  evaluatorTimer.unref?.();
  // First pass immediately (boot is already staggered by the scheduler
  // offsets) so a Monday restart can't defer the nudge another 6h.
  void runWinCadenceNudgePassOnce();
}

export function stopWinCadenceNudgeScheduler(): void {
  if (evaluatorTimer) clearInterval(evaluatorTimer);
  evaluatorTimer = null;
}

// ── Test seams (ESM live-binding workaround, slackOutageDetector pattern) ───

export function __setWinCadenceDepsForTest(
  overrides: Partial<WinCadenceDeps>,
): void {
  deps = { ...deps, ...overrides };
}

export function __resetWinCadenceDepsForTest(): void {
  deps = { ...defaultDeps };
}

registerModuleStateResetForTest("winCadenceNudge", () => {
  stopWinCadenceNudgeScheduler();
  __resetWinCadenceDepsForTest();
});
