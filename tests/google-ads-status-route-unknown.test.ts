/* test-registration
{
  "name": "Google Ads status route read-threw → status-unknown 503, never configured:false (Task #2807)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2807: the status route's catch-all used to answer a hard `configured: false` on ANY error, so a transient blip rendered the integration as unconfigured. The read-threw branch must stay an explicit status-unknown 503 (confirmed-state vs couldn't-determine). Task #4008 moved the throwable read from the connection row to the env-credential lane build; the contract is unchanged. Fast, in-memory lane override — no live DB dependency. Gate it so a catch-block \"simplification\" can't silently reintroduce the false not-configured flash.",
  "tier": "small"
}
test-registration */
/**
 * Task #2807 (re-based onto the Task #4008 env-credential model) — a THROWN
 * read inside GET /api/integrations/google-ads/status must surface as an
 * explicit status-unknown 503, never a hard `configured: false`.
 *
 * The old catch-all answered `{ configured: false, connected: false }` on
 * ANY error — including a transient read failure — momentarily rendering a
 * healthy integration as unconfigured. The project contract
 * (`.agents/memory/credential-detection-absent-vs-unknown.md`) is that
 * confirmed state and read-threw are DIFFERENT outcomes:
 *
 *   1. lane build THREW (DB blip in the freshness read path, etc.) → 503
 *      `{ statusUnknown: true, probeFailed: true, configured: <env truth>,
 *      connected: null, reason }` — `configured` stays truthful (env-only
 *      check cannot throw) and `connected` is null (unknown), never false.
 *   2. lane build SUCCEEDED → the normal 200 slim shape
 *      `{ configured, connected, loginCustomerId, adsOs }`, where
 *      `connected = configured && health !== "token_rejected"`.
 *
 * Isolation: `__setGoogleAdsOsLaneOverrideForTest` replaces the lane build
 * wholesale (throw or canned summary), so no live DB outage is needed and
 * no shared state is touched. No network call to Google ever happens on
 * this path (Task #4000 invariant — status never POSTs to the token
 * endpoint).
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import * as undici from "undici";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

// Pin the env secrets BEFORE importing the routes so `isGoogleAdsConfigured()`
// is definitively true — the point of the test is that a transient blip must
// not override that truth with `configured: false`.
process.env.GOOGLE_ADS_CLIENT_ID =
  process.env.GOOGLE_ADS_CLIENT_ID || "test_gads_client_id";
process.env.GOOGLE_ADS_CLIENT_SECRET =
  process.env.GOOGLE_ADS_CLIENT_SECRET || "test_gads_client_secret";
process.env.GOOGLE_ADS_REFRESH_TOKEN =
  process.env.GOOGLE_ADS_REFRESH_TOKEN || "test_gads_refresh_token";
process.env.GOOGLE_ADS_DEVELOPER_TOKEN =
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "test_gads_dev_token";
// Pin UNCONDITIONALLY — the dev/gate environment carries the real secret,
// and the loginCustomerId assertion below must see this synthetic value.
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "1234567890";

import { storage } from "../server/storage";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { closeDbPools } from "../server/db";
import { registerGoogleAdsRoutes } from "../server/routes/googleAds";
import {
  __setGoogleAdsOsLaneOverrideForTest,
  type GoogleAdsOsLaneSummary,
} from "../server/services/integrationStatusLoaders";

const USER_ID = "gads-2807-admin";

const s = storage as any;
const originalGetUser = s.getUser;

function installStubs(): void {
  s.getUser = async (id: string) =>
    id === USER_ID
      ? {
          id: USER_ID,
          email: "gads-2807@test.local",
          firstName: "Status",
          lastName: "Unknown",
          role: "ceo",
        }
      : undefined;
  // storage.getUser is stubbed but requireAuth resolves identity via the
  // ambient PUBLIC-schema db (no seeded row here). Pre-register the profile so
  // requireAuth uses it directly (no JIT-provisioning litter / comms auto-join).
  __test_markUserReconciled(USER_ID, {
    id: USER_ID,
    email: "gads-2807@test.local",
    firstName: "Status",
    lastName: "Unknown",
    role: "ceo",
  });
}

function restoreStubs(): void {
  s.getUser = originalGetUser;
  __setGoogleAdsOsLaneOverrideForTest(null);
  __test_resetReconciledUsers();
}

function healthyLane(): GoogleAdsOsLaneSummary {
  return {
    configured: true,
    refreshTokenSource: "env",
    health: "healthy",
    healthDetail: null,
    lastDataUpdateAt: "2026-08-07T10:00:00.000Z",
  };
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

async function getStatus(baseUrl: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}/api/integrations/google-ads/status`);
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
  console.log("Google Ads status route — read-threw ≠ not configured (Task #2807/#4008)");

  installStubs();
  try {
    await withApp(async (baseUrl) => {
      await step(
        "thrown lane build → 503 status-unknown; configured stays TRUE, connected null — never a hard configured:false",
        async () => {
          __setGoogleAdsOsLaneOverrideForTest(async () => {
            throw new Error("simulated transient lane read failure (pool saturation)");
          });
          const { status, json } = await getStatus(baseUrl);
          assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(json)}`);
          assert.equal(json?.statusUnknown, true, "must be an explicit status-unknown shape");
          assert.equal(json?.probeFailed, true);
          assert.equal(
            json?.configured,
            true,
            "configured is answered from env (cannot throw) and must NOT be flipped false by a transient blip",
          );
          assert.equal(json?.connected, null, "connected is UNKNOWN (null), not false");
          assert.match(
            String(json?.reason),
            /simulated transient lane read failure/,
            "reason must carry the underlying read error for operator debugging",
          );
        },
      );

      await step(
        "healthy lane → normal 200 slim shape { configured, connected, loginCustomerId, adsOs }",
        async () => {
          __setGoogleAdsOsLaneOverrideForTest(async () => healthyLane());
          const { status, json } = await getStatus(baseUrl);
          assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
          assert.equal(json?.configured, true);
          assert.equal(json?.connected, true);
          assert.equal(json?.loginCustomerId, "1234567890");
          assert.equal(json?.adsOs?.health, "healthy");
          assert.equal(json?.statusUnknown, undefined, "success is NOT status-unknown");
        },
      );

      await step(
        "token_rejected lane → 200 with connected:false (terminal rejection is a CONFIRMED state, not unknown)",
        async () => {
          __setGoogleAdsOsLaneOverrideForTest(async () => ({
            ...healthyLane(),
            health: "token_rejected",
            healthDetail: "HTTP 400: invalid_grant",
          }));
          const { status, json } = await getStatus(baseUrl);
          assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
          assert.equal(json?.configured, true);
          assert.equal(json?.connected, false, "terminal rejection renders connected:false");
          assert.equal(json?.adsOs?.health, "token_rejected");
          assert.equal(json?.adsOs?.healthDetail, "HTTP 400: invalid_grant");
          assert.equal(json?.statusUnknown, undefined);
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
