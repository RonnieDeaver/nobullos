/* test-registration
{
  "name": "NoBull Sheets — data model, storage & routes foundation (Task #2929)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "tier": "small"
}
test-registration */
/**
 * NoBull Sheets — route-level tests (Task #2929).
 *
 * Covers:
 *   - Folder CRUD (create, list, rename, delete) with ownership checks.
 *   - Workbook CRUD (create, list, get, update, delete) with
 *     ownership + permission checks.
 *   - Snapshot size guard (10 MB limit).
 *   - last-activity contract (Task #4303): 200 + id → ISO-timestamp map of
 *     the latest activity row, unknown ids omitted, literal route not
 *     shadowed by /:id.
 *   - Permission management endpoints (grant, list, revoke).
 *   - 401 on unauthenticated access.
 *
 * Uses runInIsolatedSchema so all writes are scoped to a throwaway
 * search_path and never touch the shared dev tables.
 */

import assert from "node:assert/strict";
import express from "express";
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from "undici";
import { createServer } from "http";
import { runInIsolatedSchema } from "./db-sandbox";

// ---- minimal fake-auth helpers (Clerk-era test seams) ----

// The suite must run with NODE_ENV=test so requireAuth honors the
// per-request __test_clerkUserId seam (bare `npx tsx` repros included).
process.env.NODE_ENV ||= "test";

// Clerk-era auth seam: requireAuth reads req.__test_clerkUserId under
// NODE_ENV=test, and __test_markUserReconciled pre-registers the profile so
// the middleware never looks the user up in the PUBLIC schema (this suite
// seeds users only inside its isolated schema).
function makeAuthMiddleware(userId: string) {
  return (_req: any, _res: any, next: any) => {
    _req.__test_clerkUserId = userId;
    next();
  };
}

async function buildTestApp(userId: string, role = "account_manager") {
  const { storage } = await import("../server/storage");
  const { __test_markUserReconciled } = await import(
    "../server/middlewares/requireAuth"
  );
  __test_markUserReconciled(userId, {
    id: userId,
    email: `${userId}@test.local`,
    firstName: "Tester",
    lastName: "Sheets",
    role,
  });

  const app = express();
  app.use(express.json());
  // Apply the auth seam before route handlers so requireAuth passes.
  app.use(makeAuthMiddleware(userId));

  const { registerSheetsRoutes } = await import("../server/routes/sheets");
  registerSheetsRoutes(app);

  return { app, storage };
}

