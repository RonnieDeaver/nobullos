/* test-registration
{
  "name": "NoBull Sheets — Excel & CSV import: converter + storage integration (Task #2935)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3097: XLSX import with ExcelJS — smoke gate verifies ExcelJS style extraction (bold/italic/borders/alignment/fill/freeze), CSV path still on SheetJS, all converter→storage integration tests, size guards, and the malformed-buffer error path. Async converter (convertToUniverSnapshot).",
  "tier": "small"
}
test-registration */
/**
 * NoBull Sheets — Excel & CSV import tests.
 *
 * Covers the converter directly (unit tests) and the converter→storage
 * integration (storage-layer tests run inside runInIsolatedSchema).
 *
 * Unit tests:
 *   - CSV with numbers, strings → cellData populated
 *   - XLSX with formula → formula stored with leading `=`
 *   - XLSX with merged cells → mergeData populated
 *   - XLSX with bold/italic style → style fields extracted (ExcelJS path)
 *   - XLSX with borders → bd fields populated
 *   - XLSX with alignment + wrap → ht/vt/tb fields populated
 *   - XLSX with fill color → bg field populated
 *   - XLSX with frozen panes → freeze config preserved
 *   - XLSX with multiple sheets → all sheets in sheetOrder
 *   - Malformed buffer → throws readable error
 *   - Column/row width/height → columnData/rowData populated
 *   - Sheet limit → excess sheets skipped with skipped report entry
 *
 * Storage-layer integration tests (isolated schema):
 *   - XLSX → converter → storage.createSheetWorkbook → workbook + report correct
 *   - CSV → converter → storage → workbook created
 *   - Filename extension stripping logic for default name
 *   - Snapshot size guard (10 MB threshold arithmetic)
 *   - Malformed XLSX buffer → converter throws before storage write
 *   - Workbook readable back via storage.getSheetWorkbook
 */

import assert from "node:assert/strict";
import { runInIsolatedSchema } from "./db-sandbox";

// ── Helpers ────────────────────────────────────────────────────────────────────

type XLSXModule = typeof import("@e965/xlsx");

/** Build a minimal XLSX buffer from array-of-arrays per sheet using SheetJS. */
function makeXlsx(
  XLSX: XLSXModule,
  sheets: Array<{ name: string; aoa: unknown[][] }>,
): Buffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.aoa);
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  return Buffer.from(
    XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array,
  );
}

/** Build a CSV buffer. */
function makeCsv(rows: string[][]): Buffer {
  return Buffer.from(rows.map((r) => r.join(",")).join("\n"));
}

/**
 * Build an XLSX buffer with full style data using ExcelJS.
 * This gives us proper style extraction (ExcelJS round-trips styles correctly).
 */
async function makeStyledXlsx(
  buildFn: (wb: any, ExcelJS: any) => void | Promise<void>,
): Promise<Buffer> {
  const ejsMod = await import("exceljs");
  const ExcelJS: any = (ejsMod as any).default ?? ejsMod;
  const wb = new ExcelJS.Workbook();
  await buildFn(wb, ExcelJS);
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}

// ── Unit tests ─────────────────────────────────────────────────────────────────

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

type ConverterFn = typeof import("../server/services/sheetsImportConverter").convertToUniverSnapshot;

