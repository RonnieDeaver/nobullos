/* test-registration
{
  "name": "Feedback \u2192 Slack delivery tracking (Task #2065)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2065 — guard the per-feedback Slack delivery tracking that
 * Task #2064 added. Without this test a regression could silently
 * return us to the old "failures are invisible" state.
 *
 * What this covers:
 *
 *   1. `relayFeedbackToSlack` + `recordFeedbackSlackResult` persist the
 *      correct `slack_status` / `slack_reason` for:
 *        - delivered      (auth.test ok → channel found → postMessage ok)
 *        - not_connected  (auth.test returns a terminal auth code)
 *        - failed         (chat.postMessage returns a non-terminal error)
 *   2. The Retry-Slack endpoint's glue updates the row on BOTH a
 *      successful retry (delivered) and a failing retry (not_connected).
 *   3. Unit coverage for `plainEnglishSlackReason` / `parseSlackErrorCode`
 *      across the terminal Slack auth codes in SLACK_REASON_TEXT.
 *
 * Like the Task #1968 Slack connect-handler test, this exercises the
 * REAL service module (`feedbackSlackRelay.ts` + `slackIntegration.ts`)
 * with `global.fetch` monkey-patched for Slack, so the behavior under
 * test is the production code path — not a re-implemented copy. Feedback
 * rows are written to the live `user_feedback` table under a unique test
 * user id and cleaned up at the end.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  __resetSlackAuthBreakerForTest,
  plainEnglishSlackReason,
  parseSlackErrorCode,
} from "../server/services/slackIntegration";
import {
  relayFeedbackToSlack,
  recordFeedbackSlackResult,
  resetFeedbackSlackLookupCache,
  __resetFeedbackSlackStateForTest,
  type FeedbackSlackResult,
  type FeedbackSlackRelayArgs,
} from "../server/services/feedbackSlackRelay";
import { SYNTHETIC_FEEDBACK_TEST_MARKER } from "../server/services/feedbackSlackRetry";

const TEST_USER_ID = "task-2065-feedback-slack-test";
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
  authTest: () => jsonResponse({ ok: true, team: "Acme", user: "U1", team_id: "T1" }),
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
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url = typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.includes("slack.com/api/auth.test")) return routes.authTest();
  if (url.includes("slack.com/api/conversations.list")) return routes.conversationsList();
  if (url.includes("slack.com/api/users.lookupByEmail")) return routes.lookupByEmail();
  if (url.includes("slack.com/api/chat.postMessage")) return routes.postMessage();
  if (url.includes("slack.com/api")) return jsonResponse({ ok: true });
  return originalFetch(input as any, init);
}) as any;

const RELAY_ARGS: FeedbackSlackRelayArgs = {
  topic: "BUG_REPORT",
  userName: "Tester",
  page: "/some/page",
  feedbackText: "Something is broken",
  screenshotCount: 0,
};

// Task #2783 — seed as a TERMINAL slack_status (`undeliverable`) so the row
// is never a live retry-scheduler candidate on the shared dev DB, even in
// the brief window before the test's own `recordFeedbackSlackResult()` call
// overwrites it (or before `cleanupRows()` runs if the process is
// SIGKILL'd on a timeout). Every case in this file calls
// `recordFeedbackSlackResult` immediately after, which unconditionally
// overwrites `slack_status`/`slack_reason` with the real outcome under
// test — this seed value is never asserted on.
const SYNTHETIC_SLACK_REASON = `${SYNTHETIC_FEEDBACK_TEST_MARKER} (task-2065) — never send to Slack`;

async function insertFeedbackRow(): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO user_feedback (user_id, user_name, topic, feedback_text, current_page, screenshots, slack_status, slack_reason)
    VALUES (${TEST_USER_ID}, 'Tester', 'BUG_REPORT', 'Something is broken', '/some/page', '[]', 'undeliverable', ${SYNTHETIC_SLACK_REASON})
    RETURNING id
  `);
  const id = (r.rows?.[0] as any)?.id;
  assert.ok(id != null, "insert should return a feedback row id");
  return Number(id);
}

async function readRow(id: number): Promise<{ slack_status: string; slack_reason: string | null }> {
  const r = await db.execute(sql`
    SELECT slack_status, slack_reason FROM user_feedback WHERE id = ${id}
  `);
  const row = r.rows?.[0] as any;
  assert.ok(row, `feedback row ${id} should exist`);
  return { slack_status: String(row.slack_status), slack_reason: row.slack_reason ?? null };
}

async function cleanupRows(): Promise<void> {
  await db.execute(sql`DELETE FROM user_feedback WHERE user_id = ${TEST_USER_ID}`);
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  // Fresh breaker + relay channel cache + default Slack handlers per case.
  __resetSlackAuthBreakerForTest();
  __resetFeedbackSlackStateForTest();
  routes = { ...DEFAULT_ROUTES };
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
  }
}

/**
 * Re-creation of the thin Retry-Slack endpoint glue
 * (POST /api/feedback/:id/retry-slack): force a fresh channel resolution,
 * relay via the shared helper, persist, and report success on `delivered`.
 */
