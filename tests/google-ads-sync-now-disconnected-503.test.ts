/* test-registration
{
  "name": "Google Ads sync-now disconnected → structured 503 end-to-end (Task #2805)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2805 (re-based by Task #4008 onto the env-credential model): the missing end-to-end leg of the Task #2797 contract — POST /api/integrations/google-ads/sync-now with a dead/missing credential must return the structured 503, with the route's gates (env-trio config, google_ads_sync_enabled setting, non_critical_sweeps kill switch, negative-cache rejection) pinned deterministically. Gate it so a change to the skip-reason plumbing INSIDE runGoogleAdsSync (not just the mapping helper) can't silently revert Sync Now to the \"Synced 0 customer(s)\" toast.",
  "tier": "small"
}
test-registration */
/**
 * Task #2805 (re-based by Task #4008) — end-to-end proof that the
 * Integrations Hub's "Sync Now" button shows the rotate-secrets message when
 * the Google Ads env credential is missing or rejected.
 *
 * `runGoogleAdsSync` RETURNS skipped summaries (it never throws on a dead
 * credential); the route maps the credential-level skip reasons onto the
 * shared structured-503 contract. Under the unified env-credential model the
 * credential gates are:
 *
 *   1. Env secrets incomplete → `reason: "not_configured"` → structured
 *      `503 { code: "google_ads_disconnected", reason: /not connected/ }`.
 *      (Task #4008 change: previously not_configured kept the plain
 *      summary; now a missing credential IS the disconnect story.)
 *   2. Non-auth skip (`google_ads_sync_enabled` pinned "false") → the
 *      route keeps the plain 200 summary — editing secrets would not fix
 *      it, so no disconnect banner.
 *   3. Env complete but the shared mint's negative cache is armed (real
 *      terminal 400 from the stubbed token endpoint, armed OUTSIDE the
 *      route) → `reason: "env_token_rejected"` → the same structured 503
 *      with the rejected phrase — and the sync tick makes NO token POST of
 *      its own (the whole point of the pre-flight `isConnected()` gate).
 *
 * Determinism pinning (the reason this path was previously untested):
 *   - `isGoogleAdsConfigured()` reads 5 env secrets → pinned process-local
 *     and restored.
 *   - `readKillSwitch()` reads `system_settings.google_ads_sync_enabled`
 *     through the storage singleton → `storage.getSystemSetting` is
 *     stubbed for exactly that key (mutable per-step value); all other
 *     keys delegate to the real implementation.
 *   - `isKillSwitchEnabled("non_critical_sweeps")` loads persisted
 *     overrides once via `storage.getSystemSettings` → stubbed to return
 *     `kill_switch_non_critical_sweeps: "false"`, then
 *     `ensureKillSwitchesLoaded()` is awaited BEFORE any request so the
 *     first route hit can't race the background load and pick up a value
 *     leaked into the shared dev DB (see
 *     .agents/memory/test-global-setting-leak-from-sigkill.md). No
 *     `setSystemSetting` write is made, so nothing can leak back out.
 *   - The negative cache is process-local shared-mint state, reset via
 *     `__adsOsResetAuthStateForTest` in every branch.
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { storage } from "../server/storage";
import { closeDbPools } from "../server/db";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { registerGoogleAdsRoutes } from "../server/routes/googleAds";
import { ensureKillSwitchesLoaded } from "../server/services/killSwitches";
import {
  __adsOsResetAuthStateForTest,
  getEnvAccessToken,
} from "../server/services/adsOs/googleAdsClient";
import { GOOGLE_ADS_DISCONNECTED_CODE } from "../shared/googleAdsDisconnect";

const TAG = "task-2805";
const USER_ID = "gads-2805-ceo";
const SYNC_ENABLED_KEY = "google_ads_sync_enabled";
const NON_CRITICAL_SWEEPS_ROW = "kill_switch_non_critical_sweeps";
const ENV_KEYS = [
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_ADS_REFRESH_TOKEN",
] as const;

const s = storage as any;
const originalGetUser = s.getUser;
const originalGetSystemSetting = s.getSystemSetting;
const originalGetSystemSettings = s.getSystemSettings;
const envOriginals = new Map<string, string | undefined>(
  ENV_KEYS.map((k) => [k, process.env[k]]),
);

// Mutable per-step value the getSystemSetting stub serves for the
// google_ads_sync_enabled row.
let syncEnabledValue = "true";

// ---------------------------------------------------------------------------
// Fetch stub — the Google OAuth token host answers a terminal 400 (used to
// arm the negative cache); loopback passes through; all else benign 503.
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

function setSyntheticEnv(): void {
  process.env.GOOGLE_ADS_CLIENT_ID = `${TAG}-client-id`;
  process.env.GOOGLE_ADS_CLIENT_SECRET = `${TAG}-client-secret`;
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = `${TAG}-dev-token`;
  process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "1234509876";
  process.env.GOOGLE_ADS_REFRESH_TOKEN = `${TAG}-refresh-token`;
}

function installStubs(): void {
  // Pre-register the acting user with requireAuth's test registry so the seam
  // uses the profile directly (no public-schema SELECT / JIT-insert) — the
  // user is not seeded in the DB, only stubbed on storage.getUser (which
  // requireTeamLead reads). Role ceo satisfies requireTeamLead.
  __test_markUserReconciled(USER_ID, {
    id: USER_ID,
    email: "gads-2805@test.local",
    firstName: "Sync",
    lastName: "Now",
    role: "ceo",
  });

  s.getUser = async (id: string) =>
    id === USER_ID
      ? {
          id: USER_ID,
          email: "gads-2805@test.local",
          firstName: "Sync",
          lastName: "Now",
          role: "ceo",
        }
      : undefined;

  s.getSystemSetting = async (key: string) => {
    if (key === SYNC_ENABLED_KEY) {
      return { key, value: syncEnabledValue };
    }
    return originalGetSystemSetting.call(storage, key);
  };

  // loadOverrides() (killSwitches.ts) reads every kill_switch_* row in one
  // getSystemSettings call; serve a deterministic "false" for
  // non_critical_sweeps and leave the rest at env defaults (unread here).
  s.getSystemSettings = async (keys: string[]) => {
    if (keys.includes(NON_CRITICAL_SWEEPS_ROW)) {
      return { [NON_CRITICAL_SWEEPS_ROW]: "false" };
    }
    return originalGetSystemSettings.call(storage, keys);
  };
}

function restoreStubs(): void {
  s.getUser = originalGetUser;
  s.getSystemSetting = originalGetSystemSetting;
  s.getSystemSettings = originalGetSystemSettings;
  for (const [k, v] of envOriginals) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __adsOsResetAuthStateForTest();
  global.fetch = originalFetch;
  __test_resetReconciledUsers();
}

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id. USER_ID is pre-registered in the
    // requireAuth test registry (installStubs) so requireAuth uses the
    // profile directly instead of a public-schema SELECT/JIT-insert, and
    // populates the legacy req.user.claims.sub shape itself.
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

async function postSyncNow(baseUrl: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}/api/integrations/google-ads/sync-now`, {
    method: "POST",
  });
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
  console.log("Google Ads sync-now disconnected 503 end-to-end (Task #2805/#4008)");

  installStubs();
  __adsOsResetAuthStateForTest();
  try {
    // Deterministically load the kill-switch overrides through the stub
    // BEFORE the first request; isKillSwitchEnabled's first call otherwise
    // returns the env default while the load races in the background.
    await ensureKillSwitchesLoaded();

    await withApp(async (baseUrl) => {
      await step(
        "sync-now with incomplete env secrets → 503 google_ads_disconnected + rotate-secrets message",
        async () => {
          syncEnabledValue = "true";
          setSyntheticEnv();
          delete process.env.GOOGLE_ADS_REFRESH_TOKEN;
          __adsOsResetAuthStateForTest();
          const { status, json } = await postSyncNow(baseUrl);
          assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(json)}`);
          assert.equal(json?.code, GOOGLE_ADS_DISCONNECTED_CODE);
          assert.match(
            String(json?.message),
            /rotate the GOOGLE_ADS_\* secret trio and restart/,
          );
          assert.match(
            String(json?.reason),
            /Google Ads not connected/,
            "not_configured skip must map onto the auth-dead phrase family",
          );
        },
      );

      await step(
        "non-auth skip (sync disabled) → plain 200 summary, no disconnect banner",
        async () => {
          syncEnabledValue = "false";
          setSyntheticEnv();
          __adsOsResetAuthStateForTest();
          const { status, json } = await postSyncNow(baseUrl);
          assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
          assert.equal(json?.skipped, true);
          assert.equal(json?.reason, "google_ads_sync_disabled");
          assert.equal(json?.code, undefined, "must NOT carry the disconnect code");
        },
      );

      await step(
        "negative cache armed (terminal 400 outside the route) → 503 rejected phrase, sync makes NO token POST",
        async () => {
          syncEnabledValue = "true";
          setSyntheticEnv();
          __adsOsResetAuthStateForTest();
          // Arm the shared mint's negative cache the same way a real
          // surface would: one genuine mint against the stubbed token
          // endpoint's terminal 400.
          await assert.rejects(() => getEnvAccessToken(), /OAuth token exchange failed \(400\)/);
          const before = tokenHostHits;
          const { status, json } = await postSyncNow(baseUrl);
          assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(json)}`);
          assert.equal(json?.code, GOOGLE_ADS_DISCONNECTED_CODE);
          assert.match(
            String(json?.reason),
            /Google Ads credential rejected by Google/,
            "env_token_rejected skip must map onto the rejected phrase",
          );
          assert.match(
            String(json?.lastError ?? ""),
            /HTTP 400/,
            "lastError carries the negative-cache detail",
          );
          assert.equal(
            tokenHostHits,
            before,
            "the pre-flight isConnected() gate must skip the tick WITHOUT re-POSTing the dead credential",
          );
        },
      );
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
