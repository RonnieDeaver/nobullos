/* test-registration
{
  "name": "all-status settings-read blip degrades to 200/unknown, never 500 (Task #2830)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2830: the AGGREGATE half of the status-unknown contract. Server side: a thrown settings/reconcile read inside /api/integrations/all-status must degrade to 200 with unknown (null) statuses — the pre-#2830 500 made the Hub present EVERY integration as broken during a DB blip. Client side: a status-unknown 503 from all-status renders the neutral banner + \"Checking…\" badges (no false Not Connected / Connect CTA), while a genuine 200 connected:false still renders Not Connected. Both fast and deterministic; the server test monkey-patches the storage singleton (no live outage), the client test is a DB-free jsdom render with fetch fully stubbed.",
  "tier": "small"
}
test-registration */
/**
 * Task #2830 — a transient DB blip in `GET /api/integrations/all-status`'s
 * request-thread settings reads (the LastEdited credential-metadata block
 * and the breaker/gate store reconciles) must NOT 500 the whole aggregate
 * poll. A 500 made the Integrations Hub momentarily present EVERY
 * integration as broken (generic "Request failed" toast + no fresh data).
 *
 * Contract (extends Task #2811's absent-vs-unknown split to the aggregate
 * route):
 *   1. Settings/reconcile reads THROW → route still answers 200 with the
 *      outcome-aware probe-cache statuses; `connected` stays null (unknown)
 *      on a cold cache — never a committed `false` off a thrown read. The
 *      LastEdited badges simply degrade (null) for that poll.
 *   2. Settings reads SUCCEED with no credential (confirmed empty) → the
 *      normal 200 shape, no `statusUnknown` marker — genuine disconnects
 *      keep rendering.
 *
 * (The route's outer catch now answers the Task #2811
 * `503 { statusUnknown: true, probeFailed: true, reason }` contract as a
 * last resort; the Hub-side neutral rendering for that shape is covered by
 * tests/client/integrations-hub-all-status-unknown.test.tsx.)
 *
 * Isolation: the blip is simulated by monkey-patching the shared `storage`
 * singleton's `getSystemSettings` / `getSystemSetting` (the same seam as
 * tests/integration-status-routes-unknown.test.ts). No live DB outage
 * needed; no shared rows mutated.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { sql } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, closeDbPools } from "../server/db";
import { storage } from "../server/storage";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import { __resetIntegrationStatusCacheForTest } from "../server/services/integrationStatusCache";

const TAG = "task-2830";
const AM_ID = `${TAG}-am`;

// Task #4008 — pin the Google Ads env trio (+ the two API-side secrets) so
// the env-derived googleAds lane is deterministically "configured" in this
// suite regardless of the runner's real environment, and clear any terminal
// negative-cache state a sibling suite in the same batch process may have
// armed. No network risk: all-status never POSTs to Google, and non-loopback
// fetch is stubbed to 503 below anyway.
const GADS_ENV_KEYS = [
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
] as const;
const gadsEnvSnapshot: Record<string, string | undefined> = {};
for (const k of GADS_ENV_KEYS) {
  gadsEnvSnapshot[k] = process.env[k];
  process.env[k] = process.env[k] || `${TAG}-fake-${k.toLowerCase()}`;
}
const { __adsOsResetAuthStateForTest } = await import("../server/services/adsOs/googleAdsClient");
const { __resetGoogleAdsOsLaneMemoForTest } = await import(
  "../server/services/integrationStatusLoaders"
);
__adsOsResetAuthStateForTest();
__resetGoogleAdsOsLaneMemoForTest();
function restoreGadsEnv(): void {
  for (const k of GADS_ENV_KEYS) {
    if (gadsEnvSnapshot[k] === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = gadsEnvSnapshot[k];
  }
}

const s = storage as any;
const originalGetSystemSettings = s.getSystemSettings;
const originalGetSystemSetting = s.getSystemSetting;

const { isUpstashRedisUrl: __isUpstashRedisUrl, makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse } =
  await import("./helpers/upstashFetchStub");

// Keep background probes from hitting real providers: everything external
// answers a benign 503 (probe_failed → preserve/null), Upstash passes
// through, and only loopback traffic reaches the real fetch.
const originalFetch: typeof fetch = global.fetch;
global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url = typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
    return originalFetch(input as any, init);
  }
  return new Response("unavailable (task-2830 stub)", { status: 503 });
}) as any;

function seedThrowingReads(): void {
  const boom = async () => {
    throw new Error("simulated transient DB read failure (pool saturation)");
  };
  s.getSystemSettings = boom;
  s.getSystemSetting = boom;
}

function seedConfirmedEmptyReads(): void {
  s.getSystemSettings = async () => ({});
  s.getSystemSetting = async () => undefined;
}

function restoreReads(): void {
  s.getSystemSettings = originalGetSystemSettings;
  s.getSystemSetting = originalGetSystemSetting;
}

async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task2830 AM"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanupUser(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM users WHERE id = ${AM_ID}`);
  } catch {}
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; requireAuth resolves the seeded users
    // row and populates the legacy req.user.claims.sub shape itself.
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

// googleAds left this list with Task #4008: its status derives from env
// presence + the env-trio mint's process-local auth snapshot — no settings
// read on the path, so a DB blip does NOT make it unknown. It is asserted
// separately below (present, and never a false "disconnected" off a blip).
const CONNECTED_FIELDS: Array<{ key: string; field: string }> = [
  { key: "front", field: "connected" },
  { key: "slack", field: "connected" },
  { key: "zoom", field: "connected" },
  { key: "pandadoc", field: "connected" },
  { key: "stripe", field: "connected" },
  { key: "semrush", field: "connected" },
];

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  __resetIntegrationStatusCacheForTest();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  } finally {
    restoreReads();
    __resetIntegrationStatusCacheForTest();
  }
}

async function main(): Promise<void> {
  console.log("all-status settings-read blip resilience (Task #2830)");

  await ensureUser();
  const { server, baseUrl } = await listen(buildApp());

  try {
    await step(
      "thrown settings reads → 200 with unknown (null) statuses — never a 500, never a committed false",
      async () => {
        seedThrowingReads();
        const r = await fetch(`${baseUrl}/api/integrations/all-status`);
        const body: any = await r.json().catch(() => null);
        assert.equal(
          r.status,
          200,
          `aggregate poll must degrade, not fail: expected 200, got ${r.status}: ${JSON.stringify(body).slice(0, 300)}`,
        );
        assert.ok(body, "body must parse as JSON");
        assert.equal(body.statusUnknown, undefined, "a degraded 200 is not the status-unknown shape");
        for (const { key, field } of CONNECTED_FIELDS) {
          assert.notEqual(
            body?.[key]?.[field],
            false,
            `${key}.${field} must never be committed false off a thrown read (cold cache + blip)`,
          );
          assert.equal(
            body?.[key]?.[field],
            null,
            `${key}.${field} is UNKNOWN (null) on a cold cache during the blip (got ${body?.[key]?.[field]})`,
          );
        }
        // LastEdited credential metadata degrades to "no badge" this poll
        // (buildLastEdited off the empty degraded settings → all-null token).
        assert.equal(
          body?.front?.lastEdited?.token?.updatedBy ?? null,
          null,
          "front lastEdited badge carries no user attribution during the blip",
        );
        assert.equal(
          body?.front?.lastEdited?.token?.updatedAt ?? null,
          null,
          "front lastEdited badge carries no timestamp during the blip",
        );
        // Task #4008 — googleAds status is env-derived (no settings read on
        // its path): the block must still be present and must NOT flip to a
        // committed false because of a DB blip. With the env trio pinned
        // present, connected stays true right through the blip.
        assert.ok(body?.googleAds, "googleAds block present during the blip");
        assert.equal(
          body.googleAds.connected,
          true,
          `googleAds.connected stays env-truth (true) during a settings blip (got ${body.googleAds.connected})`,
        );
      },
    );

    await step(
      "confirmed-empty settings reads → normal 200 shape with no statusUnknown marker",
      async () => {
        seedConfirmedEmptyReads();
        const r = await fetch(`${baseUrl}/api/integrations/all-status`);
        const body: any = await r.json().catch(() => null);
        assert.equal(r.status, 200, `expected 200, got ${r.status}`);
        assert.ok(body, "body must parse as JSON");
        assert.equal(body.statusUnknown, undefined, "confirmed empty is NOT status-unknown");
        for (const { key } of CONNECTED_FIELDS) {
          assert.ok(
            body?.[key] && typeof body[key] === "object",
            `${key} payload must be present in the normal shape`,
          );
        }
      },
    );
  } finally {
    restoreReads();
    restoreGadsEnv();
    __adsOsResetAuthStateForTest();
    __resetGoogleAdsOsLaneMemoForTest();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanupUser();
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
    restoreReads();
    restoreGadsEnv();
    __adsOsResetAuthStateForTest();
    __resetGoogleAdsOsLaneMemoForTest();
    global.fetch = originalFetch;
    await undici.getGlobalDispatcher().close();
    await closeDbPools();
  } catch {}
});
