/* test-registration
{
  "name": "Zoom proactive token keep-alive (Task #2740)",
  "regression": true,
  "sweepOnlyReason": "Task #2740 — imports server/storage (warms DB pools), not a DB-free gate candidate; consistent with the other zoom OAuth tests above",
  "tier": "small"
}
test-registration */
/**
 * Task #2740 — proactive Zoom token keep-alive.
 *
 * The Zoom OAuth app is UNPUBLISHED (Draft), so per Zoom's OAuth docs the
 * refresh token is invalidated ~1h after issue and is ROTATED on every
 * refresh. A quiet period (no recordings, no operator action) can let the
 * ~1h elapse with nothing triggering a refresh, after which the next real
 * call hits `invalid_grant` and forces an operator reconnect.
 *
 * `runZoomTokenKeepAliveTick()` proactively rotates the token before that
 * cutoff, through the SAME single-flight + cross-process-lease path as every
 * other refresh — and is NON-authoritative: a terminal failure surfaces to
 * the scheduler WITHOUT engaging the sticky global auth gate (only the
 * authoritative on-demand path in getAccessToken may do that). These cases
 * exercise the tick directly:
 *
 *   1. kill switch off              → skipped (disabled), no token POST.
 *   2. no stored refresh token      → skipped (no_tokens), no token POST.
 *   3. token well clear of expiry   → skipped (fresh), no token POST.
 *   4. token inside the rotation window → refreshed (one token POST), rotated
 *      tokens persisted.
 *   5. terminal refresh failure     → terminal_error, the global auth gate
 *      stays DISENGAGED and the stored tokens survive (non-authoritative).
 *
 * Pure in-memory: `storage.getSystemSetting/setSystemSetting` are backed by a
 * Map and `fetch` is intercepted for the Zoom token endpoint. NODE_ENV=test
 * keeps the cross-process lease OFF so the tick's own freshness gate (not the
 * lease recheck) decides whether to rotate.
 */
import { strict as assert } from "node:assert";

process.env.NODE_ENV = "test";
process.env.ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "test_zoom_client_id";
process.env.ZOOM_CLIENT_SECRET =
  process.env.ZOOM_CLIENT_SECRET || "test_zoom_client_secret";

import { storage } from "../server/storage";
import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import {
  runZoomTokenKeepAliveTick,
  getZoomAuthGate,
  clearZoomPermanentFailure,
  __disableZoomAuthSelfHealForTest,
  __clearPersistedZoomAuthGateForTest,
  ZOOM_KEEPALIVE_ENABLED_SETTING,
  ZOOM_KEEPALIVE_REFRESH_BEFORE_EXPIRY_SECONDS,
} from "../server/services/zoomIntegration";

const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";
const ACCESS = "zoom_access_token";
const REFRESH = "zoom_refresh_token";
const EXPIRES = "zoom_token_expires_at";

const originalFetch = globalThis.fetch;
const originalGet = (storage as any).getSystemSetting;
const originalSet = (storage as any).setSystemSetting;
const originalRecord = (storage as any).recordAdminSettingChange;

let tokenCalls = 0;

type Mode = "ok" | "invalid_grant";

function installStubs(map: Map<string, string>, mode: Mode): void {
  tokenCalls = 0;
  (storage as any).getSystemSetting = async (key: string) => {
    const value = map.get(key);
    return value === undefined ? undefined : { key, value };
  };
  (storage as any).setSystemSetting = async (key: string, value: string) => {
    map.set(key, value);
    return { key, value };
  };
  (storage as any).recordAdminSettingChange = async () => undefined;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.startsWith(ZOOM_TOKEN_URL)) return originalFetch(input, init);
    tokenCalls++;
    if (mode === "invalid_grant") {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        access_token: "zoom-access-rotated",
        refresh_token: "zoom-refresh-rotated",
        expires_in: 3600,
        scope: "meeting:read",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as any;
}

function restoreAll(): void {
  globalThis.fetch = originalFetch;
  (storage as any).getSystemSetting = originalGet;
  (storage as any).setSystemSetting = originalSet;
  (storage as any).recordAdminSettingChange = originalRecord;
}

