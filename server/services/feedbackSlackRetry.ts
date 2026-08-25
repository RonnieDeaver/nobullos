// @db-pool-intent: worker
// @cross-instance-safe: scheduler tick is enqueue-only — enqueues a dedupe-keyed feedback_slack_retry work_queue job; the runFeedbackSlackRetryTick handler runs once per claim.
//
// The candidate SELECT and the per-row `recordFeedbackSlackResult`
// write both resolve their handle via `getDb()`. The only caller of
// `runFeedbackSlackRetryTick()` is the `feedback_slack_retry` work-queue
// handler, which wraps it in `runWithWorkerDb(...)` so `getDb()`
// resolves to the worker pool.
/**
 * Task #2066 — Automatically re-send feedback that failed to reach
 * Slack once it reconnects.
 *
 * Task #2064 made feedback → Slack relay failures visible (per-row
 * `slack_status` / `slack_reason`) and added a manual "Retry Slack"
 * button. But a row left in `pending` / `failed` / `not_connected`
 * still needs a human to notice and press retry. This module closes
 * that loop: a bounded, default-OFF, worker-pool scheduler that
 * periodically re-drives un-delivered feedback rows through the *shared*
 * relay (`relayFeedbackToSlack` + `recordFeedbackSlackResult` in
 * `feedbackSlackRelay.ts`) — the same path the routes use — and updates
 * each row's status + reason in place.
 *
 * Connectivity gate. The tick first runs a single `probeConnection()`
 * (active `auth.test`). If Slack is unauthorized or unreachable the
 * whole pass no-ops with a reason, so we never iterate the backlog (and
 * never hammer Slack with N posts) while it is down. Only once Slack is
 * reachable does the tick fan out, and the per-row relay re-checks
 * connectivity itself, so a mid-pass disconnect is still classified
 * correctly.
 *
 * Bounding + backoff. Each tick processes at most `maxPerTick` rows and
 * only considers rows whose last attempt (`slack_updated_at`) is older
 * than `backoffMinutes` (or never attempted). That backoff stops the
 * scheduler from re-posting the same just-attempted rows on every tick
 * and avoids racing the inline relay that runs on submit.
 *
 * Gating (default OFF — opt-in because the tick performs real Slack
 * posts, not just measurement):
 *   1. `feedback_slack_retry_enabled` system setting (master switch).
 *   2. `feedback_slack_retry` queue-drain pause.
 *   3. `KILL_SWITCH_NON_CRITICAL_SWEEPS`.
 *   4. A live `probeConnection()` connectivity check.
 */
import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { PERF } from "../perfConfig";
import { isQueuePaused } from "./queueDrainControl";
import { probeConnection as probeSlackConnection } from "./slackIntegration";
import {
  relayFeedbackToSlack,
  recordFeedbackSlackResult,
  markFeedbackSlackUndeliverable,
  type FeedbackSlackResult,
} from "./feedbackSlackRelay";

export const QUEUE_NAME = "feedback_slack_retry";

/**
 * Task #2783 — defensive guard against synthetic test rows leaking to the
 * real Slack channel. Any `user_feedback` row seeded by a test that is not
 * itself exercising this scheduler's candidate-selection logic (e.g. the
 * video-processing and relay-outcome tests) should stamp this exact marker
 * into `slack_reason` so it is excluded from candidate selection here even
 * if a future edit forgets to also insert it with a terminal `slack_status`.
 * Deliberately NOT used by `tests/feedback-slack-retry.test.ts`, which
 * intentionally seeds non-terminal rows under a mocked-Slack, in-process
 * call to THIS tick to test candidate selection itself — marking those
 * rows here would make the scheduler unable to see its own test fixtures.
 * That suite instead relies on a stable synthetic user id that gets pruned
 * at the start of every case (see its `step()` helper).
 */
export const SYNTHETIC_FEEDBACK_TEST_MARKER = "[synthetic-test-row:no-slack]";
const SYNTHETIC_FEEDBACK_TEST_MARKER_LIKE = `%${SYNTHETIC_FEEDBACK_TEST_MARKER}%`;

/** Master enable switch. Default OFF — opt-in because the tick performs
 * real Slack `chat.postMessage` posts, not just measurement. */
export const SETTING_ENABLED = "feedback_slack_retry_enabled";

