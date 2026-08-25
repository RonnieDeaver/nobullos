/* test-registration
{
  "name": "Front health-check never disconnects a still-valid connection (Task #2277)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2277 — Verify health checks never disconnect a still-valid Front
 * connection.
 *
 * Task #2267 (generalizing SEMrush Task #2265) made the terminal-auth
 * disconnect on Front gate on `isAuthoritativeRefreshPurpose`. A
 * NON-authoritative refresh (`front_probe` health check / any `proactive`
 * top-up) is observational: when it loses a refresh-token rotation race it
 * 4xx's `invalid_grant` on a captured-but-already-consumed token. That must
 * surface to the caller WITHOUT tripping the global Front auth-dead breaker
 * or recording an auth-death record — both of which would back off every
 * healthy Front surface and flip the Integrations Hub badge to a false
 * "Disconnected". Only an authoritative, on-demand refresh (a real Front
 * API call, a 401 recovery) may commit the disconnect.
 *
 * Front does NOT wipe stored tokens on a terminal refresh — its durable
 * "disconnect" signal is the global auth-dead breaker (+ death record), so
 * "tokens left intact" here means BOTH the stored tokens survive AND the
 * breaker stays closed. This file directly exercises the gating in
 * `getValidFrontAccessToken` for each caller class:
 *
 *   1. probe caller (`front_probe`)     → throws, breaker NOT tripped,
 *      tokens intact.
 *   2. proactive caller (`proactive`)   → throws, breaker NOT tripped,
 *      tokens intact.
 *   3. authoritative caller (`front_sync`) → throws, breaker IS tripped.
 *
 * Pure in-memory: `storage.getSystemSetting/setSystemSetting` are stubbed
 * and `fetch` is intercepted — no DB, no network.
 */
import { strict as assert } from "node:assert";

process.env.FRONT_CLIENT_ID = process.env.FRONT_CLIENT_ID || "test_front_client_id";
process.env.FRONT_CLIENT_SECRET =
  process.env.FRONT_CLIENT_SECRET || "test_front_client_secret";

import { storage } from "../server/storage";
import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import {
  FrontAuthError,
  getValidFrontAccessToken,
} from "../server/services/frontIntegration";
import {
  frontAuthBreakerActive,
  __resetFrontAuthBreakerForTest,
  __clearPersistedFrontAuthBreakerForTest,
} from "../server/services/frontAuthBreaker";

const ACCESS = "front_access_token";
const REFRESH = "front_refresh_token";
const EXPIRES = "front_token_expires_at";

type SettingMap = Map<string, string>;

const originalGet = storage.getSystemSetting.bind(storage);
const originalSet = storage.setSystemSetting.bind(storage);
const originalFetch = globalThis.fetch;

function installStorageStub(map: SettingMap): void {
  (storage as any).getSystemSetting = async (key: string) => {
    const value = map.get(key);
    return value === undefined ? undefined : { key, value };
  };
  (storage as any).setSystemSetting = async (key: string, value: string) => {
    map.set(key, value);
    return { key, value };
  };
}

function restoreAll(): void {
  (storage as any).getSystemSetting = originalGet;
  (storage as any).setSystemSetting = originalSet;
  globalThis.fetch = originalFetch;
}

function installFetchStub(
  responder: (url: string, init?: any) => Response | Promise<Response>,
): void {
  globalThis.fetch = (async (input: any, init?: any) =>
    responder(typeof input === "string" ? input : String(input), init)) as any;
}