// ---- helpers ----

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

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: any;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
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
    // We need a real user row for FK constraints.
    const { getDb } = await import("../server/db");
    const db = getDb();
    const ownerId = "sheets-test-owner-001";
    const otherId = "sheets-test-other-002";
    const editorId = "sheets-test-editor-003";

    // Ensure user rows exist (insert or ignore).
    await db.execute(
      `INSERT INTO users (id, first_name, email, role)
       VALUES ('${ownerId}', 'sheets_owner', 'sheets_owner@test.local', 'account_manager'),
              ('${otherId}', 'sheets_other', 'sheets_other@test.local', 'account_manager'),
              ('${editorId}', 'sheets_editor', 'sheets_editor@test.local', 'account_manager')
       ON CONFLICT (id) DO NOTHING` as any,
    );

    // Build an app acting as `ownerId`.
    const { app } = await buildTestApp(ownerId);
    await startServer(app);

    try {
      // ---- folders ----
      {
        // Create a folder.
        const { status, body } = await req("POST", "/api/sheets/folders", { name: "My Reports" });
        assert.equal(status, 201, `createFolder status: ${JSON.stringify(body)}`);
        assert.ok(body.folder?.id, "createFolder returned id");
        const folderId = body.folder.id;
        ok("createFolder returns 201 + id");

        // List folders.
        const list = await req("GET", "/api/sheets/folders");
        assert.equal(list.status, 200);
        assert.ok(Array.isArray(list.body.folders));
        assert.ok(list.body.folders.some((f: any) => f.id === folderId));
        ok("listFolders includes created folder");

        // Rename folder.
        const patch = await req("PATCH", `/api/sheets/folders/${folderId}`, { name: "Renamed" });
        assert.equal(patch.status, 200);
        assert.equal(patch.body.folder?.name, "Renamed");
        ok("renameFolder returns updated name");

        // Delete folder.
        const del = await req("DELETE", `/api/sheets/folders/${folderId}`);
        assert.equal(del.status, 200);
        assert.ok(del.body.ok);
        ok("deleteFolder returns ok:true");

        // Folder gone after delete.
        const list2 = await req("GET", "/api/sheets/folders");
        assert.equal(list2.status, 200);
        assert.ok(!list2.body.folders.some((f: any) => f.id === folderId));
        ok("folder absent after delete");
      }

      // ---- workbooks ----
      {
        // Create a workbook without snapshot.
        const { status: s1, body: b1 } = await req("POST", "/api/sheets/workbooks", { name: "Q1 Review" });
        assert.equal(s1, 201);
        assert.ok(b1.workbook?.id);
        const wbId = b1.workbook.id;
        ok("createWorkbook returns 201 + id");

        // List workbooks (owner sees it).
        const listWb = await req("GET", "/api/sheets/workbooks");
        assert.equal(listWb.status, 200);
        assert.ok(listWb.body.workbooks.some((w: any) => w.id === wbId));
        ok("listWorkbooks includes owned workbook");

        // Get workbook with snapshot.
        const getWb = await req("GET", `/api/sheets/workbooks/${wbId}`);
        assert.equal(getWb.status, 200);
        assert.equal(getWb.body.workbook.id, wbId);
        ok("getWorkbook returns full workbook");

        // Rename workbook.
        const renWb = await req("PATCH", `/api/sheets/workbooks/${wbId}`, { name: "Q1 Review v2" });
        assert.equal(renWb.status, 200);
        assert.equal(renWb.body.workbook.name, "Q1 Review v2");
        ok("updateWorkbook renames workbook");

        // Save a snapshot (expectedRevision: 0 since workbook was just created).
        const snap = { sheets: [{ id: "sheet1", rows: [] }] };
        const saveSnap = await req("PATCH", `/api/sheets/workbooks/${wbId}`, { snapshot: snap, expectedRevision: 0 });
        assert.equal(saveSnap.status, 200, `saveSnapshot: ${JSON.stringify(saveSnap.body)}`);
        ok("updateWorkbook saves snapshot");

        // Snapshot size guard — 10 MB + 1.
        const bigSnap = { data: "x".repeat(10 * 1024 * 1024 + 1) };
        const tooBig = await req("PATCH", `/api/sheets/workbooks/${wbId}`, { snapshot: bigSnap });
        assert.equal(tooBig.status, 413, `Expected 413, got ${tooBig.status}`);
        ok("snapshot > 10 MB rejected with 413");

        // ---- last-activity (literal route must win over :id param) ----

        // Zero ids → empty map (no DB call needed, must not 404).
        const laEmpty = await req("GET", "/api/sheets/workbooks/last-activity?ids=");
        assert.equal(laEmpty.status, 200, `last-activity empty ids status: ${JSON.stringify(laEmpty.body)}`);
        assert.ok(laEmpty.body.lastActivity && typeof laEmpty.body.lastActivity === "object", "lastActivity is object");
        ok("last-activity with empty ids returns 200 {lastActivity:{}}");

        // Real workbook id: must be 200 — never 404 (the literal "last-activity"
        // segment must not be captured by the /:id param route) and never 500
        // (Task #4303: the storage layer used to tuple-expand the ids array into
        // invalid SQL — `ANY(($1))` — so EVERY non-empty call errored). This call
        // also runs the activity-table ensure step on the server's normal
        // public-schema pool BEFORE the storage-level seeding below, so the
        // seeded rows land in the same table the endpoint reads (the isolated
        // schema clones no tables; only ensure-DDL could diverge).
        const la = await req("GET", `/api/sheets/workbooks/last-activity?ids=${encodeURIComponent(wbId)}`);
        assert.equal(la.status, 200, `last-activity real id status: ${JSON.stringify(la.body)}`);
        assert.ok(la.body.lastActivity && typeof la.body.lastActivity === "object", "lastActivity is object");
        ok("last-activity with real workbook id returns 200 (route not shadowed by /:id)");

        // Full contract (Task #4303): id → ISO timestamp of the LATEST activity
        // row, unknown ids omitted. Route-side activity logging is
        // fire-and-forget (racy timestamps), so seed deterministic fixtures via
        // storage on two workbooks that never receive route-side writes.
        {
          const { storage } = await import("../server/storage");
          const wbA = await storage.createSheetWorkbook({ name: "LA Fixture A", ownerId });
          const wbB = await storage.createSheetWorkbook({ name: "LA Fixture B", ownerId });
          try {
            const rowA1 = await storage.logSheetActivity({
              workbookId: wbA.id, actorId: ownerId, actorName: "Owner", action: "created",
            });
            // Distinct created_at for the DISTINCT ON latest-wins assert.
            await new Promise((r) => setTimeout(r, 10));
            const rowA2 = await storage.logSheetActivity({
              workbookId: wbA.id, actorId: ownerId, actorName: "Owner", action: "renamed",
            });
            const rowB1 = await storage.logSheetActivity({
              workbookId: wbB.id, actorId: ownerId, actorName: "Owner", action: "created",
            });
            assert.ok(
              rowA2.createdAt.getTime() > rowA1.createdAt.getTime(),
              "fixture rows have distinct timestamps",
            );

            // Single id → exactly that workbook's latest activity timestamp.
            const laA = await req(
              "GET",
              `/api/sheets/workbooks/last-activity?ids=${encodeURIComponent(wbA.id)}`,
            );
            assert.equal(laA.status, 200, `single-id status: ${JSON.stringify(laA.body)}`);
            assert.deepEqual(
              laA.body.lastActivity,
              { [wbA.id]: rowA2.createdAt.toISOString() },
              `single-id map: ${JSON.stringify(laA.body.lastActivity)}`,
            );
            ok("last-activity single id → latest timestamp for that workbook");

            // Multiple ids + an unknown id → per-workbook latest, unknown omitted.
            const ghost = "00000000-0000-4000-8000-000000000000";
            const laMulti = await req(
              "GET",
              `/api/sheets/workbooks/last-activity?ids=${encodeURIComponent([wbA.id, wbB.id, ghost].join(","))}`,
            );
            assert.equal(laMulti.status, 200, `multi-id status: ${JSON.stringify(laMulti.body)}`);
            assert.deepEqual(
              laMulti.body.lastActivity,
              {
                [wbA.id]: rowA2.createdAt.toISOString(),
                [wbB.id]: rowB1.createdAt.toISOString(),
              },
              `multi-id map: ${JSON.stringify(laMulti.body.lastActivity)}`,
            );
            ok("last-activity multi id → latest per workbook, unknown id omitted");
          } finally {
            await storage.deleteSheetWorkbook(wbA.id);
            await storage.deleteSheetWorkbook(wbB.id);
          }
        }

        // ---- permissions ----

        // Grant editor access to editorId.
        const grant = await req("PUT", `/api/sheets/workbooks/${wbId}/permissions`, {
          userId: editorId,
          role: "editor",
        });
        assert.equal(grant.status, 200);
        assert.equal(grant.body.permission?.role, "editor");
        ok("grantPermission returns permission with role=editor");

        // List permissions.
        const listPerm = await req("GET", `/api/sheets/workbooks/${wbId}/permissions`);
        assert.equal(listPerm.status, 200);
        assert.ok(listPerm.body.permissions.some((p: any) => p.userId === editorId));
        ok("listPermissions includes granted user");

        // otherId (no permission) cannot read.
        const { app: otherApp } = await buildTestApp(otherId);
        await stopServer();
        await startServer(otherApp);
        const noAccess = await req("GET", `/api/sheets/workbooks/${wbId}`);
        assert.equal(noAccess.status, 403, `Expected 403 for other user, got ${noAccess.status}`);
        ok("non-permitted user gets 403 on getWorkbook");

        // otherId cannot list (should not see the workbook).
        const otherList = await req("GET", "/api/sheets/workbooks");
        assert.equal(otherList.status, 200);
        assert.ok(!otherList.body.workbooks.some((w: any) => w.id === wbId));
        ok("non-permitted user does not see workbook in list");

        // Switch back to owner.
        const { app: ownerApp2 } = await buildTestApp(ownerId);
        await stopServer();
        await startServer(ownerApp2);

        // Revoke permission.
        const revoke = await req("DELETE", `/api/sheets/workbooks/${wbId}/permissions/${editorId}`);
        assert.equal(revoke.status, 200);
        ok("revokePermission returns ok");

        // Delete workbook.
        const delWb = await req("DELETE", `/api/sheets/workbooks/${wbId}`);
        assert.equal(delWb.status, 200);
        ok("deleteWorkbook returns ok");

        // Workbook gone.
        const getGone = await req("GET", `/api/sheets/workbooks/${wbId}`);
        assert.equal(getGone.status, 404);
        ok("workbook returns 404 after delete");
      }

      // ---- duplicate workbook ----
      {
        // Create a fresh workbook with a snapshot to duplicate.
        const { body: base } = await req("POST", "/api/sheets/workbooks", { name: "Base Workbook" });
        const baseId = base.workbook.id as string;
        const snap = { sheets: [{ id: "s1", rows: [{ id: "r1", cells: ["hello"] }] }] };
        await req("PATCH", `/api/sheets/workbooks/${baseId}`, { snapshot: snap, expectedRevision: 0 });

        // Duplicate it.
        const { status: dStatus, body: dBody } = await req(
          "POST",
          `/api/sheets/workbooks/${baseId}/duplicate`,
          { name: "Base Workbook (copy)" },
        );
        assert.equal(dStatus, 201, `duplicate status: ${JSON.stringify(dBody)}`);
        assert.ok(dBody.workbook?.id, "duplicate returned workbook id");
        assert.notEqual(dBody.workbook.id, baseId, "duplicate has a different id");
        assert.equal(dBody.workbook.name, "Base Workbook (copy)");
        ok("duplicateWorkbook returns 201 with new id and given name");

        // Both workbooks visible in list.
        const { body: listAfterDup } = await req("GET", "/api/sheets/workbooks");
        const wbIds = (listAfterDup.workbooks as any[]).map((w) => w.id);
        assert.ok(wbIds.includes(baseId), "original still in list after duplicate");
        assert.ok(wbIds.includes(dBody.workbook.id), "duplicate in list");
        ok("both original and duplicate appear in workbook list");

        // Snapshot was copied (can read it).
        const { status: snapStatus, body: snapBody } = await req(
          "GET",
          `/api/sheets/workbooks/${dBody.workbook.id}`,
        );
        assert.equal(snapStatus, 200);
        assert.deepEqual(snapBody.workbook.snapshot, snap, "snapshot matches source");
        ok("duplicate snapshot matches source workbook snapshot");
      }

      // ---- templates ----
      {
        // Create a workbook to save as template.
        const { body: tmplBase } = await req("POST", "/api/sheets/workbooks", { name: "Template Source" });
        const tmplBaseId = tmplBase.workbook.id as string;

        // Save it as a template (owner succeeds without needing CEO role).
        const { status: saveStatus, body: saveBody } = await req(
          "POST",
          `/api/sheets/workbooks/${tmplBaseId}/save-as-template`,
          { name: "My Template", description: "Reusable layout" },
        );
        assert.equal(saveStatus, 201, `save-as-template status: ${JSON.stringify(saveBody)}`);
        assert.ok(saveBody.template?.id, "save-as-template returned template id");
        assert.equal(saveBody.template.name, "My Template");
        const templateId = saveBody.template.id as string;
        ok("saveWorkbookAsTemplate returns 201 + template with id and name");

        // List templates — should include the new template.
        const { status: listTmplStatus, body: listTmplBody } = await req("GET", "/api/sheets/templates");
        assert.equal(listTmplStatus, 200);
        assert.ok(Array.isArray(listTmplBody.templates), "templates is array");
        assert.ok(
          (listTmplBody.templates as any[]).some((t: any) => t.id === templateId),
          "new template in list",
        );
        ok("listSheetTemplates includes newly created template");

        // Get individual template.
        const { status: getTmplStatus, body: getTmplBody } = await req("GET", `/api/sheets/templates/${templateId}`);
        assert.equal(getTmplStatus, 200);
        assert.equal(getTmplBody.template.id, templateId);
        ok("getSheetTemplate returns 200 + matching template");

        // Rename template.
        const { status: renameTmplStatus, body: renameTmplBody } = await req(
          "PATCH",
          `/api/sheets/templates/${templateId}`,
          { name: "Renamed Template", description: "Updated desc" },
        );
        assert.equal(renameTmplStatus, 200, `renameTemplate status: ${JSON.stringify(renameTmplBody)}`);
        assert.equal(renameTmplBody.template?.name, "Renamed Template");
        ok("updateSheetTemplate renames template");

        // Create workbook from template.
        const { status: fromTmplStatus, body: fromTmplBody } = await req(
          "POST",
          `/api/sheets/templates/${templateId}/workbook`,
          { name: "From Template WB" },
        );
        assert.equal(fromTmplStatus, 201, `createFromTemplate status: ${JSON.stringify(fromTmplBody)}`);
        assert.ok(fromTmplBody.workbook?.id, "createFromTemplate returned workbook id");
        assert.equal(fromTmplBody.workbook.name, "From Template WB");
        ok("createWorkbookFromTemplate returns 201 + new workbook");

        // Archive template.
        const { status: archiveStatus, body: archiveBody } = await req(
          "PATCH",
          `/api/sheets/templates/${templateId}`,
          { archive: true },
        );
        assert.equal(archiveStatus, 200, `archive status: ${JSON.stringify(archiveBody)}`);
        assert.ok(archiveBody.template?.archivedAt, "archivedAt is set after archive");
        ok("archiveTemplate sets archivedAt");

        // Archived template returns 410 for create-from-template.
        const { status: archivedCreateStatus } = await req(
          "POST",
          `/api/sheets/templates/${templateId}/workbook`,
          { name: "Should Fail" },
        );
        assert.equal(archivedCreateStatus, 410, "archived template returns 410");
        ok("creating workbook from archived template returns 410");

        // Archived template does NOT appear in the default list.
        const { body: listAfterArchive } = await req("GET", "/api/sheets/templates");
        const activeIds = (listAfterArchive.templates as any[]).map((t: any) => t.id);
        assert.ok(!activeIds.includes(templateId), "archived template absent from default list");
        ok("archived template excluded from default template list");

        // Archived template appears with includeArchived=true.
        const { body: listWithArchived } = await req("GET", "/api/sheets/templates?includeArchived=true");
        const allIds = (listWithArchived.templates as any[]).map((t: any) => t.id);
        assert.ok(allIds.includes(templateId), "archived template present with includeArchived=true");
        ok("archived template visible with includeArchived=true");

        // Delete template.
        const { status: deleteTmplStatus, body: deleteTmplBody } = await req(
          "DELETE",
          `/api/sheets/templates/${templateId}`,
        );
        assert.equal(deleteTmplStatus, 200, `delete template: ${JSON.stringify(deleteTmplBody)}`);
        assert.ok(deleteTmplBody.ok, "deleteTemplate returns ok:true");
        ok("deleteSheetTemplate returns 200 ok:true");

        // Template gone after delete.
        const { status: getGoneTmpl } = await req("GET", `/api/sheets/templates/${templateId}`);
        assert.equal(getGoneTmpl, 404, "deleted template returns 404");
        ok("deleted template returns 404");
      }

      // ---- server-side pagination/search/sort (Task #4488) ----
      {
        // Three uniquely-prefixed workbooks so `q` isolates this block from
        // rows created earlier in the suite.
        const names = ["PgT Alpha", "PgT Bravo", "PgT Charlie"];
        for (const name of names) {
          const { status } = await req("POST", "/api/sheets/workbooks", { name });
          assert.equal(status, 201, `create ${name}`);
        }

        const page1 = await req(
          "GET",
          "/api/sheets/workbooks?q=PgT&sort=name&dir=asc&limit=2&offset=0",
        );
        assert.equal(page1.status, 200);
        assert.equal(page1.body.total, 3, "total counts the full match set");
        assert.deepEqual(
          page1.body.workbooks.map((w: any) => w.name),
          ["PgT Alpha", "PgT Bravo"],
          "page 1 is name-asc sorted and sliced server-side",
        );
        ok("paged list returns sorted slice + full total");

        const page2 = await req(
          "GET",
          "/api/sheets/workbooks?q=PgT&sort=name&dir=asc&limit=2&offset=2",
        );
        assert.equal(page2.status, 200);
        assert.deepEqual(
          page2.body.workbooks.map((w: any) => w.name),
          ["PgT Charlie"],
          "offset walks past page 1",
        );
        assert.equal(page2.body.total, 3);
        ok("offset returns the next page with a stable total");

        // Legacy shape: no limit → full list (plus additive total).
        const legacy = await req("GET", "/api/sheets/workbooks?q=PgT");
        assert.equal(legacy.status, 200);
        assert.equal(legacy.body.workbooks.length, 3, "no-limit returns everything");
        assert.equal(legacy.body.total, 3);
        ok("omitting limit keeps the legacy full-list behavior");

        const bad = await req("GET", "/api/sheets/workbooks?limit=0");
        assert.equal(bad.status, 400, "limit below 1 is rejected");
        ok("invalid pagination params → 400");
      }

      // ---- unauthenticated access ----
      {
        // Anonymous: __test_clerkUserId = null → requireAuth returns 401.
        const bareApp = express();
        bareApp.use(express.json());
        bareApp.use((_req: any, _res: any, next: any) => {
          _req.__test_clerkUserId = null;
          next();
        });
        const { registerSheetsRoutes: reg } = await import("../server/routes/sheets");
        reg(bareApp);
        await stopServer();
        await startServer(bareApp);

        const unauth = await req("GET", "/api/sheets/workbooks");
        assert.equal(unauth.status, 401);
        ok("unauthenticated request returns 401");
      }

    } finally {
      await stopServer();
      const { __test_resetReconciledUsers } = await import(
        "../server/middlewares/requireAuth"
      );
      __test_resetReconciledUsers();
    }
  });

  console.log(`\nsheets-routes: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }

}

run().catch((err) => {
  console.error("[sheets-routes] fatal:", err);
  process.exit(1);
});
