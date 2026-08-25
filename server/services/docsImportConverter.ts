/**
 * NoBull Docs — DOCX → Univer document snapshot converter (Task #4024,
 * tables + images upgraded in Task #4052).
 *
 * Mirrors the Sheets import converter's role (sheetsImportConverter.ts):
 * pure in-memory conversion, no DB access, throws on unreadable input, and
 * returns a report describing anything that was skipped or simplified.
 *
 * Approach: unzip the .docx (fflate), parse `word/document.xml` (+ optional
 * `word/numbering.xml` and `word/_rels/document.xml.rels`) with jsdom in XML
 * mode, and walk the body building a Univer `IDocumentData`-shaped snapshot:
 *   - dataStream: paragraph text joined with "\r", terminated by "\n"
 *   - textRuns: bold / italic / underline / strikethrough / font size / color
 *   - paragraphs: heading levels (Title, Subtitle, Heading 1-5), alignment,
 *     and list bullets (numbering.xml decides ordered vs unordered)
 *   - tables: real Univer tables — table/row/cell control tokens in the
 *     dataStream + a `tableSource` definition per table (matching the shape
 *     Univer's own insert-table command generates)
 *   - inline images: embedded pictures become `\b` custom blocks backed by
 *     BASE64 data-URL drawings (the same shape the in-app image insert
 *     produces, so they render and re-export)
 *   - sectionBreaks: one per table cell (Univer cell convention) + a single
 *     final section break
 *
 * Remaining v1 simplifications (only genuinely unsupported constructs land
 * in the import report):
 *   - Non-picture drawings (shapes, charts, legacy w:pict / w:object) are
 *     skipped and reported.
 *   - Vertically merged table cells import as separate cells (reported).
 *   - Nested tables are flattened into their parent cell (reported).
 *   - Hyperlinks keep their text but lose the link target.
 *
 * jsdom is imported lazily so server boot doesn't pay its startup cost.
 */

import { unzipSync, strFromU8 } from "fflate";
import { randomUUID } from "node:crypto";

/** Hard cap for uploaded .docx files (same as Sheets imports). */
export const DOCS_IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

// ---- Univer data-stream control characters ----
// (from @univerjs/core DataStreamTreeTokenType)
const PARAGRAPH_MARK = "\r";
const SECTION_BREAK = "\n";
const TABLE_START = "\u001A";
const TABLE_ROW_START = "\u001B";
const TABLE_CELL_START = "\u001C";
const TABLE_CELL_END = "\u001D";
const TABLE_ROW_END = "\u000E";
const TABLE_END = "\u000F";
const CUSTOM_BLOCK = "\b";

// Univer NamedStyleType enum values (numeric).
const NAMED_STYLE = {
  NORMAL_TEXT: 1,
  TITLE: 2,
  SUBTITLE: 3,
  HEADING_1: 4,
  HEADING_2: 5,
  HEADING_3: 6,
  HEADING_4: 7,
  HEADING_5: 8,
} as const;

// Univer HorizontalAlign enum values (numeric).
const H_ALIGN = { LEFT: 1, CENTER: 2, RIGHT: 3, JUSTIFIED: 4 } as const;

// EMU (English Metric Units, OOXML extents) per point.
const EMU_PER_PT = 12700;

// Usable content width in pt (A4 width 595 − 50pt margins each side).
const PAGE_CONTENT_WIDTH_PT = 495;

export interface DocsImportReportEntry {
  type: "image_skipped" | "unsupported";
  detail: string;
}

export interface DocsImportReport {
  paragraphCount: number;
  tableCount: number;
  imagesImported: number;
  imagesSkipped: number;
  entries: DocsImportReportEntry[];
}

interface RunStyle {
  bl?: number;                       // bold 0|1
  it?: number;                       // italic 0|1
  ul?: { s: number };                // underline
  st?: { s: number };                // strikethrough
  fs?: number;                       // font size (pt)
  cl?: { rgb: string };              // font color "#RRGGBB"
}

interface PendingImage {
  dataUrl: string;
  widthPt: number;
  heightPt: number;
}

interface PendingRun {
  text: string;
  style: RunStyle | null;
  /** When set, this run is an inline image (text is ignored). */
  image?: PendingImage;
}

