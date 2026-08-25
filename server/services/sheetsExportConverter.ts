/**
 * sheetsExportConverter — converts a Univer IWorkbookData snapshot back to
 * XLSX or CSV (inverse of sheetsImportConverter).
 *
 * XLSX path uses ExcelJS (same library as the import side) so rich cell
 * styles survive a full import → edit → export round-trip:
 *   ✓ Cell values  (numbers, strings, booleans)
 *   ✓ Formulas     (leading `=` stripped, cached result preserved)
 *   ✓ Multiple tabs (one worksheet per Univer sheet, in sheetOrder)
 *   ✓ Merged cells
 *   ✓ Column widths / row heights, hidden rows & columns
 *   ✓ Freeze panes
 *   ✓ Styles: bold, italic, underline, strikethrough, font name/size/color,
 *     fill color, borders (per-side style + color), horizontal/vertical
 *     alignment, text wrap, number formats
 *
 * CSV path remains SheetJS (values only — CSV has no styles).
 *
 * Large-workbook safeguard (Task #3194): ExcelJS's document Workbook keeps the
 * entire cell object model in memory — benchmarked at ~600 MB heap for 500k
 * styled cells. Snapshots above LARGE_WORKBOOK_CELL_THRESHOLD total cells are
 * therefore written with ExcelJS's streaming WorkbookWriter
 * (`ExcelJS.stream.xlsx.WorkbookWriter`, README § "Streaming XLSX Writer"):
 * rows are committed as they are written so their objects are freed, with
 * `useStyles: true` so styling survives. Per the docs, merges are declared
 * before row commits, and worksheet views (freeze) are passed at addWorksheet
 * time. With no stream/filename option the writer buffers into an in-memory
 * StreamBuf (`wb.stream.read()`), which holds only the final zipped bytes —
 * far smaller than the document object model.
 *
 * DB-hold rule: the entire build happens BEFORE any DB interaction.
 * Call convertSnapshotToXlsx / convertSheetToCsv BEFORE opening a DB hold.
 */

import * as XLSX from "@e965/xlsx";
import type {
  UniverWorkbookData,
  UniverWorksheetData,
  UniverCellData,
  UniverCellStyle,
  UniverBorderSide,
} from "./sheetsImportConverter";

// ── Style mapping tables (inverse of sheetsImportConverter's tables) ───────────

const BORDER_STYLE_REVERSE: Record<number, string> = {
  1: "thin",
  2: "hair",
  3: "dotted",
  4: "dashed",
  5: "dashDot",
  6: "dashDotDot",
  7: "slantDashDot",
  8: "mediumDashDotDot",
  9: "mediumDashDot",
  10: "medium",
  11: "double",
  12: "thick",
};

const H_ALIGN_REVERSE: Record<number, string> = {
  1: "left",
  2: "center",
  3: "right",
  4: "fill",
  5: "justify",
  6: "centerContinuous",
  7: "distributed",
};