async function runRetryEndpoint(rowId: number): Promise<{
  success: boolean;
  slackStatus: FeedbackSlackResult["status"];
  slackReason: string | null;
}> {
  resetFeedbackSlackLookupCache();
  const slackResult = await relayFeedbackToSlack(RELAY_ARGS);
  await recordFeedbackSlackResult(rowId, slackResult);
  return {
    success: slackResult.status === "delivered",
    slackStatus: slackResult.status,
    slackReason: slackResult.reason,
  };
}

async function main(): Promise<void> {
  console.log("Feedback → Slack delivery tracking (Task #2065)");

  const prior = await storage.getSystemSetting(SLACK_TOKEN_KEY).catch(() => null);
  originalSlackBotToken = prior ? prior.value ?? null : undefined;
  // A non-empty token so probeConnection actually probes (auth.test)
  // instead of short-circuiting to no_token_stored.
  await storage.setSystemSetting(SLACK_TOKEN_KEY, "xoxb-task-2065-fake", "system");

  await cleanupRows();

  // ── (1a) delivered path persists slack_status=delivered ───────────────
  await step("delivered: auth ok + channel found + postMessage ok", async () => {
    const id = await insertFeedbackRow();
    const result = await relayFeedbackToSlack(RELAY_ARGS);
    assert.equal(result.status, "delivered", "relay should report delivered");
    assert.equal(result.reason, null, "delivered has no reason");
    await recordFeedbackSlackResult(id, result);
    const row = await readRow(id);
    assert.equal(row.slack_status, "delivered", "row persists delivered");
    assert.equal(row.slack_reason, null, "row has null reason on delivered");
  });

  // ── (1b) not_connected path (terminal auth code from auth.test) ───────
  await step("not_connected: auth.test returns invalid_auth", async () => {
    routes.authTest = () => jsonResponse({ ok: false, error: "invalid_auth" });
    const id = await insertFeedbackRow();
    const result = await relayFeedbackToSlack(RELAY_ARGS);
    assert.equal(result.status, "not_connected", "terminal auth → not_connected");
    assert.equal(
      result.reason,
      plainEnglishSlackReason("invalid_auth"),
      "reason should be the plain-English invalid_auth text",
    );
    await recordFeedbackSlackResult(id, result);
    const row = await readRow(id);
    assert.equal(row.slack_status, "not_connected", "row persists not_connected");
    assert.equal(row.slack_reason, plainEnglishSlackReason("invalid_auth"));
  });

  // ── (1c) failed path (non-terminal chat.postMessage error) ────────────
  await step("failed: chat.postMessage returns not_in_channel", async () => {
    routes.postMessage = () => jsonResponse({ ok: false, error: "not_in_channel" });
    const id = await insertFeedbackRow();
    const result = await relayFeedbackToSlack(RELAY_ARGS);
    assert.equal(result.status, "failed", "non-terminal post error → failed");
    assert.equal(
      result.reason,
      plainEnglishSlackReason("not_in_channel"),
      "reason should be the plain-English not_in_channel text",
    );
    await recordFeedbackSlackResult(id, result);
    const row = await readRow(id);
    assert.equal(row.slack_status, "failed", "row persists failed");
    assert.equal(row.slack_reason, plainEnglishSlackReason("not_in_channel"));
  });

  // ── (1d) failed path (transient HTTP 5xx from postMessage) ────────────
  await step("failed: chat.postMessage HTTP 500 (transient)", async () => {
    routes.postMessage = () => new Response("boom", { status: 500 });
    const id = await insertFeedbackRow();
    const result = await relayFeedbackToSlack(RELAY_ARGS);
    assert.equal(result.status, "failed", "5xx post error → failed");
    assert.ok(
      typeof result.reason === "string" && result.reason.length > 0,
      "transient failure must still carry a human-readable reason",
    );
    await recordFeedbackSlackResult(id, result);
    const row = await readRow(id);
    assert.equal(row.slack_status, "failed", "row persists failed on 5xx");
  });

  // ── (2a) Retry-Slack endpoint updates the row to delivered on success ─
  await step("retry endpoint: failed row recovers to delivered", async () => {
    const id = await insertFeedbackRow();
    // Seed a prior failed state so we prove the retry actually changes it.
    await recordFeedbackSlackResult(id, { status: "failed", reason: "old failure" });
    assert.equal((await readRow(id)).slack_status, "failed", "precondition: failed");

    const resp = await runRetryEndpoint(id);
    assert.equal(resp.success, true, "retry success flag true on delivered");
    assert.equal(resp.slackStatus, "delivered");
    const row = await readRow(id);
    assert.equal(row.slack_status, "delivered", "retry persists delivered");
    assert.equal(row.slack_reason, null);
  });

  // ── (2b) Retry-Slack endpoint updates the row on a failing retry ──────
  await step("retry endpoint: delivered row flips to not_connected on auth loss", async () => {
    const id = await insertFeedbackRow();
    await recordFeedbackSlackResult(id, { status: "delivered", reason: null });
    assert.equal((await readRow(id)).slack_status, "delivered", "precondition: delivered");

    routes.authTest = () => jsonResponse({ ok: false, error: "token_revoked" });
    const resp = await runRetryEndpoint(id);
    assert.equal(resp.success, false, "retry success flag false on not_connected");
    assert.equal(resp.slackStatus, "not_connected");
    assert.equal(resp.slackReason, plainEnglishSlackReason("token_revoked"));
    const row = await readRow(id);
    assert.equal(row.slack_status, "not_connected", "retry persists not_connected");
    assert.equal(row.slack_reason, plainEnglishSlackReason("token_revoked"));
  });

  // ── (3a) plainEnglishSlackReason: terminal auth codes mapped ──────────
  await step("plainEnglishSlackReason maps terminal auth codes (no fallback)", async () => {
    const expected: Record<string, string> = {
      invalid_auth: "Slack rejected the saved token (invalid). Reconnect Slack.",
      not_authed: "No Slack token was sent. Reconnect Slack.",
      account_inactive: "The Slack account or bot is deactivated. Reconnect Slack.",
      token_revoked: "The Slack token was revoked. Reconnect Slack.",
      token_expired: "The Slack token has expired. Reconnect Slack.",
      invalid_token: "The Slack token is not valid. Reconnect Slack.",
      no_token_stored: "Slack is not connected. Reconnect Slack.",
    };
    for (const [code, text] of Object.entries(expected)) {
      assert.equal(plainEnglishSlackReason(code), text, `mapped text for ${code}`);
    }
    // null → generic not-connected; unknown code → fallback that names the code.
    assert.equal(plainEnglishSlackReason(null), "Slack is not connected. Reconnect Slack.");
    assert.equal(plainEnglishSlackReason(undefined), "Slack is not connected. Reconnect Slack.");
    assert.equal(
      plainEnglishSlackReason("totally_unknown_code"),
      "Slack rejected the request (totally_unknown_code).",
      "unknown code falls back to a message that still names the raw code",
    );
  });

  // ── (3b) parseSlackErrorCode: bare code vs HTTP-status vs noise ───────
  await step("parseSlackErrorCode extracts bare codes only", async () => {
    assert.equal(parseSlackErrorCode("Slack API error: token_revoked"), "token_revoked");
    assert.equal(parseSlackErrorCode("Slack API error: invalid_auth"), "invalid_auth");
    assert.equal(parseSlackErrorCode("Slack API error: not_in_channel"), "not_in_channel");
    // HTTP-status form carries a numeric status + body → not a bare code.
    assert.equal(parseSlackErrorCode("Slack API error: 500 Internal Server Error"), null);
    assert.equal(parseSlackErrorCode("some random error"), null);
    assert.equal(parseSlackErrorCode(null), null);
    assert.equal(parseSlackErrorCode(undefined), null);
  });

  await cleanupRows();

  if (failures > 0) throw new Error(`${failures} test(s) failed`);
  console.log("\nAll feedback → Slack delivery tracking tests passed");
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
      if (originalSlackBotToken === undefined) {
        await storage.deleteSystemSetting(SLACK_TOKEN_KEY);
      } else {
        await storage.setSystemSetting(SLACK_TOKEN_KEY, originalSlackBotToken ?? "", "system");
      }
    } catch {}
    process.exitCode = exitCode;
  });
