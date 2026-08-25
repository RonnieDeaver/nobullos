/* test-registration
{
  "name": "PandaDoc connect handler \u2014 transient-failure preservation (Task #1977)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.9s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1977 — PandaDoc connect handler must not wipe the API key on
 * transient probe failures, and every clear must be audited.
 *
 * The route handler (`POST /api/integrations/pandadoc/connect` in
 * server/routes/agents.ts) is a thin glue layer over the PandaDoc
 * service: it calls setApiKey → probeConnection, then either
 *   - returns 200 (connected)
 *   - calls disconnect(trigger=connect_terminal_auth_error) + 400
 *   - returns 202 (probe_failed) WITHOUT touching the key
 *
 * This test reproduces that branching against the real service module
 * (with `global.fetch` monkey-patched for PandaDoc) and asserts the
 * durable invariants the task cares about:
 *
 *   1. Valid key (documents ok) → key retained, audit "connect".
 *   2. HTTP 401 → key cleared, audit row with
 *      trigger=connect_terminal_auth_error + reason=http_401.
 *   3. HTTP 403 → same as #2 with reason=http_403.
 *   4. HTTP 500 → key RETAINED, no clear audit row.
 *   5. HTTP 429 → key RETAINED, no clear audit row.
 *   6. Network throw → key RETAINED.
 *   7. Manual disconnect → key cleared, audit row with
 *      trigger=manual_disconnect.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import { getDb } from "../server/db";
import { users } from "@shared/schema";
import {
  PANDADOC_API_KEY_SETTING_KEY,
  disconnect,
  isTerminalPandadocAuthReason,
  probeConnection,
  setApiKey,
} from "../server/services/pandadocIntegration";
import { runInIsolatedSchema, sql } from "./db-sandbox";

const originalFetch: typeof fetch = global.fetch;
let originalPandadocKey: string | null | undefined;

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url = typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.includes("api.pandadoc.com")) {
    if (fetchHandler) return fetchHandler(url, init);
    return new Response(JSON.stringify({ results: [] }), {
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
 * server/routes/agents.ts. We exercise the same service-call sequence
 * the handler uses so the branching (wipe vs preserve) is
 * regression-tested independent of express plumbing.
 */
async function runConnectHandler(apiKey: string): Promise<{
  status: number;
  body: Record<string, any>;
}> {
  await setApiKey(apiKey, undefined);
  const probe = await probeConnection();
  if (probe.outcome === "connected") {
    return { status: 200, body: { success: true } };
  }
  if (probe.outcome === "unauthorized" && isTerminalPandadocAuthReason(probe.reason)) {
    await disconnect(undefined, {
      trigger: "connect_terminal_auth_error",
      reason: probe.reason ?? null,
      notes: "Cleared by connect handler after PandaDoc returned a terminal auth status",
    });
    return {
      status: 400,
      body: {
        error: `PandaDoc rejected the API key (${probe.reason}) — re-enter the key.`,
        reason: probe.reason!,
      },
    };
  }
  return {
    status: 202,
    body: {
      success: true,
      warning: `Key saved but verification failed (${probe.reason ?? "probe_failed"}). It will be probed again automatically.`,
      reason: probe.reason ?? "probe_failed",
    },
  };
}

async function getKeyValue(): Promise<string> {
  const s = await storage.getSystemSetting(PANDADOC_API_KEY_SETTING_KEY);
  return s?.value ?? "";
}

async function listClearAudit(scope: string) {
  return storage.listAdminSettingAudit({ settingKey: PANDADOC_API_KEY_SETTING_KEY, scope, limit: 5 });
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  fetchHandler = null;
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    fetchHandler = null;
  }
}

