/* test-registration
{
  "name": "SEMrush probe outcome classification (Task #1975)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1975 — SEMrush `probeConnection()` outcome classification.
 *
 * The Integrations Hub `/api/integrations/all-status` loader uses the
 * outcome-aware preserve pattern: only `unauthorized` commits a real
 * "Disconnected" badge; `probe_failed` keeps the previously-cached
 * value so a 5xx / network blip never flips the badge. This test pins
 * down the four shapes the probe must produce so future refactors of
 * the SEMrush refresh path can't silently regress the badge.
 *
 * We stub `storage.getSystemSetting` and intercept `fetch` so this is
 * a pure in-memory test — no DB, no network.
 */
import { strict as assert } from "node:assert";
import { storage } from "../server/storage";
import {
  __resetOAuthRefreshSingleFlightForTest,
} from "../server/services/oauthRefresh";
import { probeConnection } from "../server/services/semrushApi";

type SettingMap = Map<string, string>;

const originalGet = storage.getSystemSetting.bind(storage);
const originalSet = storage.setSystemSetting.bind(storage);
const originalFetch = globalThis.fetch;

function installStorageStub(map: SettingMap): void {
  (storage as any).getSystemSetting = async (key: string) => {
    const value = map.get(key);
    return value === undefined ? undefined : { key, value };
  };
  (storage as any).setSystemSetting = async (
    key: string,
    value: string,
  ) => {
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

async function withFreshSingleFlight<T>(fn: () => Promise<T>): Promise<T> {
  __resetOAuthRefreshSingleFlightForTest();
  return fn();
}

async function testUnauthorizedWhenNoTokens(): Promise<void> {
  const map: SettingMap = new Map();
  installStorageStub(map);
  installFetchStub(() => new Response("should not be called", { status: 500 }));
  try {
    const result = await withFreshSingleFlight(() => probeConnection());
    assert.equal(result.outcome, "unauthorized");
    assert.equal(result.reason, "no_tokens_stored");
  } finally {
    restoreAll();
  }
}

async function testConnectedWhenFreshAccessToken(): Promise<void> {
  const map: SettingMap = new Map([
    ["semrush_access_token", "at-fresh"],
    ["semrush_refresh_token", "rt-1"],
    ["semrush_token_expires_at", String(Date.now() + 30 * 60 * 1000)],
  ]);
  installStorageStub(map);
  let fetchCalled = false;
  installFetchStub(() => {
    fetchCalled = true;
    return new Response("should not refresh when fresh", { status: 500 });
  });
  try {
    const result = await withFreshSingleFlight(() => probeConnection());
    assert.equal(result.outcome, "connected");
    assert.equal(fetchCalled, false, "fresh access token must not trigger a refresh");
  } finally {
    restoreAll();
  }
}

async function testProbeFailedOn5xxPreservesTokens(): Promise<void> {
  // Expired access token → probe refreshes → vendor 5xx → MUST classify
  // as `probe_failed` (not unauthorized) AND MUST NOT wipe tokens. This
  // is the SEMrush-flap regression the helper exists to prevent.
  const map: SettingMap = new Map([
    ["semrush_access_token", "at-expired"],
    ["semrush_refresh_token", "rt-1"],
    ["semrush_token_expires_at", String(Date.now() - 10_000)],
  ]);
  installStorageStub(map);
  installFetchStub(
    () => new Response("upstream maintenance", { status: 503 }),
  );
  try {
    const result = await withFreshSingleFlight(() => probeConnection());
    assert.equal(result.outcome, "probe_failed");
    assert.equal(
      map.get("semrush_refresh_token"),
      "rt-1",
      "transient probe failure must NOT wipe the refresh token",
    );
  } finally {
    restoreAll();
  }
}

async function testProbeFailedOnInvalidGrantPreservesTokens(): Promise<void> {
  // Task #2265 / #2267 / #2500 — the status/health probe refreshes with the
  // non-authoritative `purpose: "probe"`. A terminal `invalid_grant` here is
  // the deploy-time rotation-race case (a background health-check lost a
  // refresh-token rotation and 4xx'd on a captured-but-already-consumed
  // token). With the durable auth-dead breaker still CLOSED, Task #2500
  // surfaces `probe_failed` (preserve the last-known-good badge) — NOT
  // `unauthorized` — so the Hub doesn't flash a false "Not Connected" on a
  // connection a sibling instance just rotated healthy. It also MUST NOT wipe
  // the stored tokens. Only an authoritative, on-demand refresh (default
  // purpose) clears credentials; only the durable breaker / confirmed-empty
  // tokens flips the badge.
  const map: SettingMap = new Map([
    ["semrush_access_token", "at-expired"],
    ["semrush_refresh_token", "rt-dead"],
    ["semrush_token_expires_at", String(Date.now() - 10_000)],
  ]);
  installStorageStub(map);
  installFetchStub(
    () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
  );
  try {
    const result = await withFreshSingleFlight(() => probeConnection());
    assert.equal(
      result.outcome,
      "probe_failed",
      "probe terminal with breaker closed must preserve (probe_failed), not flip the badge",
    );
    // Non-authoritative terminal MUST NOT wipe — tokens are preserved so a
    // healthy connection rotated by another instance isn't poisoned.
    assert.equal(
      map.get("semrush_refresh_token"),
      "rt-dead",
      "probe (non-authoritative) terminal must NOT wipe the refresh token",
    );
    assert.equal(
      map.get("semrush_access_token"),
      "at-expired",
      "probe (non-authoritative) terminal must NOT wipe the access token",
    );
  } finally {
    restoreAll();
  }
}

async function testUnauthorizedWhenAccessExpiredAndNoRefresh(): Promise<void> {
  const map: SettingMap = new Map([
    ["semrush_access_token", "at-expired"],
    ["semrush_token_expires_at", String(Date.now() - 10_000)],
  ]);
  installStorageStub(map);
  installFetchStub(() => new Response("should not be called", { status: 500 }));
  try {
    const result = await withFreshSingleFlight(() => probeConnection());
    assert.equal(result.outcome, "unauthorized");
    assert.equal(result.reason, "no_refresh_token");
  } finally {
    restoreAll();
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["unauthorized when no tokens stored", testUnauthorizedWhenNoTokens],
    ["connected when access token is fresh", testConnectedWhenFreshAccessToken],
    ["probe_failed on 5xx preserves tokens (SEMrush-flap regression)", testProbeFailedOn5xxPreservesTokens],
    ["probe_failed on invalid_grant preserves tokens (probe non-authoritative, breaker closed, Task #2500)", testProbeFailedOnInvalidGrantPreservesTokens],
    ["unauthorized when access expired and no refresh token", testUnauthorizedWhenAccessExpiredAndNoRefresh],
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
    throw new Error("semrush-probe-classification test cases failed");
  }
  console.log("semrush-probe-classification: OK");
}

// The shared test teardown in server/db.ts unref's idle pg sockets in test
// mode, so the loop drains and the child exits on its own once main() settles
// — no manual process.exit() needed (Task #2084).
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
