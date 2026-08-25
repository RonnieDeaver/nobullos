/* test-registration
{
  "name": "NoBull Sheets — restoring an older version brings back its styling (Task #3191)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3191: version restore styling — proves nested style objects (borders, fill, alignment, freeze) survive save-version → restore → re-open through the versions-table jsonb layer, with a destructive unstyled edit in between so a trivially-passing restore can't hide a drop.",
  "tier": "small"
}
test-registration */
/**
 * NoBull Sheets — restoring an older version brings back its styling (Task #3191).
 *
 * tests/sheets-style-persistence.test.ts proves styles survive the workbook
 * save/re-open cycle. tests/sheets-version.test.ts proves the version routes
 * work — but only with unstyled snapshots. This test closes the gap: nested
 * style objects (borders, fill colors, alignment, freeze config) must survive
 * the save-version → restore → re-open cycle through the versions table's
 * jsonb layer.
 *
 * Flow:
 *   1. POST /api/sheets/workbooks/import  (styled XLSX fixture — same styles
 *      as sheets-style-persistence.test.ts)
 *   2. POST .../versions                  (manual "Styled baseline" version
 *      of the styled snapshot)
 *   3. PATCH the workbook with an UNSTYLED snapshot (destructive edit that
 *      strips every style — proves the later assertions can't pass trivially)
 *   4. GET the workbook → confirm styles are actually gone
 *   5. POST .../versions/:id/restore      (restore the styled baseline)
 *   6. GET the workbook → assert bold / italic / size / fill / alignment /
 *      wrap / borders / freeze are ALL back on the expected cells
 *   7. GET .../versions/:id → assert the stored version snapshot itself still
 *      carries the styles (direct jsonb round-trip of the versions row)
 *
 * Uses runInIsolatedSchema so all writes land in a throwaway search_path.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express from "express";
import { getGlobalDispatcher, setGlobalDispatcher, Agent } from "undici";
import { createServer } from "http";
import { randomBytes } from "node:crypto";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

// ---- Clerk test-seam auth middleware (same pattern as sheets-style-persistence.test.ts) ----

function makeAuthMiddleware(userId: string, role: string) {
  return (_req: any, _res: any, next: any) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id. requireAuth populates req.dbUser +
    // req.user.claims.sub from the pre-registered profile.
    void role;
    _req.__test_clerkUserId = userId;
    next();
  };
}

// ---- server plumbing ----

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

async function jsonReq(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: any;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

// ---- styled XLSX fixture (same styles as sheets-style-persistence.test.ts) ----

async function buildStyledXlsx(): Promise<Buffer> {
  const ejsMod = await import("exceljs");
  const ExcelJS: any = (ejsMod as any).default ?? ejsMod;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("StyledSheet");

  // Row 1 — header: bold+italic, size 14, yellow fill, centered + wrapped.
  const header = ws.addRow(["Revenue", "Cost"]);
  const a1 = header.getCell(1);
  a1.font = { bold: true, italic: true, size: 14, name: "Calibri" };
  a1.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
  a1.alignment = { horizontal: "center", vertical: "middle", wrapText: true };

  // Row 2 — data: bordered cell.
  const data = ws.addRow([1234, 567]);
  const a2 = data.getCell(1);
  a2.border = {
    top: { style: "thin", color: { argb: "FF000000" } },
    left: { style: "thin", color: { argb: "FF000000" } },
    bottom: { style: "medium", color: { argb: "FF000000" } },
    right: { style: "thick", color: { argb: "FFFF0000" } },
  };

  // Freeze the header row.
  ws.views = [{ state: "frozen", xSplit: 0, ySplit: 1, topLeftCell: "A2" }];

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}

// ---- style assertions (mirrors sheets-style-persistence.test.ts) ----

function assertStylesIntact(snapshot: any, label: string) {
  assert.ok(snapshot, `${label}: snapshot present`);
  assert.ok(snapshot.sheets, `${label}: snapshot.sheets present`);
  const sheet: any = Object.values(snapshot.sheets)[0];
  assert.ok(sheet, `${label}: first sheet present`);
  assert.ok(sheet.cellData, `${label}: cellData present`);

  // A1 — bold / italic / font size / fill / alignment / wrap.
  const a1 = sheet.cellData[0]?.[0];
  assert.ok(a1, `${label}: A1 exists`);
  assert.equal(a1.s?.bl, 1, `${label}: A1 bold intact`);
  assert.equal(a1.s?.it, 1, `${label}: A1 italic intact`);
  assert.equal(a1.s?.fs, 14, `${label}: A1 font size intact`);
  assert.ok(a1.s?.bg, `${label}: A1 fill present`);
  assert.equal(a1.s.bg.rgb, "#FFFF00", `${label}: A1 yellow fill intact (Univer #-prefixed hex)`);
  assert.equal(a1.s?.ht, 2, `${label}: A1 horizontal center intact`);
  assert.equal(a1.s?.vt, 2, `${label}: A1 vertical middle intact`);
  assert.equal(a1.s?.tb, 2, `${label}: A1 wrap text intact`);

  // A2 — borders (nested objects: bd.{t,l,b,r}.{s,cl.rgb}).
  const a2 = sheet.cellData[1]?.[0];
  assert.ok(a2, `${label}: A2 exists`);
  assert.ok(a2.s?.bd, `${label}: A2 border object intact`);
  assert.equal(a2.s.bd.t?.s, 1, `${label}: A2 top border thin intact`);
  assert.ok(a2.s.bd.l, `${label}: A2 left border intact`);
  assert.equal(a2.s.bd.b?.s, 10, `${label}: A2 bottom border medium intact`);
  assert.equal(a2.s.bd.r?.s, 12, `${label}: A2 right border thick intact`);
  assert.equal(a2.s.bd.r?.cl?.rgb, "#FF0000", `${label}: A2 right border color intact (Univer #-prefixed hex)`);

  // Freeze panes.
  assert.ok(sheet.freeze, `${label}: freeze config intact`);
  assert.equal(sheet.freeze.ySplit, 1, `${label}: freeze ySplit intact`);

  return sheet;
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
  console.log("\nsheets-version-style-restore tests:");

  await runInIsolatedSchema(async () => {
    const { getDb } = await import("../server/db");
    const db = getDb();
    const token = randomBytes(4).toString("hex");
    const ownerId = `sheets-verstyle-owner-${token}`;

    await db.execute(
      `INSERT INTO users (id, first_name, email, role)
       VALUES ('${ownerId}', 'verstyle_owner_${token}', 'verstyle_owner_${token}@test.local', 'account_manager')
       ON CONFLICT (id) DO NOTHING` as any,
    );

    // User is seeded in the isolated (uncommitted) sandbox schema, so
    // requireAuth's ambient public-schema lookup would miss it. Pre-register
    // with the Clerk test registry.
    __test_markUserReconciled(ownerId, {
      id: ownerId,
      firstName: `verstyle_owner_${token}`,
      email: `verstyle_owner_${token}@test.local`,
      role: "account_manager",
    });

    const app = express();
    app.use(express.json({ limit: "15mb" }));
    app.use(makeAuthMiddleware(ownerId, "account_manager"));
    const { registerSheetsRoutes } = await import("../server/routes/sheets");
    registerSheetsRoutes(app);
    await startServer(app);

    try {
      // ── 1. Import styled XLSX ────────────────────────────────────────────
      let workbookId = "";
      let styledSnapshot: any;
      let revision = 0;
      try {
        const xlsxBuf = await buildStyledXlsx();
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(xlsxBuf)], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
          "styled-restore.xlsx",
        );
        form.append("name", `Styled Restore ${token}`);
        const res = await fetch(`${baseUrl}/api/sheets/workbooks/import`, {
          method: "POST",
          body: form,
        });
        const body: any = await res.json();
        assert.equal(res.status, 201, `import status: ${JSON.stringify(body)}`);
        workbookId = body.workbook.id;

        const getWb = await jsonReq("GET", `/api/sheets/workbooks/${workbookId}`);
        assert.equal(getWb.status, 200, `get status: ${JSON.stringify(getWb.body)}`);
        styledSnapshot = getWb.body.workbook?.snapshot;
        revision = getWb.body.workbook?.revision ?? 0;
        assertStylesIntact(styledSnapshot, "after import");
        ok("import: styled workbook created with all style fields intact");
      } catch (e: any) {
        fail("import styled XLSX", e.message);
        throw e;
      }

      // ── 2. Save a manual version of the styled snapshot ─────────────────
      let styledVersionId = "";
      try {
        const save = await jsonReq("POST", `/api/sheets/workbooks/${workbookId}/versions`, {
          snapshot: styledSnapshot,
          label: "Styled baseline",
        });
        assert.equal(save.status, 201, `saveVersion status: ${JSON.stringify(save.body)}`);
        styledVersionId = save.body.version?.id;
        assert.ok(styledVersionId, "version id returned");
        ok("manual version of the styled snapshot saved");
      } catch (e: any) {
        fail("save styled version", e.message);
        throw e;
      }

      // ── 3. Destructive edit: PATCH an UNSTYLED snapshot ─────────────────
      try {
        const sheetId: string = Object.keys(styledSnapshot.sheets)[0];
        const unstyledSnapshot = {
          ...styledSnapshot,
          sheets: {
            [sheetId]: {
              id: sheetId,
              name: "StyledSheet",
              cellData: {
                0: { 0: { v: "Revenue" }, 1: { v: "Cost" } },
                1: { 0: { v: 1234 }, 1: { v: 567 } },
              },
              // no styles, no freeze — every style field stripped
            },
          },
        };
        const patch = await jsonReq("PATCH", `/api/sheets/workbooks/${workbookId}`, {
          snapshot: unstyledSnapshot,
          expectedRevision: revision,
        });
        assert.equal(patch.status, 200, `patch status: ${JSON.stringify(patch.body)}`);
        ok("destructive edit saved (styles stripped from current snapshot)");
      } catch (e: any) {
        fail("destructive unstyled edit", e.message);
        throw e;
      }

      // ── 4. Confirm the styles are actually gone before restoring ────────
      try {
        const getWb = await jsonReq("GET", `/api/sheets/workbooks/${workbookId}`);
        assert.equal(getWb.status, 200);
        const snap = getWb.body.workbook?.snapshot;
        const sheet: any = Object.values(snap.sheets)[0];
        const a1 = sheet.cellData?.[0]?.[0];
        assert.ok(a1, "A1 still exists after unstyled edit");
        assert.equal(a1.s, undefined, "A1 has no style after destructive edit");
        assert.equal(sheet.freeze, undefined, "freeze config gone after destructive edit");
        ok("pre-restore check: current snapshot really is unstyled (no trivial pass)");
      } catch (e: any) {
        fail("pre-restore unstyled check", e.message);
        throw e;
      }

      // ── 5. Restore the styled baseline version ──────────────────────────
      try {
        const restore = await jsonReq(
          "POST",
          `/api/sheets/workbooks/${workbookId}/versions/${styledVersionId}/restore`,
        );
        assert.equal(restore.status, 200, `restore status: ${JSON.stringify(restore.body)}`);
        assert.ok(restore.body.workbook?.id, "restore returned updated workbook");
        ok("restore of styled baseline returned 200");
      } catch (e: any) {
        fail("restore styled version", e.message);
        throw e;
      }

      // ── 6. Re-open: styles are back on the expected cells ───────────────
      try {
        const getWb = await jsonReq("GET", `/api/sheets/workbooks/${workbookId}`);
        assert.equal(getWb.status, 200, `get-after-restore status: ${JSON.stringify(getWb.body)}`);
        const restored = getWb.body.workbook?.snapshot;
        const sheet = assertStylesIntact(restored, "after restore");
        assert.equal(sheet.cellData[0][0]?.v, "Revenue", "A1 value restored");
        assert.equal(sheet.cellData[1][0]?.v, 1234, "A2 value restored");
        ok("re-open after restore: bold/italic/size/fill/alignment/borders/freeze ALL restored");
      } catch (e: any) {
        fail("re-open after restore", e.message);
      }

      // ── 7. The stored version row itself still carries the styles ───────
      try {
        const getVer = await jsonReq(
          "GET",
          `/api/sheets/workbooks/${workbookId}/versions/${styledVersionId}`,
        );
        assert.equal(getVer.status, 200, `getVersion status: ${JSON.stringify(getVer.body)}`);
        assertStylesIntact(getVer.body.version?.snapshot, "stored version row");
        ok("stored version snapshot (versions-table jsonb) still carries all styles");
      } catch (e: any) {
        fail("stored version snapshot styles", e.message);
      }
    } finally {
      __test_resetReconciledUsers();
      await stopServer();
    }
  });

  console.log(`\nsheets-version-style-restore: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[sheets-version-style-restore] fatal:", err);
  process.exit(1);
});
