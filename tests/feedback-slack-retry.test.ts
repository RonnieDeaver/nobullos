/* test-registration
{
  "name": "Feedback \u2192 Slack auto-resend scheduler (Task #2074)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2074 — guard the feedback → Slack auto-resend scheduler that
 * Task #2066 added. The tick (`runFeedbackSlackRetryTick`) has several
 * branches that are easy to regress and previously had no automated
 * coverage:
 *
 *   1. Gating no-ops (never select or relay any rows, and write a reason):
 *        - master switch OFF (default)
 *        - queue paused via queue_drain_state
 *        - KILL_SWITCH_NON_CRITICAL_SWEEPS=true
 *        - tick-level probeConnection() reports disconnected
 *          (both `unauthorized` and `probe_failed`)
 *   2. Candidate selection when Slack is reachable:
 *        - only non-delivered rows past the backoff window are selected
 *          (a just-attempted row inside the window is skipped)
 *        - ordered oldest-first (slack_updated_at ASC NULLS FIRST, id ASC)
 *        - bounded by max_per_tick
 *   3. Each selected row is re-driven through the SHARED relay
 *      (`relayFeedbackToSlack`) and its outcome persisted via
 *      `recordFeedbackSlackResult` — both the delivered and the
 *      still-failed classifications land on the `user_feedback` row.
 *
 * Like the Task #2065 relay test, this exercises the REAL service module
 * (`feedbackSlackRetry.ts` → `feedbackSlackRelay.ts` → `slackIntegration.ts`)
 * with `global.fetch` monkey-patched for Slack, so the behavior under
 * test is the production code path — not a re-implemented copy. Feedback
 * rows are written to the live `user_feedback` table under a unique test
 * user id and cleaned up at the end.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { PERF } from "../server/perfConfig";
import {
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import {
  setQueuePause,
  _resetQueueDrainStateForTests,
} from "../server/services/queueDrainControl";
import {
  __resetSlackAuthBreakerForTest,
} from "../server/services/slackIntegration";
import {
  __resetFeedbackSlackStateForTest,
} from "../server/services/feedbackSlackRelay";
import {
  runFeedbackSlackRetryTick,
  QUEUE_NAME,
  SETTING_ENABLED,
  SETTING_MAX_PER_TICK,
  SETTING_BACKOFF_MINUTES,
  SETTING_MAX_ATTEMPTS,
  SETTING_MAX_STUCK_HOURS,
  SYNTHETIC_FEEDBACK_TEST_MARKER,
} from "../server/services/feedbackSlackRetry";

const TEST_USER_ID = "task-2074-feedback-slack-retry-test";
// Task #2131 — a dedicated admin (team_lead) so the give-up escalation has
// a deterministic recipient to assert against, plus the stable dedupeKey
// the escalation uses so we can clean up after ourselves.
const TEST_ADMIN_ID = "task-2131-feedback-escalation-admin";
const ESCALATION_DEDUPE_KEY = "feedback-slack-undeliverable";
const SLACK_TOKEN_KEY = "slack_bot_token";

const originalFetch: typeof fetch = global.fetch;
let originalSlackBotToken: string | null | undefined;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Per-endpoint Slack handlers, overridable per test case. Defaults model
// the happy path (token valid, channel found, message posted).
type SlackHandler = () => Response | Promise<Response>;
interface SlackRoutes {
  authTest: SlackHandler;
  conversationsList: SlackHandler;
  lookupByEmail: SlackHandler;
  postMessage: SlackHandler;
}

const DEFAULT_ROUTES: SlackRoutes = {
  authTest: () =>
    jsonResponse({ ok: true, team: "Acme", user: "U1", team_id: "T1" }),
  conversationsList: () =>
    jsonResponse({
      ok: true,
      channels: [
        { id: "C_RONNIE", name: "ronnie-thought-stream", is_member: true },
      ],
    }),
  lookupByEmail: () => jsonResponse({ ok: true, user: { id: "U_RONNIE" } }),
  postMessage: () => jsonResponse({ ok: true }),
};

let routes: SlackRoutes = { ...DEFAULT_ROUTES };

global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input))
    return __makeUpstashPassthroughResponse(input, init);
  const url =
    typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.includes("slack.com/api/auth.test")) return routes.authTest();
  if (url.includes("slack.com/api/conversations.list"))
    return routes.conversationsList();
  if (url.includes("slack.com/api/users.lookupByEmail"))
    return routes.lookupByEmail();
  if (url.includes("slack.com/api/chat.postMessage")) return routes.postMessage();
  if (url.includes("slack.com/api")) return jsonResponse({ ok: true });
  return originalFetch(input as any, init);
}) as any;

/**
 * Seed one feedback row. `slackStatus` defaults to a non-delivered state
 * so the row is a retry candidate; `updatedMinutesAgo === null` leaves
 * `slack_updated_at` NULL (never attempted), otherwise it is set that
 * many minutes in the past.
 */
