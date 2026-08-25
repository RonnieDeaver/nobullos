/**
 * NoBull Docs — Univer document snapshot → DOCX converter (Task #4024).
 *
 * Mirrors the Sheets export converter's role (sheetsExportConverter.ts):
 * pure in-memory conversion (no DB access) that turns the persisted Univer
 * snapshot into a .docx Buffer via the `docx` npm package.
 *
 * The Univer document body is a flat `dataStream` string with control
 * characters marking structure (see @univerjs/core DataStreamTreeTokenType):
 *   \r     paragraph end          \n     section break
 *   \x1A   table start            \x0F   table end
 *   \x1B   row start              \x0E   row end
 *   \x1C   cell start             \x1D   cell end
 *   \b     custom block (images)  \t     tab
 *
 * We tokenize that stream into paragraph/table blocks, then rebuild each
 * paragraph's runs by intersecting its [start, end) range with body.textRuns.
 * Styling carried over: bold, italic, underline, strikethrough, font size,
 * font family, color, headings (Title/Subtitle/H1-H5), alignment, and
 * bullet/ordered lists. Base64 images embed best-effort (skipped on error).
 */

import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableCell,
  TableRow,
  WidthType,
} from "docx";

// ---- Univer data-stream control characters ----
const PARAGRAPH_MARK = "\r";
const SECTION_BREAK = "\n";
const TABLE_START = "\u001A";
const TABLE_ROW_START = "\u001B";
const TABLE_CELL_START = "\u001C";
const TABLE_CELL_END = "\u001D";
const TABLE_ROW_END = "\u000E";
const TABLE_END = "\u000F";
const CUSTOM_BLOCK = "\b";

const ORDERED_NUMBERING_REF = "nobull-docs-ordered";

interface UniverTextRun {
  st: number;
  ed: number;
  ts?: {
    bl?: number;
    it?: number;
    ul?: { s?: number };
    st?: { s?: number };
    fs?: number;
    ff?: string | null;
    cl?: { rgb?: string | null } | null;
  } | null;
}

interface UniverParagraph {
  startIndex: number;
  paragraphStyle?: {
    namedStyleType?: number;
    horizontalAlign?: number;
  };
  bullet?: {
    listType?: string;
    nestingLevel?: number;
  };
}

interface UniverCustomBlock {
  startIndex: number;
  blockId?: string;
}

interface UniverDrawing {
  imageSourceType?: string;
  source?: string;
  docTransform?: { size?: { width?: number; height?: number } };
  transform?: { width?: number; height?: number };
}

interface UniverBody {
  dataStream?: string;
  textRuns?: UniverTextRun[];
  paragraphs?: UniverParagraph[];
  customBlocks?: UniverCustomBlock[];
  tables?: Array<{ startIndex?: number; endIndex?: number; tableId?: string }>;
}

interface UniverTableCellMeta {
  rowSpan?: number;
  columnSpan?: number;
}

interface UniverTableMeta {
  tableRows?: Array<{ tableCells?: UniverTableCellMeta[] }>;
}

interface UniverDocSnapshot {
  body?: UniverBody;
  drawings?: Record<string, UniverDrawing>;
  tableSource?: Record<string, UniverTableMeta>;
}

// Parsed block structure.
type Block =
  | { kind: "paragraph"; start: number; end: number; markIndex: number }
  | { kind: "table"; startIndex: number; rows: Block[][][] }; // rows → cells → blocks

/**
 * Convert a persisted Univer document snapshot to a .docx file Buffer.
 * Throws when the snapshot has no readable body — the route maps to 422.
 */
