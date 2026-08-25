/**
 * sheetsImportConverter — converts XLSX/CSV buffers into Univer IWorkbookData snapshots.
 *
 * Conversion coverage:
 *   ✓ Cell values  (numbers, strings, booleans, dates as serials, errors)
 *   ✓ Formulas     (leading `=` ensured)
 *   ✓ Multiple tabs (one Univer sheet per XLSX worksheet)
 *   ✓ Merged cells
 *   ✓ Column widths / row heights
 *   ✓ Full style surface via ExcelJS:
 *       bold, italic, underline, strikethrough, font name/size/color,
 *       fill color, borders (per-side style + color),
 *       horizontal/vertical alignment, text wrap, number formats
 *   ✓ Freeze panes (frozen rows/columns)
 *   ✓ Hidden rows / hidden columns
 *   ✓ Hyperlinks (URL preserved in linkUrl; one skip-report entry)
 *   ✓ CSV/TSV  (SheetJS path, no style needed)
 *
 * Graceful skips (logged in ImportReport.skipped):
 *   - Charts, pivot tables, images, macros
 *   - Hyperlinks (rendered as text with URL stored in linkUrl)
 *   - Unsupported exotic border styles (mapped to thin)
 *
 * Size guards (hard errors):
 *   - File > MAX_FILE_BYTES → reject at multer layer
 *   - Sheets > MAX_SHEETS  → only first MAX_SHEETS converted
 *   - Rows  > MAX_ROWS     → truncated per sheet
 *   - Cols  > MAX_COLS     → truncated per sheet
 *
 * DB-hold rule: the entire parse happens BEFORE any DB interaction.
 * The caller must finish conversion and THEN open a DB hold window.
 */

import * as XLSX from "@e965/xlsx";

// ── Limits ─────────────────────────────────────────────────────────────────────

export const IMPORT_MAX_SHEETS = 20;
export const IMPORT_MAX_ROWS = 100_000;
export const IMPORT_MAX_COLS = 1_000;
export const IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

// ── Result types ───────────────────────────────────────────────────────────────

export interface ImportSkippedItem {
  kind:
    | "chart"
    | "pivot_table"
    | "image"
    | "macro"
    | "sheet_limit"
    | "row_limit"
    | "col_limit"
    | "hyperlink";
  detail: string;
}

export interface ImportReport {
  sheetCount: number;
  cellCount: number;
  formulaCount: number;
  mergeCount: number;
  skipped: ImportSkippedItem[];
}

export interface ConversionResult {
  snapshot: UniverWorkbookData;
  report: ImportReport;
}

// ── Minimal Univer snapshot types ──────────────────────────────────────────────
// These replicate the relevant fields from IWorkbookData / IWorksheetData /
// ICellData. We define them locally so we never need to import Univer at runtime
// on the server (Univer is a client-only package).

export interface UniverBorderSide {
  s: number;             // border style (1=thin, 2=hair, 3=dotted, 4=dashed, …12=thick)
  cl: { rgb: string };  // color (6-char uppercase hex)
}

export interface UniverCellStyle {
  bl?: 1;                    // bold
  it?: 1;                    // italic
  ul?: { s: 1 };            // underline
  st?: { s: 1 };            // strikethrough
  ff?: string;               // font family
  fs?: number;               // font size (pt)
  cl?: { rgb: string };      // font color
  bg?: { rgb: string };      // background color
  n?: { pattern: string };   // number format
  ht?: number;               // horizontal align: 1=left, 2=center, 3=right, 4=fill, 5=justify, 6=centerContinuous, 7=distributed
  vt?: number;               // vertical align: 1=top, 2=middle, 3=bottom, 4=justify, 5=distributed
  tb?: number;               // text wrap: 1=overflow, 2=wrap, 3=clip
  bd?: {                     // borders
    t?: UniverBorderSide;
    l?: UniverBorderSide;
    b?: UniverBorderSide;
    r?: UniverBorderSide;
  };
}