async function seedFeedbackRow(opts: {
  slackStatus?: string;
  updatedMinutesAgo: number | null;
  // Task #2131 — control the give-up thresholds:
  //   attempts        → seeds slack_attempts (defaults 0)
  //   createdHoursAgo → seeds created_at that many hours in the past
  attempts?: number;
  createdHoursAgo?: number;
}): Promise<number> {
  const status = opts.slackStatus ?? "failed";
  const updatedAt =
    opts.updatedMinutesAgo == null
      ? sql`NULL`
      : sql`now() - (${opts.updatedMinutesAgo} * interval '1 minute')`;
  const attempts = opts.attempts ?? 0;
  const createdAt =
    opts.createdHoursAgo == null
      ? sql`now()`
      : sql`now() - (${opts.createdHoursAgo} * interval '1 hour')`;
  const r = await db.execute(sql`
    INSERT INTO user_feedback
      (user_id, user_name, topic, feedback_text, current_page, screenshots,
       slack_status, slack_reason, slack_updated_at, slack_attempts, created_at)
    VALUES
      (${TEST_USER_ID}, 'Tester', 'BUG_REPORT', 'Something is broken',
       '/some/page', '[]', ${status}, 'seed reason', ${updatedAt}, ${attempts}, ${createdAt})
    RETURNING id
  `);
  const id = (r.rows?.[0] as any)?.id;
  assert.ok(id != null, "insert should return a feedback row id");
  return Number(id);
}

async function readRow(
  id: number,
): Promise<{
  slack_status: string;
  slack_reason: string | null;
  updated_at: any;
  slack_attempts: number;
}> {
  const r = await db.execute(sql`
    SELECT slack_status, slack_reason, slack_updated_at, slack_attempts
    FROM user_feedback WHERE id = ${id}
  `);
  const row = r.rows?.[0] as any;
  assert.ok(row, `feedback row ${id} should exist`);
  return {
    slack_status: String(row.slack_status),
    slack_reason: row.slack_reason ?? null,
    updated_at: row.slack_updated_at ?? null,
    slack_attempts: Number(row.slack_attempts ?? 0),
  };
}

async function cleanupRows(): Promise<void> {
  await db.execute(sql`DELETE FROM user_feedback WHERE user_id = ${TEST_USER_ID}`);
}

// Task #2131 — the give-up escalation fans out a notifyUser() to every
// responsible admin in the dev DB under a stable dedupeKey. Remove those
// rows (and our seeded admin) so the test does not pollute real inboxes.
async function cleanupEscalation(): Promise<void> {
  await db
    .execute(
      sql`DELETE FROM user_notifications WHERE dedupe_key = ${ESCALATION_DEDUPE_KEY}`,
    )
    .catch(() => {});
}

