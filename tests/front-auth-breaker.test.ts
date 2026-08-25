/* test-registration
{
  "name": "Front auth-dead circuit breaker (Task #2100)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2100 regression coverage for the Front auth-dead circuit breaker
 * (`server/services/frontAuthBreaker.ts`, wired into
 * `server/services/frontIntegration.ts`). Mirrors the Slack breaker
 * regression (Task #1606).
 *
 * Background: Front rotates its OAuth refresh token on every refresh and
 * a revoked token returns a 4xx `invalid_grant` from
 * POST https://app.frontapp.com/oauth/token. Without a global backoff,
 * every Front surface (live sync, webhook apply, historical recovery,
 * analytics self-heal) keeps re-driving the doomed refresh, flooding the
 * logs. The breaker trips on terminal auth failures and short-circuits
 * token acquisition for a cooldown window.
 *
 * Locks the following behavior in place:
 *   1. Every terminal Front auth code trips the breaker
 *      (front_not_connected / front_no_refresh_token /
 *      front_refresh_failed_permanent).
 *   2. Transient refresh failures (5xx, network) never trip the breaker.
 *   3. While open, `getValidFrontAccessToken()` short-circuits WITHOUT
 *      touching the network (kills the refresh hammering).
 *   4. `bypassBreaker: true` (the probe's recovery path) still issues the
 *      network call while the breaker is open.
 *   5. A successful token acquisition resets the breaker.
 *   6. A successful `/me` probe resets the breaker (operator reconnect
 *      clears the UI on the next poll).
 *   7. The throttle helper emits at most once per window per key.
 *   8. `getFrontAuthState()` exposes the Slack-shaped introspection.
 *
 * `global.fetch` is monkey-patched so the suite never hits real Front.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import {
  FrontAuthError,
  getValidFrontAccessToken,
  probeConnection,
} from "../server/services/frontIntegration";
import {
  __clearPersistedFrontAuthBreakerForTest,
  __readPersistedFrontAuthBreakerForTest,
  __resetFrontAuthBreakerForTest,
  __setFrontAuthStateForTest,
  __whenFrontAuthBreakerPersistSettledForTest,
  frontAuthBreakerActive,
  getFrontAuthState,
  hydrateFrontAuthBreakerFromStore,
  isFrontAuthTerminalCode,
  reconcileFrontAuthBreakerFromStore,
  resetFrontAuthBreaker,
  shouldLogFrontAuth,
  tripFrontAuthBreaker,
  TERMINAL_FRONT_AUTH_CODES,
} from "../server/services/frontAuthBreaker";

const SETTINGS_KEY_BREAKER_STATE = "front_auth_breaker_state";

// Trip/reset persist the durable signal fire-and-forget (the entry points
// are synchronous). A fixed delay races under shared-dev-DB contention
// (the write can land AFTER a subsequent read/clear), so await the queued
// write actually settling, then poll the store until it reflects the
// expected state instead of sleeping a flat 50ms.
async function waitForPersisted(
  read: () => Promise<string | null>,
  predicate: (raw: string | null) => boolean,
  label: string,
): Promise<string | null> {
  // Deterministic first: await the queued trip/reset persist actually
  // landing (DB write + cache invalidation). This is the real fix for the
  // contention flake — the read below then sees the committed value on the
  // first attempt.
  await __whenFrontAuthBreakerPersistSettledForTest();
  // Tolerant fallback poll for any residual cross-process lag (e.g. the
  // dev server racing the same row). Generous deadline so a slow shared
  // dev DB never trips a false timeout.
  const deadline = Date.now() + 15000;
  let raw = await read();
  while (!predicate(raw) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    raw = await read();
  }
  if (!predicate(raw)) {
    throw new Error(`waitForPersisted timed out waiting for: ${label}`);
  }
  return raw;
}

const SETTINGS_KEY_ACCESS = "front_access_token";
const SETTINGS_KEY_REFRESH = "front_refresh_token";
const SETTINGS_KEY_EXPIRES = "front_token_expires_at";
const FRONT_TOKEN_URL = "https://app.frontapp.com/oauth/token";
const FRONT_API_BASE = "https://api2.frontapp.com";

const originalFetch: typeof fetch = global.fetch;

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;
let tokenEndpointCalls = 0;
let meEndpointCalls = 0;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

global.fetch = (async (input: any, init?: any) => {
  // Short-circuit Upstash REST calls so the system_settings cache (this
  // suite repeatedly toggles the Front token rows) stays deterministic.
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url =
    typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.startsWith(FRONT_TOKEN_URL)) {
    tokenEndpointCalls++;
    if (fetchHandler) return fetchHandler(url, init);
    return jsonResponse({ ok: false }, 400);
  }
  if (url.startsWith(`${FRONT_API_BASE}/me`)) {
    meEndpointCalls++;
    if (fetchHandler) return fetchHandler(url, init);
    return jsonResponse({ id: "me" }, 200);
  }
  return originalFetch(input as any, init);
}) as any;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── token-row helpers ────────────────────────────────────────────────
async function setTokens(opts: {
  access?: string | null;
  refresh?: string | null;
  expiresAt?: number | null;
}): Promise<void> {
  if (opts.access === null) await storage.deleteSystemSetting(SETTINGS_KEY_ACCESS);
  else if (opts.access !== undefined) await storage.setSystemSetting(SETTINGS_KEY_ACCESS, opts.access, "system");
  if (opts.refresh === null) await storage.deleteSystemSetting(SETTINGS_KEY_REFRESH);
  else if (opts.refresh !== undefined) await storage.setSystemSetting(SETTINGS_KEY_REFRESH, opts.refresh, "system");
  if (opts.expiresAt === null) await storage.deleteSystemSetting(SETTINGS_KEY_EXPIRES);
  else if (opts.expiresAt !== undefined)
    await storage.setSystemSetting(SETTINGS_KEY_EXPIRES, String(opts.expiresAt), "system");
}

const PAST = Math.floor(Date.now() / 1000) - 3600;
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

async function resetAll(): Promise<void> {
  __resetFrontAuthBreakerForTest();
  fetchHandler = null;
  tokenEndpointCalls = 0;
  meEndpointCalls = 0;
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
  await resetAll();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    await resetAll();
  }
}

// Snapshot env + token rows so we restore exactly on exit.
const originalClientId = process.env.FRONT_CLIENT_ID;
const originalClientSecret = process.env.FRONT_CLIENT_SECRET;
let priorAccess: string | null | undefined;
let priorRefresh: string | null | undefined;
let priorExpires: string | null | undefined;

async function snapshot(key: string): Promise<string | null | undefined> {
  const row = await storage.getSystemSetting(key).catch(() => null);
  return row ? row.value ?? null : undefined;
}

async function restore(key: string, prior: string | null | undefined): Promise<void> {
  if (prior === undefined) await storage.deleteSystemSetting(key).catch(() => {});
  else await storage.setSystemSetting(key, prior ?? "", "system").catch(() => {});
}

async function main(): Promise<void> {
  console.log("Front auth breaker regression (Task #2100)");

  priorAccess = await snapshot(SETTINGS_KEY_ACCESS);
  priorRefresh = await snapshot(SETTINGS_KEY_REFRESH);
  priorExpires = await snapshot(SETTINGS_KEY_EXPIRES);

  // Refresh-path scenarios need OAuth creds present so
  // performTokenRefreshPost reaches the fetch (mocked) rather than
  // throwing "credentials not configured".
  process.env.FRONT_CLIENT_ID = originalClientId || "test-front-client-id";
  process.env.FRONT_CLIENT_SECRET = originalClientSecret || "test-front-client-secret";

  // ── Group 0 ── pure breaker-module invariants ───────────────────────
  await step("Group 0 — terminal-code set matches the spec", async () => {
    assert.deepEqual(
      [...TERMINAL_FRONT_AUTH_CODES].sort(),
      ["front_no_refresh_token", "front_not_connected", "front_refresh_failed_permanent"].sort(),
    );
    assert.equal(isFrontAuthTerminalCode("front_refresh_failed_permanent"), true);
    assert.equal(isFrontAuthTerminalCode("front_refresh_failed_transient"), false);
    assert.equal(isFrontAuthTerminalCode(null), false);
  });

  await step("Group 0 — trip/active/reset round-trips and getFrontAuthState shape", async () => {
    assert.equal(frontAuthBreakerActive(), false);
    tripFrontAuthBreaker("front_refresh_failed_permanent");
    assert.equal(frontAuthBreakerActive(), true);
    const s = getFrontAuthState();
    assert.equal(s.breakerOpen, true);
    assert.equal(s.authBroken, true);
    assert.equal(s.errorCode, "front_refresh_failed_permanent");
    assert.ok(s.cooldownRemainingMs > 0, "cooldownRemainingMs > 0");
    assert.ok(s.openedUntil, "openedUntil set");
    assert.equal(s.lastTrippedCode, "front_refresh_failed_permanent");
    assert.ok(s.tripCount >= 1, "tripCount incremented");
    resetFrontAuthBreaker();
    assert.equal(frontAuthBreakerActive(), false);
    assert.equal(getFrontAuthState().errorCode, null);
  });

  await step("Group 0 — throttle helper emits once per window per key", async () => {
    assert.equal(shouldLogFrontAuth("k1"), true, "first emit allowed");
    assert.equal(shouldLogFrontAuth("k1"), false, "second emit throttled");
    assert.equal(shouldLogFrontAuth("k2"), true, "different key not throttled");
  });

  // ── Group 1 ── terminal codes trip the breaker via the accessor ──────
  await step("Group 1 — no tokens → front_not_connected trips the breaker", async () => {
    await setTokens({ access: null, refresh: null, expiresAt: null });
    const err = await expectThrows(() => getValidFrontAccessToken({ purpose: "test" }));
    assert.ok(err.message.length > 0);
    assert.equal(frontAuthBreakerActive(), true, "breaker should be open");
    assert.equal(getFrontAuthState().errorCode, "front_not_connected");
  });

  await step("Group 1 — needs-refresh but no refresh token → front_no_refresh_token trips", async () => {
    await setTokens({ access: "stale-access", refresh: null, expiresAt: PAST });
    await expectThrows(() => getValidFrontAccessToken({ purpose: "test" }));
    assert.equal(frontAuthBreakerActive(), true);
    assert.equal(getFrontAuthState().errorCode, "front_no_refresh_token");
  });

  await step("Group 1 — refresh 400 invalid_grant → front_refresh_failed_permanent trips", async () => {
    await setTokens({ access: "stale-access", refresh: "revoked-refresh", expiresAt: PAST });
    fetchHandler = async (url) => {
      if (url.startsWith(FRONT_TOKEN_URL)) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      return jsonResponse({ ok: true });
    };
    await expectThrows(() => getValidFrontAccessToken({ forceRefresh: true, purpose: "test" }));
    assert.equal(frontAuthBreakerActive(), true);
    assert.equal(getFrontAuthState().errorCode, "front_refresh_failed_permanent");
    assert.ok(tokenEndpointCalls >= 1, "token endpoint should have been hit");
  });

  // ── Group 1b ── Task #2267: a non-authoritative (probe) terminal refresh
  // must NOT trip the breaker or wipe tokens ───────────────────────────
  await step("Group 1b — front_probe terminal invalid_grant does NOT trip the breaker (Task #2267)", async () => {
    // The Integrations-Hub badge probe and any pre-expiry top-up tag their
    // refresh `front_probe`. Front rotates its refresh token, so a probe
    // that loses the rotation race gets a terminal invalid_grant on an
    // already-consumed token. Committing a disconnect from THAT would back
    // off every healthy Front surface on a transient blip. The probe must
    // surface the failure to its caller WITHOUT tripping the breaker; a
    // real (authoritative) surface still trips when IT hits the same wall
    // (proven by the Group 1 `purpose: "test"` case above).
    await setTokens({ access: "stale-access", refresh: "revoked-refresh", expiresAt: PAST });
    fetchHandler = async (url) => {
      if (url.startsWith(FRONT_TOKEN_URL)) return jsonResponse({ error: "invalid_grant" }, 400);
      return jsonResponse({ ok: true });
    };
    const err = await expectThrows(() =>
      getValidFrontAccessToken({ forceRefresh: true, purpose: "front_probe", bypassBreaker: true }),
    );
    assert.ok(err.message.length > 0, "probe still surfaces the failure to its caller");
    assert.ok(tokenEndpointCalls >= 1, "the probe still attempted the refresh");
    assert.equal(frontAuthBreakerActive(), false, "non-authoritative terminal must NOT trip the breaker");
    // Tokens are left intact for the operator's real reconnect to use.
    assert.equal(
      (await storage.getSystemSetting(SETTINGS_KEY_REFRESH))?.value,
      "revoked-refresh",
      "refresh token preserved on a non-authoritative terminal",
    );
  });

  // ── Group 2 ── transient failures do NOT trip the breaker ────────────
  await step("Group 2 — refresh 500 → transient, breaker stays closed", async () => {
    await setTokens({ access: "stale-access", refresh: "ok-refresh", expiresAt: PAST });
    fetchHandler = async (url) => {
      if (url.startsWith(FRONT_TOKEN_URL)) return new Response("server error", { status: 500 });
      return jsonResponse({ ok: true });
    };
    await expectThrows(() => getValidFrontAccessToken({ forceRefresh: true, purpose: "test" }));
    assert.equal(frontAuthBreakerActive(), false, "transient must NOT trip the breaker");
  });

  await step("Group 2 — refresh network error → transient, breaker stays closed", async () => {
    await setTokens({ access: "stale-access", refresh: "ok-refresh", expiresAt: PAST });
    fetchHandler = async (url) => {
      if (url.startsWith(FRONT_TOKEN_URL)) throw new Error("ECONNREFUSED simulated");
      return jsonResponse({ ok: true });
    };
    await expectThrows(() => getValidFrontAccessToken({ forceRefresh: true, purpose: "test" }));
    assert.equal(frontAuthBreakerActive(), false);
  });

  // ── Group 3 ── open breaker short-circuits WITHOUT network ───────────
  await step("Group 3 — open breaker short-circuits getValidFrontAccessToken (no network)", async () => {
    await setTokens({ access: "stale-access", refresh: "revoked-refresh", expiresAt: PAST });
    tripFrontAuthBreaker("front_refresh_failed_permanent");
    tokenEndpointCalls = 0;
    const err = await expectThrows(() => getValidFrontAccessToken({ forceRefresh: true, purpose: "test" }));
    assert.match(err.message, /breaker|reconnect/i);
    assert.equal(tokenEndpointCalls, 0, "no token-endpoint fetch while breaker open");
  });

  // ── Group 4 ── bypassBreaker still issues the network call ───────────
  await step("Group 4 — bypassBreaker issues the refresh while breaker open", async () => {
    await setTokens({ access: "stale-access", refresh: "ok-refresh", expiresAt: PAST });
    tripFrontAuthBreaker("front_refresh_failed_permanent");
    tokenEndpointCalls = 0;
    fetchHandler = async (url) => {
      if (url.startsWith(FRONT_TOKEN_URL)) {
        return jsonResponse(
          { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_at: FUTURE },
          200,
        );
      }
      return jsonResponse({ ok: true });
    };
    const token = await getValidFrontAccessToken({ forceRefresh: true, purpose: "test", bypassBreaker: true });
    assert.equal(token, "fresh-access");
    assert.ok(tokenEndpointCalls >= 1, "bypass must reach the token endpoint");
    // A real refresh that persists fresh tokens (storeTokens) proves the live
    // credential works, so it clears the breaker.
    assert.equal(frontAuthBreakerActive(), false, "successful refresh + storeTokens clears the breaker");
  });

  // ── Group 5 ── a cached-token read must NOT reset the breaker ────────
  await step("Group 5 — cached unexpired token read does NOT reset the breaker", async () => {
    await setTokens({ access: "good-access", refresh: "ok-refresh", expiresAt: FUTURE });
    tripFrontAuthBreaker("front_refresh_failed_permanent");
    assert.equal(frontAuthBreakerActive(), true);
    // An unexpired *cached* access token is returned WITHOUT a network
    // refresh. A locally-unexpired token can still be revoked server-side,
    // so a cached read does not prove auth health and must NOT clear the
    // breaker — otherwise a revoked token re-enables the flood.
    tokenEndpointCalls = 0;
    const token = await getValidFrontAccessToken({ purpose: "test", bypassBreaker: true });
    assert.equal(token, "good-access");
    assert.equal(tokenEndpointCalls, 0, "no refresh for an unexpired cached token");
    assert.equal(frontAuthBreakerActive(), true, "cached read must NOT clear the breaker");
  });

  // ── Group 6 ── only a healthy /me probe resets the breaker ───────────
  await step("Group 6 — successful probe (/me 2xx) resets the breaker", async () => {
    await setTokens({ access: "good-access", refresh: "ok-refresh", expiresAt: FUTURE });
    tripFrontAuthBreaker("front_refresh_failed_permanent");
    fetchHandler = async (url) => {
      if (url.startsWith(`${FRONT_API_BASE}/me`)) return jsonResponse({ id: "me", name: "Inbox" }, 200);
      return jsonResponse({ ok: true });
    };
    const probe = await probeConnection();
    assert.equal(probe.outcome, "connected", `probe outcome should be connected (got ${probe.outcome})`);
    assert.equal(meEndpointCalls >= 1, true, "/me should have been hit (probe bypasses breaker)");
    assert.equal(frontAuthBreakerActive(), false, "breaker should clear after a healthy probe");
  });

  await step("Group 6 — probe with revoked-but-cached token (/me 401) does NOT reset", async () => {
    // The dangerous case the review flagged: breaker open, access token still
    // locally unexpired but revoked server-side. The probe bypasses the
    // breaker and returns the cached token, but /me 401s — the breaker must
    // stay open so Front surfaces keep backing off.
    await setTokens({ access: "good-access", refresh: "ok-refresh", expiresAt: FUTURE });
    tripFrontAuthBreaker("front_refresh_failed_permanent");
    fetchHandler = async (url) => {
      if (url.startsWith(`${FRONT_API_BASE}/me`)) return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse({ ok: true });
    };
    const probe = await probeConnection();
    assert.notEqual(probe.outcome, "connected", `401 probe must not report connected (got ${probe.outcome})`);
    assert.equal(meEndpointCalls >= 1, true, "/me should have been hit");
    assert.equal(frontAuthBreakerActive(), true, "a failed probe must NOT clear the breaker");
  });

  // ── Group 7 ── Task #2103 durable persistence across restarts/instances ─
  await step("Group 7 — trip persists the durable signal", async () => {
    await __clearPersistedFrontAuthBreakerForTest();
    tripFrontAuthBreaker("front_refresh_failed_permanent");
    const raw = await waitForPersisted(
      __readPersistedFrontAuthBreakerForTest,
      (r) => !!r,
      "trip persist",
    );
    assert.ok(raw, "durable signal should be persisted on trip");
    const parsed = JSON.parse(raw as string);
    assert.equal(parsed.code, "front_refresh_failed_permanent");
    assert.ok(Number(parsed.openedUntilMs) > Date.now(), "openedUntilMs in the future");
    await __clearPersistedFrontAuthBreakerForTest();
  });

  await step("Group 7 — reset clears the durable signal", async () => {
    tripFrontAuthBreaker("front_refresh_failed_permanent");
    await waitForPersisted(
      __readPersistedFrontAuthBreakerForTest,
      (r) => !!r,
      "trip persist before reset",
    );
    resetFrontAuthBreaker();
    const raw = await waitForPersisted(
      __readPersistedFrontAuthBreakerForTest,
      (r) => !r,
      "reset clear",
    );
    assert.ok(!raw, `durable signal should be cleared on reset (got ${JSON.stringify(raw)})`);
  });

  await step("Group 7 — hydrate re-tripps a fresh process from the durable signal", async () => {
    // Simulate instance A tripping + persisting, then a restart wiping the
    // in-memory breaker. Instance B (fresh memory) hydrates from the store.
    tripFrontAuthBreaker("front_refresh_failed_permanent");
    await waitForPersisted(
      __readPersistedFrontAuthBreakerForTest,
      (r) => !!r && Number(JSON.parse(r).openedUntilMs) > Date.now(),
      "trip persist before simulated restart",
    );
    // Wipe the in-memory open window only (mimic a restart) WITHOUT
    // clearing the store.
    __setFrontAuthStateForTest({ breakerOpenUntilMs: 0 });
    assert.equal(frontAuthBreakerActive(), false, "in-memory cleared (simulated restart)");
    const { breakerOpen } = await hydrateFrontAuthBreakerFromStore();
    assert.equal(breakerOpen, true, "hydrate should re-open from the durable signal");
    assert.equal(frontAuthBreakerActive(), true, "suppression restored after hydrate");
    assert.equal(getFrontAuthState().errorCode, "front_refresh_failed_permanent");
    await __clearPersistedFrontAuthBreakerForTest();
  });

  await step("Group 7 — reconcile clears in-memory when another instance cleared the store", async () => {
    // Local breaker open (tripped long enough ago to clear the persist
    // grace), store cleared by a reconnect on another instance.
    tripFrontAuthBreaker("front_refresh_failed_permanent");
    await waitForPersisted(
      __readPersistedFrontAuthBreakerForTest,
      (r) => !!r,
      "trip persist before clear",
    );
    await __clearPersistedFrontAuthBreakerForTest();
    // Age the local trip past the grace window so reconcile is allowed to
    // clear it.
    __setFrontAuthStateForTest({ lastTrippedAtMs: Date.now() - 60_000 });
    await reconcileFrontAuthBreakerFromStore();
    assert.equal(frontAuthBreakerActive(), false, "reconcile should mirror the store-cleared state");
  });

  await step("Group 7 — reconcile keeps a fresh local trip (persist grace)", async () => {
    // Local trip just happened and store still shows empty (its persist
    // raced behind). The grace window must protect the fresh trip.
    await __clearPersistedFrontAuthBreakerForTest();
    tripFrontAuthBreaker("front_refresh_failed_permanent");
    await reconcileFrontAuthBreakerFromStore();
    assert.equal(frontAuthBreakerActive(), true, "fresh local trip must survive a stale store read");
    await __clearPersistedFrontAuthBreakerForTest();
  });

  // ── Group 8 ── Task #2416 confirm-before-trip (absent vs unknown) ────
  // The hot-path accessor (`acquireValidFrontAccessToken`, reached via
  // `getValidFrontAccessToken`) must NOT flip the TERMINAL
  // `front_not_connected` breaker on a single falsy/cached read. Before
  // declaring "not connected" it re-reads BOTH tokens authoritatively
  // (cache-bypassing) and only trips on a CONFIRMED absence. A read that
  // itself fails is UNKNOWN, not absent → a transient, non-terminal error
  // that never trips the breaker. Mirrors SEMrush Group 6 (Task #2412).
  const origGetSystemSetting = storage.getSystemSetting.bind(storage);
  const origGetSystemSettingFresh = storage.getSystemSettingFresh.bind(storage);
  function toRow(key: string, value: string | undefined): any {
    return value === undefined
      ? undefined
      : { key, value, updatedAt: new Date(), updatedBy: "system" };
  }
  function installSettingStubs(opts: {
    cached: Record<string, string | undefined>;
    fresh: Record<string, string | undefined> | "throw";
  }): () => void {
    storage.getSystemSetting = (async (key: string) =>
      key in opts.cached ? toRow(key, opts.cached[key]) : origGetSystemSetting(key)) as any;
    storage.getSystemSettingFresh = (async (key: string) => {
      if (opts.fresh === "throw") throw new Error("simulated token read failure");
      return key in opts.fresh ? toRow(key, opts.fresh[key]) : origGetSystemSettingFresh(key);
    }) as any;
    return () => {
      storage.getSystemSetting = origGetSystemSetting as any;
      storage.getSystemSettingFresh = origGetSystemSettingFresh as any;
    };
  }

  await step("Group 8 — stale falsy cache but token present in DB → no trip, uses fresh token", async () => {
    // The cached read reports BOTH tokens absent (stale negative cache /
    // transient empty), but the authoritative re-read shows a valid,
    // unexpired access token. Must NOT trip; must return the fresh token
    // without any refresh POST.
    const restoreStubs = installSettingStubs({
      cached: {
        [SETTINGS_KEY_ACCESS]: undefined,
        [SETTINGS_KEY_REFRESH]: undefined,
        [SETTINGS_KEY_EXPIRES]: undefined,
      },
      fresh: {
        [SETTINGS_KEY_ACCESS]: "live-access",
        [SETTINGS_KEY_REFRESH]: "live-refresh",
        [SETTINGS_KEY_EXPIRES]: String(FUTURE),
      },
    });
    try {
      const token = await getValidFrontAccessToken({ purpose: "test" });
      assert.equal(token, "live-access", "returns the authoritative fresh access token");
      assert.equal(frontAuthBreakerActive(), false, "must NOT trip on a stale falsy cache");
      assert.equal(getFrontAuthState().errorCode, null, "no not-connected error code recorded");
      assert.equal(tokenEndpointCalls, 0, "valid fresh token → no refresh POST");
    } finally {
      restoreStubs();
    }
  });

  await step("Group 8 — falsy access + refresh present → routes to refresh, no not_connected trip", async () => {
    // Cached read shows both absent; the authoritative re-read finds no
    // access but a live refresh token, so the accessor refreshes instead of
    // declaring the integration disconnected.
    fetchHandler = async (url) => {
      if (url.startsWith(FRONT_TOKEN_URL))
        return jsonResponse(
          { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_at: FUTURE },
          200,
        );
      return jsonResponse({ ok: true });
    };
    // The refresh path's `readRefreshToken` reads the refresh token via the
    // (cached) getSystemSetting, so keep it present there too; the access
    // token is what's absent and triggers the confirm re-read.
    const restoreStubs = installSettingStubs({
      cached: { [SETTINGS_KEY_ACCESS]: undefined, [SETTINGS_KEY_REFRESH]: "ok-refresh" },
      fresh: {
        [SETTINGS_KEY_ACCESS]: undefined,
        [SETTINGS_KEY_REFRESH]: "ok-refresh",
        [SETTINGS_KEY_EXPIRES]: String(PAST),
      },
    });
    try {
      // Authoritative purpose so a terminal outcome WOULD trip — we assert it
      // does not, because a refresh token is present.
      const token = await getValidFrontAccessToken({ purpose: "front_live_sync" });
      assert.equal(token, "fresh-access", "returns the refreshed access token");
      assert.equal(frontAuthBreakerActive(), false, "refresh-present path must NOT trip");
      assert.notEqual(
        getFrontAuthState().errorCode,
        "front_not_connected",
        "must not declare not-connected when a refresh token exists",
      );
      assert.ok(tokenEndpointCalls >= 1, "should have attempted a refresh");
    } finally {
      restoreStubs();
    }
  });

  await step("Group 8 — authoritative re-read throws → UNKNOWN, transient, no trip", async () => {
    // The cache-bypassing re-read itself fails. Absence is NOT confirmed, so
    // the accessor must surface a transient/retryable error WITHOUT tripping
    // the terminal breaker. An authoritative purpose makes a terminal outcome
    // tripworthy — assert the transient code is NOT terminal so it cannot.
    const restoreStubs = installSettingStubs({
      cached: { [SETTINGS_KEY_ACCESS]: undefined, [SETTINGS_KEY_REFRESH]: undefined },
      fresh: "throw",
    });
    try {
      const err = await expectThrows(() =>
        getValidFrontAccessToken({ purpose: "front_live_sync" }),
      );
      assert.match(err.message, /unknown|read failed|will retry/i, "transient/unknown error surfaced");
      assert.equal(frontAuthBreakerActive(), false, "a failed read must NOT trip the breaker");
      assert.equal(getFrontAuthState().errorCode, null, "no terminal code recorded");
      assert.equal(tokenEndpointCalls, 0, "no refresh attempted on an unknown read");
      // The downstream contract that actually prevents the false disconnect:
      // the surfaced code must be NON-terminal so getValidFrontAccessToken's
      // catch cannot trip the breaker on it.
      assert.ok(err instanceof FrontAuthError, "surfaces a FrontAuthError");
      assert.equal(
        isFrontAuthTerminalCode((err as any).code),
        false,
        "an unknown read must use a NON-terminal code (front_refresh_failed_transient)",
      );
    } finally {
      restoreStubs();
    }
  });

  await step("Group 8 — confirmed both-absent (cache-bypassing) still trips not_connected", async () => {
    // The genuine disconnect: no access AND no refresh token, confirmed via
    // the authoritative re-read. With an authoritative purpose this MUST
    // still trip the terminal breaker.
    const restoreStubs = installSettingStubs({
      cached: { [SETTINGS_KEY_ACCESS]: undefined, [SETTINGS_KEY_REFRESH]: undefined },
      fresh: {
        [SETTINGS_KEY_ACCESS]: undefined,
        [SETTINGS_KEY_REFRESH]: undefined,
        [SETTINGS_KEY_EXPIRES]: undefined,
      },
    });
    try {
      const err = await expectThrows(() =>
        getValidFrontAccessToken({ purpose: "front_live_sync" }),
      );
      assert.ok(err instanceof FrontAuthError);
      assert.equal((err as any).code, "front_not_connected", "confirmed absence → not_connected");
      assert.equal(frontAuthBreakerActive(), true, "confirmed absence must trip");
      assert.equal(getFrontAuthState().errorCode, "front_not_connected");
      assert.equal(tokenEndpointCalls, 0, "no refresh attempted when no refresh token exists");
    } finally {
      restoreStubs();
    }
  });

  if (failures > 0) {
    throw new Error(`${failures} test(s) failed`);
  }
  console.log("\nAll Front auth breaker regression tests passed");
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
    if (originalClientId === undefined) delete process.env.FRONT_CLIENT_ID;
    else process.env.FRONT_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.FRONT_CLIENT_SECRET;
    else process.env.FRONT_CLIENT_SECRET = originalClientSecret;
    // Restore Front token rows to their prior values so we don't leak
    // fake tokens into other suites that share the dev DB.
    await restore(SETTINGS_KEY_ACCESS, priorAccess);
    await restore(SETTINGS_KEY_REFRESH, priorRefresh);
    await restore(SETTINGS_KEY_EXPIRES, priorExpires);
    process.exitCode = exitCode;
  });