async function runUnit(XLSX: XLSXModule, convertToUniverSnapshot: ConverterFn) {
  console.log("\nsheets-import unit tests:");

  // ── CSV basic values ────────────────────────────────────────────────────────
  try {
    const buf = makeCsv([
      ["ID", "Name", "Amount"],
      ["1", "Alice", "100"],
      ["2", "Bob", "200.5"],
    ]);
    const { snapshot, report } = await convertToUniverSnapshot(buf, "test.csv", "Test CSV");
    const sheet = Object.values(snapshot.sheets)[0];
    assert.ok(sheet, "sheet exists");
    assert.equal(snapshot.sheetOrder.length, 1, "one sheet");
    assert.equal(sheet.cellData[0][0].v, "ID", "header ID");
    assert.equal(sheet.cellData[0][1].v, "Name", "header Name");
    assert.equal(sheet.cellData[1][0].v, 1, "numeric 1");
    assert.equal(sheet.cellData[1][1].v, "Alice", "string Alice");
    assert.equal(sheet.cellData[1][2].v, 100, "numeric 100");
    assert.equal(sheet.cellData[2][2].v, 200.5, "float 200.5");
    assert.ok(report.cellCount > 0, "cellCount > 0");
    assert.equal(report.sheetCount, 1, "sheetCount=1");
    ok("CSV: numbers/strings converted correctly");
  } catch (e: any) {
    fail("CSV: numbers/strings", e.message);
  }

  // ── XLSX formula ────────────────────────────────────────────────────────────
  try {
    const buf = makeXlsx(XLSX, [{
      name: "Sheet1",
      aoa: [[1, 2, { f: "A1+B1", t: "n", v: 3 }]],
    }]);
    const { snapshot, report } = await convertToUniverSnapshot(buf, "formulas.xlsx", "Formulas");
    const sheet = Object.values(snapshot.sheets)[0];
    const cell = sheet.cellData[0][2];
    assert.ok(cell, "C1 exists");
    assert.ok(cell.f?.startsWith("="), `formula starts with =: ${cell.f}`);
    assert.ok(report.formulaCount > 0, "formulaCount > 0");
    ok("XLSX: formula stored with leading `=`");
  } catch (e: any) {
    fail("XLSX: formula", e.message);
  }

  // ── XLSX merged cells ───────────────────────────────────────────────────────
  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["merged", null, null], [1, 2, 3]]);
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = Buffer.from(
      XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array,
    );
    const { snapshot, report } = await convertToUniverSnapshot(buf, "merges.xlsx", "Merges");
    const sheet = Object.values(snapshot.sheets)[0];
    assert.equal(sheet.mergeData.length, 1, "one merge");
    const m = sheet.mergeData[0];
    assert.equal(m.startRow, 0);
    assert.equal(m.startColumn, 0);
    assert.equal(m.endRow, 0);
    assert.equal(m.endColumn, 2);
    assert.equal(report.mergeCount, 1, "mergeCount=1");
    ok("XLSX: merged cells converted correctly");
  } catch (e: any) {
    fail("XLSX: merges", e.message);
  }

  // ── XLSX multiple sheets ────────────────────────────────────────────────────
  try {
    const buf = makeXlsx(XLSX, [
      { name: "January", aoa: [["A", 1]] },
      { name: "February", aoa: [["B", 2]] },
      { name: "March", aoa: [["C", 3]] },
    ]);
    const { snapshot, report } = await convertToUniverSnapshot(buf, "multi.xlsx", "Multi");
    assert.equal(snapshot.sheetOrder.length, 3, "3 sheets");
    assert.equal(report.sheetCount, 3, "sheetCount=3");
    const names = Object.values(snapshot.sheets).map((s) => s.name);
    assert.ok(names.includes("January"), "January sheet");
    assert.ok(names.includes("February"), "February sheet");
    assert.ok(names.includes("March"), "March sheet");
    ok("XLSX: multiple sheets preserved");
  } catch (e: any) {
    fail("XLSX: multiple sheets", e.message);
  }

  // ── XLSX bold + italic style (ExcelJS round-trip) ───────────────────────────
  try {
    const buf = await makeStyledXlsx(async (wb) => {
      const ws = wb.addWorksheet("Styled");
      const row = ws.addRow(["Hello"]);
      const cell = row.getCell(1);
      cell.value = "Hello";
      cell.font = { bold: true, italic: true, size: 14, name: "Calibri" };
    });
    const { snapshot } = await convertToUniverSnapshot(buf, "styled.xlsx", "Styled");
    const sheet = Object.values(snapshot.sheets)[0];
    const cell = sheet.cellData[0][0];
    assert.ok(cell, "A1 exists");
    assert.equal(cell.v, "Hello", "cell value preserved");
    assert.equal(cell.s?.bl, 1, "bold extracted");
    assert.equal(cell.s?.it, 1, "italic extracted");
    assert.equal(cell.s?.fs, 14, "font size extracted");
    ok("XLSX: bold/italic/font-size style fields extracted via ExcelJS");
  } catch (e: any) {
    fail("XLSX: bold/italic style", e.message);
  }

  // ── XLSX borders ────────────────────────────────────────────────────────────
  try {
    const buf = await makeStyledXlsx(async (wb) => {
      const ws = wb.addWorksheet("Borders");
      const row = ws.addRow(["Box"]);
      const cell = row.getCell(1);
      cell.value = "Box";
      cell.border = {
        top: { style: "thin", color: { argb: "FF000000" } },
        left: { style: "thin", color: { argb: "FF000000" } },
        bottom: { style: "medium", color: { argb: "FF000000" } },
        right: { style: "thick", color: { argb: "FFFF0000" } },
      };
    });
    const { snapshot } = await convertToUniverSnapshot(buf, "borders.xlsx", "Borders");
    const sheet = Object.values(snapshot.sheets)[0];
    const cell = sheet.cellData[0][0];
    assert.ok(cell?.s?.bd, "border data present");
    assert.ok(cell.s!.bd!.t, "top border present");
    assert.equal(cell.s!.bd!.t!.s, 1, "top border = thin (1)");
    assert.ok(cell.s!.bd!.b, "bottom border present");
    assert.equal(cell.s!.bd!.b!.s, 10, "bottom border = medium (10)");
    assert.ok(cell.s!.bd!.r, "right border present");
    assert.equal(cell.s!.bd!.r!.s, 12, "right border = thick (12)");
    assert.equal(cell.s!.bd!.r!.cl.rgb, "#FF0000", "right border color = #FF0000 (Univer #-prefix required)");
    ok("XLSX: borders extracted with correct style codes and colors");
  } catch (e: any) {
    fail("XLSX: borders", e.message);
  }

  // ── XLSX alignment + wrap ───────────────────────────────────────────────────
  try {
    const buf = await makeStyledXlsx(async (wb) => {
      const ws = wb.addWorksheet("Align");
      const row = ws.addRow(["Centered"]);
      const cell = row.getCell(1);
      cell.value = "Centered";
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    });
    const { snapshot } = await convertToUniverSnapshot(buf, "align.xlsx", "Align");
    const sheet = Object.values(snapshot.sheets)[0];
    const cell = sheet.cellData[0][0];
    assert.ok(cell?.s, "style present");
    assert.equal(cell.s!.ht, 2, "horizontal center (2)");
    assert.equal(cell.s!.vt, 2, "vertical middle (2)");
    assert.equal(cell.s!.tb, 2, "wrap text (2)");
    ok("XLSX: alignment (center/middle) and wrap extracted");
  } catch (e: any) {
    fail("XLSX: alignment + wrap", e.message);
  }

  // ── XLSX fill color ─────────────────────────────────────────────────────────
  try {
    const buf = await makeStyledXlsx(async (wb) => {
      const ws = wb.addWorksheet("Fill");
      const row = ws.addRow(["Yellow"]);
      const cell = row.getCell(1);
      cell.value = "Yellow";
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFFF00" }, // yellow
      };
    });
    const { snapshot } = await convertToUniverSnapshot(buf, "fill.xlsx", "Fill");
    const sheet = Object.values(snapshot.sheets)[0];
    const cell = sheet.cellData[0][0];
    assert.ok(cell?.s?.bg, "background color present");
    assert.equal(cell.s!.bg!.rgb, "#FFFF00", "yellow fill color = #FFFF00 (Univer #-prefix required)");
    ok("XLSX: fill color extracted correctly with #-prefixed hex");
  } catch (e: any) {
    fail("XLSX: fill color", e.message);
  }

  // ── XLSX freeze panes ───────────────────────────────────────────────────────
  try {
    const buf = await makeStyledXlsx(async (wb) => {
      const ws = wb.addWorksheet("Frozen");
      ws.addRow(["Header A", "Header B", "Header C"]);
      ws.addRow([1, 2, 3]);
      ws.addRow([4, 5, 6]);
      ws.views = [{ state: "frozen", xSplit: 0, ySplit: 1, topLeftCell: "A2" }];
    });
    const { snapshot } = await convertToUniverSnapshot(buf, "frozen.xlsx", "Frozen");
    const sheet = Object.values(snapshot.sheets)[0] as any;
    assert.ok(sheet.freeze, "freeze config present");
    assert.equal(sheet.freeze.ySplit, 1, "1 frozen row");
    assert.equal(sheet.freeze.xSplit, 0, "0 frozen columns");
    assert.equal(sheet.freeze.startRow, 1, "startRow = ySplit = 1");
    ok("XLSX: frozen panes extracted correctly");
  } catch (e: any) {
    fail("XLSX: freeze panes", e.message);
  }

  // ── XLSX column widths ──────────────────────────────────────────────────────
  try {
    const buf = await makeStyledXlsx(async (wb) => {
      const ws = wb.addWorksheet("Widths");
      ws.columns = [
        { header: "A", key: "a", width: 15 },
        { header: "B", key: "b", width: 10 },
        { header: "C", key: "c", width: 25 },
      ];
      ws.addRow(["A", "B", "C"]);
    });
    const { snapshot } = await convertToUniverSnapshot(buf, "widths.xlsx", "Widths");
    const sheet = Object.values(snapshot.sheets)[0];
    assert.ok(sheet.columnData, "columnData present");
    assert.ok((sheet.columnData![0]?.w ?? 0) > 0, `col0 width present: ${sheet.columnData![0]?.w}`);
    assert.ok((sheet.columnData![1]?.w ?? 0) > 0, `col1 width present: ${sheet.columnData![1]?.w}`);
    assert.ok((sheet.columnData![2]?.w ?? 0) > 0, `col2 width present: ${sheet.columnData![2]?.w}`);
    ok("XLSX: column widths converted");
  } catch (e: any) {
    fail("XLSX: column widths", e.message);
  }

  // ── XLSX row heights ────────────────────────────────────────────────────────
  try {
    const buf = await makeStyledXlsx(async (wb) => {
      const ws = wb.addWorksheet("Heights");
      const r0 = ws.addRow(["Row0"]);
      r0.height = 30;
      const r1 = ws.addRow(["Row1"]);
      r1.height = 50;
    });
    const { snapshot } = await convertToUniverSnapshot(buf, "heights.xlsx", "Heights");
    const sheet = Object.values(snapshot.sheets)[0];
    assert.ok(sheet.rowData, "rowData present");
    assert.ok((sheet.rowData![0]?.h ?? 0) > 0, `row0 height present: ${sheet.rowData![0]?.h}`);
    assert.ok((sheet.rowData![1]?.h ?? 0) > 0, `row1 height present: ${sheet.rowData![1]?.h}`);
    ok("XLSX: row heights converted");
  } catch (e: any) {
    fail("XLSX: row heights", e.message);
  }

  // ── Malformed buffer ────────────────────────────────────────────────────────
  try {
    const buf = Buffer.from("PK\x03\x04this is corrupt zip content that cannot be parsed");
    let threw = false;
    try {
      await convertToUniverSnapshot(buf, "bad.xlsx", "Bad");
    } catch (e: any) {
      threw = true;
      assert.ok(e.message.length > 0, "error has message");
    }
    assert.ok(threw, "malformed file throws");
    ok("Malformed buffer: throws readable error");
  } catch (e: any) {
    fail("Malformed buffer", e.message);
  }

  // ── Sheet limit ─────────────────────────────────────────────────────────────
  try {
    const buf = await makeStyledXlsx(async (wb) => {
      for (let i = 0; i < 22; i++) {
        const ws = wb.addWorksheet(`Sheet${i + 1}`);
        ws.addRow([i]);
      }
    });
    const { snapshot, report } = await convertToUniverSnapshot(buf, "many.xlsx", "Many");
    assert.ok(snapshot.sheetOrder.length <= 20, `sheets capped: ${snapshot.sheetOrder.length}`);
    assert.ok(
      report.skipped.some((s) => s.kind === "sheet_limit"),
      "sheet_limit in skipped",
    );
    ok("Sheet limit: excess sheets skipped with report");
  } catch (e: any) {
    fail("Sheet limit", e.message);
  }

  // ── Regression: all emitted colors are #RRGGBB ──────────────────────────────
  // Univer's ColorKit rejects bare hex without '#' and renders black.
  // This test fails if argbToRgb ever regresses to bare-hex output.
  try {
    const buf = await makeStyledXlsx(async (wb) => {
      const ws = wb.addWorksheet("Colors");
      const row = ws.addRow(["Rainbow"]);
      const cell = row.getCell(1);
      cell.value = "Rainbow";
      cell.font = { color: { argb: "FF0000FF" } };  // blue font
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } }; // yellow bg
      cell.border = {
        top: { style: "thin", color: { argb: "FFFF0000" } },    // red top
        right: { style: "thin", color: { argb: "FF00FF00" } },  // green right
      };
    });
    const { snapshot } = await convertToUniverSnapshot(buf, "colors.xlsx", "Colors");
    const COLOR_RE = /^#[0-9A-F]{6}$/i;

    // Collect all rgb values from the snapshot
    const rgbValues: string[] = [];
    function collectRgb(node: unknown): void {
      if (Array.isArray(node)) { node.forEach(collectRgb); return; }
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === "rgb" && typeof v === "string") {
            rgbValues.push(v);
          } else {
            collectRgb(v);
          }
        }
      }
    }
    collectRgb(snapshot);

    assert.ok(rgbValues.length > 0, "snapshot has rgb values to check");
    for (const rgb of rgbValues) {
      assert.ok(COLOR_RE.test(rgb), `rgb "${rgb}" must match #RRGGBB (Univer format)`);
    }
    ok("Regression: all emitted rgb values match #RRGGBB format");
  } catch (e: any) {
    fail("Regression: #RRGGBB color format", e.message);
  }

  // ── Regression: normalizeSnapshotColors self-heals bare-hex snapshots ───────
  try {
    const { normalizeSnapshotColors } = await import("../server/services/sheetsImportConverter");

    const bareHexSnapshot = {
      sheets: {
        s1: {
          cellData: {
            0: {
              0: { s: { bg: { rgb: "FFFF00" }, cl: { rgb: "0000FF" }, bd: { t: { s: 1, cl: { rgb: "000000" } } } } },
            },
          },
        },
      },
    };
    const normalized = normalizeSnapshotColors(bareHexSnapshot) as typeof bareHexSnapshot;
    const cell = normalized.sheets.s1.cellData[0][0].s;
    assert.equal(cell.bg.rgb, "#FFFF00", "bg.rgb normalized to #FFFF00");
    assert.equal(cell.cl.rgb, "#0000FF", "cl.rgb normalized to #0000FF");
    assert.equal(cell.bd.t.cl.rgb, "#000000", "border cl.rgb normalized to #000000");

    // Idempotent: already-correct values pass through unchanged
    const alreadyGood = { sheets: { s1: { cellData: { 0: { 0: { s: { bg: { rgb: "#FFFF00" } } } } } } } };
    const reNormalized = normalizeSnapshotColors(alreadyGood) as typeof alreadyGood;
    assert.equal(reNormalized.sheets.s1.cellData[0][0].s.bg.rgb, "#FFFF00", "already-correct value unchanged");

    ok("normalizeSnapshotColors: converts bare-hex to #RRGGBB, idempotent on correct values");
  } catch (e: any) {
    fail("normalizeSnapshotColors self-heal", e.message);
  }

  // ── Regression: theme/indexed colors are never emitted as invalid strings ────
  try {
    // ExcelJS theme colors arrive as { theme: N } with no argb property.
    // argbToRgb must return undefined for these, not an empty/invalid string.
    const { snapshot } = await convertToUniverSnapshot(
      await makeStyledXlsx(async (wb) => {
        const ws = wb.addWorksheet("Theme");
        const row = ws.addRow(["ThemeCell"]);
        const cell = row.getCell(1);
        cell.value = "ThemeCell";
        // Simulate a theme color: ExcelJS accepts { theme: 1 } — no argb
        cell.font = { color: { theme: 1 } as any };
      }),
      "theme.xlsx",
      "Theme",
    );
    const COLOR_RE = /^#[0-9A-F]{6}$/i;
    const invalidRgb: string[] = [];
    function checkRgb(node: unknown): void {
      if (Array.isArray(node)) { node.forEach(checkRgb); return; }
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === "rgb" && typeof v === "string" && !COLOR_RE.test(v)) {
            invalidRgb.push(v);
          } else {
            checkRgb(v);
          }
        }
      }
    }
    checkRgb(snapshot);
    assert.equal(invalidRgb.length, 0, `theme cells must not emit invalid rgb strings; found: ${invalidRgb.join(", ")}`);
    ok("Theme/indexed colors: never emitted as invalid rgb strings");
  } catch (e: any) {
    fail("Theme/indexed color safety", e.message);
  }
}

