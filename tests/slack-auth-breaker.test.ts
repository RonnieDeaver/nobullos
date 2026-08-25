/* test-registration
{
  "name": "Slack auth circuit breaker (Task #1606)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1606 regression coverage for the Slack auth circuit breaker added
 * in Task #1602 (`server/services/slackIntegration.ts`).
 *
 * Locks the following behavior in place against future refactors:
 *
 * 1. Every terminal Slack auth code trips the breaker.
 * 2. Transient Slack errors (5xx, 429-after-retries, network, channel_not_found,
 *    rate_limited) never trip the breaker.
 * 3. `auth.test` bypasses the open breaker (recovery path).
 * 4. A successful `auth.test` resets the breaker.
 * 5. While the breaker is open, `isConnected()` returns false and an alert
 *    dispatch through `manualReserveAlerts` records `not_configured` (not
 *    `failed`) so the dispatch table doesn't fill with auth-failure spam.
 *
 * `global.fetch` is monkey-patched so the suite never hits real Slack.
 * The breaker module exports `__resetSlackAuthBreakerForTest` /
 * `getSlackAuthState` exactly for this kind of test — no new production
 * hooks are added.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  __resetSlackAuthBreakerForTest,
  getSlackAuthState,
  isConnected,
  lookupUserByEmail,
  postMessage,
  testConnection,
} from "../server/services/slackIntegration";
import {
  __resetManualReserveAlertCooldownsForTest,
  __resetManualReserveAlertDispatchesForTest,
  deliverManualReserveAlerts,
  getRecentManualReserveAlertDispatches,
} from "../server/services/manualReserveAlerts";
import type { Alert } from "../server/services/healthMetrics";

const originalFetch: typeof fetch = global.fetch;
const originalEnvChannel = process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID;
let originalSlackBotToken: string | null | undefined; // undefined = "row missing", null/string = "row existed"

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;
let slackCallLog: string[] = [];

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

global.fetch = (async (input: any, init?: any) => {
  // Task #1820: short-circuit Upstash REST calls so the
  // system_settings cache (this suite repeatedly toggles
  // `slack_bot_token`) stays deterministic across scenarios. Without
  // it, an intermittent `cacheDel` failure can leak a prior scenario's
  // token into the next one.
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url =
    typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.includes("slack.com/api")) {
    slackCallLog.push(url);
    if (fetchHandler) return fetchHandler(url, init);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return originalFetch(input as any, init);
}) as any;

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function methodOf(url: string): string {
  const m = url.match(/slack\.com\/api\/([^/?]+)/);
  return m?.[1] ?? "";
}

async function resetBreakerAndLog(): Promise<void> {
  __resetSlackAuthBreakerForTest();
  slackCallLog = [];
  fetchHandler = null;
}

async function expectThrows(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw, but it resolved");
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  await resetBreakerAndLog();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    await resetBreakerAndLog();
  }
}

const TERMINAL_CODES = [
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "token_expired",
  "invalid_token",
  "missing_scope",
  "no_permission",
  "not_authed",
];

async function main(): Promise<void> {
  console.log("Slack auth breaker regression (Task #1606)");

  // Snapshot the existing slack_bot_token value (if any) so we can restore
  // it on exit and avoid polluting the shared dev DB across test files.
  const prior = await storage.getSystemSetting("slack_bot_token").catch(() => null);
  originalSlackBotToken = prior ? prior.value ?? null : undefined;

  // Seed a slack_bot_token so getBotToken() doesn't throw — the breaker
  // is a separate gating layer that runs even before the token lookup.
  await storage.setSystemSetting("slack_bot_token", "xoxb-test-fake-token", "system");

  // ── Group 1 ── every terminal code trips the breaker ─────────────────
  for (const code of TERMINAL_CODES) {
    await step(`Group 1 — terminal code "${code}" trips the breaker`, async () => {
      fetchHandler = async (url) => {
        // postMessage uses chat.postMessage POST; mock returns the terminal
        // Slack-shaped error.
        return jsonResponse({ ok: false, error: code });
      };
      await expectThrows(() => postMessage("C123", "hello"));
      const state = getSlackAuthState();
      assert.equal(state.authBroken, true, `breaker should be open after ${code}`);
      assert.equal(state.errorCode, code, `errorCode should be ${code}`);
      assert.ok(state.cooldownRemainingMs > 0, "cooldownRemainingMs > 0");
      assert.equal(await isConnected(), false, "isConnected() should be false while open");
    });
  }

  // ── Group 2 ── transient errors do NOT trip the breaker ──────────────
  await step("Group 2 — HTTP 500 does not trip breaker", async () => {
    fetchHandler = async () => new Response("internal error", { status: 500 });
    await expectThrows(() => postMessage("C123", "hello"));
    assert.equal(getSlackAuthState().authBroken, false);
    assert.equal(await isConnected(), true, "isConnected() should remain true (token present)");
  });

  await step("Group 2 — HTTP 429 (after retries exhausted) does not trip breaker", async () => {
    // Always 429 with Retry-After:0 so the cap kicks in fast.
    fetchHandler = async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "0" },
      });
    await expectThrows(() => postMessage("C123", "hello"));
    assert.equal(getSlackAuthState().authBroken, false);
    assert.equal(await isConnected(), true);
  });

  await step("Group 2 — network error does not trip breaker", async () => {
    fetchHandler = async () => {
      throw new Error("ECONNREFUSED simulated");
    };
    await expectThrows(() => postMessage("C123", "hello"));
    assert.equal(getSlackAuthState().authBroken, false);
    assert.equal(await isConnected(), true);
  });

  await step("Group 2 — channel_not_found does not trip breaker", async () => {
    fetchHandler = async () => jsonResponse({ ok: false, error: "channel_not_found" });
    await expectThrows(() => postMessage("C123", "hello"));
    assert.equal(getSlackAuthState().authBroken, false);
    assert.equal(await isConnected(), true);
  });

  await step("Group 2 — rate_limited body code does not trip breaker", async () => {
    fetchHandler = async () => jsonResponse({ ok: false, error: "rate_limited" });
    await expectThrows(() => postMessage("C123", "hello"));
    assert.equal(getSlackAuthState().authBroken, false);
    assert.equal(await isConnected(), true);
  });

  // ── Group 3A ── auth.test bypasses the open breaker ──────────────────
  await step("Group 3A — auth.test bypasses an open breaker (recovery path)", async () => {
    // Trip the breaker with invalid_auth via a lookupUserByEmail attempt
    // (which uses slackApiRequest GET). lookupUserByEmail swallows the
    // throw and returns null, but the breaker still trips inside.
    fetchHandler = async (url) => {
      if (methodOf(url) === "users.lookupByEmail") {
        return jsonResponse({ ok: false, error: "invalid_auth" });
      }
      return jsonResponse({ ok: true });
    };
    const r = await lookupUserByEmail("nobody@example.com");
    assert.equal(r, null);
    assert.equal(getSlackAuthState().authBroken, true, "breaker should be open");

    // Now swap fetch to count auth.test calls and have it ALSO error so we
    // can confirm the call is made (it bypasses the breaker short-circuit).
    let authTestCalls = 0;
    fetchHandler = async (url) => {
      if (methodOf(url) === "auth.test") {
        authTestCalls++;
        // Return a non-ok body so testConnection() returns ok:false, but the
        // fetch itself was issued → proving the breaker did not short-circuit.
        return jsonResponse({ ok: false, error: "invalid_auth" });
      }
      return jsonResponse({ ok: true });
    };
    const tc = await testConnection();
    assert.equal(tc.ok, false);
    assert.equal(authTestCalls, 1, "auth.test must be called despite open breaker");
    // Breaker state may persist (failed auth.test does not clear it).
    assert.equal(getSlackAuthState().authBroken, true);
  });

  // ── Group 3B ── successful auth.test resets the breaker ──────────────
  await step("Group 3B — successful auth.test clears the breaker", async () => {
    fetchHandler = async (url) => {
      if (methodOf(url) === "chat.postMessage") {
        return jsonResponse({ ok: false, error: "invalid_auth" });
      }
      return jsonResponse({ ok: true });
    };
    await expectThrows(() => postMessage("C123", "hello"));
    assert.equal(getSlackAuthState().authBroken, true);
    assert.equal(await isConnected(), false);

    fetchHandler = async (url) => {
      if (methodOf(url) === "auth.test") {
        return jsonResponse({ ok: true, team: "T1", user: "U1", team_id: "T1" });
      }
      return jsonResponse({ ok: true });
    };
    const tc = await testConnection();
    assert.equal(tc.ok, true);
    assert.equal(getSlackAuthState().authBroken, false, "breaker should be cleared after successful auth.test");
    assert.equal(await isConnected(), true);
  });

  // ── Group 4 ── breaker-open → manualReserveAlerts records not_configured
  await step(
    "Group 4 — breaker-open causes manualReserveAlerts to record `not_configured` (not `failed`)",
    async () => {
      // Give the dispatcher a channel so it doesn't short-circuit with
      // skipped_no_channel before reaching the Slack-connectivity check.
      process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID = "C-test-1606";

      // Trip the breaker.
      fetchHandler = async () => jsonResponse({ ok: false, error: "invalid_auth" });
      await expectThrows(() => postMessage("C-test-1606", "trip-the-breaker"));
      assert.equal(getSlackAuthState().authBroken, true);
      assert.equal(await isConnected(), false);

      // Now arrange a dispatch — the dispatcher must NOT actually hit Slack
      // (isSlackConnected returns false because the breaker is open), so it
      // returns skipped_slack_disconnected and manualReserveAlerts records
      // "not_configured" with detail "Slack integration not connected".
      __resetManualReserveAlertCooldownsForTest();
      __resetManualReserveAlertDispatchesForTest();

      const uniqueMetric = `t1606_breaker_${process.pid}_${Date.now()}`;
      const alert: Alert = {
        metric: uniqueMetric,
        severity: "warning",
        value: 5,
        threshold: 1,
        message: `regression probe ${uniqueMetric}`,
      };
      const startedAt = Date.now();
      const result = await deliverManualReserveAlerts([alert]);
      assert.equal(result.sent, false, "delivery should not have been sent");
      assert.deepEqual(
        result.deliveredKeys,
        [`${uniqueMetric}:warning`],
        "the metric should still be marked as cooled-down so we don't retry",
      );

      // Wait briefly for the fire-and-forget DB write to settle, then query
      // the table directly (the dispatch is persisted async via void
      // persistDispatches; the in-memory buffer is populated synchronously
      // but the task brief asks specifically for a DB-row assertion).
      let dispatched: Awaited<ReturnType<typeof getRecentManualReserveAlertDispatches>> = [];
      for (let i = 0; i < 50; i++) {
        dispatched = await getRecentManualReserveAlertDispatches({
          sinceTimestamp: startedAt - 1,
          metric: uniqueMetric,
          limit: 10,
        });
        if (dispatched.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(dispatched.length >= 1, `expected a dispatch row for ${uniqueMetric}`);
      const row = dispatched[0];
      assert.equal(row.status, "not_configured", `status must be not_configured (got ${row.status})`);
      assert.notEqual(row.status, "failed", "status must NOT be failed while breaker is open");
      assert.ok(
        (row.detail ?? "").toLowerCase().includes("slack"),
        `detail should mention Slack (got ${JSON.stringify(row.detail)})`,
      );

      // Clean up the rows we just wrote so we don't leave noise in the dev DB.
      await db.execute(sql`
        DELETE FROM manual_reserve_alert_dispatches WHERE metric = ${uniqueMetric}
      `);
      delete process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID;
      if (originalEnvChannel !== undefined) {
        process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID = originalEnvChannel;
      }
    },
  );

  if (failures > 0) {
    throw new Error(`${failures} test(s) failed`);
  }
  console.log("\nAll Slack auth breaker regression tests passed");
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
    if (originalEnvChannel === undefined) {
      delete process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID;
    } else {
      process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID = originalEnvChannel;
    }
    // Restore the slack_bot_token system setting to its prior value so we
    // don't leak a fake token into other test files that share the dev DB.
    try {
      if (originalSlackBotToken === undefined) {
        await storage.deleteSystemSetting("slack_bot_token");
      } else {
        await storage.setSystemSetting(
          "slack_bot_token",
          originalSlackBotToken ?? "",
          "system",
        );
      }
    } catch {}
    process.exitCode = exitCode;
  });
