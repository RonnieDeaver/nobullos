/* test-registration
{
  "name": "SEMrush keep-alive rotation contract — endpoint/body, age criterion, lease recheck, rotate-now action (Task #3666)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3666: SEMrush keep-alive rotation contract — refresh POST targets /oauth2/access_token with client creds from env when set, the 3.5-day age criterion + expiresAt−7d fallback, last-refreshed stamping, the proactive lease-recheck bypass (prod ticks silently no-opped via lease_skip_fresh before this), and the rotate-now prod-action outcomes. Fast (~15s), pure in-memory storage/fetch stubs — gate it so the weekly reconnect treadmill bug class can't silently return.",
  "tier": "small"
}
test-registration */
/**
 * Task #3666 — SEMrush keep-alive rotation contract.
 *
 * The weekly reconnect treadmill was caused by `refreshOnce` POSTing
 * `grant_type=refresh_token` to the device-flow endpoint
 * (`/dag/device/token`), which only accepts `device_code` grants — every
 * refresh 400'd and the expiry-path wipe forced a manual reconnect at
 * +7 days. This file locks in the corrected contract end-to-end:
 *
 *   1. Refresh request construction — POST to
 *      `https://oauth.semrush.com/oauth2/access_token`, form-encoded
 *      `grant_type=refresh_token` + `refresh_token`; `client_id` /
 *      `client_secret` included IFF the SEMRUSH_CLIENT_ID /
 *      SEMRUSH_CLIENT_SECRET env vars are set.
 *   2. A successful rotation persists the new pair AND stamps
 *      `semrush_token_last_refreshed_at` (the age-criterion input).
 *   3. `runSemrushTokenKeepAliveTick` decision matrix — skips a young
 *      token, rotates inside the 48h pre-expiry window, rotates on
 *      age ≥ 3.5d even when expiry is far, derives age from
 *      `expiresAt − 7d` when the last-refreshed stamp is missing
 *      (pre-#3666 deployments), and `force: true` bypasses freshness
 *      while still honoring the no-tokens guard.
 *   4. Terminal refresh failure surfaces as `terminal_error` WITHOUT
 *      wiping tokens (keep-alive is non-authoritative).
 *   5. Cross-process-lease recheck — in production the lease is always
 *      held, so the old recheck returned the still-fresh access token
 *      and silently skipped EVERY proactive POST (the keep-alive never
 *      actually rotated anything until the token was ≤60s from death).
 *      A proactive rotation must POST despite a fresh access token,
 *      short-circuiting only when a sibling rotated moments ago; the
 *      default (on-demand) fast path keeps the old reuse behavior.
 *   6. The `semrush_keepalive_rotate_now` prod-action — blocked with no
 *      tokens, `applied` on a successful forced rotation, `error`
 *      (with the OAuth detail) on a terminal one.
 *
 * Pure in-memory: `storage.getSystemSetting/getSystemSettingFresh/
 * setSystemSetting` are stubbed and `fetch` is intercepted with a
 * host-filtered stub (non-SEMrush URLs pass through) — no DB writes to
 * token keys, no network.
 */
import { strict as assert } from "node:assert";
import { storage } from "../server/storage";
import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import {
  __setOAuthRefreshLeaseForTest,
  type OAuthCrossProcessLease,
} from "../server/services/oauthRefreshLease";
import {
  runSemrushTokenKeepAliveTick,
  __refreshAccessTokenForTest,
  SEMRUSH_KEEPALIVE_MAX_AGE_MS,
  SEMRUSH_KEEPALIVE_REFRESH_BEFORE_EXPIRY_MS,
  SEMRUSH_PROACTIVE_SIBLING_ROTATION_SKEW_MS,
} from "../server/services/semrushApi";
import {
  __resetSemrushAuthBreakerForTest,
  tripSemrushAuthBreaker,
} from "../server/services/semrushAuthBreaker";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";

const ACCESS = "semrush_access_token";
const REFRESH = "semrush_refresh_token";
const EXPIRES = "semrush_token_expires_at";
const LAST_REFRESHED = "semrush_token_last_refreshed_at";

