/* test-registration
{
  "name": "Integrations Hub SEMrush reconnectRequired field (Task #2160)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2160 — End-to-end coverage for the Integrations Hub SEMrush
 * "reconnect required" indicator.
 *
 * Task #2122 made the SEMrush auth-dead breaker persist its trip state
 * durably and reconcile across instances (mirroring Front / Zoom). Task
 * #2160 surfaces an explicit operator-facing `reconnectRequired` boolean on
 * `GET /api/integrations/all-status` (derived from
 * `semrushAuthBreakerActive()`) so the Hub can render an amber "Reconnect
 * Required" badge, consistent with the Zoom/Front experience.
 *
 * (Google Ads was originally covered here too; Task #4008 retired its
 * platform OAuth breaker — the env-credential model has no in-app reconnect,
 * so the googleAds payload must NOT carry breaker fields anymore. A negative
 * assertion below pins that retirement.)
 *
 * This boots the route and asserts the field reaches the JSON payload —
 * true while the breaker is open, false when closed — so a future refactor
 * of the response shape can't silently drop it.
 *
 * The in-memory breaker is driven via its test-only introspection seam
 * and the durable signal is cleared first so the route's reconcile-from-store
 * step can't adopt a stale open window from a prior test. A freshly-set local
 * trip (trippedAt = now) is within the persist-grace window, so reconcile
 * preserves it instead of clearing.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

// Ensure the Clerk per-request test seam is active for bare repros too.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db } from "../server/db";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import { __resetIntegrationStatusCacheForTest } from "../server/services/integrationStatusCache";
import {
  __resetSemrushAuthBreakerForTest,
  __clearPersistedSemrushAuthBreakerForTest,
  __setSemrushAuthStateForTest,
} from "../server/services/semrushAuthBreaker";

const TAG = "task-2160";
const AM_ID = `${TAG}-am`;

type Payload = {
  googleAds: Record<string, unknown>;
  semrush: { reconnectRequired?: boolean; breakerOpen?: boolean };
};

const originalFetch: typeof fetch = global.fetch;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

// Keep Upstash/Redis traffic local; let everything else fall through. The
// reconnectRequired field is computed from the in-memory breaker state, so no
// upstream Google Ads / SEMrush HTTP is involved.
global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  return originalFetch(input as any, init);
}) as any;

async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task2160 AM"})
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

async function fetchStatus(baseUrl: string): Promise<Payload> {
  const r = await fetch(`${baseUrl}/api/integrations/all-status`);
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`all-status → ${r.status}: ${text.slice(0, 300)}`);
  }
  return (await r.json()) as Payload;
}

let passed = 0;
let failed = 0;

async function resetBreakers(): Promise<void> {
  __resetIntegrationStatusCacheForTest();
  __resetSemrushAuthBreakerForTest();
  await __clearPersistedSemrushAuthBreakerForTest();
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  await resetBreakers();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  } finally {
    await resetBreakers();
  }
}

async function main(): Promise<void> {
  console.log("Integrations Hub SEMrush reconnectRequired field end-to-end (Task #2160)");

  await ensureUser();
  const { server, baseUrl } = await listen(buildApp());

  try {
    await step(
      "breaker open — semrush.reconnectRequired is true",
      async () => {
        const now = Date.now();
        const openUntil = now + 5 * 60_000;
        __setSemrushAuthStateForTest({
          breakerOpenUntilMs: openUntil,
          lastTrippedAtMs: now,
          lastTrippedCode: "semrush_refresh_failed_permanent",
          tripCount: 1,
        });

        const body = await fetchStatus(baseUrl);
        assert.equal(
          body.semrush.reconnectRequired,
          true,
          "semrush.reconnectRequired must be true while the breaker is open",
        );
      },
    );

    await step(
      "breaker closed — semrush.reconnectRequired is false; googleAds carries NO breaker fields (Task #4008)",
      async () => {
        const body = await fetchStatus(baseUrl);
        assert.equal(
          body.semrush.reconnectRequired,
          false,
          "semrush.reconnectRequired must be false with no trip",
        );
        // Task #4008 — the env-credential model has no in-app reconnect;
        // the slim googleAds payload must not resurrect breaker fields.
        for (const retired of ["reconnectRequired", "breakerOpen", "lastTrippedCode"]) {
          assert.equal(
            retired in body.googleAds,
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
