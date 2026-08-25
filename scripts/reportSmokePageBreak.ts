/**
 * Pure helpers for the report-smoke page-break regression check (Task #4721).
 *
 * Kept import-light (no puppeteer/pg) and side-effect free so the detector
 * logic is unit-testable (tests/report-smoke-page-break-detector.test.ts)
 * without booting the smoke harness. scripts/report-smoke-check.ts is the
 * sole runtime consumer.
 */

/**
 * Sparse-deck atomic print units (Tasks #4715/#4747): the no-data upsell
 * callout bands and dashed chart-placeholder frames. The @media print
 * `break-inside: avoid` rule in client/src/index.css targets EXACTLY these
 * testid selectors (an explicit rule — the old `rounded-lg` class-string
 * hook silently died when the class was dropped upstream). The detector
 * unit test asserts this list against the live stylesheet, so the marker
 * tint and the sabotage cover precisely the elements the print CSS promises
 * never to slice.
 */
export const SPARSE_ATOMIC_SELECTORS = [
  '[data-testid^="upsell-"]',
  '[data-testid^="chart-placeholder-"]',
] as const;

/** Layout-neutral marker tint for the atomic empty-state elements: background
 * color never affects print fragmentation, so the REAL print CSS still
 * decides where pages break — the tint only makes upsell callouts and
 * chart-placeholder frames machine-detectable in page rasters (their real
 * gold/10 band and 3%-alpha dashed frame are too faint to threshold). */
export const PAGE_BREAK_MARKER_CSS = `
  @media print {
    ${SPARSE_ATOMIC_SELECTORS.join(", ")} {
      background-color: #ff00ff !important;
      background-image: none !important;
    }
  }
`;

/**
 * Dense-deck marker tint (Task #4728): the atomic print units of a data-heavy
 * deck are the leaf cards — stat cards, list rows, chart cards — under the
 * atomic-card `break-inside: avoid` family in client/src/index.css
 * `@media print`. The selector list below is kept in EXACT lockstep with that
 * rule (the detector unit test asserts it against the live stylesheet), so
 * the marker tint covers precisely the elements the print CSS promises never
 * to slice. Background tint is layout-neutral — the REAL print CSS still
 * decides fragmentation; the tint only makes the atomic elements
 * machine-detectable in page rasters.
 */
export const DENSE_CARD_ATOMIC_SELECTORS = [
  ".card",
  ".card-light",
  ".card-dark",
  ".card-dark-accent",
  '[class*="rounded-xl"]:not([class*="p-8"])',
  '[class*="rounded-lg"]:not([class*="p-8"])',
] as const;

export const DENSE_PAGE_BREAK_MARKER_CSS = `
  @media print {
    ${DENSE_CARD_ATOMIC_SELECTORS.join(",\n    ")} {
      background-color: #ff00ff !important;
      background-image: none !important;
    }
  }
`;

/**
 * Self-test sabotage CSS (Task #4735): defeats the atomic-card
 * `break-inside: avoid` print contract for the exact card family the dense
 * marker tint covers. Injected ONLY by `--page-break-selftest` (appended
 * after the marker tint, so its equal-specificity !important declarations
 * win by source order) to prove end-to-end that the dense page-break check
 * reports a BLOCKING split when the print CSS regresses. Never used on real
 * runs.
 *
 * Why the slide rules are sabotaged too: each `.slide` prints as its own
 * page (`break-before: page` + `min-height: 11in` in client/src/index.css
 * @media print), so on decks whose slides fit one page nothing ever crosses
 * a boundary and card break-inside is inert — sabotaging it alone proved a
 * false negative (verified live: 15 pages, 1.28M marker px, zero splits).
 * The card contract is only load-bearing when content flows across
 * boundaries, so the negative proof removes the slide-level page fitting as
 * well; with BOTH gone, cards must straddle boundaries and the detector
 * must flag them, or the pipeline is blind.
 */
export const DENSE_PAGE_BREAK_SABOTAGE_CSS = `
  @media print {
    ${DENSE_CARD_ATOMIC_SELECTORS.join(",\n    ")} {
      break-inside: auto !important;
      page-break-inside: auto !important;
    }
    .slide {
      break-before: auto !important;
      page-break-before: auto !important;
      min-height: 0 !important;
    }
  }
`;

/**
 * Sparse-deck self-test sabotage CSS (Task #4747): companion to
 * DENSE_PAGE_BREAK_SABOTAGE_CSS for the sparse no-data deck. Defeats the
 * explicit `break-inside: avoid` print rule that client/src/index.css
 * places on SPARSE_ATOMIC_SELECTORS (the exact elements the sparse marker
 * tint tracks — same specificity, wins by source order as an injected
 * style tag) AND the atomic-card family, so no ancestor/self print rule
 * keeps them intact. Injected ONLY by `--page-break-selftest` (appended
 * after PAGE_BREAK_MARKER_CSS so its equal-specificity !important
 * declarations win by source order). Never used on real runs.
 *
 * The slide-level page fitting is sabotaged too, for the same reason as the
 * dense variant (see above): each `.slide` prints `break-before: page` +
 * `min-height: 11in`, so with slides intact nothing ever crosses a page
 * boundary and element break-inside is inert — the sabotage would be a
 * false negative. With BOTH gone, callouts/frames must straddle boundaries
 * and the detector must flag them, or the sparse pipeline is blind.
 */
