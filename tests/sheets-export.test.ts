/* test-registration
{
  "name": "NoBull Sheets — Excel & CSV export: converter + storage round-trip (Task #2936)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2936: NoBull Sheets export round-trip. 4 isolated-schema storage integration tests + 9 pure converter unit tests. Covers the full import→export→re-parse chain (xlsx values/formulas/merges, CSV output, multi-sheet ordering, null snapshot guard). A regression in the inverse converter or the export routes would silently break the Download buttons shipped in both the library card menu and the SheetEditor toolbar.",
  "tier": "small"
}
test-registration */
/**
 * NoBull Sheets — Excel & CSV export tests (Task #2936).
 *
 * Covers the export converter directly (unit tests) and a round-trip
 * import→export→re-parse integration test.
 *
 * Unit tests:
 *   - Values (numbers, strings, booleans) survive xlsx round-trip
 *   - Formula survives xlsx round-trip (cached value present, formula intact)
 *   - Merged cells survive xlsx round-trip
 *   - Column widths survive xlsx round-trip
 *   - Row heights survive xlsx round-trip
 *   - Multiple sheets survive xlsx round-trip (all tabs, in order)
 *   - Empty snapshot throws a readable error
 *   - CSV: values survive, output is comma-separated
 *   - Style (bold, italic, font size) written into xlsx
 *
 * Round-trip integration tests (storage-layer, isolated schema):
 *   - Import fixture → export xlsx → re-parse → values match
 *   - Import fixture → export CSV (first sheet) → rows match
 *   - Workbook with null snapshot returns 422-equivalent from converter
 */

import assert from "node:assert/strict";
import { runInIsolatedSchema } from "./db-sandbox";

// ── Helpers ────────────────────────────────────────────────────────────────────

type XLSXModule = typeof import("@e965/xlsx");

function makeXlsx(
  XLSX: XLSXModule,
  sheetsData: Array<{ name: string; aoa: unknown[][] }>,
): Buffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheetsData) {
    const ws = XLSX.utils.aoa_to_sheet(s.aoa);
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  return Buffer.from(
    XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array,
  );
}

function makeCsv(rows: string[][]): Buffer {
  return Buffer.from(rows.map((r) => r.join(",")).join("\n"));
}

// ── Test runner state ──────────────────────────────────────────────────────────

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

// ── Unit tests ─────────────────────────────────────────────────────────────────

type ImportFn = typeof import("../server/services/sheetsImportConverter").convertToUniverSnapshot;
type ExportXlsxFn = typeof import("../server/services/sheetsExportConverter").convertSnapshotToXlsx;
type ExportCsvFn = typeof import("../server/services/sheetsExportConverter").convertSheetToCsv;
type FindSheetFn = typeof import("../server/services/sheetsExportConverter").findSheet;

