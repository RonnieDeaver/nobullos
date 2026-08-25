/* test-registration
{
  "name": "Front auth-recovery annotation + history route (Task #2435)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2435 — Front auth-death recovery annotation
 * (`markFrontAuthDeathRecovered` in
 * `server/services/frontAuthDeathDiagnostics.ts`) and its pass-through on
 * the read-only Integrations-Hub route
 * (`GET /api/integrations/front/auth-history`).
 *
 * Defect 1: a death record was never annotated when Front auth came back,
 * so a healed login-race blip looked identical to a permanent outage in the
 * panel forever. The genuine recovery sites (a successful token persist
 * after refresh/connect, and a 2xx `/me` probe) now call
 * `markFrontAuthDeathRecovered`, which stamps `recoveredAt` on the standing
 * death so the UI can render it as healed.
 *
 * Locks the following behavior in place:
 *   1. Recovery after a death stamps `recoveredAt` on BOTH `:last` and the
 *      matching newest entry in the `:recent` ring.
 *   2. The annotation is idempotent (a second recovery doesn't move the
 *      timestamp) and a no-op when there is no death on record — it never
 *      INVENTS a recovery (so a true revocation can't be masked).
 *   3. The auth-history route serves `recoveredAt` through to the client.
 *
 * Mirrors `tests/front-auth-history.test.ts` for the DB + route harness.
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
  markFrontAuthDeathRecovered,
  getLastFrontAuthDeath,
  getRecentFrontAuthDeaths,
  __resetFrontAuthDeathDedupForTest,
  FRONT_AUTH_DEATH_LAST_KEY,
  FRONT_AUTH_DEATH_RECENT_KEY,
} from "../server/services/frontAuthDeathDiagnostics";

// Take the Clerk per-request test seam even under a bare `npx tsx` repro.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = "task-2435";
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
    VALUES (${AM_ID}, 'account_manager', ${"Task2435 AM"})
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
  console.log("Front auth-death recovery annotation (Task #2435)");

  await ensureUser();
  const { server, baseUrl } = await listen(buildApp());

  try {
    await step("recovery stamps recoveredAt on :last and the matching :recent entry", async () => {
      await recordFrontAuthDeath({
        code: "front_refresh_failed_permanent",
        httpStatus: 400,
        bodySnippet: "invalid_grant: rotation race",
      });

      const before = await getLastFrontAuthDeath();
      assert.ok(before, "death must be persisted");
      assert.ok(!before!.recoveredAt, "death starts unrecovered");

      await markFrontAuthDeathRecovered();

      const after = await getLastFrontAuthDeath();
      assert.ok(after!.recoveredAt, ":last must carry recoveredAt after recovery");
      assert.equal(after!.code, before!.code, "code must be preserved");
      assert.equal(after!.diedAt, before!.diedAt, "diedAt must be preserved");

      const recent = await getRecentFrontAuthDeaths();
      assert.equal(recent.length, 1, "ring still holds the one death");
      assert.ok(recent[0].recoveredAt, "matching ring entry must also carry recoveredAt");
      assert.equal(recent[0].recoveredAt, after!.recoveredAt, "ring + last recoveredAt must match");
    });

    await step("recovery is idempotent — a second call does not move recoveredAt", async () => {
      await recordFrontAuthDeath({ code: "front_refresh_failed_permanent", httpStatus: 400 });
      await markFrontAuthDeathRecovered();
      const first = (await getLastFrontAuthDeath())!.recoveredAt;
      assert.ok(first, "first recovery must stamp recoveredAt");

      // Reset the in-process short-circuit so the second call actually
      // re-reads the DB (proving idempotence at the data layer, not just
      // the flag).
      __resetFrontAuthDeathDedupForTest();
      await markFrontAuthDeathRecovered();
      const second = (await getLastFrontAuthDeath())!.recoveredAt;
      assert.equal(second, first, "a second recovery must NOT overwrite the original recoveredAt");
    });

    await step("recovery with no death on record is a no-op (never invents a recovery)", async () => {
      await markFrontAuthDeathRecovered();
      const last = await getLastFrontAuthDeath();
      assert.equal(last, null, "no death must remain no death — recovery never fabricates one");
    });

    await step("a true death left unrecovered keeps recoveredAt null", async () => {
      await recordFrontAuthDeath({ code: "front_not_connected", httpStatus: null });
      // No recovery call — simulate a genuine revocation that never heals.
      const last = await getLastFrontAuthDeath();
      assert.ok(last, "death persisted");
      assert.ok(!last!.recoveredAt, "an unrecovered true death must stay unrecovered (no masking)");
    });

    await step("GET /api/integrations/front/auth-history serves recoveredAt", async () => {
      await recordFrontAuthDeath({
        code: "front_refresh_failed_permanent",
        httpStatus: 400,
        bodySnippet: "invalid_grant",
      });
      await markFrontAuthDeathRecovered();

      const r = await fetch(`${baseUrl}/api/integrations/front/auth-history`);
      assert.equal(r.status, 200, "route should respond 200 for an account manager");
      const body = await r.json();
      assert.ok(body.last, "payload.last must be present");
      assert.ok(body.last.recoveredAt, "payload.last.recoveredAt must be served through");
      assert.ok(Array.isArray(body.recent) && body.recent.length === 1);
      assert.ok(body.recent[0].recoveredAt, "payload.recent[0].recoveredAt must be served through");
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
