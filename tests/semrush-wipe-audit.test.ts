/* test-registration
{
  "name": "SEMrush automatic-wipe durable audit breadcrumbs + operator alert (Task #3109)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #3109 — SEMrush automatic-wipe durable audit breadcrumbs.
 *
 * The July 17 2026 production incident showed that automatic token wipes (and
 * every wipe_skipped / wipe_aborted decision) left no durable trace — only a
 * console.warn that expired with the deployment log retention window. This
 * suite locks the three new `admin_setting_audit` breadcrumbs introduced by
 * Task #3109 into the regression gate so a future refactor cannot remove them
 * silently:
 *
 *   1. wipe_skipped — non-authoritative caller (probe/proactive) hits a
 *      terminal refresh: tokens must NOT be cleared AND a scoped audit row
 *      with event=token_wipe_skipped must be written.
 *
 *   2. wipe_aborted — authoritative caller but the stored refresh token
 *      CHANGED fingerprint since the last POST (sibling rotated it in the
 *      wipe window): tokens must NOT be cleared AND a scoped audit row with
 *      event=token_wipe_aborted carrying both fingerprints must be written.
 *
 *   3. wipe — authoritative caller, stored refresh token fingerprint
 *      UNCHANGED (genuine revocation): tokens MUST be cleared, a scoped
 *      audit row with event=token_wiped must be written, AND the operator
 *      alert must fire via the injected notifyByType override.
 *
 *   4. denylist coverage — SETTINGS_CACHE_DENYLIST includes every SEMrush
 *      token key so no Redis-cached stale read can drive a false wipe.
 *
 * Implementation notes (Task #3109):
 *   SEMrush OAuth (Device Flow, POST https://oauth.semrush.com/dag/device/token):
 *   - 7-day access token, 30-day rotating refresh token.
 *   - Rotation semantics: refresh token rotated on every successful refresh;
 *     presenting an already-consumed refresh token returns 400 invalid_request
 *     (SEMrush uses invalid_request instead of the OAuth-spec invalid_grant).
 *   - All of invalid_request / invalid_grant / invalid_client /
 *     unauthorized_client are treated as terminal (no retry budget).
 *   - The stale-cached-token root cause: getSystemSetting was read-through
 *     Redis (5-min TTL in prod since May 24) but SEMrush token keys are now
 *     in SETTINGS_CACHE_DENYLIST → always direct DB reads (case 4).
 *
 * Sibling integration audit (Task #3109 Step 6 — findings for follow-up):
 *   Front: front_access_token, front_refresh_token, front_token_expires_at,
 *          front_oauth_state → all in SETTINGS_CACHE_DENYLIST. ✓
 *   Google Ads: Task #4008 — credentials moved to the GOOGLE_ADS_* env
 *          secrets (connection table + in-app OAuth flow retired); nothing
 *          token-bearing in system_settings. Legacy nonce-shaped keys would
 *          still bypass the cache via the `_oauth_nonce` suffix net. ✓
 *   Replit Auth: session tokens are session-scoped; no system_settings key.
 *   Twilio: twilio_auth_token, twilio_api_key_secret → in SETTINGS_CACHE_DENYLIST. ✓
 *   Stripe: stripe_secret_key → in SETTINGS_CACHE_DENYLIST. ✓
 *   Slack: slack_bot_token → in SETTINGS_CACHE_DENYLIST. ✓
 *
 * Pure in-memory: storage methods and fetch are stubbed via the (storage as any)
 * pattern. getSystemSettingFresh is also stubbed so the wipe-confirmation
 * re-read returns a controlled value without hitting the DB.
 * NODE_ENV=test disables the cross-process refresh lease.
 */
import { strict as assert } from "node:assert";

process.env.NODE_ENV = "test";

import { storage } from "../server/storage";
import {
  SETTINGS_CACHE_DENYLIST,
  isSettingsCacheDenylisted,
} from "../server/storage/settingsStorage";
import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import {
  __refreshAccessTokenForTest,
  __setWipeNotifyOverrideForTest,
  __resetSemrushWipeAuditWriteFailedCountForTest,
  getSemrushWipeAuditWriteFailedCount,
} from "../server/services/semrushApi";
import {
  __resetSemrushAuthBreakerForTest,
  __clearPersistedSemrushAuthBreakerForTest,
} from "../server/services/semrushAuthBreaker";

