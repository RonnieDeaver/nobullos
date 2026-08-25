/* test-registration
{
  "name": "Google Calendar health-check never disconnects a still-valid credential (Task #2286)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.4s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2286 — Verify health checks / non-authoritative reads never
 * disconnect a still-valid per-user Google Calendar credential.
 *
 * Generalizing the Task #2267 protection (SEMrush #2265 → Front/Zoom/Google
 * Ads #2277) to the last remaining rotating-refresh-token OAuth integration:
 * Google Calendar. Its terminal credential-status flips live in two places —
 * `getValidAccessToken` (refresh 4xx) and `calendarRequest` (live 401/403) —
 * and both are reachable from NON-authoritative callers (public/AM/settings
 * availability previews via `getFreeBusy`, and the timezone backfill seeder).
 *
 * A non-authoritative refresh that loses a refresh-token rotation race 4xx's
 * `invalid_grant` on a captured-but-already-consumed token. That must surface
 * to the caller (fail-closed) WITHOUT writing `status:"disconnected"` on the
 * credential row — otherwise a single preview view would force the AM to
 * reconnect a perfectly healthy calendar. Only an authoritative, on-demand
 * caller (a real booking saga re-check / event write — the default purpose)
 * may commit the disconnect.
 *
 * This file exercises the gating for each caller class against BOTH
 * terminal-disconnect branches:
 *
 * A. the refresh path (`getValidAccessToken`, refresh 4xx):
 *
 *   1. probe caller (purpose `probe`) → throws, NO credential-status write.
 *   2. proactive caller (purpose `proactive`) → throws, NO status write.
 *   3. authoritative caller (default / undefined purpose) → throws AND
 *      writes `status:"disconnected"`.
 *
 * B. the LIVE API path (`calendarRequest` 401/403 block, reached via
 *    `getFreeBusy` — the exact path a public/AM availability preview
 *    triggers), with a still-valid access token so the refresh path is
 *    skipped and only the live 401/403 handler runs (Task #2360):
 *
 *   4. probe caller (purpose `probe`) → throws CalendarReauthRequiredError,
 *      NO credential-status write (fail-closed but rotation-race safe).
 *   5. authoritative caller (default / undefined purpose) → throws AND
 *      writes `status:"disconnected"`.
 *
 * Pure in-memory: the credential store methods on the `storage` singleton
 * are swapped for stubs and `fetch` is intercepted for the Google token
 * endpoint (path A) and the Calendar API endpoint (path B). No DB, no
 * live worker race.
 */
import { strict as assert } from "node:assert";

process.env.GOOGLE_CALENDAR_CLIENT_ID =
  process.env.GOOGLE_CALENDAR_CLIENT_ID || "test_gcal_client_id";
process.env.GOOGLE_CALENDAR_CLIENT_SECRET =
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET || "test_gcal_client_secret";

import {
  getValidAccessToken,
  getFreeBusy,
  CalendarReauthRequiredError,
} from "../server/services/googleCalendarIntegration";
import { storage } from "../server/storage";
import { encryptToken } from "../server/utils/tokenCrypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_FREEBUSY_URL =
  "https://www.googleapis.com/calendar/v3/freeBusy";

const USER_ID = "user-gcal-health-check";

const originalFetch = globalThis.fetch;
const originalGet = (storage as any).getGoogleCalendarCredential;
const originalUpdate = (storage as any).updateGoogleCalendarCredential;

/** Captured `updateGoogleCalendarCredential` patches for the test under run. */
let updates: Array<Record<string, any>> = [];

function installFetchStub(): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.startsWith(GOOGLE_TOKEN_URL)) {
      // Terminal refresh failure — Google returns a recognized OAuth error.
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as any;
}

/** Seed a connected credential whose access token is already expired. */
function installStorageStub(): void {
  updates = [];
  (storage as any).getGoogleCalendarCredential = async () => ({
    userId: USER_ID,
    status: "connected",
    accessTokenEncrypted: encryptToken("at-expired"),
    refreshTokenEncrypted: encryptToken("rt-live"),
    tokenExpiry: new Date(Date.now() - 60_000),
    calendarId: "primary",
    lastError: null,
  });
  (storage as any).updateGoogleCalendarCredential = async (
    _userId: string,
    patch: Record<string, any>,
  ) => {
    updates.push(patch);
  };
}

/**
 * Live-API blip stubs (path B). The credential carries a still-valid
 * access token (expiry in the future) so `getValidAccessToken` reuses it
 * WITHOUT a refresh round-trip — the only failure that runs is the live
 * 401/403 handler inside `calendarRequest`. The Calendar freeBusy
 * endpoint returns `httpStatus` with an `invalid_grant`-style body so the
 * credential-status mapping resolves to "disconnected".
 */
function installLiveBlipFetchStub(httpStatus: number): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.startsWith(GOOGLE_FREEBUSY_URL)) {
      return new Response(
        JSON.stringify({ error: { errors: [{ reason: "invalid_grant" }] } }),
        {
          status: httpStatus,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (url.startsWith(GOOGLE_TOKEN_URL)) {
      // The refresh path must NOT run on this branch — fail loudly if it
      // somehow does so the test catches a regression that re-enables it.
      throw new Error(
        "token refresh endpoint must not be hit on the live-blip path (valid access token expected)",
      );
    }
    return originalFetch(input, init);
  }) as any;
}