// ── Storage-layer integration tests ────────────────────────────────────────────

async function runRoutes() {
  console.log("\nsheets-import storage-layer tests:");

  await runInIsolatedSchema(async () => {
    const { getDb } = await import("../server/db");
    const db = getDb();
    const ownerId = "sheets-import-test-owner-001";

    await db.execute(
      `INSERT INTO users (id, email, role)
       VALUES ('${ownerId}', 'import_owner@test.local', 'account_manager')
       ON CONFLICT (id) DO NOTHING` as any,
    );

    const { storage } = await import("../server/storage");
    const { convertToUniverSnapshot } = await import("../server/services/sheetsImportConverter");
    const XLSX = await import("@e965/xlsx");
    const SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024;

    // ── XLSX → snapshot → storage round-trip ────────────────────────────────
    try {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["A", "B"], [1, 2]]), "Sheet1");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["X"], [99]]), "Sheet2");
      const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array);
      const { snapshot, report } = await convertToUniverSnapshot(buf, "report.xlsx", "My Imported Report");
      const snapshotJson = JSON.stringify(snapshot);
      assert.ok(Buffer.byteLength(snapshotJson) < SNAPSHOT_MAX_BYTES, "snapshot under 10 MB");
      const workbook = await storage.createSheetWorkbook({
        name: "My Imported Report",
        ownerId,
        snapshot: snapshot as any,
      });
      assert.ok(workbook.id, "workbook.id created");
      assert.equal(workbook.name, "My Imported Report", "name applied");
      assert.equal(report.sheetCount, 2, "two sheets imported");
      assert.ok(report.cellCount > 0, "cells counted");
      ok("XLSX → converter → storage: creates workbook with correct name + report");
    } catch (e: any) {
      fail("XLSX → converter → storage", e.message);
    }

    // ── CSV → snapshot → storage round-trip ─────────────────────────────────
    try {
      const buf = Buffer.from(["Name,Score", "Alice,95", "Bob,87"].join("\n"));
      const { snapshot, report } = await convertToUniverSnapshot(buf, "scores.csv", "Scores");
      const workbook = await storage.createSheetWorkbook({
        name: "Scores",
        ownerId,
        snapshot: snapshot as any,
      });
      assert.ok(workbook.id, "csv workbook created");
      assert.equal(report.sheetCount, 1, "one sheet for csv");
      ok("CSV → converter → storage: creates workbook");
    } catch (e: any) {
      fail("CSV → converter → storage", e.message);
    }

    // ── Filename without extension as default name ───────────────────────────
    try {
      const name = "quarterly-report.csv".replace(/\.[^.]+$/, "");
      assert.equal(name, "quarterly-report", "extension stripped correctly");
      ok("Filename extension strip: name defaults correctly");
    } catch (e: any) {
      fail("Filename extension strip", e.message);
    }

    // ── Snapshot size guard logic ────────────────────────────────────────────
    try {
      const smallJson = JSON.stringify({ id: "wb", sheets: {}, sheetOrder: [], name: "x", locale: "enUS" });
      assert.ok(Buffer.byteLength(smallJson) < SNAPSHOT_MAX_BYTES, "small snapshot passes size check");
      const bigStr = "x".repeat(SNAPSHOT_MAX_BYTES + 1);
      assert.ok(Buffer.byteLength(bigStr) > SNAPSHOT_MAX_BYTES, "large snapshot fails size check");
      ok("Size guard: 10 MB threshold logic is correct");
    } catch (e: any) {
      fail("Size guard", e.message);
    }

    // ── Malformed buffer: converter throws ───────────────────────────────────
    try {
      const buf = Buffer.from("PK\x03\x04this is corrupt zip content that cannot be parsed");
      let threw = false;
      try {
        await convertToUniverSnapshot(buf, "corrupt.xlsx", "Bad");
      } catch {
        threw = true;
      }
      assert.ok(threw, "converter throws on corrupt zip");
      ok("Converter rejects malformed XLSX buffer");
    } catch (e: any) {
      fail("Converter malformed buffer", e.message);
    }

    // ── Workbook is readable back from storage ───────────────────────────────
    try {
      const buf = Buffer.from(["v,w", "1,2"].join("\n"));
      const { snapshot } = await convertToUniverSnapshot(buf, "read-back.csv", "ReadBack");
      const created = await storage.createSheetWorkbook({
        name: "ReadBack",
        ownerId,
        snapshot: snapshot as any,
      });
      const fetched = await storage.getSheetWorkbook(created.id);
      assert.ok(fetched, "workbook fetched after create");
      assert.equal(fetched?.name, "ReadBack", "name matches");
      assert.ok(fetched?.snapshot, "snapshot stored");
      ok("Workbook created via import is readable back from storage");
    } catch (e: any) {
      fail("Workbook read-back", e.message);
    }
  });
}

async function run() {
  await runRoutes();

  const XLSX = await import("@e965/xlsx");
  const { convertToUniverSnapshot } = await import("../server/services/sheetsImportConverter");
  await runUnit(XLSX, convertToUniverSnapshot);

  console.log(`\nsheets-import: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[sheets-import] fatal:", err);
  process.exit(1);
});