// Task #3666 — endpoint changed from /dag/device/token to /oauth2/access_token.
const OAUTH_TOKEN_URL = "https://oauth.semrush.com/oauth2/access_token";

const REFRESH_KEY = "semrush_refresh_token";
const ACCESS_KEY = "semrush_access_token";
const EXPIRES_KEY = "semrush_token_expires_at";

const CAPTURED_REFRESH = "rt-captured-dead";
const ROTATED_REFRESH = "rt-rotated-by-sibling";

const originalFetch = globalThis.fetch;
const originalGetSetting = (storage as any).getSystemSetting;
const originalGetSettingFresh = (storage as any).getSystemSettingFresh;
const originalSetSetting = (storage as any).setSystemSetting;
const originalRecord = (storage as any).recordAdminSettingChange;

interface AuditCall {
  settingKey: string;
  scope: string;
  changedBy: string | null;
  oldValues: unknown;
  newValues: unknown;
}

type StubState = {
  /** In-memory token store. */
  map: Map<string, string>;
  /** Value returned by getSystemSettingFresh(REFRESH_KEY). null → row not found. */
  freshRefreshValue: string | null;
  /** Captured recordAdminSettingChange calls. */
  auditCalls: AuditCall[];
  /** Captured notifyByType calls: [id, payload, opts]. */
  notifyCalls: Array<[string, any, any]>;
  /** Number of POSTs to the token endpoint. */
  tokenCalls: number;
  /** setSystemSetting writes: key → values. */
  writes: Array<{ key: string; value: string }>;
};

