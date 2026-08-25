/* test-registration
{
  "name": "SEMrush health-check never disconnects a still-valid connection (Task #2266)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2266 — Verify health checks never disconnect a still-valid SEMrush
 * connection.
 *
 * Task #2265 changed `refreshAccessToken` so the credential wipe only runs
 * for an AUTHORITATIVE, on-demand refresh (the default purpose — a real API
 * call needs a token, or a 401 recovery). A NON-authoritative refresh
 * (`probe` / `proactive`) is observational: a terminal 4xx (e.g. a rotation
 * race where another process already consumed the captured refresh token)
 * must surface as `unauthorized` to its caller WITHOUT wiping a connection
 * that may still be valid. This is the core fix that stops false
 * "Disconnected" badges.
 *
 * The existing tests for this surface only cover the sync-state helpers and
 * the prod-action registration. This file directly exercises the token-wipe
 * gating in `semrushApi.ts` for both caller classes:
 *
 *   1. probe caller (real `probeConnection()`)  → terminal → `unauthorized`,
 *      tokens LEFT INTACT.
 *   2. proactive caller (`refreshAccessToken({ purpose: "proactive" })`)
 *      → terminal → throws, tokens LEFT INTACT.
 *   3. authoritative caller (default purpose)    → terminal → throws,
 *      tokens CLEARED.
 *   4. authoritative caller, cross-process rotation race → the re-read-and-
 *      retry path recovers with the freshly-rotated token, returns a token,
 *      and tokens are NOT cleared (a still-valid connection survives even on
 *      the authoritative path).
 *
 * Pure in-memory: `storage.getSystemSetting/setSystemSetting` are stubbed and
 * `fetch` is intercepted — no DB, no network.
 */
import { strict as assert } from "node:assert";
import { storage } from "../server/storage";
import {
  OAuthRefreshError,
  __resetOAuthRefreshSingleFlightForTest,
} from "../server/services/oauthRefresh";
import {
  probeConnection,
  __refreshAccessTokenForTest,
} from "../server/services/semrushApi";
import {
  __resetSemrushAuthBreakerForTest,
  __clearPersistedSemrushAuthBreakerForTest,
  tripSemrushAuthBreaker,
} from "../server/services/semrushAuthBreaker";

const ACCESS = "semrush_access_token";
const REFRESH = "semrush_refresh_token";
const EXPIRES = "semrush_token_expires_at";

type SettingMap = Map<string, string>;

const originalGet = storage.getSystemSetting.bind(storage);
// Task #3666 — wipe-confirmation re-read uses getSystemSettingFresh; stub it too.
const originalGetFresh = (storage as any).getSystemSettingFresh?.bind(storage);
const originalSet = storage.setSystemSetting.bind(storage);
const originalFetch = globalThis.fetch;

function installStorageStub(map: SettingMap): void {
  const readKey = async (key: string) => {
    const value = map.get(key);
    return value === undefined ? undefined : { key, value };
  };
  (storage as any).getSystemSetting = readKey;
  // Task #3666 — wipe-confirmation path uses getSystemSettingFresh; must see
  // the same in-memory map so the fingerprint comparison is correct.
  (storage as any).getSystemSettingFresh = readKey;
  (storage as any).setSystemSetting = async (key: string, value: string) => {
    map.set(key, value);
    return { key, value };
  };
}

function restoreAll(): void {
  (storage as any).getSystemSetting = originalGet;
  (storage as any).getSystemSettingFresh = originalGetFresh;
  (storage as any).setSystemSetting = originalSet;
  globalThis.fetch = originalFetch;
}

function installFetchStub(
  responder: (url: string, init?: any) => Response | Promise<Response>,
): void {
  globalThis.fetch = (async (input: any, init?: any) =>
    responder(typeof input === "string" ? input : String(input), init)) as any;
}

/** Terminal refresh failure — Semrush returns `invalid_request` (its quirk). */
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

function expiredTokenMap(): SettingMap {
  return new Map([
    [ACCESS, "at-expired"],
    [REFRESH, "rt-live"],
    [EXPIRES, String(Date.now() - 10_000)],
  ]);
}