interface PendingParagraph {
  runs: PendingRun[];
  namedStyleType?: number;
  horizontalAlign?: number;
  bullet?: { listType: string; listId: string; nestingLevel: number };
}

interface PendingCell {
  paragraphs: PendingParagraph[];
  columnSpan?: number;
  /**
   * Grid position covered by a preceding cell's columnSpan. Covered cells
   * still get an (empty) stream cell and a tableCells entry with
   * rowSpan: 0 / columnSpan: 0 — matching Univer's own HTML-table importer.
   */
  covered?: boolean;
}

interface PendingTable {
  rows: PendingCell[][];
  columnCount: number;
}

type PendingBlock =
  | { kind: "paragraph"; paragraph: PendingParagraph }
  | { kind: "table"; table: PendingTable };

/** Media context shared by the walkers: rels map + zip entries. */
interface MediaContext {
  /** relationship id → target path inside the zip (already resolved). */
  relTargets: Map<string, string>;
  files: Record<string, Uint8Array>;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
};

/**
 * Convert a .docx buffer into a Univer document snapshot.
 * Throws when the file cannot be unzipped or its document.xml is missing
 * or unparseable — the route maps that to 422.
 */
export async function convertDocxToDocumentSnapshot(
  buffer: Buffer,
  documentTitle: string,
): Promise<{ snapshot: Record<string, unknown>; report: DocsImportReport }> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new Error("The file is not a valid .docx (could not unzip it).");
  }

  const documentXmlRaw = files["word/document.xml"];
  if (!documentXmlRaw) {
    throw new Error("The file is not a valid .docx (missing word/document.xml).");
  }

  // jsdom is heavy — load it lazily, only when an import actually runs.
  const { JSDOM } = await import("jsdom");

  let body: Element;
  try {
    const dom = new JSDOM(strFromU8(documentXmlRaw), { contentType: "text/xml" });
    const bodyEl = dom.window.document.getElementsByTagName("w:body")[0];
    if (!bodyEl) throw new Error("no body");
    body = bodyEl;
  } catch {
    throw new Error("The .docx document XML could not be parsed.");
  }

  // numbering.xml → numId → "bullet" | "ordered" (defaults to bullet when absent).
  const numberingKind = new Map<string, "bullet" | "ordered">();
  const numberingXmlRaw = files["word/numbering.xml"];
  if (numberingXmlRaw) {
    try {
      const numDom = new JSDOM(strFromU8(numberingXmlRaw), { contentType: "text/xml" });
      const numDoc = numDom.window.document;

      // abstractNumId → kind, from the level-0 numFmt.
      const abstractKind = new Map<string, "bullet" | "ordered">();
      for (const abstractNum of Array.from(numDoc.getElementsByTagName("w:abstractNum"))) {
        const id = abstractNum.getAttribute("w:abstractNumId");
        if (id === null) continue;
        let kind: "bullet" | "ordered" = "ordered";
        const firstLvl = abstractNum.getElementsByTagName("w:lvl")[0];
        const numFmt = firstLvl?.getElementsByTagName("w:numFmt")[0];
        if (numFmt?.getAttribute("w:val") === "bullet") kind = "bullet";
        abstractKind.set(id, kind);
      }

      for (const num of Array.from(numDoc.getElementsByTagName("w:num"))) {
        const numId = num.getAttribute("w:numId");
        if (numId === null) continue;
        const abstractRef = num
          .getElementsByTagName("w:abstractNumId")[0]
          ?.getAttribute("w:val");
        numberingKind.set(
          numId,
          (abstractRef !== null && abstractRef !== undefined
            ? abstractKind.get(abstractRef)
            : undefined) ?? "ordered",
        );
      }
    } catch {
      // Numbering parse failure is non-fatal — lists degrade to ordered.
    }
  }

  // document.xml.rels → rId → resolved zip path (for image parts).
  const relTargets = new Map<string, string>();
  const relsRaw = files["word/_rels/document.xml.rels"];
  if (relsRaw) {
    try {
      const relsDom = new JSDOM(strFromU8(relsRaw), { contentType: "text/xml" });
      for (const rel of Array.from(relsDom.window.document.getElementsByTagName("Relationship"))) {
        const id = rel.getAttribute("Id");
        const target = rel.getAttribute("Target");
        const mode = rel.getAttribute("TargetMode");
        if (!id || !target || mode === "External") continue;
        // Targets are relative to word/ (e.g. "media/image1.png") or
        // occasionally absolute ("/word/media/image1.png").
        const resolved = target.startsWith("/") ? target.slice(1) : `word/${target}`;
        relTargets.set(id, resolved.replace(/\\/g, "/").replace(/^word\/\.\.\//, ""));
      }
    } catch {
      // Rels parse failure is non-fatal — images degrade to skipped-with-report.
    }
  }

  const media: MediaContext = { relTargets, files };

  const report: DocsImportReport = {
    paragraphCount: 0,
    tableCount: 0,
    imagesImported: 0,
    imagesSkipped: 0,
    entries: [],
  };

  const blocks: PendingBlock[] = [];

  for (const child of Array.from(body.children)) {
    const tag = child.tagName;
    if (tag === "w:p") {
      for (const paragraph of convertParagraphElement(child, numberingKind, report, media)) {
        blocks.push({ kind: "paragraph", paragraph });
      }
    } else if (tag === "w:tbl") {
      report.tableCount += 1;
      blocks.push({ kind: "table", table: convertTable(child, numberingKind, report, media) });
    }
    // w:sectPr and anything else at body level is layout-only — ignore.
  }

  // Ensure the document has at least one (empty) paragraph, and never let a
  // table be the final block (Univer expects a trailing paragraph before the
  // section break, same as Word keeps a paragraph after every table).
  if (blocks.length === 0 || blocks[blocks.length - 1].kind === "table") {
    blocks.push({ kind: "paragraph", paragraph: { runs: [] } });
  }

  // ---- Assemble the Univer snapshot ----
  const asm = new SnapshotAssembler(report);
  for (const block of blocks) {
    if (block.kind === "paragraph") asm.appendParagraph(block.paragraph);
    else asm.appendTable(block.table);
  }

  const snapshot = asm.finish(documentTitle);
  report.paragraphCount = asm.paragraphCount;

  return { snapshot, report };
}

/** Default page setup (A4 portrait, pt units) matching a blank in-app doc. */
export function defaultDocumentStyle(): Record<string, unknown> {
  return {
    pageSize: { width: 595, height: 842 },
    marginTop: 50,
    marginBottom: 50,
    marginRight: 50,
    marginLeft: 50,
  };
}

// ---- snapshot assembler ----

/**
 * Builds the flat Univer dataStream plus all the sidecar arrays
 * (textRuns / paragraphs / sectionBreaks / customBlocks / tables) and the
 * reference sources (tableSource / drawings / drawingsOrder).
 */
class SnapshotAssembler {
  private dataStream = "";
  private textRuns: Array<{ st: number; ed: number; ts: RunStyle }> = [];
  private paragraphEntries: Array<Record<string, unknown>> = [];
  private sectionBreaks: Array<{ startIndex: number }> = [];
  private customBlocks: Array<{ startIndex: number; blockId: string }> = [];
  private tables: Array<{ startIndex: number; endIndex: number; tableId: string }> = [];
  private tableSource: Record<string, unknown> = {};
  private drawings: Record<string, unknown> = {};
  private drawingsOrder: string[] = [];
  paragraphCount = 0;

  constructor(private report: DocsImportReport) {}

  appendParagraph(para: PendingParagraph): void {
    for (const run of para.runs) {
      if (run.image) {
        this.appendImage(run.image);
        continue;
      }
      if (run.text.length === 0) continue;
      const st = this.dataStream.length;
      this.dataStream += run.text;
      if (run.style && Object.keys(run.style).length > 0) {
        this.textRuns.push({ st, ed: this.dataStream.length, ts: run.style });
      }
    }

    const paragraphStyle: Record<string, unknown> = {};
    if (para.namedStyleType !== undefined) paragraphStyle.namedStyleType = para.namedStyleType;
    if (para.horizontalAlign !== undefined) paragraphStyle.horizontalAlign = para.horizontalAlign;

    const entry: Record<string, unknown> = { startIndex: this.dataStream.length };
    if (Object.keys(paragraphStyle).length > 0) entry.paragraphStyle = paragraphStyle;
    if (para.bullet) entry.bullet = para.bullet;
    this.paragraphEntries.push(entry);

    this.dataStream += PARAGRAPH_MARK;
    this.paragraphCount += 1;
  }

  appendTable(table: PendingTable): void {
    if (table.rows.length === 0 || table.columnCount === 0) return;

    const tableId = `docx-tbl-${randomUUID().slice(0, 8)}`;
    const startIndex = this.dataStream.length;
    this.dataStream += TABLE_START;

    for (const row of table.rows) {
      this.dataStream += TABLE_ROW_START;
      for (const cell of row) {
        this.dataStream += TABLE_CELL_START;
        const paragraphs = cell.paragraphs.length > 0 ? cell.paragraphs : [{ runs: [] }];
        for (const para of paragraphs) this.appendParagraph(para);
        // Univer convention: every cell body ends with a section break
        // (genEmptyTable emits "\x1C\r\n\x1D" for an empty cell).
        this.sectionBreaks.push({ startIndex: this.dataStream.length });
        this.dataStream += SECTION_BREAK;
        this.dataStream += TABLE_CELL_END;
      }
      this.dataStream += TABLE_ROW_END;
    }

    this.dataStream += TABLE_END;
    this.tables.push({ startIndex, endIndex: this.dataStream.length, tableId });
    this.tableSource[tableId] = buildTableSource(table, tableId);
  }

  private appendImage(image: PendingImage): void {
    const blockId = `docx-img-${randomUUID().slice(0, 8)}`;
    this.customBlocks.push({ startIndex: this.dataStream.length, blockId });
    this.dataStream += CUSTOM_BLOCK;
    // Shape mirrors what the in-app insert-image command produces
    // (docs-drawing preset), so imported pictures render and re-export.
    this.drawings[blockId] = {
      unitId: "",
      subUnitId: "",
      drawingId: blockId,
      drawingType: 0, // DrawingTypeEnum.DRAWING_IMAGE
      imageSourceType: "BASE64",
      source: image.dataUrl,
      transform: {
        width: image.widthPt,
        height: image.heightPt,
        left: 0,
        top: 0,
        angle: 0,
      },
      docTransform: {
        size: { width: image.widthPt, height: image.heightPt },
        positionH: { relativeFrom: 2 /* ObjectRelativeFromH.CHARACTER */, posOffset: 0 },
        positionV: { relativeFrom: 2 /* ObjectRelativeFromV.LINE */, posOffset: 0 },
        angle: 0,
      },
      layoutType: 0, // PositionedObjectLayoutType.INLINE
      behindDoc: 0,
      title: "",
      description: "",
      wrapText: 0,
      distB: 0,
      distL: 0,
      distR: 0,
      distT: 0,
    };
    this.drawingsOrder.push(blockId);
    this.report.imagesImported += 1;
  }

  finish(documentTitle: string): Record<string, unknown> {
    const sectionBreakIndex = this.dataStream.length;
    this.dataStream += SECTION_BREAK;
    this.sectionBreaks.push({ startIndex: sectionBreakIndex });

    const body: Record<string, unknown> = {
      dataStream: this.dataStream,
      textRuns: this.textRuns,
      paragraphs: this.paragraphEntries,
      sectionBreaks: this.sectionBreaks,
    };
    if (this.customBlocks.length > 0) body.customBlocks = this.customBlocks;
    if (this.tables.length > 0) body.tables = this.tables;

    const snapshot: Record<string, unknown> = {
      id: `doc-import-${Date.now().toString(36)}`,
      title: documentTitle,
      body,
      documentStyle: defaultDocumentStyle(),
    };
    if (Object.keys(this.tableSource).length > 0) snapshot.tableSource = this.tableSource;
    if (this.drawingsOrder.length > 0) {
      snapshot.drawings = this.drawings;
      snapshot.drawingsOrder = this.drawingsOrder;
    }
    return snapshot;
  }
}

/** Build a Univer ITable definition (mirrors docs-ui genTableSource defaults). */
function buildTableSource(table: PendingTable, tableId: string): Record<string, unknown> {
  const columnWidth = PAGE_CONTENT_WIDTH_PT / table.columnCount;
  const cellMargin = {
    start: { v: 10 },
    end: { v: 10 },
    top: { v: 5 },
    bottom: { v: 5 },
  };
  return {
    tableId,
    tableRows: table.rows.map((row) => ({
      tableCells: row.map((cell) =>
        cell.covered
          ? { margin: cellMargin, rowSpan: 0, columnSpan: 0 }
          : {
              margin: cellMargin,
              ...(cell.columnSpan && cell.columnSpan > 1 ? { columnSpan: cell.columnSpan } : {}),
            },
      ),
      trHeight: { val: { v: 30 }, hRule: 0 /* TableRowHeightRule.AUTO */ },
    })),
    tableColumns: Array.from({ length: table.columnCount }, () => ({
      size: { type: 1 /* TableSizeType.SPECIFIED */, width: { v: columnWidth } },
    })),
    align: 0, // TableAlignmentType.START
    indent: { v: 0 },
    textWrap: 0, // TableTextWrapType.NONE
    position: {
      positionH: { relativeFrom: 0, posOffset: 0 },
      positionV: { relativeFrom: 0, posOffset: 0 },
    },
    dist: { distB: 0, distL: 0, distR: 0, distT: 0 },
    cellMargin,
    size: { type: 0 /* TableSizeType.UNSPECIFIED */, width: { v: PAGE_CONTENT_WIDTH_PT } },
  };
}

// ---- paragraph / run walkers ----

/**
 * Convert one `w:p` element. Soft line breaks (`w:br`) split the paragraph —
 * Univer has no soft-break token, so each visual line becomes a paragraph
 * with the same style.
 */
function convertParagraphElement(
  p: Element,
  numberingKind: Map<string, "bullet" | "ordered">,
  report: DocsImportReport,
  media: MediaContext,
): PendingParagraph[] {
  const base: Omit<PendingParagraph, "runs"> = {};

  const pPr = directChild(p, "w:pPr");
  if (pPr) {
    const styleVal = directChild(pPr, "w:pStyle")?.getAttribute("w:val") ?? "";
    const named = mapParagraphStyle(styleVal);
    if (named !== undefined) base.namedStyleType = named;

    const jc = directChild(pPr, "w:jc")?.getAttribute("w:val");
    if (jc === "center") base.horizontalAlign = H_ALIGN.CENTER;
    else if (jc === "right" || jc === "end") base.horizontalAlign = H_ALIGN.RIGHT;
    else if (jc === "both" || jc === "distribute") base.horizontalAlign = H_ALIGN.JUSTIFIED;

    const numPr = directChild(pPr, "w:numPr");
    if (numPr) {
      const numId = directChild(numPr, "w:numId")?.getAttribute("w:val");
      const ilvlRaw = directChild(numPr, "w:ilvl")?.getAttribute("w:val");
      const nestingLevel = clampInt(ilvlRaw, 0, 8);
      if (numId !== null && numId !== undefined) {
        const kind = numberingKind.get(numId) ?? "bullet";
        base.bullet = {
          // PresetListType values understood by Univer's built-in list defs.
          listType: kind === "bullet" ? "BULLET_LIST" : "ORDER_LIST",
          listId: `docx-num-${numId}`,
          nestingLevel,
        };
      }
    }
  }

  const out: PendingParagraph[] = [{ ...base, runs: [] }];

  const walk = (el: Element) => {
    for (const node of Array.from(el.children)) {
      switch (node.tagName) {
        case "w:r": {
          const style = readRunStyle(node);
          for (const part of Array.from(node.children)) {
            if (part.tagName === "w:t") {
              out[out.length - 1].runs.push({ text: part.textContent ?? "", style });
            } else if (part.tagName === "w:tab") {
              out[out.length - 1].runs.push({ text: "\t", style });
            } else if (part.tagName === "w:br") {
              // Soft break → start a new paragraph with the same style.
              out.push({ ...base, runs: [] });
            } else if (part.tagName === "w:drawing") {
              const image = extractDrawingImage(part, media, report);
              if (image) {
                out[out.length - 1].runs.push({ text: "", style: null, image });
              }
            } else if (part.tagName === "w:pict" || part.tagName === "w:object") {
              report.imagesSkipped += 1;
              report.entries.push({
                type: "image_skipped",
                detail: "A legacy embedded picture/object (VML) was skipped during import.",
              });
            }
          }
          break;
        }
        case "w:hyperlink":
          // Keep the link text; the target is dropped (v1 limitation).
          walk(node);
          break;
        case "w:smartTag":
        case "w:ins":
          walk(node);
          break;
        default:
          break;
      }
    }
  };
  walk(p);

  return out;
}

/**
 * Extract an inline/anchored picture from a `w:drawing` element as a BASE64
 * data-URL image. Returns null (with a report entry) for non-picture
 * drawings (shapes, charts) or unresolvable/unsupported image parts.
 */
function extractDrawingImage(
  drawing: Element,
  media: MediaContext,
  report: DocsImportReport,
): PendingImage | null {
  const skip = (detail: string): null => {
    report.imagesSkipped += 1;
    report.entries.push({ type: "image_skipped", detail });
    return null;
  };

  // Pictures reference their image part via a:blip r:embed.
  const blip = drawing.getElementsByTagName("a:blip")[0];
  if (!blip) {
    return skip("A non-picture drawing (shape/chart) was skipped during import.");
  }
  const relId = blip.getAttribute("r:embed") ?? blip.getAttribute("r:link");
  if (!relId) {
    return skip("An embedded picture had no image reference and was skipped.");
  }
  const target = media.relTargets.get(relId);
  const data = target ? media.files[target] : undefined;
  if (!data) {
    return skip("An embedded picture referenced a missing image part and was skipped.");
  }

  const ext = (target!.split(".").pop() ?? "").toLowerCase();
  const mime = IMAGE_MIME_BY_EXT[ext];
  if (!mime) {
    return skip(`An embedded image of unsupported type ".${ext}" was skipped during import.`);
  }

  // Size from wp:extent (EMU). Fall back to a sane default.
  let widthPt = 300;
  let heightPt = 200;
  const extent = drawing.getElementsByTagName("wp:extent")[0];
  const cx = Number(extent?.getAttribute("cx"));
  const cy = Number(extent?.getAttribute("cy"));
  if (Number.isFinite(cx) && cx > 0 && Number.isFinite(cy) && cy > 0) {
    widthPt = Math.max(4, Math.round(cx / EMU_PER_PT));
    heightPt = Math.max(4, Math.round(cy / EMU_PER_PT));
    // Clamp to the page content width, preserving aspect ratio.
    if (widthPt > PAGE_CONTENT_WIDTH_PT) {
      heightPt = Math.max(4, Math.round((heightPt * PAGE_CONTENT_WIDTH_PT) / widthPt));
      widthPt = PAGE_CONTENT_WIDTH_PT;
    }
  }

  const dataUrl = `data:${mime};base64,${Buffer.from(data).toString("base64")}`;
  return { dataUrl, widthPt, heightPt };
}

/** Convert a `w:tbl` into a real pending table (rows → cells → paragraphs). */
function convertTable(
  tbl: Element,
  numberingKind: Map<string, "bullet" | "ordered">,
  report: DocsImportReport,
  media: MediaContext,
): PendingTable {
  const rows: PendingCell[][] = [];
  let columnCount = 0;
  let sawVMerge = false;
  let sawNestedTable = false;

  // Prefer the declared grid for the column count.
  const grid = directChild(tbl, "w:tblGrid");
  if (grid) {
    columnCount = Array.from(grid.children).filter((c) => c.tagName === "w:gridCol").length;
  }

  for (const tr of Array.from(tbl.children)) {
    if (tr.tagName !== "w:tr") continue;
    const cells: PendingCell[] = [];
    let rowSpanUnits = 0;

    for (const tc of Array.from(tr.children)) {
      if (tc.tagName !== "w:tc") continue;

      const tcPr = directChild(tc, "w:tcPr");
      const gridSpanRaw = tcPr
        ? directChild(tcPr, "w:gridSpan")?.getAttribute("w:val")
        : undefined;
      const columnSpan = clampInt(gridSpanRaw ?? "1", 1, 63);
      if (tcPr && directChild(tcPr, "w:vMerge")) sawVMerge = true;

      const paragraphs: PendingParagraph[] = [];
      for (const child of Array.from(tc.children)) {
        if (child.tagName === "w:p") {
          paragraphs.push(...convertParagraphElement(child, numberingKind, report, media));
        } else if (child.tagName === "w:tbl") {
          // Nested tables flatten into the parent cell (v1 limitation).
          sawNestedTable = true;
          const nested = convertTable(child, numberingKind, report, media);
          for (const nestedRow of nested.rows) {
            const merged: PendingParagraph = { runs: [] };
            nestedRow.forEach((nestedCell, idx) => {
              if (idx > 0) merged.runs.push({ text: "\t", style: null });
              for (const p of nestedCell.paragraphs) merged.runs.push(...p.runs);
            });
            paragraphs.push(merged);
          }
        }
      }

      cells.push({ paragraphs, ...(columnSpan > 1 ? { columnSpan } : {}) });
      // A spanning cell covers (span − 1) following grid columns — emit
      // covered placeholders so every row spans the full grid.
      for (let i = 1; i < columnSpan; i++) {
        cells.push({ paragraphs: [], covered: true });
      }
      rowSpanUnits += columnSpan;
    }

    if (cells.length > 0) {
      rows.push(cells);
      columnCount = Math.max(columnCount, rowSpanUnits);
    }
  }

  // Pad short rows to the full grid width with covered placeholders so the
  // stream cell count and tableCells always match tableColumns.
  const gridWidth = Math.max(columnCount, 1);
  for (const row of rows) {
    while (row.length < gridWidth) row.push({ paragraphs: [], covered: true });
  }

  if (sawVMerge) {
    report.entries.push({
      type: "unsupported",
      detail: "Vertically merged table cells were imported as separate cells.",
    });
  }
  if (sawNestedTable) {
    report.entries.push({
      type: "unsupported",
      detail: "A nested table was flattened into its parent table cell.",
    });
  }

  return { rows, columnCount: Math.max(columnCount, 1) };
}

function readRunStyle(r: Element): RunStyle | null {
  const rPr = directChild(r, "w:rPr");
  if (!rPr) return null;
  const style: RunStyle = {};

  if (toggleOn(directChild(rPr, "w:b"))) style.bl = 1;
  if (toggleOn(directChild(rPr, "w:i"))) style.it = 1;

  const u = directChild(rPr, "w:u");
  if (u && u.getAttribute("w:val") !== "none") style.ul = { s: 1 };

  if (toggleOn(directChild(rPr, "w:strike"))) style.st = { s: 1 };

  const sz = directChild(rPr, "w:sz")?.getAttribute("w:val");
  if (sz) {
    const half = Number(sz);
    if (Number.isFinite(half) && half > 0) style.fs = half / 2; // half-points → pt
  }

  const color = directChild(rPr, "w:color")?.getAttribute("w:val");
  if (color && color.toLowerCase() !== "auto" && /^[0-9a-f]{6}$/i.test(color)) {
    style.cl = { rgb: `#${color.toUpperCase()}` };
  }

  return Object.keys(style).length > 0 ? style : null;
}

/** OOXML toggle properties are ON unless w:val is explicitly false/0/none. */
function toggleOn(el: Element | undefined): boolean {
  if (!el) return false;
  const val = el.getAttribute("w:val");
  return val === null || !["0", "false", "none", "off"].includes(val.toLowerCase());
}

function mapParagraphStyle(styleVal: string): number | undefined {
  const normalized = styleVal.toLowerCase().replace(/\s+/g, "");
  switch (normalized) {
    case "title": return NAMED_STYLE.TITLE;
    case "subtitle": return NAMED_STYLE.SUBTITLE;
    case "heading1": return NAMED_STYLE.HEADING_1;
    case "heading2": return NAMED_STYLE.HEADING_2;
    case "heading3": return NAMED_STYLE.HEADING_3;
    case "heading4": return NAMED_STYLE.HEADING_4;
    case "heading5": return NAMED_STYLE.HEADING_5;
    default: return undefined;
  }
}

function directChild(el: Element, tagName: string): Element | undefined {
  for (const child of Array.from(el.children)) {
    if (child.tagName === tagName) return child;
  }
  return undefined;
}

function clampInt(raw: string | null | undefined, min: number, max: number): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
