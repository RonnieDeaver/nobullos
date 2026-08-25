/* test-registration
{
  "name": "Report-smoke PDF page-break detector (Task #4721)",
  "scanPaths": [
    "client/src/index.css"
  ],
  "tier": "small"
}
test-registration */
/**
 * Unit-proves the pure page-break detector behind the pre-Publish report
 * smoke check (scripts/reportSmokePageBreak.ts, consumed by
 * scripts/report-smoke-check.ts --page-break-only):
 *
 * 1. PPM parsing + marker classification round-trip on synthetic pages.
 * 2. Page-file ordering is NUMERIC — pdftoppm zero-pads page numbers only to
 *    the deck's digit width, so a lexicographic sort of a 10+-page deck
 *    interleaves pages (page-1, page-10, page-11, page-2 …) and would make
 *    the boundary detector compare non-adjacent pages. The regression this
 *    guards: a forced split on a REAL adjacent boundary (9→10) must be
 *    detected, and would be missed under lexicographic order.
 * 3. detectSplitBoundaries flags exactly the fragmented boundary (marker ink
 *    touching both edge strips in overlapping columns), stays quiet on
 *    intact pages, and ignores sub-threshold overlap noise.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parsePpm,
  isMarker,
  countMarkerPixels,
  sortPpmPageFiles,
  detectSplitBoundaries,
  DENSE_CARD_ATOMIC_SELECTORS,
  DENSE_PAGE_BREAK_MARKER_CSS,
  SPARSE_ATOMIC_SELECTORS,
  PAGE_BREAK_MARKER_CSS,
  SPARSE_PAGE_BREAK_SABOTAGE_CSS,
  type PpmPage,
} from "../scripts/reportSmokePageBreak";

const W = 40;
const H = 30;

/** Build a synthetic P6 PPM page: white background plus magenta marker rects. */
function buildPpm(rects: { x0: number; x1: number; y0: number; y1: number }[]): Buffer {
  const header = Buffer.from(`P6\n# synthetic fixture\n${W} ${H}\n255\n`, "latin1");
  const data = Buffer.alloc(W * H * 3, 255);
  for (const r of rects) {
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const o = (y * W + x) * 3;
        data[o] = 255;
        data[o + 1] = 0;
        data[o + 2] = 255;
      }
    }
  }
  return Buffer.concat([header, data]);
}

