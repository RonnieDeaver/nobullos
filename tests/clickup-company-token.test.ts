/* test-registration
{
  "name": "ClickUp company token — DB-override→env accessor precedence/TTL/failed-read-fallback/write-through, rotation reaches the directory Authorization header with no restart, pure Test-connection probe, auth-dead alert grace/threshold/once-per-streak/kill-switch/re-arm (Task #3662)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3662: ClickUp COMPANY token runtime rotation — the accessor precedence (DB override → env), failed-read last-known fallback, the rotation actually reaching the directory fetch's Authorization header, probe purity, and the auth-dead alert streak semantics. Injected store + dispatcher, fetch stubbed, DB-free, fast. This is the fix for the twice- repeated prod outage class (stale env-secret snapshot → silent directory 401 → wrong dashboard names); a drift here reopens it silently.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3662 — ClickUp COMPANY token runtime rotation + auth-dead alerting.
 *
 * Covers, hermetically (injected settings store, injected dispatcher +
 * kill-switch reader, stubbed global.fetch — no DB, no network, no timers):
 *  (a) accessor precedence DB override → env fallback → none, short-TTL
 *      cache + invalidation, TTL=0 re-reads, failed-read → last-known/env
 *      (never a false "unconfigured"), write-through set/clear + audit
 *      breadcrumbs (event only, never the value);
 *  (b) directory + probe wiring: the resolved token reaches the actual
 *      Authorization header, a mid-process rotation takes effect on the next
 *      fetch with NO restart, unconfigured serves stale without fetching;
 *  (c) fetch outcomes dispatch to the alert hooks; probeClientList is PURE
 *      (no cache/liveness/lastError/alert mutations, candidate token used);
 *  (d) directoryHealth reports tokenSource + rotation-hint reasons;
 *  (e) alert module semantics: 401 grace anchor, transient consecutive
 *      threshold, once-per-streak, kill switch (suppresses without consuming
 *      the streak), success re-arms via markRecovered.
 */

import { strict as assert } from "node:assert";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

// Env BEFORE imports: config constants are read at module load.
const ENV_TOKEN = "pk_env_fallback_1234567890";
const DB_TOKEN = "pk_db_override_abcdefghij";
process.env.CLICKUP_API_TOKEN = ENV_TOKEN;

// ── global.fetch stub (ClickUp only; anything else = test bug) ──────────────
let lastAuthHeader: string | null = null;
let clickupStatus = 200;
let fetchCount = 0;
const clickupBody = {
  last_page: true,
  tasks: [{ id: "t1", name: "Acme Law", status: { status: "active" }, custom_fields: [] }],
};
const realFetch = global.fetch;
global.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  let pathname = "";
  try { pathname = new URL(u).pathname; } catch {}
  if (!pathname.startsWith("/api/v2/")) throw new Error(`unexpected fetch in test: ${u}`);
  if (isClickUpListFieldPath(pathname)) {
    lastAuthHeader = init?.headers?.Authorization ?? null;
    if (clickupStatus !== 200) {
      return new Response(JSON.stringify({ err: "Oauth token not found" }), {
        status: clickupStatus,
      });
    }
    return new Response(JSON.stringify(EMPTY_CLICKUP_PRACTICE_AREA_FIELDS), {
      status: 200,
    });
  }
  fetchCount++;
  lastAuthHeader = init?.headers?.Authorization ?? null;
  if (clickupStatus !== 200) {
    return new Response(JSON.stringify({ err: "Oauth token not found" }), { status: clickupStatus });
  }
  return new Response(JSON.stringify(clickupBody), { status: 200 });
}) as any;

