/* test-registration
{
  "name": "Report slide <img> print-downscale guard — every img rendered by the public report slide components carries data-print-downscale or an explicit allow-list reason, so a new slide image can't silently re-bloat the shared PDF (Task #4529)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4529: report PDF weight is controlled by annotating slide imgs with data-print-downscale (client/src/lib/printImagePrep.ts swaps them to print-sized data URLs). Before that fix, two 2254px thumbnails displayed at 56px made the shared report PDF 4.3MB on their own. Nothing else stops a future slide from adding an unannotated full-resolution img and quietly quadrupling every client-facing PDF again — this source scan is the only guard. Pure fs scan over the publicReport page directory: milliseconds, DB-free, network-free.",
  "scanPaths": [
    "client/src/pages/publicReport",
    "client/src/lib/printImagePrep.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4529 — keep report PDFs small when new images are added to slides.
 *
 * Source scan over every .tsx file in client/src/pages/publicReport: each
 * JSX <img> opening tag must either
 *   - carry the data-print-downscale attribute (printImagePrep.ts swaps it
 *     to a canvas-downscaled data URL before print/PDF capture), or
 *   - match an explicit allow-list entry below with a written reason
 *     (e.g. the img never reaches print output).
 *
 * Allow-list entries are exact-match against the img's src attribute text
 * and MUST still match a real un-annotated img — stale entries fail the
 * test so the list can't rot into a blanket exemption.
 *
 * Run: npx tsx tests/report-slide-img-print-downscale.test.ts
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SLIDES_DIR = path.resolve(HERE, "../client/src/pages/publicReport");

/**
 * Un-annotated <img> tags that are deliberately exempt. Keyed by file
 * basename + the exact src attribute text as it appears in the tag.
 * Every entry needs a reason explaining why it can never bloat the PDF.
 */
const ALLOW_LIST: Array<{ file: string; srcContains: string; reason: string }> = [
  {
    file: "CoverSlide.tsx",
    srcContains: "/assets/NoBull.Primary.Logo.White_1768864291629.png",
    reason:
      "Screen-only letterhead logo inside a print:hidden wrapper (Task #4275) — it is display:none in every print/PDF path, so it never embeds in the PDF at all.",
  },
  {
    file: "ReportStatePage.tsx",
    srcContains: "WHITE_LOGO",
    reason:
      "Branded error/empty-state page (expired link, not-ready, load failure) — it renders INSTEAD of the report deck, is never part of the Save-as-PDF / print capture, and the src is a small fixed logo asset.",
  },
];

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}${detail ? `\n    ${detail}` : ""}`);
  }
}

/** Strip block comments and line comments so a documented `<img` in prose
 * never counts as a rendered image (replace with spaces to keep offsets). */
function maskComments(source: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "block" | "line" | "str" = "code";
  let strQuote = "";
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "*") { mode = "block"; out += "  "; i += 2; continue; }
      if (c === "/" && next === "/") { mode = "line"; out += "  "; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") { mode = "str"; strQuote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") { mode = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    if (mode === "line") {
      if (c === "\n") { mode = "code"; out += "\n"; i++; continue; }
      out += " "; i++; continue;
    }
    // string mode — keep contents (src literals live here), honor escapes
    if (c === "\\") { out += c + (next ?? ""); i += 2; continue; }
    if (c === strQuote) { mode = "code"; out += c; i++; continue; }
    out += c; i++; continue;
  }
  return out;
}

/**
 * Extract the full JSX opening tag starting at `<img`. Walks forward
 * tracking {} depth and string/template quoting so `=>` arrows and `>`
 * comparisons inside attribute expressions don't end the tag early.
 */
function extractImgTag(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") { depth++; continue; }
    if (c === "}") { depth--; continue; }
    if (c === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start); // unterminated — return the tail, will fail loudly
}

/**
 * Mask string-literal and brace-expression CONTENTS inside an opening tag
 * (replaced with spaces) so attribute detection can't be satisfied by the
 * text "data-print-downscale" appearing inside an alt/src/expression value.
 */
function maskTagValues(tag: string): string {
  let out = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < tag.length; i++) {
    const c = tag[i];
    if (quote) {
      if (c === "\\") { out += "  "; i++; continue; }
      if (c === quote) { quote = null; out += c; continue; }
      out += " ";
      continue;
    }
    if (depth > 0) {
      if (c === '"' || c === "'" || c === "`") { quote = c; out += " "; continue; }
      if (c === "{") { depth++; out += " "; continue; }
      if (c === "}") { depth--; out += depth === 0 ? c : " "; continue; }
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; continue; }
    if (c === "{") { depth = 1; out += c; continue; }
    out += c;
  }
  return out;
}

