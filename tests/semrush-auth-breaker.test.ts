/* test-registration
{
  "name": "SEMrush auth-dead circuit breaker (Task #2102)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.6s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2102 regression coverage for the SEMrush auth-dead circuit
 * breaker (`server/services/semrushAuthBreaker.ts`, wired into
 * `server/services/semrushApi.ts`). Mirrors the Front auth breaker
 * regression (`tests/front-auth-breaker.test.ts`, Task #2100).
 *
 * Background: the system-wide SEMrush OAuth refresh token can be revoked.
 * Per SEMrush's OAuth docs the refresh exchange POSTs to
 * https://oauth.semrush.com/dag/device/token and a rejected refresh token
 * returns a 4xx carrying `invalid_request` (SEMrush's variant — NOT the
 * spec `invalid_grant`). Without a global backoff, the Local-Dominance
 * sweep (one attempt per client × location) plus the Integrations-Hub
 * probe keep re-driving the doomed refresh, flooding production logs. The
 * breaker trips on terminal auth failures and short-circuits token
 * acquisition for a cooldown window.
 *
 * Locks the following behavior in place:
 *   1. Every terminal SEMrush auth code trips the breaker
 *      (semrush_not_connected / semrush_no_refresh_token /
 *      semrush_refresh_failed_permanent).
 *   2. Transient refresh failures (5xx, network) never trip the breaker.
 *   3. While open, `getAccessToken()` (reached via any SEMrush API call)
 *      short-circuits WITHOUT touching the network.
 *   4. The probe (`probeConnection`) does NOT go through `getAccessToken`
 *      so it naturally bypasses the breaker; a successful refresh on the
 *      probe path resets the breaker (operator reconnect recovery).
 *   5. `getSemrushAuthState()` exposes the Front-shaped introspection.
 *
 * `global.fetch` is monkey-patched so the suite never hits real SEMrush.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import {
  getCampaign,
  probeConnection,
  SemrushAuthUnknownError,
} from "../server/services/semrushApi";
import {
  classifyError,
  markPausedAuth,
  recoverPausedAuthRows,
} from "../server/services/semrushLocationSyncState";
import { workerDb } from "../server/db";
import {
  clients,
  clientLocations,
  clientSemrushIntegrations,
  semrushLocationSyncState,
} from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  __clearPersistedSemrushAuthBreakerForTest,
  __readPersistedSemrushAuthBreakerForTest,
  __resetSemrushAuthBreakerForTest,
  __setSemrushAuthStateForTest,
  __whenSemrushAuthBreakerPersistSettledForTest,
  getSemrushAuthState,
  hydrateSemrushAuthBreakerFromStore,
  isSemrushAuthTerminalCode,
  reconcileSemrushAuthBreakerFromStore,
  resetSemrushAuthBreaker,
  semrushAuthBreakerActive,
  tripSemrushAuthBreaker,
  TERMINAL_SEMRUSH_AUTH_CODES,
} from "../server/services/semrushAuthBreaker";

// The durable persist is fire-and-forget (the trip entry point is
// synchronous). A fixed delay races under shared-dev-DB contention (the
// trip's write can land AFTER a subsequent read/clear), so poll the store
// until it reflects the expected state instead of sleeping a flat 50ms.
async function waitForPersisted(
  read: () => Promise<string | null>,
  predicate: (raw: string | null) => boolean,
  label: string,
): Promise<string | null> {
  // Deterministic first: await the queued trip/reset persist actually
  // landing (DB write + cache invalidation) instead of guessing a delay.
  // This is the real fix for the contention flake — the read below then
  // sees the committed value on the first attempt.
  await __whenSemrushAuthBreakerPersistSettledForTest();
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

const SETTINGS_KEY_ACCESS = "semrush_access_token";
const SETTINGS_KEY_REFRESH = "semrush_refresh_token";
const SETTINGS_KEY_EXPIRES = "semrush_token_expires_at";
// Task #3666 — endpoint changed from /dag/device/token to /oauth2/access_token.
const OAUTH_TOKEN_URL = "https://oauth.semrush.com/oauth2/access_token";
const SEMRUSH_API_BASE = "https://api.semrush.com";

const originalFetch: typeof fetch = global.fetch;

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;
let tokenEndpointCalls = 0;
let apiBaseCalls = 0;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url =
    typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.startsWith(OAUTH_TOKEN_URL)) {
    tokenEndpointCalls++;
    if (fetchHandler) return fetchHandler(url, init);
    return new Response("invalid_request", { status: 400 });
  }
  if (url.startsWith(SEMRUSH_API_BASE)) {
    apiBaseCalls++;
    if (fetchHandler) return fetchHandler(url, init);
    return jsonResponse({ data: {} }, 200);
  }
  return originalFetch(input as any, init);
}) as any;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

const PAST = Date.now() - 3_600_000;
const FUTURE = Date.now() + 3_600_000;

async function resetAll(): Promise<void> {
  __resetSemrushAuthBreakerForTest();
  fetchHandler = null;
  tokenEndpointCalls = 0;
  apiBaseCalls = 0;
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

async function main(): Promise<void> {
  console.log("SEMrush auth breaker regression (Task #2102)");

  priorAccess = await snapshot(SETTINGS_KEY_ACCESS);
  priorRefresh = await snapshot(SETTINGS_KEY_REFRESH);
  priorExpires = await snapshot(SETTINGS_KEY_EXPIRES);

  // ── Group 0 ── pure breaker-module invariants ───────────────────────
  await step("Group 0 — terminal-code set matches the spec", async () => {
    assert.deepEqual(
      [...TERMINAL_SEMRUSH_AUTH_CODES].sort(),
      ["semrush_no_refresh_token", "semrush_not_connected", "semrush_refresh_failed_permanent"].sort(),
    );
    assert.equal(isSemrushAuthTerminalCode("semrush_refresh_failed_permanent"), true);
    assert.equal(isSemrushAuthTerminalCode("semrush_refresh_failed_transient"), false);
    assert.equal(isSemrushAuthTerminalCode(null), false);
  });

  await step("Group 0 — trip/active/reset round-trips and getSemrushAuthState shape", async () => {
    assert.equal(semrushAuthBreakerActive(), false);
    tripSemrushAuthBreaker("semrush_refresh_failed_permanent");
    assert.equal(semrushAuthBreakerActive(), true);
    const s = getSemrushAuthState();
    assert.equal(s.breakerOpen, true);
    assert.equal(s.authBroken, true);
    assert.equal(s.errorCode, "semrush_refresh_failed_permanent");
    assert.ok(s.cooldownRemainingMs > 0, "cooldownRemainingMs > 0");
    assert.ok(s.openedUntil, "openedUntil set");
    assert.equal(s.lastTrippedCode, "semrush_refresh_failed_permanent");
    assert.ok(s.tripCount >= 1, "tripCount incremented");
    resetSemrushAuthBreaker();
    assert.equal(semrushAuthBreakerActive(), false);
    assert.equal(getSemrushAuthState().errorCode, null);
  });

  // ── Group 1 ── terminal codes trip the breaker via the accessor ──────
  await step("Group 1 — no access token → semrush_not_connected trips the breaker", async () => {
    await setTokens({ access: null, refresh: null, expiresAt: null });
    await expectThrows(() => getCampaign("c1"));
    assert.equal(semrushAuthBreakerActive(), true, "breaker should be open");
    assert.equal(getSemrushAuthState().errorCode, "semrush_not_connected");
  });

  await step("Group 1 — refresh 400 invalid_request → semrush_refresh_failed_permanent trips", async () => {
    await setTokens({ access: "stale-access", refresh: "revoked-refresh", expiresAt: PAST });
    fetchHandler = async (url) => {
      if (url.startsWith(OAUTH_TOKEN_URL)) return new Response("invalid_request", { status: 400 });
      return jsonResponse({ data: {} });
    };
    await expectThrows(() => getCampaign("c1"));
    assert.equal(semrushAuthBreakerActive(), true);
    assert.equal(getSemrushAuthState().errorCode, "semrush_refresh_failed_permanent");
    assert.ok(tokenEndpointCalls >= 1, "token endpoint should have been hit");
  });

  // ── Group 2 ── transient failures do NOT trip the breaker ────────────
  await step("Group 2 — refresh 500 → transient, breaker stays closed", async () => {
    await setTokens({ access: "stale-access", refresh: "ok-refresh", expiresAt: PAST });
    fetchHandler = async (url) => {
      if (url.startsWith(OAUTH_TOKEN_URL)) return new Response("server error", { status: 500 });
      return jsonResponse({ data: {} });
    };
    await expectThrows(() => getCampaign("c1"));
    assert.equal(semrushAuthBreakerActive(), false, "transient must NOT trip the breaker");
  });

  await step("Group 2 — refresh network error → transient, breaker stays closed", async () => {
    await setTokens({ access: "stale-access", refresh: "ok-refresh", expiresAt: PAST });
    fetchHandler = async (url) => {
      if (url.startsWith(OAUTH_TOKEN_URL)) throw new Error("ECONNREFUSED simulated");
      return jsonResponse({ data: {} });
    };
    await expectThrows(() => getCampaign("c1"));
    assert.equal(semrushAuthBreakerActive(), false);
  });

  // ── Group 3 ── open breaker short-circuits WITHOUT network ───────────
  await step("Group 3 — open breaker short-circuits SEMrush API calls (no network)", async () => {
    await setTokens({ access: "stale-access", refresh: "revoked-refresh", expiresAt: PAST });
    tripSemrushAuthBreaker("semrush_refresh_failed_permanent");
    tokenEndpointCalls = 0;
    apiBaseCalls = 0;
    const err = await expectThrows(() => getCampaign("c1"));
    assert.match(err.message, /breaker|re-authorize|not connected/i);
    assert.equal(tokenEndpointCalls, 0, "no token-endpoint fetch while breaker open");
    assert.equal(apiBaseCalls, 0, "no SEMrush API fetch while breaker open");
  });

  // ── Group 4 ── a successful probe refresh resets the breaker ─────────
  await step("Group 4 — successful refresh on the probe path resets the breaker", async () => {
    // Probe path: expired access token forces refreshAccessToken, which on
    // a 200 resets the breaker. The probe never calls getAccessToken, so it
    // naturally bypasses the open-breaker short-circuit.
    await setTokens({ access: "stale-access", refresh: "ok-refresh", expiresAt: PAST });
    tripSemrushAuthBreaker("semrush_refresh_failed_permanent");
    assert.equal(semrushAuthBreakerActive(), true);
    fetchHandler = async (url) => {
      if (url.startsWith(OAUTH_TOKEN_URL)) {
        return jsonResponse(
          { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 },
          200,
        );
      }
      return jsonResponse({ data: {} });
    };
    const probe = await probeConnection();
    assert.equal(probe.outcome, "connected", `probe outcome should be connected (got ${probe.outcome})`);
    assert.ok(tokenEndpointCalls >= 1, "probe must reach the token endpoint");
    assert.equal(semrushAuthBreakerActive(), false, "successful refresh resets the breaker");
  });

  // ── Group 5 ── Task #2122 durable persistence across restarts/instances ─
  await step("Group 5 — trip persists the durable signal", async () => {
    await __clearPersistedSemrushAuthBreakerForTest();
    tripSemrushAuthBreaker("semrush_refresh_failed_permanent");
    const raw = await waitForPersisted(
      __readPersistedSemrushAuthBreakerForTest,
      (r) => !!r,
      "trip persist",
    );
    assert.ok(raw, "durable signal should be persisted on trip");
    const parsed = JSON.parse(raw as string);
    assert.equal(parsed.code, "semrush_refresh_failed_permanent");
    assert.ok(Number(parsed.openedUntilMs) > Date.now(), "openedUntilMs in the future");
    await __clearPersistedSemrushAuthBreakerForTest();
  });

  await step("Group 5 — reset clears the durable signal", async () => {
    tripSemrushAuthBreaker("semrush_refresh_failed_permanent");
    await waitForPersisted(
      __readPersistedSemrushAuthBreakerForTest,
      (r) => !!r,
      "trip persist before reset",
    );
    resetSemrushAuthBreaker();
    const raw = await waitForPersisted(
      __readPersistedSemrushAuthBreakerForTest,
      (r) => !r,
      "reset clear",
    );
    assert.ok(!raw, `durable signal should be cleared on reset (got ${JSON.stringify(raw)})`);
  });

  await step("Group 5 — hydrate re-tripps a fresh process from the durable signal", async () => {
    tripSemrushAuthBreaker("semrush_refresh_failed_permanent");
    await waitForPersisted(
      __readPersistedSemrushAuthBreakerForTest,
      (r) => !!r && Number(JSON.parse(r).openedUntilMs) > Date.now(),
      "trip persist before simulated restart",
    );
    __setSemrushAuthStateForTest({ breakerOpenUntilMs: 0 });
    assert.equal(semrushAuthBreakerActive(), false, "in-memory cleared (simulated restart)");
    const { breakerOpen } = await hydrateSemrushAuthBreakerFromStore();
    assert.equal(breakerOpen, true, "hydrate should re-open from the durable signal");
    assert.equal(semrushAuthBreakerActive(), true, "suppression restored after hydrate");
    assert.equal(getSemrushAuthState().errorCode, "semrush_refresh_failed_permanent");
    await __clearPersistedSemrushAuthBreakerForTest();
  });

  await step("Group 5 — reconcile clears in-memory when another instance cleared the store", async () => {
    tripSemrushAuthBreaker("semrush_refresh_failed_permanent");
    await waitForPersisted(
      __readPersistedSemrushAuthBreakerForTest,
      (r) => !!r,
      "trip persist before clear",
    );
    await __clearPersistedSemrushAuthBreakerForTest();
    __setSemrushAuthStateForTest({ lastTrippedAtMs: Date.now() - 60_000 });
    await reconcileSemrushAuthBreakerFromStore();
    assert.equal(semrushAuthBreakerActive(), false, "reconcile should mirror the store-cleared state");
  });

  await step("Group 5 — reconcile keeps a fresh local trip (persist grace)", async () => {
    await __clearPersistedSemrushAuthBreakerForTest();
    tripSemrushAuthBreaker("semrush_refresh_failed_permanent");
    await reconcileSemrushAuthBreakerFromStore();
    assert.equal(semrushAuthBreakerActive(), true, "fresh local trip must survive a stale store read");
    await __clearPersistedSemrushAuthBreakerForTest();
  });

  // ── Group 6 ── Task #2412 confirm-before-trip (absent vs unknown) ─────
  // The hot-path accessor must NOT flip the TERMINAL `semrush_not_connected`
  // breaker on a single falsy/cached read. Before declaring "not connected"
  // it re-reads BOTH tokens authoritatively (cache-bypassing) and only trips
  // on a CONFIRMED absence. A read that itself fails is UNKNOWN, not absent.
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

  await step("Group 6 — stale falsy cache but token present in DB → no trip, uses fresh token", async () => {
    // The cached read reports the access token absent (stale negative cache /
    // transient empty), but the authoritative re-read shows it is present.
    const restoreStubs = installSettingStubs({
      cached: { [SETTINGS_KEY_ACCESS]: undefined, [SETTINGS_KEY_EXPIRES]: String(FUTURE) },
      fresh: {
        [SETTINGS_KEY_ACCESS]: "live-access",
        [SETTINGS_KEY_REFRESH]: "live-refresh",
        [SETTINGS_KEY_EXPIRES]: String(FUTURE),
      },
    });
    try {
      // getCampaign may throw later on the stub API body shape; we only care
      // that token acquisition did NOT trip and DID use the fresh token.
      await getCampaign("c1").catch(() => {});
      assert.equal(semrushAuthBreakerActive(), false, "must NOT trip on a stale falsy cache");
      assert.equal(getSemrushAuthState().errorCode, null, "no not-connected error code");
      assert.equal(tokenEndpointCalls, 0, "valid fresh token → no refresh POST");
      assert.ok(apiBaseCalls >= 1, "proceeded to the SEMrush API with the fresh token");
    } finally {
      restoreStubs();
    }
  });

  await step("Group 6 — falsy access + refresh present → routes to refresh, no not_connected trip", async () => {
    // Real tokens: access deleted, refresh present. The confirm re-read finds
    // no access but a live refresh, so the accessor refreshes instead of
    // declaring the integration disconnected.
    await setTokens({ access: null, refresh: "ok-refresh", expiresAt: null });
    fetchHandler = async (url) => {
      if (url.startsWith(OAUTH_TOKEN_URL)) {
        return jsonResponse(
          { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 },
          200,
        );
      }
      return jsonResponse({ data: {} });
    };
    await getCampaign("c1").catch(() => {});
    assert.equal(semrushAuthBreakerActive(), false, "refresh-present path must NOT trip");
    assert.notEqual(
      getSemrushAuthState().errorCode,
      "semrush_not_connected",
      "must not declare not-connected when a refresh token exists",
    );
    assert.ok(tokenEndpointCalls >= 1, "should have attempted a refresh");
  });

  await step("Group 6 — authoritative re-read throws → UNKNOWN, no trip (transient)", async () => {
    // State 3: the cache-bypassing re-read itself fails. Absence is not
    // confirmed, so the accessor must surface a transient error WITHOUT
    // tripping the terminal breaker.
    const restoreStubs = installSettingStubs({
      cached: { [SETTINGS_KEY_ACCESS]: undefined },
      fresh: "throw",
    });
    try {
      const err = await expectThrows(() => getCampaign("c1"));
      assert.match(err.message, /unknown|read failed|retry/i, "transient/unknown error surfaced");
      assert.equal(semrushAuthBreakerActive(), false, "a failed read must NOT trip the breaker");
      assert.equal(getSemrushAuthState().errorCode, null, "no terminal code recorded");
      assert.equal(tokenEndpointCalls, 0, "no refresh attempted on an unknown read");
      // The downstream contract that actually prevents the false disconnect:
      // a failed read must classify as a RETRYABLE transient error, never the
      // permanent `auth_config` that folds the location sync into `paused_auth`
      // (the "Reconnect Required" symptom). Assert both the error type and the
      // classifier verdict, not just that the breaker stayed closed.
      assert.ok(
        err instanceof SemrushAuthUnknownError,
        "an unknown read surfaces SemrushAuthUnknownError, not SemrushAuthMissingError",
      );
      assert.equal(
        classifyError(err),
        "transient",
        "an unknown read must classify as transient/retryable, never auth_config",
      );
    } finally {
      restoreStubs();
    }
  });

  await step("Group 6 — confirmed both-absent (cache-bypassing) still trips not_connected", async () => {
    // The genuine disconnect: no access AND no refresh token, confirmed via
    // the authoritative re-read. This MUST still trip the terminal breaker.
    await setTokens({ access: null, refresh: null, expiresAt: null });
    await expectThrows(() => getCampaign("c1"));
    assert.equal(semrushAuthBreakerActive(), true, "confirmed absence must trip");
    assert.equal(getSemrushAuthState().errorCode, "semrush_not_connected");
    assert.equal(tokenEndpointCalls, 0, "no refresh attempted when no refresh token exists");
  });

  // ── Group 7 ── Task #2643 auth-breaker self-heals from healthy traffic ─
  // The recurring false-disconnect: a rotation-race wipe (or any misclassified
  // blip) trips the GLOBAL auth breaker, but the breaker only ever cleared on
  // a successful refresh or operator reconnect. A successful authenticated API
  // call recorded success on the CIRCUIT breaker, NOT the auth breaker, so a
  // FALSE trip had no path back to healthy from ordinary traffic — operators
  // kept filing "SEMrush auth missing" on a live connection. Now a bearer-token
  // API call that returns 200 is treated as proof the credential is live and
  // clears the auth breaker.
  await step("Group 7 — successful API call while breaker open self-heals it", async () => {
    // Valid (unexpired) access token so getAccessToken returns WITHOUT a
    // refresh and WITHOUT short-circuiting (breaker is closed at entry).
    await setTokens({ access: "live-access", refresh: "live-refresh", expiresAt: FUTURE });
    // Model the race: the breaker is tripped by a concurrent caller AFTER the
    // token was acquired but BEFORE the success check, by tripping it from
    // inside the API fetch handler. The call still returns 200.
    fetchHandler = async (url) => {
      if (url.startsWith(SEMRUSH_API_BASE)) {
        tripSemrushAuthBreaker("semrush_refresh_failed_permanent");
        return jsonResponse({ data: {} }, 200);
      }
      return jsonResponse({ data: {} });
    };
    await getCampaign("c1").catch(() => {});
    assert.equal(tokenEndpointCalls, 0, "valid token → no refresh POST");
    assert.ok(apiBaseCalls >= 1, "the authenticated API call reached SEMrush");
    assert.equal(
      semrushAuthBreakerActive(),
      false,
      "a successful authenticated API call must self-heal the auth breaker",
    );
    assert.equal(getSemrushAuthState().errorCode, null, "error code cleared on self-heal");
  });

  await step("Group 7 — healthy traffic with breaker CLOSED does not churn (no false reset signal)", async () => {
    // Guard: the self-heal is gated on `semrushAuthBreakerActive()`, so the
    // happy path (breaker already closed) must not even attempt a reset. We
    // assert the breaker simply stays closed across a normal successful call.
    await setTokens({ access: "live-access", refresh: "live-refresh", expiresAt: FUTURE });
    fetchHandler = async () => jsonResponse({ data: {} }, 200);
    assert.equal(semrushAuthBreakerActive(), false, "precondition: breaker closed");
    await getCampaign("c1").catch(() => {});
    assert.equal(semrushAuthBreakerActive(), false, "breaker stays closed on the happy path");
  });

  await step("Group 7 — reactive-401 refresh is single-flight/lease-covered (concurrent → ONE refresh POST)", async () => {
    // Task #2643 — the reactive-401 recovery refresh must route through the
    // SAME withSingleFlightOAuthRefresh + cross-process lease as every other
    // refresh (purpose "401_retry"), so two autoscale-style concurrent callers
    // that both 401 collapse to a SINGLE refresh POST rather than racing the
    // rotating refresh token. Under NODE_ENV=test the lease is in-process only,
    // so the observable here is the single-flight collapse.
    await setTokens({ access: "stale-access", refresh: "live-refresh", expiresAt: FUTURE });
    fetchHandler = async (url, init) => {
      if (url.startsWith(OAUTH_TOKEN_URL)) {
        return jsonResponse(
          { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 },
          200,
        );
      }
      if (url.startsWith(SEMRUSH_API_BASE)) {
        const auth = String((init?.headers as any)?.Authorization ?? "");
        // The pre-refresh (stale) bearer token 401s; the post-refresh token
        // succeeds. This forces every caller down the reactive-401 path.
        return auth.includes("fresh-access")
          ? jsonResponse({ data: {} }, 200)
          : new Response("unauthorized", { status: 401 });
      }
      return jsonResponse({ data: {} });
    };
    await Promise.allSettled([getCampaign("c1"), getCampaign("c2")]);
    assert.equal(
      tokenEndpointCalls,
      1,
      `concurrent 401s must single-flight to ONE refresh POST (got ${tokenEndpointCalls})`,
    );
    assert.equal(semrushAuthBreakerActive(), false, "successful 401 recovery leaves breaker closed");
  });

  // ── Group 8 ── Task #2643 recovery clears stale paused_auth on both grains ─
  // When auth is restored, BOTH the per-location sync_state rows and the
  // per-client integration rows stamped `paused_auth` by the sweep must clear
  // so client pages return to normal without an operator action.
  await step("Group 8 — recoverPausedAuthRows clears location + client-integration paused_auth", async () => {
    // Seed a real client (clientSemrushIntegrations has a NOT NULL FK to it).
    const [client] = await workerDb
      .insert(clients)
      .values({ firmName: `t2643-recovery-${Date.now()}` })
      .returning({ id: clients.id });
    const clientId = client.id;
    try {
      // sync_state.location_id has a FK to client_locations.id, so seed one.
      const [location] = await workerDb
        .insert(clientLocations)
        .values({ clientId, name: "t2643-loc" })
        .returning({ id: clientLocations.id });
      // A paused_auth location sync_state row keyed by the triple.
      const key = { clientId, locationId: location.id, campaignId: "camp-1" };
      await markPausedAuth(key, "sweep short-circuit — Semrush not connected");
      // A paused_auth client integration row.
      await workerDb.insert(clientSemrushIntegrations).values({
        clientId,
        syncStatus: "paused_auth",
        lastSyncOutcome: "paused_auth",
        errorMessage: "sweep short-circuit",
      });

      const { locationRows, integrationRows } = await recoverPausedAuthRows();
      assert.ok(locationRows >= 1, `>=1 location row cleared (got ${locationRows})`);
      assert.ok(integrationRows >= 1, `>=1 integration row cleared (got ${integrationRows})`);

      const [loc] = await workerDb
        .select({ status: semrushLocationSyncState.status })
        .from(semrushLocationSyncState)
        .where(eq(semrushLocationSyncState.clientId, clientId));
      assert.equal(loc?.status, "queued", "location row flipped paused_auth → queued");

      const [integ] = await workerDb
        .select({ syncStatus: clientSemrushIntegrations.syncStatus })
        .from(clientSemrushIntegrations)
        .where(eq(clientSemrushIntegrations.clientId, clientId));
      assert.equal(integ?.syncStatus, "idle", "integration row flipped paused_auth → idle");
    } finally {
      // sync_state + integration rows FK-cascade off clients.
      await workerDb.delete(clients).where(eq(clients.id, clientId)).catch(() => {});
    }
  });

  await step("Group 8 — recoverPausedAuthRows is idempotent / cheap when nothing is paused", async () => {
    const { locationRows, integrationRows } = await recoverPausedAuthRows();
    assert.ok(locationRows >= 0 && integrationRows >= 0, "non-negative counts, no throw");
  });

  // ─── Group 9: global-disconnect alert (Task #2877) ──────────────────────────
  // Tests the once-per-streak alerting logic in semrushDisconnectAlert.ts.
  // These are DB-free, network-free, and fast — suitable for SMOKE_FILES.
  //
  // Approach: monkey-patch notifyByType and markRecovered (imported from the
  // dispatcher module) at the module level by re-importing them through the
  // alert module's test seam. This avoids DB calls while still exercising
  // the real alert guard logic (kill-switch check, grace window gate,
  // dedupeKey construction).
  await step("Group 9 — checkSemrushGlobalDisconnectAlert: grace window suppresses early fire", async () => {
    const {
      checkSemrushGlobalDisconnectAlert: alertFn,
      SEMRUSH_DISCONNECT_ALERT_GRACE_MS,
      __resetSemrushDisconnectAlertStreakForTest,
      __setDispatcherForTest,
      __resetDispatcherForTest,
    } = await import("../server/services/semrushDisconnectAlert");

    let notifyCalls = 0;

    __setDispatcherForTest(
      async (_id: string, _payload: unknown, _opts?: unknown) => {
        notifyCalls++;
        return { ok: true, deliveryId: null };
      },
      async () => {},
    );

    try {
      __resetSemrushDisconnectAlertStreakForTest();
      __resetSemrushAuthBreakerForTest();
      // Trip the breaker but set lastTrippedAt to NOW (inside grace window)
      const recentTripMs = Date.now() - Math.floor(SEMRUSH_DISCONNECT_ALERT_GRACE_MS / 2);
      __setSemrushAuthStateForTest({
        lastTrippedAtMs: recentTripMs,
        breakerOpenUntilMs: Date.now() + 60_000,
        tripCount: 1,
      });

      await alertFn("breaker_open");

      assert.equal(notifyCalls, 0, "alert must NOT fire while inside grace window");
    } finally {
      __resetDispatcherForTest();
      __resetSemrushDisconnectAlertStreakForTest();
      __resetSemrushAuthBreakerForTest();
    }
  });

  await step("Group 9 — checkSemrushGlobalDisconnectAlert: alert fires after grace window elapses", async () => {
    const {
      checkSemrushGlobalDisconnectAlert: alertFn,
      SEMRUSH_DISCONNECT_ALERT_GRACE_MS,
      __getSemrushDisconnectAlertKeysForTest,
      __resetSemrushDisconnectAlertStreakForTest,
      __setDispatcherForTest,
      __resetDispatcherForTest,
    } = await import("../server/services/semrushDisconnectAlert");

    const { notificationId, dedupeKey } = __getSemrushDisconnectAlertKeysForTest();

    let notifyCalls = 0;
    let lastNotificationId: string | null = null;
    let lastDedupeKey: string | null = null;

    __setDispatcherForTest(
      async (id: string, _payload: unknown, opts: any) => {
        notifyCalls++;
        lastNotificationId = id;
        lastDedupeKey = opts?.dedupeKey ?? null;
        return { ok: true, deliveryId: null };
      },
      async () => {},
    );

    try {
      __resetSemrushDisconnectAlertStreakForTest();
      __resetSemrushAuthBreakerForTest();
      // Trip the breaker with lastTrippedAt well outside the grace window
      const oldTripMs = Date.now() - SEMRUSH_DISCONNECT_ALERT_GRACE_MS - 60_000;
      __setSemrushAuthStateForTest({
        lastTrippedAtMs: oldTripMs,
        breakerOpenUntilMs: Date.now() + 60_000,
        tripCount: 2,
      });

      await alertFn("tokens_absent");

      assert.equal(notifyCalls, 1, "alert must fire once after grace window");
      assert.equal(lastNotificationId, notificationId, "alert must use the registered notification ID");
      assert.equal(lastDedupeKey, dedupeKey, "alert must use dedupeKey='global'");
    } finally {
      __resetDispatcherForTest();
      __resetSemrushDisconnectAlertStreakForTest();
      __resetSemrushAuthBreakerForTest();
    }
  });

  await step("Group 9 — alert fires only once per streak; second call suppressed; re-arms after recovery", async () => {
    const {
      checkSemrushGlobalDisconnectAlert: alertFn,
      onSemrushAuthRestored,
      SEMRUSH_DISCONNECT_ALERT_GRACE_MS,
      __resetSemrushDisconnectAlertStreakForTest,
      __setDispatcherForTest,
      __resetDispatcherForTest,
    } = await import("../server/services/semrushDisconnectAlert");

    let notifyCalls = 0;

    __setDispatcherForTest(
      async (_id: string, _payload: unknown, _opts?: unknown) => {
        notifyCalls++;
        return { ok: true, deliveryId: null };
      },
      async () => {},
    );

    try {
      // Ensure clean streak state at start of this step
      __resetSemrushDisconnectAlertStreakForTest();
      __resetSemrushAuthBreakerForTest();

      // Trip the breaker well outside the grace window
      const oldTripMs = Date.now() - SEMRUSH_DISCONNECT_ALERT_GRACE_MS - 60_000;
      __setSemrushAuthStateForTest({
        lastTrippedAtMs: oldTripMs,
        breakerOpenUntilMs: Date.now() + 60_000,
        tripCount: 1,
      });

      // First call — must fire (streak not yet set)
      await alertFn("tokens_absent");
      assert.equal(notifyCalls, 1, "first alert call must deliver the notification");

      // Second call — same outage streak, streak flag is now set → must be suppressed
      await alertFn("tokens_absent");
      assert.equal(notifyCalls, 1, "second alert call within the same streak must NOT re-notify");

      // Third call — still same streak, still suppressed (different reason too)
      await alertFn("breaker_open");
      assert.equal(notifyCalls, 1, "third alert call (different reason) within the same streak must still be suppressed");

      // Recovery clears the streak flag (markRecovered is a no-op stub here)
      await onSemrushAuthRestored();

      // Next call after recovery must fire again (streak re-armed)
      await alertFn("tokens_absent");
      assert.equal(notifyCalls, 2, "alert must fire again after recovery re-arms the streak gate");
    } finally {
      __resetDispatcherForTest();
      __resetSemrushDisconnectAlertStreakForTest();
      __resetSemrushAuthBreakerForTest();
    }
  });

  await step("Group 9 — onSemrushAuthRestored calls markRecovered with correct keys", async () => {
    const {
      onSemrushAuthRestored,
      __getSemrushDisconnectAlertKeysForTest,
      __resetSemrushDisconnectAlertStreakForTest,
      __setDispatcherForTest,
      __resetDispatcherForTest,
    } = await import("../server/services/semrushDisconnectAlert");

    const { notificationId, dedupeKey } = __getSemrushDisconnectAlertKeysForTest();

    let recoverCalls = 0;
    let lastRecoverId: string | null = null;
    let lastRecoverKey: string | null = null;

    __setDispatcherForTest(
      async () => ({ ok: true, deliveryId: null }),
      async (id: string, key: string) => {
        recoverCalls++;
        lastRecoverId = id;
        lastRecoverKey = key;
      },
    );

    try {
      await onSemrushAuthRestored();

      assert.equal(recoverCalls, 1, "markRecovered must be called once on auth restore");
      assert.equal(lastRecoverId, notificationId, "markRecovered must use the registered notification ID");
      assert.equal(lastRecoverKey, dedupeKey, "markRecovered must use dedupeKey='global'");
    } finally {
      __resetDispatcherForTest();
      __resetSemrushDisconnectAlertStreakForTest();
    }
  });

  if (failures > 0) {
    throw new Error(`${failures} test(s) failed`);
  }
  console.log("\nAll SEMrush auth breaker regression tests passed");
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
    await restore(SETTINGS_KEY_ACCESS, priorAccess);
    await restore(SETTINGS_KEY_REFRESH, priorRefresh);
    await restore(SETTINGS_KEY_EXPIRES, priorExpires);
    process.exitCode = exitCode;
  });