/** Seed a connected credential whose access token is still valid. */
function installLiveBlipStorageStub(): void {
  updates = [];
  (storage as any).getGoogleCalendarCredential = async () => ({
    userId: USER_ID,
    status: "connected",
    accessTokenEncrypted: encryptToken("at-live-valid"),
    refreshTokenEncrypted: encryptToken("rt-live"),
    tokenExpiry: new Date(Date.now() + 60 * 60_000),
    calendarId: "primary",
    lastError: null,
  });
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

function statusWrites(): Array<Record<string, any>> {
  return updates.filter((p) => "status" in p);
}

// ---------------------------------------------------------------------------
// 1. probe caller — terminal refresh must NOT write a credential status.
// ---------------------------------------------------------------------------
async function testProbeTerminalPreservesConnection(): Promise<void> {
  installFetchStub();
  installStorageStub();
  try {
    let thrown: unknown;
    try {
      await getValidAccessToken(USER_ID, { purpose: "probe" });
      assert.fail("probe terminal refresh must throw (fail-closed)");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "probe terminal refresh must surface an error");
    assert.equal(
      statusWrites().length,
      0,
      "probe must NOT write any credential status (rotation-race safe)",
    );
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 2. proactive caller — terminal refresh must NOT write a credential status.
// ---------------------------------------------------------------------------
async function testProactiveTerminalPreservesConnection(): Promise<void> {
  installFetchStub();
  installStorageStub();
  try {
    let thrown: unknown;
    try {
      await getValidAccessToken(USER_ID, { purpose: "proactive" });
      assert.fail("proactive terminal refresh must throw (fail-closed)");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "proactive terminal refresh must surface an error");
    assert.equal(
      statusWrites().length,
      0,
      "proactive must NOT write any credential status (rotation-race safe)",
    );
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 3. authoritative caller — terminal refresh MUST flip status:"disconnected".
// ---------------------------------------------------------------------------
async function testAuthoritativeTerminalDisconnects(): Promise<void> {
  installFetchStub();
  installStorageStub();
  try {
    let thrown: unknown;
    try {
      // No purpose → default authoritative (real booking/event call).
      await getValidAccessToken(USER_ID);
      assert.fail("authoritative terminal refresh must throw");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "authoritative terminal refresh must surface an error");
    const writes = statusWrites();
    assert.equal(
      writes.length,
      1,
      "authoritative terminal refresh MUST write exactly one credential status",
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

// ---------------------------------------------------------------------------
// 4. LIVE blip (calendarRequest 401/403) via getFreeBusy — probe caller must
//    fail-closed (throw CalendarReauthRequiredError) but NOT write status.
// ---------------------------------------------------------------------------
async function testProbeLiveBlipPreservesConnection(): Promise<void> {
  // 403 goes straight to the 401/403 block (no retry-on-401 recursion),
  // isolating exactly the live auth-blip handler a slots preview hits.
  installLiveBlipFetchStub(403);
  installLiveBlipStorageStub();
  try {
    const from = new Date();
    const to = new Date(Date.now() + 60 * 60_000);
    let thrown: unknown;
    try {
      await getFreeBusy(USER_ID, from, to, ["primary"], { purpose: "probe" });
      assert.fail("probe live 403 must throw (fail-closed)");
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      thrown instanceof CalendarReauthRequiredError,
      "probe live 403 must throw CalendarReauthRequiredError (fail-closed)",
    );
    assert.equal(
      statusWrites().length,
      0,
      "probe live blip must NOT write any credential status (rotation-race safe)",
    );
  } finally {
    restoreAll();
  }
}

// ---------------------------------------------------------------------------
// 5. LIVE blip (calendarRequest 401/403) via getFreeBusy — authoritative
//    caller MUST flip status:"disconnected".
// ---------------------------------------------------------------------------
async function testAuthoritativeLiveBlipDisconnects(): Promise<void> {
  installLiveBlipFetchStub(403);
  installLiveBlipStorageStub();
  try {
    const from = new Date();
    const to = new Date(Date.now() + 60 * 60_000);
    let thrown: unknown;
    try {
      // No purpose → default authoritative (real booking free/busy read).
      await getFreeBusy(USER_ID, from, to, ["primary"]);
      assert.fail("authoritative live 403 must throw");
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      thrown instanceof CalendarReauthRequiredError,
      "authoritative live 403 must throw CalendarReauthRequiredError",
    );
    const writes = statusWrites();
    assert.equal(
      writes.length,
      1,
      "authoritative live blip MUST write exactly one credential status",
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
    ["probe terminal refresh → throws, no credential-status write", testProbeTerminalPreservesConnection],
    ["proactive terminal refresh → throws, no credential-status write", testProactiveTerminalPreservesConnection],
    ["authoritative terminal refresh → throws, status flipped to disconnected", testAuthoritativeTerminalDisconnects],
    ["probe live blip (getFreeBusy 403) → throws CalendarReauthRequiredError, no credential-status write", testProbeLiveBlipPreservesConnection],
    ["authoritative live blip (getFreeBusy 403) → throws, status flipped to disconnected", testAuthoritativeLiveBlipDisconnects],
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
    throw new Error("google-calendar-health-check-no-disconnect test cases failed");
  }
  console.log("google-calendar-health-check-no-disconnect: OK");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