function installStubs(opts: {
  terminalResponse?: boolean;
  freshRefreshValue?: string | null;
  /** When true, recordAdminSettingChange throws for scope "wipe" rows (Task #3126). */
  failWipeAuditWrite?: boolean;
}): StubState {
  const state: StubState = {
    map: new Map([
      [REFRESH_KEY, CAPTURED_REFRESH],
      [ACCESS_KEY, "at-old"],
      [EXPIRES_KEY, String(Date.now() - 1000)], // expired — forces a refresh attempt
    ]),
    freshRefreshValue: opts.freshRefreshValue ?? null,
    auditCalls: [],
    notifyCalls: [],
    tokenCalls: 0,
    writes: [],
  };

  (storage as any).getSystemSetting = async (key: string) => {
    const value = state.map.get(key);
    return value === undefined ? undefined : { key, value };
  };

  (storage as any).getSystemSettingFresh = async (key: string) => {
    if (key === REFRESH_KEY) {
      return state.freshRefreshValue === null
        ? undefined
        : { key, value: state.freshRefreshValue };
    }
    const value = state.map.get(key);
    return value === undefined ? undefined : { key, value };
  };

  (storage as any).setSystemSetting = async (key: string, value: string) => {
    state.writes.push({ key, value });
    state.map.set(key, value);
    return { key, value };
  };

  (storage as any).recordAdminSettingChange = async (data: AuditCall) => {
    if (opts.failWipeAuditWrite && data.scope === "wipe") {
      throw new Error("simulated pool exhaustion: audit insert failed");
    }
    state.auditCalls.push(data);
    return data;
  };

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.startsWith(OAUTH_TOKEN_URL)) return originalFetch(input, init);
    state.tokenCalls++;
    if (opts.terminalResponse !== false) {
      return new Response(JSON.stringify({ error: "invalid_request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        access_token: "at-new",
        refresh_token: "rt-new",
        expires_in: 604800,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as any;

  __setWipeNotifyOverrideForTest(async (id, payload, notifyOpts) => {
    state.notifyCalls.push([id, payload, notifyOpts]);
  });

  return state;
}

function restoreAll(): void {
  globalThis.fetch = originalFetch;
  (storage as any).getSystemSetting = originalGetSetting;
  (storage as any).getSystemSettingFresh = originalGetSettingFresh;
  (storage as any).setSystemSetting = originalSetSetting;
  (storage as any).recordAdminSettingChange = originalRecord;
  __setWipeNotifyOverrideForTest(null);
}

async function resetSemrushState(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  __resetSemrushAuthBreakerForTest();
  await __clearPersistedSemrushAuthBreakerForTest();
}

function wiperWrites(state: StubState): number {
  return state.writes.filter((w) => w.key === REFRESH_KEY && w.value === "").length;
}

function auditForScope(state: StubState, scope: string): AuditCall[] {
  return state.auditCalls.filter((c) => c.scope === scope);
}

// ---------------------------------------------------------------------------
// Helper: drain the fire-and-forget audit/alert void promise.
// onTerminalAfterRetry's audit+alert run in a void (async () => {})() so the
// wipe completes before them. Give the microtask queue a few ticks to flush.
// ---------------------------------------------------------------------------
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

// ---------------------------------------------------------------------------
// 1. wipe_skipped — non-authoritative purpose (probe) hits a terminal error.
//    Tokens must be untouched; audit row scoped "wipe_skipped" must appear.
// ---------------------------------------------------------------------------
async function testWipeSkipped(): Promise<void> {
  await resetSemrushState();
  const state = installStubs({ terminalResponse: true, freshRefreshValue: null });
  try {
    let thrown: unknown;
    try {
      await __refreshAccessTokenForTest({ purpose: "probe" });
      assert.fail("probe terminal refresh must throw");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "must surface an error");

    await drainMicrotasks();

    assert.equal(
      wiperWrites(state),
      0,
      "wipe_skipped: refresh token must NOT be cleared (non-authoritative path)",
    );

    const rows = auditForScope(state, "wipe_skipped");
    assert.equal(rows.length, 1, "exactly one wipe_skipped audit row must be written");
    const nv = rows[0].newValues as any;
    assert.equal(nv.event, "token_wipe_skipped");
    assert.equal(nv.reason, "non_authoritative");
    assert.equal(nv.purpose, "probe");
    assert.ok(typeof nv.instance === "string" && nv.instance.length > 0, "instance must be set");
    assert.ok(typeof nv.providerError === "string" && nv.providerError.length > 0, "providerError must be set");
    assert.equal(rows[0].changedBy, null);

    assert.equal(
      state.notifyCalls.length,
      0,
      "wipe_skipped must NOT fire the operator alert",
    );
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 2. wipe_aborted — authoritative caller, but the stored refresh token changed
//    fingerprint during the wipe window (sibling rotated it). Tokens untouched;
//    audit row scoped "wipe_aborted" with both fingerprints must appear.
// ---------------------------------------------------------------------------
async function testWipeAborted(): Promise<void> {
  await resetSemrushState();
  // freshRefreshValue is DIFFERENT from CAPTURED_REFRESH (sibling rotated).
  const state = installStubs({
    terminalResponse: true,
    freshRefreshValue: ROTATED_REFRESH,
  });
  try {
    let thrown: unknown;
    try {
      // Default purpose = authoritative (the caller class allowed to wipe).
      await __refreshAccessTokenForTest();
      assert.fail("authoritative terminal refresh must throw");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "must surface an error");

    await drainMicrotasks();

    assert.equal(
      wiperWrites(state),
      0,
      "wipe_aborted: refresh token must NOT be cleared (sibling-rotated-token guard)",
    );

    const rows = auditForScope(state, "wipe_aborted");
    assert.equal(rows.length, 1, "exactly one wipe_aborted audit row must be written");
    const nv = rows[0].newValues as any;
    assert.equal(nv.event, "token_wipe_aborted");
    assert.equal(nv.reason, "sibling_rotated_token");
    assert.ok(typeof nv.refreshFp_was === "string" && nv.refreshFp_was !== "none", "refreshFp_was must reflect the tried token");
    assert.ok(typeof nv.refreshFp_now === "string" && nv.refreshFp_now !== "none", "refreshFp_now must reflect the sibling-rotated token");
    assert.notEqual(
      nv.refreshFp_was,
      nv.refreshFp_now,
      "fingerprints must differ (rotation race confirmed)",
    );
    assert.equal(rows[0].changedBy, null);

    assert.equal(
      state.notifyCalls.length,
      0,
      "wipe_aborted must NOT fire the operator alert",
    );
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 3. wipe — authoritative caller, fresh token fingerprint UNCHANGED (or null):
//    genuine revocation. Tokens MUST be cleared, audit row scoped "wipe" must
//    appear, and the operator alert must fire.
// ---------------------------------------------------------------------------
async function testWipeGenuineRevocation(): Promise<void> {
  await resetSemrushState();
  // freshRefreshValue null → getSystemSettingFresh returns undefined → wipe proceeds.
  const state = installStubs({ terminalResponse: true, freshRefreshValue: null });
  try {
    let thrown: unknown;
    try {
      await __refreshAccessTokenForTest();
      assert.fail("authoritative terminal refresh with no sibling rotation must throw");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "must surface an error");

    await drainMicrotasks();

    assert.equal(
      wiperWrites(state),
      1,
      "wipe: refresh token MUST be cleared exactly once on genuine revocation",
    );
    assert.equal(
      state.writes.filter((w) => w.key === ACCESS_KEY && w.value === "").length,
      1,
      "access token MUST also be cleared",
    );
    assert.equal(
      state.writes.filter((w) => w.key === EXPIRES_KEY && w.value === "").length,
      1,
      "expires token MUST also be cleared",
    );

    const rows = auditForScope(state, "wipe");
    assert.equal(rows.length, 1, "exactly one wipe audit row must be written");
    const nv = rows[0].newValues as any;
    assert.equal(nv.event, "token_wiped");
    assert.equal(nv.purpose, "authoritative");
    assert.ok(typeof nv.refreshFp === "string", "refreshFp must be present");
    assert.ok(typeof nv.providerError === "string" && nv.providerError.length > 0, "providerError must be set");
    assert.equal(rows[0].changedBy, null);

    // Operator alert must fire immediately.
    assert.equal(
      state.notifyCalls.length,
      1,
      "exactly one operator alert must fire on an automatic wipe",
    );
    const [alertId, alertPayload, alertOpts] = state.notifyCalls[0];
    assert.equal(alertId, "integration.semrush.auth_or_circuit_open");
    assert.equal(alertOpts.dedupeKey, "auto_wipe");
    assert.ok(
      typeof alertPayload.text === "string" && alertPayload.text.includes("automatically wiped"),
      "alert text must mention the automatic wipe",
    );
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 3b. wipe audit write FAILS (Task #3126) — the wipe must still complete, the
//     named counter must increment, and a dedicated low-severity alert with
//     dedupeKey "wipe_audit_write_failed" must fire IN ADDITION to the normal
//     auto_wipe alert, so the audit gap is visible to operators instead of
//     vanishing into expiring console logs.
// ---------------------------------------------------------------------------
async function testWipeAuditWriteFailure(): Promise<void> {
  await resetSemrushState();
  __resetSemrushWipeAuditWriteFailedCountForTest();
  const state = installStubs({
    terminalResponse: true,
    freshRefreshValue: null,
    failWipeAuditWrite: true,
  });
  try {
    let thrown: unknown;
    try {
      await __refreshAccessTokenForTest();
      assert.fail("authoritative terminal refresh must throw");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "must surface an error");

    await drainMicrotasks();

    assert.equal(
      wiperWrites(state),
      1,
      "wipe must still complete even when the audit insert fails",
    );
    assert.equal(
      auditForScope(state, "wipe").length,
      0,
      "audit insert was simulated to fail — no wipe audit row recorded",
    );

    assert.equal(
      getSemrushWipeAuditWriteFailedCount(),
      1,
      "semrush.wipe_audit_write_failed counter must increment exactly once",
    );

    // Two alerts: the audit-failure meta-alert AND the normal auto_wipe alert.
    assert.equal(
      state.notifyCalls.length,
      2,
      "both the audit-failure alert and the auto_wipe alert must fire",
    );
    const auditFailCall = state.notifyCalls.find(
      ([, , o]) => o?.dedupeKey === "wipe_audit_write_failed",
    );
    assert.ok(auditFailCall, "an alert with dedupeKey=wipe_audit_write_failed must fire");
    assert.equal(auditFailCall![0], "integration.semrush.auth_or_circuit_open");
    assert.ok(
      typeof auditFailCall![1]?.text === "string" &&
        auditFailCall![1].text.includes("semrush.wipe_audit_write_failed") &&
        auditFailCall![1].text.includes("simulated pool exhaustion"),
      "audit-failure alert text must name the counter and carry the audit error",
    );
    const autoWipeCall = state.notifyCalls.find(
      ([, , o]) => o?.dedupeKey === "auto_wipe",
    );
    assert.ok(autoWipeCall, "the normal auto_wipe alert must still fire");
  } finally {
    restoreAll();
    __resetSemrushWipeAuditWriteFailedCountForTest();
  }
}

// ---------------------------------------------------------------------------
// 4. denylist coverage — SETTINGS_CACHE_DENYLIST must include every SEMrush
//    OAuth token key so no stale Redis read can drive a false wipe.
//    (The Redis cache layer's own architectural contract: OAuth tokens are
//    excluded at the call site. This is the enforcement.)
// ---------------------------------------------------------------------------
async function testDenylistCoversSemrushTokens(): Promise<void> {
  const required = [
    "semrush_access_token",
    "semrush_refresh_token",
    "semrush_token_expires_at",
    "semrush_device_code",
    "semrush_user_code",
    "semrush_device_expires_at",
  ];
  for (const key of required) {
    assert.ok(
      SETTINGS_CACHE_DENYLIST.has(key),
      `SETTINGS_CACHE_DENYLIST must include "${key}" — a stale cached read of this key can drive a false token wipe`,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. denylist coverage for sibling integrations (Task #3125) — Front's
//    rotating-token keys must be in SETTINGS_CACHE_DENYLIST. Google Ads
//    credentials moved to the GOOGLE_ADS_* env secrets (Task #4008 — no DB
//    row, no system_settings keys, no OAuth nonces), so it needs no denylist
//    entries; any legacy nonce-shaped key would still bypass the cache via
//    the `_oauth_nonce` suffix net, which we pin here.
// ---------------------------------------------------------------------------
async function testDenylistCoversFrontAndGoogleAds(): Promise<void> {
  const frontKeys = [
    "front_access_token",
    "front_refresh_token",
    "front_token_expires_at",
    "front_oauth_state",
  ];
  for (const key of frontKeys) {
    assert.ok(
      SETTINGS_CACHE_DENYLIST.has(key),
      `SETTINGS_CACHE_DENYLIST must include "${key}" — a stale cached read of this key can drive a false token wipe`,
    );
    assert.ok(
      isSettingsCacheDenylisted(key),
      `isSettingsCacheDenylisted("${key}") must be true`,
    );
  }

  // The in-app Google Ads OAuth flow is retired (Task #4008), but any
  // legacy nonce-shaped rows must still bypass the cache via the
  // `_oauth_nonce` suffix net (defense in depth, not a live write path).
  assert.ok(
    isSettingsCacheDenylisted("google_ads_oauth_nonce:user-123"),
    "legacy google_ads_oauth_nonce:<userId> keys still bypass the cache via the _oauth_nonce suffix net",
  );

  // Non-token keys must still flow through the cache (denylist stays narrow).
  assert.equal(
    isSettingsCacheDenylisted("redis_cache_enabled"),
    false,
    "ordinary config keys must NOT be denylisted",
  );
  assert.equal(
    isSettingsCacheDenylisted("google_ads_morning_refresh_enabled"),
    false,
    "google_ads_* non-credential keys must NOT be denylisted",
  );
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    [
      "wipe_skipped (non-authoritative/probe) → tokens untouched + audit breadcrumb, no alert",
      testWipeSkipped,
    ],
    [
      "wipe_aborted (sibling rotated token in wipe window) → tokens untouched + audit breadcrumb with fingerprints, no alert",
      testWipeAborted,
    ],
    [
      "wipe (genuine revocation) → tokens cleared + audit breadcrumb + operator alert fires",
      testWipeGenuineRevocation,
    ],
    [
      "wipe audit write failure → wipe completes, counter increments, dedicated alert fires (Task #3126)",
      testWipeAuditWriteFailure,
    ],
    [
      "SETTINGS_CACHE_DENYLIST covers all SEMrush OAuth token keys (Redis-cache exclusion)",
      testDenylistCoversSemrushTokens,
    ],
    [
      "SETTINGS_CACHE_DENYLIST covers Front token keys + Google Ads OAuth nonce prefix (Task #3125)",
      testDenylistCoversFrontAndGoogleAds,
    ],
  ];

  let failures = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err: any) {
      failures++;
      console.error(`  ✗ ${name}: ${err?.message ?? err}`);
      if (err?.stack) console.error(err.stack);
    }
  }

  if (failures > 0) {
    throw new Error(`semrush-wipe-audit: ${failures} test(s) failed`);
  }
  console.log("semrush-wipe-audit: OK");
}

let exitCode = 0;
main()
  .catch((err) => {
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
