/* test-registration
{
  "name": "Front lastSyncError reaches all-status payload when disconnected (Task #2417)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.4s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2417 — Route-level regression: the derived Front "last error" reason must
 * reach the `GET /api/integrations/all-status` payload when the Front connection
 * BREAKS (probe outcome `unauthorized`), not only when it's connected.
 *
 * The earlier service-layer fix made `getSyncMetadata().lastError` derive a real
 * human-readable reason from the live auth-death diagnostics + auth-breaker state,
 * but the route gated that call behind `if (connected)`, so `front.lastSyncError`
 * was forced to `null` in exactly the disconnected/auth-dead state the task is
 * about. This test boots the route, drives the in-memory breaker into an auth-dead
 * state, seeds a death record, and forces the probe to `unauthorized` (by clearing
 * the stored Front tokens → `no_tokens_stored`, pinned + restored), then asserts
 * the reason reaches the JSON payload — so a future re-gating can't silently
 * suppress it again.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import { __resetIntegrationStatusCacheForTest } from "../server/services/integrationStatusCache";
import { FRONT_AUTH_DEATH_LAST_KEY } from "../server/services/frontAuthDeathDiagnostics";
import {
  __resetFrontAuthBreakerForTest,
  __clearPersistedFrontAuthBreakerForTest,
  __setFrontAuthStateForTest,
} from "../server/services/frontAuthBreaker";

const TAG = "task-2417";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const AM_ID = `${TAG}-am`;
const ACCESS_KEY = "front_access_token";
const REFRESH_KEY = "front_refresh_token";

type FrontPayload = {
  connected: boolean | null;
  lastSyncError: string | null;
  lastSyncSuccess: string | null;
  reason: string | null;
};

const originalFetch: typeof fetch = global.fetch;
const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

// Keep Upstash/Redis local; everything else falls through. With the Front tokens
// cleared, the probe returns `no_tokens_stored` before any Front HTTP, so no
// upstream Front call is involved.
global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  return originalFetch(input as any, init);
}) as any;

async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task2417 AM"})
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
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated. The
    // pre-Clerk passport-shape injection stopped working when auth migrated.
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

async function fetchFrontOnce(baseUrl: string): Promise<FrontPayload> {
  const r = await fetch(`${baseUrl}/api/integrations/all-status`);
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`all-status → ${r.status}: ${text.slice(0, 300)}`);
  }
  const body = await r.json();
  return body.front as FrontPayload;
}

// The Front `connected` / `lastSyncError` fields come from the stale-while-
// revalidate status cache: a cold cache returns `connected: null` on the first
// call and kicks a background refresh. Poll until the cache warms (connected is
// a real boolean), so the assertions see the committed probe result.
async function fetchFrontWarm(baseUrl: string): Promise<FrontPayload> {
  let last: FrontPayload | null = null;
  for (let i = 0; i < 50; i++) {
    last = await fetchFrontOnce(baseUrl);
    if (last.connected !== null) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Front status cache never warmed (connected stayed null): ${JSON.stringify(last)}`);
}

let passed = 0;
let failed = 0;

async function main(): Promise<void> {
  console.log("Integrations Hub Front lastSyncError reaches payload when disconnected (Task #2417)");

  // Pin + restore the death record AND the Front tokens we manipulate.
  const priorDeath = await storage.getSystemSetting(FRONT_AUTH_DEATH_LAST_KEY).catch(() => null);
  const priorAccess = await storage.getSystemSetting(ACCESS_KEY).catch(() => null);
  const priorRefresh = await storage.getSystemSetting(REFRESH_KEY).catch(() => null);

  await ensureUser();
  const { server, baseUrl } = await listen(buildApp());

  try {
    // Force the probe to `unauthorized` (no_tokens_stored) without any HTTP.
    await storage.deleteSystemSetting(ACCESS_KEY).catch(() => {});
    await storage.deleteSystemSetting(REFRESH_KEY).catch(() => {});

    // --- Case A: auth-dead breaker + death record → reason reaches the payload.
    __resetIntegrationStatusCacheForTest();
    __resetFrontAuthBreakerForTest();
    await __clearPersistedFrontAuthBreakerForTest();
    try {
      const now = Date.now();
      __setFrontAuthStateForTest({
        breakerOpenUntilMs: now + 5 * 60_000,
        lastTrippedAtMs: now,
        lastTrippedCode: "front_refresh_failed_permanent",
        lastSuccessAtMs: null,
        tripCount: 1,
      });
      await storage.setSystemSetting(
        FRONT_AUTH_DEATH_LAST_KEY,
        JSON.stringify({
          code: "front_refresh_failed_permanent",
          httpStatus: 401,
          bodySnippet: "invalid_grant",
          environment: "development",
          lastSuccessAt: null,
          diedAt: new Date(now).toISOString(),
        }),
        "system",
      );

      const front = await fetchFrontWarm(baseUrl);
      assert.equal(front.connected, false, "Front should report disconnected when probe is unauthorized");
      assert.ok(
        front.lastSyncError,
        "lastSyncError MUST reach the payload when Front auth is dead (not gated on connected)",
      );
      assert.ok(
        front.lastSyncError!.includes("Front rejected the saved credentials"),
        `lastSyncError should be the plain-English reason (got: ${front.lastSyncError})`,
      );
      assert.ok(
        front.lastSyncError!.includes("HTTP 401") && /reconnect/i.test(front.lastSyncError!),
        `lastSyncError should carry the HTTP status + reconnect hint (got: ${front.lastSyncError})`,
      );
      passed++;
      console.log("  ✓ auth-dead + unauthorized probe → lastSyncError reaches payload");
    } catch (err: any) {
      failed++;
      console.error(`  ✗ auth-dead case: ${err?.message ?? err}`);
      if (err?.stack) console.error(err.stack);
    }

    // --- Case B: healthy breaker (never tripped) → lastSyncError null even when
    // disconnected, so we don't show a phantom error on a clean not-connected.
    __resetIntegrationStatusCacheForTest();
    __resetFrontAuthBreakerForTest();
    await __clearPersistedFrontAuthBreakerForTest();
    await storage.deleteSystemSetting(FRONT_AUTH_DEATH_LAST_KEY).catch(() => {});
    try {
      const front = await fetchFrontWarm(baseUrl);
      assert.equal(front.connected, false, "Front should still report disconnected (no tokens)");
      assert.equal(
        front.lastSyncError,
        null,
        "lastSyncError must be null when Front never auth-died (no phantom reason)",
      );
      passed++;
      console.log("  ✓ never auth-died → lastSyncError null even when disconnected");
    } catch (err: any) {
      failed++;
      console.error(`  ✗ healthy case: ${err?.message ?? err}`);
      if (err?.stack) console.error(err.stack);
    }
  } finally {
    __resetIntegrationStatusCacheForTest();
    __resetFrontAuthBreakerForTest();
    await __clearPersistedFrontAuthBreakerForTest();
    // Restore the Front tokens and death record exactly as we found them.
    if (priorAccess?.value) await storage.setSystemSetting(ACCESS_KEY, priorAccess.value, "system");
    if (priorRefresh?.value) await storage.setSystemSetting(REFRESH_KEY, priorRefresh.value, "system");
    if (priorDeath?.value) {
      await storage.setSystemSetting(FRONT_AUTH_DEATH_LAST_KEY, priorDeath.value, "system");
    } else {
      await storage.deleteSystemSetting(FRONT_AUTH_DEATH_LAST_KEY).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanupUser();
    global.fetch = originalFetch;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; return; }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so
// the process exits on its own once work settles — no manual process.exit().
main()
  .then(() => {})
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  });
