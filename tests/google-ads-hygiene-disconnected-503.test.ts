/* test-registration
{
  "name": "Ads Hygiene disconnected → structured 503 + shared client parser (Task #2794)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2794 (re-based by Task #4008 onto the env-credential model): the /admin/ads-hygiene rotate-credentials banner rides on one route-level contract — auth-dead Google Ads errors map to a structured `503 { code: \"google_ads_disconnected\" }` and the SAME shared parser drives the page banner + global toast suppression. Gate the route test so a drift in the auth-dead phrase family (token accessor rewording) or the parser's \"503: <json>\" contract fails fast instead of silently reverting the page to generic 500 toasts.",
  "tier": "small"
}
test-registration */
/**
 * Task #2794 (re-based by Task #4008) — /admin/ads-hygiene "Google Ads
 * credentials" 503 contract under the unified env-credential model.
 *
 * When the Google Ads credential is auth-dead, the Ads Hygiene routes used to
 * surface a generic `500 { error }` per widget. This suite locks the behavior
 * at the route level:
 *
 *   1. Pacing route with the env secrets INCOMPLETE → structured
 *      `503 { code: "google_ads_disconnected", reason: /not connected/ }`,
 *      zero token POSTs (config check precedes any mint).
 *   2. Pacing route with a terminally-rejected credential: first call mints
 *      once (real 400 from the stubbed token endpoint) and arms the shared
 *      negative cache → rejected-phrase 503; second call short-circuits
 *      pre-mint — same structured 503, no new POST.
 *   3. The shared client-side parser round-trips the exact error string the
 *      client's `apiRequest` would throw (`"503: <json>"`) and rejects
 *      non-disconnect 503s / non-503s, so the page banner and the global
 *      toast suppression key off the same predicate the server emits.
 *   4. Classifier boundaries: ONLY the two terminal phrases classify;
 *      transient errors (network blips, GAQL 5xx, plain strings) do not.
 *
 * Isolation: credential state is process-local (env vars + the shared
 * mint's in-memory auth state, reset via `__adsOsResetAuthStateForTest`);
 * the token endpoint is a fetch stub. No DB rows are read or written on
 * these paths (the mint fails before any GAQL work).
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { storage } from "../server/storage";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { closeDbPools } from "../server/db";
import { registerGoogleAdsHygieneRoutes } from "../server/routes/googleAdsHygiene";
import {
  isGoogleAdsAuthDeadError,
  respondGoogleAdsDisconnected,
} from "../server/routes/googleAdsDisconnected";
import { __adsOsResetAuthStateForTest } from "../server/services/adsOs/googleAdsClient";
import {
  GOOGLE_ADS_DISCONNECTED_CODE,
  parseGoogleAdsDisconnectedError,
} from "../shared/googleAdsDisconnect";

const TAG = "task-2794";
const USER_ID = "gads-2794-ceo";
const CUSTOMER_ID = "1234567890";

const s = storage as any;
const originalGetUser = s.getUser;

// ---------------------------------------------------------------------------
// Env pinning — synthetic secrets; originals restored in finally (batched
// runner shares one process; a leaked env edit poisons sibling suites).
// ---------------------------------------------------------------------------
const ENV_KEYS = [
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_ADS_REFRESH_TOKEN",
] as const;
const envOriginals = new Map<string, string | undefined>(
  ENV_KEYS.map((k) => [k, process.env[k]]),
);
function setSyntheticEnv(): void {
  process.env.GOOGLE_ADS_CLIENT_ID = `${TAG}-client-id`;
  process.env.GOOGLE_ADS_CLIENT_SECRET = `${TAG}-client-secret`;
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = `${TAG}-dev-token`;
  process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "9876543210";
  process.env.GOOGLE_ADS_REFRESH_TOKEN = `${TAG}-refresh-token`;
}
function restoreEnv(): void {
  for (const [k, v] of envOriginals) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ---------------------------------------------------------------------------
// Fetch stub — the Google OAuth token host answers a terminal 400
// invalid_grant; loopback passes through; everything else is a benign 503.
// ---------------------------------------------------------------------------
let tokenHostHits = 0;
const originalFetch: typeof fetch = global.fetch;
global.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.includes("oauth2.googleapis.com")) {
    tokenHostHits++;
    return new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
    return originalFetch(input as any, init);
  }
  return new Response(`unavailable (${TAG} stub)`, { status: 503 });
}) as any;

function installStubs(): void {
  s.getUser = async (id: string) =>
    id === USER_ID
      ? {
          id: USER_ID,
          email: "gads-2794@test.local",
          firstName: "Ads",
          lastName: "Hygiene",
          role: "ceo",
        }
      : undefined;
  // storage.getUser is stubbed but requireAuth resolves identity via the
  // ambient PUBLIC-schema db (no seeded row here). Pre-register the profile so
  // requireAuth uses it directly (no JIT-provisioning litter / comms auto-join).
  __test_markUserReconciled(USER_ID, {
    id: USER_ID,
    email: "gads-2794@test.local",
    firstName: "Ads",
    lastName: "Hygiene",
    role: "ceo",
  });
}

function restoreStubs(): void {
  s.getUser = originalGetUser;
  restoreEnv();
  __adsOsResetAuthStateForTest();
  global.fetch = originalFetch;
  __test_resetReconciledUsers();
}

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): authenticate as
    // USER_ID. The real isAuthenticated middleware reads this and populates
    // req.user.claims.sub; role gating resolves via the stubbed storage.getUser.
    req.__test_clerkUserId = USER_ID;
    next();
  });
  registerGoogleAdsHygieneRoutes(app);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function getPacing(baseUrl: string): Promise<{ status: number; json: any }> {
  const r = await fetch(
    `${baseUrl}/api/admin/google-ads-hygiene/${CUSTOMER_ID}/pacing`,
  );
  let json: any = null;
  try {
    json = await r.json();
  } catch {
    // non-JSON body — assertions below will fail loudly on json shape
  }
  return { status: r.status, json };
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

async function main(): Promise<void> {
  console.log("Ads Hygiene disconnected 503 contract (Task #2794/#4008)");

  installStubs();
  __adsOsResetAuthStateForTest();
  try {
    await withApp(async (baseUrl) => {
      let rejectedBody: any;

      await step(
        "pacing with incomplete env secrets → 503 not-connected, zero token POSTs",
        async () => {
          setSyntheticEnv();
          delete process.env.GOOGLE_ADS_REFRESH_TOKEN;
          __adsOsResetAuthStateForTest();
          const before = tokenHostHits;
          const { status, json } = await getPacing(baseUrl);
          assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(json)}`);
          assert.equal(json?.code, GOOGLE_ADS_DISCONNECTED_CODE);
          assert.match(
            String(json?.message),
            /rotate the GOOGLE_ADS_\* secret trio and restart/,
            "banner message carries the rotation runbook action",
          );
          assert.match(String(json?.reason), /Google Ads not connected/);
          assert.equal(tokenHostHits, before, "config check precedes any token POST");
        },
      );

      await step(
        "pacing with rejected credential → mints once, arms negative cache, rejected-phrase 503",
        async () => {
          setSyntheticEnv();
          __adsOsResetAuthStateForTest();
          const before = tokenHostHits;
          const { status, json } = await getPacing(baseUrl);
          assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(json)}`);
          assert.equal(json?.code, GOOGLE_ADS_DISCONNECTED_CODE);
          assert.match(
            String(json?.reason),
            /Google Ads credential rejected by Google/,
            "reason must carry the terminal-rejection phrase",
          );
          assert.match(
            String(json?.lastError ?? ""),
            /HTTP 400/,
            "lastError carries the negative-cache detail",
          );
          assert.equal(tokenHostHits, before + 1, "exactly one arming POST");
          rejectedBody = json;
        },
      );

      await step(
        "second call (negative cache armed) → same structured 503, NO new token POST",
        async () => {
          const before = tokenHostHits;
          const { status, json } = await getPacing(baseUrl);
          assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(json)}`);
          assert.equal(json?.code, GOOGLE_ADS_DISCONNECTED_CODE);
          assert.match(String(json?.reason), /Google Ads credential rejected by Google/);
          assert.equal(tokenHostHits, before, "dead credential must not be re-POSTed per request");
        },
      );

      await step(
        "client parser round-trips the exact apiRequest error string",
        async () => {
          assert.ok(rejectedBody, "step 2 must have captured the 503 body");
          const clientError = new Error(`503: ${JSON.stringify(rejectedBody)}`);
          const parsed = parseGoogleAdsDisconnectedError(clientError);
          assert.ok(parsed, "parser must recognize the server's 503 body");
          assert.equal(parsed.code, GOOGLE_ADS_DISCONNECTED_CODE);
          assert.match(String(parsed.lastError ?? ""), /HTTP 400/);
          assert.match(parsed.reason, /Google Ads credential rejected by Google/);
          assert.match(
            parsed.message,
            /rotate the GOOGLE_ADS_\* secret trio and restart/,
          );
        },
      );
    });

    await step("parser rejects non-disconnect errors (generic 500 / plain 503 / non-Error)", async () => {
      assert.equal(
        parseGoogleAdsDisconnectedError(new Error("500: {\"error\":\"boom\"}")),
        null,
      );
      assert.equal(
        parseGoogleAdsDisconnectedError(new Error("503: {\"error\":\"maintenance\"}")),
        null,
      );
      assert.equal(
        parseGoogleAdsDisconnectedError(new Error("503: not json google_ads_disconnected")),
        null,
      );
      assert.equal(parseGoogleAdsDisconnectedError("503: string"), null);
      assert.equal(parseGoogleAdsDisconnectedError(undefined), null);
    });

    await step("classifier: the two terminal phrases in, transient errors out", async () => {
      assert.equal(
        isGoogleAdsAuthDeadError(
          new Error("Google Ads not connected — the GOOGLE_ADS_* env secrets are incomplete (see GOOGLE_ADS.md)"),
        ),
        true,
      );
      assert.equal(
        isGoogleAdsAuthDeadError(
          new Error(
            "Google Ads credential rejected by Google: HTTP 400: invalid_grant — rotate the GOOGLE_ADS_* secret trio and restart (see GOOGLE_ADS.md)",
          ),
        ),
        true,
      );
      // Transient mint/network/GAQL failures must NOT render as
      // rotate-your-secrets — they retry on the next call.
      assert.equal(isGoogleAdsAuthDeadError(new Error("fetch failed: socket hang up")), false);
      assert.equal(
        isGoogleAdsAuthDeadError(new Error("OAuth token exchange failed: HTTP 503")),
        false,
      );
      assert.equal(isGoogleAdsAuthDeadError(new Error("GAQL request failed: 500")), false);
      assert.equal(isGoogleAdsAuthDeadError("Google Ads not connected"), false);
    });

    await step("respondGoogleAdsDisconnected returns false untouched for non-auth-dead errors", async () => {
      let touched = false;
      const fakeRes = {
        status() {
          touched = true;
          return this;
        },
        json() {
          touched = true;
          return this;
        },
      } as any;
      const handled = respondGoogleAdsDisconnected(fakeRes, new Error("GAQL request failed: 500"));
      assert.equal(handled, false);
      assert.equal(touched, false, "response must not be written for generic errors");
    });
  } finally {
    restoreStubs();
  }

  if (failures > 0) {
    console.error(`\n${failures} step(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nAll steps passed");
  }

  // Route tests that fetch a local server hang on exit unless undici's
  // keep-alive sockets are closed (see add-stale-location-route.test.ts).
  await undici.getGlobalDispatcher().close();
  await closeDbPools();
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
  try {
    restoreStubs();
    await undici.getGlobalDispatcher().close();
    await closeDbPools();
  } catch {}
});