// ---------------------------------------------------------------------------
// 1. probe caller, breaker CLOSED — a terminal refresh on the non-authoritative
//    probe purpose is a deploy-time rotation race. Task #2500: it must surface
//    `probe_failed` (preserve the last-known-good badge), NOT `unauthorized`,
//    so the Hub does not flash a false "Not Connected" after a publish on a
//    connection a sibling instance just rotated healthy. Tokens stay intact.
// ---------------------------------------------------------------------------
async function testProbeTerminalBreakerClosedPreserves(): Promise<void> {
  const map = expiredTokenMap();
  installStorageStub(map);
  installFetchStub(() => terminalResponse());
  try {
    const result = await withFresh(() => probeConnection());
    assert.equal(
      result.outcome,
      "probe_failed",
      "probe terminal with breaker closed must preserve (probe_failed), not flip the badge",
    );
    assert.equal(map.get(REFRESH), "rt-live", "probe must NOT wipe the refresh token");
    assert.equal(map.get(ACCESS), "at-expired", "probe must NOT wipe the access token");
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 1b. probe caller, breaker OPEN — the DURABLE auth-dead breaker is the
//     authoritative disconnect signal. Task #2500: with it already open (an
//     authoritative refresh confirmed the death), a probe terminal MUST surface
//     `unauthorized` so the badge reflects the genuine, durable disconnect.
// ---------------------------------------------------------------------------
async function testProbeTerminalBreakerOpenSurfacesUnauthorized(): Promise<void> {
  const map = expiredTokenMap();
  installStorageStub(map);
  installFetchStub(() => terminalResponse());
  try {
    const result = await withFresh(async () => {
      tripSemrushAuthBreaker("semrush_refresh_failed_permanent");
      return probeConnection();
    });
    assert.equal(
      result.outcome,
      "unauthorized",
      "probe terminal with the durable breaker OPEN must surface unauthorized (genuine disconnect)",
    );
  } finally {
    __resetSemrushAuthBreakerForTest();
    // Trip persists the breaker state; clear it too so a stale persisted row
    // can't hydrate into (and contaminate) a later test in the same process.
    await __clearPersistedSemrushAuthBreakerForTest();
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 2. proactive caller — terminal refresh must NOT wipe tokens, surfaces error.
// ---------------------------------------------------------------------------
async function testProactiveTerminalPreservesTokens(): Promise<void> {
  const map = expiredTokenMap();
  installStorageStub(map);
  installFetchStub(() => terminalResponse());
  try {
    let thrown: unknown;
    try {
      await withFresh(() => __refreshAccessTokenForTest({ purpose: "proactive" }));
      assert.fail("proactive terminal refresh must throw");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof OAuthRefreshError, "must surface an OAuthRefreshError");
    assert.equal((thrown as OAuthRefreshError).outcome, "terminal", "must be a terminal outcome");
    assert.equal(map.get(REFRESH), "rt-live", "proactive must NOT wipe the refresh token");
    assert.equal(map.get(ACCESS), "at-expired", "proactive must NOT wipe the access token");
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 3. authoritative caller — terminal refresh MUST clear credentials.
// ---------------------------------------------------------------------------
async function testAuthoritativeTerminalClearsTokens(): Promise<void> {
  const map = expiredTokenMap();
  installStorageStub(map);
  installFetchStub(() => terminalResponse());
  try {
    let thrown: unknown;
    try {
      // No purpose → authoritative (a real sync / on-demand API call).
      await withFresh(() => __refreshAccessTokenForTest());
      assert.fail("authoritative terminal refresh must throw");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof OAuthRefreshError, "must surface an OAuthRefreshError");
    assert.equal((thrown as OAuthRefreshError).outcome, "terminal", "must be a terminal outcome");
    assert.equal(map.get(REFRESH), "", "authoritative terminal refresh MUST clear the refresh token");
    assert.equal(map.get(ACCESS), "", "authoritative terminal refresh MUST clear the access token");
    assert.equal(map.get(EXPIRES), "", "authoritative terminal refresh MUST clear the expiry");
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 4. authoritative caller, cross-process rotation race — re-read-and-retry
//    recovers the freshly-rotated token; a still-valid connection survives.
// ---------------------------------------------------------------------------
async function testAuthoritativeRotationRaceRecovers(): Promise<void> {
  const map = expiredTokenMap();
  installStorageStub(map);
  // First POST uses the captured "rt-live" token and 4xx's terminally — but
  // as it fails, another process has already rotated the stored token to
  // "rt-rotated". The helper re-reads, sees the rotation, and retries; the
  // second POST (with "rt-rotated") succeeds.
  installFetchStub((_url, init) => {
    const body = String(init?.body ?? "");
    if (body.includes("rt-rotated")) {
      return new Response(
        JSON.stringify({ access_token: "at-new", refresh_token: "rt-rotated2", expires_in: 604800 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // The captured (consumed) token races: simulate the concurrent rotation
    // landing in storage, then fail this POST terminally.
    map.set(REFRESH, "rt-rotated");
    return terminalResponse();
  });
  try {
    const token = await withFresh(() => __refreshAccessTokenForTest());
    assert.equal(token, "at-new", "race recovery must return the freshly-minted access token");
    assert.equal(map.get(ACCESS), "at-new", "race recovery must persist the new access token");
    assert.equal(
      map.get(REFRESH),
      "rt-rotated2",
      "race recovery must persist the rotated refresh token — NOT wipe it",
    );
    assert.notEqual(map.get(REFRESH), "", "a still-valid connection must NOT be cleared on race recovery");
  } finally {
    restoreAll();
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["probe terminal (breaker closed) → probe_failed/preserve, tokens intact (Task #2500)", testProbeTerminalBreakerClosedPreserves],
    ["probe terminal (breaker OPEN) → unauthorized (durable disconnect, Task #2500)", testProbeTerminalBreakerOpenSurfacesUnauthorized],
    ["proactive terminal refresh → throws, tokens intact", testProactiveTerminalPreservesTokens],
    ["authoritative terminal refresh → throws, tokens cleared", testAuthoritativeTerminalClearsTokens],
    ["authoritative rotation race → recovers, tokens preserved", testAuthoritativeRotationRaceRecovers],
  ];
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err: any) {
      console.error(`  ✗ ${name}: ${err?.message ?? err}`);
      process.exitCode = 1;
    }
  }
  if (process.exitCode && process.exitCode !== 0) {
    throw new Error("semrush-health-check-no-disconnect test cases failed");
  }
  console.log("semrush-health-check-no-disconnect: OK");
}

// The shared test teardown in server/db.ts unref's idle pg sockets in test
// mode, so the loop drains and the child exits on its own once main() settles
// — no manual process.exit() needed (Task #2084).
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