/**
 * True only when the tag carries data-print-downscale as a REAL JSX
 * attribute token (never text inside a value) with an EFFECTIVE value —
 * printImagePrep.targetPxFor only acts on a finite positive number, so a
 * bare attribute, empty string, or non-positive/non-numeric static value
 * is a silent no-op at print time and must fail here.
 *
 * Policy for dynamic values (={expr}): accepted — the annotation is
 * deliberate and the expression's runtime value is the author's contract
 * (the known dynamic uses pass computed px widths). Empty expressions
 * ({} / whitespace) are rejected.
 */
function hasDownscaleAttr(tag: string): boolean {
  const masked = maskTagValues(tag); // same length as tag — offsets line up
  const m = /(?<=[\s<])data-print-downscale(?=[\s=/>])/.exec(masked);
  if (!m) return false;
  let i = m.index + "data-print-downscale".length;
  while (i < tag.length && /\s/.test(tag[i])) i++;
  if (tag[i] !== "=") return false; // bare attribute — no-op in printImagePrep
  i++;
  while (i < tag.length && /\s/.test(tag[i])) i++;
  const c = tag[i];
  if (c === '"' || c === "'") {
    const end = tag.indexOf(c, i + 1);
    if (end < 0) return false;
    const value = tag.slice(i + 1, end).trim();
    const px = Number(value);
    return value.length > 0 && Number.isFinite(px) && px > 0;
  }
  if (c === "{") {
    // Dynamic expression — find the matching close brace via the masked
    // string (contents are spaces there, so no nested-quote pitfalls; the
    // masked form keeps only the outermost braces).
    const end = masked.indexOf("}", i + 1);
    if (end < 0) return false;
    return tag.slice(i + 1, end).trim().length > 0; // {} / {  } rejected
  }
  return false;
}

// Scanner self-test: text inside attribute VALUES must never satisfy the
// guard, and every legitimate attribute assignment form must.
check(
  "self-test: attribute-in-value spoofs rejected, real attribute forms accepted",
  !hasDownscaleAttr('<img alt="data-print-downscale" src={x} />') &&
    !hasDownscaleAttr("<img src={`data-print-downscale`} alt={cond ? 'data-print-downscale' : y} />") &&
    !hasDownscaleAttr('<img src="/x.png" title={"data-print-downscale"} />') &&
    hasDownscaleAttr('<img src="/x.png" data-print-downscale="56" />') &&
    hasDownscaleAttr("<img src={u} data-print-downscale={px} />") &&
    hasDownscaleAttr("<img src={u} data-print-downscale={cond ? 56 : 112} />") &&
    hasDownscaleAttr("<img data-print-downscale\n=\"56\" src={u} />"),
);

// Ineffective annotations must fail too: printImagePrep.targetPxFor ignores
// anything that isn't a finite positive number, so these forms would ship
// full-resolution into the PDF while looking annotated.
check(
  "self-test: ineffective annotation forms rejected (bare / empty / non-numeric / non-positive / empty expression)",
  !hasDownscaleAttr('<img src="/x.png" data-print-downscale />') &&
    !hasDownscaleAttr('<img src="/x.png" data-print-downscale="" />') &&
    !hasDownscaleAttr('<img src="/x.png" data-print-downscale="  " />') &&
    !hasDownscaleAttr('<img src="/x.png" data-print-downscale="anything" />') &&
    !hasDownscaleAttr('<img src="/x.png" data-print-downscale="0" />') &&
    !hasDownscaleAttr('<img src="/x.png" data-print-downscale="-56" />') &&
    !hasDownscaleAttr('<img src="/x.png" data-print-downscale="NaN" />') &&
    !hasDownscaleAttr("<img src={u} data-print-downscale={} />") &&
    !hasDownscaleAttr("<img src={u} data-print-downscale={  } />") &&
    !hasDownscaleAttr('<img src="/x.png" data-print-downscale= />'),
);

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