/** Terminal refresh failure — Front returns a 4xx OAuth error. */
function terminalResponse(): Response {
  return new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

function expiredTokenMap(): SettingMap {
  // Front expiry is stored in epoch SECONDS; make the access token expired.
  return new Map([
    [ACCESS, "at-expired"],
    [REFRESH, "rt-live"],
    [EXPIRES, String(Math.floor(Date.now() / 1000) - 100)],
  ]);
}

async function withFresh<T>(fn: () => Promise<T>): Promise<T> {
  __resetOAuthRefreshSingleFlightForTest();
  __resetFrontAuthBreakerForTest();
  await __clearPersistedFrontAuthBreakerForTest();
  return fn();
}

// ---------------------------------------------------------------------------
// 1. probe caller — terminal refresh must NOT trip the breaker or wipe tokens.
// ---------------------------------------------------------------------------
async function testProbeTerminalPreservesConnection(): Promise<void> {
  const map = expiredTokenMap();
  installStorageStub(map);
  installFetchStub(() => terminalResponse());
  try {
    let thrown: unknown;
    try {
      await withFresh(() =>
        getValidFrontAccessToken({ purpose: "front_probe", bypassBreaker: true }),
      );
      assert.fail("probe terminal refresh must throw");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof FrontAuthError, "must surface a FrontAuthError");
    assert.equal(
      (thrown as FrontAuthError).code,
      "front_refresh_failed_permanent",
      "probe terminal must surface the permanent refresh code to its caller",
    );
    assert.equal(
      frontAuthBreakerActive(),
      false,
      "probe must NOT trip the Front auth-dead breaker (rotation-race safe)",
    );
    assert.equal(map.get(REFRESH), "rt-live", "probe must NOT wipe the refresh token");
    assert.equal(map.get(ACCESS), "at-expired", "probe must NOT wipe the access token");
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 2. proactive caller — terminal refresh must NOT trip the breaker.
// ---------------------------------------------------------------------------
async function testProactiveTerminalPreservesConnection(): Promise<void> {
  const map = expiredTokenMap();
  installStorageStub(map);
  installFetchStub(() => terminalResponse());
  try {
    let thrown: unknown;
    try {
      await withFresh(() => getValidFrontAccessToken({ purpose: "proactive" }));
      assert.fail("proactive terminal refresh must throw");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof FrontAuthError, "must surface a FrontAuthError");
    assert.equal(
      frontAuthBreakerActive(),
      false,
      "proactive must NOT trip the Front auth-dead breaker (rotation-race safe)",
    );
    assert.equal(map.get(REFRESH), "rt-live", "proactive must NOT wipe the refresh token");
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 3. authoritative caller — terminal refresh MUST trip the breaker.
// ---------------------------------------------------------------------------
async function testAuthoritativeTerminalTripsBreaker(): Promise<void> {
  const map = expiredTokenMap();
  installStorageStub(map);
  installFetchStub(() => terminalResponse());
  try {
    let thrown: unknown;
    try {
      // A real Front API sync — authoritative, allowed to commit the disconnect.
      await withFresh(() => getValidFrontAccessToken({ purpose: "front_sync" }));
      assert.fail("authoritative terminal refresh must throw");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof FrontAuthError, "must surface a FrontAuthError");
    assert.equal(
      (thrown as FrontAuthError).code,
      "front_refresh_failed_permanent",
      "authoritative terminal must surface the permanent refresh code",
    );
    assert.equal(
      frontAuthBreakerActive(),
      true,
      "authoritative terminal refresh MUST trip the Front auth-dead breaker",
    );
  } finally {
    // Leave the breaker closed for any other suite sharing the process.
    __resetFrontAuthBreakerForTest();
    await __clearPersistedFrontAuthBreakerForTest();
    restoreAll();
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["probe terminal refresh → throws, breaker closed, tokens intact", testProbeTerminalPreservesConnection],
    ["proactive terminal refresh → throws, breaker closed, tokens intact", testProactiveTerminalPreservesConnection],
    ["authoritative terminal refresh → throws, breaker tripped", testAuthoritativeTerminalTripsBreaker],
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
    throw new Error("front-health-check-no-disconnect test cases failed");
  }
  console.log("front-health-check-no-disconnect: OK");
}

// The shared test teardown in server/db.ts unref's idle pg sockets in test
// mode, so the loop drains and the child exits on its own once main() settles.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
