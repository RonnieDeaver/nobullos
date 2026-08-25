/* test-registration
{
  "name": "Zoom health-check never disconnects a still-valid connection (Task #2277)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2277 — Verify health checks never disconnect a still-valid Zoom
 * connection.
 *
 * Task #2267 (generalizing SEMrush Task #2265) made the terminal-auth
 * disconnect on Zoom gate on `isAuthoritativeRefreshPurpose`. A
 * NON-authoritative refresh (`zoom_probe` health check / any `proactive`
 * top-up) is observational: when it loses a refresh-token rotation race it
 * 4xx's `invalid_grant` on a captured-but-already-consumed token. That must
 * surface to the caller WITHOUT engaging the sticky global Zoom auth gate
 * (or the terminal self-heal latch) — both of which would back off every
 * healthy Zoom surface and force an operator reconnect. Only an
 * authoritative, on-demand refresh (a real Zoom operation, a 401 recovery)
 * may commit the disconnect.
 *
 * Zoom does NOT wipe stored tokens on a terminal refresh — its durable
 * "disconnect" signal is the global auth gate, so "tokens left intact" here
 * means BOTH the stored tokens survive AND the gate stays disengaged. This
 * file directly exercises the gating in `getAccessToken` for each caller
 * class:
 *
 *   1. probe caller (`zoom_probe`)        → throws, gate NOT engaged,
 *      tokens intact.
 *   2. proactive caller (`proactive`)     → throws, gate NOT engaged,
 *      tokens intact.
 *   3. authoritative caller (`expiry_or_401`) → throws, gate IS engaged.
 *
 * Pure in-memory: `storage.getSystemSetting/setSystemSetting` are stubbed
 * and `fetch` is intercepted — no DB, no network.
 */
import { strict as assert } from "node:assert";

process.env.ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "test_zoom_client_id";
process.env.ZOOM_CLIENT_SECRET =
  process.env.ZOOM_CLIENT_SECRET || "test_zoom_client_secret";

import { storage } from "../server/storage";
import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import {
  getAccessToken,
  getZoomAuthGate,
  clearZoomPermanentFailure,
  __disableZoomAuthSelfHealForTest,
  __clearPersistedZoomAuthGateForTest,
} from "../server/services/zoomIntegration";

const ACCESS = "zoom_access_token";
const REFRESH = "zoom_refresh_token";
const EXPIRES = "zoom_token_expires_at";

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

/** Terminal refresh failure — Zoom returns a recognized OAuth error. */
function terminalResponse(): Response {
  return new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

function expiredTokenMap(): SettingMap {
  // Zoom expiry is stored in epoch SECONDS; make the access token expired.
  return new Map([
    [ACCESS, "at-expired"],
    [REFRESH, "rt-live"],
    [EXPIRES, String(Math.floor(Date.now() / 1000) - 100)],
  ]);
}

async function withFreshGate(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  clearZoomPermanentFailure("test_reset");
  await __clearPersistedZoomAuthGateForTest();
}

// ---------------------------------------------------------------------------
// 1. probe caller — terminal refresh must NOT engage the gate or wipe tokens.
// ---------------------------------------------------------------------------
async function testProbeTerminalPreservesConnection(): Promise<void> {
  const map = expiredTokenMap();
  installStorageStub(map);
  installFetchStub(() => terminalResponse());
  try {
    await withFreshGate();
    let thrown: unknown;
    try {
      await getAccessToken({ purpose: "zoom_probe" });
      assert.fail("probe terminal refresh must throw");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "probe terminal refresh must surface an error");
    assert.equal(
      getZoomAuthGate(),
      null,
      "probe must NOT engage the Zoom auth gate (rotation-race safe)",
    );
    assert.equal(map.get(REFRESH), "rt-live", "probe must NOT wipe the refresh token");
    assert.equal(map.get(ACCESS), "at-expired", "probe must NOT wipe the access token");
  } finally {
    clearZoomPermanentFailure("test_reset");
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 2. proactive caller — terminal refresh must NOT engage the gate.
// ---------------------------------------------------------------------------
async function testProactiveTerminalPreservesConnection(): Promise<void> {
  const map = expiredTokenMap();
  installStorageStub(map);
  installFetchStub(() => terminalResponse());
  try {
    await withFreshGate();
    let thrown: unknown;
    try {
      await getAccessToken({ purpose: "proactive" });
      assert.fail("proactive terminal refresh must throw");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "proactive terminal refresh must surface an error");
    assert.equal(
      getZoomAuthGate(),
      null,
      "proactive must NOT engage the Zoom auth gate (rotation-race safe)",
    );
    assert.equal(map.get(REFRESH), "rt-live", "proactive must NOT wipe the refresh token");
  } finally {
    clearZoomPermanentFailure("test_reset");
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 3. authoritative caller — terminal refresh MUST engage the gate.
// ---------------------------------------------------------------------------
async function testAuthoritativeTerminalEngagesGate(): Promise<void> {
  const map = expiredTokenMap();
  installStorageStub(map);
  installFetchStub(() => terminalResponse());
  try {
    await withFreshGate();
    let thrown: unknown;
    try {
      // A real expiry / 401-recovery refresh — authoritative.
      await getAccessToken({ purpose: "expiry_or_401" });
      assert.fail("authoritative terminal refresh must throw");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "authoritative terminal refresh must surface an error");
    const gate = getZoomAuthGate();
    assert.notEqual(
      gate,
      null,
      "authoritative terminal refresh MUST engage the Zoom auth gate",
    );
    assert.ok(
      !!gate && /invalid_grant/i.test(gate.reason),
      `gate reason must mention the OAuth error; got: ${gate?.reason}`,
    );
  } finally {
    // Leave the gate disengaged for any other suite sharing the process.
    clearZoomPermanentFailure("test_reset");
    await __clearPersistedZoomAuthGateForTest();
    restoreAll();
  }
}

async function main(): Promise<void> {
  // Stop the self-heal timer from firing — we only exercise the synchronous
  // refresh + gate behavior.
  __disableZoomAuthSelfHealForTest(true);
  try {
    const cases: Array<[string, () => Promise<void>]> = [
      ["probe terminal refresh → throws, gate disengaged, tokens intact", testProbeTerminalPreservesConnection],
      ["proactive terminal refresh → throws, gate disengaged, tokens intact", testProactiveTerminalPreservesConnection],
      ["authoritative terminal refresh → throws, gate engaged", testAuthoritativeTerminalEngagesGate],
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
  } finally {
    __disableZoomAuthSelfHealForTest(false);
  }
  if (process.exitCode && process.exitCode !== 0) {
    throw new Error("zoom-health-check-no-disconnect test cases failed");
  }
  console.log("zoom-health-check-no-disconnect: OK");
}

// The shared test teardown in server/db.ts unref's idle pg sockets in test
// mode, so the loop drains and the child exits on its own once main() settles.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
