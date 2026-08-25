/* test-registration
{
  "name": "Google Ads discover/sync-now disconnected → same structured 503 (Task #2797)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2797 (re-based by Task #4008 onto the env-credential model): the Integrations Hub's Google Ads discover / sync-now routes reuse the same disconnect contract. Discover throws straight through the token accessor, but sync-now depends on the `googleAdsSyncSkipAuthDeadError` reason→phrase mapping (runGoogleAdsSync RETURNS a skipped summary instead of throwing). Gate this so a skip-reason rename in googleAdsSync.ts or a phrase-family drift silently reverting sync-now to \"Synced 0 customer(s)\" fails fast.",
  "tier": "small"
}
test-registration */
/**
 * Task #2797 (re-based by Task #4008) — the Google Ads admin surfaces
 * (Integrations Hub's discover / sync-now routes in
 * server/routes/googleAds.ts) reuse the Task #2794 structured-503 disconnect
 * contract instead of generic 500s. Under the unified env-credential model:
 *
 *   1. Discover with the env secrets INCOMPLETE → structured
 *      `503 { code: "google_ads_disconnected", reason: /not connected/ }`,
 *      with ZERO POSTs to Google's token endpoint (config check is first).
 *   2. Discover with a terminally-rejected credential: the FIRST call mints
 *      once (real 400 invalid_grant from the stubbed token endpoint) and
 *      arms the shared negative cache; the SECOND call short-circuits on
 *      the pre-mint auth-dead check — same structured 503, no new POST.
 *   3. `googleAdsSyncSkipAuthDeadError` — `runGoogleAdsSync` returns
 *      `{ skipped, reason }` instead of throwing on a dead credential, so
 *      the sync-now route maps BOTH credential-level skip reasons
 *      (`not_configured`, `env_token_rejected`) onto the auth-dead phrase
 *      family (both are fixed by editing the GOOGLE_ADS_* secrets). The
 *      non-credential skip reasons (`overlap`, kill switches) must map to
 *      null so they keep the plain summary response.
 *   4. Composition: `respondGoogleAdsDisconnected(res, mapped)` writes the
 *      structured 503 payload with `lastError` enriched from the shared
 *      mint's negative-cache snapshot (display-only memory read).
 *
 * Isolation: credential state is process-local (env vars + the shared
 * mint's in-memory auth state, reset via `__adsOsResetAuthStateForTest`);
 * the token endpoint is a fetch stub. No DB rows are read or written on
 * these paths (the mint fails before any customer walk).
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
import { registerGoogleAdsRoutes } from "../server/routes/googleAds";
import {
  googleAdsSyncSkipAuthDeadError,
  isGoogleAdsAuthDeadError,
  respondGoogleAdsDisconnected,
} from "../server/routes/googleAdsDisconnected";
import { __adsOsResetAuthStateForTest } from "../server/services/adsOs/googleAdsClient";
import { GOOGLE_ADS_DISCONNECTED_CODE } from "../shared/googleAdsDisconnect";

const TAG = "task-2797";
const USER_ID = "gads-2797-ceo";

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
  process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "1234567890";
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
          email: "gads-2797@test.local",
          firstName: "Ads",
          lastName: "Routes",
          role: "ceo",
        }
      : undefined;
  // storage.getUser is stubbed but requireAuth resolves identity via the
  // ambient PUBLIC-schema db (no seeded row here). Pre-register the profile so
  // requireAuth uses it directly (no JIT-provisioning litter / comms auto-join).
  __test_markUserReconciled(USER_ID, {
    id: USER_ID,
    email: "gads-2797@test.local",
    firstName: "Ads",
    lastName: "Routes",
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
  registerGoogleAdsRoutes(app);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postDiscover(baseUrl: string): Promise<{ status: number; json: any }> {
  const r = await fetch(
    `${baseUrl}/api/integrations/google-ads/customers/discover`,
    { method: "POST" },
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
  console.log("Google Ads routes disconnected 503 contract (Task #2797/#4008)");

  installStubs();
  __adsOsResetAuthStateForTest();
  try {
    await withApp(async (baseUrl) => {
      await step(
        "discover with incomplete env secrets → 503 not-connected, ZERO token POSTs",
        async () => {
          setSyntheticEnv();
          delete process.env.GOOGLE_ADS_REFRESH_TOKEN;
          __adsOsResetAuthStateForTest();
          const before = tokenHostHits;
          const { status, json } = await postDiscover(baseUrl);
          assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(json)}`);
          assert.equal(json?.code, GOOGLE_ADS_DISCONNECTED_CODE);
          assert.match(
            String(json?.message),
            /rotate the GOOGLE_ADS_\* secret trio and restart/,
            "message carries the rotation runbook action",
          );
          assert.match(
            String(json?.reason),
            /Google Ads not connected/,
            "reason must carry the not-connected phrase (env secrets incomplete)",
          );
          assert.equal(json?.lastError, null, "no negative-cache detail before any mint");
          assert.equal(tokenHostHits, before, "config check happens BEFORE any token POST");
        },
      );

      await step(
        "discover with rejected credential → mints ONCE, arms the negative cache, structured 503",
        async () => {
          setSyntheticEnv();
          __adsOsResetAuthStateForTest();
          const before = tokenHostHits;
          const { status, json } = await postDiscover(baseUrl);
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
            "lastError carries the negative-cache detail (HTTP status from the terminal mint)",
          );
          assert.equal(tokenHostHits, before + 1, "exactly one arming POST");
        },
      );

      await step(
        "second discover (negative cache armed) → same structured 503, NO new token POST",
        async () => {
          const before = tokenHostHits;
          const { status, json } = await postDiscover(baseUrl);
          assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(json)}`);
          assert.equal(json?.code, GOOGLE_ADS_DISCONNECTED_CODE);
          assert.match(
            String(json?.reason),
            /Google Ads credential rejected by Google/,
            "pre-mint auth-dead short-circuit must map to the same structured 503",
          );
          assert.equal(
            tokenHostHits,
            before,
            "a dead credential must NOT be re-POSTed per request (negative cache is the whole point)",
          );
        },
      );
    });

    await step(
      "sync-skip mapping: not_configured / env_token_rejected → classifier-recognized errors; other reasons → null",
      async () => {
        // (negative cache still armed from the steps above — env_token_rejected
        // enriches from it, but the mapping must work regardless.)
        const notConfigured = googleAdsSyncSkipAuthDeadError("not_configured");
        assert.ok(notConfigured, "not_configured must map to an error (secrets edit fixes it)");
        assert.equal(isGoogleAdsAuthDeadError(notConfigured), true);
        assert.match(String(notConfigured?.message), /Google Ads not connected/);

        const rejected = googleAdsSyncSkipAuthDeadError("env_token_rejected");
        assert.ok(rejected, "env_token_rejected must map to an error");
        assert.equal(isGoogleAdsAuthDeadError(rejected), true);
        assert.match(String(rejected?.message), /Google Ads credential rejected by Google/);

        // Editing secrets would NOT fix these — they must keep the plain
        // summary response (no disconnect banner).
        for (const reason of [
          "overlap",
          "google_ads_sync_disabled",
          "non_critical_sweeps",
          undefined,
        ]) {
          assert.equal(
            googleAdsSyncSkipAuthDeadError(reason),
            null,
            `reason ${String(reason)} must not map to a disconnect`,
          );
        }
      },
    );

    await step(
      "composition: respondGoogleAdsDisconnected(mapped env_token_rejected) writes the structured 503",
      async () => {
        let statusCode = 0;
        let body: any = null;
        const fakeRes = {
          status(code: number) {
            statusCode = code;
            return this;
          },
          json(payload: any) {
            body = payload;
            return this;
          },
        } as any;
        const handled = respondGoogleAdsDisconnected(
          fakeRes,
          googleAdsSyncSkipAuthDeadError("env_token_rejected"),
        );
        assert.equal(handled, true);
        assert.equal(statusCode, 503);
        assert.equal(body?.code, GOOGLE_ADS_DISCONNECTED_CODE);
        assert.match(String(body?.reason), /Google Ads credential rejected by Google/);
        assert.match(
          String(body?.lastError ?? ""),
          /HTTP 400/,
          "lastError enriched from the armed negative-cache snapshot",
        );

        // Transient errors must fall through (never the rotate-secrets 503).
        const transient = respondGoogleAdsDisconnected(
          fakeRes,
          new Error("fetch failed: socket hang up"),
        );
        assert.equal(transient, false, "transient errors are NOT auth-dead");
      },
    );
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