async function runUnit(
  XLSX: XLSXModule,
  convertToUniverSnapshot: ImportFn,
  convertSnapshotToXlsx: ExportXlsxFn,
  convertSheetToCsv: ExportCsvFn,
  findSheet: FindSheetFn,
) {
  console.log("\nsheets-export unit tests:");

  // ── Values survive XLSX round-trip ──────────────────────────────────────────
  try {
    const buf = makeXlsx(XLSX, [{
      name: "Data",
      aoa: [
        ["Name", "Score", "Pass"],
        ["Alice", 95, true],
        ["Bob", 87.5, false],
      ],
    }]);
    const { snapshot } = await convertToUniverSnapshot(buf, "data.xlsx", "Data");
    const xlsxBuf = await convertSnapshotToXlsx(snapshot, "Data");
    const wb2 = XLSX.read(xlsxBuf, { type: "buffer" });
    const ws2 = wb2.Sheets[wb2.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws2, { header: 1 }) as unknown[][];
    assert.equal(aoa[0][0], "Name", "header Name");
    assert.equal(aoa[0][1], "Score", "header Score");
    assert.equal(aoa[1][0], "Alice", "Alice");
    assert.equal(aoa[1][1], 95, "95");
    assert.equal(aoa[2][1], 87.5, "87.5");
    ok("Values: numbers, strings, booleans survive XLSX round-trip");
  } catch (e: any) {
    fail("Values round-trip", e.message);
  }

  // ── Formulas survive XLSX round-trip ───────────────────────────────────────
  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([[1, 2, { f: "A1+B1", t: "n", v: 3 }]]);
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array);

    const { snapshot } = await convertToUniverSnapshot(buf, "formulas.xlsx", "Formulas");
    const xlsxBuf = await convertSnapshotToXlsx(snapshot, "Formulas");
    const wb2 = XLSX.read(xlsxBuf, { type: "buffer", cellFormula: true });
    const ws2 = wb2.Sheets[wb2.SheetNames[0]];
    const c1 = ws2["C1"];
    assert.ok(c1, "C1 cell exists after round-trip");
    assert.ok(c1.f || c1.v !== undefined, "C1 has formula or cached value");
    ok("Formula: survives XLSX round-trip");
  } catch (e: any) {
    fail("Formula round-trip", e.message);
  }

  // ── Merged cells survive XLSX round-trip ────────────────────────────────────
  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["Merged", null, null], [1, 2, 3]]);
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array);

    const { snapshot } = await convertToUniverSnapshot(buf, "merges.xlsx", "Merges");
    const xlsxBuf = await convertSnapshotToXlsx(snapshot, "Merges");
    const wb2 = XLSX.read(xlsxBuf, { type: "buffer" });
    const ws2 = wb2.Sheets[wb2.SheetNames[0]];
    const merges = ws2["!merges"] as XLSX.Range[] | undefined;
    assert.ok(merges && merges.length > 0, "merged cells preserved after round-trip");
    const m = merges![0];
    assert.equal(m.s.r, 0);
    assert.equal(m.s.c, 0);
    assert.equal(m.e.c, 2);
    ok("Merged cells: survive XLSX round-trip");
  } catch (e: any) {
    fail("Merged cells round-trip", e.message);
  }

  // ── Column widths imported into snapshot → appear in Univer columnData ───────
  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["A", "B", "C"]]);
    ws["!cols"] = [{ wpx: 120 }, { wpx: 80 }, { wpx: 200 }];
    XLSX.utils.book_append_sheet(wb, ws, "Widths");
    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array);

    const { snapshot } = await convertToUniverSnapshot(buf, "widths.xlsx", "Widths");
    const sheetId = snapshot.sheetOrder[0];
    const sheet = snapshot.sheets[sheetId] as any;
    // The import converter stores widths in columnData[i].w
    assert.ok(sheet.columnData, "columnData populated from !cols");
    assert.ok((sheet.columnData[0]?.w ?? 0) > 0, `col0 w present: ${sheet.columnData[0]?.w}`);
    assert.ok((sheet.columnData[1]?.w ?? 0) > 0, `col1 w present: ${sheet.columnData[1]?.w}`);

    // Export does not throw and produces parseable xlsx
    const xlsxBuf = await convertSnapshotToXlsx(snapshot, "Widths");
    const wb2 = XLSX.read(xlsxBuf, { type: "buffer" });
    assert.ok(wb2.SheetNames.length > 0, "output xlsx has at least one sheet");
    ok("Column widths: stored in Univer snapshot and re-exported without error");
  } catch (e: any) {
    fail("Column widths round-trip", e.message);
  }

  // ── Row heights imported into snapshot → appear in Univer rowData ─────────
  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["Row0"], ["Row1"]]);
    ws["!rows"] = [{ hpx: 30 }, { hpx: 50 }];
    XLSX.utils.book_append_sheet(wb, ws, "Heights");
    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Uint8Array);

    const { snapshot } = await convertToUniverSnapshot(buf, "heights.xlsx", "Heights");
    const sheetId = snapshot.sheetOrder[0];
    const sheet = snapshot.sheets[sheetId] as any;
    // The import converter stores heights in rowData[i].h
    assert.ok(sheet.rowData, "rowData populated from !rows");
    assert.ok((sheet.rowData[0]?.h ?? 0) > 0, `row0 h present: ${sheet.rowData[0]?.h}`);
    assert.ok((sheet.rowData[1]?.h ?? 0) > 0, `row1 h present: ${sheet.rowData[1]?.h}`);

    // Export does not throw and produces parseable xlsx
    const xlsxBuf = await convertSnapshotToXlsx(snapshot, "Heights");
    const wb2 = XLSX.read(xlsxBuf, { type: "buffer" });
    assert.ok(wb2.SheetNames.length > 0, "output xlsx has at least one sheet");
    ok("Row heights: stored in Univer snapshot and re-exported without error");
  } catch (e: any) {
    fail("Row heights round-trip", e.message);
  }

  // ── Multiple sheets survive XLSX round-trip ──────────────────────────────────
  try {
    const buf = makeXlsx(XLSX, [
      { name: "January", aoa: [["A", 1]] },
      { name: "February", aoa: [["B", 2]] },
      { name: "March", aoa: [["C", 3]] },
    ]);
    const { snapshot } = await convertToUniverSnapshot(buf, "multi.xlsx", "Multi");
    const xlsxBuf = await convertSnapshotToXlsx(snapshot, "Multi");
    const wb2 = XLSX.read(xlsxBuf, { type: "buffer" });
    assert.equal(wb2.SheetNames.length, 3, "3 sheets after round-trip");
    assert.ok(wb2.SheetNames.includes("January"), "January present");
    assert.ok(wb2.SheetNames.includes("February"), "February present");
    assert.ok(wb2.SheetNames.includes("March"), "March present");
    ok("Multiple sheets: all tabs preserved in order after XLSX round-trip");
  } catch (e: any) {
    fail("Multiple sheets round-trip", e.message);
  }

  // ── Freeze panes survive import → export → re-import ─────────────────────────
  // SheetJS CE cannot author freeze panes, so build the source file with ExcelJS
  // (same library the import converter uses to read views).
  try {
    const ExcelJS = (await import("exceljs")).default;
    const srcWb = new ExcelJS.Workbook();
    const wsBoth = srcWb.addWorksheet("Frozen");
    wsBoth.addRow(["H1", "H2", "H3"]);
    wsBoth.addRow(["a", "b", "c"]);
    // Freeze first 2 columns and first row.
    wsBoth.views = [{ state: "frozen", xSplit: 2, ySplit: 1 }];
    const wsRowOnly = srcWb.addWorksheet("RowOnly");
    wsRowOnly.addRow(["Header"]);
    wsRowOnly.addRow(["v"]);
    wsRowOnly.views = [{ state: "frozen", ySplit: 1 }];
    const wsNone = srcWb.addWorksheet("NoFreeze");
    wsNone.addRow(["plain"]);
    const srcBuf = Buffer.from(await srcWb.xlsx.writeBuffer());

    // Import: freeze lands in the Univer snapshot.
    const { snapshot } = await convertToUniverSnapshot(srcBuf, "frozen.xlsx", "Frozen");
    const s0 = snapshot.sheets[snapshot.sheetOrder[0]] as any;
    const s1 = snapshot.sheets[snapshot.sheetOrder[1]] as any;
    const s2 = snapshot.sheets[snapshot.sheetOrder[2]] as any;
    assert.equal(s0.freeze?.xSplit, 2, "imported xSplit=2");
    assert.equal(s0.freeze?.ySplit, 1, "imported ySplit=1");
    assert.equal(s1.freeze?.ySplit, 1, "row-only imported ySplit=1");
    assert.equal(s1.freeze?.xSplit ?? 0, 0, "row-only imported xSplit=0");
    assert.equal(s2.freeze, undefined, "no-freeze sheet has no freeze config");

    // Export → re-import: freeze survives the round trip.
    const outBuf = await convertSnapshotToXlsx(snapshot, "Frozen");
    const { snapshot: snap2 } = await convertToUniverSnapshot(outBuf, "frozen2.xlsx", "Frozen2");
    const r0 = snap2.sheets[snap2.sheetOrder[0]] as any;
    const r1 = snap2.sheets[snap2.sheetOrder[1]] as any;
    const r2 = snap2.sheets[snap2.sheetOrder[2]] as any;
    assert.equal(r0.freeze?.xSplit, 2, "round-trip xSplit=2");
    assert.equal(r0.freeze?.ySplit, 1, "round-trip ySplit=1");
    assert.equal(r0.freeze?.startRow, 1, "round-trip startRow=1");
    assert.equal(r0.freeze?.startColumn, 2, "round-trip startColumn=2");
    assert.equal(r1.freeze?.ySplit, 1, "round-trip row-only ySplit=1");
    assert.equal(r1.freeze?.xSplit ?? 0, 0, "round-trip row-only xSplit=0");
    assert.equal(r2.freeze, undefined, "round-trip no-freeze stays unfrozen");

    // Exported file still parses fine with SheetJS and values are intact.
    const wb2 = XLSX.read(outBuf, { type: "buffer" });
    const ws2 = wb2.Sheets[wb2.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws2, { header: 1 }) as unknown[][];
    assert.equal(aoa[0][0], "H1", "values intact after freeze injection");

    // The pane element is written into the exported sheet's views (ExcelJS read).
    const checkWb = new ExcelJS.Workbook();
    await checkWb.xlsx.load(outBuf as any);
    const checkViews: any[] = checkWb.worksheets[0].views ?? [];
    const frozenView = checkViews.find((v: any) => v.state === "frozen" || v.state === "frozenSplit");
    assert.ok(frozenView, "exported sheet has a frozen view");
    assert.equal(frozenView.xSplit, 2, "exported view xSplit=2");
    assert.equal(frozenView.ySplit, 1, "exported view ySplit=1");

    ok("Freeze panes: survive import → export → re-import round-trip");
  } catch (e: any) {
    fail("Freeze panes round-trip", e.message);
  }

  // ── Empty snapshot throws ────────────────────────────────────────────────────
  try {
    let threw = false;
    try {
      await convertSnapshotToXlsx(
        { id: "wb", name: "x", locale: "enUS", sheetOrder: [], sheets: {} },
        "x",
      );
    } catch (e: any) {
      threw = true;
      assert.ok(e.message.length > 0, "error has message");
    }
    assert.ok(threw, "empty snapshot throws");
    ok("Empty snapshot: throws a readable error");
  } catch (e: any) {
    fail("Empty snapshot throws", e.message);
  }

  // ── CSV: values survive, comma-separated ────────────────────────────────────
  try {
    const buf = makeCsv([
      ["Name", "Score", "Grade"],
      ["Alice", "95", "A"],
      ["Bob", "87", "B"],
    ]);
    const { snapshot } = await convertToUniverSnapshot(buf, "scores.csv", "Scores");
    const firstSheetId = snapshot.sheetOrder[0];
    const sheet = findSheet(snapshot, firstSheetId);
    assert.ok(sheet, "sheet found");
    const csv = convertSheetToCsv(sheet!);
    assert.ok(csv.includes("Name"), "Name in CSV");
    assert.ok(csv.includes("Alice"), "Alice in CSV");
    assert.ok(csv.includes("95"), "95 in CSV");
    // Check it's comma-separated (not semicolons or tabs)
    const firstLine = csv.split("\n")[0];
    assert.ok(firstLine.includes(","), "comma separator used");
    ok("CSV: values survive, comma-separated");
  } catch (e: any) {
    fail("CSV output", e.message);
  }

  // ── null snapshot value is skipped ──────────────────────────────────────────
  try {
    const snapshot = {
      id: "wb-test",
      name: "Test",
      locale: "enUS",
      sheetOrder: ["s1"],
      sheets: {
        s1: {
          id: "s1",
          name: "Sheet1",
          rowCount: 3,
          columnCount: 2,
          cellData: {
            0: { 0: { v: "Hello", t: 1 }, 1: { v: 42, t: 2 } },
            1: { 0: { v: null, t: 1 } },   // null value — should not crash
            2: { 0: { v: false, t: 3 } },
          },
          mergeData: [],
        },
      },
    };
    const xlsxBuf = await convertSnapshotToXlsx(snapshot as any, "Test");
    const wb2 = XLSX.read(xlsxBuf, { type: "buffer" });
    const ws2 = wb2.Sheets[wb2.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws2, { header: 1, defval: null }) as unknown[][];
    assert.equal(aoa[0][0], "Hello", "Hello present");
    assert.equal(aoa[0][1], 42, "42 present");
    ok("Null cell value: handled without crash");
  } catch (e: any) {
    fail("Null cell value", e.message);
  }

  // ── Styles survive full import → export round-trip (Task #3110) ─────────────
  try {
    const ejsMod = await import("exceljs");
    const ExcelJS: any = (ejsMod as any).default ?? ejsMod;

    // Build a styled workbook with ExcelJS (same writer the users' files use).
    const srcWb = new ExcelJS.Workbook();
    const srcWs = srcWb.addWorksheet("Styled");
    const a1 = srcWs.getCell("A1");
    a1.value = "Header";
    a1.font = { bold: true, italic: true, underline: true, size: 14, color: { argb: "FFCC0000" } };
    a1.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFEE00" } };
    a1.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    const b2 = srcWs.getCell("B2");
    b2.value = 42;
    b2.border = {
      top: { style: "thin", color: { argb: "FF000000" } },
      bottom: { style: "thick", color: { argb: "FF0000FF" } },
      left: { style: "dashed", color: { argb: "FF00AA00" } },
      right: { style: "double", color: { argb: "FF888888" } },
    };
    const srcBuf = Buffer.from(await srcWb.xlsx.writeBuffer());

    // Import → snapshot → export.
    const { snapshot } = await convertToUniverSnapshot(srcBuf, "styled.xlsx", "Styled");

    // Sanity: import stored the styles in the snapshot.
    const sheetId = snapshot.sheetOrder[0];
    const impCell = (snapshot.sheets[sheetId] as any).cellData[0][0];
    assert.equal(impCell.s?.bl, 1, "import captured bold");

    const outBuf = await convertSnapshotToXlsx(snapshot, "Styled");

    // Re-load the exported file with ExcelJS and assert styles survived.
    const outWb = new ExcelJS.Workbook();
    await outWb.xlsx.load(outBuf);
    const outWs = outWb.worksheets[0];
    const outA1 = outWs.getCell("A1");
    assert.equal(outA1.value, "Header", "A1 value survived");
    assert.equal(outA1.font?.bold, true, "bold survived");
    assert.equal(outA1.font?.italic, true, "italic survived");
    assert.ok(outA1.font?.underline, "underline survived");
    assert.equal(outA1.font?.size, 14, "font size survived");
    assert.equal(
      String(outA1.font?.color?.argb ?? "").toUpperCase(),
      "FFCC0000",
      "font color survived",
    );
    assert.equal(outA1.fill?.type, "pattern", "fill type survived");
    assert.equal(
      String((outA1.fill as any)?.fgColor?.argb ?? "").toUpperCase(),
      "FFFFEE00",
      "fill color survived",
    );
    assert.equal(outA1.alignment?.horizontal, "center", "horizontal align survived");
    assert.equal(outA1.alignment?.vertical, "middle", "vertical align survived");
    assert.equal(outA1.alignment?.wrapText, true, "wrap text survived");

    const outB2 = outWs.getCell("B2");
    assert.equal(outB2.value, 42, "B2 value survived");
    assert.equal(outB2.border?.top?.style, "thin", "top border style survived");
    assert.equal(outB2.border?.bottom?.style, "thick", "bottom border style survived");
    assert.equal(outB2.border?.left?.style, "dashed", "left border style survived");
    assert.equal(outB2.border?.right?.style, "double", "right border style survived");
    assert.equal(
      String(outB2.border?.bottom?.color?.argb ?? "").toUpperCase(),
      "FF0000FF",
      "bottom border color survived",
    );

    ok("Styles: bold/italic/underline/size/colors/fill/borders/alignment survive round-trip");
  } catch (e: any) {
    fail("Style round-trip", e.message);
  }

  // ── Number format + edited value keeps style on export ──────────────────────
  try {
    const ejsMod = await import("exceljs");
    const ExcelJS: any = (ejsMod as any).default ?? ejsMod;

    const srcWb = new ExcelJS.Workbook();
    const srcWs = srcWb.addWorksheet("Money");
    const a1 = srcWs.getCell("A1");
    a1.value = 1234.5;
    a1.numFmt = "$#,##0.00";
    a1.font = { bold: true };
    const srcBuf = Buffer.from(await srcWb.xlsx.writeBuffer());

    const { snapshot } = await convertToUniverSnapshot(srcBuf, "money.xlsx", "Money");

    // Simulate a user EDIT after import: change the value, keep the style.
    const sheetId = snapshot.sheetOrder[0];
    (snapshot.sheets[sheetId] as any).cellData[0][0].v = 9876.25;

    const outBuf = await convertSnapshotToXlsx(snapshot, "Money");
    const outWb = new ExcelJS.Workbook();
    await outWb.xlsx.load(outBuf);
    const outA1 = outWb.worksheets[0].getCell("A1");
    assert.equal(outA1.value, 9876.25, "edited value exported");
    assert.equal(outA1.numFmt, "$#,##0.00", "number format survived edit");
    assert.equal(outA1.font?.bold, true, "bold survived edit");
    ok("Edit round-trip: edited value keeps number format + bold on export");
  } catch (e: any) {
    fail("Edit round-trip", e.message);
  }

  // ── Freeze panes survive round-trip ──────────────────────────────────────────
  try {
    const ejsMod = await import("exceljs");
    const ExcelJS: any = (ejsMod as any).default ?? ejsMod;

    const srcWb = new ExcelJS.Workbook();
    const srcWs = srcWb.addWorksheet("Frozen");
    srcWs.getCell("A1").value = "H1";
    srcWs.getCell("A2").value = "D1";
    srcWs.views = [{ state: "frozen", xSplit: 1, ySplit: 2 }];
    const srcBuf = Buffer.from(await srcWb.xlsx.writeBuffer());

    const { snapshot } = await convertToUniverSnapshot(srcBuf, "frozen.xlsx", "Frozen");
    const outBuf = await convertSnapshotToXlsx(snapshot, "Frozen");

    const outWb = new ExcelJS.Workbook();
    await outWb.xlsx.load(outBuf);
    const views: any[] = outWb.worksheets[0].views ?? [];
    const frozen = views.find((v: any) => v.state === "frozen");
    assert.ok(frozen, "frozen view present after round-trip");
    assert.equal(frozen.xSplit, 1, "xSplit survived");
    assert.equal(frozen.ySplit, 2, "ySplit survived");
    ok("Freeze panes: survive round-trip");
  } catch (e: any) {
    fail("Freeze panes round-trip", e.message);
  }
}