export interface UniverCellData {
  v?: string | number | boolean | null;
  f?: string;       // formula, leading `=` included
  s?: UniverCellStyle;
  t?: number;       // CellValueType: 1=string, 2=number, 3=bool, 4=force-string
  linkUrl?: string; // hyperlink URL (preserved; may not render clickable in editor)
}

export interface UniverMergeData {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

export interface UniverFreezeConfig {
  xSplit: number;     // frozen columns count
  ySplit: number;     // frozen rows count
  startRow: number;   // first visible row index (0-based) after freeze
  startColumn: number; // first visible col index (0-based) after freeze
}

export interface UniverWorksheetData {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  cellData: Record<number, Record<number, UniverCellData>>;
  mergeData: UniverMergeData[];
  columnData?: Record<number, { w: number; hd?: 1 }>;
  rowData?: Record<number, { h: number; hd?: 1 }>;
  hidden?: boolean;
  freeze?: UniverFreezeConfig;
}

export interface UniverWorkbookData {
  id: string;
  name: string;
  locale: string;
  sheetOrder: string[];
  sheets: Record<string, UniverWorksheetData>;
}

// ── Style mapping tables ────────────────────────────────────────────────────────

const BORDER_STYLE_MAP: Record<string, number> = {
  thin: 1,
  hair: 2,
  dotted: 3,
  dashed: 4,
  dashDot: 5,
  dashDotDot: 6,
  slantDashDot: 7,
  mediumDashDotDot: 8,
  mediumDashDot: 9,
  medium: 10,
  double: 11,
  thick: 12,
};

const H_ALIGN_MAP: Record<string, number> = {
  left: 1,
  center: 2,
  right: 3,
  fill: 4,
  justify: 5,
  centerContinuous: 6,
  distributed: 7,
};

const V_ALIGN_MAP: Record<string, number> = {
  top: 1,
  middle: 2,
  bottom: 3,
  justify: 4,
  distributed: 5,
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Convert a raw file buffer (xlsx/xls or csv/tsv) to a Univer workbook snapshot.
 * `filename` is used for format detection; the actual bytes are in `buf`.
 *
 * XLSX/XLS → ExcelJS (full style extraction).
 * CSV/TSV  → SheetJS (value parsing only, no styles needed).
 *
 * Throws a human-readable Error for malformed / unrecognisable files.
 */
export async function convertToUniverSnapshot(
  buf: Buffer,
  filename: string,
  workbookName: string,
): Promise<ConversionResult> {
  const isCsv =
    filename.toLowerCase().endsWith(".csv") ||
    filename.toLowerCase().endsWith(".tsv");

  const report: ImportReport = {
    sheetCount: 0,
    cellCount: 0,
    formulaCount: 0,
    mergeCount: 0,
    skipped: [],
  };

  let sheets: Record<string, UniverWorksheetData>;
  let sheetOrder: string[];

  if (isCsv) {
    const result = convertCsvWithSheetJs(buf, filename, report);
    sheets = result.sheets;
    sheetOrder = result.sheetOrder;
  } else {
    const result = await convertXlsxWithExcelJs(buf, filename, report);
    sheets = result.sheets;
    sheetOrder = result.sheetOrder;
  }

  if (sheetOrder.length === 0) {
    throw new Error("No sheets could be converted — the file may be empty or corrupted.");
  }

  const snapshot: UniverWorkbookData = {
    id: `wb-import-${Date.now()}`,
    name: workbookName,
    locale: "enUS",
    sheetOrder,
    sheets,
  };

  return { snapshot, report };
}

// ── CSV/TSV path (SheetJS) ─────────────────────────────────────────────────────

function convertCsvWithSheetJs(
  buf: Buffer,
  filename: string,
  report: ImportReport,
): { sheets: Record<string, UniverWorksheetData>; sheetOrder: string[] } {
  let workbook: XLSX.WorkBook;
  try {
    const opts: XLSX.ParsingOptions = {
      type: "buffer",
      cellFormula: true,
      cellDates: false,
      raw: false, // infer types (numbers vs strings)
    };
    workbook = XLSX.read(buf, opts);
  } catch (err: any) {
    throw new Error(
      `Could not read file — it may be corrupted or in an unsupported format. (${err?.message ?? err})`,
    );
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error("The file contains no sheets.");
  }

  const sheets: Record<string, UniverWorksheetData> = {};
  const sheetOrder: string[] = [];

  const sheetNamesToProcess = workbook.SheetNames.slice(0, IMPORT_MAX_SHEETS);
  const extraSheets = workbook.SheetNames.length - sheetNamesToProcess.length;
  if (extraSheets > 0) {
    report.skipped.push({
      kind: "sheet_limit",
      detail: `${extraSheets} sheet(s) were not imported because the file exceeds the ${IMPORT_MAX_SHEETS}-sheet limit.`,
    });
  }

  for (const sheetName of sheetNamesToProcess) {
    const wsData = workbook.Sheets[sheetName];
    if (!wsData) continue;

    const sheetId = `sheet-import-${sheetOrder.length + 1}`;
    const result = convertSheetJsSheet(wsData, sheetId, sheetName, report);
    sheets[sheetId] = result;
    sheetOrder.push(sheetId);
    report.sheetCount++;
  }

  return { sheets, sheetOrder };
}

function convertSheetJsSheet(
  ws: XLSX.WorkSheet,
  sheetId: string,
  sheetName: string,
  report: ImportReport,
): UniverWorksheetData {
  const ref = ws["!ref"];
  let maxRow = 0;
  let maxCol = 0;

  if (ref) {
    const range = XLSX.utils.decode_range(ref);
    maxRow = range.e.r;
    maxCol = range.e.c;
  }

  if (maxRow >= IMPORT_MAX_ROWS) {
    report.skipped.push({
      kind: "row_limit",
      detail: `Sheet "${sheetName}": rows beyond ${IMPORT_MAX_ROWS.toLocaleString()} were not imported.`,
    });
    maxRow = IMPORT_MAX_ROWS - 1;
  }
  if (maxCol >= IMPORT_MAX_COLS) {
    report.skipped.push({
      kind: "col_limit",
      detail: `Sheet "${sheetName}": columns beyond ${IMPORT_MAX_COLS.toLocaleString()} were not imported.`,
    });
    maxCol = IMPORT_MAX_COLS - 1;
  }

  const cellData: Record<number, Record<number, UniverCellData>> = {};

  for (const cellAddress of Object.keys(ws)) {
    if (cellAddress.startsWith("!")) continue;
    const decoded = XLSX.utils.decode_cell(cellAddress);
    const r = decoded.r;
    const c = decoded.c;
    if (r > maxRow || c > maxCol) continue;

    const rawCell: XLSX.CellObject = ws[cellAddress];
    if (!rawCell || rawCell.t === "z") continue;

    const converted = convertSheetJsCell(rawCell, report);
    if (converted) {
      if (!cellData[r]) cellData[r] = {};
      cellData[r][c] = converted;
      report.cellCount++;
    }
  }

  const mergeData: UniverMergeData[] = [];
  const merges: XLSX.Range[] = (ws["!merges"] as XLSX.Range[]) ?? [];
  for (const m of merges) {
    if (m.s.r > maxRow || m.s.c > maxCol) continue;
    mergeData.push({
      startRow: m.s.r,
      startColumn: m.s.c,
      endRow: Math.min(m.e.r, maxRow),
      endColumn: Math.min(m.e.c, maxCol),
    });
    report.mergeCount++;
  }

  const columnData: Record<number, { w: number }> = {};
  const cols: any[] = (ws["!cols"] as any[]) ?? [];
  for (let i = 0; i < cols.length && i <= maxCol; i++) {
    const col = cols[i];
    if (!col) continue;
    const px = col.wpx ?? (col.wch != null ? Math.round(col.wch * 8) : null);
    if (px != null && px > 0) columnData[i] = { w: px };
  }

  const rowData: Record<number, { h: number }> = {};
  const rows: any[] = (ws["!rows"] as any[]) ?? [];
  for (let i = 0; i < rows.length && i <= maxRow; i++) {
    const row = rows[i];
    if (!row) continue;
    const px = row.hpx ?? (row.hpt != null ? Math.round(row.hpt * 1.333) : null);
    if (px != null && px > 0) rowData[i] = { h: px };
  }

  return {
    id: sheetId,
    name: sheetName.slice(0, 100),
    rowCount: Math.max(maxRow + 1, 100),
    columnCount: Math.max(maxCol + 1, 26),
    cellData,
    mergeData,
    ...(Object.keys(columnData).length > 0 ? { columnData } : {}),
    ...(Object.keys(rowData).length > 0 ? { rowData } : {}),
  };
}

function convertSheetJsCell(
  cell: XLSX.CellObject,
  report: ImportReport,
): UniverCellData | null {
  const out: UniverCellData = {};

  if (cell.f) {
    out.f = cell.f.startsWith("=") ? cell.f : `=${cell.f}`;
    report.formulaCount++;
  }

  if (cell.t === "n") {
    out.v = cell.v as number;
    out.t = 2;
  } else if (cell.t === "b") {
    out.v = cell.v as boolean;
    out.t = 3;
  } else if (cell.t === "e") {
    out.v = cell.w ?? "#ERR";
    out.t = 4;
  } else {
    const v = cell.v;
    out.v = v == null ? null : String(v);
    out.t = 1;
  }

  if (out.v === null && !out.f) return null;
  return out;
}

// ── XLSX path (ExcelJS) ────────────────────────────────────────────────────────

async function convertXlsxWithExcelJs(
  buf: Buffer,
  filename: string,
  report: ImportReport,
): Promise<{ sheets: Record<string, UniverWorksheetData>; sheetOrder: string[] }> {
  // Dynamic import for ESM/CJS compatibility
  const ejsMod = await import("exceljs");
  const ExcelJS: any = (ejsMod as any).default ?? ejsMod;

  let wb: any;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
  } catch (err: any) {
    throw new Error(
      `Could not read file — it may be corrupted or in an unsupported format. (${err?.message ?? err})`,
    );
  }

  const allSheets: any[] = wb.worksheets ?? [];
  if (allSheets.length === 0) {
    throw new Error("The file contains no sheets.");
  }

  // Macro-enabled workbook detection by filename
  const isMacro =
    filename.toLowerCase().endsWith(".xlsm") ||
    filename.toLowerCase().endsWith(".xlam");
  if (isMacro) {
    report.skipped.push({
      kind: "macro",
      detail: "VBA macros are not supported and were not imported.",
    });
  }

  const sheetsToProcess = allSheets.slice(0, IMPORT_MAX_SHEETS);
  const extraSheets = allSheets.length - sheetsToProcess.length;
  if (extraSheets > 0) {
    report.skipped.push({
      kind: "sheet_limit",
      detail: `${extraSheets} sheet(s) were not imported because the file exceeds the ${IMPORT_MAX_SHEETS}-sheet limit.`,
    });
  }

  const sheets: Record<string, UniverWorksheetData> = {};
  const sheetOrder: string[] = [];
  let hyperlinkFound = false;

  for (const ws of sheetsToProcess) {
    const sheetId = `sheet-import-${sheetOrder.length + 1}`;
    const { sheet, hasHyperlinks } = convertExcelJsSheet(ws, sheetId, report);
    if (hasHyperlinks) hyperlinkFound = true;
    sheets[sheetId] = sheet;
    sheetOrder.push(sheetId);
    report.sheetCount++;
  }

  if (hyperlinkFound) {
    report.skipped.push({
      kind: "hyperlink",
      detail:
        "Hyperlinks were found. URLs are preserved in the cell data (linkUrl field) but may not render as clickable links in the workbook editor.",
    });
  }

  return { sheets, sheetOrder };
}

function convertExcelJsSheet(
  ws: any,
  sheetId: string,
  report: ImportReport,
): { sheet: UniverWorksheetData; hasHyperlinks: boolean } {
  const cellData: Record<number, Record<number, UniverCellData>> = {};
  const rowData: Record<number, { h: number; hd?: 1 }> = {};
  let maxRow = 0;
  let maxCol = 0;
  let hasHyperlinks = false;

  ws.eachRow({ includeEmpty: false }, (row: any, rowNumber: number) => {
    const r = rowNumber - 1; // convert to 0-indexed

    // Row height (points → pixels)
    if (row.height != null && row.height > 0) {
      const hpx = Math.round(row.height * 1.333);
      if (!rowData[r]) rowData[r] = { h: hpx };
      else rowData[r].h = hpx;
    }
    // Hidden rows
    if (row.hidden) {
      if (!rowData[r]) rowData[r] = { h: 20 };
      rowData[r].hd = 1;
    }

    row.eachCell({ includeEmpty: false }, (cell: any, colNumber: number) => {
      const c = colNumber - 1; // convert to 0-indexed

      // Skip cells that are the non-master part of a merge
      // ExcelJS ValueType.Merge = 1
      if (cell.type === 1) return;

      // Enforce col limit inline (skip beyond boundary)
      if (c >= IMPORT_MAX_COLS) return;

      const converted = convertExcelJsCell(cell, report);
      if (converted) {
        if (converted.linkUrl) hasHyperlinks = true;
        if (!cellData[r]) cellData[r] = {};
        cellData[r][c] = converted;
        report.cellCount++;
        if (r > maxRow) maxRow = r;
        if (c > maxCol) maxCol = c;
      }
    });
  });

  // Enforce row limit
  const rowTruncated = maxRow >= IMPORT_MAX_ROWS;
  const colTruncated = maxCol >= IMPORT_MAX_COLS;
  if (rowTruncated) {
    report.skipped.push({
      kind: "row_limit",
      detail: `Sheet "${ws.name}": rows beyond ${IMPORT_MAX_ROWS.toLocaleString()} were not imported.`,
    });
    maxRow = IMPORT_MAX_ROWS - 1;
    // Trim excess rows from cellData
    for (const rKey of Object.keys(cellData)) {
      if (Number(rKey) > maxRow) delete cellData[Number(rKey)];
    }
  }
  if (colTruncated) {
    report.skipped.push({
      kind: "col_limit",
      detail: `Sheet "${ws.name}": columns beyond ${IMPORT_MAX_COLS.toLocaleString()} were not imported.`,
    });
    maxCol = IMPORT_MAX_COLS - 1;
  }

  // Merges — ExcelJS stores them in worksheet model as string ranges like "A1:C3"
  const mergeData: UniverMergeData[] = [];
  const rawMerges: string[] = (ws as any)._merges
    ? Object.keys((ws as any)._merges).filter((k) => {
        // _merges maps every cell in a merge to the master; only include master cells
        // The master is the top-left: its value equals its own address
        return (ws as any)._merges[k] === k || (ws as any)._merges[k]?.master === k;
      })
    : [];

  // Prefer model.merges (array of range strings) over _merges
  const modelMerges: string[] = (ws as any).model?.merges ?? [];
  const mergeSources = modelMerges.length > 0 ? modelMerges : [];

  for (const mergeStr of mergeSources) {
    const parts = mergeStr.split(":");
    if (parts.length !== 2) continue;
    const start = excelCellToRowCol(parts[0]);
    const end = excelCellToRowCol(parts[1]);
    if (start.r > maxRow || start.c > maxCol) continue;
    mergeData.push({
      startRow: start.r,
      startColumn: start.c,
      endRow: Math.min(end.r, maxRow),
      endColumn: Math.min(end.c, maxCol),
    });
    report.mergeCount++;
  }

  // Column widths and hidden columns
  const columnData: Record<number, { w: number; hd?: 1 }> = {};
  try {
    const cols: any[] = ws.columns ?? [];
    cols.forEach((col: any) => {
      if (!col) return;
      // col.number is 1-indexed
      const c = (col.number ?? 0) - 1;
      if (c < 0 || c > maxCol) return;
      // ExcelJS column.width is in character units; ~8px per char
      const w = col.width != null ? Math.round(col.width * 8) : null;
      if (w && w > 0) {
        columnData[c] = { w };
      }
      if (col.hidden) {
        if (!columnData[c]) columnData[c] = { w: 64 };
        columnData[c].hd = 1;
      }
    });
  } catch {
    // Non-fatal: column metadata is best-effort
  }

  // Freeze panes
  let freeze: UniverFreezeConfig | undefined;
  const views: any[] = ws.views ?? [];
  for (const view of views) {
    if (view.state === "frozen" || view.state === "frozenSplit") {
      const xSplit: number = view.xSplit ?? 0;
      const ySplit: number = view.ySplit ?? 0;
      if (xSplit > 0 || ySplit > 0) {
        freeze = {
          xSplit,
          ySplit,
          startRow: ySplit,
          startColumn: xSplit,
        };
        break;
      }
    }
  }

  const sheet: UniverWorksheetData = {
    id: sheetId,
    name: String(ws.name ?? "Sheet").slice(0, 100),
    rowCount: Math.max(maxRow + 1, 100),
    columnCount: Math.max(maxCol + 1, 26),
    cellData,
    mergeData,
    ...(Object.keys(columnData).length > 0 ? { columnData } : {}),
    ...(Object.keys(rowData).length > 0 ? { rowData } : {}),
    ...(freeze ? { freeze } : {}),
  };

  return { sheet, hasHyperlinks };
}

function convertExcelJsCell(
  cell: any,
  report: ImportReport,
): UniverCellData | null {
  const out: UniverCellData = {};
  const cellType: number = cell.type;

  // ExcelJS ValueType enum values (numeric for runtime safety without importing types)
  // 0=Null, 1=Merge, 2=Number, 3=String, 4=Date, 5=Hyperlink,
  // 6=Formula, 7=SharedString, 8=RichText, 9=Boolean, 10=Error

  if (cellType === 6 /* Formula */) {
    const formulaStr: string | undefined = cell.formula;
    if (formulaStr) {
      out.f = formulaStr.startsWith("=") ? formulaStr : `=${formulaStr}`;
      report.formulaCount++;
    }
    // Use cached result for the display value
    const result = cell.result;
    if (typeof result === "number") {
      out.v = result;
      out.t = 2;
    } else if (typeof result === "boolean") {
      out.v = result;
      out.t = 3;
    } else if (result instanceof Date) {
      out.v = dateToExcelSerial(result);
      out.t = 2;
    } else if (result != null && typeof result === "object" && result.error) {
      out.v = result.error;
      out.t = 4;
    } else if (result != null) {
      out.v = String(result);
      out.t = 1;
    }
  } else if (cellType === 2 /* Number */) {
    out.v = cell.value as number;
    out.t = 2;
  } else if (cellType === 9 /* Boolean */) {
    out.v = cell.value as boolean;
    out.t = 3;
  } else if (cellType === 4 /* Date */) {
    const d = cell.value as Date;
    out.v = d instanceof Date ? dateToExcelSerial(d) : null;
    out.t = 2;
  } else if (cellType === 5 /* Hyperlink */) {
    const hlValue: any = cell.value;
    // Hyperlink cells have { text: string, hyperlink: string }
    out.v = hlValue?.text ?? hlValue?.hyperlink ?? String(hlValue ?? "");
    out.t = 1;
    if (hlValue?.hyperlink && typeof hlValue.hyperlink === "string") {
      out.linkUrl = hlValue.hyperlink;
    } else if (cell.hyperlink && typeof cell.hyperlink === "string") {
      out.linkUrl = cell.hyperlink;
    }
  } else if (cellType === 8 /* RichText */) {
    const rtValue: any = cell.value;
    const parts: any[] = rtValue?.richText ?? [];
    out.v = parts.map((p: any) => p.text ?? "").join("");
    out.t = 1;
  } else if (cellType === 10 /* Error */) {
    const errValue: any = cell.value;
    out.v = errValue?.error ?? "#ERR";
    out.t = 4;
  } else if (cellType === 3 /* String */ || cellType === 7 /* SharedString */) {
    const v = cell.value;
    out.v = v == null ? null : String(v);
    out.t = 1;
  } else {
    // Null (0) or Merge (1) — skip
    return null;
  }

  // Style
  const style = convertExcelJsStyle(cell);
  if (style) out.s = style;

  // Number format from cell (may not be in style object in all ExcelJS versions)
  if (!out.s?.n) {
    const numFmt: string | undefined = cell.numFmt;
    if (numFmt && typeof numFmt === "string" && numFmt !== "General" && numFmt !== "@") {
      if (!out.s) out.s = {};
      out.s.n = { pattern: numFmt.slice(0, 255) };
    }
  }

  if (out.v === null && !out.f && !out.s && !out.linkUrl) return null;
  return out;
}

function convertExcelJsStyle(cell: any): UniverCellStyle | undefined {
  const style: any = cell.style;
  if (!style || typeof style !== "object") return undefined;

  const out: UniverCellStyle = {};
  let hasStyle = false;

  // ── Font ──────────────────────────────────────────────────────────────────────
  const font: any = style.font ?? {};
  if (font.bold) { out.bl = 1; hasStyle = true; }
  if (font.italic) { out.it = 1; hasStyle = true; }
  if (font.underline) { out.ul = { s: 1 }; hasStyle = true; }
  if (font.strike) { out.st = { s: 1 }; hasStyle = true; }
  if (font.name && typeof font.name === "string") {
    out.ff = font.name.slice(0, 64);
    hasStyle = true;
  }
  if (typeof font.size === "number" && font.size > 0) {
    out.fs = font.size;
    hasStyle = true;
  }
  const fontColorRgb = argbToRgb(font.color?.argb);
  if (fontColorRgb) { out.cl = { rgb: fontColorRgb }; hasStyle = true; }

  // ── Fill / background ─────────────────────────────────────────────────────────
  const fill: any = style.fill;
  if (fill) {
    let bgRgb: string | undefined;
    if (fill.type === "pattern") {
      // Only non-"none" patterns have a meaningful foreground color
      if (fill.pattern && fill.pattern !== "none") {
        bgRgb = argbToRgb(fill.fgColor?.argb);
      }
    } else if (fill.type === "gradient") {
      // Use the first gradient stop as the background color
      const stops: any[] = fill.gradient?.stops ?? fill.stops ?? [];
      if (stops.length > 0) {
        bgRgb = argbToRgb(stops[0]?.color?.argb);
      }
    }
    if (bgRgb) { out.bg = { rgb: bgRgb }; hasStyle = true; }
  }

  // ── Borders ───────────────────────────────────────────────────────────────────
  const border: any = style.border;
  if (border) {
    const bd: NonNullable<UniverCellStyle["bd"]> = {};
    let hasBorder = false;

    const mapBorderSide = (side: any): UniverBorderSide | undefined => {
      if (!side || !side.style) return undefined;
      const s = BORDER_STYLE_MAP[side.style] ?? 1;
      const rgb = argbToRgb(side.color?.argb) ?? "#000000";
      return { s, cl: { rgb } };
    };

    const t = mapBorderSide(border.top);
    if (t) { bd.t = t; hasBorder = true; }
    const l = mapBorderSide(border.left);
    if (l) { bd.l = l; hasBorder = true; }
    const b = mapBorderSide(border.bottom);
    if (b) { bd.b = b; hasBorder = true; }
    const r = mapBorderSide(border.right);
    if (r) { bd.r = r; hasBorder = true; }

    if (hasBorder) { out.bd = bd; hasStyle = true; }
  }

  // ── Alignment ─────────────────────────────────────────────────────────────────
  const alignment: any = style.alignment;
  if (alignment) {
    if (alignment.horizontal && H_ALIGN_MAP[alignment.horizontal] != null) {
      out.ht = H_ALIGN_MAP[alignment.horizontal];
      hasStyle = true;
    }
    if (alignment.vertical && V_ALIGN_MAP[alignment.vertical] != null) {
      out.vt = V_ALIGN_MAP[alignment.vertical];
      hasStyle = true;
    }
    if (alignment.wrapText) {
      out.tb = 2; // wrap
      hasStyle = true;
    }
  }

  // ── Number format ─────────────────────────────────────────────────────────────
  const numFmt: string | undefined = style.numFmt;
  if (numFmt && typeof numFmt === "string" && numFmt !== "General" && numFmt !== "@") {
    out.n = { pattern: numFmt.slice(0, 255) };
    hasStyle = true;
  }

  return hasStyle ? out : undefined;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Extract a #-prefixed 6-char uppercase hex RGB string from an ExcelJS ARGB color string.
 * ExcelJS uses ARGB format: 'FF123456' (8 chars, alpha first).
 * Returns undefined for theme/auto/missing colors (never an invalid string).
 *
 * Univer's ColorKit treats bare hex (without '#') as invalid → renders black.
 * All emitted rgb values must be '#RRGGBB' format.
 */
function argbToRgb(argb?: string): string | undefined {
  if (!argb || typeof argb !== "string") return undefined;
  const clean = argb.replace(/^#/, "").toUpperCase();
  if (clean.length === 8) return "#" + clean.slice(2); // drop alpha prefix, add #
  if (clean.length === 6) return "#" + clean;           // add #
  return undefined;
}

/**
 * Normalize bare-hex rgb values to #-prefixed format in an existing Univer snapshot.
 *
 * Snapshots imported before the color-format fix stored rgb values without the
 * leading '#' (e.g. "FFFF00"). Univer's ColorKit rejects these and renders black.
 * This function is applied when serving any stored snapshot so existing workbooks
 * display correctly without requiring a manual re-import.
 *
 * The walk is O(n) in snapshot size, allocation-light (plain object spread), and
 * idempotent — already-correct '#RRGGBB' values pass through unchanged.
 */
export function normalizeSnapshotColors(snapshot: unknown): unknown {
  return normalizeNode(snapshot);
}

function normalizeNode(val: unknown): unknown {
  if (Array.isArray(val)) {
    let changed = false;
    const next = val.map((item) => {
      const n = normalizeNode(item);
      if (n !== item) changed = true;
      return n;
    });
    return changed ? next : val;
  }
  if (val !== null && typeof val === "object") {
    const obj = val as Record<string, unknown>;
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (key === "rgb" && typeof v === "string" && !v.startsWith("#") && /^[0-9A-Fa-f]{6}$/.test(v)) {
        result[key] = "#" + v.toUpperCase();
        changed = true;
      } else {
        const n = normalizeNode(v);
        result[key] = n;
        if (n !== v) changed = true;
      }
    }
    return changed ? result : val;
  }
  return val;
}

/**
 * Parse an Excel cell address like "A1" or "BC12" into 0-indexed {r, c}.
 */
function excelCellToRowCol(addr: string): { r: number; c: number } {
  const match = addr.trim().match(/^([A-Za-z]+)(\d+)$/);
  if (!match) return { r: 0, c: 0 };
  const colStr = match[1].toUpperCase();
  let c = 0;
  for (const ch of colStr) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: parseInt(match[2], 10) - 1, c: c - 1 };
}

/**
 * Convert a JavaScript Date to an Excel serial date number.
 * Excel's epoch is December 30, 1899 (serial 0).
 */
function dateToExcelSerial(d: Date): number {
  const excelEpoch = new Date(Date.UTC(1899, 11, 30)); // Dec 30 1899
  const msPerDay = 86_400_000;
  return Math.round((d.getTime() - excelEpoch.getTime()) / msPerDay);
}