export const SPARSE_PAGE_BREAK_SABOTAGE_CSS = `
  @media print {
    ${SPARSE_ATOMIC_SELECTORS.join(", ")},
    ${DENSE_CARD_ATOMIC_SELECTORS.join(",\n    ")} {
      break-inside: auto !important;
      page-break-inside: auto !important;
    }
    .slide {
      break-before: auto !important;
      page-break-before: auto !important;
      min-height: 0 !important;
    }
  }
`;

export interface PpmPage {
  width: number;
  height: number;
  /** Raw RGB bytes, 3 per pixel, row-major. */
  data: Buffer;
}

export function parsePpm(buf: Buffer): PpmPage {
  // P6 header: "P6\n<w> <h>\n<maxval>\n" (whitespace-separated, # comments).
  if (buf.subarray(0, 2).toString("latin1") !== "P6") throw new Error("not a P6 PPM");
  let i = 2;
  const fields: number[] = [];
  while (fields.length < 3) {
    while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i++;
    if (buf[i] === 0x23 /* # */) {
      while (i < buf.length && buf[i] !== 0x0a) i++;
      continue;
    }
    const start = i;
    while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]))) i++;
    fields.push(parseInt(buf.subarray(start, i).toString("latin1"), 10));
  }
  i++; // single whitespace after maxval
  const [width, height, maxval] = fields;
  if (maxval !== 255) throw new Error(`unsupported PPM maxval ${maxval}`);
  return { width, height, data: buf.subarray(i, i + width * height * 3) };
}

export function isMarker(r: number, g: number, b: number): boolean {
  // Magenta with anti-aliasing tolerance.
  return r > 180 && b > 180 && g < 120;
}

/** Columns containing marker pixels within rows [rowStart, rowEnd). */
export function markerColumns(page: PpmPage, rowStart: number, rowEnd: number): Set<number> {
  const cols = new Set<number>();
  for (let y = Math.max(0, rowStart); y < Math.min(page.height, rowEnd); y++) {
    for (let x = 0; x < page.width; x++) {
      const o = (y * page.width + x) * 3;
      if (isMarker(page.data[o], page.data[o + 1], page.data[o + 2])) cols.add(x);
    }
  }
  return cols;
}

export function countMarkerPixels(page: PpmPage): number {
  let n = 0;
  for (let o = 0; o < page.data.length; o += 3) {
    if (isMarker(page.data[o], page.data[o + 1], page.data[o + 2])) n++;
  }
  return n;
}

/**
 * Order pdftoppm output files by their PHYSICAL page number. pdftoppm names
 * pages `<prefix>-<n>.ppm` with n zero-padded only to the digit width of the
 * page count — a plain lexicographic sort would interleave pages of decks
 * whose page numbers cross a digit boundary (page-1, page-10, page-2 …) and
 * make the boundary detector compare NON-adjacent pages.
 */
export function sortPpmPageFiles(files: string[]): string[] {
  const numbered = files.map((f) => {
    const m = /(\d+)\.ppm$/.exec(f);
    if (!m) throw new Error(`unrecognized pdftoppm page file name: ${f}`);
    return { f, n: parseInt(m[1], 10) };
  });
  return numbered.sort((a, b) => a.n - b.n).map((e) => e.f);
}

export interface SplitBoundary {
  /** 1-based page number of the page ABOVE the offending boundary. */
  pageAbove: number;
  /** Count of x-columns with marker ink on both sides of the boundary. */
  overlap: number;
}

/**
 * A split = marker ink touching the bottom edge strip of page N AND the top
 * edge strip of page N+1 in overlapping columns (>= minOverlap to dodge
 * anti-aliasing noise). Pages MUST be in physical order (sortPpmPageFiles).
 * Slides have padding, so an intact callout/frame never touches a page
 * edge — edge-touching marker ink on both sides of a boundary = a split.
 */
export function detectSplitBoundaries(pages: PpmPage[], edgeRows = 3, minOverlap = 3): SplitBoundary[] {
  const out: SplitBoundary[] = [];
  for (let i = 0; i < pages.length - 1; i++) {
    const bottom = markerColumns(pages[i], pages[i].height - edgeRows, pages[i].height);
    if (bottom.size === 0) continue;
    const top = markerColumns(pages[i + 1], 0, edgeRows);
    let overlap = 0;
    for (const c of top) if (bottom.has(c)) overlap++;
    if (overlap >= minOverlap) out.push({ pageAbove: i + 1, overlap });
  }
  return out;
}