export async function convertDocumentSnapshotToDocx(
  snapshot: unknown,
  _documentName: string,
): Promise<Buffer> {
  const snap = (snapshot ?? {}) as UniverDocSnapshot;
  const body = snap.body;
  if (!body || typeof body.dataStream !== "string") {
    throw new Error("This document has no content to export.");
  }

  const stream = body.dataStream;
  const paragraphsMeta = new Map<number, UniverParagraph>();
  for (const p of body.paragraphs ?? []) {
    if (typeof p?.startIndex === "number") paragraphsMeta.set(p.startIndex, p);
  }
  const customBlocks = new Map<number, UniverCustomBlock>();
  for (const cb of body.customBlocks ?? []) {
    if (typeof cb?.startIndex === "number") customBlocks.set(cb.startIndex, cb);
  }

  const blocks = parseBlocks(stream, 0, stream.length);

  const children: Array<Paragraph | Table> = [];
  let usesOrderedList = false;

  const renderBlocks = (list: Block[]): Array<Paragraph | Table> => {
    const out: Array<Paragraph | Table> = [];
    for (const block of list) {
      if (block.kind === "paragraph") {
        const { paragraph, usedOrdered } = buildParagraph(
          stream, block, body, paragraphsMeta, customBlocks, snap.drawings ?? {},
        );
        if (usedOrdered) usesOrderedList = true;
        out.push(paragraph);
      } else {
        // tableSource meta (looked up via body.tables) lets us honor column
        // spans and skip covered placeholder cells (rowSpan/columnSpan = 0).
        const tableId = (body.tables ?? []).find((t) => t?.startIndex === block.startIndex)?.tableId;
        const tableMeta = tableId ? snap.tableSource?.[tableId] : undefined;
        const rows = block.rows.map((cells, rowIdx) => {
          const cellMetas = tableMeta?.tableRows?.[rowIdx]?.tableCells;
          const children: TableCell[] = [];
          cells.forEach((cellBlocks, cellIdx) => {
            const meta = cellMetas?.[cellIdx];
            if (meta && meta.rowSpan === 0 && meta.columnSpan === 0) return; // covered
            const cellChildren = renderBlocks(cellBlocks)
              .filter((c): c is Paragraph => c instanceof Paragraph);
            children.push(new TableCell({
              children: cellChildren.length > 0 ? cellChildren : [new Paragraph("")],
              columnSpan:
                typeof meta?.columnSpan === "number" && meta.columnSpan > 1
                  ? meta.columnSpan
                  : undefined,
            }));
          });
          return new TableRow({ children });
        });
        if (rows.length > 0) {
          out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        }
      }
    }
    return out;
  };

  children.push(...renderBlocks(blocks));
  if (children.length === 0) children.push(new Paragraph(""));

  const doc = new Document({
    numbering: usesOrderedList
      ? {
          config: [
            {
              reference: ORDERED_NUMBERING_REF,
              levels: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((level) => ({
                level,
                format:
                  level % 3 === 0
                    ? LevelFormat.DECIMAL
                    : level % 3 === 1
                      ? LevelFormat.LOWER_LETTER
                      : LevelFormat.LOWER_ROMAN,
                text: `%${level + 1}.`,
                style: {
                  paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } },
                },
              })),
            },
          ],
        }
      : undefined,
    sections: [{ children }],
  });

  return await Packer.toBuffer(doc);
}

// ---- data-stream tokenizer ----

/**
 * Parse [from, to) of the stream into paragraph/table blocks.
 * Paragraph blocks reference [start, end) text ranges (end excludes the \r);
 * `markIndex` is the index of the \r itself (where paragraph meta lives).
 */
function parseBlocks(stream: string, from: number, to: number): Block[] {
  const blocks: Block[] = [];
  let cursor = from;
  let i = from;

  while (i < to) {
    const ch = stream[i];
    if (ch === PARAGRAPH_MARK) {
      blocks.push({ kind: "paragraph", start: cursor, end: i, markIndex: i });
      i += 1;
      cursor = i;
    } else if (ch === SECTION_BREAK) {
      // Layout marker only — skip.
      i += 1;
      cursor = i;
    } else if (ch === TABLE_START) {
      const tableEnd = findMatching(stream, i, TABLE_START, TABLE_END, to);
      blocks.push(parseTable(stream, i, i + 1, tableEnd));
      i = tableEnd + 1;
      cursor = i;
    } else {
      i += 1;
    }
  }
  return blocks;
}

function parseTable(stream: string, startIndex: number, from: number, to: number): Block {
  const rows: Block[][][] = [];
  let i = from;
  while (i < to) {
    if (stream[i] === TABLE_ROW_START) {
      const rowEnd = findMatching(stream, i, TABLE_ROW_START, TABLE_ROW_END, to);
      const cells: Block[][] = [];
      let j = i + 1;
      while (j < rowEnd) {
        if (stream[j] === TABLE_CELL_START) {
          const cellEnd = findMatching(stream, j, TABLE_CELL_START, TABLE_CELL_END, rowEnd);
          cells.push(parseBlocks(stream, j + 1, cellEnd));
          j = cellEnd + 1;
        } else {
          j += 1;
        }
      }
      rows.push(cells);
      i = rowEnd + 1;
    } else {
      i += 1;
    }
  }
  return { kind: "table", startIndex, rows };
}

