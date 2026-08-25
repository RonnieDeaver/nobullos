/* test-registration
{
  "name": "Front derived lastSyncError reaches all-status + console/overview payloads (Task #2425)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.5s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2425 — Prove the derived Front error reason actually reaches the
 * dashboard API responses.
 *
 * Task #2417 made `getSyncMetadata().lastError` derive a real, human-readable
 * reason from the live auth-death diagnostics + auth-breaker state, and added
 * unit coverage for the derivation (tests/front-sync-metadata-last-error.test.ts).
 * But nothing proved that derived reason survives the route layer into the JSON
 * the dashboards consume — a future refactor of either response shape could
 * silently drop `lastSyncError` without failing a test.
 *
 * This boots the integrations routes and, with the Front auth-breaker driven
 * into a dead state (`__setFrontAuthStateForTest` + a seeded `front_auth_death:last`
 * record), asserts the derived reason reaches BOTH dashboard payloads:
 *
 *   - `GET /api/integrations/all-status`              → `body.front.lastSyncError`
 *   - `GET /api/integrations/front/console/overview`  → `body.connection.lastSyncError`
 *
 * Determinism notes:
 *   - The all-status Front loader runs `probeConnection()` before
 *     `getSyncMetadata()`. A *successful* `/me` probe calls
 *     `resetFrontAuthBreaker()` + `markFrontAuthDeathRecovered()`, which would
 *     wipe the seeded dead state and make `lastError` null. To keep the test
 *     independent of whatever Front credentials happen to live in the dev DB,
 *     we intercept every Front-host request (api2/app.frontapp.com) and return
 *     401 so the probe resolves `unauthorized` WITHOUT resetting the breaker or
 *     touching the death record (the `front_probe` purpose is non-authoritative).
 *   - `lastSyncError` on all-status is a *cache-sourced* field: a cold cache
 *     returns `{ value: null }` and kicks a background refresh, so we poll until
 *     the cache warms (front.connected !== null) before asserting — the live
 *     breaker fields would otherwise mislead a single-fetch assertion.
 *   - We pin + restore the `front_auth_death:last` shared setting the derivation
 *     reads (shared-setting pinning).
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

const TAG = "task-2425";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const AM_ID = `${TAG}-am`;

// The exact plain-English reason `deriveFrontLastError` produces for a
// permanent-refresh death with HTTP 401 (see FRONT_AUTH_CODE_REASONS).
const EXPECTED_REASON_FRAGMENT = "Front rejected the saved credentials";

type AllStatusFront = {
  connected: boolean | null;
  lastSyncError: string | null;
};

type OverviewConnection = {
  connected: boolean;
  error: string | null;
  lastSyncError: string | null;
};

const originalFetch: typeof fetch = global.fetch;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

function isFrontHost(input: any): boolean {
  let url = "";
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else if (input && typeof input.url === "string") url = input.url;
  return url.includes("frontapp.com");
}

// Keep Upstash/Redis traffic local, and force every Front-host call to 401 so
// the probe resolves `unauthorized` without resetting the seeded dead breaker.
// Everything else falls through to the real fetch.
global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  if (isFrontHost(input)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return originalFetch(input as any, init);
}) as any;

async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task2425 AM"})
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

function seedDeadBreaker(): void {
  const now = Date.now();
  // Breaker OPEN (window in the future) so `isFrontCurrentlyAuthDead` is true,
  // tripped now (within the persist-grace window so the route's reconcile-from
  // -store step preserves the fresh local trip), no later success.
  __setFrontAuthStateForTest({
    breakerOpenUntilMs: now + 5 * 60_000,
    lastTrippedAtMs: now,
    lastTrippedCode: "front_refresh_failed_permanent",
    lastSuccessAtMs: null,
    tripCount: 2,
  });
}

async function seedDeathRecord(): Promise<void> {
  await storage.setSystemSetting(
    FRONT_AUTH_DEATH_LAST_KEY,
    JSON.stringify({
      code: "front_refresh_failed_permanent",
      httpStatus: 401,
      bodySnippet: "invalid_grant",
      environment: "development",
      lastSuccessAt: null,
      diedAt: new Date().toISOString(),
    }),
    "system",
  );
}

async function fetchAllStatusFront(baseUrl: string): Promise<AllStatusFront> {
  const r = await fetch(`${baseUrl}/api/integrations/all-status`);
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`all-status → ${r.status}: ${text.slice(0, 300)}`);
  }
  const body = await r.json();
  return body.front as AllStatusFront;
}

// Poll all-status until the (cache-sourced) Front value warms — i.e. the
// background loader has committed `connected` (false here, since the probe is
// unauthorized) — then return that warm payload.
async function pollWarmAllStatusFront(baseUrl: string): Promise<AllStatusFront> {
  const deadline = Date.now() + 10_000;
  let last: AllStatusFront = { connected: null, lastSyncError: null };
  while (Date.now() < deadline) {
    last = await fetchAllStatusFront(baseUrl);
    if (last.connected !== null) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `all-status Front value never warmed within 10s (last: ${JSON.stringify(last)})`,
  );
}

async function fetchOverviewConnection(baseUrl: string): Promise<OverviewConnection> {
  const r = await fetch(`${baseUrl}/api/integrations/front/console/overview`);
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`console/overview → ${r.status}: ${text.slice(0, 300)}`);
  }
  const body = await r.json();
  return body.connection as OverviewConnection;
}

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  __resetIntegrationStatusCacheForTest();
  __resetFrontAuthBreakerForTest();
  await __clearPersistedFrontAuthBreakerForTest();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  } finally {
    __resetIntegrationStatusCacheForTest();
    __resetFrontAuthBreakerForTest();
    await __clearPersistedFrontAuthBreakerForTest();
  }
}

async function main(): Promise<void> {
  console.log("Front derived lastSyncError reaches dashboard route payloads (Task #2425)");

  await ensureUser();

  // Pin + restore the death record the derivation reads.
  const priorDeath = await storage.getSystemSetting(FRONT_AUTH_DEATH_LAST_KEY).catch(() => null);

  const { server, baseUrl } = await listen(buildApp());

  try {
    await step(
      "GET /api/integrations/all-status — front.lastSyncError carries the derived reason",
      async () => {
        seedDeadBreaker();
        await seedDeathRecord();

        const front = await pollWarmAllStatusFront(baseUrl);
        assert.equal(
          front.connected,
          false,
          "probe should commit connected:false (unauthorized) so the cache warms",
        );
        assert.ok(
          front.lastSyncError,
          "lastSyncError must reach the all-status front payload when Front auth is dead",
        );
        assert.ok(
          front.lastSyncError!.includes(EXPECTED_REASON_FRAGMENT),
          `lastSyncError should be the plain-English reason (got: ${front.lastSyncError})`,
        );
        assert.ok(
          front.lastSyncError!.includes("HTTP 401"),
          `lastSyncError should carry the HTTP status from the death record (got: ${front.lastSyncError})`,
        );
        assert.ok(
          /reconnect/i.test(front.lastSyncError!),
          `lastSyncError should tell the operator to reconnect (got: ${front.lastSyncError})`,
        );
        assert.ok(
          front.lastSyncError !== "" &&
            front.lastSyncError !== "front_refresh_failed_permanent",
          "lastSyncError must not be the empty string or the raw code",
        );
      },
    );

    await step(
      "GET /api/integrations/front/console/overview — connection.lastSyncError carries the derived reason",
      async () => {
        seedDeadBreaker();
        await seedDeathRecord();

        const connection = await fetchOverviewConnection(baseUrl);
        assert.ok(
          connection.lastSyncError,
          "lastSyncError must reach the overview connection payload when Front auth is dead",
        );
        assert.ok(
          connection.lastSyncError!.includes(EXPECTED_REASON_FRAGMENT),
          `lastSyncError should be the plain-English reason (got: ${connection.lastSyncError})`,
        );
        assert.ok(
          connection.lastSyncError!.includes("HTTP 401"),
          `lastSyncError should carry the HTTP status from the death record (got: ${connection.lastSyncError})`,
        );
        assert.ok(
          /reconnect/i.test(connection.lastSyncError!),
          `lastSyncError should tell the operator to reconnect (got: ${connection.lastSyncError})`,
        );
      },
    );

    await step(
      "healthy Front (no trip, no death) — both payloads report lastSyncError null",
      async () => {
        // No breaker trip seeded; clear the death record so the derivation has
        // nothing to surface. Proves the field is genuinely derived, not a
        // constant the routes always echo.
        await storage.deleteSystemSetting(FRONT_AUTH_DEATH_LAST_KEY).catch(() => {});

        const front = await pollWarmAllStatusFront(baseUrl);
        assert.equal(
          front.lastSyncError,
          null,
          "all-status lastSyncError must be null when Front auth never died",
        );

        const connection = await fetchOverviewConnection(baseUrl);
        assert.equal(
          connection.lastSyncError,
          null,
          "overview lastSyncError must be null when Front auth never died",
        );
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (priorDeath?.value) {
      await storage.setSystemSetting(FRONT_AUTH_DEATH_LAST_KEY, priorDeath.value, "system");
    } else {
      await storage.deleteSystemSetting(FRONT_AUTH_DEATH_LAST_KEY).catch(() => {});
    }
    await cleanupUser();
    global.fetch = originalFetch;
    // The local-server route fetches above go through Node's global `undici`
    // dispatcher, which keeps ref'd keep-alive sockets open to 127.0.0.1 after
    // each request. Those linger past `server.close()` and would keep the event
    // loop alive (a drain hang the run-all harness scores as a timeout SIGKILL).
    // Close the dispatcher so the process exits naturally once pools drain.
    try {
      const undici = await import("undici");
      await undici.getGlobalDispatcher().close();
    } catch {
      /* best-effort: fall through to natural drain */
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; return; }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so
// the process exits on its own once work settles — no manual process.exit(), so a
// leaked handle surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  });
