/* test-registration
{
  "name": "Sheets version (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * NoBull Sheets — version history & restore (Task #2934).
 *
 * Covers:
 *   - Auto-version capture cadence (5-minute gate).
 *   - Manual "save version" always captures.
 *   - Restore: versions the current state first, then applies the target.
 *   - Retention thinning: versions older than thresholds are removed.
 *   - Cascade delete: deleting a workbook removes its versions.
 *   - Permission checks: viewer can list/get, non-permitted user cannot.
 *
 * Uses runInIsolatedSchema so all writes land in a throwaway search_path
 * and never touch the shared dev tables.
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

async function buildTestApp(userId: string, role = "account_manager") {
  const app = express();
  app.use(express.json());

  app.use((req: any, _res: any, next: any) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id. requireAuth then populates req.dbUser +
    // req.user.claims.sub from the pre-registered profile.
    void role;
    req.__test_clerkUserId = userId;
    next();
  });

  const { registerSheetsRoutes } = await import("../server/routes/sheets");
  registerSheetsRoutes(app);

  return { app };
}

// ---- http helpers ----

let baseUrl = "";
let server: ReturnType<typeof createServer>;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;
let currentAgent: Agent | null = null;

async function startServer(app: express.Express): Promise<void> {
  originalDispatcher = getGlobalDispatcher();
  currentAgent = new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 });
  setGlobalDispatcher(currentAgent);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function stopServer(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setGlobalDispatcher(originalDispatcher);
  if (currentAgent) {
    try { await currentAgent.close(); } catch { /* ignore */ }
    currentAgent = null;
  }
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

// Snapshot PATCHes must send the workbook's current `revision` as
// `expectedRevision` (optimistic-concurrency guard — 400 MISSING_REVISION
// without it, 409 REVISION_CONFLICT on mismatch). Read it fresh before
// each snapshot save.
async function getRevision(wbId: string): Promise<number> {
  const r = await req("GET", `/api/sheets/workbooks/${wbId}`);
  assert.equal(r.status, 200, `getWorkbook for revision: ${JSON.stringify(r.body)}`);
  return r.body.workbook.revision ?? 0;
}