/** Per-tick budget: how many un-delivered feedback rows to re-drive per
 * tick so a large backlog can never fan out an unbounded number of
 * Slack posts in a single pass. Bounded 1..MAX. */
export const SETTING_MAX_PER_TICK = "feedback_slack_retry_max_per_tick";

/** Backoff window: a row is only re-driven if its last relay attempt
 * (`slack_updated_at`) is older than this many minutes (or it has never
 * been attempted). Prevents re-posting the same just-attempted rows on
 * every tick and avoids racing the inline submit relay. */
export const SETTING_BACKOFF_MINUTES = "feedback_slack_retry_backoff_minutes";

/** Persisted JSON summary of the most recent tick so operators get a
 * live readout of what the retry last did (and why) without scraping
 * worker logs. */
export const SETTING_LAST_RUN = "feedback_slack_retry_last_run";

/** Task #2131 — give-up threshold by attempt count. Once a row has failed
 * to reach Slack this many times, the next tick marks it terminally
 * `undeliverable` (stops retrying) and escalates to responsible admins.
 * Default 10, bounded 1..MAX. */
export const SETTING_MAX_ATTEMPTS = "feedback_slack_retry_max_attempts";

/** Task #2131 — give-up threshold by age. A still-undelivered row older
 * than this many hours (since `created_at`) is marked terminally
 * `undeliverable` even if it has not yet hit `max_attempts` (e.g. a row
 * that only got a few attempts because Slack was down for a long stretch).
 * Default 48h, bounded 1..MAX. */
export const SETTING_MAX_STUCK_HOURS = "feedback_slack_retry_max_stuck_hours";

const DEFAULT_MAX_PER_TICK = 25;
export const MAX_PER_TICK_CAP = 200;
const DEFAULT_BACKOFF_MINUTES = 15;
export const BACKOFF_MINUTES_CAP = 24 * 60;
const DEFAULT_MAX_ATTEMPTS = 10;
const MAX_ATTEMPTS_CAP = 100;
const DEFAULT_MAX_STUCK_HOURS = 48;
const MAX_STUCK_HOURS_CAP = 24 * 30; // 30 days

export const TICK_INTERVAL_MS = Number(
  process.env.FEEDBACK_SLACK_RETRY_INTERVAL_MS || 10 * 60_000,
);

let interval: ReturnType<typeof setInterval> | null = null;

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

async function loadMaxPerTick(): Promise<number> {
  const raw = (await getSystemSetting(SETTING_MAX_PER_TICK).catch(() => null))
    ?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_PER_TICK;
  return Math.min(MAX_PER_TICK_CAP, Math.floor(n));
}

async function loadBackoffMinutes(): Promise<number> {
  const raw = (await getSystemSetting(SETTING_BACKOFF_MINUTES).catch(() => null))
    ?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_BACKOFF_MINUTES;
  return Math.min(BACKOFF_MINUTES_CAP, Math.floor(n));
}

async function loadMaxAttempts(): Promise<number> {
  const raw = (await getSystemSetting(SETTING_MAX_ATTEMPTS).catch(() => null))
    ?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_ATTEMPTS;
  return Math.min(MAX_ATTEMPTS_CAP, Math.floor(n));
}

async function loadMaxStuckHours(): Promise<number> {
  const raw = (await getSystemSetting(SETTING_MAX_STUCK_HOURS).catch(() => null))
    ?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_STUCK_HOURS;
  return Math.min(MAX_STUCK_HOURS_CAP, Math.floor(n));
}

export interface FeedbackSlackRetryConfig {
  enabled: boolean;
  maxPerTick: number;
  backoffMinutes: number;
  maxAttempts: number;
  maxStuckHours: number;
  tickIntervalMinutes: number;
}

/**
 * Read the current retry config (master switch + bounding knobs) so an
 * operator surface can show what the scheduler will do on its next tick
 * without scraping `system_settings`.
 */