const OAUTH_REFRESH_URL = "https://oauth.semrush.com/oauth2/access_token";
const DAY_MS = 24 * 60 * 60 * 1000;

type SettingMap = Map<string, string>;

const originalGet = storage.getSystemSetting.bind(storage);
const originalGetFresh = (storage as any).getSystemSettingFresh?.bind(storage);
const originalSet = storage.setSystemSetting.bind(storage);
const originalFetch = globalThis.fetch;
const originalClientId = process.env.SEMRUSH_CLIENT_ID;
const originalClientSecret = process.env.SEMRUSH_CLIENT_SECRET;

function installStorageStub(map: SettingMap): void {
  const readKey = async (key: string) => {
    const value = map.get(key);
    return value === undefined ? undefined : { key, value };
  };
  (storage as any).getSystemSetting = readKey;
  // Wipe-confirmation re-reads use getSystemSettingFresh; it must see the
  // same in-memory map (one shared map models the one shared DB both the
  // cached and fresh readers hit in production).
  (storage as any).getSystemSettingFresh = readKey;
  (storage as any).setSystemSetting = async (key: string, value: string) => {
    map.set(key, value);
    return { key, value };
  };
}

interface CapturedPost {
  url: string;
  contentType: string | undefined;
  params: URLSearchParams;
}

/**
 * Host-filtered fetch stub: intercepts ONLY oauth.semrush.com requests
 * (other in-process HTTP — e.g. cache invalidation — passes through to the
 * real fetch so it can't inflate the POST count).
 */
function installOAuthFetchStub(
  responder: (post: CapturedPost) => Response | Promise<Response>,
  captured: CapturedPost[],
): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.includes("oauth.semrush.com")) {
      return originalFetch(input, init);
    }
    const post: CapturedPost = {
      url,
      contentType: init?.headers?.["Content-Type"] ?? init?.headers?.["content-type"],
      params: new URLSearchParams(String(init?.body ?? "")),
    };
    captured.push(post);
    return responder(post);
  }) as any;
}

function restoreAll(): void {
  (storage as any).getSystemSetting = originalGet;
  (storage as any).getSystemSettingFresh = originalGetFresh;
  (storage as any).setSystemSetting = originalSet;
  globalThis.fetch = originalFetch;
  if (originalClientId === undefined) delete process.env.SEMRUSH_CLIENT_ID;
  else process.env.SEMRUSH_CLIENT_ID = originalClientId;
  if (originalClientSecret === undefined) delete process.env.SEMRUSH_CLIENT_SECRET;
  else process.env.SEMRUSH_CLIENT_SECRET = originalClientSecret;
}

