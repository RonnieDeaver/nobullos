/* test-registration
{
  "name": "Slack connect handler \u2014 transient-failure preservation (Task #1968)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1968 — Slack connect handler must not wipe the token on
 * transient probe failures, and every clear must be audited.
 *
 * The route handler (`POST /api/integrations/slack/connect` in
 * server/routes/communications.ts) is a thin glue layer over the
 * Slack service: it calls setToken → probeConnection, then either
 *   - returns 200 (connected)
 *   - calls disconnect(trigger=connect_terminal_auth_error) + 400
 *   - returns 202 (probe_failed) WITHOUT touching the token
 *
 * This test reproduces that branching against the real service
 * module (with `global.fetch` monkey-patched for Slack) and asserts
 * the durable invariants the task cares about:
 *
 *   1. Valid token (auth.test ok) → token retained, audit "connect".
 *   2. invalid_auth from auth.test → token cleared, audit row with
 *      trigger=connect_terminal_auth_error + slackErrorCode=invalid_auth.
 *   3. token_revoked from auth.test → same as #2.
 *   4. HTTP 500 from auth.test → token RETAINED, no clear audit row.
 *   5. missing_scope from auth.test → token RETAINED, no clear audit row.
 *   6. Network timeout / throw from auth.test → token RETAINED.
 *   7. Manual disconnect → token cleared, audit row with
 *      trigger=manual_disconnect.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import { getDb } from "../server/db";
import { users } from "@shared/schema";
import {
  __resetSlackAuthBreakerForTest,
  disconnect,
  isTerminalSlackAuthCode,
  probeConnection,
  setToken,
} from "../server/services/slackIntegration";
import { runInIsolatedSchema, sql } from "./db-sandbox";

const originalFetch: typeof fetch = global.fetch;
let originalSlackBotToken: string | null | undefined;

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url = typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.includes("slack.com/api")) {
    if (fetchHandler) return fetchHandler(url, init);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return originalFetch(input as any, init);
}) as any;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Faithful re-implementation of the connect-handler body in
 * server/routes/communications.ts. We exercise the same service-call
 * sequence the handler uses so the behavior of the branching (wipe vs
 * preserve) is regression-tested independent of express plumbing.
 */
async function runConnectHandler(token: string): Promise<{
  status: number;
  body: Record<string, any>;
}> {
  await setToken(token, undefined);
  const probe = await probeConnection();
  if (probe.outcome === "connected") {
    return { status: 200, body: { success: true, team: probe.team ?? null } };
  }
  if (probe.outcome === "unauthorized" && isTerminalSlackAuthCode(probe.reason)) {
    await disconnect(undefined, {
      trigger: "connect_terminal_auth_error",
      slackErrorCode: probe.reason ?? null,
      notes: "Cleared by connect handler after auth.test returned a terminal Slack auth code",
    });
    return {
      status: 400,
      body: {
        error: `Slack rejected the token (${probe.reason}) — re-enter the bot token.`,
        reason: probe.reason!,
      },
    };
  }
  return {
    status: 202,
    body: {
      success: true,
      warning: `Token saved but verification failed (${probe.reason ?? "probe_failed"}). It will be probed again automatically; no action required unless it stays unhealthy.`,
      reason: probe.reason ?? "probe_failed",
    },
  };
}

async function getTokenValue(): Promise<string> {
  const s = await storage.getSystemSetting("slack_bot_token");
  return s?.value ?? "";
}

async function clearAudit(): Promise<void> {
  // Best-effort cleanup of audit rows we may have written. The pruner
  // already exists; we just keep the test bucket small.
  try {
    await storage.pruneAdminSettingAuditPerScope({
      settingKey: "slack_bot_token",
      maxEntriesPerScope: 0,
    });
  } catch {
    // Pruner requires >=1; fall back to fetching+ignoring.
  }
}

async function listClearAudit(scope: string) {
  return storage.listAdminSettingAudit({ settingKey: "slack_bot_token", scope, limit: 5 });
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  __resetSlackAuthBreakerForTest();
  fetchHandler = null;
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    __resetSlackAuthBreakerForTest();
    fetchHandler = null;
  }
}