export async function getFeedbackSlackRetryConfig(): Promise<FeedbackSlackRetryConfig> {
  const [enabled, maxPerTick, backoffMinutes, maxAttempts, maxStuckHours] =
    await Promise.all([
      Promise.resolve(
        parseBool(
          (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
          false,
        ),
      ),
      loadMaxPerTick(),
      loadBackoffMinutes(),
      loadMaxAttempts(),
      loadMaxStuckHours(),
    ]);
  return {
    enabled,
    maxPerTick,
    backoffMinutes,
    maxAttempts,
    maxStuckHours,
    tickIntervalMinutes: TICK_INTERVAL_MS / 60_000,
  };
}

export type FeedbackRetryOutcome =
  | "delivered"
  | "failed"
  | "not_connected"
  | "pending"
  | "undeliverable"
  | "error";

export interface FeedbackRetryAttempt {
  feedbackId: number;
  outcome: FeedbackRetryOutcome;
  reason: string | null;
}

export interface FeedbackSlackRetryTickResult {
  ranAt: string;
  enabled: boolean;
  paused: boolean;
  connected: boolean;
  maxPerTick: number;
  backoffMinutes: number;
  maxAttempts: number;
  maxStuckHours: number;
  /** Un-delivered rows eligible (past the backoff window) at scan time. */
  candidates: number;
  attempted: FeedbackRetryAttempt[];
  delivered: number;
  stillFailed: number;
  /** Task #2131 — rows that hit the give-up threshold this tick and were
   * marked terminally `undeliverable` (and escalated to admins). These
   * stop counting toward the live retry budget on the next tick. */
  escalated: number;
  errors: number;
  reason?: string;
}

async function persistLastRun(
  result: FeedbackSlackRetryTickResult,
): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(result));
  } catch (err: any) {
    console.warn(
      `[FeedbackSlackRetry] Failed to persist last-run summary: ${
        err?.message ?? err
      }`,
    );
  }
}

/**
 * Why the last-run summary could not be returned as a parsed object:
 *   - "ok"         — a well-formed summary was read.
 *   - "never_run"  — the key is absent/empty; normal on a fresh deploy.
 *   - "unreadable" — the stored value (or the settings read itself)
 *     failed to produce a summary; signals a real persistence bug, not
 *     a fresh deploy.
 */
export type LastFeedbackSlackRetryRunStatus = "ok" | "never_run" | "unreadable";

export interface LastFeedbackSlackRetryRunRead {
  /** The parsed summary, or null when status is not "ok". */
  lastRun: FeedbackSlackRetryTickResult | null;
  status: LastFeedbackSlackRetryRunStatus;
  /** Plain-English reason present only when status === "unreadable". */
  error?: string;
}

/**
 * Read the persisted last-run summary and classify the outcome so the
 * operator status route can tell "never ran" (normal) apart from
 * "stored value was unreadable" (a persistence regression). Never
 * throws — a settings-read failure is reported as `unreadable` with the
 * error message rather than masquerading as `never_run`.
 */
export async function readLastFeedbackSlackRetryRun(): Promise<LastFeedbackSlackRetryRunRead> {
  let raw: string | undefined;
  try {
    const row = await getSystemSetting(SETTING_LAST_RUN);
    raw = row?.value?.trim();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[FeedbackSlackRetry] Failed to read last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }

  if (!raw) return { lastRun: null, status: "never_run" };

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { lastRun: parsed as FeedbackSlackRetryTickResult, status: "ok" };
    }
    const message = "stored last-run value was not a JSON object";
    console.warn(`[FeedbackSlackRetry] ${message}`);
    return { lastRun: null, status: "unreadable", error: message };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[FeedbackSlackRetry] Failed to parse last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }
}

/**
 * Read the persisted last-run summary, or null if the retry has not run
 * yet (or the stored value is unparseable). Thin back-compat wrapper over
 * {@link readLastFeedbackSlackRetryRun} that preserves the original
 * "null for both never-run and unreadable" contract.
 */
export async function getLastFeedbackSlackRetryRun(): Promise<FeedbackSlackRetryTickResult | null> {
  return (await readLastFeedbackSlackRetryRun()).lastRun;
}

interface CandidateRow {
  id: number;
  topic: string;
  userName: string;
  feedbackText: string;
  page: string | null;
  screenshotCount: number;
  /** Non-delivered relay attempts so far (Task #2131 give-up counter). */
  attempts: number;
  /** Row creation time — drives the M-hours-stuck give-up branch. */
  createdAt: Date | null;
}

/**
 * Task #2131 — escalate a batch of newly-undeliverable feedback to the
 * responsible admins (CEO / team_lead) via the in-app inbox so a human
 * re-auths Slack / fixes the channel. A single deduped notification per
 * admin per tick (stable dedupeKey) collapses while unread, so a long
 * outage that terminalizes many rows over many ticks does not flood the
 * bell. Worker-context call (`source: "worker:..."`) so it lands on the
 * worker pool under the tenancy switch. Best-effort — a notification
 * failure never blocks the give-up transition (the admin surface already
 * shows the `undeliverable` rows regardless).
 */
