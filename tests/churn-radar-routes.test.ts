/* test-registration
{
  "name": "Churn Risk Radar routes — 401/403 gates, 202 start + poll/list/results, 409 under held sweep lock, 404 (Task #3692)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy: isolated-schema clone + real cross-instance pg advisory lock + background sweep drain — not smoke-gate material",
  "tier": "small"
}
test-registration */
/**
 * Task #3692 — Churn Risk Radar routes test.
 *
 * Covers the director-gated radar endpoints in server/routes/churn.ts:
 *   (A) unauthenticated → 401 on all four endpoints;
 *   (B) core-authority user → 403 (strict gate — no permissive-mode bypass);
 *   (C) director POST /runs → 202 with a run id; the background sweep
 *       (drained via the service's test seam) completes against the EMPTY
 *       isolated clients table (0 active clients — instant), then
 *       GET /runs/:id shows completed with zeroed counters and
 *       GET /runs/:id/results returns the {run, clients, themes} shape;
 *   (D) POST while the cross-instance sweep lock is held → 409 (graceful
 *       re-press rejection);
 *   (E) ceo-authority user can read runs (authorityAtLeast director);
 *   (F) unknown run id → 404.
 *
 * Hermetic: runInIsolatedSchema clones users/clients/user_notifications
 * with pinGetDbForCrossAsync so Express handlers AND the background
 * sweep's storage reads hit the clones (getActiveClients sees 0 rows).
 * Radar run rows are written via workerDb (public.*) by design — the test
 * tracks created run ids and deletes them in finally. Stale `running`
 * rows in public would make POST resume them instead of creating a fresh
 * run, so assertions follow the returned run id rather than assuming
 * creation. undici's dispatcher is closed at teardown (keep-alive drain).
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql, eq, inArray } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

const { registerChurnRoutes } = await import("../server/routes/churn");
const { runInIsolatedSchema } = await import("./db-sandbox");
const { workerDb } = await import("../server/db");
const { churnRadarRuns, churnRadarActiveRunStatuses } = await import("@shared/schema");
const { acquireWorkerSingletonLock } = await import("../server/services/crossInstanceLock");
const { __testDrainChurnRadarSweeps } = await import("../server/services/churnRiskRadar");
const { __test_markUserReconciled, __test_resetReconciledUsers } = await import(
  "../server/middlewares/requireAuth"
);

const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const DIRECTOR_ID = `test-3692-dir-${RUN}`;
const CEO_ID = `test-3692-ceo-${RUN}`;
const CORE_ID = `test-3692-core-${RUN}`;

let activeUserId: string | null = DIRECTOR_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = activeUserId;
    next();
  });
  registerChurnRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  const createdRunIds = new Set<string>();

  // Stale active runs in public would make POST resume them (their sweep
  // would also run instantly against the empty isolated clients table, but
  // resumption muddies the assertions). They can only be leftovers from a
  // crashed dev-server sweep — nothing holds the lock for them anymore.
  const stale = await workerDb
    .select({ id: churnRadarRuns.id })
    .from(churnRadarRuns)
    .where(inArray(churnRadarRuns.status, [...churnRadarActiveRunStatuses]));
  if (stale.length > 0) {
    console.log(`  (pre-clean: removing ${stale.length} stale active radar run(s) from public)`);
    await workerDb.delete(churnRadarRuns).where(inArray(churnRadarRuns.id, stale.map((r) => r.id)));
  }

  try {
    await runInIsolatedSchema(
      async ({ db }) => {
        await db.execute(sql`
          INSERT INTO users (id, authority_level, first_name)
          VALUES (${DIRECTOR_ID}, 'director', 'Director 3692')
          ON CONFLICT (id) DO UPDATE SET authority_level = EXCLUDED.authority_level
        `);
        await db.execute(sql`
          INSERT INTO users (id, authority_level, first_name)
          VALUES (${CEO_ID}, 'ceo', 'CEO 3692')
          ON CONFLICT (id) DO UPDATE SET authority_level = EXCLUDED.authority_level
        `);
        await db.execute(sql`
          INSERT INTO users (id, authority_level, first_name)
          VALUES (${CORE_ID}, 'core', 'Core 3692')
          ON CONFLICT (id) DO UPDATE SET authority_level = EXCLUDED.authority_level
        `);

        // Users are seeded only in the isolated sandbox schema; pre-register
        // them with requireAuth's registry so it uses the profile directly
        // instead of missing the public lookup and JIT-provisioning a stray
        // public row (litter + surprise authority). The route re-reads
        // authority via storage.getUser under the pinned isolated schema.
        __test_markUserReconciled(DIRECTOR_ID, { id: DIRECTOR_ID, authorityLevel: "director" });
        __test_markUserReconciled(CEO_ID, { id: CEO_ID, authorityLevel: "ceo" });
        __test_markUserReconciled(CORE_ID, { id: CORE_ID, authorityLevel: "core" });

        const app = buildApp();
        const { server, baseUrl } = await listen(app);

        try {
          // ── (A) unauthenticated → 401 everywhere ───────────────────────
          activeUserId = null;
          for (const [method, path] of [
            ["POST", "/api/churn/radar/runs"],
            ["GET", "/api/churn/radar/runs"],
            ["GET", "/api/churn/radar/runs/some-id"],
            ["GET", "/api/churn/radar/runs/some-id/results"],
          ] as const) {
            const r = await call(baseUrl, method, path);
            assert.equal(r.status, 401, `${method} ${path} unauthenticated must be 401 (got ${r.status})`);
          }
          console.log("  ✓ A: unauthenticated → 401 on all radar endpoints");

          // ── (B) core authority → 403 (strict gate) ─────────────────────
          activeUserId = CORE_ID;
          for (const [method, path] of [
            ["POST", "/api/churn/radar/runs"],
            ["GET", "/api/churn/radar/runs"],
            ["GET", "/api/churn/radar/runs/some-id"],
            ["GET", "/api/churn/radar/runs/some-id/results"],
          ] as const) {
            const r = await call(baseUrl, method, path);
            assert.equal(r.status, 403, `${method} ${path} core must be 403 (got ${r.status}: ${JSON.stringify(r.body)})`);
          }
          console.log("  ✓ B: core authority → 403 (no permissive-mode bypass)");

          // ── (C) director starts a sweep; 0-client run completes ────────
          activeUserId = DIRECTOR_ID;
          const post = await call(baseUrl, "POST", "/api/churn/radar/runs");
          assert.equal(post.status, 202, `POST must be 202 (got ${post.status}: ${JSON.stringify(post.body)})`);
          const startedRunId: string = post.body?.run?.id;
          assert.ok(startedRunId, "202 body carries the run");
          createdRunIds.add(startedRunId);

          await __testDrainChurnRadarSweeps();

          const poll = await call(baseUrl, "GET", `/api/churn/radar/runs/${startedRunId}`);
          assert.equal(poll.status, 200);
          assert.equal(
            poll.body.run.status,
            "completed",
            `0-client sweep must complete after drain (got ${poll.body.run.status}: ${poll.body.run.errorSummary})`,
          );
          assert.equal(poll.body.run.totalClients, 0, "isolated clients table is empty");
          assert.equal(poll.body.run.processedClients, 0);
          assert.equal(poll.body.run.requestedBy, DIRECTOR_ID);

          const list = await call(baseUrl, "GET", "/api/churn/radar/runs");
          assert.equal(list.status, 200);
          assert.ok(
            (list.body.runs as any[]).some((r) => r.id === startedRunId),
            "run history lists the new run",
          );

          const results = await call(baseUrl, "GET", `/api/churn/radar/runs/${startedRunId}/results`);
          assert.equal(results.status, 200);
          assert.equal(results.body.run.id, startedRunId);
          assert.deepEqual(results.body.clients, [], "no clients analyzed");
          assert.deepEqual(results.body.themes, [], "no themes synthesized");
          assert.ok(typeof results.body.generatedAt === "string", "synthesis timestamp persisted even for empty runs");
          console.log("  ✓ C: director POST → 202; sweep completes; poll/list/results all serve");

          // ── (D) re-press while the sweep lock is held → 409 ────────────
          const lock = await acquireWorkerSingletonLock("churn-risk-radar-sweep", "[test-3692]");
          assert.ok(lock, "test must be able to take the sweep lock (no sweep running)");
          try {
            const conflict = await call(baseUrl, "POST", "/api/churn/radar/runs");
            assert.equal(conflict.status, 409, `POST under held lock must be 409 (got ${conflict.status}: ${JSON.stringify(conflict.body)})`);
            assert.match(conflict.body.error ?? "", /already running/i);
          } finally {
            await lock!.release();
          }
          console.log("  ✓ D: POST while a sweep holds the lock → 409, gracefully");

          // ── (E) ceo authority may read (authorityAtLeast director) ─────
          activeUserId = CEO_ID;
          const ceoList = await call(baseUrl, "GET", "/api/churn/radar/runs");
          assert.equal(ceoList.status, 200, "ceo authority passes the director gate");
          console.log("  ✓ E: ceo authority allowed");

          // ── (F) unknown run id → 404 ───────────────────────────────────
          activeUserId = DIRECTOR_ID;
          const missing = await call(baseUrl, "GET", `/api/churn/radar/runs/nonexistent-${RUN}`);
          assert.equal(missing.status, 404);
          const missingResults = await call(baseUrl, "GET", `/api/churn/radar/runs/nonexistent-${RUN}/results`);
          assert.equal(missingResults.status, 404);
          console.log("  ✓ F: unknown run id → 404");
        } finally {
          server.close();
        }
      },
      {
        // users: gate lookups + auto-provision writes; clients: the sweep's
        // getActiveClients read (must see the EMPTY clone, not public);
        // user_notifications: completion notify under the getDb pin.
        tables: ["users", "clients", "user_notifications"],
        pinGetDbForCrossAsync: true,
      },
    );
  } finally {
    // Radar run rows land in public via workerDb by design — remove ours
    // (cascade covers results/findings; none expected for 0-client runs).
    try {
      if (createdRunIds.size > 0) {
        await workerDb.delete(churnRadarRuns).where(inArray(churnRadarRuns.id, [...createdRunIds]));
      }
    } catch (err) {
      console.error("cleanup failed:", err);
    }
    __test_resetReconciledUsers();
    await getGlobalDispatcher().close();
  }

  console.log("churn-radar-routes: all sections passed (Task #3692).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("churn-radar-routes: FAILED —", err?.stack ?? err);
    process.exit(1);
  },
);
