/* test-registration
{
  "name": "Cross-integration no-false-disconnect contract \u2014 all rotating-token integrations (Task #2503)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~4.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2503 — Single unified cross-integration contract test asserting that
 * NO rotating-refresh-token integration shows a false "Not Connected" after a
 * publish.
 *
 * Background. Task #2267 (generalizing SEMrush #2265) made every rotating
 * OAuth integration gate its terminal-disconnect on
 * `isAuthoritativeRefreshPurpose`: a NON-authoritative refresh (a `probe`
 * health check or a `proactive` top-up) that loses a refresh-token rotation
 * race 4xx's `invalid_grant` on a captured-but-already-consumed token, and
 * that must NOT commit a durable disconnect. Task #2500 then made the Hub
 * badge for the three system-wide integrations degrade to `probe_failed`
 * (preserve the last-known-good badge) on that race, instead of flashing
 * `unauthorized`, while still surfacing a GENUINE durable disconnect.
 *
 * Each integration already has its own per-integration health-check test, but
 * there was no SINGLE cross-integration contract test asserting the shared
 * invariant for ALL rotating-token integrations at once — so a future
 * integration (or a refactor of an existing one) could silently reintroduce
 * the flash-disconnect bug without tripping any test.
 *
 * This file closes that gap. It iterates EVERY integration registered in
 * `PROBE_PURPOSE_REGISTRY` (the source of truth in
 * scripts/lint-probe-refresh-purpose.ts — the same set guarded by the
 * probe-purpose lint) and asserts, per integration, two halves of the shared
 * invariant:
 *
 *   A. No false disconnect. With the durable disconnect signal CLOSED, a
 *      non-authoritative (probe/proactive) terminal refresh must NOT engage
 *      the durable disconnect signal and must NOT wipe stored credentials.
 *      For the integrations that expose the #2500 badge contract
 *      (Front/SEMrush), the badge ALSO degrades to `probe_failed`.
 *      (Google Ads left this registry with Task #4008 — env-credential model,
 *      no rotating platform token, no probe refresh.)
 *
 *   B. A genuine disconnect still surfaces. With the durable disconnect
 *      signal ENGAGED (a real authoritative refresh confirmed the death), the
 *      operator-facing surface MUST report `unauthorized` — the preserve fix
 *      never masks a real disconnect.
 *
 * COMPLETENESS GATE. Every registry key MUST map to a contract adapter here
 * (and vice-versa). A new rotating-token integration added to the registry
 * without a matching adapter FAILS this test loudly — that is the
 * anti-regression mechanism the per-integration tests cannot provide.
 *
 * Two integrations honor the invariant at the ACCESSOR level rather than the
 * badge level, and that is deliberate (NOT a gap):
 *   - Zoom: its `probeConnection()` maps a terminal probe refresh to
 *     `unauthorized` by design (pre-#2500 contract), so its rotation-race
 *     safety lives in `getAccessToken` (gate not engaged, tokens intact). It
 *     is NOT in #2500's badge-degrade scope.
 *   - Google Calendar: per-user OAuth with no system-wide badge — its durable
 *     signal is the per-user credential `status`, asserted via the accessor.
 * Both are flagged `hasBadgeProbeFailedContract: false`; the universal
 * accessor-level invariant (A + B) is still asserted for them.
 *
 * Must run with NODE_ENV=test so the cross-process OAuth refresh lease is
 * disabled (see .agents/memory/oauth-rotation-test-needs-node-env-test.md) —
 * the lease check reads NODE_ENV at call time, so setting it here before any
 * integration import is sufficient. The run-all harness already sets it; this
 * line keeps a bare `npx tsx` of this file honest too.
 *
 * Pure in-memory: each adapter stubs its own credential store and intercepts
 * `fetch` — no DB, no network.
 */
process.env.NODE_ENV = "test";

// Integration module init reads these at import time — set them first.
process.env.FRONT_CLIENT_ID = process.env.FRONT_CLIENT_ID || "test_front_client_id";
process.env.FRONT_CLIENT_SECRET =
  process.env.FRONT_CLIENT_SECRET || "test_front_client_secret";
process.env.ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "test_zoom_client_id";
process.env.ZOOM_CLIENT_SECRET =
  process.env.ZOOM_CLIENT_SECRET || "test_zoom_client_secret";