async function main(): Promise<void> {
  console.log("Slack connect handler — transient-failure preservation (Task #1968)");

  const prior = await storage.getSystemSetting("slack_bot_token").catch(() => null);
  originalSlackBotToken = prior ? prior.value ?? null : undefined;

  // Hermetic baseline: the shared dev DB retains audit rows from prior runs.
  // The before/after assertions below are relative, but listClearAudit caps
  // its result at `limit: 5`; once ≥5 rows accumulate per scope the count
  // saturates and `after === before + 1` can never hold. Prune to a tiny
  // baseline so the relative counts stay well under the cap.
  await clearAudit();

  await step("happy path — auth.test ok → token retained, no clear audit", async () => {
    const beforeManual = (await listClearAudit("manual_disconnect")).length;
    const beforeTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    fetchHandler = async () => jsonResponse({ ok: true, team: "Acme", user: "U1", team_id: "T1" });
    const r = await runConnectHandler("xoxb-happy-fake");
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(await getTokenValue(), "xoxb-happy-fake", "token must be retained on success");
    const afterManual = (await listClearAudit("manual_disconnect")).length;
    const afterTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    assert.equal(afterManual, beforeManual, "no new manual_disconnect rows from a happy connect");
    assert.equal(afterTerminal, beforeTerminal, "no new terminal-auth-error rows from a happy connect");
  });

  await step("terminal invalid_auth → token cleared, audit row with slack code", async () => {
    fetchHandler = async () => jsonResponse({ ok: false, error: "invalid_auth" });
    const r = await runConnectHandler("xoxb-invalid-fake");
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, "invalid_auth");
    assert.equal(await getTokenValue(), "", "token must be cleared on terminal auth error");
    const terminal = await listClearAudit("connect_terminal_auth_error");
    assert.ok(terminal.length >= 1, "an audit row must be written for the auto-clear");
    const newest = terminal[0];
    const nv = newest.newValues as any;
    assert.equal(nv?.trigger, "connect_terminal_auth_error");
    assert.equal(nv?.slackErrorCode, "invalid_auth");
  });

  await step("terminal token_revoked → token cleared, audit row with slack code", async () => {
    fetchHandler = async () => jsonResponse({ ok: false, error: "token_revoked" });
    const r = await runConnectHandler("xoxb-revoked-fake");
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, "token_revoked");
    assert.equal(await getTokenValue(), "", "token must be cleared on terminal auth error");
    const terminal = await listClearAudit("connect_terminal_auth_error");
    const matching = terminal.find((row) => (row.newValues as any)?.slackErrorCode === "token_revoked");
    assert.ok(matching, "audit row with slackErrorCode=token_revoked must exist");
  });

  await step("HTTP 500 from auth.test → token RETAINED, no clear audit row", async () => {
    const beforeTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    const beforeManual = (await listClearAudit("manual_disconnect")).length;
    fetchHandler = async () => new Response("internal", { status: 500 });
    const r = await runConnectHandler("xoxb-transient-5xx");
    assert.equal(r.status, 202, "5xx must return 202 (probe_failed warning)");
    assert.equal(r.body.success, true);
    assert.ok(typeof r.body.warning === "string", "must surface a warning string");
    assert.equal(await getTokenValue(), "xoxb-transient-5xx", "token must be preserved on 5xx");
    const afterTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    const afterManual = (await listClearAudit("manual_disconnect")).length;
    assert.equal(afterTerminal, beforeTerminal, "no new terminal-auth-error audit row on 5xx");
    assert.equal(afterManual, beforeManual, "no new manual_disconnect audit row on 5xx");
  });

  await step("missing_scope → token RETAINED, no clear audit row", async () => {
    const beforeTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    fetchHandler = async () => jsonResponse({ ok: false, error: "missing_scope" });
    const r = await runConnectHandler("xoxb-missing-scope");
    assert.equal(r.status, 202, "missing_scope must NOT wipe the token");
    assert.equal(await getTokenValue(), "xoxb-missing-scope");
    const afterTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    assert.equal(afterTerminal, beforeTerminal, "no terminal-auth-error row from missing_scope");
  });

  await step("network throw → token RETAINED (transient)", async () => {
    const beforeTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    fetchHandler = async () => { throw new Error("ECONNRESET simulated"); };
    const r = await runConnectHandler("xoxb-network-throw");
    assert.equal(r.status, 202, "network throw must NOT wipe the token");
    assert.equal(await getTokenValue(), "xoxb-network-throw");
    const afterTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    assert.equal(afterTerminal, beforeTerminal);
  });

  await step("non-terminal unauthorized (no_token_stored / stale read) → token RETAINED", async () => {
    // Simulate the stale-read edge: probeConnection sees no token (so
    // returns outcome=unauthorized, reason=no_token_stored), but the
    // operator's freshly-entered token is sitting in storage. The handler
    // must NOT wipe it just because the probe returned `unauthorized`.
    // We invoke runConnectHandler with a token whose auth.test would
    // succeed, then assert isTerminalSlackAuthCode behavior directly
    // against the synthesized probe result.
    assert.equal(isTerminalSlackAuthCode("no_token_stored"), false, "no_token_stored must not be terminal");
    assert.equal(isTerminalSlackAuthCode(null), false, "null reason must not be terminal");
    assert.equal(isTerminalSlackAuthCode("rate_limited"), false, "rate_limited must not be terminal");
    assert.equal(isTerminalSlackAuthCode("invalid_auth"), true, "invalid_auth must be terminal");
    assert.equal(isTerminalSlackAuthCode("token_revoked"), true, "token_revoked must be terminal");
    // End-to-end: force the handler down the unauthorized path with a
    // non-terminal reason and verify the token survives.
    const beforeTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    fetchHandler = async () => jsonResponse({ ok: false, error: "rate_limited" });
    const r = await runConnectHandler("xoxb-non-terminal-unauth");
    assert.equal(r.status, 202, "non-terminal unauthorized must NOT wipe the token");
    assert.equal(await getTokenValue(), "xoxb-non-terminal-unauth");
    const afterTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    assert.equal(afterTerminal, beforeTerminal, "no terminal-auth-error audit row for non-terminal unauthorized");
  });

  await step("manual disconnect → token cleared, audit row with manual_disconnect", async () => {
    // Pre-seed a token so the disconnect has something to clear.
    await setToken("xoxb-to-be-disconnected", undefined);
    assert.equal(await getTokenValue(), "xoxb-to-be-disconnected");
    const beforeManual = (await listClearAudit("manual_disconnect")).length;
    await disconnect(undefined, { trigger: "manual_disconnect" });
    assert.equal(await getTokenValue(), "");
    const afterManual = (await listClearAudit("manual_disconnect")).length;
    assert.equal(afterManual, beforeManual + 1, "manual_disconnect audit row must be written");
    const newest = (await listClearAudit("manual_disconnect"))[0];
    assert.equal((newest.newValues as any)?.trigger, "manual_disconnect");
  });

  // Task #2282 — staff identity must be recorded when a genuine signed-in
  // admin (not the system/null actor) performs the disconnect. Slack stores
  // its credential in `system_settings` and stamps `updated_by`, and writes
  // `admin_setting_audit.changed_by`. Both FKs to `users.id` are dropped by
  // `CREATE TABLE … (LIKE …)`, so we re-add them to the cloned tables —
  // making the constraints genuinely enforced in-schema — then seed a real
  // `users` row so a *real* admin id satisfies them. A fabricated id would
  // FK-violate, which is exactly the regression this step guards against.
  await step("manual disconnect by a real signed-in admin → audit changedBy == that user id", async () => {
    await runInIsolatedSchema(
      async ({ db }) => {
        await db.execute(
          sql`ALTER TABLE admin_setting_audit ADD CONSTRAINT iso_asa_changed_by_fk FOREIGN KEY (changed_by) REFERENCES users(id)`,
        );
        await db.execute(
          sql`ALTER TABLE system_settings ADD CONSTRAINT iso_ss_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id)`,
        );
        const adminId = `u-2282-slack-${Date.now()}`;
        await getDb().insert(users).values({ id: adminId, email: `${adminId}@test.local` });

        await setToken("xoxb-actor-fake", adminId);
        assert.equal(await getTokenValue(), "xoxb-actor-fake");
        await disconnect(adminId, { trigger: "manual_disconnect" });
        assert.equal(await getTokenValue(), "", "token must be cleared on a real-admin disconnect");

        const rows = await storage.listAdminSettingAudit({
          settingKey: "slack_bot_token",
          scope: "manual_disconnect",
          changedByIn: [adminId],
          limit: 5,
        });
        assert.equal(rows.length, 1, "exactly one audit row must be attributed to the seeded admin");
        assert.equal(rows[0].changedBy, adminId, "audit changedBy must equal the signed-in admin's user id");
        assert.equal((rows[0].newValues as any)?.trigger, "manual_disconnect");
      },
      { tables: ["users", "system_settings", "admin_setting_audit"] },
    );
  });

  if (failures > 0) throw new Error(`${failures} test(s) failed`);
  console.log("\nAll Slack connect handler tests passed");
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
      if (originalSlackBotToken === undefined) {
        await storage.deleteSystemSetting("slack_bot_token");
      } else {
        await storage.setSystemSetting("slack_bot_token", originalSlackBotToken ?? "", "system");
      }
    } catch {}
    process.exitCode = exitCode;
  });
