/* test-registration
{
  "name": "Zoom terminal-rotation recheck self-heals refresh-token race (Task #2437)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2437 — Verify the bounded `terminalRotationRecheck` wired into Zoom's
 * refresh path lets a refresh-token rotation race self-heal instead of
 * surfacing a false terminal "auth dead".
 *
 * Generalizing the Task #2435 Front defense to the other rotating-token
 * integrations. Zoom rotates the refresh token on EVERY refresh, so the race
 * window is every cycle: a loser instance can re-read the stored refresh token
 * in the instant BEFORE the winning sibling persists the freshly-rotated one,
 * POST the already-consumed token, and get `invalid_grant` (HTTP 400). Without
 * the recheck that surfaces a terminal `ZoomRefreshError` (which the auth-gate
 * engager turns into an operator-reconnect prompt) on a connection a sibling
 * just rotated healthy.
 *
 * This mirrors `tests/oauth-refresh-terminal-rotation-recheck.test.ts` at the
 * integration level by driving the real `refreshAccessToken()`:
 *
 *   1. rotation mid-poll → the stored refresh token flips from the captured
 *      (now-consumed) value to the rotated one a couple of re-reads in; the
 *      retry POSTs the rotated token and succeeds (no terminal surfaced).
 *   2. true revocation → the stored refresh token never rotates; the window
 *      exhausts and a terminal `ZoomRefreshError` is surfaced exactly once
 *      (a single token-endpoint POST, no spurious retry).
 *
 * Pure in-memory: `storage.getSystemSetting` is swapped for a counter-driven
 * stub (deterministic — no setTimeout-based flip) and `fetch` is intercepted
 * for the Zoom token endpoint. The cross-process lease is OFF under
 * NODE_ENV=test, so `onLeaseAcquiredRecheck` does not run; the recheck uses
 * real (sub-second) setTimeout delays.
 */
import { strict as assert } from "node:assert";

process.env.ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "test_zoom_client_id";
process.env.ZOOM_CLIENT_SECRET =
  process.env.ZOOM_CLIENT_SECRET || "test_zoom_client_secret";

import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import { refreshAccessToken } from "../server/services/zoomIntegration";
import { storage } from "../server/storage";

const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";
const REFRESH_KEY = "zoom_refresh_token";
const CAPTURED = "rt-captured";
const ROTATED = "rt-rotated";

const originalFetch = globalThis.fetch;
const originalGetSetting = (storage as any).getSystemSetting;
const originalSetSetting = (storage as any).setSystemSetting;
const originalRecordChange = (storage as any).recordAdminSettingChange;

/** Per-case count of POSTs to the Zoom token endpoint. */
let tokenCalls = 0;
/** Per-case count of `getSystemSetting(refresh)` reads (capture + polls). */
let refreshReads = 0;
/** When > 0, the stored refresh token flips to ROTATED once reads exceed it. */
let rotateAfterReads = 0;

function refreshTokenFromBody(init: any): string | null {
  const body = typeof init?.body === "string" ? init.body : "";
  return new URLSearchParams(body).get("refresh_token");
}

function installFetchStub(): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.startsWith(ZOOM_TOKEN_URL)) return originalFetch(input, init);
    tokenCalls++;
    const rt = refreshTokenFromBody(init);
    if (rt === ROTATED) {
      return new Response(
        JSON.stringify({
          access_token: "zoom-access-new",
          refresh_token: "rt-next",
          expires_in: 3600,
          scope: "meeting:read",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Captured-but-already-consumed token → terminal invalid_grant.
    return new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
}

function installStorageStub(): void {
  refreshReads = 0;
  (storage as any).getSystemSetting = async (key: string) => {
    if (key === REFRESH_KEY) {
      refreshReads++;
      const rotated = rotateAfterReads > 0 && refreshReads > rotateAfterReads;
      return { value: rotated ? ROTATED : CAPTURED };
    }
    // Access/expires are only read by onLeaseAcquiredRecheck, which the
    // test-mode lease disables; return absent so nothing else short-circuits.
    return undefined;
  };
  // storeTokens writes the rotated tokens back — keep it in-memory.
  (storage as any).setSystemSetting = async () => undefined;
  (storage as any).recordAdminSettingChange = async () => undefined;
}

function restoreAll(): void {
  globalThis.fetch = originalFetch;
  (storage as any).getSystemSetting = originalGetSetting;
  (storage as any).setSystemSetting = originalSetSetting;
  (storage as any).recordAdminSettingChange = originalRecordChange;
}

// ---------------------------------------------------------------------------
// 1. rotation mid-poll recovers — retry on the rotated token succeeds.
// ---------------------------------------------------------------------------
async function testRotationMidPollRecovers(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  tokenCalls = 0;
  rotateAfterReads = 2; // capture + one same re-read, then the rotated value.
  installFetchStub();
  installStorageStub();
  try {
    const token = await refreshAccessToken();
    assert.equal(
      token,
      "zoom-access-new",
      "refresh must recover on the rotated token and return the new access token",
    );
    assert.equal(
      tokenCalls,
      2,
      "exactly two token POSTs: the failed captured token + the recovered rotated token",
    );
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 2. true revocation stays terminal — surfaced exactly once.
// ---------------------------------------------------------------------------
async function testTrueRevocationTerminalOnce(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  tokenCalls = 0;
  rotateAfterReads = 0; // never rotates — a genuinely dead refresh token.
  installFetchStub();
  installStorageStub();
  try {
    let thrown: any;
    try {
      await refreshAccessToken();
      assert.fail("a truly revoked refresh token must surface a terminal error");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "terminal refresh must surface an error");
    assert.equal(
      thrown.terminal,
      true,
      "the surfaced ZoomRefreshError must carry the terminal verdict",
    );
    assert.equal(
      tokenCalls,
      1,
      "terminal exactly once: the captured token POSTs once, the exhausted recheck adds no spurious retry POST",
    );
  } finally {
    restoreAll();
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["rotation mid-poll → recovers on the rotated token (no terminal)", testRotationMidPollRecovers],
    ["true revocation → terminal ZoomRefreshError surfaced exactly once", testTrueRevocationTerminalOnce],
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
    throw new Error("zoom-terminal-rotation-recheck test cases failed");
  }
  console.log("zoom-terminal-rotation-recheck: OK");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
