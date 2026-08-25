/* test-registration
{
  "name": "Google Calendar terminal-rotation recheck self-heals refresh-token race (Task #2437)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.4s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2437 — Verify the bounded `terminalRotationRecheck` wired into Google
 * Calendar's per-user refresh path lets a refresh-token rotation race self-heal
 * instead of falsely flipping THIS user's credential to `disconnected` (which
 * forces the AM to reconnect a perfectly healthy calendar).
 *
 * Generalizing the Task #2435 Front defense. Google rotates the refresh token
 * periodically (and silently): a loser instance can re-read the stored refresh
 * token in the instant BEFORE the winning sibling persists the rotated one,
 * POST the already-consumed token, get `invalid_grant` (HTTP 400), and — for an
 * authoritative caller — commit a durable `status:"disconnected"` write.
 *
 * Mirrors `tests/oauth-refresh-terminal-rotation-recheck.test.ts` at the
 * integration level by driving the real `getValidAccessToken(userId)` (default
 * purpose = authoritative, the caller class allowed to disconnect):
 *
 *   1. rotation mid-poll → the stored refresh token flips to the rotated value
 *      a couple of re-reads in; the retry succeeds and NO disconnect is written.
 *   2. true revocation → the token never rotates; the window exhausts and the
 *      authoritative disconnect is written exactly once (single token POST).
 *
 * Pure in-memory: the credential store methods on the `storage` singleton are
 * swapped for counter-driven stubs (deterministic — no setTimeout-based flip)
 * and `fetch` is intercepted for the Google token endpoint. The cross-process
 * lease is OFF under NODE_ENV=test, so the recheck uses real (sub-second)
 * setTimeout delays.
 */
import { strict as assert } from "node:assert";

process.env.GOOGLE_CALENDAR_CLIENT_ID =
  process.env.GOOGLE_CALENDAR_CLIENT_ID || "test_gcal_client_id";
process.env.GOOGLE_CALENDAR_CLIENT_SECRET =
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET || "test_gcal_client_secret";

import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import { getValidAccessToken } from "../server/services/googleCalendarIntegration";
import { storage } from "../server/storage";
import { encryptToken } from "../server/utils/tokenCrypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const USER_ID = "user-gcal-rotation-recheck";
const CAPTURED = "rt-captured";
const ROTATED = "rt-rotated";

const originalFetch = globalThis.fetch;
const originalGet = (storage as any).getGoogleCalendarCredential;
const originalUpdate = (storage as any).updateGoogleCalendarCredential;

/** Per-case count of POSTs to the Google token endpoint. */
let tokenCalls = 0;
/** Per-case count of credential reads (top read + capture + polls). */
let credReads = 0;
/** When > 0, the stored refresh token flips to ROTATED once reads exceed it. */
let rotateAfterReads = 0;
/** Captured `updateGoogleCalendarCredential` patches for the case under run. */
let updates: Array<Record<string, any>> = [];

function refreshTokenFromBody(init: any): string | null {
  const body = typeof init?.body === "string" ? init.body : "";
  return new URLSearchParams(body).get("refresh_token");
}

function installFetchStub(): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.startsWith(GOOGLE_TOKEN_URL)) return originalFetch(input, init);
    tokenCalls++;
    const rt = refreshTokenFromBody(init);
    if (rt === ROTATED) {
      return new Response(
        JSON.stringify({
          access_token: "gcal-access-new",
          refresh_token: "rt-next",
          expires_in: 3600,
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
  credReads = 0;
  updates = [];
  (storage as any).getGoogleCalendarCredential = async () => {
    credReads++;
    const rotated = rotateAfterReads > 0 && credReads > rotateAfterReads;
    return {
      userId: USER_ID,
      status: "connected",
      accessTokenEncrypted: encryptToken("at-expired"),
      refreshTokenEncrypted: encryptToken(rotated ? ROTATED : CAPTURED),
      tokenExpiry: new Date(Date.now() - 60_000),
      calendarId: "primary",
      lastError: null,
    };
  };
  (storage as any).updateGoogleCalendarCredential = async (
    _userId: string,
    patch: Record<string, any>,
  ) => {
    updates.push(patch);
  };
}

function restoreAll(): void {
  globalThis.fetch = originalFetch;
  (storage as any).getGoogleCalendarCredential = originalGet;
  (storage as any).updateGoogleCalendarCredential = originalUpdate;
}

function disconnectWrites(): Array<Record<string, any>> {
  return updates.filter((p) => p.status === "disconnected");
}

// ---------------------------------------------------------------------------
// 1. rotation mid-poll recovers — retry on the rotated token, no disconnect.
// ---------------------------------------------------------------------------
async function testRotationMidPollRecovers(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  tokenCalls = 0;
  // credReads: #1 = getValidAccessToken top read, #2 = helper capture,
  // then polls. Flip after 3 so the capture + first re-read see CAPTURED.
  rotateAfterReads = 3;
  installFetchStub();
  installStorageStub();
  try {
    const token = await getValidAccessToken(USER_ID);
    assert.equal(
      token,
      "gcal-access-new",
      "refresh must recover on the rotated token and return the new access token",
    );
    assert.equal(
      tokenCalls,
      2,
      "exactly two token POSTs: the failed captured token + the recovered rotated token",
    );
    assert.equal(
      disconnectWrites().length,
      0,
      "a recovered rotation race must NOT write a disconnect on the credential",
    );
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 2. true revocation stays terminal — disconnect written exactly once.
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
      await getValidAccessToken(USER_ID);
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
    const writes = disconnectWrites();
    assert.equal(
      writes.length,
      1,
      "an authoritative terminal refresh must write the disconnect exactly once",
    );
    assert.equal(
      writes[0].status,
      "disconnected",
      'authoritative invalid_grant MUST flip the credential to "disconnected"',
    );
  } finally {
    restoreAll();
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["rotation mid-poll → recovers on the rotated token (no disconnect)", testRotationMidPollRecovers],
    ["true revocation → terminal, disconnect written exactly once", testTrueRevocationTerminalOnce],
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
    throw new Error("google-calendar-terminal-rotation-recheck test cases failed");
  }
  console.log("google-calendar-terminal-rotation-recheck: OK");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
