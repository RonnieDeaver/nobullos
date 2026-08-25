/* test-registration
{
  "name": "Integrations Hub SEMrush breaker lastTrippedCode field (Task #2225)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2225 — Regression coverage for the SEMrush breaker
 * `lastTrippedCode` (and `lastSuccessAt`) reaching the Integrations-Hub
 * `GET /api/integrations/all-status` payload.
 *
 * Task #2152 surfaced the *when* / *until* / *how-many* breaker fields. But
 * when the breaker is open while the probe cache still reports connected, the
 * operator only saw a generic "auth breaker open — reconnect required" line —
 * not the specific terminal cause. The breaker already records that cause as
 * `lastTrippedCode` (e.g. `semrush_no_refresh_token`); this test asserts the
 * field actually reaches the JSON so a future response-shape refactor can't
 * silently drop the reason the Hub humanizes.
 *
 * (Google Ads was originally covered here too; Task #4008 retired its
 * platform OAuth breaker — the env-credential model has no breaker, so the
 * googleAds payload must NOT carry `lastTrippedCode` anymore. A negative
 * assertion below pins that retirement.)
 *
 * We drive the in-memory breaker via its test-only introspection seam and
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
  __resetSemrushAuthBreakerForTest,
  __clearPersistedSemrushAuthBreakerForTest,
  __setSemrushAuthStateForTest,
} from "../server/services/semrushAuthBreaker";

const TAG = "task-2225";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const AM_ID = `${TAG}-am`;

type TripCodePayload = {
  breakerOpen?: boolean;
  lastTrippedCode: string | null;
  lastSuccessAt: string | null;
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
    VALUES (${AM_ID}, 'account_manager', ${"Task2225 AM"})
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

async function fetchAllStatus(baseUrl: string): Promise<Record<string, TripCodePayload>> {
  const r = await fetch(`${baseUrl}/api/integrations/all-status`);
  if (r.status !== 200) {
    const text = await r.text();
    throw new Error(`all-status → ${r.status}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

async function resetAll(): Promise<void> {
  __resetIntegrationStatusCacheForTest();
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

async function main(): Promise<void> {
  console.log("Integrations Hub SEMrush breaker lastTrippedCode field (Task #2225)");

  await ensureUser();
  const { server, baseUrl } = await listen(buildApp());

  try {
    await step(
      "breaker open — lastTrippedCode + lastSuccessAt reach the semrush payload",
      async () => {
        const now = Date.now();
        const openUntil = now + 5 * 60_000;
        const lastSuccess = now - 60 * 60_000;
        __setSemrushAuthStateForTest({
          breakerOpenUntilMs: openUntil,
          lastTrippedAtMs: now,
          lastTrippedCode: "semrush_no_refresh_token",
          lastSuccessAtMs: lastSuccess,
          tripCount: 2,
        });

        const body = await fetchAllStatus(baseUrl);

        assert.ok(body.semrush, "semrush block must be present");
        assert.equal(
          body.semrush.lastTrippedCode,
          "semrush_no_refresh_token",
          "semrush lastTrippedCode must reach the payload",
        );
        assert.ok(
          body.semrush.lastSuccessAt,
          "semrush lastSuccessAt must reach the payload when set",
        );
        assert.equal(
          new Date(body.semrush.lastSuccessAt as string).getTime(),
          lastSuccess,
          "semrush lastSuccessAt must match the seeded timestamp",
        );
      },
    );

    await step(
      "breaker closed — semrush lastTrippedCode present-but-null; googleAds carries NO breaker fields (Task #4008)",
      async () => {
        const body = await fetchAllStatus(baseUrl);
        const p = body.semrush;
        assert.ok(
          "lastTrippedCode" in p,
          "semrush lastTrippedCode must always be present in the payload (no silent drop)",
        );
        assert.equal(
          p.lastTrippedCode,
          null,
          "semrush lastTrippedCode should be null after a reset",
        );
        // Task #4008 — the env-credential model has no breaker; the slim
        // googleAds payload must not resurrect breaker fields.
        assert.ok(body.googleAds, "googleAds block must be present");
        for (const retired of ["lastTrippedCode", "breakerOpen", "cooldownUntil", "tripCount"]) {
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
