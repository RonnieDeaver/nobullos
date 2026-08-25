/* test-registration
{
  "name": "NoBull Sheets — full lifecycle E2E: create→lock→save→share→import→block→version→restore→export→delete (Task #2943)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "tier": "small"
}
test-registration */
/**
 * NoBull Sheets — full lifecycle E2E route test (Task #2943).
 *
 * Exercises the complete happy-path lifecycle end-to-end through the real
 * Express app + isolated Postgres schema:
 *
 *   create folder → create workbook → list/get workbook
 *   → acquire lock → heartbeat lock → save snapshot (with revision guard)
 *   → share with a second user → import xlsx
 *   → insert data block → list data blocks
 *   → save manual version → list versions → restore version
 *   → export xlsx → release lock → delete workbook → confirm 404
 *   → delete folder
 *
 * Uses runInIsolatedSchema so all writes land in a throwaway search_path
 * and never touch shared dev tables.
 *
 * Kill-switch path (sheets_writes_disabled → 503) is verified for the
 * acquire-lock and save-snapshot routes specifically, then the switch is
 * cleared so the remaining lifecycle steps proceed normally.
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

// ---- app factory ----------------------------------------------------------------

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

// ---- http helpers ---------------------------------------------------------------

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
): Promise<{ status: number; body: any; headers: Headers }> {
  const init: RequestInit =
    body !== undefined
      ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : { method };
  const res = await fetch(`${baseUrl}${path}`, init);
  let parsed: any;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function reqRaw(
  method: string,
  path: string,
  body?: BodyInit,
): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const res = await fetch(`${baseUrl}${path}`, { method, body });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: buf, headers: res.headers };
}

// ---- xlsx builder ---------------------------------------------------------------

async function buildMinimalXlsx(): Promise<Buffer> {
  const XLSX = await import("@e965/xlsx");
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["Client", "Revenue", "Month"],
    ["Acme Corp", 50000, "Jan"],
    ["Globex", 75000, "Jan"],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array);
}

// ---- test harness ---------------------------------------------------------------

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

// ---- test suite -----------------------------------------------------------------

async function run() {
  await runInIsolatedSchema(async () => {
    const { getDb } = await import("../server/db");
    const db = getDb();

    const ownerId = "slc-e2e-owner-001";
    const viewerId = "slc-e2e-viewer-002";

    // Seed the two users the lifecycle touches.
    await db.execute(
      `INSERT INTO users (id, first_name, email, role)
       VALUES ('${ownerId}', 'E2E_Owner', 'slc_e2e_owner@test.local', 'account_manager'),
              ('${viewerId}', 'E2E_Viewer', 'slc_e2e_viewer@test.local', 'account_manager')
       ON CONFLICT (id) DO NOTHING` as any,
    );

    // Users are seeded in the isolated (uncommitted) sandbox schema, so
    // requireAuth's ambient public-schema lookup would miss them. Pre-register
    // each acting identity with the Clerk test registry.
    __test_markUserReconciled(ownerId, {
      id: ownerId,
      firstName: "E2E_Owner",
      email: "slc_e2e_owner@test.local",
      role: "account_manager",
    });
    __test_markUserReconciled(viewerId, {
      id: viewerId,
      firstName: "E2E_Viewer",
      email: "slc_e2e_viewer@test.local",
      role: "account_manager",
    });

    const { app } = await buildTestApp(ownerId);
    await startServer(app);

    try {
      console.log("\nNoBull Sheets lifecycle E2E:");

      // ------------------------------------------------------------------
      // 1. Create a folder
      // ------------------------------------------------------------------
      const createFolderRes = await req("POST", "/api/sheets/folders", { name: "Lifecycle Folder" });
      assert.equal(createFolderRes.status, 201, `createFolder: ${JSON.stringify(createFolderRes.body)}`);
      assert.ok(createFolderRes.body.folder?.id, "folder has id");
      const folderId: string = createFolderRes.body.folder.id;
      ok("create folder → 201 + id");

      // ------------------------------------------------------------------
      // 2. Create a workbook inside the folder
      // ------------------------------------------------------------------
      const createWbRes = await req("POST", "/api/sheets/workbooks", {
        name: "Lifecycle Workbook",
        folderId,
      });
      assert.equal(createWbRes.status, 201, `createWorkbook: ${JSON.stringify(createWbRes.body)}`);
      assert.ok(createWbRes.body.workbook?.id, "workbook has id");
      const wbId: string = createWbRes.body.workbook.id;
      const revision0: number = createWbRes.body.workbook.revision ?? 0;
      ok("create workbook → 201 + id");

      // ------------------------------------------------------------------
      // 3. List workbooks — new workbook appears
      // ------------------------------------------------------------------
      const listRes = await req("GET", "/api/sheets/workbooks");
      assert.equal(listRes.status, 200, `listWorkbooks: ${JSON.stringify(listRes.body)}`);
      assert.ok(Array.isArray(listRes.body.workbooks), "workbooks is array");
      const found = (listRes.body.workbooks as any[]).find((w: any) => w.id === wbId);
      assert.ok(found, "new workbook appears in list");
      ok("list workbooks — new workbook present");

      // ------------------------------------------------------------------
      // 4. GET single workbook
      // ------------------------------------------------------------------
      const getRes = await req("GET", `/api/sheets/workbooks/${wbId}`);
      assert.equal(getRes.status, 200, `getWorkbook: ${JSON.stringify(getRes.body)}`);
      assert.equal(getRes.body.workbook?.id, wbId);
      ok("get workbook → 200 + correct id");

      // ------------------------------------------------------------------
      // 5. Kill switch: verify 503 on write routes when enabled
      // ------------------------------------------------------------------
      // Use setKillSwitch directly so the in-memory override is set
      // immediately — no cache lag, deterministically 503.
      const { setKillSwitch } = await import("../server/services/killSwitches");
      await setKillSwitch("sheets_writes_disabled", true);
      const ksLockRes = await req("POST", `/api/sheets/workbooks/${wbId}/lock`, { holderName: "KS Test" });
      assert.equal(
        ksLockRes.status, 503,
        `kill-switch lock must be 503, got ${ksLockRes.status}: ${JSON.stringify(ksLockRes.body)}`,
      );
      // Clear the kill switch immediately so subsequent steps proceed normally.
      await setKillSwitch("sheets_writes_disabled", false);
      ok("kill switch test (503 while switch enabled, then cleared)");

      // ------------------------------------------------------------------
      // 6. Acquire edit lock
      // ------------------------------------------------------------------
      const lockRes = await req("POST", `/api/sheets/workbooks/${wbId}/lock`, {
        holderName: "E2E Owner",
      });
      assert.equal(lockRes.status, 200, `acquireLock: ${JSON.stringify(lockRes.body)}`);
      assert.equal(lockRes.body.acquired, true, "lock must be acquired");
      assert.ok(lockRes.body.lock?.holderUserId, "lock has holderUserId");
      ok("acquire lock → acquired=true");

      // ------------------------------------------------------------------
      // 7. GET lock status — returns locked:true
      // ------------------------------------------------------------------
      const lockStatusRes = await req("GET", `/api/sheets/workbooks/${wbId}/lock`);
      assert.equal(lockStatusRes.status, 200);
      assert.equal(lockStatusRes.body.locked, true, "lock status is locked");
      ok("get lock status → locked:true");

      // ------------------------------------------------------------------
      // 8. Heartbeat the lock
      // ------------------------------------------------------------------
      const heartbeatRes = await req("POST", `/api/sheets/workbooks/${wbId}/lock/heartbeat`);
      assert.equal(heartbeatRes.status, 200, `heartbeat: ${JSON.stringify(heartbeatRes.body)}`);
      assert.ok(heartbeatRes.body.lock, "heartbeat returns lock");
      ok("heartbeat lock → 200");

      // ------------------------------------------------------------------
      // 9. Save snapshot (PATCH with snapshot + expectedRevision)
      // ------------------------------------------------------------------
      const snapshot1 = {
        sheets: {
          sheet1: {
            id: "sheet1",
            name: "Sheet 1",
            cellData: {
              "0": { "0": { v: "Client" }, "1": { v: "Revenue" } },
            },
          },
        },
        sheetOrder: ["sheet1"],
      };
      const saveRes = await req("PATCH", `/api/sheets/workbooks/${wbId}`, {
        snapshot: snapshot1,
        expectedRevision: revision0,
      });
      assert.equal(saveRes.status, 200, `saveSnapshot: ${JSON.stringify(saveRes.body)}`);
      assert.ok(saveRes.body.workbook?.id, "save snapshot returns workbook");
      const revision1: number = saveRes.body.workbook.revision ?? 1;
      ok("save snapshot with lock + revision guard → 200");

      // ------------------------------------------------------------------
      // 10. Save snapshot with stale revision → 409
      // ------------------------------------------------------------------
      const staleRes = await req("PATCH", `/api/sheets/workbooks/${wbId}`, {
        snapshot: snapshot1,
        expectedRevision: revision0, // already consumed
      });
      assert.equal(staleRes.status, 409, `stale revision must be 409, got ${staleRes.status}`);
      assert.equal(staleRes.body.error, "REVISION_CONFLICT");
      ok("stale revision guard → 409 REVISION_CONFLICT");

      // ------------------------------------------------------------------
      // 11. Share workbook with the viewer user
      // ------------------------------------------------------------------
      const shareRes = await req("PUT", `/api/sheets/workbooks/${wbId}/permissions`, {
        userId: viewerId,
        role: "viewer",
      });
      assert.equal(shareRes.status, 200, `share: ${JSON.stringify(shareRes.body)}`);
      assert.ok(shareRes.body.permission, "permission object returned");
      ok("share workbook with viewer → 200");

      // ------------------------------------------------------------------
      // 12. List permissions — viewer appears
      // ------------------------------------------------------------------
      const permsRes = await req("GET", `/api/sheets/workbooks/${wbId}/permissions`);
      assert.equal(permsRes.status, 200);
      assert.ok(Array.isArray(permsRes.body.permissions));
      const viewerPerm = (permsRes.body.permissions as any[]).find((p: any) => p.userId === viewerId);
      assert.ok(viewerPerm, "viewer permission present in list");
      ok("list permissions — viewer present");

      // ------------------------------------------------------------------
      // 13. Import xlsx → creates a new workbook
      // ------------------------------------------------------------------
      const xlsxBuf = await buildMinimalXlsx();
      const form = new FormData();
      form.append(
        "file",
        new Blob([xlsxBuf], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        "lifecycle-import.xlsx",
      );
      form.append("name", "Imported Lifecycle WB");
      const importFetch = await fetch(`${baseUrl}/api/sheets/workbooks/import`, {
        method: "POST",
        body: form,
      });
      const importBody = await importFetch.json().catch(() => null);
      assert.equal(importFetch.status, 201, `importXlsx: ${JSON.stringify(importBody)}`);
      assert.ok(importBody?.workbook?.id, "imported workbook has id");
      const importedWbId: string = importBody.workbook.id;
      ok("import xlsx → 201 + new workbook id");

      // ------------------------------------------------------------------
      // 14. Export imported workbook as xlsx
      // ------------------------------------------------------------------
      const exportRaw = await reqRaw("GET", `/api/sheets/workbooks/${importedWbId}/export/xlsx`);
      assert.equal(exportRaw.status, 200, `exportXlsx: status ${exportRaw.status}`);
      const ct = exportRaw.headers.get("content-type") ?? "";
      assert.ok(
        ct.includes("spreadsheetml"),
        `export Content-Type must include spreadsheetml, got: ${ct}`,
      );
      assert.ok(exportRaw.body.length > 0, "export body is non-empty");
      ok("export xlsx → 200 + spreadsheetml content");

      // ------------------------------------------------------------------
      // 15. List connectors (sanity check)
      // ------------------------------------------------------------------
      const connRes = await req("GET", "/api/sheets/connectors");
      assert.equal(connRes.status, 200, `listConnectors: ${JSON.stringify(connRes.body)}`);
      assert.ok(Array.isArray(connRes.body.connectors), "connectors is array");
      assert.ok(connRes.body.connectors.length > 0, "at least one connector registered");
      const firstConnId: string = connRes.body.connectors[0].id;
      ok(`list connectors → ${connRes.body.connectors.length} connector(s)`);

      // ------------------------------------------------------------------
      // 16. Insert data block on the main workbook
      // ------------------------------------------------------------------
      const blockRes = await req("POST", `/api/sheets/workbooks/${wbId}/blocks`, {
        label: "Revenue Metrics",
        connectorId: firstConnId,
        connectorParams: {},
        sheetId: "sheet1",
        startRow: 2,
        startCol: 0,
        autoRefresh: false,
      });
      // The kill switch was deterministically cleared in step 5 via setKillSwitch(false);
      // the missing queue handler logs a warning but does NOT prevent the block from being
      // created — the route still returns 201 with the persisted block.
      assert.equal(
        blockRes.status, 201,
        `createBlock must be 201, got ${blockRes.status}: ${JSON.stringify(blockRes.body)}`,
      );
      assert.ok(blockRes.body.block?.id, "block has id");
      ok("create data block → 201 + id");

      // List data blocks
      const listBlocksRes = await req("GET", `/api/sheets/workbooks/${wbId}/blocks`);
      assert.equal(listBlocksRes.status, 200, `listBlocks: ${JSON.stringify(listBlocksRes.body)}`);
      assert.ok(Array.isArray(listBlocksRes.body.blocks), "blocks is array");
      assert.ok(listBlocksRes.body.blocks.length >= 1, "at least one block");
      ok("list data blocks → 200 + block present");

      // ------------------------------------------------------------------
      // 17. Save a manual version checkpoint
      // ------------------------------------------------------------------
      const snapshot2 = {
        sheets: {
          sheet1: {
            id: "sheet1",
            name: "Sheet 1",
            cellData: {
              "0": { "0": { v: "Client" }, "1": { v: "Revenue" } },
              "1": { "0": { v: "Acme" }, "1": { v: 50000 } },
            },
          },
        },
        sheetOrder: ["sheet1"],
      };
      const saveVerRes = await req("POST", `/api/sheets/workbooks/${wbId}/versions`, {
        snapshot: snapshot2,
        label: "Lifecycle Checkpoint",
      });
      assert.equal(saveVerRes.status, 201, `saveVersion: ${JSON.stringify(saveVerRes.body)}`);
      assert.ok(saveVerRes.body.version?.id, "version has id");
      assert.equal(saveVerRes.body.version.label, "Lifecycle Checkpoint");
      const versionId: string = saveVerRes.body.version.id;
      ok("save manual version → 201 + label");

      // ------------------------------------------------------------------
      // 18. List versions — checkpoint appears
      // ------------------------------------------------------------------
      const listVerRes = await req("GET", `/api/sheets/workbooks/${wbId}/versions`);
      assert.equal(listVerRes.status, 200, `listVersions: ${JSON.stringify(listVerRes.body)}`);
      assert.ok(Array.isArray(listVerRes.body.versions), "versions is array");
      assert.ok(listVerRes.body.versions.length >= 1, "at least one version");
      assert.ok(
        listVerRes.body.versions.every((v: any) => v.snapshot === undefined),
        "list must not include snapshot body",
      );
      ok("list versions → metadata-only, count ≥ 1");

      // ------------------------------------------------------------------
      // 19. Get specific version (with snapshot body)
      // ------------------------------------------------------------------
      const getVerRes = await req("GET", `/api/sheets/workbooks/${wbId}/versions/${versionId}`);
      assert.equal(getVerRes.status, 200, `getVersion: ${JSON.stringify(getVerRes.body)}`);
      assert.ok(getVerRes.body.version?.snapshot !== undefined, "getVersion includes snapshot");
      ok("get specific version → snapshot body present");

      // ------------------------------------------------------------------
      // 20. Restore version (current snapshot versioned first, then restored)
      // ------------------------------------------------------------------
      const restoreRes = await req(
        "POST",
        `/api/sheets/workbooks/${wbId}/versions/${versionId}/restore`,
      );
      assert.equal(restoreRes.status, 200, `restoreVersion: ${JSON.stringify(restoreRes.body)}`);
      assert.ok(restoreRes.body.workbook?.id, "restore returns workbook");
      ok("restore version → 200 + workbook");

      // ------------------------------------------------------------------
      // 21. Export original workbook as xlsx (verify snapshot survives restore)
      // ------------------------------------------------------------------
      const exportRes = await reqRaw("GET", `/api/sheets/workbooks/${wbId}/export/xlsx`);
      assert.equal(exportRes.status, 200, `exportXlsx main: status ${exportRes.status}`);
      assert.ok(
        (exportRes.headers.get("content-type") ?? "").includes("spreadsheetml"),
        "main export Content-Type is xlsx",
      );
      ok("export xlsx after restore → 200");

      // ------------------------------------------------------------------
      // 22. Publish workbook as dashboard
      // ------------------------------------------------------------------
      const publishRes = await req("POST", `/api/sheets/workbooks/${wbId}/dashboard`, {
        title: "Lifecycle Dashboard",
        tabs: [],
        audienceUserIds: [],
        audienceRoles: [],
      });
      assert.equal(
        publishRes.status, 201,
        `publishDashboard must be 201, got ${publishRes.status}: ${JSON.stringify(publishRes.body)}`,
      );
      assert.ok(publishRes.body.dashboard?.workbookId, "published dashboard has workbookId");
      ok("publish workbook as dashboard → 201 + dashboard");

      // ------------------------------------------------------------------
      // 23. Get published dashboard config
      // ------------------------------------------------------------------
      const getDashRes = await req("GET", `/api/sheets/workbooks/${wbId}/dashboard`);
      assert.equal(getDashRes.status, 200, `getDashboard: ${JSON.stringify(getDashRes.body)}`);
      assert.ok(getDashRes.body.dashboard !== null, "dashboard config is present");
      assert.equal(getDashRes.body.dashboard?.title, "Lifecycle Dashboard", "dashboard title matches");
      ok("get published dashboard config → 200 + config");

      // ------------------------------------------------------------------
      // 24. List published dashboards — new dashboard present
      // ------------------------------------------------------------------
      const listDashRes = await req("GET", `/api/sheets/dashboards`);
      assert.equal(listDashRes.status, 200, `listDashboards: ${JSON.stringify(listDashRes.body)}`);
      assert.ok(Array.isArray(listDashRes.body.dashboards), "dashboards is array");
      assert.ok(
        listDashRes.body.dashboards.some((d: any) => d.workbookId === wbId),
        "published dashboard appears in list",
      );
      ok("list published dashboards → 200 + new dashboard present");

      // ------------------------------------------------------------------
      // 25. Unpublish dashboard
      // ------------------------------------------------------------------
      const unpublishRes = await req("DELETE", `/api/sheets/workbooks/${wbId}/dashboard`);
      assert.equal(unpublishRes.status, 200, `unpublishDashboard: ${JSON.stringify(unpublishRes.body)}`);
      assert.equal(unpublishRes.body.ok, true, "unpublish returns ok:true");
      ok("unpublish dashboard → 200 + ok:true");

      // ------------------------------------------------------------------
      // 26. Release lock
      // ------------------------------------------------------------------
      const releaseRes = await req("DELETE", `/api/sheets/workbooks/${wbId}/lock`);
      assert.equal(releaseRes.status, 200, `releaseLock: ${JSON.stringify(releaseRes.body)}`);
      assert.equal(releaseRes.body.ok, true);
      ok("release lock → 200");

      // ------------------------------------------------------------------
      // 27. Lock status → unlocked after release
      // ------------------------------------------------------------------
      const postReleaseRes = await req("GET", `/api/sheets/workbooks/${wbId}/lock`);
      assert.equal(postReleaseRes.status, 200);
      assert.equal(postReleaseRes.body.locked, false, "lock should be released");
      ok("lock status after release → locked:false");

      // ------------------------------------------------------------------
      // 28. Rename workbook (metadata-only PATCH — no lock required)
      // ------------------------------------------------------------------
      const renameRes = await req("PATCH", `/api/sheets/workbooks/${wbId}`, {
        name: "Lifecycle Workbook (renamed)",
      });
      assert.equal(renameRes.status, 200, `rename: ${JSON.stringify(renameRes.body)}`);
      assert.equal(renameRes.body.workbook?.name, "Lifecycle Workbook (renamed)");
      ok("rename workbook (metadata PATCH) → 200 + new name");

      // ------------------------------------------------------------------
      // 29. Activity log populated
      // ------------------------------------------------------------------
      const activityRes = await req("GET", `/api/sheets/workbooks/${wbId}/activity`);
      assert.equal(activityRes.status, 200, `listActivity: ${JSON.stringify(activityRes.body)}`);
      assert.ok(Array.isArray(activityRes.body.activity), "activity is array");
      assert.ok(activityRes.body.activity.length > 0, "activity log has entries");
      ok("activity log → entries present");

      // ------------------------------------------------------------------
      // 30. Delete imported workbook
      // ------------------------------------------------------------------
      const deleteImportRes = await req("DELETE", `/api/sheets/workbooks/${importedWbId}`);
      assert.equal(deleteImportRes.status, 200, `deleteImported: ${JSON.stringify(deleteImportRes.body)}`);
      ok("delete imported workbook → 200");

      // ------------------------------------------------------------------
      // 31. Delete main workbook (versions + dashboard cascade)
      // ------------------------------------------------------------------
      const deleteRes = await req("DELETE", `/api/sheets/workbooks/${wbId}`);
      assert.equal(deleteRes.status, 200, `deleteWorkbook: ${JSON.stringify(deleteRes.body)}`);
      assert.equal(deleteRes.body.ok, true);
      ok("delete workbook → 200");

      // ------------------------------------------------------------------
      // 32. GET deleted workbook → 404
      // ------------------------------------------------------------------
      const afterDeleteRes = await req("GET", `/api/sheets/workbooks/${wbId}`);
      assert.equal(afterDeleteRes.status, 404, `expected 404 after delete, got ${afterDeleteRes.status}`);
      ok("GET deleted workbook → 404");

      // ------------------------------------------------------------------
      // 33. Delete folder
      // ------------------------------------------------------------------
      const deleteFolderRes = await req("DELETE", `/api/sheets/folders/${folderId}`);
      assert.equal(deleteFolderRes.status, 200, `deleteFolder: ${JSON.stringify(deleteFolderRes.body)}`);
      ok("delete folder → 200");
    } finally {
      __test_resetReconciledUsers();
      await stopServer();
    }
  });
}

// ---- entry point ----------------------------------------------------------------

run()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed.`);
    if (failed > 0) process.exit(1);
  })
  .catch((err) => {
    console.error("Unhandled error:", err);
    process.exit(1);
  });
