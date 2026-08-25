/* test-registration
{
  "name": "Google Calendar confirm-before-declaring-disconnected (Task #2428)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.4s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2428 — confirm-before-trip for the Google Calendar hot-path token
 * accessor (`getValidAccessToken`).
 *
 * Generalizes the SEMrush #2412 / Front-Zoom-Google-Ads #2416 guarantee to the
 * last rotating-refresh-token integration. The accessor reads the per-user
 * credential via `storage.getGoogleCalendarCredential` — an authoritative,
 * cache-bypassing read straight from the `google_calendar_credentials` row.
 * The confirm-before-trip rule for that read has three deterministic states:
 *
 *   1. confirmed ABSENT (read returns `undefined`) → throw the terminal
 *      "Google Calendar not connected for this user". A real missing row IS a
 *      genuine disconnect (no cache layer to go stale), so this MUST still
 *      throw — the try/catch must not swallow it.
 *   2. read THROWS (DB / pool saturation) → absence is NOT confirmed, so the
 *      accessor surfaces a transient `GoogleCalendarAuthUnknownError`, NOT the
 *      "not connected" Error. A failed read must never masquerade as a
 *      deterministic disconnect that surfaces a Reconnect prompt. No durable
 *      credential-status write, no token-refresh POST.
 *   3. present + still-valid access token → returns the stored access token
 *      (no refresh round-trip, no disconnect).
 *
 * Plus the falsy-access-but-refresh-present case: an expired access token with a
 * live refresh token must ROUTE TO REFRESH, never trip "not connected".
 *
 * Pure in-memory: the credential store methods on the `storage` singleton are
 * swapped for stubs and `fetch` is intercepted for the Google token endpoint.
 * No DB, no live worker race.
 */
import { strict as assert } from "node:assert";

process.env.GOOGLE_CALENDAR_CLIENT_ID =
  process.env.GOOGLE_CALENDAR_CLIENT_ID || "test_gcal_client_id";
process.env.GOOGLE_CALENDAR_CLIENT_SECRET =
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET || "test_gcal_client_secret";

import {
  getValidAccessToken,
  GoogleCalendarAuthUnknownError,
} from "../server/services/googleCalendarIntegration";
import { storage } from "../server/storage";
import { encryptToken } from "../server/utils/tokenCrypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const originalFetch = globalThis.fetch;
const originalGet = (storage as any).getGoogleCalendarCredential;
const originalUpdate = (storage as any).updateGoogleCalendarCredential;

/** Captured `updateGoogleCalendarCredential` patches for the test under run. */
let updates: Array<Record<string, any>> = [];
/** Count of token-endpoint POSTs the case attempted. */
let tokenEndpointCalls = 0;

/** Stub `getGoogleCalendarCredential` with a deterministic behavior. */
function stubCredential(impl: () => Promise<any>): void {
  updates = [];
  tokenEndpointCalls = 0;
  (storage as any).getGoogleCalendarCredential = impl;
  (storage as any).updateGoogleCalendarCredential = async (
    _userId: string,
    patch: Record<string, any>,
  ) => {
    updates.push(patch);
  };
}

/** A refresh-token POST that succeeds with a fresh access token. */
function installRefreshSuccessFetchStub(): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.startsWith(GOOGLE_TOKEN_URL)) {
      tokenEndpointCalls += 1;
      return new Response(
        JSON.stringify({ access_token: "at-fresh", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  }) as any;
}

/** A fetch stub that fails loudly if the token endpoint is ever hit. */
function installNoRefreshFetchStub(): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.startsWith(GOOGLE_TOKEN_URL)) {
      tokenEndpointCalls += 1;
      throw new Error(
        "token refresh endpoint must NOT be hit on this branch",
      );
    }
    return originalFetch(input, init);
  }) as any;
}

function restoreAll(): void {
  globalThis.fetch = originalFetch;
  (storage as any).getGoogleCalendarCredential = originalGet;
  (storage as any).updateGoogleCalendarCredential = originalUpdate;
}

function statusWrites(): Array<Record<string, any>> {
  return updates.filter((p) => "status" in p);
}

async function expectThrows(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw, but it resolved");
}