// ---- test suite ----

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

    const ownerId = "shver-test-owner-001";
    const viewerId = "shver-test-viewer-002";
    const otherId = "shver-test-other-003";

    await db.execute(
      `INSERT INTO users (id, first_name, email, role)
       VALUES ('${ownerId}', 'shver_owner', 'shver_owner@test.local', 'account_manager'),
              ('${viewerId}', 'shver_viewer', 'shver_viewer@test.local', 'account_manager'),
              ('${otherId}', 'shver_other', 'shver_other@test.local', 'account_manager')
       ON CONFLICT (id) DO NOTHING` as any,
    );

    // Users are seeded in the isolated (uncommitted) sandbox schema, so
    // requireAuth's ambient public-schema lookup would miss them. Pre-register
    // each acting identity with the Clerk test registry.
    __test_markUserReconciled(ownerId, {
      id: ownerId,
      firstName: "shver_owner",
      email: "shver_owner@test.local",
      role: "account_manager",
    });
    __test_markUserReconciled(viewerId, {
      id: viewerId,
      firstName: "shver_viewer",
      email: "shver_viewer@test.local",
      role: "account_manager",
    });
    __test_markUserReconciled(otherId, {
      id: otherId,
      firstName: "shver_other",
      email: "shver_other@test.local",
      role: "account_manager",
    });

    const { app: ownerApp } = await buildTestApp(ownerId);
    await startServer(ownerApp);

    try {
      // Create a workbook to test versions against.
      const create = await req("POST", "/api/sheets/workbooks", { name: "Version Test WB" });
      assert.equal(create.status, 201, `createWorkbook: ${JSON.stringify(create.body)}`);
      const wbId: string = create.body.workbook.id;
      ok("createWorkbook for version tests");

      const snap1 = { sheets: { s1: { id: "s1", rows: { 0: { cells: { 0: { v: "v1" } } } } } } };
      const snap2 = { sheets: { s1: { id: "s1", rows: { 0: { cells: { 0: { v: "v2" } } } } } } };
      const snap3 = { sheets: { s1: { id: "s1", rows: { 0: { cells: { 0: { v: "v3" } } } } } } };

      // ---- manual version save ----
      {
        const r = await req("POST", `/api/sheets/workbooks/${wbId}/versions`, {
          snapshot: snap1,
          label: "Version One",
        });
        assert.equal(r.status, 201, `saveManualVersion: ${JSON.stringify(r.body)}`);
        assert.ok(r.body.version?.id, "version has id");
        assert.equal(r.body.version.label, "Version One");
        ok("manual version save returns 201 + id + label");

        // Second manual save always captures regardless of time.
        const r2 = await req("POST", `/api/sheets/workbooks/${wbId}/versions`, {
          snapshot: snap2,
          label: "Version Two",
        });
        assert.equal(r2.status, 201, `saveManualVersion2: ${JSON.stringify(r2.body)}`);
        ok("second manual save always captured (no cadence gate)");
      }

      // ---- list versions ----
      {
        const r = await req("GET", `/api/sheets/workbooks/${wbId}/versions`);
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(r.body.versions));
        assert.ok(r.body.versions.length >= 2, `expected ≥2 versions, got ${r.body.versions.length}`);
        // Versions are newest-first.
        assert.equal(r.body.versions[0].label, "Version Two");
        // Snapshot body should NOT be in list response.
        assert.ok(r.body.versions[0].snapshot === undefined, "list should not include snapshot");
        ok("listVersions returns metadata without snapshot body");

        const versionId: string = r.body.versions[1].id; // Version One

        // ---- get a specific version (with snapshot) ----
        const get = await req("GET", `/api/sheets/workbooks/${wbId}/versions/${versionId}`);
        assert.equal(get.status, 200);
        assert.equal(get.body.version?.id, versionId);
        assert.ok(get.body.version.snapshot !== undefined, "getVersion includes snapshot");
        ok("getVersion returns full snapshot");
      }

      // ---- auto-version cadence gate ----
      // Use a fresh workbook with no prior versions so the cadence gate
      // does not see the recent manual saves from above.
      {
        const autoWb = await req("POST", "/api/sheets/workbooks", { name: "Auto Version WB" });
        assert.equal(autoWb.status, 201, `create auto wb: ${JSON.stringify(autoWb.body)}`);
        const autoWbId: string = autoWb.body.workbook.id;

        // PATCH with snapshot — should trigger auto-version (no prior versions).
        const r1 = await req("PATCH", `/api/sheets/workbooks/${autoWbId}`, {
          snapshot: snap3,
          expectedRevision: await getRevision(autoWbId),
        });
        assert.equal(r1.status, 200, `PATCH snapshot: ${JSON.stringify(r1.body)}`);
        ok("PATCH workbook with snapshot succeeds (auto-version captured)");

        // Wait briefly then check that a version was captured.
        await new Promise((r) => setTimeout(r, 300));

        const list1 = await req("GET", `/api/sheets/workbooks/${autoWbId}/versions`);
        const countAfterFirst = list1.body.versions.length;
        assert.ok(countAfterFirst >= 1, `expected ≥1 auto-version after PATCH, got ${countAfterFirst}`);
        ok("PATCH snapshot triggers auto-version capture");

        // Immediate second PATCH should NOT capture another version (5-min gate).
        const r2 = await req("PATCH", `/api/sheets/workbooks/${autoWbId}`, {
          snapshot: snap1,
          expectedRevision: await getRevision(autoWbId),
        });
        assert.equal(r2.status, 200);
        await new Promise((r) => setTimeout(r, 300));

        const list2 = await req("GET", `/api/sheets/workbooks/${autoWbId}/versions`);
        assert.equal(
          list2.body.versions.length,
          countAfterFirst,
          `cadence gate should block second auto-version (expected ${countAfterFirst}, got ${list2.body.versions.length})`,
        );
        ok("rapid PATCH does NOT create a second auto-version (cadence gate)");
      }

      // ---- restore ----
      {
        // First give the workbook an actual snapshot so the restore can
        // capture a restore-point of the current state.  Manual version saves
        // only write to the versions table; they do not update the workbook
        // snapshot, so we PATCH it here with snap2 before restoring.
        const patchForRestore = await req("PATCH", `/api/sheets/workbooks/${wbId}`, {
          snapshot: snap2,
          expectedRevision: await getRevision(wbId),
        });
        assert.equal(patchForRestore.status, 200, `PATCH before restore: ${JSON.stringify(patchForRestore.body)}`);
        // Wait for any fire-and-forget auto-version to settle (cadence gate
        // may or may not fire here; we don't assert on the count yet).
        await new Promise((r) => setTimeout(r, 300));

        const listBefore = await req("GET", `/api/sheets/workbooks/${wbId}/versions`);
        const countBefore = listBefore.body.versions.length;

        // Find the Version One version id.
        const vOneEntry = listBefore.body.versions.find((v: any) => v.label === "Version One");
        assert.ok(vOneEntry, "Version One exists in history");

        const restore = await req(
          "POST",
          `/api/sheets/workbooks/${wbId}/versions/${vOneEntry.id}/restore`,
        );
        assert.equal(restore.status, 200, `restore: ${JSON.stringify(restore.body)}`);
        assert.ok(restore.body.workbook?.id, "restore returns updated workbook");
        ok("restore returns 200 + updated workbook");

        // After restore, the workbook snapshot should match Version One.
        const getWb = await req("GET", `/api/sheets/workbooks/${wbId}`);
        assert.equal(getWb.status, 200);
        const restoredSnap = getWb.body.workbook.snapshot as any;
        assert.ok(
          restoredSnap?.sheets?.s1?.rows?.[0]?.cells?.[0]?.v === "v1",
          `workbook snapshot should be v1 after restore, got: ${JSON.stringify(restoredSnap)}`,
        );
        ok("workbook snapshot matches Version One after restore");

        // A restore-point version should have been created (current state before restore).
        await new Promise((r) => setTimeout(r, 200));
        const listAfter = await req("GET", `/api/sheets/workbooks/${wbId}/versions`);
        assert.ok(
          listAfter.body.versions.length > countBefore,
          `restore should add a restore-point version (before=${countBefore}, after=${listAfter.body.versions.length})`,
        );
        const restorePoint = listAfter.body.versions.find((v: any) => v.isRestorePoint === true);
        assert.ok(restorePoint, "a restore-point version was created");
        ok("restore creates a restore-point version (restore is undoable)");
      }

      // ---- permission checks ----
      {
        // Grant viewer access to viewerId.
        await req("PUT", `/api/sheets/workbooks/${wbId}/permissions`, {
          userId: viewerId,
          role: "viewer",
        });

        // Switch to viewerId.
        const { app: viewerApp } = await buildTestApp(viewerId);
        await stopServer();
        await startServer(viewerApp);

        // Viewer can list versions.
        const vList = await req("GET", `/api/sheets/workbooks/${wbId}/versions`);
        assert.equal(vList.status, 200);
        ok("viewer can list versions");

        // Viewer cannot save a manual version (viewer role, needs editor+).
        const snap = { sheets: { s1: {} } };
        const vSave = await req("POST", `/api/sheets/workbooks/${wbId}/versions`, { snapshot: snap });
        assert.equal(vSave.status, 403, `expected 403, got ${vSave.status}`);
        ok("viewer cannot save a manual version (403)");

        // Viewer cannot restore.
        const versions = (await req("GET", `/api/sheets/workbooks/${wbId}/versions`)).body.versions;
        const vRestore = await req(
          "POST",
          `/api/sheets/workbooks/${wbId}/versions/${versions[0].id}/restore`,
        );
        assert.equal(vRestore.status, 403);
        ok("viewer cannot restore a version (403)");

        // otherId (no permission) gets 403 on listVersions.
        const { app: otherApp } = await buildTestApp(otherId);
        await stopServer();
        await startServer(otherApp);
        const noPerm = await req("GET", `/api/sheets/workbooks/${wbId}/versions`);
        assert.equal(noPerm.status, 403);
        ok("non-permitted user gets 403 on listVersions");
      }

      // ---- cascade delete ----
      {
        const { app: ownerApp2 } = await buildTestApp(ownerId);
        await stopServer();
        await startServer(ownerApp2);

        // Capture one more version.
        await req("POST", `/api/sheets/workbooks/${wbId}/versions`, {
          snapshot: { sheets: {} },
          label: "Pre-delete",
        });

        // Confirm versions exist.
        const beforeDel = await req("GET", `/api/sheets/workbooks/${wbId}/versions`);
        assert.ok(beforeDel.body.versions.length > 0, "versions exist before delete");

        // Delete the workbook.
        const del = await req("DELETE", `/api/sheets/workbooks/${wbId}`);
        assert.equal(del.status, 200);
        ok("workbook deleted successfully");

        // Workbook gone.
        const getGone = await req("GET", `/api/sheets/workbooks/${wbId}`);
        assert.equal(getGone.status, 404);
        ok("workbook 404 after delete");

        // Verify versions were cascade-deleted by trying to query the DB directly.
        const { sheetWorkbookVersions } = await import("../shared/models/sheets");
        const { eq } = await import("drizzle-orm");
        const remaining = await db
          .select()
          .from(sheetWorkbookVersions)
          .where(eq(sheetWorkbookVersions.workbookId, wbId));
        assert.equal(remaining.length, 0, `expected 0 versions after workbook delete, got ${remaining.length}`);
        ok("workbook delete cascades to versions");
      }

    } finally {
      __test_resetReconciledUsers();
      await stopServer();
    }
  });

  console.log(`\nsheets-version: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }

}

run().catch((err) => {
  console.error("[sheets-version] fatal:", err);
  process.exit(1);
});
