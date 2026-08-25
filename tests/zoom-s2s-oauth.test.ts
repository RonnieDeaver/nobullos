/* test-registration
{
  "name": "Zoom Server-to-Server OAuth (Task #3973)",
  "regression": true,
  "sweepOnlyReason": "Task #3973 — imports server/storage (warms DB pools), not a DB-free gate candidate; consistent with the other zoom OAuth tests above",
  "tier": "small"
}
test-registration */
/**
 * Task #3973 — Zoom Server-to-Server OAuth mode.
 *
 * The legacy user-level OAuth app rotates its refresh token on every refresh;
 * one bad rotation strands the integration. S2S mode mints account-level
 * tokens on demand (`grant_type=account_credentials`) — no refresh token
 * exists, so there is NO rotation in the hot path. These cases prove:
 *
 *   1. Default mode is `oauth` (absent/garbage setting) and the legacy path
 *      never touches the s2s mint.
 *   2. s2s happy path: correct wire format (Basic auth + account_credentials
 *      body), per-process cache hit, ZERO reads/writes of the legacy token
 *      rows, granted scopes persisted once (changed-only writes).
 *   3. Concurrent token requests single-flight into ONE mint.
 *   4. 401 → force re-mint → retry-once succeeds (2 mints, no gate).
 *   5. Terminal mint on an AUTHORITATIVE call engages the global auth gate;
 *      rollback via setZoomAuthMode("oauth") clears it and audits the flip.
 *   6. Terminal/transient mint under the non-authoritative `zoom_probe`
 *      purpose (validateConnection) never engages the gate.
 *   7. Keep-alive tick skips in s2s mode (nothing to keep alive); an
 *      unreadable mode flag surfaces transient_error, never a guess.
 *   8. probeConnection: missing creds → unauthorized (s2s_credentials_missing),
 *      healthy s2s → connected via the users LIST (no /users/me — Zoom
 *      rejects the `me` context for S2S apps), unreadable mode → probe_failed.
 *   9. Preflight is side-effect-free and reports credentials/mint/scope-parity/
 *      API reachability independently.
 *  10. getRequiredZoomS2sScopes() is the exact `:admin` closure of the legacy
 *      scope list (deduped); isConnected() in s2s mode = creds present.
 *
 * Pure in-memory: `storage.getSystemSetting/getSystemSettingFresh/
 * setSystemSetting/recordAdminSettingChange` are backed by a Map and `fetch`
 * is intercepted for the Zoom token + API hosts. NODE_ENV=test keeps the
 * cross-process refresh lease off.
 */
import { strict as assert } from "node:assert";

process.env.NODE_ENV = "test";
process.env.ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "test_zoom_client_id";
process.env.ZOOM_CLIENT_SECRET =
  process.env.ZOOM_CLIENT_SECRET || "test_zoom_client_secret";

import { storage } from "../server/storage";
import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import {
  getZoomAuthMode,
  setZoomAuthMode,
  hasZoomS2sCredentials,
  getRequiredZoomScopes,
  getRequiredZoomS2sScopes,
  runZoomS2sPreflight,
  getAccessToken,
  getMeetingDetails,
  validateConnection,
  probeConnection,
  isConnected,
  runZoomTokenKeepAliveTick,
  getZoomAuthGate,
  clearZoomPermanentFailure,
  clearZoomValidationBreaker,
  __clearZoomS2sTokenCacheForTest,
  __disableZoomAuthSelfHealForTest,
  __clearPersistedZoomAuthGateForTest,
  ZOOM_AUTH_MODE_SETTING,
  ZOOM_KEEPALIVE_ENABLED_SETTING,
} from "../server/services/zoomIntegration";

const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";
const ZOOM_API_BASE = "https://api.zoom.us/v2";
const ACCESS = "zoom_access_token";
const REFRESH = "zoom_refresh_token";
const EXPIRES = "zoom_token_expires_at";
const GRANTED = "zoom_granted_scopes";
const LEGACY_TOKEN_KEYS = [ACCESS, REFRESH, EXPIRES];