async function resetZoomState(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  __disableZoomAuthSelfHealForTest(true);
  await __clearPersistedZoomAuthGateForTest();
  clearZoomPermanentFailure();
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// 1. kill switch off → skipped, no POST.
async function testDisabledSkips(): Promise<void> {
  await resetZoomState();
  const map = new Map<string, string>([
    [ZOOM_KEEPALIVE_ENABLED_SETTING, "false"],
    [ACCESS, "zoom-access-old"],
    [REFRESH, "zoom-refresh-old"],
    [EXPIRES, String(nowSec() + 60)], // even near-expiry must not refresh
  ]);
  installStubs(map, "ok");
  try {
    const res = await runZoomTokenKeepAliveTick();
    assert.deepEqual(res, { action: "skipped", reason: "disabled" });
    assert.equal(tokenCalls, 0, "disabled keep-alive must not POST to the token endpoint");
  } finally {
    restoreAll();
  }
}

// 2. no stored refresh token → skipped, no POST.
async function testNoTokensSkips(): Promise<void> {
  await resetZoomState();
  const map = new Map<string, string>(); // nothing connected
  installStubs(map, "ok");
  try {
    const res = await runZoomTokenKeepAliveTick();
    assert.deepEqual(res, { action: "skipped", reason: "no_tokens" });
    assert.equal(tokenCalls, 0, "no refresh token → nothing to keep alive, no POST");
  } finally {
    restoreAll();
  }
}

// 3. token well clear of the rotation window → skipped (fresh), no POST.
async function testFreshSkips(): Promise<void> {
  await resetZoomState();
  const map = new Map<string, string>([
    [ACCESS, "zoom-access-fresh"],
    [REFRESH, "zoom-refresh-fresh"],
    // Comfortably more than the rotation window of life left.
    [EXPIRES, String(nowSec() + ZOOM_KEEPALIVE_REFRESH_BEFORE_EXPIRY_SECONDS + 600)],
  ]);
  installStubs(map, "ok");
  try {
    const res = await runZoomTokenKeepAliveTick();
    assert.deepEqual(res, { action: "skipped", reason: "fresh" });
    assert.equal(tokenCalls, 0, "a fresh token must not be rotated");
  } finally {
    restoreAll();
  }
}

// 4. token inside the rotation window → refreshed (rotated tokens persisted)
//    even though the access token itself still has minutes of life.
async function testNearExpiryRefreshes(): Promise<void> {
  await resetZoomState();
  const map = new Map<string, string>([
    [ACCESS, "zoom-access-old"],
    [REFRESH, "zoom-refresh-old"],
    // Inside the 20-min window but still ~5 min of access-token life — proves
    // the keep-alive rotates on the REFRESH-token cutoff, not access expiry.
    [EXPIRES, String(nowSec() + 300)],
  ]);
  installStubs(map, "ok");
  try {
    const res = await runZoomTokenKeepAliveTick();
    assert.deepEqual(res, { action: "refreshed" }, "near-expiry token must be proactively rotated");
    assert.equal(tokenCalls, 1, "exactly one token POST");
    assert.equal(map.get(ACCESS), "zoom-access-rotated", "rotated access token must be persisted");
    assert.equal(map.get(REFRESH), "zoom-refresh-rotated", "rotated refresh token must be persisted");
    assert.equal(getZoomAuthGate(), null, "a successful keep-alive must not engage the auth gate");
  } finally {
    restoreAll();
  }
}

// 5. terminal refresh failure → terminal_error, gate stays DISENGAGED and
//    stored tokens survive (the keep-alive is non-authoritative).
async function testTerminalFailureDoesNotEngageGate(): Promise<void> {
  await resetZoomState();
  const map = new Map<string, string>([
    [ACCESS, "zoom-access-old"],
    [REFRESH, "zoom-refresh-dead"],
    [EXPIRES, String(nowSec() + 60)], // inside the window → it will try
  ]);
  installStubs(map, "invalid_grant");
  try {
    const res = await runZoomTokenKeepAliveTick();
    assert.equal(res.action, "terminal_error", "a dead token must surface a terminal error");
    assert.equal(
      getZoomAuthGate(),
      null,
      "a non-authoritative keep-alive must NOT engage the global auth gate on a terminal failure",
    );
    assert.equal(
      map.get(REFRESH),
      "zoom-refresh-dead",
      "the keep-alive must NOT wipe the stored refresh token",
    );
  } finally {
    restoreAll();
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["kill switch off → skipped (disabled), no POST", testDisabledSkips],
    ["no stored refresh token → skipped (no_tokens), no POST", testNoTokensSkips],
    ["token clear of the window → skipped (fresh), no POST", testFreshSkips],
    ["token inside the window → refreshed + rotated tokens persisted", testNearExpiryRefreshes],
    ["terminal failure → terminal_error, gate disengaged, tokens intact", testTerminalFailureDoesNotEngageGate],
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
  __disableZoomAuthSelfHealForTest(false);
  if (process.exitCode && process.exitCode !== 0) {
    throw new Error("zoom-token-keepalive test cases failed");
  }
  console.log("zoom-token-keepalive: OK");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