async function escalateUndeliverable(
  count: number,
  sampleReason: string | null,
): Promise<void> {
  if (count <= 0) return;
  try {
    const { getResponsibleAdminsForAlert } = await import(
      "./notifications/recipients"
    );
    const { notifyUser } = await import("./notifications/userInbox");
    const admins = await getResponsibleAdminsForAlert();
    if (admins.length === 0) {
      console.warn(
        "[FeedbackSlackRetry] no responsible admins to escalate undeliverable feedback to",
      );
      return;
    }
    const detail = sampleReason ? ` (${sampleReason})` : "";
    const body =
      `${count} feedback item${count > 1 ? "s" : ""} could not be delivered to Slack ` +
      `after repeated retries${detail}. Re-auth Slack or fix the channel, then ` +
      `re-send from the feedback admin page.`;
    for (const uid of admins) {
      await notifyUser(
        uid,
        {
          category: "feedback",
          title: "Feedback can't reach Slack",
          body,
          deepLink: "/admin/feedback",
          dedupeKey: "feedback-slack-undeliverable",
          metadata: { undeliverableThisTick: count },
        },
        { source: "worker:feedbackSlackRetry" },
      );
    }
  } catch (err: any) {
    console.warn(
      `[FeedbackSlackRetry] escalation fan-out failed: ${err?.message ?? err}`,
    );
  }
}

/**
 * Task #2131 — disconnected-path give-up sweep. When Slack can't be reached
 * at all (revoked token / unreachable), we never attempt a send, but rows
 * that have been stuck past the max-age threshold since `created_at` are
 * marked terminal `undeliverable` so a permanently broken Slack can't strand
 * feedback forever. Bounded by the per-tick budget, oldest-first. Returns
 * the rows it gave up on so the caller can escalate + report them.
 */
async function sweepStuckGiveUps(args: {
  now: Date;
  maxStuckHours: number;
  maxPerTick: number;
  disconnectedReason: string;
}): Promise<{
  count: number;
  attempted: FeedbackRetryAttempt[];
  lastReason: string | null;
}> {
  const { now, maxStuckHours, maxPerTick, disconnectedReason } = args;
  const rows = await withDbAttribution(
    "feedbackSlackRetry:selectStuckGiveUps",
    async () => {
      const res = await getDb().execute(sql`
        SELECT id, created_at
        FROM user_feedback
        WHERE slack_status NOT IN ('delivered', 'undeliverable')
          AND created_at IS NOT NULL
          AND created_at < now() - (${maxStuckHours} * interval '1 hour')
          AND (slack_reason IS NULL OR slack_reason NOT LIKE ${SYNTHETIC_FEEDBACK_TEST_MARKER_LIKE})
        ORDER BY created_at ASC NULLS LAST, id ASC
        LIMIT ${maxPerTick}
      `);
      return (res.rows ?? []).map((row: any) => ({
        id: Number(row.id),
        createdAt: row.created_at != null ? new Date(row.created_at) : null,
      }));
    },
  );

  const attempted: FeedbackRetryAttempt[] = [];
  let lastReason: string | null = null;
  for (const row of rows) {
    const ageHours = row.createdAt
      ? (now.getTime() - row.createdAt.getTime()) / 3_600_000
      : maxStuckHours;
    const terminalReason =
      `Gave up after stuck ${Math.floor(ageHours)}h — Slack disconnected (${disconnectedReason})`.slice(
        0,
        300,
      );
    await markFeedbackSlackUndeliverable(row.id, terminalReason);
    attempted.push({
      feedbackId: row.id,
      outcome: "undeliverable",
      reason: terminalReason,
    });
    lastReason = disconnectedReason;
  }
  return { count: attempted.length, attempted, lastReason };
}

/**
 * One retry pass. Re-drives un-delivered feedback rows (past the backoff
 * window) through the shared relay, bounded by the per-tick budget, but
 * only when Slack is reachable. Never throws on a per-row failure — the
 * next tick retries. Persists the summary as the last-run readout.
 */
export async function runFeedbackSlackRetryTick(opts?: {
  now?: Date;
}): Promise<FeedbackSlackRetryTickResult> {
  const result = await computeFeedbackSlackRetryTick(opts);
  await persistLastRun(result);
  return result;
}