async function run() {
  // === 1. PPM parse + marker classification ===
  const intact = parsePpm(buildPpm([{ x0: 10, x1: 30, y0: 10, y1: 20 }]));
  assert.equal(intact.width, W);
  assert.equal(intact.height, H);
  assert.equal(countMarkerPixels(intact), 20 * 10, "marker rect pixel count round-trips through parse");
  assert.ok(isMarker(255, 0, 255) && !isMarker(255, 255, 255) && !isMarker(213, 172, 92), "only magenta classifies as marker (not white, not report-gold)");

  // === 2. Numeric page ordering (the 10+-page lexicographic trap) ===
  // pdftoppm-style names for a 12-page deck WITHOUT zero-padding.
  const files = Array.from({ length: 12 }, (_, i) => `page-${i + 1}.ppm`);
  const shuffledLexicographic = [...files].sort(); // page-1, page-10, page-11, page-12, page-2, ...
  assert.notDeepEqual(shuffledLexicographic, files, "fixture actually exercises the lexicographic trap");
  assert.deepEqual(
    sortPpmPageFiles(shuffledLexicographic),
    files,
    "sortPpmPageFiles restores physical page order from lexicographic listing",
  );
  assert.throws(() => sortPpmPageFiles(["nonsense.txt"]), /unrecognized/, "non-page file names fail loudly, never sort silently");

  // === 3. Split detection on a 12-page deck, forced split at boundary 9→10 ===
  // Page 9 ends with a marker band bleeding to its bottom edge over columns
  // 8..24; page 10 starts with the band's continuation at its top edge over
  // the same columns. All other pages carry intact (non-edge) markers.
  const pages: PpmPage[] = [];
  for (let n = 1; n <= 12; n++) {
    if (n === 9) pages.push(parsePpm(buildPpm([{ x0: 8, x1: 24, y0: H - 6, y1: H }])));
    else if (n === 10) pages.push(parsePpm(buildPpm([{ x0: 8, x1: 24, y0: 0, y1: 5 }])));
    else pages.push(parsePpm(buildPpm([{ x0: 10, x1: 30, y0: 10, y1: 20 }])));
  }
  const splits = detectSplitBoundaries(pages);
  assert.deepEqual(
    splits.map((s) => s.pageAbove),
    [9],
    "exactly the fragmented 9→10 boundary is flagged on a physically-ordered 12-page deck",
  );
  assert.ok(splits[0].overlap >= 16, "overlap reports the shared marker columns");

  // The same deck in LEXICOGRAPHIC order (pages 9 and 10 land at indexes 11
  // and 1 — no longer adjacent) misses the split: this is the ordering bug
  // the numeric sort exists to prevent.
  const lexOrder = shuffledLexicographic.map((f) => pages[parseInt(/(\d+)\.ppm$/.exec(f)![1], 10) - 1]);
  assert.deepEqual(
    detectSplitBoundaries(lexOrder).map((s) => s.pageAbove),
    [],
    "lexicographic page order hides the real 9→10 split — detector input must be numerically sorted",
  );

  // Intact deck stays quiet.
  const intactDeck = Array.from({ length: 12 }, () => parsePpm(buildPpm([{ x0: 10, x1: 30, y0: 10, y1: 20 }])));
  assert.deepEqual(detectSplitBoundaries(intactDeck), [], "no findings on an intact deck");

  // Sub-threshold overlap (2 shared columns < minOverlap 3) is noise, not a split.
  const noisy = [...intactDeck];
  noisy[4] = parsePpm(buildPpm([{ x0: 8, x1: 10, y0: H - 2, y1: H }]));
  noisy[5] = parsePpm(buildPpm([{ x0: 8, x1: 10, y0: 0, y1: 2 }]));
  assert.deepEqual(detectSplitBoundaries(noisy), [], "sub-threshold edge overlap does not false-positive");

  // Element ending flush at a page bottom with NO continuation on the next
  // page top = legitimate layout, not a split.
  const flush = [...intactDeck];
  flush[6] = parsePpm(buildPpm([{ x0: 8, x1: 24, y0: H - 6, y1: H }]));
  assert.deepEqual(detectSplitBoundaries(flush), [], "bottom-edge ink without next-page continuation is not a split");

  // === 4. Dense marker CSS lockstep with the print atomic-card contract ===
  // The dense-deck pass (Task #4728) tints exactly the card family the
  // @media print `break-inside: avoid` rule in client/src/index.css promises
  // never to slice. If that rule's selector list drifts, this test — not a
  // silently blind smoke pass — is what fails.
  const indexCss = readFileSync("client/src/index.css", "utf8");
  const printBlock = indexCss.slice(indexCss.indexOf("@media print {"));
  assert.ok(printBlock.length > 100, "client/src/index.css still has an @media print block");
  for (const sel of DENSE_CARD_ATOMIC_SELECTORS) {
    assert.ok(
      printBlock.includes(sel),
      `dense marker selector "${sel}" no longer appears in the @media print atomic-card rule — update DENSE_CARD_ATOMIC_SELECTORS in lockstep`,
    );
    assert.ok(
      DENSE_PAGE_BREAK_MARKER_CSS.includes(sel),
      `DENSE_PAGE_BREAK_MARKER_CSS lost selector "${sel}"`,
    );
  }
  assert.ok(
    DENSE_PAGE_BREAK_MARKER_CSS.includes("#ff00ff"),
    "dense marker tint stays the magenta the isMarker() threshold detects",
  );

  // === 5. Sparse marker/sabotage CSS lockstep with the explicit print rule ===
  // The sparse-deck pass (Tasks #4721/#4747) tints exactly the empty-state
  // atomics (upsell callouts + chart-placeholder frames) that the explicit
  // testid-targeted `break-inside: avoid` rule in client/src/index.css
  // @media print promises never to slice, and the --page-break-selftest
  // sabotage must override that SAME rule or the negative proof is a no-op.
  for (const sel of SPARSE_ATOMIC_SELECTORS) {
    assert.ok(
      printBlock.includes(sel),
      `sparse atomic selector "${sel}" no longer appears in the @media print block — the explicit sparse atomicity rule drifted; update SPARSE_ATOMIC_SELECTORS in lockstep`,
    );
    assert.ok(
      PAGE_BREAK_MARKER_CSS.includes(sel),
      `PAGE_BREAK_MARKER_CSS lost selector "${sel}"`,
    );
    assert.ok(
      SPARSE_PAGE_BREAK_SABOTAGE_CSS.includes(sel),
      `SPARSE_PAGE_BREAK_SABOTAGE_CSS lost selector "${sel}" — the selftest would no longer defeat the sparse print contract`,
    );
  }
  // The explicit rule itself must exist (selector presence alone could be a
  // comment): the testid selectors must be followed by a break-inside: avoid
  // declaration inside the print block.
  const sparseRule = new RegExp(
    SPARSE_ATOMIC_SELECTORS.map((s) => s.replace(/[[\]^"$\\=-]/g, "\\$&")).join(",\\s*") +
      "\\s*\\{[^}]*break-inside:\\s*avoid",
  );
  assert.ok(
    sparseRule.test(printBlock),
    "client/src/index.css @media print no longer has the explicit break-inside: avoid rule for the sparse empty-state atomics",
  );
  assert.ok(PAGE_BREAK_MARKER_CSS.includes("#ff00ff"), "sparse marker tint stays magenta");
  assert.ok(
    SPARSE_PAGE_BREAK_SABOTAGE_CSS.includes("break-inside: auto") && SPARSE_PAGE_BREAK_SABOTAGE_CSS.includes(".slide"),
    "sparse sabotage defeats break-inside AND the slide-level page fitting (else nothing crosses a boundary and the proof is inert)",
  );

  console.log("report-smoke page-break detector: all assertions passed");
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