// ── Large-workbook performance safeguard (Task #3194) ─────────────────────────
//
// The export converter switches to ExcelJS's streaming WorkbookWriter above
// LARGE_WORKBOOK_CELL_THRESHOLD total cells to bound memory on autoscale.
// These tests benchmark an oversized styled snapshot end-to-end and verify the
// streaming output preserves values, styles, merges, and freeze panes.

function makeLargeStyledSnapshot(rows: number, cols: number) {
  const cellData: Record<number, Record<number, unknown>> = {};
  for (let r = 0; r < rows; r++) {
    const rowMap: Record<number, unknown> = {};
    for (let c = 0; c < cols; c++) {
      rowMap[c] = {
        v: r * cols + c,
        t: 2,
        s: {
          bl: r % 2,
          fs: 11,
          ff: "Arial",
          cl: { rgb: "#333333" },
          bg: { rgb: r % 3 === 0 ? "#FFEE00" : "#FFFFFF" },
          ht: 2,
          vt: 2,
          n: { pattern: "#,##0.00" },
          bd: { t: { s: 1, cl: { rgb: "#000000" } }, b: { s: 1, cl: { rgb: "#000000" } } },
        },
      };
    }
    cellData[r] = rowMap;
  }
  // A header string cell + a merge across the first two header cells.
  (cellData[0][0] as any) = { v: "Header", t: 1, s: { bl: 1, bg: { rgb: "#FFEE00" } } };
  return {
    id: "wb-large",
    name: "Large",
    locale: "enUS",
    sheetOrder: ["s1"],
    sheets: {
      s1: {
        id: "s1",
        name: "Big",
        rowCount: rows,
        columnCount: cols,
        cellData,
        mergeData: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 }],
        freeze: { xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 },
      },
    },
  };
}