function rotatedPairResponse(): Response {
  return new Response(
    JSON.stringify({ access_token: "at-rotated", refresh_token: "rt-rotated", expires_in: 604800 }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function terminalResponse(): Response {
  return new Response(JSON.stringify({ error: "invalid_request" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

async function withFresh<T>(fn: () => Promise<T>): Promise<T> {
  __resetOAuthRefreshSingleFlightForTest();
  __resetSemrushAuthBreakerForTest();
  return fn();
}

// ---------------------------------------------------------------------------
// 1a. Refresh request construction WITHOUT client credentials.
// ---------------------------------------------------------------------------
async function testRefreshBodyWithoutClientCreds(): Promise<void> {
  delete process.env.SEMRUSH_CLIENT_ID;
  delete process.env.SEMRUSH_CLIENT_SECRET;
  const map: SettingMap = new Map([[REFRESH, "rt-bare"]]);
  installStorageStub(map);
  const posts: CapturedPost[] = [];
  installOAuthFetchStub(() => rotatedPairResponse(), posts);
  const before = Date.now();
  try {
    const token = await withFresh(() => __refreshAccessTokenForTest());
    assert.equal(token, "at-rotated", "refresh must return the newly-minted access token");
    assert.equal(posts.length, 1, "exactly one refresh POST");
    const post = posts[0];
    assert.equal(post.url, OAUTH_REFRESH_URL, "must POST the Semrush Auth endpoint, NOT /dag/device/token");
    assert.equal(post.contentType, "application/x-www-form-urlencoded", "form-encoded body");
    assert.equal(post.params.get("grant_type"), "refresh_token");
    assert.equal(post.params.get("refresh_token"), "rt-bare");
    assert.equal(post.params.has("client_id"), false, "no client_id param when env var is unset");
    assert.equal(post.params.has("client_secret"), false, "no client_secret param when env var is unset");
    // Success persists the rotated pair + the age-criterion stamp.
    assert.equal(map.get(ACCESS), "at-rotated");
    assert.equal(map.get(REFRESH), "rt-rotated");
    const stamped = parseInt(map.get(LAST_REFRESHED) ?? "", 10);
    assert.ok(
      Number.isFinite(stamped) && stamped >= before && stamped <= Date.now(),
      `successful rotation must stamp ${LAST_REFRESHED} with the rotation wall-clock time (got ${map.get(LAST_REFRESHED)})`,
    );
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 1b. Refresh request construction WITH client credentials from env.
// ---------------------------------------------------------------------------
async function testRefreshBodyWithClientCreds(): Promise<void> {
  process.env.SEMRUSH_CLIENT_ID = "test-client-id-3666";
  process.env.SEMRUSH_CLIENT_SECRET = "test-client-secret-3666";
  const map: SettingMap = new Map([[REFRESH, "rt-cred"]]);
  installStorageStub(map);
  const posts: CapturedPost[] = [];
  installOAuthFetchStub(() => rotatedPairResponse(), posts);
  try {
    await withFresh(() => __refreshAccessTokenForTest());
    assert.equal(posts.length, 1, "exactly one refresh POST");
    const post = posts[0];
    assert.equal(post.url, OAUTH_REFRESH_URL);
    assert.equal(post.params.get("grant_type"), "refresh_token");
    assert.equal(post.params.get("refresh_token"), "rt-cred");
    assert.equal(
      post.params.get("client_id"),
      "test-client-id-3666",
      "client_id must be included when SEMRUSH_CLIENT_ID is set",
    );
    assert.equal(
      post.params.get("client_secret"),
      "test-client-secret-3666",
      "client_secret must be included when SEMRUSH_CLIENT_SECRET is set",
    );
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 2. Keep-alive tick decision matrix (no lease — the NODE_ENV=test default).
// ---------------------------------------------------------------------------
async function tickWith(
  map: SettingMap,
  opts?: { force?: boolean },
): Promise<{ result: Awaited<ReturnType<typeof runSemrushTokenKeepAliveTick>>; posts: CapturedPost[] }> {
  installStorageStub(map);
  const posts: CapturedPost[] = [];
  installOAuthFetchStub(() => rotatedPairResponse(), posts);
  const result = await withFresh(() => runSemrushTokenKeepAliveTick(opts));
  return { result, posts };
}

async function testTickSkipsYoungToken(): Promise<void> {
  const now = Date.now();
  try {
    const { result, posts } = await tickWith(
      new Map([
        [ACCESS, "at-young"],
        [REFRESH, "rt-young"],
        [EXPIRES, String(now + 6 * DAY_MS)],
        [LAST_REFRESHED, String(now - 1 * DAY_MS)],
      ]),
    );
    assert.deepEqual(result, { action: "skipped", reason: "fresh" }, "young token far from expiry must skip");
    assert.equal(posts.length, 0, "no refresh POST for a fresh token");
  } finally {
    restoreAll();
  }
}

async function testTickRotatesInsideExpiryWindow(): Promise<void> {
  const now = Date.now();
  try {
    // Age is young (1d) but expiry is inside the 48h window → window criterion.
    const { result, posts } = await tickWith(
      new Map([
        [ACCESS, "at-window"],
        [REFRESH, "rt-window"],
        [EXPIRES, String(now + SEMRUSH_KEEPALIVE_REFRESH_BEFORE_EXPIRY_MS - 60 * 60 * 1000)],
        [LAST_REFRESHED, String(now - 1 * DAY_MS)],
      ]),
    );
    assert.deepEqual(result, { action: "refreshed" }, "inside the 48h pre-expiry window must rotate");
    assert.equal(posts.length, 1, "exactly one refresh POST");
  } finally {
    restoreAll();
  }
}

async function testTickRotatesOnAgeDespiteFarExpiry(): Promise<void> {
  const now = Date.now();
  try {
    // Expiry 3d away (outside the 48h window) but the token is 4d old —
    // the Task #3666 age criterion must fire.
    const { result, posts } = await tickWith(
      new Map([
        [ACCESS, "at-aged"],
        [REFRESH, "rt-aged"],
        [EXPIRES, String(now + 3 * DAY_MS)],
        [LAST_REFRESHED, String(now - (SEMRUSH_KEEPALIVE_MAX_AGE_MS + 60_000))],
      ]),
    );
    assert.deepEqual(result, { action: "refreshed" }, "age ≥ 3.5d must rotate even when expiry is far");
    assert.equal(posts.length, 1, "exactly one refresh POST");
  } finally {
    restoreAll();
  }
}

async function testTickDerivesAgeWhenStampMissing(): Promise<void> {
  const now = Date.now();
  try {
    // Pre-#3666 deployment: no last-refreshed stamp. Expiry 2.5d out is
    // outside the 48h window, but derived issue time = expiresAt − 7d puts
    // the age at 4.5d → the fallback derivation must trigger the rotation.
    const { result, posts } = await tickWith(
      new Map([
        [ACCESS, "at-legacy"],
        [REFRESH, "rt-legacy"],
        [EXPIRES, String(now + 2.5 * DAY_MS)],
      ]),
    );
    assert.deepEqual(
      result,
      { action: "refreshed" },
      "missing stamp must fall back to expiresAt − 7d for the age criterion",
    );
    assert.equal(posts.length, 1, "exactly one refresh POST");

    // Control: identical expiry but a YOUNG explicit stamp → the stamp (not
    // the fallback) governs, and the tick skips. Proves the fallback above
    // was the deciding branch.
    const { result: control, posts: controlPosts } = await tickWith(
      new Map([
        [ACCESS, "at-legacy"],
        [REFRESH, "rt-legacy"],
        [EXPIRES, String(now + 2.5 * DAY_MS)],
        [LAST_REFRESHED, String(now - 1 * DAY_MS)],
      ]),
    );
    assert.deepEqual(control, { action: "skipped", reason: "fresh" });
    assert.equal(controlPosts.length, 0);
  } finally {
    restoreAll();
  }
}

async function testTickForceBypassesFreshness(): Promise<void> {
  const now = Date.now();
  try {
    // Same young-token setup that skipped above — force must rotate anyway.
    const { result, posts } = await tickWith(
      new Map([
        [ACCESS, "at-forced"],
        [REFRESH, "rt-forced"],
        [EXPIRES, String(now + 6 * DAY_MS)],
        [LAST_REFRESHED, String(now - 60 * 60 * 1000)],
      ]),
      { force: true },
    );
    assert.deepEqual(result, { action: "refreshed" }, "force must bypass the freshness/age checks");
    assert.equal(posts.length, 1, "exactly one refresh POST");
  } finally {
    restoreAll();
  }
}

async function testTickForceStillHonorsNoTokensGuard(): Promise<void> {
  try {
    const { result, posts } = await tickWith(new Map(), { force: true });
    assert.deepEqual(
      result,
      { action: "skipped", reason: "no_tokens" },
      "force must NOT bypass the no-tokens guard",
    );
    assert.equal(posts.length, 0);
  } finally {
    restoreAll();
  }
}

async function testTickTerminalErrorPreservesTokens(): Promise<void> {
  const now = Date.now();
  const map: SettingMap = new Map([
    [ACCESS, "at-live"],
    [REFRESH, "rt-live"],
    [EXPIRES, String(now + 6 * DAY_MS)],
    [LAST_REFRESHED, String(now - 60 * 60 * 1000)],
  ]);
  installStorageStub(map);
  const posts: CapturedPost[] = [];
  installOAuthFetchStub(() => terminalResponse(), posts);
  try {
    const result = await withFresh(() => runSemrushTokenKeepAliveTick({ force: true }));
    assert.equal(result.action, "terminal_error", "terminal refresh failure must surface as terminal_error");
    assert.match(
      (result as { action: "terminal_error"; oauthError: string | null }).oauthError ?? "",
      /HTTP 400/,
      "the OAuth error detail must carry the provider status",
    );
    // Non-authoritative: the keep-alive must never wipe stored tokens.
    assert.equal(map.get(REFRESH), "rt-live", "keep-alive terminal failure must NOT wipe the refresh token");
    assert.equal(map.get(ACCESS), "at-live", "keep-alive terminal failure must NOT wipe the access token");
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 3. Cross-process-lease recheck contract (stub lease held, as in prod).
// ---------------------------------------------------------------------------
const heldLease: OAuthCrossProcessLease = {
  acquire: async () => async () => {},
};

async function testLeaseHeldProactiveStillPosts(): Promise<void> {
  const now = Date.now();
  const map: SettingMap = new Map([
    [ACCESS, "at-fresh"],
    [REFRESH, "rt-fresh"],
    [EXPIRES, String(now + 5 * DAY_MS)],
    [LAST_REFRESHED, String(now - (SEMRUSH_KEEPALIVE_MAX_AGE_MS + 60_000))],
  ]);
  installStorageStub(map);
  const posts: CapturedPost[] = [];
  installOAuthFetchStub(() => rotatedPairResponse(), posts);
  __setOAuthRefreshLeaseForTest(heldLease);
  try {
    // Access token is fresh (5d out) — pre-#3666 the lease recheck would
    // return it and skip the POST, silently no-opping every proactive
    // rotation in production. The aged stamp means no sibling just rotated,
    // so the POST must proceed.
    const result = await withFresh(() => runSemrushTokenKeepAliveTick());
    assert.deepEqual(result, { action: "refreshed" });
    assert.equal(
      posts.length,
      1,
      "proactive rotation under a held lease must POST despite a fresh access token",
    );
    assert.equal(map.get(REFRESH), "rt-rotated", "the pair must actually rotate");
  } finally {
    __setOAuthRefreshLeaseForTest(undefined);
    restoreAll();
  }
}

async function testLeaseHeldSiblingJustRotatedSkips(): Promise<void> {
  const now = Date.now();
  const map: SettingMap = new Map([
    [ACCESS, "at-sibling"],
    [REFRESH, "rt-sibling"],
    [EXPIRES, String(now + 6 * DAY_MS)],
    // A sibling stamped a rotation well inside the skew window while we
    // waited on the lease → reuse its token, no second POST.
    [LAST_REFRESHED, String(now - Math.floor(SEMRUSH_PROACTIVE_SIBLING_ROTATION_SKEW_MS / 2))],
  ]);
  installStorageStub(map);
  const posts: CapturedPost[] = [];
  installOAuthFetchStub(() => rotatedPairResponse(), posts);
  __setOAuthRefreshLeaseForTest(heldLease);
  try {
    const result = await withFresh(() => runSemrushTokenKeepAliveTick({ force: true }));
    assert.deepEqual(result, { action: "refreshed" }, "sibling's fresh rotation counts as refreshed");
    assert.equal(posts.length, 0, "no second POST when a sibling rotated moments ago");
    assert.equal(map.get(REFRESH), "rt-sibling", "sibling's stored pair must be left untouched");
  } finally {
    __setOAuthRefreshLeaseForTest(undefined);
    restoreAll();
  }
}

async function testLeaseHeld401RetryRejectedTokenStillPosts(): Promise<void> {
  const now = Date.now();
  const map: SettingMap = new Map([
    [ACCESS, "at-rejected"],
    [REFRESH, "rt-live"],
    [EXPIRES, String(now + 5 * DAY_MS)],
    [LAST_REFRESHED, String(now - 6 * DAY_MS)],
  ]);
  installStorageStub(map);
  const posts: CapturedPost[] = [];
  installOAuthFetchStub(() => rotatedPairResponse(), posts);
  __setOAuthRefreshLeaseForTest(heldLease);
  try {
    // A live API call just 401'd with "at-rejected" even though its stored
    // expiry looks fresh (SEMrush rejected it anyway). The recheck must NOT
    // hand the same rejected bearer back — that 401-loops with zero POSTs
    // (the failure the completion review reproduced under the real lease).
    const token = await withFresh(() =>
      __refreshAccessTokenForTest({ purpose: "401_retry", rejectedAccessToken: "at-rejected" }),
    );
    assert.equal(posts.length, 1, "reactive-401 must POST when the stored token IS the rejected one");
    assert.notEqual(token, "at-rejected", "the rejected bearer must never be returned");
    assert.equal(map.get(REFRESH), "rt-rotated", "the pair must actually rotate");
  } finally {
    __setOAuthRefreshLeaseForTest(undefined);
    restoreAll();
  }
}

async function testLeaseHeld401RetrySiblingRotatedReuses(): Promise<void> {
  const now = Date.now();
  const map: SettingMap = new Map([
    // Stored token DIFFERS from the rejected one — a sibling rotated while
    // we waited on the lease; reusing it is correct and saves a POST.
    [ACCESS, "at-sibling-new"],
    [REFRESH, "rt-sibling"],
    [EXPIRES, String(now + 6 * DAY_MS)],
    [LAST_REFRESHED, String(now - 6 * DAY_MS)],
  ]);
  installStorageStub(map);
  const posts: CapturedPost[] = [];
  installOAuthFetchStub(() => rotatedPairResponse(), posts);
  __setOAuthRefreshLeaseForTest(heldLease);
  try {
    const token = await withFresh(() =>
      __refreshAccessTokenForTest({ purpose: "401_retry", rejectedAccessToken: "at-dead" }),
    );
    assert.equal(token, "at-sibling-new", "sibling-rotated token must be reused");
    assert.equal(posts.length, 0, "no POST when the stored token differs from the rejected one");
    assert.equal(map.get(REFRESH), "rt-sibling", "sibling's stored pair must be left untouched");
  } finally {
    __setOAuthRefreshLeaseForTest(undefined);
    restoreAll();
  }
}

async function testLeaseHeldOnDemandFastPathUnchanged(): Promise<void> {
  const now = Date.now();
  const map: SettingMap = new Map([
    [ACCESS, "at-ondemand"],
    [REFRESH, "rt-ondemand"],
    [EXPIRES, String(now + 5 * DAY_MS)],
    // Even an ancient stamp must not force a POST for the DEFAULT
    // (on-demand/authoritative) purpose — its recheck fast path exists to
    // reuse a sibling-refreshed still-valid token.
    [LAST_REFRESHED, String(now - 6 * DAY_MS)],
  ]);
  installStorageStub(map);
  const posts: CapturedPost[] = [];
  installOAuthFetchStub(() => rotatedPairResponse(), posts);
  __setOAuthRefreshLeaseForTest(heldLease);
  try {
    const token = await withFresh(() => __refreshAccessTokenForTest());
    assert.equal(token, "at-ondemand", "on-demand refresh must reuse the fresh stored access token");
    assert.equal(posts.length, 0, "default purpose keeps the lease_skip_fresh fast path");
  } finally {
    __setOAuthRefreshLeaseForTest(undefined);
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 4. semrush_keepalive_rotate_now prod-action.
// ---------------------------------------------------------------------------
async function testProdActionRegistrationAndStatus(): Promise<void> {
  const action = PROD_ACTIONS.find((a) => a.id === "semrush_keepalive_rotate_now");
  assert.ok(action, "semrush_keepalive_rotate_now must be registered in PROD_ACTIONS");

  // No tokens stored → blocked (reconnect first).
  const emptyMap: SettingMap = new Map();
  installStorageStub(emptyMap);
  try {
    const status = await withFresh(() => action!.status());
    assert.equal(status.state, "blocked", "status must be blocked when no tokens are stored");
    // Breaker open → blocked too.
    emptyMap.set(REFRESH, "rt-status");
    tripSemrushAuthBreaker("test breaker trip (Task #3666 contract test)");
    const breakerStatus = await action!.status();
    assert.equal(breakerStatus.state, "blocked", "status must be blocked while the auth breaker is open");
    __resetSemrushAuthBreakerForTest();
  } finally {
    __resetSemrushAuthBreakerForTest();
    restoreAll();
  }
}

async function testProdActionApplyOutcomes(): Promise<void> {
  const action = PROD_ACTIONS.find((a) => a.id === "semrush_keepalive_rotate_now");
  assert.ok(action, "action must be registered");
  const now = Date.now();

  // Success → applied, and the forced rotation actually posted + persisted.
  const okMap: SettingMap = new Map([
    [ACCESS, "at-preapply"],
    [REFRESH, "rt-preapply"],
    [EXPIRES, String(now + 6 * DAY_MS)],
    [LAST_REFRESHED, String(now - 60 * 60 * 1000)],
  ]);
  installStorageStub(okMap);
  const okPosts: CapturedPost[] = [];
  installOAuthFetchStub(() => rotatedPairResponse(), okPosts);
  try {
    const applied = await withFresh(() => action!.apply("test-actor-3666"));
    assert.equal(applied.state, "applied", `success must map to applied (got ${JSON.stringify(applied)})`);
    assert.equal(okPosts.length, 1, "apply must force exactly one rotation POST");
    assert.equal(okMap.get(REFRESH), "rt-rotated", "apply must persist the rotated pair");
  } finally {
    restoreAll();
  }

  // Terminal OAuth failure → error carrying the provider detail; tokens intact.
  const errMap: SettingMap = new Map([
    [ACCESS, "at-preapply2"],
    [REFRESH, "rt-preapply2"],
    [EXPIRES, String(now + 6 * DAY_MS)],
    [LAST_REFRESHED, String(now - 60 * 60 * 1000)],
  ]);
  installStorageStub(errMap);
  const errPosts: CapturedPost[] = [];
  installOAuthFetchStub(() => terminalResponse(), errPosts);
  try {
    const errored = await withFresh(() => action!.apply("test-actor-3666"));
    assert.equal(errored.state, "error", "terminal OAuth failure must map to error");
    assert.match(errored.detail ?? "", /HTTP 400/, "error detail must surface the OAuth failure");
    assert.equal(errMap.get(REFRESH), "rt-preapply2", "a failed forced rotation must NOT wipe tokens");
  } finally {
    restoreAll();
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["refresh POST → /oauth2/access_token, bare body when client creds unset", testRefreshBodyWithoutClientCreds],
    ["refresh POST includes client_id/client_secret from env when set", testRefreshBodyWithClientCreds],
    ["tick skips a young token far from expiry", testTickSkipsYoungToken],
    ["tick rotates inside the 48h pre-expiry window", testTickRotatesInsideExpiryWindow],
    ["tick rotates on age ≥ 3.5d despite far expiry (Task #3666)", testTickRotatesOnAgeDespiteFarExpiry],
    ["tick derives age from expiresAt − 7d when the stamp is missing", testTickDerivesAgeWhenStampMissing],
    ["tick force bypasses freshness checks", testTickForceBypassesFreshness],
    ["tick force still honors the no-tokens guard", testTickForceStillHonorsNoTokensGuard],
    ["tick terminal error surfaces without wiping tokens", testTickTerminalErrorPreservesTokens],
    ["lease held: proactive rotation still POSTs (prod no-op regression)", testLeaseHeldProactiveStillPosts],
    ["lease held: sibling-just-rotated short-circuits the POST", testLeaseHeldSiblingJustRotatedSkips],
    ["lease held: reactive-401 never reuses the rejected bearer (POSTs)", testLeaseHeld401RetryRejectedTokenStillPosts],
    ["lease held: reactive-401 reuses a sibling-rotated (different) token", testLeaseHeld401RetrySiblingRotatedReuses],
    ["lease held: on-demand fast path unchanged", testLeaseHeldOnDemandFastPathUnchanged],
    ["prod-action: registered; status blocked (no tokens / breaker open)", testProdActionRegistrationAndStatus],
    ["prod-action: apply → applied on success, error (+detail) on terminal", testProdActionApplyOutcomes],
  ];

  for (const [name, fn] of cases) {
    await fn();
    console.log(`  ✓ ${name}`);
  }
  console.log("semrush-keepalive-rotation-contract: OK");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    restoreAll();
    __setOAuthRefreshLeaseForTest(undefined);
    console.error("semrush-keepalive-rotation-contract: FAIL");
    console.error(err);
    process.exit(1);
  });