async function seedAdminUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, role, authority_level)
    VALUES (${TEST_ADMIN_ID}, ${`${TEST_ADMIN_ID}@example.test`}, 'team_lead', 'core')
    ON CONFLICT (id) DO UPDATE SET role = 'team_lead'
  `);
}

async function cleanupAdminUser(): Promise<void> {
  // user_notifications FK is ON DELETE CASCADE, so this clears its inbox too.
  await db
    .execute(sql`DELETE FROM users WHERE id = ${TEST_ADMIN_ID}`)
    .catch(() => {});
}

async function resetSettings(): Promise<void> {
  await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
  await deleteSystemSetting(SETTING_MAX_PER_TICK).catch(() => {});
  await deleteSystemSetting(SETTING_BACKOFF_MINUTES).catch(() => {});
  await deleteSystemSetting(SETTING_MAX_ATTEMPTS).catch(() => {});
  await deleteSystemSetting(SETTING_MAX_STUCK_HOURS).catch(() => {});
  _resetQueueDrainStateForTests();
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  // Fresh breaker + relay channel cache + default Slack handlers + a
  // clean slate of settings/queue-pause per case.
  __resetSlackAuthBreakerForTest();
  __resetFeedbackSlackStateForTest();
  routes = { ...DEFAULT_ROUTES };
  await resetSettings();
  await cleanupRows();
  await cleanupEscalation();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    __resetSlackAuthBreakerForTest();
    __resetFeedbackSlackStateForTest();
    routes = { ...DEFAULT_ROUTES };
    await resetSettings();
    await cleanupRows();
    await cleanupEscalation();
  }
}

async function main(): Promise<void> {
  console.log("Feedback → Slack auto-resend scheduler (Task #2074)");

  const prior = await storage.getSystemSetting(SLACK_TOKEN_KEY).catch(() => null);
  originalSlackBotToken = prior ? prior.value ?? null : undefined;
  // A non-empty token so probeConnection actually probes (auth.test)
  // instead of short-circuiting to no_token_stored.
  await storage.setSystemSetting(SLACK_TOKEN_KEY, "xoxb-task-2074-fake", "system");

  // Task #2131 — a deterministic admin recipient for the give-up escalation.
  await seedAdminUser();

  // ── (1a) disabled by default → no-op, no select, no relay ────────────
  await step("disabled by default: no-op with reason, row untouched", async () => {
    // SETTING_ENABLED is deleted by resetSettings → default OFF.
    const id = await seedFeedbackRow({ updatedMinutesAgo: null });
    const r = await runFeedbackSlackRetryTick();
    assert.equal(r.enabled, false, "tick reports disabled");
    assert.equal(r.candidates, 0, "no candidates selected while disabled");
    assert.equal(r.attempted.length, 0, "no rows relayed while disabled");
    assert.match(r.reason ?? "", /disabled/i);
    const row = await readRow(id);
    assert.equal(row.slack_status, "failed", "row status untouched");
    assert.equal(row.updated_at, null, "slack_updated_at untouched (still NULL)");
  });

  // ── (1b) queue paused → no-op, no select, no relay ───────────────────
  await step("queue paused: no-op with reason, row untouched", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setQueuePause(QUEUE_NAME, true, "task-2074-test");
    const id = await seedFeedbackRow({ updatedMinutesAgo: null });
    const r = await runFeedbackSlackRetryTick();
    assert.equal(r.paused, true, "tick reports paused");
    assert.equal(r.candidates, 0, "no candidates selected while paused");
    assert.equal(r.attempted.length, 0, "no rows relayed while paused");
    assert.match(r.reason ?? "", /paused/i);
    const row = await readRow(id);
    assert.equal(row.slack_status, "failed", "row status untouched");
    assert.equal(row.updated_at, null, "slack_updated_at untouched");
  });

  // ── (1c) KILL_SWITCH_NON_CRITICAL_SWEEPS → no-op ─────────────────────
  await step("kill switch: no-op with reason, row untouched", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    const id = await seedFeedbackRow({ updatedMinutesAgo: null });
    const priorKill = PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS;
    (PERF as any).KILL_SWITCH_NON_CRITICAL_SWEEPS = true;
    try {
      const r = await runFeedbackSlackRetryTick();
      assert.equal(r.candidates, 0, "no candidates selected while killed");
      assert.equal(r.attempted.length, 0, "no rows relayed while killed");
      assert.match(r.reason ?? "", /KILL_SWITCH_NON_CRITICAL_SWEEPS/);
      const row = await readRow(id);
      assert.equal(row.slack_status, "failed", "row status untouched");
      assert.equal(row.updated_at, null, "slack_updated_at untouched");
    } finally {
      (PERF as any).KILL_SWITCH_NON_CRITICAL_SWEEPS = priorKill;
    }
  });

  // ── (1d) probeConnection unauthorized → no-op (waiting for re-auth) ──
  await step("probe unauthorized: no-op, no relay, row untouched", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    routes.authTest = () => jsonResponse({ ok: false, error: "invalid_auth" });
    const id = await seedFeedbackRow({ updatedMinutesAgo: null });
    const r = await runFeedbackSlackRetryTick();
    assert.equal(r.connected, false, "tick reports not connected");
    assert.equal(r.candidates, 0, "no candidates selected while down");
    assert.equal(r.attempted.length, 0, "no rows relayed while down");
    assert.match(r.reason ?? "", /not connected/i);
    const row = await readRow(id);
    assert.equal(row.slack_status, "failed", "row status untouched");
    assert.equal(row.updated_at, null, "slack_updated_at untouched");
  });

  // ── (1e) probeConnection probe_failed (transient) → no-op ────────────
  await step("probe unreachable: no-op, no relay, row untouched", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    // Non-terminal slack error → probe_failed (transient/unreachable).
    routes.authTest = () => jsonResponse({ ok: false, error: "internal_error" });
    const id = await seedFeedbackRow({ updatedMinutesAgo: null });
    const r = await runFeedbackSlackRetryTick();
    assert.equal(r.connected, false, "tick reports not connected");
    assert.equal(r.candidates, 0, "no candidates selected while unreachable");
    assert.equal(r.attempted.length, 0, "no rows relayed while unreachable");
    assert.match(r.reason ?? "", /unreachable/i);
    const row = await readRow(id);
    assert.equal(row.slack_status, "failed", "row status untouched");
    assert.equal(row.updated_at, null, "slack_updated_at untouched");
  });

  // ── (2a) backoff window: only past-window rows are selected ──────────
  await step("backoff window: just-attempted row inside the window is skipped", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_BACKOFF_MINUTES, "15");
    // Inside the 15-min window → must be skipped.
    const recentId = await seedFeedbackRow({ updatedMinutesAgo: 5 });
    // Past the window → must be selected.
    const staleId = await seedFeedbackRow({ updatedMinutesAgo: 60 });
    // Never attempted → must be selected.
    const neverId = await seedFeedbackRow({ updatedMinutesAgo: null });

    const r = await runFeedbackSlackRetryTick();
    assert.equal(r.connected, true, "Slack reachable");
    const attemptedIds = r.attempted.map((a) => a.feedbackId);
    assert.ok(!attemptedIds.includes(recentId), "recent row inside window skipped");
    assert.ok(attemptedIds.includes(staleId), "stale row past window selected");
    assert.ok(attemptedIds.includes(neverId), "never-attempted row selected");

    // The skipped recent row is genuinely untouched (status + reason).
    const recent = await readRow(recentId);
    assert.equal(recent.slack_status, "failed", "skipped row status untouched");
    assert.equal(recent.slack_reason, "seed reason", "skipped row reason untouched");
  });

  // ── (2b) ordering: oldest attempt first (NULLS FIRST, then ASC) ──────
  await step("ordering: candidates processed oldest-first", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_BACKOFF_MINUTES, "5");
    // Insert NEWEST-attempt first to prove ordering is by time, not id.
    const newest = await seedFeedbackRow({ updatedMinutesAgo: 30 });
    const middle = await seedFeedbackRow({ updatedMinutesAgo: 90 });
    const oldest = await seedFeedbackRow({ updatedMinutesAgo: 180 });
    const never = await seedFeedbackRow({ updatedMinutesAgo: null });

    const r = await runFeedbackSlackRetryTick();
    const mineInOrder = r.attempted
      .map((a) => a.feedbackId)
      .filter((id) => [newest, middle, oldest, never].includes(id));
    // NULLS FIRST → never-attempted leads; then ascending slack_updated_at
    // means the longest-ago attempt (oldest) comes before middle, then newest.
    assert.deepEqual(
      mineInOrder,
      [never, oldest, middle, newest],
      "oldest-first ordering (NULLS FIRST, then slack_updated_at ASC)",
    );
  });

  // ── (2c) per-tick budget cap bounds the number of rows ───────────────
  await step("budget: max_per_tick caps the number of rows processed", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_MAX_PER_TICK, "2");
    await setSystemSetting(SETTING_BACKOFF_MINUTES, "0");
    // Three eligible rows but a cap of 2.
    await seedFeedbackRow({ updatedMinutesAgo: 10 });
    await seedFeedbackRow({ updatedMinutesAgo: 20 });
    await seedFeedbackRow({ updatedMinutesAgo: 30 });

    const r = await runFeedbackSlackRetryTick();
    assert.equal(r.maxPerTick, 2, "tick reports the configured cap");
    assert.equal(r.candidates, 2, "candidate scan bounded by max_per_tick");
    assert.equal(r.attempted.length, 2, "at most max_per_tick rows relayed");
  });

  // ── (3a) delivered: row re-driven through the relay and persisted ────
  await step("delivered: selected row re-driven through relay + persisted", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_BACKOFF_MINUTES, "0");
    const id = await seedFeedbackRow({ updatedMinutesAgo: 10 });

    const r = await runFeedbackSlackRetryTick();
    assert.equal(r.connected, true, "Slack reachable");
    const mine = r.attempted.find((a) => a.feedbackId === id);
    assert.ok(mine, "our row was attempted");
    assert.equal(mine!.outcome, "delivered", "relay reports delivered");
    assert.ok(r.delivered >= 1, "delivered counter incremented");

    // recordFeedbackSlackResult persisted the terminal status onto the row.
    const row = await readRow(id);
    assert.equal(row.slack_status, "delivered", "row persisted delivered");
    assert.equal(row.slack_reason, null, "delivered clears the reason");
    assert.notEqual(row.updated_at, null, "slack_updated_at advanced");
  });

  // ── (3b) still-failed: relay failure classified + persisted ──────────
  await step("still-failed: relay failure persisted with plain-English reason", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_BACKOFF_MINUTES, "0");
    // Slack reachable (auth.test ok) but the post is rejected non-terminally.
    routes.postMessage = () => jsonResponse({ ok: false, error: "not_in_channel" });
    const id = await seedFeedbackRow({ updatedMinutesAgo: 10 });

    const r = await runFeedbackSlackRetryTick();
    const mine = r.attempted.find((a) => a.feedbackId === id);
    assert.ok(mine, "our row was attempted");
    assert.equal(mine!.outcome, "failed", "non-terminal post error → failed");
    assert.ok(r.stillFailed >= 1, "stillFailed counter incremented");
    assert.equal(r.delivered, 0, "nothing delivered");

    const row = await readRow(id);
    assert.equal(row.slack_status, "failed", "row persisted failed");
    assert.ok(
      typeof row.slack_reason === "string" && row.slack_reason!.length > 0,
      "failure carries a human-readable reason",
    );
    assert.notEqual(
      row.slack_reason,
      "seed reason",
      "reason was re-classified by the relay, not left as the seed value",
    );
  });

  // ── (4a) give up after too many attempts → undeliverable + escalate ──
  await step("give up: too many attempts → terminal undeliverable + escalation", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_BACKOFF_MINUTES, "0");
    await setSystemSetting(SETTING_MAX_ATTEMPTS, "3");
    // Slack reachable but the post keeps failing non-terminally.
    routes.postMessage = () => jsonResponse({ ok: false, error: "not_in_channel" });
    // 2 prior attempts → this attempt is the 3rd, tipping it over the cap.
    const id = await seedFeedbackRow({ updatedMinutesAgo: 10, attempts: 2 });

    const r = await runFeedbackSlackRetryTick();
    const mine = r.attempted.find((a) => a.feedbackId === id);
    assert.ok(mine, "our row was attempted");
    assert.equal(mine!.outcome, "undeliverable", "row given up as undeliverable");
    assert.ok(r.escalated >= 1, "escalated counter incremented");
    assert.equal(r.maxAttempts, 3, "tick reports the configured attempt cap");

    const row = await readRow(id);
    assert.equal(row.slack_status, "undeliverable", "row persisted undeliverable");
    assert.equal(row.slack_attempts, 3, "slack_attempts advanced to the cap");
    assert.match(row.slack_reason ?? "", /gave up/i);
    assert.match(row.slack_reason ?? "", /3 failed attempts/i);

    // The escalation wrote an inbox notification for our seeded admin.
    const n = await db.execute(sql`
      SELECT id FROM user_notifications
      WHERE user_id = ${TEST_ADMIN_ID} AND dedupe_key = ${ESCALATION_DEDUPE_KEY}
    `);
    assert.ok((n.rows?.length ?? 0) >= 1, "admin received a give-up escalation notification");
  });

  // ── (4b) give up after stuck too long → undeliverable + escalate ─────
  await step("give up: stuck too long → terminal undeliverable + escalation", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_BACKOFF_MINUTES, "0");
    // Attempt cap high enough that only the age threshold can trip it.
    await setSystemSetting(SETTING_MAX_ATTEMPTS, "100");
    await setSystemSetting(SETTING_MAX_STUCK_HOURS, "24");
    routes.postMessage = () => jsonResponse({ ok: false, error: "not_in_channel" });
    // Few attempts but created 48h ago → over the 24h stuck threshold.
    const id = await seedFeedbackRow({
      updatedMinutesAgo: 10,
      attempts: 1,
      createdHoursAgo: 48,
    });

    const r = await runFeedbackSlackRetryTick();
    const mine = r.attempted.find((a) => a.feedbackId === id);
    assert.ok(mine, "our row was attempted");
    assert.equal(mine!.outcome, "undeliverable", "stuck row given up");
    assert.ok(r.escalated >= 1, "escalated counter incremented");
    assert.equal(r.maxStuckHours, 24, "tick reports the configured stuck-hours cap");

    const row = await readRow(id);
    assert.equal(row.slack_status, "undeliverable", "row persisted undeliverable");
    assert.match(row.slack_reason ?? "", /gave up/i);
    assert.match(row.slack_reason ?? "", /stuck/i);
  });

  // ── (4c) below both thresholds → keep retrying, no escalation ────────
  await step("below thresholds: row stays failed, no give-up, no escalation", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_BACKOFF_MINUTES, "0");
    await setSystemSetting(SETTING_MAX_ATTEMPTS, "5");
    await setSystemSetting(SETTING_MAX_STUCK_HOURS, "720");
    routes.postMessage = () => jsonResponse({ ok: false, error: "not_in_channel" });
    // 1 prior attempt, fresh row → nowhere near either threshold.
    const id = await seedFeedbackRow({ updatedMinutesAgo: 10, attempts: 1 });

    const r = await runFeedbackSlackRetryTick();
    const mine = r.attempted.find((a) => a.feedbackId === id);
    assert.ok(mine, "our row was attempted");
    assert.equal(mine!.outcome, "failed", "still failed, not yet given up");
    assert.equal(r.escalated, 0, "nothing escalated below the thresholds");

    const row = await readRow(id);
    assert.equal(row.slack_status, "failed", "row stays a retry candidate");
    assert.equal(row.slack_attempts, 2, "attempt count advanced toward the cap");
  });

  // ── (4d) terminal rows drop out of the live retry budget ─────────────
  await step("terminal: undeliverable rows are excluded from later candidate scans", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_BACKOFF_MINUTES, "0");
    // A row already marked terminal must never be re-selected, even though
    // a live retry candidate alongside it still is.
    const terminalId = await seedFeedbackRow({
      slackStatus: "undeliverable",
      updatedMinutesAgo: 10,
    });
    const liveId = await seedFeedbackRow({ updatedMinutesAgo: 20 });

    const r = await runFeedbackSlackRetryTick();
    const attemptedIds = r.attempted.map((a) => a.feedbackId);
    assert.ok(!attemptedIds.includes(terminalId), "undeliverable row excluded from budget");
    assert.ok(attemptedIds.includes(liveId), "live retry candidate still processed");

    // And the terminal row is genuinely untouched by the tick.
    const term = await readRow(terminalId);
    assert.equal(term.slack_status, "undeliverable", "terminal row left as-is");
  });

  // ── (4e) disconnected Slack (revoked token) still gives up by age ─────
  await step("disconnected: stuck rows still given up + escalated while Slack is down", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_BACKOFF_MINUTES, "0");
    await setSystemSetting(SETTING_MAX_STUCK_HOURS, "24");
    // Slack is permanently broken — auth.test never succeeds, so the tick
    // never reaches the send path. This is the revoked-token scenario.
    routes.authTest = () => jsonResponse({ ok: false, error: "invalid_auth" });
    // Stuck 48h → over the 24h age threshold → must be given up by age.
    const stuckId = await seedFeedbackRow({
      updatedMinutesAgo: 10,
      createdHoursAgo: 48,
    });
    // Fresh row → under the threshold → must be left alone for now.
    const freshId = await seedFeedbackRow({ updatedMinutesAgo: 10, createdHoursAgo: 1 });

    const r = await runFeedbackSlackRetryTick();
    assert.equal(r.connected, false, "tick reports Slack disconnected");
    const attemptedIds = r.attempted.map((a) => a.feedbackId);
    assert.ok(attemptedIds.includes(stuckId), "stuck row given up while disconnected");
    assert.ok(!attemptedIds.includes(freshId), "fresh row left alone while disconnected");
    assert.ok(r.escalated >= 1, "disconnected give-up escalates");

    const stuck = await readRow(stuckId);
    assert.equal(stuck.slack_status, "undeliverable", "stuck row marked terminal");
    assert.match(stuck.slack_reason ?? "", /gave up/i);
    assert.match(stuck.slack_reason ?? "", /disconnected/i);

    const fresh = await readRow(freshId);
    assert.equal(fresh.slack_status, "failed", "fresh row stays a retry candidate");

    // The disconnected escalation reached our seeded admin.
    const n = await db.execute(sql`
      SELECT id FROM user_notifications
      WHERE user_id = ${TEST_ADMIN_ID} AND dedupe_key = ${ESCALATION_DEDUPE_KEY}
    `);
    assert.ok((n.rows?.length ?? 0) >= 1, "admin received a disconnected give-up escalation");
  });

  // ── (5) synthetic-test-marker rows are never live retry candidates ───
  // Task #2783 — a defensive backstop: any row carrying the shared
  // synthetic-test marker in `slack_reason` must be excluded from the
  // candidate scan even though it otherwise looks like a normal, eligible
  // (non-terminal, past-backoff) row.
  await step("synthetic-test marker: marked rows are never selected as candidates", async () => {
    await setSystemSetting(SETTING_ENABLED, "true");
    await setSystemSetting(SETTING_BACKOFF_MINUTES, "0");
    const markedId = await seedFeedbackRow({ updatedMinutesAgo: 30 });
    await db.execute(sql`
      UPDATE user_feedback
      SET slack_reason = ${`${SYNTHETIC_FEEDBACK_TEST_MARKER} (task-2783) — must never be a candidate`}
      WHERE id = ${markedId}
    `);
    const unmarkedId = await seedFeedbackRow({ updatedMinutesAgo: 30 });

    const r = await runFeedbackSlackRetryTick();
    const attemptedIds = r.attempted.map((a) => a.feedbackId);
    assert.ok(
      !attemptedIds.includes(markedId),
      "marked synthetic-test row is excluded from candidate selection",
    );
    assert.ok(
      attemptedIds.includes(unmarkedId),
      "an otherwise-identical unmarked row is still selected",
    );

    const marked = await readRow(markedId);
    assert.equal(
      marked.slack_status,
      "failed",
      "marked row is genuinely untouched by the tick",
    );
  });

  if (failures > 0) throw new Error(`${failures} test(s) failed`);
  console.log("\nAll feedback → Slack auto-resend scheduler tests passed");
}

let exitCode = 0;
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    exitCode = 1;
  })
  .finally(async () => {
    global.fetch = originalFetch;
    try {
      await cleanupRows();
    } catch {}
    try {
      await cleanupEscalation();
    } catch {}
    try {
      await cleanupAdminUser();
    } catch {}
    try {
      _resetQueueDrainStateForTests();
    } catch {}
    try {
      if (originalSlackBotToken === undefined) {
        await storage.deleteSystemSetting(SLACK_TOKEN_KEY);
      } else {
        await storage.setSystemSetting(
          SLACK_TOKEN_KEY,
          originalSlackBotToken ?? "",
          "system",
        );
      }
    } catch {}
    process.exitCode = exitCode;
  });