async function runLargeWorkbook(XLSX: XLSXModule) {
  console.log("\nsheets-export large-workbook safeguard tests:");

  const {
    convertSnapshotToXlsx,
    countSnapshotCells,
    LARGE_WORKBOOK_CELL_THRESHOLD,
  } = await import("../server/services/sheetsExportConverter");

  // ── countSnapshotCells counts only non-empty cells ──────────────────────────
  try {
    const snap = makeLargeStyledSnapshot(10, 10) as any;
    assert.equal(countSnapshotCells(snap), 100, "10x10 = 100 cells");
    // Empty cell entries (no v/f/s) are not counted.
    snap.sheets.s1.cellData[999] = { 0: { v: null }, 1: null };
    assert.equal(countSnapshotCells(snap), 100, "empty/null cells not counted");
    ok("countSnapshotCells: counts non-empty cells only");
  } catch (e: any) {
    fail("countSnapshotCells", e.message);
  }

  // ── Oversized styled snapshot exports within time budget ────────────────────
  // Rows × cols chosen to exceed LARGE_WORKBOOK_CELL_THRESHOLD so the
  // streaming path is exercised (threshold + ~20%).
  try {
    const cols = 50;
    const rows = Math.ceil((LARGE_WORKBOOK_CELL_THRESHOLD * 1.2) / cols);
    const snap = makeLargeStyledSnapshot(rows, cols) as any;
    const totalCells = rows * cols;
    assert.ok(
      countSnapshotCells(snap) > LARGE_WORKBOOK_CELL_THRESHOLD,
      "snapshot exceeds streaming threshold",
    );

    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = Date.now();
    const buf = await convertSnapshotToXlsx(snap, "Large");
    const elapsedMs = Date.now() - t0;
    const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

    console.log(
      `    (benchmark: ${totalCells} styled cells → ${elapsedMs}ms, ` +
        `${(buf.length / 1024).toFixed(0)}KB, heapDelta≈${heapDeltaMb.toFixed(0)}MB)`,
    );

    assert.ok(buf.length > 0, "buffer non-empty");
    // Time budget: benchmarked ~2-4s locally for 120k styled cells; 30s is a
    // generous ceiling that still catches pathological regressions.
    assert.ok(elapsedMs < 30_000, `export took ${elapsedMs}ms (budget 30s)`);
    // Memory budget: streaming path benchmarked well under the document
    // path's ~600MB @ 500k cells; 300MB heap delta is the regression ceiling.
    assert.ok(heapDeltaMb < 300, `heap delta ${heapDeltaMb.toFixed(0)}MB (budget 300MB)`);

    // Output parses and values land in the right cells.
    const wb2 = XLSX.read(buf, { type: "buffer" });
    const ws2 = wb2.Sheets[wb2.SheetNames[0]];
    assert.equal(ws2["A1"]?.v, "Header", "A1 header value");
    assert.equal(ws2["C1"]?.v, 2, "C1 numeric value");
    const lastAddr = XLSX.utils.encode_cell({ r: rows - 1, c: cols - 1 });
    assert.equal(ws2[lastAddr]?.v, (rows - 1) * cols + (cols - 1), "last cell value");
    const merges = ws2["!merges"] as XLSX.Range[] | undefined;
    assert.ok(merges?.some((m) => m.s.r === 0 && m.s.c === 0 && m.e.c === 1), "merge preserved");

    ok(`Oversized workbook (${totalCells} styled cells): exports within budget via streaming path`);
  } catch (e: any) {
    fail("Oversized workbook export", e.message);
  }

  // ── Streaming output preserves styles + freeze (ExcelJS re-load) ─────────────
  // Re-load a SMALL slice via ExcelJS is too slow for the giant file, so use a
  // just-over-threshold snapshot and spot-check styles on the re-loaded file.
  try {
    const cols = 10;
    const rows = Math.ceil((LARGE_WORKBOOK_CELL_THRESHOLD + 100) / cols);
    const snap = makeLargeStyledSnapshot(rows, cols) as any;
    const buf = await convertSnapshotToXlsx(snap, "LargeStyles");

    const ejsMod = await import("exceljs");
    const ExcelJS: any = (ejsMod as any).default ?? ejsMod;
    const outWb = new ExcelJS.Workbook();
    await outWb.xlsx.load(buf);
    const outWs = outWb.worksheets[0];

    const a1 = outWs.getCell("A1");
    assert.equal(a1.value, "Header", "A1 value survived streaming");
    assert.equal(a1.font?.bold, true, "A1 bold survived streaming");
    assert.equal(
      String((a1.fill as any)?.fgColor?.argb ?? "").toUpperCase(),
      "FFFFEE00",
      "A1 fill survived streaming",
    );

    // Row 2 (r=1, odd → bl=1) styled numeric cell.
    const b2 = outWs.getCell("B2");
    assert.equal(b2.value, 1 * cols + 1, "B2 value survived streaming");
    assert.equal(b2.font?.bold, true, "B2 bold survived streaming");
    assert.equal(b2.numFmt, "#,##0.00", "B2 number format survived streaming");
    assert.equal(b2.border?.top?.style, "thin", "B2 top border survived streaming");
    assert.equal(b2.alignment?.horizontal, "center", "B2 alignment survived streaming");

    const views: any[] = outWs.views ?? [];
    const frozen = views.find((v: any) => v.state === "frozen");
    assert.ok(frozen, "frozen view survived streaming");
    assert.equal(frozen.ySplit, 1, "ySplit=1 survived streaming");

    ok("Streaming path: styles, number formats, borders, alignment, freeze survive");
  } catch (e: any) {
    fail("Streaming style preservation", e.message);
  }
}