const V_ALIGN_REVERSE: Record<number, string> = {
  1: "top",
  2: "middle",
  3: "bottom",
  4: "justify",
  5: "distributed",
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Above this many total cells (across all sheets) the XLSX export switches to
 * ExcelJS's streaming WorkbookWriter to bound memory. Benchmarks (Task #3194):
 * document path ≈ 92 MB heap @ 100k styled cells, ≈ 600 MB @ 500k.
 */
export const LARGE_WORKBOOK_CELL_THRESHOLD = 100_000;

/**
 * Count non-empty cells (value, formula, or style) across all sheets in
 * sheetOrder. Used to decide document vs streaming export path.
 */
export function countSnapshotCells(snapshot: UniverWorkbookData): number {
  let count = 0;
  for (const sheetId of snapshot.sheetOrder ?? []) {
    const sheet = snapshot.sheets?.[sheetId];
    if (!sheet) continue;
    for (const colMap of Object.values(sheet.cellData ?? {})) {
      if (!colMap || typeof colMap !== "object") continue;
      for (const cellData of Object.values(colMap)) {
        if (!cellData) continue;
        if (
          (cellData.v === null || cellData.v === undefined) &&
          !cellData.f &&
          !cellData.s
        ) {
          continue;
        }
        count++;
      }
    }
  }
  return count;
}

/**
 * Convert a full Univer workbook snapshot to an XLSX buffer using ExcelJS,
 * preserving cell styles (bold, borders, colors, alignment, number formats).
 * All sheets in sheetOrder are included.
 * Throws a human-readable Error if the snapshot is invalid/empty.
 */
export async function convertSnapshotToXlsx(
  snapshot: UniverWorkbookData,
  workbookName: string,
): Promise<Buffer> {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Invalid snapshot: expected an object.");
  }
  if (!snapshot.sheetOrder || snapshot.sheetOrder.length === 0) {
    throw new Error("Snapshot contains no sheets.");
  }

  // Dynamic import for ESM/CJS compatibility (mirrors sheetsImportConverter).
  const ejsMod = await import("exceljs");
  const ExcelJS: any = (ejsMod as any).default ?? ejsMod;

  // Oversized workbooks go through the streaming writer to bound memory.
  if (countSnapshotCells(snapshot) > LARGE_WORKBOOK_CELL_THRESHOLD) {
    return convertSnapshotToXlsxStreaming(ExcelJS, snapshot);
  }

  const wb: any = new ExcelJS.Workbook();
  const usedNames = new Set<string>();

  for (const sheetId of snapshot.sheetOrder) {
    const sheet = snapshot.sheets[sheetId];
    if (!sheet) continue;
    const wsName = nextWorksheetName(sheet.name || sheetId, usedNames);
    buildExcelJsSheet(wb, sheet, wsName);
  }

  if (wb.worksheets.length === 0) {
    throw new Error("No sheets could be converted — the snapshot may be empty.");
  }

  const raw = await wb.xlsx.writeBuffer();
  return Buffer.from(raw as ArrayBuffer);
}

/** Worksheet names must be ≤31 chars in Excel and unique (case-insensitive). */
function nextWorksheetName(desired: string, usedNames: Set<string>): string {
  let wsName = desired.slice(0, 31);
  let suffix = 1;
  while (usedNames.has(wsName.toLowerCase())) {
    const base = desired.slice(0, 28);
    wsName = `${base}_${++suffix}`;
  }
  usedNames.add(wsName.toLowerCase());
  return wsName;
}

/**
 * Streaming XLSX build for oversized snapshots (ExcelJS stream.xlsx
 * WorkbookWriter). Rows are committed in ascending order so their objects can
 * be freed as the zip is produced; merges are declared before any row commits
 * (per ExcelJS README, merged rows must not be committed before the merge is
 * declared); freeze views are passed at addWorksheet time. With no
 * stream/filename option the writer buffers into an in-memory StreamBuf.
 */
