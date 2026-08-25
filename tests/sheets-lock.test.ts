/* test-registration
{
  "name": "NoBull Sheets — edit locking, heartbeat & revision guard (Task #2933)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "tier": "small"
}
test-registration */
/**
 * NoBull Sheets — edit-locking & revision-guard route tests.
 *
 * Covers (Task #2933):
 *   - Lock acquisition succeeds when workbook is unlocked.
 *   - Lock contention: second user cannot acquire a live lock.
 *   - Expiry reclaim: a lock that has expired is taken over.
 *   - Heartbeat extends the lock; missing holder returns 409.
 *   - Release removes the lock so the next user can acquire.
 *   - Save without holding the lock → 423 LOCK_REQUIRED.
 *   - Save with wrong revision → 409 REVISION_CONFLICT.
 *   - Save with correct lock + revision → 200, revision incremented.
 *   - Metadata-only update (rename) does NOT require a lock or revision.
 *   - GET /lock returns locked:false when lock is absent.
 *
 * Uses runInIsolatedSchema so all writes hit a throwaway search_path.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express from "express";
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from "undici";
import { createServer } from "http";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

// ---- Clerk test-seam auth helper ----

function makeAuthMiddleware(userId: string, role = "account_manager") {
  return (_req: any, _res: any, next: any) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id. requireAuth populates req.dbUser +
    // req.user.claims.sub from the pre-registered profile.
    void role;
    _req.__test_clerkUserId = userId;
    next();
  };
}

async function buildTestApp(userId: string, role = "account_manager") {
  const app = express();
  app.use(express.json());
  app.use(makeAuthMiddleware(userId, role));

  const { registerSheetsRoutes } = await import("../server/routes/sheets");
  registerSheetsRoutes(app);

  return { app };
}

// ---- server lifecycle ----

let baseUrl = "";
let server: ReturnType<typeof createServer>;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

async function startServer(app: express.Express): Promise<void> {
  originalDispatcher = getGlobalDispatcher();
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 }));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function stopServer(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setGlobalDispatcher(originalDispatcher);
}

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: any;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

// ---- test runner ----

let passed = 0;
let failed = 0;

function ok(label: string) {
  passed++;
  console.log(`  ✓ ${label}`);
}

function fail(label: string, detail: string) {
  failed++;
  console.error(`  ✗ ${label}: ${detail}`);
}

async function run() {
  await runInIsolatedSchema(async () => {
    const { getDb } = await import("../server/db");
    const db = getDb();

    const ownerId = "sl-test-owner-001";
    const otherId = "sl-test-other-002";

    // Seed users.
    await db.execute(
      `INSERT INTO users (id, email, role)
       VALUES ('${ownerId}', 'sl_owner@test.local', 'account_manager'),
              ('${otherId}', 'sl_other@test.local', 'account_manager')
       ON CONFLICT (id) DO NOTHING` as any,
    );

    // Users are seeded in the isolated (uncommitted) sandbox schema, so
    // requireAuth's ambient public-schema lookup would miss them. Pre-register
    // each acting identity with the Clerk test registry.
    __test_markUserReconciled(ownerId, {
      id: ownerId,
      email: "sl_owner@test.local",
      role: "account_manager",
    });
    __test_markUserReconciled(otherId, {
      id: otherId,
      email: "sl_other@test.local",
      role: "account_manager",
    });

    // ---- setup: create a workbook as ownerId ----
    let wbId: string;
    {
      const { app } = await buildTestApp(ownerId);
      await startServer(app);
      const { status, body } = await req("POST", "/api/sheets/workbooks", { name: "Lock Test WB" });
      assert.equal(status, 201, `createWorkbook: ${JSON.stringify(body)}`);
      wbId = body.workbook.id;
      ok(`setup: created workbook ${wbId}`);
      await stopServer();
    }

    // ---- GET /lock — no lock yet ----
    {
      const { app } = await buildTestApp(ownerId);
      await startServer(app);
      const { status, body } = await req("GET", `/api/sheets/workbooks/${wbId}/lock`);
      assert.equal(status, 200, `getLock: ${JSON.stringify(body)}`);
      assert.equal(body.locked, false);
      ok("GET /lock returns locked:false when no lock exists");
      await stopServer();
    }

    // ---- Acquire lock as owner ----
    {
      const { app } = await buildTestApp(ownerId);
      await startServer(app);
      const { status, body } = await req("POST", `/api/sheets/workbooks/${wbId}/lock`, {
        holderName: "Alice Owner",
      });
      assert.equal(status, 200, `acquireLock: ${JSON.stringify(body)}`);
      assert.equal(body.acquired, true);
      assert.equal(body.lock?.holderUserId, ownerId);
      ok("owner acquires lock → acquired:true");
      await stopServer();
    }

    // ---- GET /lock — lock present ----
    {
      const { app } = await buildTestApp(ownerId);
      await startServer(app);
      const { status, body } = await req("GET", `/api/sheets/workbooks/${wbId}/lock`);
      assert.equal(status, 200);
      assert.equal(body.locked, true);
      assert.equal(body.lock?.holderUserId, ownerId);
      ok("GET /lock returns locked:true and holder when lock exists");
      await stopServer();
    }

    // ---- Lock contention: other user cannot acquire ----
    {
      const { app } = await buildTestApp(otherId);
      await startServer(app);

      // First, grant otherId editor access via owner's perspective (rebuild as owner).
      await stopServer();
      const { app: ownerApp } = await buildTestApp(ownerId);
      await startServer(ownerApp);
      await req("PUT", `/api/sheets/workbooks/${wbId}/permissions`, {
        userId: otherId,
        role: "editor",
      });
      await stopServer();

      const { app: otherApp } = await buildTestApp(otherId);
      await startServer(otherApp);
      const { status, body } = await req("POST", `/api/sheets/workbooks/${wbId}/lock`, {
        holderName: "Bob Other",
      });
      assert.equal(status, 200, `otherAcquire: ${JSON.stringify(body)}`);
      assert.equal(body.acquired, false, "other user should NOT acquire while owner holds lock");
      assert.equal(body.lock?.holderUserId, ownerId);
      ok("lock contention: other user gets acquired:false while owner holds");
      await stopServer();
    }

    // ---- Heartbeat extends lock ----
    {
      const { app } = await buildTestApp(ownerId);
      await startServer(app);
      const { status, body } = await req(
        "POST",
        `/api/sheets/workbooks/${wbId}/lock/heartbeat`,
        {},
      );
      assert.equal(status, 200, `heartbeat: ${JSON.stringify(body)}`);
      assert.ok(body.lock?.expiresAt, "heartbeat returned updated lock with expiresAt");
      ok("heartbeat returns updated lock");
      await stopServer();
    }

    // ---- Heartbeat by non-holder returns 409 ----
    {
      const { app } = await buildTestApp(otherId);
      await startServer(app);
      const { status } = await req(
        "POST",
        `/api/sheets/workbooks/${wbId}/lock/heartbeat`,
        {},
      );
      assert.equal(status, 409);
      ok("heartbeat by non-holder → 409 LOCK_LOST");
      await stopServer();
    }

    // ---- Save with lock and correct revision ----
    {
      const { app } = await buildTestApp(ownerId);
      await startServer(app);
      // Fetch current revision.
      const getR = await req("GET", `/api/sheets/workbooks/${wbId}`);
      const currentRevision: number = getR.body.workbook.revision;

      const snap = { sheets: [{ id: "s1", rows: [] }] };
      const { status, body } = await req("PATCH", `/api/sheets/workbooks/${wbId}`, {
        snapshot: snap,
        expectedRevision: currentRevision,
      });
      assert.equal(status, 200, `saveWithLock: ${JSON.stringify(body)}`);
      assert.equal(body.workbook?.revision, currentRevision + 1, "revision should increment");
      ok("save with correct lock + revision → 200, revision incremented");
      await stopServer();
    }

    // ---- Revision conflict: stale expectedRevision ----
    {
      const { app } = await buildTestApp(ownerId);
      await startServer(app);
      const snap = { sheets: [{ id: "s1", rows: [{ stale: true }] }] };
      // Use revision 0 which is now stale (we already saved once above).
      const { status, body } = await req("PATCH", `/api/sheets/workbooks/${wbId}`, {
        snapshot: snap,
        expectedRevision: 0,
      });
      assert.equal(status, 409, `revisionConflict: ${JSON.stringify(body)}`);
      assert.equal(body.error, "REVISION_CONFLICT");
      assert.ok(typeof body.currentRevision === "number", "currentRevision in response");
      ok("save with stale revision → 409 REVISION_CONFLICT");
      await stopServer();
    }

    // ---- Missing expectedRevision when snapshot provided ----
    {
      const { app } = await buildTestApp(ownerId);
      await startServer(app);
      const snap = { sheets: [] };
      const { status, body } = await req("PATCH", `/api/sheets/workbooks/${wbId}`, {
        snapshot: snap,
        // no expectedRevision
      });
      assert.equal(status, 400, `missingRevision: ${JSON.stringify(body)}`);
      assert.equal(body.error, "MISSING_REVISION");
      ok("save without expectedRevision → 400 MISSING_REVISION");
      await stopServer();
    }

    // ---- Release lock ----
    {
      const { app } = await buildTestApp(ownerId);
      await startServer(app);
      const { status, body } = await req("DELETE", `/api/sheets/workbooks/${wbId}/lock`);
      assert.equal(status, 200, `releaseLock: ${JSON.stringify(body)}`);
      assert.equal(body.ok, true);
      ok("owner releases lock → ok:true");

      // Confirm lock is gone.
      const { body: afterBody } = await req("GET", `/api/sheets/workbooks/${wbId}/lock`);
      assert.equal(afterBody.locked, false);
      ok("lock absent after release");
      await stopServer();
    }

    // ---- Save without a lock → 423 ----
    {
      // Lock is released; otherId tries to save without acquiring the lock.
      // (Lock guard only fires when someone else holds it — if no lock, the save
      // proceeds. Test the belt-and-braces by having OWNER hold the lock while
      // OTHER tries to save as OTHER.)
      //
      // Re-acquire as owner, then other attempts to save.
      const { app: ownerApp } = await buildTestApp(ownerId);
      await startServer(ownerApp);
      await req("POST", `/api/sheets/workbooks/${wbId}/lock`, { holderName: "Alice Owner" });
      await stopServer();

      const { app: otherApp } = await buildTestApp(otherId);
      await startServer(otherApp);
      // Fetch current revision.
      const getR = await req("GET", `/api/sheets/workbooks/${wbId}`);
      const currentRevision: number = getR.body.workbook.revision;

      const { status, body } = await req("PATCH", `/api/sheets/workbooks/${wbId}`, {
        snapshot: { sheets: [] },
        expectedRevision: currentRevision,
      });
      assert.equal(status, 423, `saveWithoutLock: ${JSON.stringify(body)}`);
      assert.equal(body.error, "LOCK_REQUIRED");
      ok("save while another holds the lock → 423 LOCK_REQUIRED");
      await stopServer();
    }

    // ---- Metadata-only update does NOT require lock or revision ----
    {
      // otherId renames the workbook — no snapshot → no lock/revision check.
      const { app } = await buildTestApp(otherId);
      await startServer(app);
      const { status, body } = await req("PATCH", `/api/sheets/workbooks/${wbId}`, {
        name: "Renamed Without Lock",
      });
      assert.equal(status, 200, `renameNoLock: ${JSON.stringify(body)}`);
      assert.equal(body.workbook?.name, "Renamed Without Lock");
      ok("metadata-only rename succeeds without holding the lock");
      await stopServer();
    }

    // ---- Expiry reclaim ----
    // Directly expire the lock in the DB and confirm the next acquire succeeds.
    {
      await db.execute(
        `UPDATE sheet_workbook_locks
            SET expires_at = NOW() - INTERVAL '1 second'
          WHERE workbook_id = '${wbId}'` as any,
      );

      const { app } = await buildTestApp(otherId);
      await startServer(app);
      const { status, body } = await req("POST", `/api/sheets/workbooks/${wbId}/lock`, {
        holderName: "Bob Other",
      });
      assert.equal(status, 200, `expiryReclaim: ${JSON.stringify(body)}`);
      assert.equal(body.acquired, true, "should acquire expired lock");
      assert.equal(body.lock?.holderUserId, otherId);
      ok("expiry reclaim: expired lock taken over by new user");
      await stopServer();
    }

    __test_resetReconciledUsers();
  });

  console.log(`\nsheets-lock: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  __test_resetReconciledUsers();
  console.error("[sheets-lock] fatal:", err);
  process.exit(1);
});
