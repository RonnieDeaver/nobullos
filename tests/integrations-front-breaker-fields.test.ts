/* test-registration
{
  "name": "Integrations Hub Front breaker badge fields (Task #2121)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2121 — End-to-end coverage for the Integrations Hub Front breaker
 * badge fields.
 *
 * Task #2103 persists the Front auth-dead breaker signal durably
 * ({code, openedUntilMs, trippedAtMs, tripCount}). Task #2121 surfaces the
 * *when* (tripped-at), the *until* (cooldown-until), and the *how many*
 * (trip count) on the Integrations Hub so the badge is actionable, not just
 * a bare open/closed flag.
 *
 * This boots `GET /api/integrations/all-status` and asserts that the three
 * new Front fields actually reach the JSON payload, so a future refactor of
 * the response shape can't silently drop them:
 *
 *   - `lastTrippedAt`   (ISO — when Front lost its connection)
 *   - `cooldownUntil`   (ISO — when auto-retry / suppression lifts)
 *   - `tripCount`       (number — how many times the breaker has tripped)
 *
 * We drive the in-memory breaker via the test-only introspection seam
 * (`__setFrontAuthStateForTest`) and clear the durable signal first so the
 * route's reconcile-from-store step can't adopt a stale open window from a
 * prior test. A freshly-set local trip (trippedAt = now) is within the
 * persist-grace window, so reconcile preserves it instead of clearing.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import { __resetIntegrationStatusCacheForTest } from "../server/services/integrationStatusCache";
import {
  __resetFrontAuthBreakerForTest,
  __clearPersistedFrontAuthBreakerForTest,
  __setFrontAuthStateForTest,
} from "../server/services/frontAuthBreaker";

const TAG = "task-2121";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const AM_ID = `${TAG}-am`;

type FrontPayload = {
  connected: boolean | null;
  breakerOpen: boolean;
  cooldownRemainingMs: number;
  lastTrippedAt: string | null;
  cooldownUntil: string | null;
  tripCount: number;
};

const originalFetch: typeof fetch = global.fetch;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

// Keep Upstash/Redis traffic local; let everything else fall through. The
// breaker fields are computed from the in-memory state, so no upstream Front
// HTTP is involved.
global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  return originalFetch(input as any, init);
}) as any;

async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task2121 AM"})
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

async function fetchFront(baseUrl: string): Promise<FrontPayload> {
  const r = await fetch(`${baseUrl}/api/integrations/all-status`);
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`all-status → ${r.status}: ${text.slice(0, 300)}`);
  }
  const body = await r.json();
  return body.front as FrontPayload;
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
  console.log("Integrations Hub Front breaker badge fields end-to-end (Task #2121)");

  await ensureUser();
  const { server, baseUrl } = await listen(buildApp());

  try {
    await step(
      "breaker open — lastTrippedAt, cooldownUntil, tripCount reach the payload",
      async () => {
        const now = Date.now();
        const openUntil = now + 5 * 60_000;
        __setFrontAuthStateForTest({
          breakerOpenUntilMs: openUntil,
          lastTrippedAtMs: now,
          lastTrippedCode: "front_refresh_failed_permanent",
          tripCount: 3,
        });

        const front = await fetchFront(baseUrl);
        assert.equal(front.breakerOpen, true, "breakerOpen should be true while the window is open");
        assert.ok(
          front.cooldownRemainingMs > 0,
          `cooldownRemainingMs should be > 0 (got ${front.cooldownRemainingMs})`,
        );
        assert.ok(front.lastTrippedAt, "lastTrippedAt must reach the payload when tripped");
        assert.equal(
          new Date(front.lastTrippedAt as string).getTime(),
          now,
          "lastTrippedAt must match the trip timestamp",
        );
        assert.ok(front.cooldownUntil, "cooldownUntil must reach the payload when open");
        assert.equal(
          new Date(front.cooldownUntil as string).getTime(),
          openUntil,
          "cooldownUntil must match the breaker open-until timestamp",
        );
        assert.equal(front.tripCount, 3, "tripCount must surface the persisted trip count");
      },
    );

    await step(
      "breaker closed — tripCount is a number and breakerOpen is false",
      async () => {
        const front = await fetchFront(baseUrl);
        assert.equal(front.breakerOpen, false, "breakerOpen should be false with no trip");
        assert.equal(front.cooldownRemainingMs, 0, "cooldownRemainingMs should be 0 when closed");
        assert.equal(front.cooldownUntil, null, "cooldownUntil should be null when never opened");
        assert.equal(
          typeof front.tripCount,
          "number",
          "tripCount must reach the payload as a number (no silent drop)",
        );
        assert.equal(front.tripCount, 0, "tripCount should be 0 after a reset");
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanupUser();
    global.fetch = originalFetch;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exitCode = 1; return; }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  });