async function convertSnapshotToXlsxStreaming(
  ExcelJS: any,
  snapshot: UniverWorkbookData,
): Promise<Buffer> {
  const wb: any = new ExcelJS.stream.xlsx.WorkbookWriter({
    useStyles: true,
    useSharedStrings: false,
  });
  const usedNames = new Set<string>();
  let sheetCount = 0;

  for (const sheetId of snapshot.sheetOrder) {
    const sheet = snapshot.sheets[sheetId];
    if (!sheet) continue;
    const wsName = nextWorksheetName(sheet.name || sheetId, usedNames);
    sheetCount++;

    const wsOptions: any = {};
    if (sheet.freeze && (sheet.freeze.xSplit > 0 || sheet.freeze.ySplit > 0)) {
      wsOptions.views = [
        { state: "frozen", xSplit: sheet.freeze.xSplit, ySplit: sheet.freeze.ySplit },
      ];
    }
    const ws: any = wb.addWorksheet(wsName, wsOptions);

    // Column widths + hidden columns — must be set before rows are committed.
    if (sheet.columnData) {
      for (const [colStr, colDef] of Object.entries(sheet.columnData)) {
        const c = Number(colStr);
        if (Number.isNaN(c) || !colDef) continue;
        const col = ws.getColumn(c + 1);
        if (colDef.w != null && colDef.w > 0) col.width = colDef.w / 8;
        if (colDef.hd === 1) col.hidden = true;
      }
    }

    // Merges declared up front, before any row commit. In a merged range the
    // slave cells share the master's value object — writing a slave AFTER the
    // master would overwrite the master's value — so slave coordinates are
    // collected and skipped in the cell loop below.
    const mergeSlaves = new Set<string>();
    for (const m of sheet.mergeData ?? []) {
      try {
        ws.mergeCells(m.startRow + 1, m.startColumn + 1, m.endRow + 1, m.endColumn + 1);
        for (let mr = m.startRow; mr <= m.endRow; mr++) {
          for (let mc = m.startColumn; mc <= m.endColumn; mc++) {
            if (mr === m.startRow && mc === m.startColumn) continue; // master
            mergeSlaves.add(`${mr}:${mc}`);
          }
        }
      } catch {
        // Overlapping/invalid merge ranges are non-fatal; skip.
      }
    }

    // Union of row indices that carry cells or row metadata, ascending.
    const rowIndices = new Set<number>();
    for (const rowStr of Object.keys(sheet.cellData ?? {})) {
      const r = Number(rowStr);
      if (!Number.isNaN(r)) rowIndices.add(r);
    }
    for (const rowStr of Object.keys(sheet.rowData ?? {})) {
      const r = Number(rowStr);
      if (!Number.isNaN(r)) rowIndices.add(r);
    }
    const sortedRows = Array.from(rowIndices).sort((a, b) => a - b);

    // Rows the merges span must stay uncommitted until the merge master's
    // style is applied; since merges are declared already and we commit rows
    // strictly in ascending order after writing them, this holds.
    for (const r of sortedRows) {
      const row = ws.getRow(r + 1);
      const rowDef = sheet.rowData?.[r as any];
      if (rowDef) {
        if (rowDef.h != null && rowDef.h > 0) row.height = rowDef.h / 1.333;
        if (rowDef.hd === 1) row.hidden = true;
      }
      const colMap = sheet.cellData?.[r as any];
      if (colMap && typeof colMap === "object") {
        for (const [colStr, cellData] of Object.entries(colMap)) {
          const c = Number(colStr);
          if (!cellData || Number.isNaN(c)) continue;
          if (mergeSlaves.has(`${r}:${c}`)) continue;
          if (
            (cellData.v === null || cellData.v === undefined) &&
            !cellData.f &&
            !cellData.s
          ) {
            continue;
          }
          const cell = row.getCell(c + 1);
          applyCellValue(cell, cellData);
          if (cellData.s) applyCellStyle(cell, cellData.s);
        }
      }
      row.commit();
    }

    ws.commit();
  }

  if (sheetCount === 0) {
    throw new Error("No sheets could be converted — the snapshot may be empty.");
  }

  await wb.commit();
  const buf = wb.stream.read();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

/**
 * Convert a single Univer sheet to a CSV string.
 * Uses comma as delimiter; values with commas/newlines/quotes are quoted.
 */
export function convertSheetToCsv(sheet: UniverWorksheetData): string {
  const ws = convertSheetToSheetJsSheet(sheet);
  return XLSX.utils.sheet_to_csv(ws, { FS: "," });
}

/**
 * Look up a sheet by sheetId within a snapshot.
 * Returns undefined if not found.
 */
export function findSheet(
  snapshot: UniverWorkbookData,
  sheetId: string,
): UniverWorksheetData | undefined {
  return snapshot.sheets[sheetId];
}

// ── ExcelJS sheet build (XLSX path) ─────────────────────────────────────────────

function buildExcelJsSheet(wb: any, sheet: UniverWorksheetData, wsName: string): void {
  const ws: any = wb.addWorksheet(wsName);

  // Cells (values, formulas, styles).
  for (const [rowStr, colMap] of Object.entries(sheet.cellData ?? {})) {
    const r = Number(rowStr);
    if (!colMap || typeof colMap !== "object" || Number.isNaN(r)) continue;

    for (const [colStr, cellData] of Object.entries(colMap)) {
      const c = Number(colStr);
      if (!cellData || Number.isNaN(c)) continue;
      if (
        (cellData.v === null || cellData.v === undefined) &&
        !cellData.f &&
        !cellData.s
      ) {
        continue;
      }

      const cell = ws.getCell(r + 1, c + 1); // ExcelJS is 1-indexed
      applyCellValue(cell, cellData);
      if (cellData.s) applyCellStyle(cell, cellData.s);
    }
  }

  // Merged cells.
  for (const m of sheet.mergeData ?? []) {
    try {
      ws.mergeCells(m.startRow + 1, m.startColumn + 1, m.endRow + 1, m.endColumn + 1);
    } catch {
      // Overlapping/invalid merge ranges are non-fatal; skip.
    }
  }

  // Column widths + hidden columns (Univer w=px → ExcelJS char units ~8px/char).
  if (sheet.columnData) {
    for (const [colStr, colDef] of Object.entries(sheet.columnData)) {
      const c = Number(colStr);
      if (Number.isNaN(c) || !colDef) continue;
      const col = ws.getColumn(c + 1);
      if (colDef.w != null && colDef.w > 0) col.width = colDef.w / 8;
      if (colDef.hd === 1) col.hidden = true;
    }
  }

  // Row heights + hidden rows (Univer h=px → ExcelJS points, px/1.333).
  if (sheet.rowData) {
    for (const [rowStr, rowDef] of Object.entries(sheet.rowData)) {
      const r = Number(rowStr);
      if (Number.isNaN(r) || !rowDef) continue;
      const row = ws.getRow(r + 1);
      if (rowDef.h != null && rowDef.h > 0) row.height = rowDef.h / 1.333;
      if (rowDef.hd === 1) row.hidden = true;
    }
  }

  // Freeze panes.
  if (sheet.freeze && (sheet.freeze.xSplit > 0 || sheet.freeze.ySplit > 0)) {
    ws.views = [
      {
        state: "frozen",
        xSplit: sheet.freeze.xSplit,
        ySplit: sheet.freeze.ySplit,
      },
    ];
  }
}

function applyCellValue(cell: any, cellData: UniverCellData): void {
  if (cellData.f) {
    // ExcelJS expects the formula WITHOUT the leading `=`.
    const formula = cellData.f.startsWith("=") ? cellData.f.slice(1) : cellData.f;
    const result =
      cellData.v !== null && cellData.v !== undefined ? cellData.v : undefined;
    cell.value = { formula, result };
    return;
  }
  if (cellData.v === null || cellData.v === undefined) {
    // Style-only cell: leave value empty.
    return;
  }
  if (typeof cellData.v === "number" || typeof cellData.v === "boolean") {
    cell.value = cellData.v;
  } else {
    cell.value = String(cellData.v);
  }
}

// ── Style conversion (Univer → ExcelJS) ─────────────────────────────────────────

function toArgb(rgb: string): string {
  const hex = rgb.replace(/^#/, "").toUpperCase();
  return hex.length === 8 ? hex : `FF${hex}`;
}

function convertBorderSide(side: UniverBorderSide | undefined): any | undefined {
  if (!side) return undefined;
  const style = BORDER_STYLE_REVERSE[side.s] ?? "thin";
  const out: any = { style };
  if (side.cl?.rgb) out.color = { argb: toArgb(side.cl.rgb) };
  return out;
}

function applyCellStyle(cell: any, style: UniverCellStyle): void {
  // Font.
  const font: any = {};
  let hasFont = false;
  if (style.bl === 1) { font.bold = true; hasFont = true; }
  if (style.it === 1) { font.italic = true; hasFont = true; }
  if (style.ul?.s === 1) { font.underline = true; hasFont = true; }
  if (style.st?.s === 1) { font.strike = true; hasFont = true; }
  if (style.ff) { font.name = style.ff; hasFont = true; }
  if (typeof style.fs === "number" && style.fs > 0) { font.size = style.fs; hasFont = true; }
  if (style.cl?.rgb) { font.color = { argb: toArgb(style.cl.rgb) }; hasFont = true; }
  if (hasFont) cell.font = font;

  // Fill / background.
  if (style.bg?.rgb) {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: toArgb(style.bg.rgb) },
    };
  }

  // Number format.
  if (style.n?.pattern) {
    cell.numFmt = style.n.pattern;
  }

  // Alignment + text wrap.
  const alignment: any = {};
  let hasAlignment = false;
  if (style.ht != null && H_ALIGN_REVERSE[style.ht]) {
    alignment.horizontal = H_ALIGN_REVERSE[style.ht];
    hasAlignment = true;
  }
  if (style.vt != null && V_ALIGN_REVERSE[style.vt]) {
    alignment.vertical = V_ALIGN_REVERSE[style.vt];
    hasAlignment = true;
  }
  if (style.tb === 2) {
    alignment.wrapText = true;
    hasAlignment = true;
  }
  if (hasAlignment) cell.alignment = alignment;

  // Borders.
  if (style.bd) {
    const border: any = {};
    let hasBorder = false;
    const top = convertBorderSide(style.bd.t);
    const left = convertBorderSide(style.bd.l);
    const bottom = convertBorderSide(style.bd.b);
    const right = convertBorderSide(style.bd.r);
    if (top) { border.top = top; hasBorder = true; }
    if (left) { border.left = left; hasBorder = true; }
    if (bottom) { border.bottom = bottom; hasBorder = true; }
    if (right) { border.right = right; hasBorder = true; }
    if (hasBorder) cell.border = border;
  }
}