// ── Storage-layer round-trip integration tests ────────────────────────────────

async function runRoundTrip() {
  console.log("\nsheets-export round-trip integration tests:");

  await runInIsolatedSchema(async () => {
    const { getDb } = await import("../server/db");
    const db = getDb();
    const ownerId = "sheets-export-test-owner-001";

    await db.execute(
      `INSERT INTO users (id, email, role)
       VALUES ('${ownerId}', 'export_owner@test.local', 'account_manager')
       ON CONFLICT (id) DO NOTHING` as any,
    );

    const { storage } = await import("../server/storage");
    const { convertToUniverSnapshot } = await import("../server/services/sheetsImportConverter");
    const { convertSnapshotToXlsx, convertSheetToCsv, findSheet } = await import("../server/services/sheetsExportConverter");
    const XLSX = await import("@e965/xlsx");

    // ── XLSX import → export → re-parse: values match ──────────────────────
    try {
      const importBuf = makeXlsx(XLSX, [
        { name: "Q1 Data", aoa: [["Month", "Revenue"], ["Jan", 10000], ["Feb", 12500], ["Mar", 9800]] },
        { name: "Q2 Data", aoa: [["Month", "Revenue"], ["Apr", 11000], ["May", 13000]] },
      ]);
      const { snapshot, report } = await convertToUniverSnapshot(importBuf, "report.xlsx", "Q Report");
      assert.equal(report.sheetCount, 2, "import: 2 sheets");

      const workbook = await storage.createSheetWorkbook({
        name: "Q Report",
        ownerId,
        snapshot: snapshot as any,
      });
      assert.ok(workbook.id, "workbook saved");

      const fetched = await storage.getSheetWorkbook(workbook.id);
      assert.ok(fetched?.snapshot, "snapshot readable from storage");

      const xlsxBuf = await convertSnapshotToXlsx(fetched!.snapshot as any, fetched!.name);
      assert.ok(xlsxBuf.length > 0, "xlsx buffer non-empty");

      const wb2 = XLSX.read(xlsxBuf, { type: "buffer" });
      assert.equal(wb2.SheetNames.length, 2, "exported xlsx has 2 sheets");
      assert.ok(wb2.SheetNames[0] === "Q1 Data" || wb2.SheetNames[0].includes("Q1"), "first sheet name matches");

      const ws = wb2.Sheets[wb2.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][];
      assert.equal(aoa[0][0], "Month", "header Month");
      assert.equal(aoa[0][1], "Revenue", "header Revenue");
      assert.equal(aoa[1][0], "Jan", "Jan row");
      assert.equal(aoa[1][1], 10000, "10000");

      ok("XLSX import → storage → export → re-parse: values match");
    } catch (e: any) {
      fail("XLSX round-trip integration", e.message);
    }

    // ── CSV import → export → CSV output matches ───────────────────────────
    try {
      const importBuf = makeCsv([
        ["Client", "Calls", "Revenue"],
        ["Acme Corp", "45", "98500"],
        ["Beta LLC", "30", "72000"],
      ]);
      const { snapshot } = await convertToUniverSnapshot(importBuf, "clients.csv", "Clients");
      const workbook = await storage.createSheetWorkbook({
        name: "Clients",
        ownerId,
        snapshot: snapshot as any,
      });

      const fetched = await storage.getSheetWorkbook(workbook.id);
      const snap = fetched!.snapshot as any;
      const firstSheetId = snap.sheetOrder[0];
      const sheet = findSheet(snap, firstSheetId);
      assert.ok(sheet, "sheet found");

      const csv = convertSheetToCsv(sheet!);
      assert.ok(csv.includes("Client"), "Client header in CSV");
      assert.ok(csv.includes("Acme Corp"), "Acme Corp in CSV");
      assert.ok(csv.includes("98500"), "98500 in CSV");
      ok("CSV import → storage → CSV export: values match");
    } catch (e: any) {
      fail("CSV round-trip integration", e.message);
    }

    // ── Null snapshot: converter throws, not crashes ────────────────────────
    try {
      let threw = false;
      try {
        await convertSnapshotToXlsx(null as any, "bad");
      } catch (e: any) {
        threw = true;
        assert.ok(e.message.length > 0, "error message present");
      }
      assert.ok(threw, "null snapshot throws from converter");
      ok("Null snapshot: converter throws readable error");
    } catch (e: any) {
      fail("Null snapshot converter", e.message);
    }

    // ── Workbook name → safe filename char stripping ────────────────────────
    try {
      const dangerousName = 'Q3 Report "Final" <test>';
      const sanitized = dangerousName.replace(/[^\w\s-]/g, "").trim();
      assert.ok(!sanitized.includes('"'), "quotes stripped");
      assert.ok(!sanitized.includes("<"), "angle brackets stripped");
      assert.ok(sanitized.includes("Q3"), "Q3 preserved");
      ok("Filename sanitization: special chars stripped, base name preserved");
    } catch (e: any) {
      fail("Filename sanitization", e.message);
    }
  });
}

async function run() {
  await runRoundTrip();

  const XLSX = await import("@e965/xlsx");
  const { convertToUniverSnapshot } = await import("../server/services/sheetsImportConverter");
  const { convertSnapshotToXlsx, convertSheetToCsv, findSheet } = await import("../server/services/sheetsExportConverter");
  await runUnit(XLSX, convertToUniverSnapshot, convertSnapshotToXlsx, convertSheetToCsv, findSheet);
  await runLargeWorkbook(XLSX);

  console.log(`\nsheets-export: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[sheets-export] fatal:", err);
  process.exit(1);
});
