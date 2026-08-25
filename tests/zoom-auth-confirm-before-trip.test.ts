/* test-registration
{
  "name": "Zoom confirm-before-declaring-disconnected (Task #2416)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2416 regression coverage for the Zoom confirm-before-declaring-
 * disconnected guarantee on the hot-path token accessor
 * (`getAccessToken` in `server/services/zoomIntegration.ts`).
 *
 * Background: a falsy *cached* read of the stored Zoom access token on this
 * hot path is NOT proof the operator disconnected — it can be a stale
 * negative-cache sentinel or a transient empty read under DB / worker-pool
 * saturation. Before Task #2416, `getAccessToken()` threw "Zoom not
 * connected" on that single cached read, which surfaced the false
 * "Reconnect Required" badge. The fix re-reads BOTH tokens authoritatively
 * (cache-bypassing `getSystemSettingFresh`) and only declares the
 * disconnect on a CONFIRMED absence (no access AND no refresh). The four
 * states the accessor must distinguish (mirrors `semrush-auth-breaker`
 * Group 6 and Front Group 8):
 *
 *   1. Stale falsy cache but a valid token present in the DB → no throw,
 *      uses the fresh token, no refresh POST.
 *   2. Cached access absent + refresh present (authoritative) → routes to a
 *      refresh, never declares "not connected".
 *   3. The authoritative re-read itself THROWS → UNKNOWN, not absent →
 *      surface a transient "connection state unknown … will retry" error
 *      WITHOUT engaging the auth gate (no disconnect declared).
 *   4. Confirmed both-absent (cache-bypassing) → still throws "Zoom not
 *      connected" (the genuine disconnect).
 *
 * Zoom reuses the Task #1843 auth GATE (not a breaker module); the
 * "not connected" throw is independent of the gate (only a TERMINAL refresh
 * engages the gate), so each case asserts the gate stays clear unless the
 * refresh path engages it. `storage.getSystemSetting` /
 * `getSystemSettingFresh` are monkey-patched to drive cached-vs-fresh
 * divergence; `global.fetch` is monkey-patched so the suite never hits real
 * Zoom (and Upstash cache calls pass through).
 */
process.env.ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "test_client_id";
process.env.ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || "test_client_secret";
process.env.ZOOM_REDIRECT_URI =
  process.env.ZOOM_REDIRECT_URI || "https://test.example.com/api/zoom/callback";

import assert from "node:assert/strict";
import { storage } from "../server/storage";
const zoom = await import("../server/services/zoomIntegration");

const SETTINGS_KEY_ACCESS = "zoom_access_token";
const SETTINGS_KEY_REFRESH = "zoom_refresh_token";
const SETTINGS_KEY_EXPIRES = "zoom_token_expires_at";
const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";

const FUTURE = Math.floor(Date.now() / 1000) + 3600; // outside the 300s pre-expiry window
const PAST = Math.floor(Date.now() / 1000) - 3600;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

const originalFetch = globalThis.fetch;
let tokenEndpointCalls = 0;
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
let fetchHandler: FetchHandler | null = null;

globalThis.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url =
    typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.startsWith(ZOOM_TOKEN_URL)) {
    tokenEndpointCalls++;
    if (fetchHandler) return fetchHandler(url, init);
    return jsonResponse({ error: "invalid_grant" }, 400);
  }
  return originalFetch(input as any, init);
}) as any;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── cached / fresh setting stubs (mirrors SEMrush Group 6) ────────────
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

let passed = 0;
let failed = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  // Keep the gate clear + reset fetch state before each case.
  zoom.clearZoomPermanentFailure("test_reset");
  fetchHandler = null;
  tokenEndpointCalls = 0;
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err: any) {
    failed++;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    zoom.clearZoomPermanentFailure("test_reset");
    fetchHandler = null;
  }
}

async function expectThrows(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw, but it resolved");
}

// Stop the live self-heal timer from firing — we only exercise the
// synchronous accessor behavior in getAccessToken().
zoom.__disableZoomAuthSelfHealForTest(true);