process.env.GOOGLE_ADS_CLIENT_ID =
  process.env.GOOGLE_ADS_CLIENT_ID || "test_gads_client_id";
process.env.GOOGLE_ADS_CLIENT_SECRET =
  process.env.GOOGLE_ADS_CLIENT_SECRET || "test_gads_client_secret";
process.env.GOOGLE_ADS_DEVELOPER_TOKEN =
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "test_gads_dev_token";
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID =
  process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "1234567890";
process.env.GOOGLE_CALENDAR_CLIENT_ID =
  process.env.GOOGLE_CALENDAR_CLIENT_ID || "test_gcal_client_id";
process.env.GOOGLE_CALENDAR_CLIENT_SECRET =
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET || "test_gcal_client_secret";

import { strict as assert } from "node:assert";

import { PROBE_PURPOSE_REGISTRY } from "../scripts/lint-probe-refresh-purpose";
import { storage } from "../server/storage";
import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import { encryptToken, decryptToken } from "../server/utils/tokenCrypto";

import * as front from "../server/services/frontIntegration";
import {
  frontAuthBreakerActive,
  tripFrontAuthBreaker,
  __resetFrontAuthBreakerForTest,
  __clearPersistedFrontAuthBreakerForTest,
} from "../server/services/frontAuthBreaker";

import * as semrush from "../server/services/semrushApi";
import {
  semrushAuthBreakerActive,
  tripSemrushAuthBreaker,
  __resetSemrushAuthBreakerForTest,
  __clearPersistedSemrushAuthBreakerForTest,
} from "../server/services/semrushAuthBreaker";

import * as zoom from "../server/services/zoomIntegration";
import * as gcal from "../server/services/googleCalendarIntegration";

// ---------------------------------------------------------------------------
// Shared in-memory stubs.
// ---------------------------------------------------------------------------

type BadgeOutcome = "connected" | "unauthorized" | "probe_failed";
type SettingMap = Map<string, string>;

const originalFetch = globalThis.fetch;
const originalGetSetting = storage.getSystemSetting.bind(storage);
const originalSetSetting = storage.setSystemSetting.bind(storage);

