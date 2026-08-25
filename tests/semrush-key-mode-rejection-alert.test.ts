/* test-registration
{
  "name": "SEMrush key-mode rejected-key alert (Task #3672)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3672: key-mode rejected-key alert — a key-mode 401/403 must throw SemrushApiKeyRejectedError (never wipe OAuth tokens, POST a refresh, or prompt device flow) and the once-per-streak alert must fire at the consecutive threshold, re-arm on success, and honor its kill switch. Fetch + dispatcher fully stubbed, fast; a drift here re-opens the silent-stale-heatmap outage class the alert exists to catch.",
  "tier": "small"
}
test-registration */
/**
 * Task #3672 — smoke coverage for the SEMrush key-mode rejected-key alert
 * (`server/services/semrushKeyModeAlert.ts`, wired into
 * `server/services/semrushApi.ts`).
 *
 * In key mode (Task #3670) the OAuth disconnect alert and auth-dead breaker
 * are dormant by design, so a revoked/expired SEMRUSH_V4_API_KEY would
 * previously fail every call with `SemrushApiKeyRejectedError` without
 * paging anyone — the only symptom would be quietly stale heatmap data.
 *
 * Locks the following behavior in place:
 *   1. A key-mode 401 throws `SemrushApiKeyRejectedError` whose message
 *      points at the SEMRUSH_V4_API_KEY secret, NEVER at OAuth reconnect,
 *      and the call authenticates with `Authorization: Apikey` (no Bearer).
 *   2. A key-mode 401 never wipes the stored OAuth tokens, never POSTs to
 *      any oauth.semrush.com endpoint (no refresh, no device flow), and
 *      never trips the OAuth auth-dead breaker.
 *   3. The alert fires exactly ONCE per rejection streak, only after
 *      SEMRUSH_KEY_REJECTED_ALERT_THRESHOLD consecutive rejections, with the
 *      registered notification id + dedupeKey='global'.
 *   4. A successful key-mode call resets the streak, calls markRecovered,
 *      and re-arms the alert so the next streak fires again.
 *   5. The kill switch (`kill_switch_semrush_key_rejected_alert` = "false")
 *      suppresses delivery.
 *   6. Outside key mode the recorder is dormant (no alert from OAuth-path
 *      signals — that path has its own alert).
 *
 * `global.fetch` is monkey-patched so the suite never hits real SEMrush.
 * Shared-DB settings the suite reads or writes are snapshotted and restored.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import { getCampaign, SemrushApiKeyRejectedError } from "../server/services/semrushApi";
import { __setSemrushKeyModeOverrideForTest } from "../server/services/semrushAuthMode";
import {
  recordSemrushKeyModeRejection,
  onSemrushKeyModeCallSucceeded,
  SEMRUSH_KEY_REJECTED_ALERT_THRESHOLD,
  KILL_SWITCH_SEMRUSH_KEY_REJECTED_ALERT,
  __drainSemrushKeyModeAlertForTest,
  __getSemrushKeyModeAlertKeysForTest,
  __resetSemrushKeyModeAlertForTest,
  __setKeyModeDispatcherForTest,
  __resetKeyModeDispatcherForTest,
} from "../server/services/semrushKeyModeAlert";
import {
  __resetSemrushAuthBreakerForTest,
  semrushAuthBreakerActive,
} from "../server/services/semrushAuthBreaker";

const SETTINGS_KEY_ACCESS = "semrush_access_token";
const SETTINGS_KEY_REFRESH = "semrush_refresh_token";
const SETTINGS_KEY_EXPIRES = "semrush_token_expires_at";

const originalFetch = global.fetch;

// ── Fetch stub ───────────────────────────────────────────────────────────────
let apiStatus = 401;
let apiCalls = 0;
let oauthCalls = 0;
let lastAuthHeader: string | null = null;

function installFetchStub(): void {
  global.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (url.includes("oauth.semrush.com")) {
      oauthCalls++;
      return new Response(JSON.stringify({ error: "should_never_be_called" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("api.semrush.com")) {
      apiCalls++;
      const headers = new Headers(init?.headers ?? {});
      lastAuthHeader = headers.get("authorization");
      if (apiStatus === 200) {
        return new Response(JSON.stringify({ data: { id: "camp-1", reportDates: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unauthorized", { status: apiStatus });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

// ── Dispatcher capture ───────────────────────────────────────────────────────
let notifyCalls: Array<{ id: string; dedupeKey: string | null; text: string }> = [];
let recoverCalls: Array<{ id: string; key: string }> = [];

function installDispatcherStub(): void {
  __setKeyModeDispatcherForTest(
    (async (id: string, payload: any, opts: any) => {
      notifyCalls.push({
        id,
        dedupeKey: opts?.dedupeKey ?? null,
        text: typeof payload?.text === "string" ? payload.text : "",
      });
      return { ok: true, deliveryId: null };
    }) as any,
    (async (id: string, key: string) => {
      recoverCalls.push({ id, key });
    }) as any,
  );
}

// ── Harness ──────────────────────────────────────────────────────────────────
let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  __resetSemrushKeyModeAlertForTest();
  __resetSemrushAuthBreakerForTest();
  __setSemrushKeyModeOverrideForTest(true);
  apiStatus = 401;
  apiCalls = 0;
  oauthCalls = 0;
  lastAuthHeader = null;
  notifyCalls = [];
  recoverCalls = [];
  installDispatcherStub();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    __resetKeyModeDispatcherForTest();
    __setSemrushKeyModeOverrideForTest(null);
    __resetSemrushKeyModeAlertForTest();
    __resetSemrushAuthBreakerForTest();
  }
}

async function expectThrows(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw, but it resolved");
}

async function snapshot(key: string): Promise<string | null | undefined> {
  const row = await storage.getSystemSetting(key).catch(() => null);
  return row ? row.value ?? null : undefined;
}
async function restore(key: string, prior: string | null | undefined): Promise<void> {
  if (prior === undefined) await storage.deleteSystemSetting(key).catch(() => {});
  else await storage.setSystemSetting(key, prior ?? "", "system").catch(() => {});
}

let priorAccess: string | null | undefined;
let priorRefresh: string | null | undefined;
let priorExpires: string | null | undefined;
let priorKillSwitch: string | null | undefined;

async function main(): Promise<void> {
  console.log("SEMrush key-mode rejected-key alert tests (Task #3672)\n");

  // Pin every shared-DB setting this suite reads or writes (restored in finally).
  priorAccess = await snapshot(SETTINGS_KEY_ACCESS);
  priorRefresh = await snapshot(SETTINGS_KEY_REFRESH);
  priorExpires = await snapshot(SETTINGS_KEY_EXPIRES);
  priorKillSwitch = await snapshot(KILL_SWITCH_SEMRUSH_KEY_REJECTED_ALERT);
  await storage.deleteSystemSetting(KILL_SWITCH_SEMRUSH_KEY_REJECTED_ALERT).catch(() => {});

  installFetchStub();
  process.env.SEMRUSH_V4_API_KEY = process.env.SEMRUSH_V4_API_KEY || "test-key-3672";

  const { notificationId, dedupeKey } = __getSemrushKeyModeAlertKeysForTest();

  await step("key-mode 401 throws SemrushApiKeyRejectedError pointing at the secret, Apikey header, no OAuth traffic", async () => {
    // Seed OAuth tokens so a wipe would be observable.
    const marker = `keep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await storage.setSystemSetting(SETTINGS_KEY_ACCESS, `access-${marker}`, "system");
    await storage.setSystemSetting(SETTINGS_KEY_REFRESH, `refresh-${marker}`, "system");
    await storage.setSystemSetting(SETTINGS_KEY_EXPIRES, String(Date.now() + 3_600_000), "system");

    const err = await expectThrows(() => getCampaign("camp-3672"));
    assert.equal(err.name, "SemrushApiKeyRejectedError", "must throw SemrushApiKeyRejectedError");
    assert.ok(err instanceof SemrushApiKeyRejectedError, "instanceof holds");
    assert.match(err.message, /SEMRUSH_V4_API_KEY/, "message must point at the secret");
    assert.doesNotMatch(err.message, /re-authorize|Integrations Hub|device/i, "message must not prompt OAuth reconnect or device flow");
    assert.match(lastAuthHeader ?? "", /^Apikey /, "request must authenticate with Apikey, not Bearer");
    assert.equal(oauthCalls, 0, "no refresh POST and no device-flow call may fire on a key-mode 401");
    assert.equal(semrushAuthBreakerActive(), false, "OAuth auth-dead breaker must stay closed");

    // Stored OAuth tokens survive untouched (no wipe).
    assert.equal((await snapshot(SETTINGS_KEY_ACCESS)) ?? null, `access-${marker}`, "access token must not be wiped");
    assert.equal((await snapshot(SETTINGS_KEY_REFRESH)) ?? null, `refresh-${marker}`, "refresh token must not be wiped");
  });

  await step("alert fires exactly once per streak, only at the consecutive threshold", async () => {
    for (let i = 1; i < SEMRUSH_KEY_REJECTED_ALERT_THRESHOLD; i++) {
      await expectThrows(() => getCampaign("camp-3672"));
      assert.equal(notifyCalls.length, 0, `no alert before threshold (rejection ${i})`);
    }
    await expectThrows(() => getCampaign("camp-3672"));
    assert.equal(notifyCalls.length, 1, "alert fires at the threshold");
    assert.equal(notifyCalls[0].id, notificationId, "registered notification id");
    assert.equal(notifyCalls[0].dedupeKey, dedupeKey, "dedupeKey='global'");
    assert.match(notifyCalls[0].text, /SEMRUSH_V4_API_KEY/, "alert body names the secret to rotate");
    assert.match(notifyCalls[0].text, /republish/i, "alert body says to republish");

    // Further rejections within the same streak stay silent.
    await expectThrows(() => getCampaign("camp-3672"));
    await expectThrows(() => getCampaign("camp-3672"));
    assert.equal(notifyCalls.length, 1, "no repeat delivery within the same streak");
  });

  await step("a success resets the streak, marks recovered, and re-arms the alert", async () => {
    for (let i = 0; i < SEMRUSH_KEY_REJECTED_ALERT_THRESHOLD; i++) {
      await expectThrows(() => getCampaign("camp-3672"));
    }
    assert.equal(notifyCalls.length, 1, "first streak fired");

    apiStatus = 200;
    const campaign = await getCampaign("camp-3672");
    assert.equal(campaign?.id, "camp-1", "successful key-mode call returns data");
    await __drainSemrushKeyModeAlertForTest();
    assert.equal(recoverCalls.length, 1, "markRecovered called once on recovery");
    assert.equal(recoverCalls[0].id, notificationId, "recovery uses the registered id");
    assert.equal(recoverCalls[0].key, dedupeKey, "recovery uses dedupeKey='global'");

    // Streak re-armed: a fresh run of rejections fires again.
    apiStatus = 403;
    for (let i = 0; i < SEMRUSH_KEY_REJECTED_ALERT_THRESHOLD; i++) {
      await expectThrows(() => getCampaign("camp-3672"));
    }
    assert.equal(notifyCalls.length, 2, "second streak re-fires after recovery");
    assert.match(notifyCalls[1].text, /HTTP 403/, "403 is surfaced like 401");
  });

  await step("interleaved success below the threshold keeps the counter consecutive", async () => {
    await expectThrows(() => getCampaign("camp-3672"));
    await expectThrows(() => getCampaign("camp-3672"));
    apiStatus = 200;
    await getCampaign("camp-3672");
    apiStatus = 401;
    await expectThrows(() => getCampaign("camp-3672"));
    await expectThrows(() => getCampaign("camp-3672"));
    assert.equal(notifyCalls.length, 0, "counter must reset on success — 2+2 non-consecutive rejections never alert");
    await expectThrows(() => getCampaign("camp-3672"));
    assert.equal(notifyCalls.length, 1, "third consecutive rejection after the reset alerts");
  });

  await step("kill switch OFF suppresses delivery", async () => {
    await storage.setSystemSetting(KILL_SWITCH_SEMRUSH_KEY_REJECTED_ALERT, "false", "system");
    try {
      for (let i = 0; i < SEMRUSH_KEY_REJECTED_ALERT_THRESHOLD + 1; i++) {
        await recordSemrushKeyModeRejection(401, "/campaigns/x");
      }
      assert.equal(notifyCalls.length, 0, "kill switch must suppress the notify call");
    } finally {
      await storage.deleteSystemSetting(KILL_SWITCH_SEMRUSH_KEY_REJECTED_ALERT).catch(() => {});
    }
  });

  await step("Hub state getter tracks the streak and clears on success (Task #3690)", async () => {
    const { getSemrushKeyModeRejectionState } = await import(
      "../server/services/semrushKeyModeAlert"
    );
    let s = getSemrushKeyModeRejectionState();
    assert.equal(s.consecutiveRejections, 0, "starts at zero");
    assert.equal(s.keyRejected, false, "not rejected initially");
    assert.equal(s.lastRejectionAt, null, "no rejection time initially");

    for (let i = 0; i < SEMRUSH_KEY_REJECTED_ALERT_THRESHOLD; i++) {
      await expectThrows(() => getCampaign("camp-3690"));
    }
    s = getSemrushKeyModeRejectionState();
    assert.equal(s.consecutiveRejections, SEMRUSH_KEY_REJECTED_ALERT_THRESHOLD, "counter matches streak");
    assert.equal(s.keyRejected, true, "keyRejected flips at the threshold");
    assert.equal(s.streakAlertFired, true, "alert-fired flag surfaces");
    assert.equal(s.lastRejectionStatus, 401, "last rejection status recorded");
    assert.ok(s.lastRejectionAt && !Number.isNaN(Date.parse(s.lastRejectionAt)), "last rejection time is a valid ISO timestamp");

    apiStatus = 200;
    await getCampaign("camp-3690");
    await __drainSemrushKeyModeAlertForTest();
    s = getSemrushKeyModeRejectionState();
    assert.equal(s.consecutiveRejections, 0, "success resets counter");
    assert.equal(s.keyRejected, false, "keyRejected clears on success");
    assert.equal(s.streakAlertFired, false, "alert flag re-armed");
    assert.equal(s.lastRejectionAt, null, "rejection time cleared");
    assert.equal(s.lastRejectionStatus, null, "rejection status cleared");
  });

  await step("dormant outside key mode", async () => {
    __setSemrushKeyModeOverrideForTest(false);
    for (let i = 0; i < SEMRUSH_KEY_REJECTED_ALERT_THRESHOLD + 1; i++) {
      await recordSemrushKeyModeRejection(401, "/campaigns/x");
    }
    assert.equal(notifyCalls.length, 0, "OAuth-mode signals must never fire the key alert");
    onSemrushKeyModeCallSucceeded();
    await __drainSemrushKeyModeAlertForTest();
    assert.equal(recoverCalls.length, 0, "no recovery call when nothing fired");
  });

  if (failures > 0) {
    throw new Error(`${failures} test(s) failed`);
  }
  console.log("\nAll SEMrush key-mode rejected-key alert tests passed");
}

let exitCode = 0;
main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    exitCode = 1;
  })
  .finally(async () => {
    global.fetch = originalFetch;
    await restore(SETTINGS_KEY_ACCESS, priorAccess);
    await restore(SETTINGS_KEY_REFRESH, priorRefresh);
    await restore(SETTINGS_KEY_EXPIRES, priorExpires);
    await restore(KILL_SWITCH_SEMRUSH_KEY_REJECTED_ALERT, priorKillSwitch);
    process.exitCode = exitCode;
  });