// ── SheetJS sheet build (CSV path only) ─────────────────────────────────────────

function convertSheetToSheetJsSheet(sheet: UniverWorksheetData): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};

  let maxRow = 0;
  let maxCol = 0;

  for (const [rowStr, colMap] of Object.entries(sheet.cellData ?? {})) {
    const r = Number(rowStr);
    if (!colMap || typeof colMap !== "object") continue;

    for (const [colStr, cellData] of Object.entries(colMap)) {
      const c = Number(colStr);
      if (!cellData) continue;

      const cell = convertCellToSheetJs(cellData);
      if (cell) {
        const addr = XLSX.utils.encode_cell({ r, c });
        ws[addr] = cell;
        if (r > maxRow) maxRow = r;
        if (c > maxCol) maxCol = c;
      }
    }
  }

  if (Object.keys(ws).length > 0) {
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });
  } else {
    ws["!ref"] = "A1:A1";
  }

  return ws;
}

function convertCellToSheetJs(cell: UniverCellData): XLSX.CellObject | null {
  if (cell.v === null || cell.v === undefined) {
    if (!cell.f) return null;
  }

  const out: XLSX.CellObject = { t: "z", v: undefined };

  if (cell.f) {
    const formula = cell.f.startsWith("=") ? cell.f.slice(1) : cell.f;
    out.f = formula;
    if (cell.v !== null && cell.v !== undefined) {
      if (typeof cell.v === "number") {
        out.t = "n";
        out.v = cell.v;
      } else if (typeof cell.v === "boolean") {
        out.t = "b";
        out.v = cell.v;
      } else {
        out.t = "s";
        out.v = String(cell.v);
      }
    } else {
      out.t = "n";
      out.v = 0;
    }
  } else if (typeof cell.v === "number") {
    out.t = "n";
    out.v = cell.v;
  } else if (typeof cell.v === "boolean") {
    out.t = "b";
    out.v = cell.v;
  } else {
    out.t = "s";
    out.v = String(cell.v);
  }

  return out;
}