/** Find the matching closer for the opener at `openIndex`, honoring nesting. */
function findMatching(
  stream: string,
  openIndex: number,
  opener: string,
  closer: string,
  limit: number,
): number {
  let depth = 0;
  for (let i = openIndex; i < limit; i++) {
    if (stream[i] === opener) depth += 1;
    else if (stream[i] === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return limit; // Malformed stream — treat the rest as the block body.
}

// ---- paragraph builder ----

function buildParagraph(
  stream: string,
  block: { start: number; end: number; markIndex: number },
  body: UniverBody,
  paragraphsMeta: Map<number, UniverParagraph>,
  customBlocks: Map<number, UniverCustomBlock>,
  drawings: Record<string, UniverDrawing>,
): { paragraph: Paragraph; usedOrdered: boolean } {
  const children: Array<TextRun | ImageRun> = [];

  // Split [start, end) at text-run boundaries so styles apply per segment.
  const cuts = new Set<number>([block.start, block.end]);
  for (const run of body.textRuns ?? []) {
    if (typeof run?.st !== "number" || typeof run?.ed !== "number") continue;
    if (run.ed <= block.start || run.st >= block.end) continue;
    cuts.add(Math.max(run.st, block.start));
    cuts.add(Math.min(run.ed, block.end));
  }
  // Images are single \b characters — cut around each.
  for (let i = block.start; i < block.end; i++) {
    if (stream[i] === CUSTOM_BLOCK) {
      cuts.add(i);
      cuts.add(i + 1);
    }
  }
  const sorted = Array.from(cuts).sort((a, b) => a - b);

  for (let s = 0; s < sorted.length - 1; s++) {
    const segStart = sorted[s];
    const segEnd = sorted[s + 1];
    if (segEnd <= segStart) continue;

    // Image segment?
    if (segEnd - segStart === 1 && stream[segStart] === CUSTOM_BLOCK) {
      const image = tryBuildImage(customBlocks.get(segStart), drawings);
      if (image) children.push(image);
      continue;
    }

    const rawText = stream.slice(segStart, segEnd);
    // Strip any control characters; keep tabs as spaces (w:t has no tabs).
    const text = rawText
      .replace(/\t/g, "    ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B-\u001F]/g, "");
    if (text.length === 0) continue;

    const ts = (body.textRuns ?? []).find(
      (r) => typeof r?.st === "number" && typeof r?.ed === "number" && r.st <= segStart && r.ed >= segEnd,
    )?.ts;

    children.push(
      new TextRun({
        text,
        bold: ts?.bl === 1 || undefined,
        italics: ts?.it === 1 || undefined,
        underline: ts?.ul?.s === 1 ? {} : undefined,
        strike: ts?.st?.s === 1 || undefined,
        size: typeof ts?.fs === "number" && ts.fs > 0 ? Math.round(ts.fs * 2) : undefined,
        font: typeof ts?.ff === "string" && ts.ff ? ts.ff : undefined,
        color:
          typeof ts?.cl?.rgb === "string" && /^#?[0-9a-f]{6}$/i.test(ts.cl.rgb)
            ? ts.cl.rgb.replace("#", "").toUpperCase()
            : undefined,
      }),
    );
  }

  const meta = paragraphsMeta.get(block.markIndex);
  const style = meta?.paragraphStyle;

  let heading: (typeof HeadingLevel)[keyof typeof HeadingLevel] | undefined;
  let namedStyle: string | undefined;
  switch (style?.namedStyleType) {
    case 2: heading = HeadingLevel.TITLE; break;
    case 3: namedStyle = "Subtitle"; break; // Word/GDocs latent built-in style
    case 4: heading = HeadingLevel.HEADING_1; break;
    case 5: heading = HeadingLevel.HEADING_2; break;
    case 6: heading = HeadingLevel.HEADING_3; break;
    case 7: heading = HeadingLevel.HEADING_4; break;
    case 8: heading = HeadingLevel.HEADING_5; break;
    default: break;
  }

  let alignment: (typeof AlignmentType)[keyof typeof AlignmentType] | undefined;
  switch (style?.horizontalAlign) {
    case 2: alignment = AlignmentType.CENTER; break;
    case 3: alignment = AlignmentType.RIGHT; break;
    case 4:
    case 5: alignment = AlignmentType.JUSTIFIED; break;
    default: break;
  }

  let usedOrdered = false;
  let bullet: { level: number } | undefined;
  let numbering: { reference: string; level: number } | undefined;
  if (meta?.bullet) {
    const level = clampLevel(meta.bullet.nestingLevel);
    const listType = meta.bullet.listType ?? "";
    if (/ORDER|CHECK/i.test(listType) && !/BULLET/i.test(listType)) {
      numbering = { reference: ORDERED_NUMBERING_REF, level };
      usedOrdered = true;
    } else {
      bullet = { level };
    }
  }

  const paragraph = new Paragraph({
    children,
    heading,
    style: namedStyle,
    alignment,
    bullet,
    numbering,
  });
  return { paragraph, usedOrdered };
}

function tryBuildImage(
  cb: UniverCustomBlock | undefined,
  drawings: Record<string, UniverDrawing>,
): ImageRun | null {
  try {
    if (!cb?.blockId) return null;
    const drawing = drawings[cb.blockId];
    if (!drawing || typeof drawing.source !== "string") return null;

    // Only BASE64 data-URL sources embed; URL-sourced images are skipped
    // (no network fetches during export).
    const match = /^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/i.exec(drawing.source);
    if (!match) return null;
    const ext = match[1].toLowerCase();
    const type = (ext === "jpeg" ? "jpg" : ext) as "png" | "jpg" | "gif" | "bmp";
    const data = Buffer.from(match[2], "base64");
    if (data.length === 0) return null;

    const sizePt = drawing.docTransform?.size;
    const widthPt = numberOr(sizePt?.width, numberOr(drawing.transform?.width, 300));
    const heightPt = numberOr(sizePt?.height, numberOr(drawing.transform?.height, 200));

    return new ImageRun({
      type,
      data,
      // docx transformation is in px (96 dpi); Univer sizes are pt (72 dpi).
      transformation: {
        width: Math.max(8, Math.round((widthPt * 96) / 72)),
        height: Math.max(8, Math.round((heightPt * 96) / 72)),
      },
    });
  } catch {
    return null; // Best-effort: a bad drawing never fails the whole export.
  }
}

function clampLevel(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 0;
  return Math.max(0, Math.min(8, n));
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
