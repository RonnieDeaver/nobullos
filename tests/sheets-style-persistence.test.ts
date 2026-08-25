/* test-registration
{
  "name": "NoBull Sheets — style fields survive import → save → re-open through routes + DB (Task #3112)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3112: style persistence — proves bold/fill/borders/alignment/freeze survive the full HTTP import → DB save → re-open → live-edit-save → re-open cycle (jsonb round-trip of nested style objects). Complements the in-memory converter checks in sheets-import.test.ts.",
  "tier": "small"
}
test-registration */
/**
 * NoBull Sheets — style persistence integration test (Task #3112).
 *
 * The converter unit tests (tests/sheets-import.test.ts) already prove
 * ExcelJS styles land in the in-memory Univer snapshot. This test proves the
 * styles ALSO survive the full live flow through the real routes + DB:
 *
 *   1. POST /api/sheets/workbooks/import  (multipart, styled XLSX)
 *   2. GET  /api/sheets/workbooks/:id     (re-open — snapshot read from DB)
 *      → assert bold / italic / font size / fill color / borders /
 *        alignment+wrap / freeze panes are intact on the expected cells.
 *   3. PATCH /api/sheets/workbooks/:id    (live edit → save: mutate one cell
 *      value, keep styles, save with expectedRevision)
 *   4. GET again → assert the edited value landed AND all style fields are
 *      still intact after the second DB round-trip.
 *   5. GET /api/sheets/workbooks/:id/export/xlsx (the Download button path,
 *      Task #3190) → re-parse the downloaded bytes with ExcelJS and assert
 *      bold / italic / font size / fill / alignment+wrap / borders / freeze
 *      panes AND the edited value all made it into the exported Excel file.
 *
 * A serialization bug in the jsonb layer (dropped nested objects, key
 * mangling) would fail these assertions.
 *
 * Uses runInIsolatedSchema so all writes are scoped to a throwaway
 * search_path.
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

// ---- Clerk test-seam auth middleware (same pattern as sheets-routes.test.ts) ----

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

// ---- styled XLSX fixture (ExcelJS so styles round-trip) ----

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

// ---- style assertions, shared by the re-open and post-edit checks ----

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
  assert.equal(a1.s.bg.rgb, "#FFFF00", `${label}: A1 yellow fill intact`);
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
  assert.equal(a2.s.bd.r?.cl?.rgb, "#FF0000", `${label}: A2 right border color intact`);

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
  console.log("\nsheets-style-persistence tests:");

  await runInIsolatedSchema(async () => {
    const { getDb } = await import("../server/db");
    const db = getDb();
    const token = randomBytes(4).toString("hex");
    const ownerId = `sheets-style-owner-${token}`;

    await db.execute(
      `INSERT INTO users (id, first_name, email, role)
       VALUES ('${ownerId}', 'style_owner_${token}', 'style_owner_${token}@test.local', 'account_manager')
       ON CONFLICT (id) DO NOTHING` as any,
    );

    // User is seeded in the isolated (uncommitted) sandbox schema, so
    // requireAuth's ambient public-schema lookup would miss it. Pre-register
    // with the Clerk test registry.
    __test_markUserReconciled(ownerId, {
      id: ownerId,
      firstName: `style_owner_${token}`,
      email: `style_owner_${token}@test.local`,
      role: "account_manager",
    });

    const app = express();
    app.use(express.json({ limit: "15mb" }));
    app.use(makeAuthMiddleware(ownerId, "account_manager"));
    const { registerSheetsRoutes } = await import("../server/routes/sheets");
    registerSheetsRoutes(app);
    await startServer(app);

    try {
      // ── 1. Import styled XLSX via the real multipart route ────────────────
      let workbookId = "";
      try {
        const xlsxBuf = await buildStyledXlsx();
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(xlsxBuf)], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
          "styled-report.xlsx",
        );
        form.append("name", `Styled Report ${token}`);
        const res = await fetch(`${baseUrl}/api/sheets/workbooks/import`, {
          method: "POST",
          body: form,
        });
        const body: any = await res.json();
        assert.equal(res.status, 201, `import status: ${JSON.stringify(body)}`);
        assert.ok(body.workbook?.id, "import returned workbook id");
        workbookId = body.workbook.id;
        ok("import: styled XLSX accepted, workbook created");
      } catch (e: any) {
        fail("import styled XLSX", e.message);
        throw e; // remaining steps depend on the workbook
      }

      // ── 2. Re-open: GET the workbook, snapshot comes back from the DB ─────
      let snapshot: any;
      let revision = 0;
      try {
        const getWb = await jsonReq("GET", `/api/sheets/workbooks/${workbookId}`);
        assert.equal(getWb.status, 200, `get status: ${JSON.stringify(getWb.body)}`);
        snapshot = getWb.body.workbook?.snapshot;
        revision = getWb.body.workbook?.revision ?? 0;
        assertStylesIntact(snapshot, "after import");
        ok("re-open after import: bold/italic/size/fill/alignment/borders/freeze all intact");
      } catch (e: any) {
        fail("re-open after import", e.message);
        throw e;
      }

      // ── 3. Live edit → save: change one value, keep styles, PATCH back ────
      try {
        const sheet: any = Object.values(snapshot.sheets)[0];
        // Simulate a user editing B2's value in the editor (styles untouched).
        sheet.cellData[1][1] = { ...(sheet.cellData[1][1] ?? {}), v: 999 };
        const save = await jsonReq("PATCH", `/api/sheets/workbooks/${workbookId}`, {
          snapshot,
          expectedRevision: revision,
        });
        assert.equal(save.status, 200, `save status: ${JSON.stringify(save.body)}`);
        ok("live edit → save: PATCH with edited snapshot accepted");
      } catch (e: any) {
        fail("live edit → save", e.message);
        throw e;
      }

      // ── 4. Re-open again: styles survive the second DB round-trip ─────────
      try {
        const getWb2 = await jsonReq("GET", `/api/sheets/workbooks/${workbookId}`);
        assert.equal(getWb2.status, 200, `get2 status: ${JSON.stringify(getWb2.body)}`);
        const snap2 = getWb2.body.workbook?.snapshot;
        const sheet2 = assertStylesIntact(snap2, "after edit+save");
        assert.equal(sheet2.cellData[1][1]?.v, 999, "edited value persisted");
        assert.equal(sheet2.cellData[0][0]?.v, "Revenue", "untouched value persisted");
        ok("re-open after edit+save: edited value landed AND all styles still intact");
      } catch (e: any) {
        fail("re-open after edit+save", e.message);
      }

      // ── 5. Download: export route → re-parse XLSX → styles survived ───────
      try {
        const res = await fetch(
          `${baseUrl}/api/sheets/workbooks/${workbookId}/export/xlsx`,
        );
        assert.equal(res.status, 200, `export status ${res.status}`);
        const ct = res.headers.get("content-type") ?? "";
        assert.ok(
          ct.includes("spreadsheetml.sheet"),
          `export content-type is xlsx: ${ct}`,
        );
        const disposition = res.headers.get("content-disposition") ?? "";
        assert.ok(
          disposition.includes("attachment") && disposition.includes(".xlsx"),
          `export content-disposition: ${disposition}`,
        );
        const outBuf = Buffer.from(await res.arrayBuffer());
        assert.ok(outBuf.length > 0, "export returned non-empty body");

        // Re-parse the downloaded file with ExcelJS (what Excel would open).
        const ejsMod = await import("exceljs");
        const ExcelJS: any = (ejsMod as any).default ?? ejsMod;
        const outWb = new ExcelJS.Workbook();
        await outWb.xlsx.load(outBuf);
        const outWs = outWb.worksheets[0];
        assert.ok(outWs, "downloaded workbook has a worksheet");

        // A1 — bold / italic / size / fill / alignment / wrap.
        const a1 = outWs.getCell("A1");
        assert.equal(a1.value, "Revenue", "download: A1 value intact");
        assert.equal(a1.font?.bold, true, "download: A1 bold survived");
        assert.equal(a1.font?.italic, true, "download: A1 italic survived");
        assert.equal(a1.font?.size, 14, "download: A1 font size survived");
        assert.equal(a1.fill?.type, "pattern", "download: A1 fill type survived");
        assert.equal(
          String((a1.fill as any)?.fgColor?.argb ?? "").toUpperCase(),
          "FFFFFF00",
          "download: A1 yellow fill survived",
        );
        assert.equal(a1.alignment?.horizontal, "center", "download: A1 h-align survived");
        assert.equal(a1.alignment?.vertical, "middle", "download: A1 v-align survived");
        assert.equal(a1.alignment?.wrapText, true, "download: A1 wrap survived");

        // A2 — per-side borders (style + color).
        const a2 = outWs.getCell("A2");
        assert.equal(a2.value, 1234, "download: A2 value intact");
        assert.equal(a2.border?.top?.style, "thin", "download: A2 top border survived");
        assert.equal(a2.border?.left?.style, "thin", "download: A2 left border survived");
        assert.equal(a2.border?.bottom?.style, "medium", "download: A2 bottom border survived");
        assert.equal(a2.border?.right?.style, "thick", "download: A2 right border survived");
        assert.equal(
          String(a2.border?.right?.color?.argb ?? "").toUpperCase(),
          "FFFF0000",
          "download: A2 right border color survived",
        );

        // Edited value (step 3's PATCH) made it into the download too.
        const b2 = outWs.getCell("B2");
        assert.equal(b2.value, 999, "download: edited B2 value survived");

        // Freeze panes.
        const views: any[] = outWs.views ?? [];
        const frozen = views.find(
          (v: any) => v.state === "frozen" || v.state === "frozenSplit",
        );
        assert.ok(frozen, "download: frozen view present");
        assert.equal(frozen.ySplit, 1, "download: freeze ySplit survived");

        ok("download: exported XLSX keeps bold/italic/size/fill/alignment/borders/freeze + edited value");
      } catch (e: any) {
        fail("download export xlsx", e.message);
      }
    } finally {
      __test_resetReconciledUsers();
      await stopServer();
    }
  });

  console.log(`\nsheets-style-persistence: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[sheets-style-persistence] fatal:", err);
  process.exit(1);
});