const files = fs
  .readdirSync(SLIDES_DIR)
  .filter((f) => f.endsWith(".tsx"))
  .sort();

check("publicReport slide directory has .tsx files to scan", files.length > 0);

type ImgHit = { file: string; line: number; tag: string };
const unannotated: ImgHit[] = [];
let totalImgs = 0;
let annotated = 0;

for (const file of files) {
  const raw = fs.readFileSync(path.join(SLIDES_DIR, file), "utf8");
  const src = maskComments(raw);
  const re = /<img\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    totalImgs++;
    const tag = extractImgTag(src, m.index);
    if (hasDownscaleAttr(tag)) {
      annotated++;
    } else {
      unannotated.push({ file, line: lineOf(src, m.index), tag });
    }
  }
}

// Sanity: the scanner actually sees the known annotated examples — if this
// drops to zero the extractor broke and the guard would be vacuously green.
check(
  `scanner found <img> tags in the slide components (found ${totalImgs}, ${annotated} annotated)`,
  totalImgs >= 3 && annotated >= 1,
  "Expected the known annotated imgs (MarketingSlide GBP thumb / scan slot, BookPromoSlide cover). If slides were restructured, update this floor deliberately.",
);

const usedAllowEntries = new Set<number>();
for (const hit of unannotated) {
  const idx = ALLOW_LIST.findIndex(
    (e) => e.file === hit.file && hit.tag.includes(e.srcContains),
  );
  if (idx >= 0) {
    usedAllowEntries.add(idx);
    console.log(`  ok - ${hit.file}:${hit.line} allow-listed: ${ALLOW_LIST[idx].reason}`);
    continue;
  }
  check(
    `${hit.file}:${hit.line} <img> carries data-print-downscale`,
    false,
    `This img has no data-print-downscale attribute and is not allow-listed.\n` +
      `    PDF-weight consequence: the report print/PDF embeds every <img> at its ORIGINAL\n` +
      `    resolution — before Task #4288 two 2254px thumbnails displayed at 56px made the\n` +
      `    shared client PDF 4.3MB by themselves. Annotate it with data-print-downscale="<css px\n` +
      `    display width>" so client/src/lib/printImagePrep.ts downscales it for print (add\n` +
      `    data-print-alpha only if transparency must survive), or — ONLY if it provably never\n` +
      `    reaches print output — add an ALLOW_LIST entry in this test with a written reason.\n` +
      `    Tag: ${hit.tag.replace(/\s+/g, " ").slice(0, 300)}`,
  );
}

// Stale allow-list entries rot into blanket exemptions — fail them.
ALLOW_LIST.forEach((e, idx) => {
  check(
    `allow-list entry still matches a real un-annotated img (${e.file} src~"${e.srcContains}")`,
    usedAllowEntries.has(idx),
    "No un-annotated <img> matched this entry — it is stale. Remove it (or fix it) so the allow-list can't silently absorb future violations.",
  );
});

// Contract anchor: the attribute name this scan enforces must be the one
// printImagePrep.ts actually reads — a rename there would otherwise leave
// this guard enforcing a dead attribute.
const prep = fs.readFileSync(
  path.resolve(HERE, "../client/src/lib/printImagePrep.ts"),
  "utf8",
);
check(
  'printImagePrep.ts still keys off "data-print-downscale"',
  prep.includes('"data-print-downscale"') && prep.includes("img[data-print-downscale]"),
  "The print downscale attribute name changed in printImagePrep.ts — update this scan (and every slide annotation) in lockstep.",
);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll report slide <img> print-downscale guard checks passed");