async function computeFeedbackSlackRetryTick(opts?: {
  now?: Date;
}): Promise<FeedbackSlackRetryTickResult> {
  const now = opts?.now ?? new Date();
  const enabled = parseBool(
    (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
    false,
  );
  const paused = isQueuePaused(QUEUE_NAME);
  const maxPerTick = await loadMaxPerTick();
  const backoffMinutes = await loadBackoffMinutes();
  const maxAttempts = await loadMaxAttempts();
  const maxStuckHours = await loadMaxStuckHours();
  const result: FeedbackSlackRetryTickResult = {
    ranAt: now.toISOString(),
    enabled,
    paused,
    connected: false,
    maxPerTick,
    backoffMinutes,
    maxAttempts,
    maxStuckHours,
    candidates: 0,
    attempted: [],
    delivered: 0,
    stillFailed: 0,
    escalated: 0,
    errors: 0,
  };

  if (!enabled) {
    result.reason = "retry disabled in system_settings";
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

  // Connectivity gate — a single active probe so we never iterate the
  // backlog (and never hammer Slack) while it is down.
  const probe = await probeSlackConnection();
  result.connected = probe.outcome === "connected";
  if (!result.connected) {
    // Slack is down. We deliberately do NOT attempt any sends here (never
    // hammer a dead/unreachable Slack). But a permanently broken Slack —
    // e.g. a revoked token that never re-auths — must not strand feedback
    // in `failed`/`not_connected` forever. Task #2131: even while
    // disconnected, give up on rows stuck past the max-age threshold and
    // escalate, so the "M hours stuck" guarantee still holds when the
    // breakage is exactly that Slack can't be reached at all.
    const probeReason =
      probe.outcome === "unauthorized"
        ? probe.reason ?? "unauthorized"
        : probe.reason ?? "probe_failed";
    const gaveUp = await sweepStuckGiveUps({
      now,
      maxStuckHours,
      maxPerTick,
      disconnectedReason: probeReason,
    });
    result.candidates = gaveUp.count;
    for (const a of gaveUp.attempted) result.attempted.push(a);
    result.escalated += gaveUp.count;
    if (gaveUp.count > 0) {
      await escalateUndeliverable(gaveUp.count, gaveUp.lastReason);
    }
    const base =
      probe.outcome === "unauthorized"
        ? `Slack not connected (${probeReason}) — waiting for re-auth`
        : `Slack unreachable (${probeReason}) — will retry next tick`;
    result.reason =
      gaveUp.count > 0
        ? `${base}; gave up on ${gaveUp.count} stuck row(s) past ${maxStuckHours}h and escalated`
        : base;
    return result;
  }

  // Eligible = NOT terminal (delivered or undeliverable) AND (never
  // attempted OR last attempt older than the backoff window). Excluding
  // `undeliverable` (Task #2131) is what makes given-up rows stop counting
  // toward the live retry budget — they are never selected again, so the
  // per-tick budget is spent only on rows that can still make progress.
  // Bounded by the per-tick budget, oldest attempt first so a long-stuck
  // row is not starved by newer ones.
  const candidates = await withDbAttribution(
    "feedbackSlackRetry:selectCandidates",
    async () => {
      const res = await getDb().execute(sql`
        SELECT id, topic, user_name, feedback_text, current_page, screenshots,
               slack_attempts, created_at
        FROM user_feedback
        WHERE slack_status NOT IN ('delivered', 'undeliverable')
          AND (
            slack_updated_at IS NULL
            OR slack_updated_at < now() - (${backoffMinutes} * interval '1 minute')
          )
          AND (slack_reason IS NULL OR slack_reason NOT LIKE ${SYNTHETIC_FEEDBACK_TEST_MARKER_LIKE})
        ORDER BY slack_updated_at ASC NULLS FIRST, id ASC
        LIMIT ${maxPerTick}
      `);
      return (res.rows ?? []).map((row: any): CandidateRow => {
        let screenshotCount = 0;
        try {
          const parsed = JSON.parse(String(row.screenshots ?? "[]"));
          if (Array.isArray(parsed)) screenshotCount = parsed.length;
        } catch {
          screenshotCount = 0;
        }
        const attemptsRaw = Number(row.slack_attempts);
        return {
          id: Number(row.id),
          topic: String(row.topic ?? "OTHER"),
          userName: String(row.user_name ?? "Unknown"),
          feedbackText: String(row.feedback_text ?? ""),
          page: row.current_page != null ? String(row.current_page) : null,
          screenshotCount,
          attempts: Number.isFinite(attemptsRaw) ? attemptsRaw : 0,
          createdAt: row.created_at != null ? new Date(row.created_at) : null,
        };
      });
    },
  );

  result.candidates = candidates.length;
  if (candidates.length === 0) {
    result.reason = "no un-delivered feedback rows past the backoff window";
    return result;
  }

  let lastEscalationReason: string | null = null;
  for (const row of candidates) {
    let relayResult: FeedbackSlackResult;
    try {
      relayResult = await relayFeedbackToSlack({
        topic: row.topic,
        userName: row.userName,
        page: row.page,
        feedbackText: row.feedbackText,
        screenshotCount: row.screenshotCount,
      });
    } catch (err: any) {
      console.warn(
        `[FeedbackSlackRetry] relay threw for feedback=${row.id}: ${
          err?.message ?? err
        }`,
      );
      result.attempted.push({
        feedbackId: row.id,
        outcome: "error",
        reason: err?.message ? String(err.message).slice(0, 200) : "relay threw",
      });
      result.errors += 1;
      continue;
    }

    if (relayResult.status === "delivered") {
      await recordFeedbackSlackResult(row.id, relayResult);
      result.attempted.push({
        feedbackId: row.id,
        outcome: "delivered",
        reason: relayResult.reason,
      });
      result.delivered += 1;
      continue;
    }

    // Task #2131 — non-delivered. Decide whether this is the attempt that
    // tips the row over the give-up threshold (too many attempts OR stuck
    // too long). `recordFeedbackSlackResult` increments `slack_attempts`,
    // so after this attempt the row will be at `row.attempts + 1`.
    const attemptsAfter = row.attempts + 1;
    const ageHours = row.createdAt
      ? (now.getTime() - row.createdAt.getTime()) / 3_600_000
      : 0;
    const tooManyAttempts = attemptsAfter >= maxAttempts;
    const stuckTooLong = ageHours >= maxStuckHours;

    if (tooManyAttempts || stuckTooLong) {
      const why = tooManyAttempts
        ? `${attemptsAfter} failed attempts`
        : `stuck ${Math.floor(ageHours)}h`;
      const terminalReason =
        `Gave up after ${why} — ${relayResult.reason ?? "still not reaching Slack"}`.slice(
          0,
          300,
        );
      await markFeedbackSlackUndeliverable(row.id, terminalReason);
      result.attempted.push({
        feedbackId: row.id,
        outcome: "undeliverable",
        reason: terminalReason,
      });
      result.escalated += 1;
      lastEscalationReason = relayResult.reason ?? terminalReason;
      continue;
    }

    await recordFeedbackSlackResult(row.id, relayResult);
    result.attempted.push({
      feedbackId: row.id,
      outcome: relayResult.status,
      reason: relayResult.reason,
    });
    result.stillFailed += 1;
  }

  // Task #2131 — one deduped escalation per admin if anything gave up this
  // tick, so a human re-auths Slack / fixes the channel.
  if (result.escalated > 0) {
    await escalateUndeliverable(result.escalated, lastEscalationReason);
  }

  return result;
}

async function enqueueScheduledTick(): Promise<void> {
  try {
    if (isQueuePaused(QUEUE_NAME)) {
      console.log(
        `[FeedbackSlackRetry] enqueue_skipped_queue_paused queue=${QUEUE_NAME} reason=queue_drain_state ts=${new Date().toISOString()}`,
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
      `[FeedbackSlackRetry] enqueue scheduled tick failed: ${
        err?.message ?? err
      }`,
    );
  }
}

export function startFeedbackSlackRetryScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void enqueueScheduledTick();
  }, TICK_INTERVAL_MS);
  console.log(
    `[FeedbackSlackRetry] enqueue scheduler started (every ${
      TICK_INTERVAL_MS / 60_000
    }min; default OFF via ${SETTING_ENABLED}) — work runs in worker pool via ${QUEUE_NAME} queue`,
  );
}

export function stopFeedbackSlackRetryScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __feedbackSlackRetryTestHelpers = {
  enqueueScheduledTick,
  loadMaxPerTick,
  loadBackoffMinutes,
};
