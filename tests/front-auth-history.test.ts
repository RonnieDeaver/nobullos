/* test-registration
{
  "name": "Front auth-death diagnostics + history route (Task #2142)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2142 — coverage for the durable Front auth-death diagnostics
 * (`server/services/frontAuthDeathDiagnostics.ts`) and the read-only
 * Integrations-Hub route (`GET /api/integrations/front/auth-history`).
 *
 * Task #2100/#2103 surface *that* Front lost its OAuth credential (the
 * breaker badge). This task captures *why* the last death happened — the
 * HTTP status Front returned, the response-body snippet, the environment,
 * and when Front auth last worked — into `front_auth_death:last` plus a
 * capped `front_auth_death:recent` ring, and serves them read-only.
 *
 * Locks the following behavior in place:
 *   1. `recordFrontAuthDeath` writes both the `:last` pointer and the
 *      `:recent` ring; read helpers parse them back.
 *   2. A burst of the same terminal code within the dedup window collapses
 *      to a single record (the ring is a timeline, not a flood).
 *   3. A different code (or a record after the window) appends a new entry,
 *      newest-first.
 *   4. The route returns `{ last, recent }` from the read helpers.
 *
 * `global.fetch` is left alone except for the Upstash/Redis passthrough the
 * settings cache needs; no real Front HTTP is involved.
 */
import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import {
  recordFrontAuthDeath,
  getLastFrontAuthDeath,
  getRecentFrontAuthDeaths,
  __resetFrontAuthDeathDedupForTest,
  FRONT_AUTH_DEATH_LAST_KEY,
  FRONT_AUTH_DEATH_RECENT_KEY,
} from "../server/services/frontAuthDeathDiagnostics";

// Take the Clerk per-request test seam even under a bare `npx tsx` repro.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = "task-2142";
const AM_ID = `${TAG}-am`;

const originalFetch: typeof fetch = global.fetch;

const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  return originalFetch(input as any, init);
}) as any;

async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task2142 AM"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanupUser(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM users WHERE id = ${AM_ID}`);
  } catch {}
}

async function clearDeathRows(): Promise<void> {
  __resetFrontAuthDeathDedupForTest();
  await db.execute(
    sql`DELETE FROM system_settings WHERE key IN (${FRONT_AUTH_DEATH_LAST_KEY}, ${FRONT_AUTH_DEATH_RECENT_KEY})`,
  );
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
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

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  await clearDeathRows();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  } finally {
    await clearDeathRows();
  }
}

async function main(): Promise<void> {
  console.log("Front auth-death diagnostics + history route (Task #2142)");

  await ensureUser();
  const { server, baseUrl } = await listen(buildApp());

  try {
    await step("recordFrontAuthDeath writes :last and :recent; read helpers parse", async () => {
      await recordFrontAuthDeath({
        code: "front_refresh_failed_permanent",
        httpStatus: 400,
        bodySnippet: "invalid_grant: token revoked",
        lastSuccessAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const last = await getLastFrontAuthDeath();
      assert.ok(last, "last death must be persisted");
      assert.equal(last!.code, "front_refresh_failed_permanent");
      assert.equal(last!.httpStatus, 400, "httpStatus must round-trip");
      assert.equal(last!.bodySnippet, "invalid_grant: token revoked", "bodySnippet must round-trip");
      assert.ok(last!.environment, "environment must be recorded");
      assert.ok(last!.diedAt, "diedAt must be recorded");

      const recent = await getRecentFrontAuthDeaths();
      assert.equal(recent.length, 1, "recent ring should hold exactly one entry");
      assert.equal(recent[0].code, "front_refresh_failed_permanent");
    });

    await step("a same-code burst within the dedup window collapses to one record", async () => {
      await recordFrontAuthDeath({ code: "front_refresh_failed_permanent", httpStatus: 400 });
      await recordFrontAuthDeath({ code: "front_refresh_failed_permanent", httpStatus: 400 });
      await recordFrontAuthDeath({ code: "front_refresh_failed_permanent", httpStatus: 400 });

      const recent = await getRecentFrontAuthDeaths();
      assert.equal(recent.length, 1, "a burst of identical codes must not flood the ring");
    });

    await step("a different code appends a new newest-first entry", async () => {
      await recordFrontAuthDeath({ code: "front_refresh_failed_permanent", httpStatus: 400 });
      __resetFrontAuthDeathDedupForTest(); // simulate a later, distinct death
      await recordFrontAuthDeath({ code: "front_no_refresh_token", httpStatus: null });

      const recent = await getRecentFrontAuthDeaths();
      assert.equal(recent.length, 2, "two distinct deaths should both be in the ring");
      assert.equal(recent[0].code, "front_no_refresh_token", "newest death must be first");
      assert.equal(recent[1].code, "front_refresh_failed_permanent");

      const last = await getLastFrontAuthDeath();
      assert.equal(last!.code, "front_no_refresh_token", ":last must point at the newest death");
    });

    await step("GET /api/integrations/front/auth-history returns { last, recent }", async () => {
      await recordFrontAuthDeath({
        code: "front_refresh_failed_permanent",
        httpStatus: 401,
        bodySnippet: "unauthorized",
      });

      const r = await fetch(`${baseUrl}/api/integrations/front/auth-history`);
      assert.equal(r.status, 200, "route should respond 200 for an account manager");
      const body = await r.json();
      assert.ok(body.last, "payload.last must be present");
      assert.equal(body.last.code, "front_refresh_failed_permanent");
      assert.equal(body.last.httpStatus, 401);
      assert.ok(Array.isArray(body.recent), "payload.recent must be an array");
      assert.equal(body.recent.length, 1);
    });

    await step("GET returns nulls/empty when there is no death on record", async () => {
      const r = await fetch(`${baseUrl}/api/integrations/front/auth-history`);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.last, null, "last should be null with no deaths");
      assert.deepEqual(body.recent, [], "recent should be empty with no deaths");
    });
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