async function main(): Promise<void> {
  console.log("PandaDoc connect handler — transient-failure preservation (Task #1977)");

  // Hermetic baseline: the shared dev DB retains audit rows from prior runs.
  // The before/after assertions below are relative, but listAdminSettingAudit
  // caps results at `limit: 5`; once ≥5 rows accumulate per scope the count
  // saturates and `after === before + 1` can never hold. Prune to a tiny
  // baseline so the relative counts stay well under the cap.
  await storage
    .pruneAdminSettingAuditPerScope({ settingKey: PANDADOC_API_KEY_SETTING_KEY, maxEntriesPerScope: 1 })
    .catch(() => {});

  const prior = await storage.getSystemSetting(PANDADOC_API_KEY_SETTING_KEY).catch(() => null);
  originalPandadocKey = prior ? prior.value ?? null : undefined;

  // Sanity-check the terminal classifier directly.
  assert.equal(isTerminalPandadocAuthReason("http_401"), true);
  assert.equal(isTerminalPandadocAuthReason("http_403"), true);
  assert.equal(isTerminalPandadocAuthReason("http_500"), false);
  assert.equal(isTerminalPandadocAuthReason("http_429"), false);
  assert.equal(isTerminalPandadocAuthReason("network_timeout"), false);
  assert.equal(isTerminalPandadocAuthReason(null), false);

  await step("happy path — documents ok → key retained, no clear audit", async () => {
    const beforeManual = (await listClearAudit("manual_disconnect")).length;
    const beforeTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    fetchHandler = async () => jsonResponse({ results: [] });
    const r = await runConnectHandler("pd-happy-fake");
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(await getKeyValue(), "pd-happy-fake", "key must be retained on success");
    const afterManual = (await listClearAudit("manual_disconnect")).length;
    const afterTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    assert.equal(afterManual, beforeManual, "no new manual_disconnect rows from a happy connect");
    assert.equal(afterTerminal, beforeTerminal, "no new terminal-auth-error rows from a happy connect");
  });

  await step("terminal 401 → key cleared, audit row with reason=http_401", async () => {
    fetchHandler = async () => jsonResponse({ detail: "invalid" }, 401);
    const r = await runConnectHandler("pd-invalid-fake");
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, "http_401");
    assert.equal(await getKeyValue(), "", "key must be cleared on terminal auth error");
    const terminal = await listClearAudit("connect_terminal_auth_error");
    assert.ok(terminal.length >= 1, "an audit row must be written for the auto-clear");
    const nv = terminal[0].newValues as any;
    assert.equal(nv?.trigger, "connect_terminal_auth_error");
    assert.equal(nv?.reason, "http_401");
  });

  await step("terminal 403 → key cleared, audit row with reason=http_403", async () => {
    fetchHandler = async () => jsonResponse({ detail: "forbidden" }, 403);
    const r = await runConnectHandler("pd-forbidden-fake");
    assert.equal(r.status, 400);
    assert.equal(r.body.reason, "http_403");
    assert.equal(await getKeyValue(), "", "key must be cleared on terminal auth error");
    const terminal = await listClearAudit("connect_terminal_auth_error");
    const matching = terminal.find((row) => (row.newValues as any)?.reason === "http_403");
    assert.ok(matching, "audit row with reason=http_403 must exist");
  });

  await step("HTTP 500 → key RETAINED, no clear audit row", async () => {
    const beforeTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    const beforeManual = (await listClearAudit("manual_disconnect")).length;
    fetchHandler = async () => new Response("internal", { status: 500 });
    const r = await runConnectHandler("pd-transient-5xx");
    assert.equal(r.status, 202, "5xx must return 202 (probe_failed warning)");
    assert.equal(r.body.success, true);
    assert.ok(typeof r.body.warning === "string", "must surface a warning string");
    assert.equal(await getKeyValue(), "pd-transient-5xx", "key must be preserved on 5xx");
    const afterTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    const afterManual = (await listClearAudit("manual_disconnect")).length;
    assert.equal(afterTerminal, beforeTerminal, "no new terminal-auth-error audit row on 5xx");
    assert.equal(afterManual, beforeManual, "no new manual_disconnect audit row on 5xx");
  });

  await step("HTTP 429 → key RETAINED, no clear audit row", async () => {
    const beforeTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    fetchHandler = async () => new Response("rate limited", { status: 429 });
    const r = await runConnectHandler("pd-rate-limited");
    assert.equal(r.status, 202, "429 must NOT wipe the key");
    assert.equal(await getKeyValue(), "pd-rate-limited");
    const afterTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    assert.equal(afterTerminal, beforeTerminal, "no terminal-auth-error row from 429");
  });

  await step("network throw → key RETAINED (transient)", async () => {
    const beforeTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    fetchHandler = async () => { throw new Error("ECONNRESET simulated"); };
    const r = await runConnectHandler("pd-network-throw");
    assert.equal(r.status, 202, "network throw must NOT wipe the key");
    assert.equal(await getKeyValue(), "pd-network-throw");
    const afterTerminal = (await listClearAudit("connect_terminal_auth_error")).length;
    assert.equal(afterTerminal, beforeTerminal);
  });

  await step("manual disconnect → key cleared, audit row with manual_disconnect", async () => {
    await setApiKey("pd-to-be-disconnected", undefined);
    assert.equal(await getKeyValue(), "pd-to-be-disconnected");
    const beforeManual = (await listClearAudit("manual_disconnect")).length;
    await disconnect(undefined, { trigger: "manual_disconnect" });
    assert.equal(await getKeyValue(), "");
    const afterManual = (await listClearAudit("manual_disconnect")).length;
    assert.equal(afterManual, beforeManual + 1, "manual_disconnect audit row must be written");
    const newest = (await listClearAudit("manual_disconnect"))[0];
    assert.equal((newest.newValues as any)?.trigger, "manual_disconnect");
  });

  // Task #2282 — staff identity must be recorded when a genuine signed-in
  // admin (not the system/null actor) performs the disconnect. PandaDoc
  // stores its API key in `system_settings` and stamps `updated_by`, and
  // writes `admin_setting_audit.changed_by`. Both FKs to `users.id` are
  // dropped by `CREATE TABLE … (LIKE …)`, so we re-add them to the cloned
  // tables — making the constraints genuinely enforced in-schema — then seed
  // a real `users` row so a *real* admin id satisfies them. A fabricated id
  // would FK-violate, which is exactly the regression this step guards against.
  await step("manual disconnect by a real signed-in admin → audit changedBy == that user id", async () => {
    await runInIsolatedSchema(
      async ({ db }) => {
        await db.execute(
          sql`ALTER TABLE admin_setting_audit ADD CONSTRAINT iso_asa_changed_by_fk FOREIGN KEY (changed_by) REFERENCES users(id)`,
        );
        await db.execute(
          sql`ALTER TABLE system_settings ADD CONSTRAINT iso_ss_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id)`,
        );
        const adminId = `u-2282-pandadoc-${Date.now()}`;
        await getDb().insert(users).values({ id: adminId, email: `${adminId}@test.local` });

        await setApiKey("pd-actor-fake", adminId);
        assert.equal(await getKeyValue(), "pd-actor-fake");
        await disconnect(adminId, { trigger: "manual_disconnect" });
        assert.equal(await getKeyValue(), "", "key must be cleared on a real-admin disconnect");

        const rows = await storage.listAdminSettingAudit({
          settingKey: PANDADOC_API_KEY_SETTING_KEY,
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
  console.log("\nAll PandaDoc connect handler tests passed");
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
      if (originalPandadocKey === undefined) {
        await storage.deleteSystemSetting(PANDADOC_API_KEY_SETTING_KEY);
      } else {
        await storage.setSystemSetting(PANDADOC_API_KEY_SETTING_KEY, originalPandadocKey ?? "", "system");
      }
    } catch {}
    process.exitCode = exitCode;
  });
