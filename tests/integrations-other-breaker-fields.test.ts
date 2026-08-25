/* test-registration
{
  "name": "Integrations Hub Slack / SEMrush breaker badge fields (Task #2152)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2152 — End-to-end coverage for the Integrations Hub Slack / SEMrush
 * breaker badge fields.
 *
 * Task #2121 surfaced the *when* (tripped-at), the *until* (cooldown-until),
 * and the *how many* (trip count) for Front. Task #2152 extended the same
 * detail to the other breaker-backed integrations, which already exposed
 * `breakerOpen` + `cooldownRemainingMs` but whose cards only showed the bare
 * open/closed badge.
 *
 * (Google Ads was originally covered here too; Task #4008 retired its
 * platform OAuth breaker — the env-credential model has no breaker, so the
 * googleAds payload must NOT carry these fields anymore. A negative
 * assertion below pins that retirement.)
 *
 * This boots `GET /api/integrations/all-status` and asserts that the three
 * fields actually reach the JSON payload for each integration, so a future
 * refactor of the response shape can't silently drop them:
 *
 *   - `lastTrippedAt`   (ISO — when the integration lost its connection)
 *   - `cooldownUntil`   (ISO — when auto-retry / suppression lifts)
 *   - `tripCount`       (number — how many times the breaker has tripped)
 *
 * We drive each in-memory breaker via its test-only introspection seam and
 * clear the durable signal first so the route's reconcile-from-store step
 * can't adopt a stale open window from a prior test. A freshly-set local trip
 * (trippedAt = now) is within the persist-grace window, so reconcile preserves
 * it instead of clearing.
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
  __resetSlackAuthBreakerForTest,
  __setSlackAuthStateForTest,
} from "../server/services/slackIntegration";
import {
  __resetSemrushAuthBreakerForTest,
  __clearPersistedSemrushAuthBreakerForTest,
  __setSemrushAuthStateForTest,
} from "../server/services/semrushAuthBreaker";

const TAG = "task-2152";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const AM_ID = `${TAG}-am`;

type BreakerPayload = {
  breakerOpen?: boolean;
  cooldownRemainingMs?: number;
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
// breaker fields are computed from the in-memory state, so no upstream HTTP
// is involved in producing them.
global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  return originalFetch(input as any, init);
}) as any;

async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task2152 AM"})
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

async function fetchAllStatus(baseUrl: string): Promise<Record<string, BreakerPayload>> {
  const r = await fetch(`${baseUrl}/api/integrations/all-status`);
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`all-status → ${r.status}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

async function resetAll(): Promise<void> {
  __resetIntegrationStatusCacheForTest();
  __resetSlackAuthBreakerForTest();
  __resetSemrushAuthBreakerForTest();
  await __clearPersistedSemrushAuthBreakerForTest();
}

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  await resetAll();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  } finally {
    await resetAll();
  }
}

function assertOpenFields(integration: string, payload: BreakerPayload, now: number, openUntil: number, trips: number) {
  assert.ok(payload, `${integration} block must be present`);
  assert.ok(payload.lastTrippedAt, `${integration} lastTrippedAt must reach the payload when tripped`);
  assert.equal(
    new Date(payload.lastTrippedAt as string).getTime(),
    now,
    `${integration} lastTrippedAt must match the trip timestamp`,
  );
  assert.ok(payload.cooldownUntil, `${integration} cooldownUntil must reach the payload when open`);
  assert.equal(
    new Date(payload.cooldownUntil as string).getTime(),
    openUntil,
    `${integration} cooldownUntil must match the breaker open-until timestamp`,
  );
  assert.equal(payload.tripCount, trips, `${integration} tripCount must surface the trip count`);
}

async function main(): Promise<void> {
  console.log("Integrations Hub Slack / SEMrush breaker badge fields end-to-end (Task #2152)");

  await ensureUser();
  const { server, baseUrl } = await listen(buildApp());

  try {
    await step(
      "breaker open — lastTrippedAt, cooldownUntil, tripCount reach each payload",
      async () => {
        const now = Date.now();
        const openUntil = now + 5 * 60_000;
        __setSlackAuthStateForTest({
          breakerOpenUntilMs: openUntil,
          lastTrippedAtMs: now,
          lastTrippedCode: "invalid_auth",
          tripCount: 2,
        });
        __setSemrushAuthStateForTest({
          breakerOpenUntilMs: openUntil,
          lastTrippedAtMs: now,
          lastTrippedCode: "unauthorized",
          tripCount: 5,
        });

        const body = await fetchAllStatus(baseUrl);
        assertOpenFields("slack", body.slack, now, openUntil, 2);
        assertOpenFields("semrush", body.semrush, now, openUntil, 5);
      },
    );

    await step(
      "breaker closed — tripCount number/cooldownUntil null; googleAds carries NO breaker fields (Task #4008)",
      async () => {
        const body = await fetchAllStatus(baseUrl);
        for (const integration of ["slack", "semrush"] as const) {
          const p = body[integration];
          assert.equal(p.cooldownUntil, null, `${integration} cooldownUntil should be null when never opened`);
          assert.equal(
            typeof p.tripCount,
            "number",
            `${integration} tripCount must reach the payload as a number (no silent drop)`,
          );
          assert.equal(p.tripCount, 0, `${integration} tripCount should be 0 after a reset`);
        }
        // Task #4008 — the env-credential model has no breaker; the slim
        // googleAds payload must not resurrect breaker fields.
        assert.ok(body.googleAds, "googleAds block must be present");
        for (const retired of ["lastTrippedAt", "cooldownUntil", "tripCount", "breakerOpen"]) {
          assert.equal(
            retired in (body.googleAds as Record<string, unknown>),
            false,
            `googleAds.${retired} was retired with the platform OAuth machinery`,
          );
        }
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
