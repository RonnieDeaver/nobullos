/* test-registration
{
  "name": "Front probe badge durable (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #2500 — Front `probeConnection()` badge contract: reflect the DURABLE
 * auth state, not a single non-authoritative probe refresh that lost a
 * deploy-time rotation race.
 *
 * After a publish, autoscale briefly runs multiple instances and the
 * deploy-time burst of boot probes can make the cross-process refresh lease
 * time out and fall back to in-process-only, so a loser instance hits a real
 * rotation-race `invalid_grant`. The bounded re-read recheck (#2437) is
 * exhausted and — correctly — NOT committed as a durable disconnect (#2267);
 * `getValidFrontAccessToken({purpose:"front_probe"})` surfaces
 * `front_refresh_failed_permanent`. Before this task the probe mapped that to
 * `unauthorized`, flashing a false "Not Connected" for ~15s until the next
 * poll re-read the sibling-rotated healthy token.
 *
 * The fix: with the DURABLE auth-dead breaker still CLOSED, a probe terminal is
 * preserved (`probe_failed` / last-known-good). It surfaces `unauthorized` only
 * when the breaker is OPEN (an authoritative surface confirmed the death) or the
 * `/me` call returns 401 (a confirmed revocation on a still-cached token).
 *
 * Pure in-memory: `storage.getSystemSetting/setSystemSetting` are stubbed and
 * `fetch` is intercepted for the Front token + `/me` endpoints — no DB, no
 * network.
 */
import { strict as assert } from "node:assert";

process.env.FRONT_CLIENT_ID = process.env.FRONT_CLIENT_ID || "test_front_client_id";
process.env.FRONT_CLIENT_SECRET =
  process.env.FRONT_CLIENT_SECRET || "test_front_client_secret";

import { storage } from "../server/storage";
import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import { probeConnection } from "../server/services/frontIntegration";
import {
  frontAuthBreakerActive,
  tripFrontAuthBreaker,
  __resetFrontAuthBreakerForTest,
  __clearPersistedFrontAuthBreakerForTest,
} from "../server/services/frontAuthBreaker";

const FRONT_TOKEN_URL = "https://app.frontapp.com/oauth/token";
const FRONT_ME_URL = "https://api2.frontapp.com/me";

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
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.startsWith(FRONT_TOKEN_URL) || url.startsWith(FRONT_ME_URL)) {
      return responder(url, init);
    }
    return originalFetch(input, init);
  }) as any;
}

/** Terminal refresh failure — Front returns a 4xx OAuth error. */
function terminalResponse(): Response {
  return new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

/** Front expiry is stored in epoch SECONDS. */
function expiredTokenMap(): SettingMap {
  return new Map([
    [ACCESS, "at-expired"],
    [REFRESH, "rt-live"],
    [EXPIRES, String(Math.floor(Date.now() / 1000) - 100)],
  ]);
}

function freshTokenMap(): SettingMap {
  return new Map([
    [ACCESS, "at-fresh"],
    [REFRESH, "rt-live"],
    [EXPIRES, String(Math.floor(Date.now() / 1000) + 3600)],
  ]);
}

async function resetBreaker(): Promise<void> {
  __resetFrontAuthBreakerForTest();
  await __clearPersistedFrontAuthBreakerForTest();
}

// ---------------------------------------------------------------------------
// 1. probe terminal, breaker CLOSED → probe_failed (preserve last-known-good).
// ---------------------------------------------------------------------------
async function testProbeTerminalBreakerClosedPreserves(): Promise<void> {
  const map = expiredTokenMap();
  installStorageStub(map);
  installFetchStub(() => terminalResponse());
  try {
    __resetOAuthRefreshSingleFlightForTest();
    await resetBreaker();
    const result = await probeConnection();
    assert.equal(
      result.outcome,
      "probe_failed",
      "probe terminal with breaker closed must preserve (probe_failed), not flip the badge",
    );
    assert.equal(
      frontAuthBreakerActive(),
      false,
      "the probe must NOT trip the breaker (rotation-race safe)",
    );
    assert.equal(map.get(REFRESH), "rt-live", "probe must NOT wipe the refresh token");
  } finally {
    await resetBreaker();
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 2. probe terminal, breaker OPEN → unauthorized (durable disconnect flips it).
// ---------------------------------------------------------------------------
async function testProbeTerminalBreakerOpenSurfacesUnauthorized(): Promise<void> {
  const map = expiredTokenMap();
  installStorageStub(map);
  installFetchStub(() => terminalResponse());
  try {
    __resetOAuthRefreshSingleFlightForTest();
    await resetBreaker();
    tripFrontAuthBreaker("front_refresh_failed_permanent");
    const result = await probeConnection();
    assert.equal(
      result.outcome,
      "unauthorized",
      "probe terminal with the durable breaker OPEN must surface unauthorized (genuine disconnect)",
    );
  } finally {
    await resetBreaker();
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 3. confirmed /me 401 on a still-cached fresh token → unauthorized. A genuine
//    revocation is never masked by the preserve fix.
// ---------------------------------------------------------------------------
async function testMe401SurfacesUnauthorized(): Promise<void> {
  const map = freshTokenMap();
  installStorageStub(map);
  installFetchStub((url) => {
    if (url.startsWith(FRONT_ME_URL)) {
      return new Response("unauthorized", { status: 401 });
    }
    // A fresh access token must not trigger a refresh.
    return new Response("token endpoint must not be called", { status: 500 });
  });
  try {
    __resetOAuthRefreshSingleFlightForTest();
    await resetBreaker();
    const result = await probeConnection();
    assert.equal(
      result.outcome,
      "unauthorized",
      "a confirmed /me 401 must surface unauthorized (genuine disconnect)",
    );
    assert.equal(result.status, 401, "the /me 401 status must be surfaced");
  } finally {
    await resetBreaker();
    restoreAll();
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["probe terminal (breaker closed) → probe_failed/preserve (Task #2500)", testProbeTerminalBreakerClosedPreserves],
    ["probe terminal (breaker OPEN) → unauthorized (durable disconnect, Task #2500)", testProbeTerminalBreakerOpenSurfacesUnauthorized],
    ["confirmed /me 401 → unauthorized (genuine disconnect not masked)", testMe401SurfacesUnauthorized],
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
    throw new Error("front-probe-badge-durable test cases failed");
  }
  console.log("front-probe-badge-durable: OK");
}

// The shared test teardown in server/db.ts unref's idle pg sockets in test
// mode, so the loop drains and the child exits on its own once main() settles.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