try {
  console.log("Zoom confirm-before-trip regression (Task #2416)");

  await step("stale falsy cache but token present in DB → no disconnect, uses fresh token", async () => {
    // Cached read reports the access token absent; the authoritative re-read
    // shows a valid, unexpired access token. Must return it with no refresh
    // POST and no gate engagement.
    const restore = installSettingStubs({
      cached: { [SETTINGS_KEY_ACCESS]: undefined, [SETTINGS_KEY_EXPIRES]: undefined },
      fresh: {
        [SETTINGS_KEY_ACCESS]: "live-access",
        [SETTINGS_KEY_REFRESH]: "live-refresh",
        [SETTINGS_KEY_EXPIRES]: String(FUTURE),
      },
    });
    try {
      const token = await zoom.getAccessToken();
      assert.equal(token, "live-access", "returns the authoritative fresh access token");
      assert.equal(tokenEndpointCalls, 0, "valid fresh token → no refresh POST");
      assert.equal(zoom.getZoomAuthGate(), null, "must NOT engage the auth gate on a stale cache");
    } finally {
      restore();
    }
  });

  await step("cached access absent + refresh present → routes to refresh, no 'not connected'", async () => {
    // Cached access absent triggers the confirm re-read; fresh shows access
    // absent but a refresh token present → the accessor refreshes instead of
    // declaring the integration disconnected. `refreshAccessToken` reads the
    // refresh token via the (cached) getSystemSetting, so the stub keeps it
    // present there too.
    fetchHandler = async () =>
      jsonResponse(
        { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 },
        200,
      );
    const restore = installSettingStubs({
      cached: { [SETTINGS_KEY_ACCESS]: undefined, [SETTINGS_KEY_REFRESH]: "cached-refresh" },
      fresh: {
        [SETTINGS_KEY_ACCESS]: undefined,
        [SETTINGS_KEY_REFRESH]: "cached-refresh",
        [SETTINGS_KEY_EXPIRES]: String(PAST),
      },
    });
    try {
      const token = await zoom.getAccessToken();
      assert.equal(token, "fresh-access", "returns the refreshed access token");
      assert.ok(tokenEndpointCalls >= 1, "should have attempted a refresh");
      assert.equal(zoom.getZoomAuthGate(), null, "a successful refresh leaves the gate clear");
    } finally {
      restore();
    }
  });

  await step("authoritative re-read THROWS → UNKNOWN, transient, no gate engaged", async () => {
    // State 3: the cache-bypassing re-read itself fails. Absence is NOT
    // confirmed, so the accessor surfaces a transient "unknown … will retry"
    // error and must NOT engage the gate or declare "not connected".
    const restore = installSettingStubs({
      cached: { [SETTINGS_KEY_ACCESS]: undefined },
      fresh: "throw",
    });
    try {
      const err = await expectThrows(() => zoom.getAccessToken());
      assert.match(
        err.message,
        /unknown|read failed|will retry/i,
        "transient/unknown error surfaced",
      );
      assert.doesNotMatch(
        err.message,
        /not connected/i,
        "must NOT declare 'not connected' on an unknown read",
      );
      assert.equal(tokenEndpointCalls, 0, "no refresh attempted on an unknown read");
      assert.equal(zoom.getZoomAuthGate(), null, "a failed read must NOT engage the auth gate");
    } finally {
      restore();
    }
  });

  await step("confirmed both-absent (cache-bypassing) still throws 'Zoom not connected'", async () => {
    // The genuine disconnect: no access AND no refresh token, confirmed via
    // the authoritative re-read. Must still throw the not-connected error.
    const restore = installSettingStubs({
      cached: { [SETTINGS_KEY_ACCESS]: undefined, [SETTINGS_KEY_REFRESH]: undefined },
      fresh: {
        [SETTINGS_KEY_ACCESS]: undefined,
        [SETTINGS_KEY_REFRESH]: undefined,
        [SETTINGS_KEY_EXPIRES]: undefined,
      },
    });
    try {
      const err = await expectThrows(() => zoom.getAccessToken());
      assert.match(err.message, /not connected/i, "confirmed absence → 'Zoom not connected'");
      assert.equal(tokenEndpointCalls, 0, "no refresh attempted when no refresh token exists");
    } finally {
      restore();
    }
  });
} finally {
  globalThis.fetch = originalFetch;
  storage.getSystemSetting = origGetSystemSetting as any;
  storage.getSystemSettingFresh = origGetSystemSettingFresh as any;
  zoom.clearZoomPermanentFailure("test");
  zoom.__disableZoomAuthSelfHealForTest(false);
}

console.log(`\n${passed} passed, ${failed} failed`);
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
process.exitCode = failed > 0 ? 1 : 0;
