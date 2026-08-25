/* test-registration
{
  "name": "Google Ads status carries the env-credential lane, no token POSTs on status reads (Task #4000/#4008)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4008: the env-trio lane is THE Google Ads credential story (single-credential model). The server contract is (1) /api/integrations/all-status always carries the adsOs lane summary and derives `connected` from it, degrading to null (never false) on a lane blip, and (2) building the lane NEVER POSTs to Google's token endpoint (lane health is stored/cached state only; a status poll that minted tokens would hammer oauth2.googleapis.com every 5s per admin viewer). Fast: one local express server, stubbed external fetch, hermetic DB.",
  "tier": "small"
}
test-registration */
/**
 * Task #4000 (re-based by Task #4008) — the Integrations Hub Google Ads card
 * shows ONE credential lane: the env trio that powers every Google Ads
 * surface. This suite covers the server half:
 *
 *   1. `buildGoogleAdsOsLaneSummary()` classifies the lane from env presence
 *      + the shared client's in-memory cached/negative-cached auth state +
 *      store freshness — with ZERO fetches to the Google OAuth token host.
 *   2. `GET /api/integrations/all-status` carries the slim googleAds shape
 *      `{ configured, connected, loginCustomerId, adsOs }` where `connected`
 *      is DERIVED from the lane (configured && health !== token_rejected),
 *      and degrades `connected`/`adsOs` to null on a lane-build blip —
 *      never a hard false.
 *   3. A terminal 4xx from a REAL mint (armed outside the status path)
 *      surfaces as health=token_rejected + connected:false on the next
 *      status read — still without any new token POST from the status path
 *      itself.
 *
 * Token-endpoint accounting filters to the Google OAuth host specifically
 * (oauth2.googleapis.com) so unrelated stubbed traffic (Upstash, Front,
 * Zoom probes) can never mask or inflate the count.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response as ExpressResponse } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { sql } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import { __resetIntegrationStatusCacheForTest } from "../server/services/integrationStatusCache";
import {
  buildGoogleAdsOsLaneSummary,
  __resetGoogleAdsOsLaneMemoForTest,
  __setGoogleAdsOsLaneOverrideForTest,
} from "../server/services/integrationStatusLoaders";
import {
  __adsOsResetAuthStateForTest,
  getAdsOsClientAuthSnapshot,
  listMccAccounts,
} from "../server/services/adsOs/googleAdsClient";
import { putAlerts } from "../server/services/adsOs/store";

const TAG = "task-4000";
const AM_ID = `${TAG}-am-${Date.now()}`;
const ALERT_CID = `9${String(Date.now()).slice(-8)}`; // digits-only per store key convention

// ---------------------------------------------------------------------------
// Env pinning — the suite runs with synthetic Google Ads secrets and restores
// the originals in finally (batched runner shares one process; a leaked env
// edit poisons sibling suites).
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
// Fetch stub — counts Google OAuth token-host hits specifically; everything
// external answers benign 503, Upstash passes through, loopback is real.
// ---------------------------------------------------------------------------
const { isUpstashRedisUrl: __isUpstashRedisUrl, makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse } =
  await import("./helpers/upstashFetchStub");

let tokenHostHits = 0;
// When set, the token host answers with this instead of the benign 503 —
// used ONCE to arm the negative cache via a real terminal 4xx mint.
let tokenResponder: (() => Response) | null = null;

const originalFetch: typeof fetch = global.fetch;
global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url = typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.includes("oauth2.googleapis.com")) {
    tokenHostHits++;
    if (tokenResponder) return tokenResponder();
    return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
  }
  if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
    return originalFetch(input as any, init);
  }
  return new Response(`unavailable (${TAG} stub)`, { status: 503 });
}) as any;

// ---------------------------------------------------------------------------
// Harness (pattern: tests/integrations-all-status-settings-read-blip.test.ts)
// ---------------------------------------------------------------------------
async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task4000 AM"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}
async function cleanupRows(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM users WHERE id = ${AM_ID}`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM ads_os_account_alerts WHERE key = ${`ads:${ALERT_CID}`}`);
  } catch {}
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: ExpressResponse, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): authenticate as AM_ID.
    (req as any).__test_clerkUserId = AM_ID;
    next();
  });
  registerIntegrationRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function resetLaneState(): void {
  __adsOsResetAuthStateForTest();
  __resetGoogleAdsOsLaneMemoForTest();
  __resetIntegrationStatusCacheForTest();
}

let passed = 0;
let failed = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  }
}

async function main(): Promise<void> {
  console.log("Google Ads status — Ads OS env-credential lane (Task #4000)");

  await ensureUser();
  setSyntheticEnv();
  const { server, baseUrl } = await listen(buildApp());

  const getAllStatus = async (): Promise<any> => {
    const r = await fetch(`${baseUrl}/api/integrations/all-status`);
    assert.equal(r.status, 200, `all-status must answer 200, got ${r.status}`);
    return r.json();
  };

  try {
    await step("cold configured lane → health=unknown, source=env, ZERO token-host fetches", async () => {
      resetLaneState();
      const before = tokenHostHits;
      const lane = await buildGoogleAdsOsLaneSummary();
      assert.equal(lane.configured, true, "env trio present → configured");
      assert.equal(lane.refreshTokenSource, "env");
      assert.equal(
        lane.health,
        "unknown",
        `cold process (no cached mint, no rejection) is UNKNOWN, never fabricated healthy/dead — got ${lane.health}`,
      );
      assert.equal(lane.healthDetail, null);
      assert.equal(
        tokenHostHits,
        before,
        `lane build must not POST to the Google OAuth host (got ${tokenHostHits - before} hit(s))`,
      );
    });

    await step("all-status carries the slim shape + lane; the poll makes ZERO token-host fetches", async () => {
      resetLaneState();
      const before = tokenHostHits;
      const body = await getAllStatus();
      const g = body?.googleAds;
      assert.ok(g && typeof g === "object", "googleAds payload present");
      // Task #4008 slim shape: configured/connected/loginCustomerId/adsOs.
      assert.equal(g.configured, true, "env trio present → configured");
      assert.equal(
        g.connected,
        true,
        "connected derives from the lane (configured && !token_rejected); unknown health is still connected",
      );
      assert.equal(g.loginCustomerId, "1234567890");
      const a = g.adsOs;
      assert.ok(a && typeof a === "object", "adsOs lane present in the payload");
      assert.equal(a.refreshTokenSource, "env");
      assert.equal(a.health, "unknown");
      assert.equal(typeof a.configured, "boolean");
      assert.ok("lastDataUpdateAt" in a, "adsOs carries the freshness field");
      assert.equal(
        tokenHostHits,
        before,
        `the status poll must not POST to the Google OAuth host (got ${tokenHostHits - before} hit(s))`,
      );
    });

    await step("real terminal 4xx mint (outside status path) → token_rejected on next read, still zero status-path token POSTs", async () => {
      resetLaneState();
      // Arm the negative cache through the REAL mint path: one deliberate
      // 400 invalid_grant from the token endpoint.
      tokenResponder = () =>
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      const beforeArm = tokenHostHits;
      let mintErr: any = null;
      await listMccAccounts().catch((err: any) => {
        mintErr = err;
      });
      tokenResponder = null;
      assert.ok(mintErr, "the arming mint must throw");
      assert.equal(tokenHostHits, beforeArm + 1, "the arming mint POSTs exactly once");
      const snap = getAdsOsClientAuthSnapshot();
      assert.equal(snap.authDead, true, "negative cache armed");

      __resetGoogleAdsOsLaneMemoForTest();
      __resetIntegrationStatusCacheForTest();
      const beforeRead = tokenHostHits;
      const body = await getAllStatus();
      const g = body?.googleAds;
      const a = g?.adsOs;
      assert.equal(a?.health, "token_rejected", `armed rejection surfaces — got ${a?.health}`);
      assert.match(String(a?.healthDetail ?? ""), /HTTP 400/, "healthDetail names the terminal HTTP status");
      assert.equal(
        g?.connected,
        false,
        "a terminal rejection flips the card's connected to a CONFIRMED false (single credential = whole integration down)",
      );
      assert.equal(
        tokenHostHits,
        beforeRead,
        `status read after a dead token must NOT re-POST (negative cache is the whole point) — got ${tokenHostHits - beforeRead} hit(s)`,
      );
    });

    await step("refresh token absent → not_configured / source=none", async () => {
      resetLaneState();
      delete process.env.GOOGLE_ADS_REFRESH_TOKEN;
      try {
        const lane = await buildGoogleAdsOsLaneSummary();
        assert.equal(lane.configured, false);
        assert.equal(lane.refreshTokenSource, "none");
        assert.equal(lane.health, "not_configured");
      } finally {
        process.env.GOOGLE_ADS_REFRESH_TOKEN = `${TAG}-refresh-token`;
      }
    });

    await step("a Google-pull store write surfaces as lastDataUpdateAt", async () => {
      resetLaneState();
      const before = Date.now() - 60_000; // slack for DB clock skew
      await putAlerts("ads", ALERT_CID, { armed: true, tag: TAG });
      __resetGoogleAdsOsLaneMemoForTest();
      const lane = await buildGoogleAdsOsLaneSummary();
      assert.ok(lane.lastDataUpdateAt, "freshness present after a pull-table write");
      const ts = new Date(lane.lastDataUpdateAt!).getTime();
      assert.ok(
        Number.isFinite(ts) && ts >= before,
        `freshness reflects the write (got ${lane.lastDataUpdateAt}, floor ${new Date(before).toISOString()})`,
      );
    });

    await step("lane-build blip → adsOs null + connected null (never a hard false), poll still 200", async () => {
      resetLaneState();
      // Task #4008 — the all-status route degrades a THROWN lane build to
      // null (card shows "Checking…"); a transient blip must never render
      // a confirmed Not-Connected (credential-detection absent-vs-unknown
      // contract).
      __setGoogleAdsOsLaneOverrideForTest(async () => {
        throw new Error("simulated lane read outage");
      });
      try {
        const body = await getAllStatus();
        const g = body?.googleAds;
        assert.ok(g && typeof g === "object", "googleAds payload present");
        assert.equal(g.configured, true, "configured stays env truth (cannot blip)");
        assert.equal(g.connected, null, "connected degrades to UNKNOWN null, never false");
        assert.equal(g.adsOs, null, "lane degrades to null");
      } finally {
        __setGoogleAdsOsLaneOverrideForTest(null);
      }
    });
  } finally {
    __setGoogleAdsOsLaneOverrideForTest(null);
    tokenResponder = null;
    restoreEnv();
    __adsOsResetAuthStateForTest();
    __resetGoogleAdsOsLaneMemoForTest();
    __resetIntegrationStatusCacheForTest();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanupRows();
    global.fetch = originalFetch;
    // Route tests that fetch a local server hang on exit unless undici's
    // keep-alive sockets are closed.
    await undici.getGlobalDispatcher().close();
    await closeDbPools();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error("Test runner failed:", err?.message ?? err);
  if (err?.stack) console.error(err.stack);
  process.exitCode = 1;
  try {
    __setGoogleAdsOsLaneOverrideForTest(null);
    restoreEnv();
    global.fetch = originalFetch;
    await undici.getGlobalDispatcher().close();
    await closeDbPools();
  } catch {}
});
