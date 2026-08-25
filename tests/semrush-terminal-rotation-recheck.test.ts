/* test-registration
{
  "name": "SEMrush terminal-rotation recheck self-heals refresh-token race (Task #2437)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.5s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2437 — Verify the bounded `terminalRotationRecheck` wired into
 * SEMrush's refresh path lets a refresh-token rotation race self-heal instead
 * of falsely wiping the stored credentials (which flips the Integrations Hub
 * badge to Disconnected and forces an operator reconnect).
 *
 * Generalizing the Task #2435 Front defense. SEMrush rotates the refresh token
 * on refresh: a loser instance can re-read the stored refresh token in the
 * instant BEFORE the winning sibling persists the rotated one, POST the
 * already-consumed token, get a definitive 4xx (`invalid_request`), and — for
 * an authoritative caller — WIPE the tokens via `onTerminalAfterRetry`.
 *
 * Mirrors `tests/oauth-refresh-terminal-rotation-recheck.test.ts` at the
 * integration level by driving the real refresh through the exported
 * `__refreshAccessTokenForTest` seam (default purpose = authoritative, the
 * caller class allowed to wipe):
 *
 *   1. rotation mid-poll → the stored refresh token flips to the rotated
 *      value a couple of re-reads in; the retry succeeds and the tokens are
 *      NOT wiped.
 *   2. true revocation → the token never rotates; the window exhausts and the
 *      authoritative wipe runs exactly once (a single token-endpoint POST).
 *
 * Pure in-memory: `storage.getSystemSetting` / `setSystemSetting` are swapped
 * for counter-driven stubs (deterministic — no setTimeout-based flip) and
 * `fetch` is intercepted for the SEMrush token endpoint. The cross-process
 * lease is OFF under NODE_ENV=test, so the recheck uses real (sub-second)
 * setTimeout delays.
 */
import { strict as assert } from "node:assert";

process.env.SEMRUSH_CLIENT_ID =
  process.env.SEMRUSH_CLIENT_ID || "test_semrush_client_id";
process.env.SEMRUSH_CLIENT_SECRET =
  process.env.SEMRUSH_CLIENT_SECRET || "test_semrush_client_secret";

import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import { __refreshAccessTokenForTest } from "../server/services/semrushApi";
import { storage } from "../server/storage";

// Task #3666 — endpoint changed from /dag/device/token (device-flow only) to
// /oauth2/access_token (the documented Semrush Auth refresh endpoint).
const OAUTH_TOKEN_URL = "https://oauth.semrush.com/oauth2/access_token";
const REFRESH_KEY = "semrush_refresh_token";
const CAPTURED = "rt-captured";
const ROTATED = "rt-rotated";

const originalFetch = globalThis.fetch;
const originalGetSetting = (storage as any).getSystemSetting;
// Task #3666 — wipe-confirmation re-read uses getSystemSettingFresh; stub it too.
const originalGetSettingFresh = (storage as any).getSystemSettingFresh;
const originalSetSetting = (storage as any).setSystemSetting;

/** Per-case count of POSTs to the SEMrush token endpoint. */
let tokenCalls = 0;
/** Per-case count of `getSystemSetting(refresh)` reads (capture + polls). */
let refreshReads = 0;
/** When > 0, the stored refresh token flips to ROTATED once reads exceed it. */
let rotateAfterReads = 0;
/** Captured `setSystemSetting` writes for the case under run. */
let writes: Array<{ key: string; value: string }> = [];

function refreshTokenFromBody(init: any): string | null {
  const body = typeof init?.body === "string" ? init.body : "";
  return new URLSearchParams(body).get("refresh_token");
}

function installFetchStub(): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.startsWith(OAUTH_TOKEN_URL)) return originalFetch(input, init);
    tokenCalls++;
    const rt = refreshTokenFromBody(init);
    if (rt === ROTATED) {
      return new Response(
        JSON.stringify({
          access_token: "semrush-access-new",
          refresh_token: "rt-next",
          expires_in: 604800,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Captured-but-already-consumed token → definitive (terminal) 4xx.
    return new Response(JSON.stringify({ error: "invalid_request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
}

function installStorageStub(): void {
  refreshReads = 0;
  writes = [];
  const readRefreshToken = (key: string) => {
    if (key === REFRESH_KEY) {
      refreshReads++;
      const rotated = rotateAfterReads > 0 && refreshReads > rotateAfterReads;
      return { value: rotated ? ROTATED : CAPTURED };
    }
    return undefined;
  };
  (storage as any).getSystemSetting = async (key: string) => readRefreshToken(key);
  // Task #3666 — wipe-confirmation uses getSystemSettingFresh; must see the same
  // in-memory state as getSystemSetting so the fingerprint comparison is correct.
  (storage as any).getSystemSettingFresh = async (key: string) => readRefreshToken(key);
  (storage as any).setSystemSetting = async (key: string, value: string) => {
    writes.push({ key, value });
  };
}

function restoreAll(): void {
  globalThis.fetch = originalFetch;
  (storage as any).getSystemSetting = originalGetSetting;
  (storage as any).getSystemSettingFresh = originalGetSettingFresh;
  (storage as any).setSystemSetting = originalSetSetting;
}

/** A token wipe sets the refresh key to the empty string (re-auth required). */
function refreshWipes(): number {
  return writes.filter((w) => w.key === REFRESH_KEY && w.value === "").length;
}

// ---------------------------------------------------------------------------
// 1. rotation mid-poll recovers — retry on the rotated token succeeds, no wipe.
// ---------------------------------------------------------------------------
async function testRotationMidPollRecovers(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  tokenCalls = 0;
  rotateAfterReads = 2; // capture + one same re-read, then the rotated value.
  installFetchStub();
  installStorageStub();
  try {
    const token = await __refreshAccessTokenForTest();
    assert.equal(
      token,
      "semrush-access-new",
      "refresh must recover on the rotated token and return the new access token",
    );
    assert.equal(
      tokenCalls,
      2,
      "exactly two token POSTs: the failed captured token + the recovered rotated token",
    );
    assert.equal(
      refreshWipes(),
      0,
      "a recovered rotation race must NOT wipe the stored credentials",
    );
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 2. true revocation stays terminal — authoritative wipe runs exactly once.
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
      await __refreshAccessTokenForTest();
      assert.fail("a truly revoked refresh token must surface a terminal error");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "terminal refresh must surface an error");
    assert.equal(
      tokenCalls,
      1,
      "terminal exactly once: the captured token POSTs once, the exhausted recheck adds no spurious retry POST",
    );
    assert.equal(
      refreshWipes(),
      1,
      "an authoritative terminal refresh must wipe the stored refresh token exactly once",
    );
  } finally {
    restoreAll();
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["rotation mid-poll → recovers on the rotated token (no wipe)", testRotationMidPollRecovers],
    ["true revocation → terminal, authoritative wipe runs exactly once", testTrueRevocationTerminalOnce],
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
    throw new Error("semrush-terminal-rotation-recheck test cases failed");
  }
  console.log("semrush-terminal-rotation-recheck: OK");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