/** Terminal refresh failure — a recognized OAuth 4xx (the rotation-race shape). */
function terminalResponse(error = "invalid_grant"): Response {
  return new Response(JSON.stringify({ error }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

/** A successful token-endpoint response (the rotated-token retry succeeds). */
function successTokenResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Task #2520 — outcome of the AUTHORITATIVE cross-process rotation-race
 * RECOVERY probe (see the interface doc on
 * `runAuthoritativeRotationRaceRecovery`). The harness asserts all three.
 */
interface RotationRaceRecoveryResult {
  /**
   * The access token the recovery returned, or `null` if the authoritative
   * refresh threw instead of recovering (a regression — the re-read-and-retry
   * failed to pick up the sibling's freshly-rotated token).
   */
  recoveredToken: string | null;
  /** True if the stored refresh credential was CLEARED to empty (a wipe). */
  credentialsWiped: boolean;
  /** True if the durable disconnect signal engaged during the recovery. */
  durableSignalEngaged: boolean;
}

function installSystemSettingStub(map: SettingMap): void {
  (storage as any).getSystemSetting = async (key: string) => {
    const value = map.get(key);
    return value === undefined ? undefined : { key, value };
  };
  (storage as any).setSystemSetting = async (key: string, value: string) => {
    map.set(key, value);
    return { key, value };
  };
}

function restoreSystemSettingStub(): void {
  (storage as any).getSystemSetting = originalGetSetting;
  (storage as any).setSystemSetting = originalSetSetting;
}

function installFetchStub(
  responder: (url: string, init?: any) => Response | Promise<Response>,
): void {
  globalThis.fetch = (async (input: any, init?: any) =>
    responder(typeof input === "string" ? input : String(input), init)) as any;
}

/** Only intercept the given token host; let incidental HTTP pass through. */
function installScopedFetchStub(
  tokenHostPrefix: string,
  responder: (url: string, init?: any) => Response | Promise<Response>,
): void {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.startsWith(tokenHostPrefix)) return responder(url, init);
    return originalFetch(input, init);
  }) as any;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

/** Classify a thrown accessor error: does it announce a genuine disconnect? */
function classifyDisconnectError(err: unknown): "unauthorized" | string {
  const msg = String((err as any)?.message ?? err);
  // Mirror the shared disconnect-throw phrases registered in
  // scripts/lint-probe-swallow-into-unauthorized.ts.
  return /not connected|status is|missing refresh token|unauthorized|invalid_grant/i.test(
    msg,
  )
    ? "unauthorized"
    : `non-disconnect error: ${msg}`;
}

// ---------------------------------------------------------------------------
// Contract adapter shape — the SHARED invariant logic lives in the harness;
// adapters provide only the integration-specific glue.
// ---------------------------------------------------------------------------

interface IntegrationContract {
  /** Full path — MUST equal a PROBE_PURPOSE_REGISTRY key. */
  registryKey: string;
  label: string;
  /**
   * Whether this integration exposes the #2500 badge contract
   * (probeConnection → probe_failed on a non-authoritative terminal with the
   * durable signal closed). Zoom/Calendar are accessor-level only.
   */
  hasBadgeProbeFailedContract: boolean;

  /** Connected-but-expired creds + terminal-refresh fetch stub + durable CLOSED. */
  setup(): Promise<void>;
  teardown(): Promise<void>;

  /**
   * Run one non-authoritative (probe/proactive) terminal refresh. Returns the
   * badge outcome when the integration has a probeConnection() badge, else
   * null (accessor-only: the throw is expected and swallowed).
   */
  runNonAuthoritativeTerminal(): Promise<BadgeOutcome | null>;

  /** Is the durable disconnect signal currently engaged? */
  durableSignalEngaged(): Promise<boolean>;
  /** Were the stored credentials wiped? */
  credentialsWiped(): Promise<boolean>;

  /** Engage the durable disconnect signal (an authoritative refresh confirmed death). */
  engageDurableDisconnect(): Promise<void>;
  /** With the durable signal engaged, what does the operator-facing surface report? */
  surfaceWhenDurablyDisconnected(): Promise<"unauthorized" | string>;

  /**
   * Task #2520 — OPTIONAL authoritative cross-process rotation-race RECOVERY
   * probe (the third behavior in the no-false-disconnect family, previously
   * asserted only for SEMrush in
   * tests/semrush-health-check-no-disconnect.test.ts case 4).
   *
   * Self-contained: seed a connected-but-expired credential, then drive the
   * AUTHORITATIVE refresh path (default/real purpose — NOT a probe/proactive)
   * under a rotation race. The first token POST 4xx's terminally on the
   * captured (already-consumed) refresh token while a sibling instance
   * concurrently rotates the stored token; the helper's re-read-and-retry then
   * POSTs the freshly-rotated token, which succeeds. The probe owns its own
   * fetch/credential stubs and restores them before returning.
   *
   * The harness asserts the recovery returns a fresh access token AND the
   * stored credentials are NOT wiped AND the durable signal (breaker / gate /
   * status) stays closed — i.e. an authoritative caller never tears down a
   * still-valid connection just because it lost a publish-time rotation race.
   *
   * When an integration genuinely cannot express this contract, leave this
   * undefined and set `rotationRaceRecoveryUnsupportedReason` to document why
   * (the harness then skips it explicitly, mirroring the
   * `hasBadgeProbeFailedContract` divergence pattern).
   */
  runAuthoritativeRotationRaceRecovery?(): Promise<RotationRaceRecoveryResult>;
  /**
   * Required ONLY when `runAuthoritativeRotationRaceRecovery` is undefined —
   * the documented reason the integration cannot express the recovery
   * contract. The harness fails loudly on an undocumented skip.
   */
  rotationRaceRecoveryUnsupportedReason?: string;
}

// ---------------------------------------------------------------------------
// Front — durable signal = global auth-dead breaker; badge = probeConnection.
// ---------------------------------------------------------------------------

const frontContract: IntegrationContract = (() => {
  const ACCESS = "front_access_token";
  const REFRESH = "front_refresh_token";
  const EXPIRES = "front_token_expires_at"; // epoch SECONDS
  let map: SettingMap;
  return {
    registryKey: "server/services/frontIntegration.ts",
    label: "Front",
    hasBadgeProbeFailedContract: true,
    async setup() {
      map = new Map([
        [ACCESS, "at-expired"],
        [REFRESH, "rt-live"],
        [EXPIRES, String(Math.floor(Date.now() / 1000) - 100)],
      ]);
      installSystemSettingStub(map);
      installFetchStub(() => terminalResponse());
      __resetOAuthRefreshSingleFlightForTest();
      __resetFrontAuthBreakerForTest();
      await __clearPersistedFrontAuthBreakerForTest();
    },
    async teardown() {
      __resetFrontAuthBreakerForTest();
      await __clearPersistedFrontAuthBreakerForTest();
      restoreSystemSettingStub();
      restoreFetch();
    },
    async runNonAuthoritativeTerminal() {
      return (await front.probeConnection()).outcome;
    },
    async durableSignalEngaged() {
      return frontAuthBreakerActive();
    },
    async credentialsWiped() {
      return map.get(REFRESH) !== "rt-live";
    },
    async engageDurableDisconnect() {
      tripFrontAuthBreaker("front_refresh_failed_permanent");
    },
    async surfaceWhenDurablyDisconnected() {
      return (await front.probeConnection()).outcome;
    },
    async runAuthoritativeRotationRaceRecovery() {
      map = new Map([
        [ACCESS, "at-expired"],
        [REFRESH, "rt-live"],
        [EXPIRES, String(Math.floor(Date.now() / 1000) - 100)],
      ]);
      installSystemSettingStub(map);
      installFetchStub((_url, init) => {
        const body = String(init?.body ?? "");
        // Retry POST carries the sibling-rotated token → succeeds.
        if (body.includes("rt-rotated")) {
          return successTokenResponse({
            access_token: "at-new",
            refresh_token: "rt-rotated2",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          });
        }
        // First POST: a sibling instance rotates the stored refresh token
        // out from under us, then this captured-token POST 4xx's terminally.
        map.set(REFRESH, "rt-rotated");
        return terminalResponse();
      });
      __resetOAuthRefreshSingleFlightForTest();
      __resetFrontAuthBreakerForTest();
      await __clearPersistedFrontAuthBreakerForTest();
      try {
        let recoveredToken: string | null = null;
        try {
          // purpose "internal" is authoritative (the real getAccessToken path).
          recoveredToken = await front.getValidFrontAccessToken({ purpose: "internal" });
        } catch {
          recoveredToken = null;
        }
        return {
          recoveredToken,
          credentialsWiped: !map.get(REFRESH),
          durableSignalEngaged: frontAuthBreakerActive(),
        };
      } finally {
        __resetFrontAuthBreakerForTest();
        await __clearPersistedFrontAuthBreakerForTest();
        restoreSystemSettingStub();
        restoreFetch();
      }
    },
  };
})();

// ---------------------------------------------------------------------------
// SEMrush — durable signal = global auth-dead breaker; badge = probeConnection.
// ---------------------------------------------------------------------------

const semrushContract: IntegrationContract = (() => {
  const ACCESS = "semrush_access_token";
  const REFRESH = "semrush_refresh_token";
  const EXPIRES = "semrush_token_expires_at"; // epoch MILLISECONDS
  let map: SettingMap;
  return {
    registryKey: "server/services/semrushApi.ts",
    label: "SEMrush",
    hasBadgeProbeFailedContract: true,
    async setup() {
      map = new Map([
        [ACCESS, "at-expired"],
        [REFRESH, "rt-live"],
        [EXPIRES, String(Date.now() - 10_000)],
      ]);
      installSystemSettingStub(map);
      // SEMrush signals a dead refresh token with `invalid_request` (its quirk).
      installFetchStub(() => terminalResponse("invalid_request"));
      __resetOAuthRefreshSingleFlightForTest();
      __resetSemrushAuthBreakerForTest();
      await __clearPersistedSemrushAuthBreakerForTest();
    },
    async teardown() {
      __resetSemrushAuthBreakerForTest();
      await __clearPersistedSemrushAuthBreakerForTest();
      restoreSystemSettingStub();
      restoreFetch();
    },
    async runNonAuthoritativeTerminal() {
      return (await semrush.probeConnection()).outcome;
    },
    async durableSignalEngaged() {
      return semrushAuthBreakerActive();
    },
    async credentialsWiped() {
      return map.get(REFRESH) !== "rt-live";
    },
    async engageDurableDisconnect() {
      tripSemrushAuthBreaker("semrush_refresh_failed_permanent");
    },
    async surfaceWhenDurablyDisconnected() {
      return (await semrush.probeConnection()).outcome;
    },
    async runAuthoritativeRotationRaceRecovery() {
      map = new Map([
        [ACCESS, "at-expired"],
        [REFRESH, "rt-live"],
        [EXPIRES, String(Date.now() - 10_000)],
      ]);
      installSystemSettingStub(map);
      installFetchStub((_url, init) => {
        const body = String(init?.body ?? "");
        if (body.includes("rt-rotated")) {
          return successTokenResponse({
            access_token: "at-new",
            refresh_token: "rt-rotated2",
            expires_in: 604800,
          });
        }
        // Sibling rotates the stored token, then this captured-token POST
        // 4xx's terminally (SEMrush signals it with `invalid_request`).
        map.set(REFRESH, "rt-rotated");
        return terminalResponse("invalid_request");
      });
      __resetOAuthRefreshSingleFlightForTest();
      __resetSemrushAuthBreakerForTest();
      await __clearPersistedSemrushAuthBreakerForTest();
      try {
        let recoveredToken: string | null = null;
        try {
          // The no-purpose authoritative refresh (the reference case 4 path).
          recoveredToken = await semrush.__refreshAccessTokenForTest();
        } catch {
          recoveredToken = null;
        }
        return {
          recoveredToken,
          credentialsWiped: !map.get(REFRESH),
          durableSignalEngaged: semrushAuthBreakerActive(),
        };
      } finally {
        __resetSemrushAuthBreakerForTest();
        await __clearPersistedSemrushAuthBreakerForTest();
        restoreSystemSettingStub();
        restoreFetch();
      }
    },
  };
})();

// ---------------------------------------------------------------------------
// Zoom — durable signal = global auth gate; accessor-level invariant. The
// badge maps a terminal probe to `unauthorized` by design (pre-#2500), so it
// is NOT in the badge-degrade scope; rotation-race safety is at getAccessToken.
// ---------------------------------------------------------------------------

const zoomContract: IntegrationContract = (() => {
  const ACCESS = "zoom_access_token";
  const REFRESH = "zoom_refresh_token";
  const EXPIRES = "zoom_token_expires_at"; // epoch SECONDS
  let map: SettingMap;
  return {
    registryKey: "server/services/zoomIntegration.ts",
    label: "Zoom",
    hasBadgeProbeFailedContract: false,
    async setup() {
      zoom.__disableZoomAuthSelfHealForTest(true);
      map = new Map([
        [ACCESS, "at-expired"],
        [REFRESH, "rt-live"],
        [EXPIRES, String(Math.floor(Date.now() / 1000) - 100)],
      ]);
      installSystemSettingStub(map);
      installFetchStub(() => terminalResponse());
      __resetOAuthRefreshSingleFlightForTest();
      zoom.clearZoomPermanentFailure("test_reset");
      await zoom.__clearPersistedZoomAuthGateForTest();
    },
    async teardown() {
      zoom.clearZoomPermanentFailure("test_reset");
      await zoom.__clearPersistedZoomAuthGateForTest();
      zoom.__disableZoomAuthSelfHealForTest(false);
      restoreSystemSettingStub();
      restoreFetch();
    },
    async runNonAuthoritativeTerminal() {
      try {
        await zoom.getAccessToken({ purpose: "zoom_probe" });
        assert.fail("Zoom: probe terminal refresh must throw");
      } catch {
        /* expected — accessor surfaces the error, no badge to report */
      }
      return null;
    },
    async durableSignalEngaged() {
      return zoom.getZoomAuthGate() !== null;
    },
    async credentialsWiped() {
      return map.get(REFRESH) !== "rt-live";
    },
    async engageDurableDisconnect() {
      // An authoritative terminal refresh engages the gate (the durable signal).
      try {
        await zoom.getAccessToken({ purpose: "expiry_or_401" });
      } catch {
        /* expected — the throw is how it engages the gate */
      }
    },
    async surfaceWhenDurablyDisconnected() {
      // With the gate engaged, the probe badge reflects the genuine disconnect.
      return (await zoom.probeConnection()).outcome;
    },
    async runAuthoritativeRotationRaceRecovery() {
      zoom.__disableZoomAuthSelfHealForTest(true);
      map = new Map([
        [ACCESS, "at-expired"],
        [REFRESH, "rt-live"],
        [EXPIRES, String(Math.floor(Date.now() / 1000) - 100)],
      ]);
      installSystemSettingStub(map);
      installFetchStub((_url, init) => {
        const body = String(init?.body ?? "");
        if (body.includes("rt-rotated")) {
          return successTokenResponse({
            access_token: "at-new",
            refresh_token: "rt-rotated2",
            expires_in: 3600,
          });
        }
        // Sibling rotates the stored token, then this captured-token POST 4xx's.
        map.set(REFRESH, "rt-rotated");
        return terminalResponse();
      });
      __resetOAuthRefreshSingleFlightForTest();
      zoom.clearZoomPermanentFailure("test_reset");
      await zoom.__clearPersistedZoomAuthGateForTest();
      try {
        let recoveredToken: string | null = null;
        try {
          // refreshAccessToken's purpose ("expiry_or_401") is authoritative.
          recoveredToken = await zoom.refreshAccessToken();
        } catch {
          recoveredToken = null;
        }
        return {
          recoveredToken,
          credentialsWiped: !map.get(REFRESH),
          durableSignalEngaged: zoom.getZoomAuthGate() !== null,
        };
      } finally {
        zoom.clearZoomPermanentFailure("test_reset");
        await zoom.__clearPersistedZoomAuthGateForTest();
        zoom.__disableZoomAuthSelfHealForTest(false);
        restoreSystemSettingStub();
        restoreFetch();
      }
    },
  };
})();

// ---------------------------------------------------------------------------
// Google Calendar — PER-USER; durable signal = credential status write;
// accessor-level invariant (no system-wide badge).
// ---------------------------------------------------------------------------

const googleCalendarContract: IntegrationContract = (() => {
  const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
  const USER_ID = "user-oauth-contract";
  const originalGetCred = (storage as any).getGoogleCalendarCredential;
  const originalUpdateCred = (storage as any).updateGoogleCalendarCredential;
  let updates: Array<Record<string, any>> = [];
  let credStatus: "connected" | "disconnected" = "connected";
  function installCredStub(): void {
    updates = [];
    (storage as any).getGoogleCalendarCredential = async () => ({
      userId: USER_ID,
      status: credStatus,
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
  return {
    registryKey: "server/services/googleCalendarIntegration.ts",
    label: "Google Calendar",
    hasBadgeProbeFailedContract: false,
    async setup() {
      credStatus = "connected";
      installCredStub();
      installScopedFetchStub(GOOGLE_TOKEN_URL, () => terminalResponse());
      __resetOAuthRefreshSingleFlightForTest();
    },
    async teardown() {
      (storage as any).getGoogleCalendarCredential = originalGetCred;
      (storage as any).updateGoogleCalendarCredential = originalUpdateCred;
      restoreFetch();
    },
    async runNonAuthoritativeTerminal() {
      try {
        await gcal.getValidAccessToken(USER_ID, { purpose: "proactive" });
        assert.fail("Google Calendar: proactive terminal refresh must throw");
      } catch {
        /* expected — accessor surfaces the error, no badge to report */
      }
      return null;
    },
    async durableSignalEngaged() {
      // Calendar's durable disconnect is a credential-status write to a
      // non-connected state.
      return updates.some((p) => "status" in p && p.status !== "connected");
    },
    async credentialsWiped() {
      // Calendar never wipes tokens — it writes status. Always false.
      return false;
    },
    async engageDurableDisconnect() {
      // Flip the per-user credential to disconnected (an authoritative refresh
      // would have committed this).
      credStatus = "disconnected";
    },
    async surfaceWhenDurablyDisconnected() {
      try {
        await gcal.getValidAccessToken(USER_ID, { purpose: "proactive" });
        return "no-throw (expected a disconnect)";
      } catch (err) {
        return classifyDisconnectError(err);
      }
    },
    async runAuthoritativeRotationRaceRecovery() {
      let currentRefresh = "rt-live";
      let status: "connected" | "disconnected" = "connected";
      const localUpdates: Array<Record<string, any>> = [];
      (storage as any).getGoogleCalendarCredential = async () => ({
        userId: USER_ID,
        status,
        accessTokenEncrypted: encryptToken("at-expired"),
        refreshTokenEncrypted: encryptToken(currentRefresh),
        tokenExpiry: new Date(Date.now() - 60_000),
        calendarId: "primary",
        lastError: null,
      });
      (storage as any).updateGoogleCalendarCredential = async (
        _userId: string,
        patch: Record<string, any>,
      ) => {
        localUpdates.push(patch);
        if (patch.refreshTokenEncrypted) {
          currentRefresh = decryptToken(patch.refreshTokenEncrypted);
        }
        if (typeof patch.status === "string") status = patch.status;
      };
      installScopedFetchStub(GOOGLE_TOKEN_URL, (_url, init) => {
        const body = String(init?.body ?? "");
        if (body.includes("rt-rotated")) {
          return successTokenResponse({
            access_token: "at-new",
            refresh_token: "rt-rotated2",
            expires_in: 3600,
          });
        }
        // Sibling rotates this user's token, then the captured-token POST 4xx's.
        currentRefresh = "rt-rotated";
        return terminalResponse();
      });
      __resetOAuthRefreshSingleFlightForTest();
      try {
        let recoveredToken: string | null = null;
        try {
          // The no-purpose accessor refresh is authoritative.
          recoveredToken = await gcal.getValidAccessToken(USER_ID);
        } catch {
          recoveredToken = null;
        }
        return {
          recoveredToken,
          // Calendar never wipes tokens (it writes status); the recovery
          // rotates the stored token forward, which is not a wipe.
          credentialsWiped: false,
          durableSignalEngaged: localUpdates.some(
            (p) => "status" in p && p.status !== "connected",
          ),
        };
      } finally {
        (storage as any).getGoogleCalendarCredential = originalGetCred;
        (storage as any).updateGoogleCalendarCredential = originalUpdateCred;
        restoreFetch();
      }
    },
  };
})();

// ---------------------------------------------------------------------------
// Adapter registry, keyed by PROBE_PURPOSE_REGISTRY path.
// ---------------------------------------------------------------------------

const CONTRACTS: IntegrationContract[] = [
  frontContract,
  semrushContract,
  zoomContract,
  googleCalendarContract,
];

// ---------------------------------------------------------------------------
// Completeness gate — every registry key MUST map to an adapter (and v.v.).
// ---------------------------------------------------------------------------

function testRegistryCompleteness(): void {
  const registryKeys = new Set(PROBE_PURPOSE_REGISTRY.keys());
  const adapterKeys = new Set(CONTRACTS.map((c) => c.registryKey));

  const missingAdapters = [...registryKeys].filter((k) => !adapterKeys.has(k));
  assert.deepEqual(
    missingAdapters,
    [],
    `Every PROBE_PURPOSE_REGISTRY integration must have a contract adapter in ` +
      `this test. Missing: ${missingAdapters.join(", ")}. A new rotating-token ` +
      `integration was registered without asserting the #2500/#2267 no-false-` +
      `disconnect invariant — add an adapter to CONTRACTS.`,
  );

  const staleAdapters = [...adapterKeys].filter((k) => !registryKeys.has(k));
  assert.deepEqual(
    staleAdapters,
    [],
    `Every contract adapter must correspond to a live PROBE_PURPOSE_REGISTRY ` +
      `key. Stale: ${staleAdapters.join(", ")}.`,
  );

  // No duplicate adapters for the same integration.
  assert.equal(
    adapterKeys.size,
    CONTRACTS.length,
    "Duplicate contract adapters detected (two entries share a registryKey).",
  );
}

// ---------------------------------------------------------------------------
// Shared invariant — A (no false disconnect) and B (real disconnect surfaces).
// ---------------------------------------------------------------------------

async function assertNoFalseDisconnect(c: IntegrationContract): Promise<void> {
  await c.setup();
  try {
    const badge = await c.runNonAuthoritativeTerminal();
    assert.equal(
      await c.durableSignalEngaged(),
      false,
      `${c.label}: a non-authoritative terminal refresh must NOT engage the ` +
        `durable disconnect signal (rotation-race safe; no false "Not Connected")`,
    );
    assert.equal(
      await c.credentialsWiped(),
      false,
      `${c.label}: a non-authoritative terminal refresh must NOT wipe stored credentials`,
    );
    if (c.hasBadgeProbeFailedContract) {
      assert.equal(
        badge,
        "probe_failed",
        `${c.label}: badge must degrade to probe_failed (preserve last-known-good), ` +
          `not flash unauthorized after publish (Task #2500)`,
      );
    } else {
      assert.equal(
        badge,
        null,
        `${c.label}: accessor-level integration must report no badge from the ` +
          `non-authoritative path (it surfaces via the accessor throw instead)`,
      );
    }
  } finally {
    await c.teardown();
  }
}

async function assertGenuineDisconnectSurfaces(
  c: IntegrationContract,
): Promise<void> {
  await c.setup();
  try {
    await c.engageDurableDisconnect();
    const surfaced = await c.surfaceWhenDurablyDisconnected();
    assert.equal(
      surfaced,
      "unauthorized",
      `${c.label}: with the durable disconnect signal ENGAGED, the surface MUST ` +
        `report unauthorized — the preserve fix must never mask a real disconnect`,
    );
  } finally {
    await c.teardown();
  }
}

// ---------------------------------------------------------------------------
// Shared invariant — C (authoritative cross-process rotation-race RECOVERY).
// ---------------------------------------------------------------------------

async function assertAuthoritativeRotationRaceRecovers(
  c: IntegrationContract,
): Promise<void> {
  if (!c.runAuthoritativeRotationRaceRecovery) {
    // Documented, explicit skip — mirrors the hasBadgeProbeFailedContract
    // divergence pattern (an integration that genuinely cannot express this
    // contract must say WHY, never silently opt out).
    assert.ok(
      c.rotationRaceRecoveryUnsupportedReason,
      `${c.label}: an integration without an authoritative rotation-race ` +
        `recovery probe MUST document why via rotationRaceRecoveryUnsupportedReason`,
    );
    console.log(
      `  ⊘ ${c.label}: authoritative rotation-race recovery skipped — ` +
        `${c.rotationRaceRecoveryUnsupportedReason}`,
    );
    return;
  }
  const r = await c.runAuthoritativeRotationRaceRecovery();
  assert.ok(
    r.recoveredToken,
    `${c.label}: an AUTHORITATIVE refresh that loses a cross-process rotation ` +
      `race must RECOVER via re-read-and-retry and return a fresh access token ` +
      `(got ${r.recoveredToken === null ? "null — the retry failed to pick up the sibling's rotated token" : r.recoveredToken})`,
  );
  assert.equal(
    r.credentialsWiped,
    false,
    `${c.label}: a recovered rotation race must NOT wipe the stored credentials ` +
      `— the connection is still valid (a sibling rotated it healthy)`,
  );
  assert.equal(
    r.durableSignalEngaged,
    false,
    `${c.label}: a recovered rotation race must NOT engage the durable ` +
      `disconnect signal (breaker / gate / status) — no false "Not Connected"`,
  );
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cases: Array<[string, () => void | Promise<void>]> = [
    [
      "registry completeness — every PROBE_PURPOSE_REGISTRY integration has a contract adapter",
      testRegistryCompleteness,
    ],
  ];
  for (const c of CONTRACTS) {
    cases.push([
      `${c.label}: non-authoritative terminal → no false disconnect (durable closed, creds intact)`,
      () => assertNoFalseDisconnect(c),
    ]);
    cases.push([
      `${c.label}: durable disconnect engaged → surfaces unauthorized (real disconnect not masked)`,
      () => assertGenuineDisconnectSurfaces(c),
    ]);
    cases.push([
      `${c.label}: authoritative cross-process rotation race → recovers with fresh token (no false disconnect)`,
      () => assertAuthoritativeRotationRaceRecovers(c),
    ]);
  }

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
    throw new Error("oauth-no-false-disconnect-contract test cases failed");
  }
  console.log("oauth-no-false-disconnect-contract: OK");
}

// The shared test teardown in server/db.ts unref's idle pg sockets in test
// mode, so the loop drains and the child exits on its own once main() settles.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