// ---------------------------------------------------------------------------
// State 1 — confirmed ABSENT (undefined) → terminal "not connected", no write.
// ---------------------------------------------------------------------------
async function testConfirmedAbsentTrips(): Promise<void> {
  installNoRefreshFetchStub();
  stubCredential(async () => undefined);
  try {
    const err = await expectThrows(() =>
      getValidAccessToken("user-absent"),
    );
    assert.ok(
      !(err instanceof GoogleCalendarAuthUnknownError),
      "a confirmed-absent read is a genuine disconnect, NOT an unknown error",
    );
    assert.match(
      err.message,
      /not connected/i,
      'confirmed absence must throw "not connected"',
    );
    assert.equal(
      statusWrites().length,
      0,
      "the accessor read path must not write a durable credential status",
    );
    assert.equal(tokenEndpointCalls, 0, "no refresh attempted on absence");
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// State 2 — read THROWS → UNKNOWN (transient), NOT "not connected", no write.
// ---------------------------------------------------------------------------
async function testThrowingReadIsUnknown(): Promise<void> {
  installNoRefreshFetchStub();
  stubCredential(async () => {
    throw new Error("simulated credential read failure (pool saturation)");
  });
  try {
    const err = await expectThrows(() =>
      getValidAccessToken("user-unknown"),
    );
    assert.ok(
      err instanceof GoogleCalendarAuthUnknownError,
      "a throwing read surfaces GoogleCalendarAuthUnknownError, not a not-connected Error",
    );
    assert.doesNotMatch(
      err.message,
      /not connected/i,
      "an unknown read must NOT masquerade as a deterministic disconnect",
    );
    assert.match(
      err.message,
      /unknown|read failed|will retry/i,
      "the message must read as transient/retryable",
    );
    assert.equal(
      statusWrites().length,
      0,
      "an unknown read must NOT write any durable credential status",
    );
    assert.equal(tokenEndpointCalls, 0, "no refresh attempted on an unknown read");
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// State 3 — present + valid access token → returns it, no refresh, no write.
// ---------------------------------------------------------------------------
async function testValidTokenReused(): Promise<void> {
  installNoRefreshFetchStub();
  stubCredential(async () => ({
    userId: "user-valid",
    status: "connected",
    accessTokenEncrypted: encryptToken("at-valid"),
    refreshTokenEncrypted: encryptToken("rt-live"),
    tokenExpiry: new Date(Date.now() + 60 * 60_000),
    calendarId: "primary",
    lastError: null,
  }));
  try {
    const token = await getValidAccessToken("user-valid");
    assert.equal(token, "at-valid", "a still-valid access token is reused as-is");
    assert.equal(tokenEndpointCalls, 0, "no refresh when the token is still valid");
    assert.equal(statusWrites().length, 0, "no status write on the happy path");
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// Falsy-access-but-refresh-present — expired access + live refresh → ROUTE TO
// REFRESH (never trip "not connected").
// ---------------------------------------------------------------------------
async function testExpiredAccessRoutesToRefresh(): Promise<void> {
  installRefreshSuccessFetchStub();
  stubCredential(async () => ({
    userId: "user-expired",
    status: "connected",
    accessTokenEncrypted: encryptToken("at-expired"),
    refreshTokenEncrypted: encryptToken("rt-live"),
    tokenExpiry: new Date(Date.now() - 60_000),
    calendarId: "primary",
    lastError: null,
  }));
  try {
    const token = await getValidAccessToken("user-expired");
    assert.equal(
      token,
      "at-fresh",
      "an expired access token with a live refresh token must refresh, not trip not-connected",
    );
    assert.ok(tokenEndpointCalls >= 1, "the refresh path POSTed to the token endpoint");
    const writes = statusWrites();
    assert.ok(
      writes.every((w) => w.status === "connected"),
      "a successful refresh only ever writes status:connected",
    );
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// Refresh-path re-read THROWS — credential present + expired access token, but
// the authoritative re-read inside the single-flight `readRefreshToken` throws
// (DB / pool blip in the window between the initial read and the refresh). It
// must NOT collapse to `null` (which the helper treats as a terminal "refresh
// token is missing — reconnect required" and commits a durable disconnect).
// Expect a transient GoogleCalendarAuthUnknownError, no status write, no POST.
// ---------------------------------------------------------------------------
async function testRefreshReadThrowsIsUnknown(): Promise<void> {
  installNoRefreshFetchStub();
  // First read (the initial authoritative read in getValidAccessToken) returns
  // a connected credential with an EXPIRED access token + a live refresh token,
  // routing into the refresh helper. Every subsequent read — the single-flight
  // `readRefreshToken` re-read (and the best-effort lease recheck, if any) —
  // THROWS, simulating a transient DB/pool failure mid-refresh.
  let reads = 0;
  stubCredential(async () => {
    reads += 1;
    if (reads === 1) {
      return {
        userId: "user-refresh-blip",
        status: "connected",
        accessTokenEncrypted: encryptToken("at-expired"),
        refreshTokenEncrypted: encryptToken("rt-live"),
        tokenExpiry: new Date(Date.now() - 60_000),
        calendarId: "primary",
        lastError: null,
      };
    }
    throw new Error("simulated refresh-path re-read failure (pool saturation)");
  });
  try {
    const err = await expectThrows(() =>
      getValidAccessToken("user-refresh-blip"),
    );
    assert.ok(
      err instanceof GoogleCalendarAuthUnknownError,
      "a throwing refresh-path re-read surfaces GoogleCalendarAuthUnknownError, not a terminal missing-token disconnect",
    );
    assert.doesNotMatch(
      err.message,
      /missing|not connected|reconnect required/i,
      "a transient re-read failure must NOT masquerade as a missing-token / reconnect-required disconnect",
    );
    assert.equal(
      statusWrites().length,
      0,
      "a transient refresh-path re-read failure must NOT write any durable credential status (no disconnect)",
    );
    assert.equal(
      tokenEndpointCalls,
      0,
      "the refresh POST must not fire when the refresh-token re-read failed",
    );
  } finally {
    restoreAll();
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ["confirmed absent (undefined) → throws not-connected, no status write", testConfirmedAbsentTrips],
    ["read throws → GoogleCalendarAuthUnknownError (transient), no status write, no refresh", testThrowingReadIsUnknown],
    ["present + valid access token → reused, no refresh, no write", testValidTokenReused],
    ["expired access + live refresh → routes to refresh, never trips not-connected", testExpiredAccessRoutesToRefresh],
    ["refresh-path re-read throws → GoogleCalendarAuthUnknownError, no disconnect, no POST", testRefreshReadThrowsIsUnknown],
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
    throw new Error("google-calendar-auth-confirm-before-trip test cases failed");
  }
  console.log("google-calendar-auth-confirm-before-trip: OK");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