const originalFetch = globalThis.fetch;
const originalGet = (storage as any).getSystemSetting;
const originalGetFresh = (storage as any).getSystemSettingFresh;
const originalSet = (storage as any).setSystemSetting;
const originalRecord = (storage as any).recordAdminSettingChange;

let tokenCalls = 0;
let lastTokenInit: any = null;
let apiCalls: Array<{ url: string; init: any }> = [];
let settingReads: string[] = [];
let settingWrites: string[] = [];
let auditCalls: any[] = [];

type TokenHandler = () => Response;
type ApiHandler = (url: string, init: any) => Response;

const okTokenResponse = (scope: string, token = "s2s-token-1"): Response =>
  new Response(
    JSON.stringify({ access_token: token, token_type: "bearer", expires_in: 3600, scope }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const okUsersList = (): Response =>
  new Response(JSON.stringify({ users: [{ id: "u-123", email: "a@b.c" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function installStubs(
  map: Map<string, string>,
  handlers: { token?: TokenHandler; api?: ApiHandler },
): void {
  tokenCalls = 0;
  lastTokenInit = null;
  apiCalls = [];
  settingReads = [];
  settingWrites = [];
  auditCalls = [];
  const read = async (key: string) => {
    settingReads.push(key);
    const value = map.get(key);
    return value === undefined ? undefined : { key, value };
  };
  (storage as any).getSystemSetting = read;
  (storage as any).getSystemSettingFresh = read;
  (storage as any).setSystemSetting = async (key: string, value: string) => {
    settingWrites.push(key);
    map.set(key, value);
    return { key, value };
  };
  (storage as any).recordAdminSettingChange = async (row: any) => {
    auditCalls.push(row);
    return undefined;
  };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.startsWith(ZOOM_TOKEN_URL)) {
      tokenCalls++;
      lastTokenInit = init;
      if (!handlers.token) throw new Error(`unexpected token POST in this case: ${url}`);
      return handlers.token();
    }
    if (url.startsWith(ZOOM_API_BASE)) {
      apiCalls.push({ url, init });
      if (!handlers.api) throw new Error(`unexpected Zoom API call in this case: ${url}`);
      return handlers.api(url, init);
    }
    return originalFetch(input, init);
  }) as any;
}

function restoreAll(): void {
  globalThis.fetch = originalFetch;
  (storage as any).getSystemSetting = originalGet;
  (storage as any).getSystemSettingFresh = originalGetFresh;
  (storage as any).setSystemSetting = originalSet;
  (storage as any).recordAdminSettingChange = originalRecord;
}

async function resetZoomState(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  __disableZoomAuthSelfHealForTest(true);
  await __clearPersistedZoomAuthGateForTest();
  clearZoomPermanentFailure();
  clearZoomValidationBreaker();
  __clearZoomS2sTokenCacheForTest();
}

function setS2sCreds(): void {
  process.env.ZOOM_S2S_ACCOUNT_ID = "acct-1";
  process.env.ZOOM_S2S_CLIENT_ID = "s2s-client";
  process.env.ZOOM_S2S_CLIENT_SECRET = "s2s-secret";
}

function clearS2sCreds(): void {
  delete process.env.ZOOM_S2S_ACCOUNT_ID;
  delete process.env.ZOOM_S2S_CLIENT_ID;
  delete process.env.ZOOM_S2S_CLIENT_SECRET;
}

const fullScopeString = () => getRequiredZoomS2sScopes().join(" ");

// 1. Default mode is oauth; legacy path never touches the s2s mint.
async function testDefaultModeIsOauth(): Promise<void> {
  clearS2sCreds();
  const map = new Map<string, string>([
    [ACCESS, "legacy-access"],
    [EXPIRES, String(Math.floor(Date.now() / 1000) + 3000)], // fresh
  ]);
  installStubs(map, {});
  try {
    await resetZoomState();
    assert.equal(await getZoomAuthMode(), "oauth", "absent setting must default to oauth");
    map.set(ZOOM_AUTH_MODE_SETTING, "garbage-value");
    assert.equal(await getZoomAuthMode(), "oauth", "unknown value must fall back to oauth");
    map.set(ZOOM_AUTH_MODE_SETTING, "  S2S  ");
    assert.equal(await getZoomAuthMode(), "s2s", "mode parse must trim + lowercase");
    map.delete(ZOOM_AUTH_MODE_SETTING);

    const token = await getAccessToken();
    assert.equal(token, "legacy-access", "oauth mode must serve the stored token");
    assert.equal(tokenCalls, 0, "no token-endpoint POST for a fresh stored token");
  } finally {
    restoreAll();
  }
}

// 2. s2s happy path: wire format, cache hit, zero legacy token-row touches,
//    changed-only granted-scope persistence.
async function testS2sHappyMint(): Promise<void> {
  setS2sCreds();
  const map = new Map<string, string>([[ZOOM_AUTH_MODE_SETTING, "s2s"]]);
  installStubs(map, { token: () => okTokenResponse("scope:a scope:b") });
  try {
    await resetZoomState();
    const token = await getAccessToken();
    assert.equal(token, "s2s-token-1");
    assert.equal(tokenCalls, 1, "exactly one mint");

    // Wire format — Basic auth of the S2S pair + account_credentials body.
    const expectedBasic = Buffer.from("s2s-client:s2s-secret").toString("base64");
    assert.equal(lastTokenInit?.headers?.Authorization, `Basic ${expectedBasic}`);
    const body = String(lastTokenInit?.body);
    assert.ok(body.includes("grant_type=account_credentials"), `body was: ${body}`);
    assert.ok(body.includes("account_id=acct-1"), `body was: ${body}`);
    assert.ok(!body.includes("refresh_token"), "s2s mint must not reference refresh tokens");

    // Cache hit — no second mint.
    assert.equal(await getAccessToken(), "s2s-token-1");
    assert.equal(tokenCalls, 1, "second call must be served from the per-process cache");

    // The s2s hot path must never touch the legacy token rows.
    for (const key of LEGACY_TOKEN_KEYS) {
      assert.ok(!settingReads.includes(key), `s2s path must not READ ${key}`);
      assert.ok(!settingWrites.includes(key), `s2s path must not WRITE ${key}`);
    }

    // Granted scopes persisted once, with an audit row.
    assert.equal(map.get(GRANTED), "scope:a scope:b");
    assert.equal(settingWrites.filter((k) => k === GRANTED).length, 1);
    assert.ok(
      auditCalls.some((c) => c?.settingKey === GRANTED && c?.scope === "s2s_mint"),
      "granted-scope persistence must audit as s2s_mint",
    );

    // Changed-only: a re-mint returning the SAME scope string must not rewrite.
    __clearZoomS2sTokenCacheForTest();
    await getAccessToken();
    assert.equal(tokenCalls, 2, "cache cleared → re-mint");
    assert.equal(
      settingWrites.filter((k) => k === GRANTED).length,
      1,
      "unchanged scope string must not be re-persisted (no hourly settings churn)",
    );
  } finally {
    restoreAll();
    clearS2sCreds();
  }
}

// 3. Concurrent requests single-flight into ONE mint.
async function testS2sSingleFlight(): Promise<void> {
  setS2sCreds();
  const map = new Map<string, string>([[ZOOM_AUTH_MODE_SETTING, "s2s"]]);
  installStubs(map, { token: () => okTokenResponse("scope:a") });
  try {
    await resetZoomState();
    const [a, b] = await Promise.all([getAccessToken(), getAccessToken()]);
    assert.equal(a, "s2s-token-1");
    assert.equal(b, "s2s-token-1");
    assert.equal(tokenCalls, 1, "concurrent callers must join one in-flight mint");
  } finally {
    restoreAll();
    clearS2sCreds();
  }
}

// 4. 401 on an API call → force re-mint → retry-once succeeds.
async function test401ForceRemintRetry(): Promise<void> {
  setS2sCreds();
  const map = new Map<string, string>([[ZOOM_AUTH_MODE_SETTING, "s2s"]]);
  let meetingCalls = 0;
  let mintCount = 0;
  installStubs(map, {
    token: () => {
      mintCount++;
      return okTokenResponse("scope:a", `s2s-token-${mintCount}`);
    },
    api: (url) => {
      if (url.includes("/meetings/")) {
        meetingCalls++;
        if (meetingCalls === 1) {
          return new Response(JSON.stringify({ code: 124, message: "Invalid access token." }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ id: "m1", topic: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected API url: ${url}`);
    },
  });
  try {
    await resetZoomState();
    const details = await getMeetingDetails("m1");
    assert.equal(details?.topic, "ok");
    assert.equal(meetingCalls, 2, "401 must retry exactly once");
    assert.equal(tokenCalls, 2, "initial mint + force re-mint after the 401");
    const retryAuth = apiCalls[apiCalls.length - 1]?.init?.headers?.Authorization;
    assert.equal(retryAuth, "Bearer s2s-token-2", "retry must carry the re-minted token");
    assert.equal(getZoomAuthGate(), null, "a recovered 401 must not leave a gate engaged");
  } finally {
    restoreAll();
    clearS2sCreds();
  }
}

// 5. Terminal mint on an authoritative call engages the gate; rollback flip
//    clears it and audits the mode change.
async function testTerminalMintGatesThenRollback(): Promise<void> {
  setS2sCreds();
  const map = new Map<string, string>([[ZOOM_AUTH_MODE_SETTING, "s2s"]]);
  installStubs(map, {
    token: () =>
      new Response(JSON.stringify({ error: "invalid_client", reason: "bad client" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
  });
  try {
    await resetZoomState();
    await assert.rejects(
      () => getMeetingDetails("m1"),
      /invalid_client|terminal|400/i,
      "terminal mint must reject the authoritative call",
    );
    const gate = getZoomAuthGate();
    assert.ok(gate, "terminal mint on an authoritative call MUST engage the auth gate");
    assert.equal(gate!.status, 400);

    // Rollback: flip back to oauth — mode persists, audit recorded, gate cleared.
    await setZoomAuthMode("oauth", "op-1");
    assert.equal(map.get(ZOOM_AUTH_MODE_SETTING), "oauth");
    assert.equal(getZoomAuthGate(), null, "mode flip must clear the auth gate (clean slate)");
    const flip = auditCalls.find((c) => c?.settingKey === ZOOM_AUTH_MODE_SETTING);
    assert.ok(flip, "mode flip must record an admin-settings audit row");
    assert.equal(flip.scope, "auth_mode_change");
    assert.equal(flip.changedBy, "op-1");
    assert.deepEqual(flip.oldValues, { mode: "s2s" });
    assert.deepEqual(flip.newValues, { mode: "oauth" });

    await assert.rejects(
      () => setZoomAuthMode("bogus" as any),
      /Invalid Zoom auth mode/,
      "setter must validate the mode value",
    );
  } finally {
    restoreAll();
    clearS2sCreds();
  }
}

// 6. Non-authoritative probe purpose: terminal AND transient mint failures
//    surface valid:false WITHOUT engaging the gate.
async function testProbePurposeNeverGates(): Promise<void> {
  setS2sCreds();
  for (const [label, status, bodyJson] of [
    ["terminal invalid_client", 400, { error: "invalid_client" }],
    ["transient 503", 503, { error: "service_unavailable" }],
  ] as const) {
    const map = new Map<string, string>([[ZOOM_AUTH_MODE_SETTING, "s2s"]]);
    installStubs(map, {
      token: () =>
        new Response(JSON.stringify(bodyJson), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    });
    try {
      await resetZoomState();
      const res = await validateConnection();
      assert.equal(res.valid, false, `${label}: probe must report invalid`);
      assert.ok(
        String(res.error).includes("s2s mode"),
        `${label}: s2s validate must note the skipped /users/me primary (got: ${res.error})`,
      );
      assert.equal(
        getZoomAuthGate(),
        null,
        `${label}: zoom_probe purpose must NEVER engage the global auth gate`,
      );
    } finally {
      restoreAll();
    }
  }
  clearS2sCreds();
}

// 7. Keep-alive: s2s mode skips (no chain to keep alive); unreadable mode
//    flag → transient_error, never a silent guess.
async function testKeepAliveS2sSkip(): Promise<void> {
  setS2sCreds();
  const map = new Map<string, string>([
    [ZOOM_AUTH_MODE_SETTING, "s2s"],
    [ZOOM_KEEPALIVE_ENABLED_SETTING, "true"],
    [ACCESS, "legacy-access"],
    [REFRESH, "legacy-refresh"],
    [EXPIRES, String(Math.floor(Date.now() / 1000) + 60)], // would rotate in oauth mode
  ]);
  installStubs(map, {});
  try {
    await resetZoomState();
    const res = await runZoomTokenKeepAliveTick();
    assert.deepEqual(res, { action: "skipped", reason: "s2s_mode" });
    assert.equal(tokenCalls, 0, "s2s keep-alive skip must not POST to the token endpoint");

    // Unreadable mode flag → transient_error (no guessing, no legacy refresh).
    const throwingRead = async (key: string) => {
      if (key === ZOOM_AUTH_MODE_SETTING) throw new Error("settings store down");
      const value = map.get(key);
      return value === undefined ? undefined : { key, value };
    };
    (storage as any).getSystemSetting = throwingRead;
    const res2 = await runZoomTokenKeepAliveTick();
    assert.equal(res2.action, "transient_error", "unreadable mode must be transient, not a guess");
    assert.ok(String((res2 as any).message).includes("auth mode read failed"));
    assert.equal(tokenCalls, 0, "unreadable mode must not drive the legacy refresh chain");
  } finally {
    restoreAll();
    clearS2sCreds();
  }
}

// 8. probeConnection in s2s mode.
async function testProbeConnectionS2s(): Promise<void> {
  // (a) creds missing → unauthorized with the s2s-specific reason, no fetches.
  clearS2sCreds();
  const map = new Map<string, string>([[ZOOM_AUTH_MODE_SETTING, "s2s"]]);
  installStubs(map, {});
  try {
    await resetZoomState();
    const res = await probeConnection();
    assert.deepEqual(res, { outcome: "unauthorized", reason: "s2s_credentials_missing" });
    assert.equal(tokenCalls + apiCalls.length, 0, "structural miss must not call Zoom");
  } finally {
    restoreAll();
  }

  // (b) creds present + healthy API → connected, via the users LIST (never /users/me).
  setS2sCreds();
  const map2 = new Map<string, string>([[ZOOM_AUTH_MODE_SETTING, "s2s"]]);
  installStubs(map2, {
    token: () => okTokenResponse(fullScopeString()),
    api: (url) => {
      if (url.includes("/users?")) return okUsersList();
      throw new Error(`unexpected API url: ${url}`);
    },
  });
  try {
    await resetZoomState();
    const res = await probeConnection();
    assert.equal(res.outcome, "connected", `expected connected, got ${JSON.stringify(res)}`);
    assert.ok(
      apiCalls.every((c) => !c.url.includes("/users/me")),
      "s2s probe must never use the `me` context (Zoom rejects it for S2S apps)",
    );
  } finally {
    restoreAll();
  }

  // (c) unreadable mode flag → probe_failed (status cache keeps previous value).
  const map3 = new Map<string, string>();
  installStubs(map3, {});
  (storage as any).getSystemSetting = async (key: string) => {
    if (key === ZOOM_AUTH_MODE_SETTING) throw new Error("settings store down");
    const value = map3.get(key);
    return value === undefined ? undefined : { key, value };
  };
  try {
    const res = await probeConnection();
    assert.equal(res.outcome, "probe_failed");
    assert.ok(String((res as any).reason).startsWith("auth_mode_read_failed"));
  } finally {
    restoreAll();
    clearS2sCreds();
  }
}

// 9. Preflight: independent readiness report, side-effect-free.
async function testPreflight(): Promise<void> {
  // (a) creds absent.
  clearS2sCreds();
  let map = new Map<string, string>([[ZOOM_AUTH_MODE_SETTING, "oauth"]]);
  installStubs(map, {});
  try {
    await resetZoomState();
    const res = await runZoomS2sPreflight();
    assert.equal(res.credentialsPresent, false);
    assert.equal(res.ready, false);
    assert.ok(String(res.error).includes("not configured"));
  } finally {
    restoreAll();
  }

  setS2sCreds();

  // (b) mint fails terminally → mintOk false, and NO gate side-effect.
  map = new Map<string, string>([[ZOOM_AUTH_MODE_SETTING, "oauth"]]);
  installStubs(map, {
    token: () =>
      new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
  });
  try {
    await resetZoomState();
    const res = await runZoomS2sPreflight();
    assert.equal(res.credentialsPresent, true);
    assert.equal(res.mintOk, false);
    assert.equal(res.ready, false);
    assert.ok(String(res.error).startsWith("mint_failed:"));
    assert.equal(getZoomAuthGate(), null, "preflight must NEVER engage the auth gate");
  } finally {
    restoreAll();
  }

  // (c) scope gap → ready:false with the missing scope named.
  const allScopes = getRequiredZoomS2sScopes();
  const dropped = allScopes[allScopes.length - 1];
  map = new Map<string, string>([[ZOOM_AUTH_MODE_SETTING, "oauth"]]);
  installStubs(map, {
    token: () => okTokenResponse(allScopes.filter((s) => s !== dropped).join(" ")),
    api: (url) => {
      if (url.includes("/users?")) return okUsersList();
      throw new Error(`unexpected API url: ${url}`);
    },
  });
  try {
    await resetZoomState();
    const res = await runZoomS2sPreflight();
    assert.equal(res.mintOk, true);
    assert.equal(res.apiOk, true);
    assert.equal(res.ready, false, "a missing scope must block readiness");
    assert.deepEqual(res.missingScopes, [dropped]);
  } finally {
    restoreAll();
  }

  // (d) full parity + API ok → ready, and side-effect-free (no cache/scope writes;
  //     a follow-up s2s token fetch must mint fresh).
  map = new Map<string, string>([[ZOOM_AUTH_MODE_SETTING, "s2s"]]);
  installStubs(map, {
    token: () => okTokenResponse(fullScopeString()),
    api: (url) => {
      if (url.includes("/users?")) return okUsersList();
      throw new Error(`unexpected API url: ${url}`);
    },
  });
  try {
    await resetZoomState();
    const res = await runZoomS2sPreflight();
    assert.equal(res.ready, true, `expected ready, got ${JSON.stringify(res)}`);
    assert.deepEqual(res.missingScopes, []);
    assert.ok(res.grantedScopes.length > 0);
    assert.equal(tokenCalls, 1);
    assert.ok(!settingWrites.includes(GRANTED), "preflight must not persist scopes");
    await getAccessToken();
    assert.equal(tokenCalls, 2, "preflight must not have populated the live token cache");
  } finally {
    restoreAll();
    clearS2sCreds();
  }
}

// 10. Scope closure properties, isConnected matrix, unreadable-mode accessor.
async function testScopeClosureAndConnected(): Promise<void> {
  const legacy = getRequiredZoomScopes();
  const closure = getRequiredZoomS2sScopes();
  assert.ok(closure.length > 0);
  assert.equal(new Set(closure).size, closure.length, "closure must be deduped");
  for (const scope of closure) {
    assert.ok(scope.endsWith(":admin"), `s2s scope must be account-level: ${scope}`);
  }
  // Task #3982 — S2S-era scope renames: the closure carries the name the S2S
  // picker actually grants, not the legacy name. Keep in lockstep with
  // ZOOM_S2S_SCOPE_RENAMES in zoomIntegration.ts.
  const S2S_RENAMES: Record<string, string> = {
    "recording:read:recording:admin": "cloud_recording:read:recording:admin",
  };
  for (const scope of legacy) {
    const admin = scope.endsWith(":admin") ? scope : `${scope}:admin`;
    const expected = S2S_RENAMES[admin] ?? admin;
    assert.ok(closure.includes(expected), `legacy scope ${scope} must map into the closure as ${expected}`);
  }
  for (const [legacyName, renamed] of Object.entries(S2S_RENAMES)) {
    assert.ok(!closure.includes(legacyName), `renamed scope must not keep its legacy name: ${legacyName}`);
    assert.ok(closure.includes(renamed), `renamed scope must be present: ${renamed}`);
  }
  assert.ok(
    closure.includes("meeting:read:list_past_participants:admin"),
    "the sole user-level scope must collapse into its :admin variant",
  );
  const expectedSize = new Set(
    legacy.map((s) => {
      const admin = s.endsWith(":admin") ? s : `${s}:admin`;
      return S2S_RENAMES[admin] ?? admin;
    }),
  ).size;
  assert.equal(closure.length, expectedSize, "closure must be exactly the admin-mapped (rename-aware) legacy set");

  // isConnected: s2s = creds present; oauth = stored token.
  const map = new Map<string, string>([[ZOOM_AUTH_MODE_SETTING, "s2s"]]);
  installStubs(map, {});
  try {
    await resetZoomState();
    clearS2sCreds();
    assert.equal(hasZoomS2sCredentials(), false);
    assert.equal(await isConnected(), false, "s2s without creds = not connected");
    setS2sCreds();
    assert.equal(hasZoomS2sCredentials(), true);
    assert.equal(await isConnected(), true, "s2s with creds = connected (structurally)");

    // Unreadable mode flag → the token accessor REJECTS (no oauth fallback,
    // no mint, no legacy token reads).
    (storage as any).getSystemSetting = async (key: string) => {
      if (key === ZOOM_AUTH_MODE_SETTING) throw new Error("settings store down");
      const value = map.get(key);
      return value === undefined ? undefined : { key, value };
    };
    settingReads = [];
    await assert.rejects(
      () => getAccessToken(),
      /settings store down/,
      "unreadable mode must reject, never silently fall back to the legacy chain",
    );
    assert.equal(tokenCalls, 0, "no mint on an unreadable mode flag");
    for (const key of LEGACY_TOKEN_KEYS) {
      assert.ok(!settingReads.includes(key), `no legacy fallback read of ${key}`);
    }
  } finally {
    restoreAll();
    clearS2sCreds();
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["default mode is oauth; legacy path never mints", testDefaultModeIsOauth],
    ["s2s happy mint: wire format, cache, no legacy rows, scope persistence", testS2sHappyMint],
    ["concurrent requests single-flight into one mint", testS2sSingleFlight],
    ["401 → force re-mint → retry-once succeeds", test401ForceRemintRetry],
    ["terminal mint gates (authoritative) + rollback flip clears", testTerminalMintGatesThenRollback],
    ["zoom_probe purpose never engages the gate", testProbePurposeNeverGates],
    ["keep-alive skips in s2s mode; unreadable mode = transient", testKeepAliveS2sSkip],
    ["probeConnection s2s: creds/connected/probe_failed", testProbeConnectionS2s],
    ["preflight: creds / mint / scope-parity / ready, side-effect-free", testPreflight],
    ["scope closure + isConnected + unreadable-mode accessor", testScopeClosureAndConnected],
  ];
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err: any) {
      console.error(`  ✗ ${name}: ${err?.stack ?? err?.message ?? err}`);
      process.exitCode = 1;
    }
  }
  __disableZoomAuthSelfHealForTest(false);
  if (process.exitCode && process.exitCode !== 0) {
    throw new Error("zoom-s2s-oauth test cases failed");
  }
  console.log("zoom-s2s-oauth: OK");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