async function main() {
  const tok = await import("../server/services/clickUpCompanyToken");

  // Injected store — the real settingsStorage/DB is never touched.
  let dbValue: string | null = null;
  let getCalls = 0;
  let getShouldThrow = false;
  const setCalls: Array<{ key: string; value: string; updatedBy?: string }> = [];
  let delCalls = 0;
  const audits: Array<{ event: string; changedBy: string | null }> = [];
  const store = {
    async get(key: string) {
      getCalls++;
      if (getShouldThrow) throw new Error("settings read blew up");
      assert.equal(key, tok.CLICKUP_COMPANY_TOKEN_SETTING_KEY);
      return dbValue === null
        ? undefined
        : { value: dbValue, updatedAt: new Date("2026-07-30T00:00:00Z"), updatedBy: "user-1" };
    },
    async set(key: string, value: string, updatedBy?: string) {
      setCalls.push({ key, value, updatedBy });
      dbValue = value;
    },
    async del() {
      delCalls++;
      dbValue = null;
    },
    async recordAudit(event: "set" | "cleared", changedBy: string | null) {
      audits.push({ event, changedBy });
    },
  };
  tok.__setClickUpCompanyTokenStoreForTest(store);

  // ── (a) accessor precedence + caching ─────────────────────────────────────
  dbValue = DB_TOKEN;
  let r = await tok.resolveClickUpCompanyToken();
  assert.deepEqual(r, { token: DB_TOKEN, source: "db" }, "DB override wins over env");
  assert.equal(getCalls, 1, "first resolve reads the store");
  r = await tok.resolveClickUpCompanyToken();
  assert.equal(getCalls, 1, "within TTL: cached, no re-read");
  tok.invalidateClickUpCompanyTokenCache();
  await tok.resolveClickUpCompanyToken();
  assert.equal(getCalls, 2, "invalidate forces a re-read");

  dbValue = null;
  tok.invalidateClickUpCompanyTokenCache();
  r = await tok.resolveClickUpCompanyToken();
  assert.deepEqual(r, { token: ENV_TOKEN, source: "env" }, "no override → env fallback");

  delete process.env.CLICKUP_API_TOKEN;
  tok.invalidateClickUpCompanyTokenCache();
  r = await tok.resolveClickUpCompanyToken();
  assert.deepEqual(r, { token: "", source: "none" }, "no override + no env → none");
  process.env.CLICKUP_API_TOKEN = ENV_TOKEN;

  // TTL=0 disables the cache — every resolve re-reads (used for the rest of
  // the suite so store flips take effect immediately, like TTL expiry does).
  tok.__setClickUpCompanyTokenTtlForTest(0);
  dbValue = DB_TOKEN;
  const beforeCalls = getCalls;
  await tok.resolveClickUpCompanyToken();
  await tok.resolveClickUpCompanyToken();
  assert.equal(getCalls, beforeCalls + 2, "TTL 0: each resolve re-reads the store");

  // Failed read: last-known snapshot wins (never a false "no token").
  getShouldThrow = true;
  r = await tok.resolveClickUpCompanyToken();
  assert.deepEqual(r, { token: DB_TOKEN, source: "db" }, "failed read serves the last-known token");
  // Failed read with NO snapshot: env fallback.
  tok.__setClickUpCompanyTokenStoreForTest(store); // clears the snapshot cache
  r = await tok.resolveClickUpCompanyToken();
  assert.deepEqual(r, { token: ENV_TOKEN, source: "env" }, "failed read + no snapshot → env fallback");
  getShouldThrow = false;

  // Write-through set: trimmed, attributed, snapshot updated immediately.
  await tok.setClickUpCompanyToken("  pk_new_rotated_token_00001  ", "user-42");
  assert.deepEqual(setCalls.at(-1), {
    key: tok.CLICKUP_COMPANY_TOKEN_SETTING_KEY,
    value: "pk_new_rotated_token_00001",
    updatedBy: "user-42",
  });
  assert.deepEqual(
    tok.getClickUpCompanyTokenSnapshot(),
    { token: "pk_new_rotated_token_00001", source: "db" },
    "set() is write-through to the in-process snapshot",
  );
  assert.deepEqual(audits.at(-1), { event: "set", changedBy: "user-42" }, "audit records event, not value");
  await assert.rejects(() => tok.setClickUpCompanyToken("   "), /empty/);

  // Clear: reverts to env; synthetic "system" actor audited as null.
  await tok.clearClickUpCompanyToken("system");
  assert.equal(delCalls, 1);
  assert.deepEqual(audits.at(-1), { event: "cleared", changedBy: null });
  assert.deepEqual(tok.getClickUpCompanyTokenSnapshot(), { token: ENV_TOKEN, source: "env" });

  // Status: source + metadata, NEVER the token value.
  dbValue = DB_TOKEN;
  const status = await tok.getClickUpCompanyTokenStatus();
  assert.equal(status.source, "db");
  assert.equal(status.dbOverride, true);
  assert.equal(status.envPresent, true);
  assert.equal(status.updatedAt, "2026-07-30T00:00:00.000Z");
  assert.ok(!JSON.stringify(status).includes(DB_TOKEN), "status payload never contains the token");

  // Config-level gates reflect the accessor.
  const cfg = await import("../server/services/adsOs/config");
  assert.equal(cfg.isClickUpConfigured(), true);
  assert.equal(await cfg.isClickUpConfiguredAsync(), true);
  assert.equal(cfg.clickUpTokenSource(), "db");

  // ── (b) directory wiring ──────────────────────────────────────────────────
  const dir = await import("../server/services/adsOs/clickUpDirectory");
  const alertEvents: Array<{ ok: boolean; httpStatus?: number | null; message?: string }> = [];
  dir.__setDirectoryAlertHooksForTest({
    onSuccess: async () => {
      alertEvents.push({ ok: true });
    },
    onFailure: async (info) => {
      alertEvents.push({ ok: false, httpStatus: info.httpStatus, message: info.message });
    },
  });
  dir.__testResetDirectoryCache();

  dbValue = DB_TOKEN;
  let bundle = await dir.getClientDirectory({ force: true });
  assert.equal(lastAuthHeader, DB_TOKEN, "directory fetch sends the DB override token");
  assert.equal(bundle.blocks.length, 1);

  dbValue = "pk_rotated_mid_process_99";
  bundle = await dir.getClientDirectory({ force: true });
  assert.equal(
    lastAuthHeader,
    "pk_rotated_mid_process_99",
    "a rotation takes effect on the next fetch — no restart, no republish",
  );

  dbValue = null;
  await dir.getClientDirectory({ force: true });
  assert.equal(lastAuthHeader, ENV_TOKEN, "cleared override falls back to the env token");

  // Unconfigured: no fetch attempted, stale bundle still served for display.
  delete process.env.CLICKUP_API_TOKEN;
  const fcBefore = fetchCount;
  const served = await dir.getClientDirectory({ force: true });
  assert.equal(fetchCount, fcBefore, "no token → no fetch attempted");
  assert.ok(served.blocks.length >= 1, "stale bundle still served when unconfigured");
  await assert.rejects(
    () => dir.getClientDirectory({ force: true, throwOnError: true }),
    /No ClickUp company token/,
    "proof mode surfaces the unconfigured state explicitly",
  );
  process.env.CLICKUP_API_TOKEN = ENV_TOKEN;

  // ── (c) alert dispatch wiring + probe purity ─────────────────────────────
  await dir.__test_drainDirectoryAlertWork();
  assert.ok(alertEvents.filter((e) => e.ok).length >= 3, "each successful fetch dispatched onSuccess");

  clickupStatus = 401;
  await dir.getClientDirectory({ force: true }); // swallowed → serves stale
  await dir.__test_drainDirectoryAlertWork();
  const lastFail = alertEvents.at(-1)!;
  assert.equal(lastFail.ok, false);
  assert.equal(lastFail.httpStatus, 401, "failure dispatch carries the HTTP status");
  assert.ok(String(lastFail.message).includes("401"));
  clickupStatus = 200;

  // 401-failure reason carries the rotation hint.
  let health = dir.directoryHealth();
  assert.equal(health.live, false);
  assert.ok(
    String(health.reason).includes("Integrations Hub"),
    "401 reason points the operator at Hub rotation (no republish)",
  );
  assert.equal(health.tokenSource, "env", "health reports the active token source");

  // Probe: candidate token used; ZERO directory-state mutation either way.
  dir.__testResetDirectoryCache();
  const evBefore = alertEvents.length;
  const probe = await dir.probeClientList("pk_candidate_zzzzzzzzzzz");
  assert.equal(lastAuthHeader, "pk_candidate_zzzzzzzzzzz", "probe uses the candidate token");
  assert.equal(probe.clients, 1);
  health = dir.directoryHealth();
  assert.equal(health.lastSuccessAt, null, "successful probe does NOT touch directory state");
  assert.equal(health.lastError, null);
  clickupStatus = 401;
  await assert.rejects(
    () => dir.probeClientList("pk_candidate_zzzzzzzzzzz"),
    (e: any) => e?.status === 401 && /401/.test(String(e?.message)),
    "probe surfaces the exact ClickUp error to the caller",
  );
  health = dir.directoryHealth();
  assert.equal(health.lastError, null, "failed probe does NOT set lastError");
  clickupStatus = 200;
  await dir.__test_drainDirectoryAlertWork();
  assert.equal(alertEvents.length, evBefore, "probes never dispatch alert hooks");

  // Unconfigured health reason names the Hub path (not "republish").
  delete process.env.CLICKUP_API_TOKEN;
  dbValue = null;
  tok.__setClickUpCompanyTokenStoreForTest(store); // drop snapshot → source none
  health = dir.directoryHealth();
  assert.equal(health.configured, false);
  assert.equal(health.tokenSource, "none");
  assert.ok(String(health.reason).includes("No ClickUp company token"));
  assert.ok(!String(health.reason).includes("republish after updating secrets"));
  process.env.CLICKUP_API_TOKEN = ENV_TOKEN;

  // ── (e) alert module semantics ────────────────────────────────────────────
  const alert = await import("../server/services/adsOs/clickUpDirectoryAlert");
  const notifies: Array<{ id: string; text: string; options: any }> = [];
  const recoveries: Array<{ id: string; dedupeKey: string }> = [];
  alert.__setClickUpDirectoryAlertDispatcherForTest(
    (async (id: string, payload: any, options: any) => {
      notifies.push({ id, text: String(payload?.text ?? ""), options });
      return { ok: true } as any;
    }) as any,
    (async (id: string, dedupeKey: string) => {
      recoveries.push({ id, dedupeKey });
    }) as any,
  );
  let killValue: string | null = null;
  alert.__setClickUpDirectoryAlertSettingReaderForTest(async () =>
    killValue === null ? undefined : { value: killValue },
  );
  alert.__resetClickUpDirectoryAlertForTest();

  const keys = alert.__getClickUpDirectoryAlertKeysForTest();
  assert.equal(keys.notificationId, "integration.clickup.ads_os_directory_down");
  assert.equal(keys.dedupeKey, "global");

  const authFail = {
    httpStatus: 401,
    message: "ClickUp GET /list/x → HTTP 401: Oauth token not found",
    errorClass: "ClickUpHttpError",
    listId: "901417549202",
  };
  const transientFail = { ...authFail, httpStatus: 500, message: "HTTP 500: boom" };

  // 401 grace: first failure inside the window stays silent.
  alert.__setClickUpDirectoryAlertTuningForTest({ authGraceMs: 60_000, transientThreshold: 99 });
  await alert.onClickUpDirectoryFetchFailure(authFail);
  assert.equal(notifies.length, 0, "401 within grace → no alert");
  // Grace elapsed (anchor already set; drop grace to zero).
  alert.__setClickUpDirectoryAlertTuningForTest({ authGraceMs: 0 });
  await alert.onClickUpDirectoryFetchFailure(authFail);
  assert.equal(notifies.length, 1, "401 past grace → alert fires");
  assert.equal(notifies[0].id, keys.notificationId);
  assert.equal(notifies[0].options.dedupeKey, "global");
  assert.equal(notifies[0].options.triggerSource, "scheduled");
  assert.ok(notifies[0].text.includes("Integrations Hub"), "alert tells the operator to rotate via the Hub");
  assert.ok(notifies[0].text.includes("Oauth token not found"), "alert carries the exact ClickUp error");
  assert.ok(
    !notifies[0].text.includes(DB_TOKEN) && !notifies[0].text.includes(ENV_TOKEN),
    "alert text never contains a token",
  );
  // Once per streak.
  await alert.onClickUpDirectoryFetchFailure(authFail);
  assert.equal(notifies.length, 1, "at most one alert per outage streak");
  // Recovery re-arms and marks recovered.
  await alert.onClickUpDirectoryFetchSuccess();
  assert.deepEqual(recoveries, [{ id: keys.notificationId, dedupeKey: "global" }]);
  await alert.onClickUpDirectoryFetchFailure(authFail); // grace 0 → immediate
  assert.equal(notifies.length, 2, "next outage after recovery alerts again");
  await alert.onClickUpDirectoryFetchSuccess();
  await alert.onClickUpDirectoryFetchSuccess();
  assert.equal(recoveries.length, 2, "healthy → healthy success does not re-mark recovered");

  // Transient threshold: 3 consecutive non-auth failures.
  alert.__resetClickUpDirectoryAlertForTest();
  alert.__setClickUpDirectoryAlertTuningForTest({ authGraceMs: 99_999_999, transientThreshold: 3 });
  notifies.length = 0;
  await alert.onClickUpDirectoryFetchFailure(transientFail);
  await alert.onClickUpDirectoryFetchFailure(transientFail);
  assert.equal(notifies.length, 0, "below the consecutive threshold → silent");
  await alert.onClickUpDirectoryFetchFailure(transientFail);
  assert.equal(notifies.length, 1, "3rd consecutive transient failure alerts");
  assert.ok(notifies[0].text.includes("3 consecutive"), "transient alert names the streak length");

  // Kill switch suppresses WITHOUT consuming the streak.
  alert.__resetClickUpDirectoryAlertForTest();
  alert.__setClickUpDirectoryAlertTuningForTest({ authGraceMs: 0, transientThreshold: 99 });
  notifies.length = 0;
  killValue = "false";
  await alert.onClickUpDirectoryFetchFailure(authFail);
  assert.equal(notifies.length, 0, "kill switch OFF → no alert");
  assert.equal(
    alert.__getClickUpDirectoryAlertStateForTest().streakAlertFired,
    false,
    "suppressed alert does not mark the streak as fired",
  );
  killValue = null;
  await alert.onClickUpDirectoryFetchFailure(authFail);
  assert.equal(notifies.length, 1, "switch re-enabled mid-streak → alert still fires");

  // Cleanup.
  alert.__resetClickUpDirectoryAlertDispatcherForTest();
  alert.__resetClickUpDirectoryAlertForTest();
  dir.__testResetDirectoryCache();
  dir.__setDirectoryAlertHooksForTest(null);
  tok.__resetClickUpCompanyTokenForTest();
  global.fetch = realFetch;
  console.log("clickup-company-token: all assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
