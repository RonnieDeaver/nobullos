/**
 * scripts/designContractRatchet.ts — shared engine for the four design-contract
 * count-ratchet lints (Task #4347):
 *
 *   lint-design-hex-colors  hardcoded hex colors        → token palette
 *   lint-design-text-px     arbitrary text-[Npx] sizes  → type scale
 *   lint-design-rounded     off-contract rounded-*      → square/pill contract
 *   lint-design-z-index     raw Tailwind z-* utilities  → CSS z-scale vars
 *
 * Pattern: frozen-snapshot count ratchet (TASK_SELFCHECK.md § 69 family). ONE
 * committed, self-hashed baseline artifact (scripts/design-contract-baseline.json)
 * holds per-file counts for all four categories. Each lint recounts its category
 * over the tracked client tree (client/src/**\/*.{ts,tsx}) and fails two-sided:
 *   - count ABOVE the frozen baseline → new violation; the fix is a token,
 *     never a baseline edit (the regen script refuses total increases);
 *   - count BELOW the frozen baseline → stale baseline; run the regen script to
 *     ratchet the frozen counts down and commit the artifact.
 * Merge conflict on the artifact? Take either side, then regen on the rebased
 * tree and commit — never hand-merge (the sha256 self-hash rejects hand edits).
 *
 * The lints are read-only by contract: no fs-write APIs, no CLI flags
 * (guard-tested in tests/lint-design-contract-ratchets.test.ts). The sole
 * writer of the artifact is scripts/regen-design-contract-baseline.ts.
 *
 * Definition notes (v2 — Task #4425 widened the Task #4347 v1 definitions to
 * close the ratchet's documented blind spots; decisions in both impact reviews):
 *   - hex = 6/8-digit #RRGGBB[AA], PLUS 3/4-digit short hexes (#fff, #f0f0)
 *     that contain at least one hex letter or are a single repeated digit
 *     (#000). All-digit non-repeated short forms (#123, #4347) stay excluded —
 *     they are live issue-ref/ID strings in UI copy, not colors.
 *   - text sizes = text-[<number>px], text-[<number>rem], and
 *     text-[length:…] arbitrary values.
 *   - bare `rounded` and side-only forms (rounded-t …) are excluded: under
 *     Tailwind v4 they resolve to var(--radius) = 0rem — the token itself.
 *   - zIndex = raw Tailwind z-* utilities PLUS inline-style zIndex literals
 *     (zIndex: 60 / zIndex: "60"); zIndex values referencing var(--z-…) are
 *     on-scale and allowed, as are non-literal expressions.
 *   - Comments and regex literals are masked before counting; string literals
 *     and template chunks (including nested strings inside `${…}`) are counted.
 *
 * Definition changes bump BASELINE_VERSION; the regen script accepts a total
 * increase ONLY as a one-time migration from an older-version artifact, and
 * the lints refuse to run against a stale-version artifact.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { isScannablePath, listTrackedFiles } from "./lintFileDiscovery.ts";

export const CATEGORY_IDS = ["hexColors", "textPx", "rounded", "zIndex", "chartFontSize", "primaryWhite"] as const;
export type DesignCategoryId = (typeof CATEGORY_IDS)[number];

export const BASELINE_RELPATH = "scripts/design-contract-baseline.json";
/**
 * Bump on ANY scanner-definition change (widening/narrowing a category).
 * The regen script permits per-category total increases only when migrating
 * an artifact whose version is older than this; the lints refuse to compare
 * against an older-version artifact (definitions and counts would disagree).
 */
export const BASELINE_VERSION = 4;

/**
 * Task #4500 — chart-internal label floor. The app-wide readable-size floor is
 * 11px (audits/internal-os-design-audit-2026-08.md §4.3, snapped to
 * text-caption 12px by Task #4481), but chart-internal labels (recharts axis
 * ticks, legends, reference-line labels — numeric fontSize props invisible to
 * the text-[Npx] ratchet) conventionally sit at 10–11px. Sanctioned decision:
 * chart-internal numeric fontSize has a HARD FLOOR of 10px. Values below it
 * (fontSize={8|9}) are flagged by lint-design-chart-font-size.
 */
export const CHART_FONT_SIZE_FLOOR_PX = 10;
export const REGEN_COMMAND = "npx tsx scripts/regen-design-contract-baseline.ts";
export const SKIP_ENV_VAR = "LINT_DESIGN_CONTRACT_SKIP";

export interface DesignMatch {
  line: number;
  token: string;
}
export interface CategoryScan {
  count: number;
  samples: DesignMatch[];
}
export type FileScan = Record<DesignCategoryId, CategoryScan>;

const SAMPLE_CAP_PER_FILE = 40;

export interface DesignCategoryMeta {
  id: DesignCategoryId;
  lintName: string;
  label: string;
  remedy: string[];
}

export const CATEGORIES: Record<DesignCategoryId, DesignCategoryMeta> = {
  hexColors: {
    id: "hexColors",
    lintName: "lint-design-hex-colors",
    label: "hardcoded hex color",
    remedy: [
      "Use the token palette from client/src/index.css instead of raw hexes:",
      "  semantic utilities (bg-primary, text-muted-foreground, border-border, bg-status-ok, …)",
      "  or var(--color-…)/hsl(var(--…)) references from the token constitution block.",
    ],
  },
  textPx: {
    id: "textPx",
    lintName: "lint-design-text-px",
    label: "arbitrary text-[Npx] size",
    remedy: [
      "Use the type-scale utilities from client/src/index.css instead of arbitrary pixel sizes:",
      "  text-display (28px page titles), text-heading (18px section/card headers),",
      "  text-body (14px default prose/controls), text-caption (12px secondary metadata).",
    ],
  },
  rounded: {
    id: "rounded",
    lintName: "lint-design-rounded",
    label: "off-contract rounded-*",
    remedy: [
      "Corners are square by contract (--radius: 0rem in client/src/index.css).",
      "  Allowed: rounded-none, rounded-full, and rounded-pill (--radius-pill is the sole",
      "  sanctioned exception; side/corner -none/-full variants cover pill segment caps).",
      "  Remove other rounded-* utilities instead of adding new ones.",
    ],
  },
  chartFontSize: {
    id: "chartFontSize",
    lintName: "lint-design-chart-font-size",
    label: "sub-floor numeric fontSize literal (chart label below the 10px floor)",
    remedy: [
      `Chart-internal labels (recharts ticks/legends/labels) have a sanctioned 10px hard floor (Task #4500;`,
      `  the general UI floor stays text-caption 12px per the 2026-08 design audit §4.3).`,
      "  Raise the numeric fontSize to 10 or more (fontSize={10} / tick={{ fontSize: 10 }}),",
      "  or use the type-scale classes for non-chart text.",
    ],
  },
  primaryWhite: {
    id: "primaryWhite",
    lintName: "lint-design-primary-white",
    label: "hand-rolled white-on-primary pairing (bg-primary + text-white on one line)",
    remedy: [
      "Task #4719 swept hard-coded white-on-blue chips onto the token pair — pair bg-primary with",
      "  text-primary-foreground (never text-white) so the ink tracks the palette in both themes.",
      "  Report-deck files (.report-surface, pinned light theme) are exempt by design (Task #4726).",
    ],
  },
  zIndex: {
    id: "zIndex",
    lintName: "lint-design-z-index",
    label: "off-scale z-index (Tailwind z-* or inline-style zIndex)",
    remedy: [
      "Use the CSS z-scale from client/src/index.css instead of raw Tailwind z utilities or inline zIndex literals:",
      "  z-[var(--z-base)] 0, z-[var(--z-raised)] 2, z-[var(--z-sticky)] 10,",
      "  z-[var(--z-nav)] 40, z-[var(--z-overlay)] 50, z-[var(--z-toast)] 100.",
      "  Nothing may stack above --z-toast.",
    ],
  },
};

/* ------------------------------------------------------------------------- *
 * Masking: blank comments and regex-literal bodies (newlines preserved) while
 * KEEPING string/template contents — the violations live inside class-name
 * strings. Regex literals must be masked too (source-scanner rule): a quote or
 * a hex-looking pattern inside /…/ is neither a string nor a color.
 * ------------------------------------------------------------------------- */
const REGEX_PREV = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", ";", "+", "-", "*", "%", "~", "^", "",
]);
// Deliberately NOT in REGEX_PREV: `<` `>` `{` `}` — in .tsx those are JSX
// tag/expression delimiters far more often than regex-start contexts, and a
// false regex-blank there swallows real className strings.

export function maskForDesignScan(src: string): string {
  const n = src.length;
  const out = src.split("");

  function processCode(start: number, insideInterpolation: boolean): number {
    let i = start;
    let braceDepth = 0;
    let prev = "";
    while (i < n) {
      const c = src[i]!;
      const next = i + 1 < n ? src[i + 1]! : "";
      if (c === "/" && next === "/") {
        while (i < n && src[i] !== "\n") {
          out[i] = " ";
          i++;
        }
        continue;
      }
      if (c === "/" && next === "*") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
          if (src[i] !== "\n") out[i] = " ";
          i++;
        }
        if (i < n) {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
        }
        continue;
      }
      if (c === '"' || c === "'") {
        i++;
        while (i < n && src[i] !== c && src[i] !== "\n") {
          if (src[i] === "\\") {
            i += 2;
            continue;
          }
          i++;
        }
        if (i < n && src[i] === c) i++;
        prev = ")"; // expression-end semantics: a following slash is division
        continue;
      }
      if (c === "`") {
        i = processTemplate(i + 1);
        prev = ")";
        continue;
      }
      if (c === "/") {
        if (REGEX_PREV.has(prev)) {
          // Regex literal: blank delimiters, body, and flags.
          out[i] = " ";
          i++;
          let inClass = false;
          while (i < n && src[i] !== "\n") {
            const rc = src[i]!;
            if (rc === "\\") {
              out[i] = " ";
              if (i + 1 < n && src[i + 1] !== "\n") out[i + 1] = " ";
              i += 2;
              continue;
            }
            if (rc === "[") inClass = true;
            else if (rc === "]") inClass = false;
            out[i] = " ";
            i++;
            if (rc === "/" && !inClass) break;
          }
          while (i < n && /[a-z]/i.test(src[i]!)) {
            out[i] = " ";
            i++;
          }
          prev = ")";
          continue;
        }
        prev = "/";
        i++;
        continue;
      }
      if (insideInterpolation) {
        if (c === "{") braceDepth++;
        else if (c === "}") {
          if (braceDepth === 0) return i + 1;
          braceDepth--;
        }
      }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
    return i;
  }

  function processTemplate(start: number): number {
    let i = start;
    while (i < n) {
      const c = src[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") return i + 1;
      if (c === "$" && i + 1 < n && src[i + 1] === "{") {
        i = processCode(i + 2, true);
        continue;
      }
      i++;
    }
    return i;
  }

  processCode(0, false);
  return out.join("");
}

/* ------------------------------------------------------------------------- *
 * Category matchers (run on MASKED source).
 * ------------------------------------------------------------------------- */
interface RawMatch {
  index: number;
  token: string;
}

const HEX_RE = /#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{3})(?![0-9A-Za-z])/g;
// Short-hex (3/4-digit) guard: count only when the body contains a hex LETTER
// (#fff, #f0f0) or is a single repeated digit (#000, #1111). All-digit
// non-repeated bodies (#123, #4347) are live issue-ref/ID strings in UI copy.
function shortHexCounts(body: string): boolean {
  if (/[A-Fa-f]/.test(body)) return true;
  return body.split("").every((ch) => ch === body[0]);
}
// `&` blocks &#123456; HTML entities; `.` blocks this.#facade-style private
// fields whose names happen to be all hex letters; `#`/idents block mid-word hits.
const HEX_PREV_BLOCK = /[0-9A-Za-z_&#.]/;

const TEXT_PX_RE =
  /text-\[(?:(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem)|length:[^\]\n]+)\]/g;

const TW_BOUND = /[A-Za-z0-9_-]/;

const ROUNDED_RE =
  /rounded(?:-(?:tl|tr|br|bl|ss|se|es|ee|t|r|b|l|s|e))?-(\[[^\]\n]*\]|\([^)\n]*\)|[a-z0-9]+)/g;
const ROUNDED_ALLOWED = new Set(["full", "none", "pill"]);
const ROUNDED_SIZES = new Set(["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"]);

const Z_RE = /-?z-(?:\d+|\[[^\]\n]*\]|\([^)\n]*\)|auto)/g;

// Task #4500 — fontSize values in chart/SVG props. The scanner locates every
// `fontSize=` / `fontSize:` (optionally quoted key) site, extracts the FULL
// value — balanced-brace JSX expression, quoted string, or object-literal
// value up to the next delimiter — and flags the site when ANY numeric
// literal inside it resolves below CHART_FONT_SIZE_FLOOR_PX (px/em-less
// treated as px, rem/em ×16). This closes the evasion forms: fontSize="8",
// fontSize={cond ? 10 : 8}, fontSize: "9px", tick={{ fontSize: 9 }}.
// Conservative by design: a sub-floor literal anywhere in the expression
// counts; genuinely dynamic values with no sub-floor literal never do.
const CHART_FONT_SIZE_HEAD_RE = /\b["']?fontSize["']?\s*[:=]\s*/g;
const CHART_FONT_SIZE_LITERAL_RE = /(?<![\w.$])(\d+(?:\.\d+)?)(px|rem|em)?(?![\w.])/g;

// Inline-style zIndex literals (style={{ zIndex: 60 }} / zIndex: "60").
// `zIndex?: number` type annotations don't match (the `?` breaks the colon);
// non-literal values (zIndex: Z_TOKENS.nav) are deliberately out of scope.
const Z_INLINE_RE = /\bzIndex\s*:\s*("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|-?(?:\d+(?:\.\d+)?|\.\d+))/g;

function findHexMatches(masked: string): RawMatch[] {
  const found: RawMatch[] = [];
  for (const m of masked.matchAll(HEX_RE)) {
    const idx = m.index!;
    const prevC = idx > 0 ? masked[idx - 1]! : "";
    if (prevC && HEX_PREV_BLOCK.test(prevC)) continue;
    const body = m[0].slice(1);
    if (body.length <= 4 && !shortHexCounts(body)) continue;
    found.push({ index: idx, token: m[0] });
  }
  return found;
}

function findTextPxMatches(masked: string): RawMatch[] {
  const found: RawMatch[] = [];
  for (const m of masked.matchAll(TEXT_PX_RE)) {
    const idx = m.index!;
    const prevC = idx > 0 ? masked[idx - 1]! : "";
    if (prevC && TW_BOUND.test(prevC)) continue;
    found.push({ index: idx, token: m[0] });
  }
  return found;
}

function findRoundedMatches(masked: string): RawMatch[] {
  const found: RawMatch[] = [];
  for (const m of masked.matchAll(ROUNDED_RE)) {
    const idx = m.index!;
    const token = m[0];
    const prevC = idx > 0 ? masked[idx - 1]! : "";
    if (prevC && TW_BOUND.test(prevC)) continue;
    const nextC = idx + token.length < masked.length ? masked[idx + token.length]! : "";
    if (nextC && TW_BOUND.test(nextC)) continue;
    const size = m[1]!;
    if (size.startsWith("[")) {
      const inner = size.slice(1, -1);
      if (inner.startsWith("var(--radius")) continue; // token-referencing arbitrary value
      found.push({ index: idx, token });
      continue;
    }
    if (size.startsWith("(")) {
      const inner = size.slice(1, -1);
      if (inner.startsWith("--radius")) continue; // Tailwind v4 var shorthand
      found.push({ index: idx, token });
      continue;
    }
    if (ROUNDED_ALLOWED.has(size)) continue;
    if (!ROUNDED_SIZES.has(size)) continue; // unknown suffix: prose/custom class, not the radius family
    found.push({ index: idx, token });
  }
  return found;
}

function findZMatches(masked: string): RawMatch[] {
  const found: RawMatch[] = [];
  for (const m of masked.matchAll(Z_RE)) {
    const idx = m.index!;
    const token = m[0];
    const negative = token.startsWith("-");
    const prevC = idx > 0 ? masked[idx - 1]! : "";
    if (negative) {
      // Also blocks `-` so var names like --z-toast never match via their tail.
      if (prevC && /[A-Za-z0-9_-]/.test(prevC)) continue;
    } else if (prevC && TW_BOUND.test(prevC)) {
      continue;
    }
    const nextC = idx + token.length < masked.length ? masked[idx + token.length]! : "";
    if (nextC && TW_BOUND.test(nextC)) continue;
    const body = negative ? token.slice(1) : token;
    const val = body.slice(2); // strip "z-"
    if (val === "auto") continue;
    if (val.startsWith("[")) {
      const inner = val.slice(1, -1);
      if (!negative && inner.startsWith("var(--z-")) continue; // on-scale reference
    } else if (val.startsWith("(")) {
      const inner = val.slice(1, -1);
      if (!negative && inner.startsWith("--z-")) continue; // Tailwind v4 var shorthand
    }
    found.push({ index: idx, token });
  }
  for (const m of masked.matchAll(Z_INLINE_RE)) {
    const raw = m[1]!;
    const quote = raw[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      const inner = raw.slice(1, -1).trim();
      if (inner.startsWith("var(--z-")) continue; // on-scale reference
    }
    found.push({ index: m.index!, token: m[0].replace(/\s+/g, " ") });
  }
  found.sort((a, b) => a.index - b.index);
  return found;
}

// Task #4726 — hand-rolled white-on-primary pairings. Task #4719 swept the
// ~51 hard-coded `bg-primary text-white` literals onto text-primary-foreground;
// this category ratchets the remaining same-line pairings (mostly
// `bg-primary hover:bg-primary/90 text-white`) and blocks new ones. Definition:
// a line counts ONCE when it carries both an UNPREFIXED bg-primary[/NN] token
// and an UNPREFIXED text-white[/NN] token (variant-prefixed forms like
// hover:bg-primary/90 don't count on their own — the swept convention concerns
// the base pair). bg-primary-foreground / text-white-anything never match
// (Tailwind boundary). Files containing the report-deck marker class
// `report-surface` are exempt: the report deck pins a light theme where
// white-on-primary is deliberate (see scanFileContent). The marker is checked
// on the MASKED source so a mere comment mention cannot exempt a file.
const PRIMARY_WHITE_BG_RE = /bg-primary(?:\/\d+(?:\.\d+)?)?(?![A-Za-z0-9_/-])/g;
const PRIMARY_WHITE_TEXT_RE = /text-white(?:\/\d+(?:\.\d+)?)?(?![A-Za-z0-9_/-])/g;
// Blocks mid-word hits AND variant prefixes (`hover:bg-primary`): `:` included.
const PRIMARY_WHITE_PREV_BLOCK = /[A-Za-z0-9_:.-]/;

const REPORT_SURFACE_MARKER = /\breport-surface\b/;

function unprefixedTokenIndexes(masked: string, re: RegExp): number[] {
  const idxs: number[] = [];
  for (const m of masked.matchAll(re)) {
    const idx = m.index!;
    const prevC = idx > 0 ? masked[idx - 1]! : "";
    if (prevC && PRIMARY_WHITE_PREV_BLOCK.test(prevC)) continue;
    idxs.push(idx);
  }
  return idxs;
}

function findPrimaryWhiteMatches(masked: string, lineOf: (index: number) => number): RawMatch[] {
  const bgIdxs = unprefixedTokenIndexes(masked, PRIMARY_WHITE_BG_RE);
  if (bgIdxs.length === 0) return [];
  const textIdxs = unprefixedTokenIndexes(masked, PRIMARY_WHITE_TEXT_RE);
  if (textIdxs.length === 0) return [];
  const bgLines = new Map<number, number>(); // line → first bg-primary index
  for (const idx of bgIdxs) {
    const line = lineOf(idx);
    if (!bgLines.has(line)) bgLines.set(line, idx);
  }
  const found: RawMatch[] = [];
  const seen = new Set<number>();
  for (const idx of textIdxs) {
    const line = lineOf(idx);
    if (seen.has(line)) continue;
    const bgIdx = bgLines.get(line);
    if (bgIdx === undefined) continue;
    seen.add(line);
    const start = Math.min(bgIdx, idx);
    const lineStart = masked.lastIndexOf("\n", start) + 1;
    let lineEnd = masked.indexOf("\n", start);
    if (lineEnd === -1) lineEnd = masked.length;
    const snippet = masked.slice(lineStart, lineEnd).trim().replace(/\s+/g, " ");
    found.push({
      index: start,
      token: snippet.length > 60 ? `${snippet.slice(0, 57)}…` : snippet,
    });
  }
  found.sort((a, b) => a.index - b.index);
  return found;
}

function findChartFontSizeMatches(masked: string): RawMatch[] {
  const found: RawMatch[] = [];
  for (const m of masked.matchAll(CHART_FONT_SIZE_HEAD_RE)) {
    const valueStart = m.index! + m[0].length;
    const first = masked[valueStart];
    let valueEnd = valueStart;
    if (first === "{") {
      let depth = 0;
      for (let j = valueStart; j < masked.length; j++) {
        const c = masked[j];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            valueEnd = j + 1;
            break;
          }
        } else if (c === "\n" && depth === 0) break;
      }
      if (valueEnd === valueStart) valueEnd = Math.min(masked.length, valueStart + 80);
    } else if (first === '"' || first === "'" || first === "`") {
      const close = masked.indexOf(first, valueStart + 1);
      valueEnd = close === -1 ? Math.min(masked.length, valueStart + 80) : close + 1;
    } else {
      const rest = masked.slice(valueStart, valueStart + 160);
      const stop = rest.search(/[,;})\n]/);
      valueEnd = valueStart + (stop === -1 ? rest.length : stop);
    }
    const value = masked.slice(valueStart, valueEnd);
    let subFloor = false;
    for (const lit of value.matchAll(CHART_FONT_SIZE_LITERAL_RE)) {
      const n = Number.parseFloat(lit[1]!);
      const unit = lit[2];
      const px = unit === "rem" || unit === "em" ? n * 16 : n;
      if (px < CHART_FONT_SIZE_FLOOR_PX) {
        subFloor = true;
        break;
      }
    }
    if (!subFloor) continue;
    const snippet = masked.slice(m.index!, valueEnd).replace(/\s+/g, " ");
    found.push({ index: m.index!, token: snippet.length > 60 ? `${snippet.slice(0, 57)}…` : snippet });
  }
  return found;
}

function buildLineOf(masked: string): (index: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "\n") starts.push(i + 1);
  }
  return (index: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

export function scanFileContent(src: string): FileScan {
  const masked = maskForDesignScan(src);
  const lineOf = buildLineOf(masked);
  const toScan = (matches: RawMatch[]): CategoryScan => ({
    count: matches.length,
    samples: matches
      .slice(0, SAMPLE_CAP_PER_FILE)
      .map((m) => ({ line: lineOf(m.index), token: m.token })),
  });
  return {
    hexColors: toScan(findHexMatches(masked)),
    textPx: toScan(findTextPxMatches(masked)),
    rounded: toScan(findRoundedMatches(masked)),
    zIndex: toScan(findZMatches(masked)),
    chartFontSize: toScan(findChartFontSizeMatches(masked)),
    // Report-deck exemption (Task #4726): the public report deck pins a light
    // theme (.report-surface) where white-on-primary is deliberate — files
    // carrying the marker class are out of scope for the pairing ratchet.
    // Tested against the MASKED source: comments and regex literals are
    // blanked, so a `// report-surface` comment never exempts a file — only a
    // live string/template occurrence (className usage, CSS selector) does.
    primaryWhite: toScan(
      REPORT_SURFACE_MARKER.test(masked) ? [] : findPrimaryWhiteMatches(masked, lineOf),
    ),
  };
}

/* ------------------------------------------------------------------------- *
 * Discovery + baseline artifact.
 * ------------------------------------------------------------------------- */
export function discoverClientFiles(): string[] {
  return listTrackedFiles().filter(
    (f) =>
      f.startsWith("client/src/") &&
      (f.endsWith(".ts") || f.endsWith(".tsx")) &&
      isScannablePath(f),
  );
}

export interface BaselineCategory {
  total: number;
  files: Record<string, number>;
}
export type BaselineCategories = Record<DesignCategoryId, BaselineCategory>;
export interface DesignBaseline {
  version: number;
  generatedAt: string;
  generatedBy: string;
  note: string[];
  sha256: string;
  categories: BaselineCategories;
}

export const ARTIFACT_NOTE: string[] = [
  "AUTOGENERATED — never hand-edit (the sha256 self-hash rejects edits). Sole writer: scripts/regen-design-contract-baseline.ts",
  "Frozen per-file design-contract baseline for the four ratchet lints (Task #4347):",
  "lint-design-hex-colors / lint-design-text-px / lint-design-rounded / lint-design-z-index.",
  "Counts may only go DOWN; the regen script refuses per-category total increases.",
  "Merge conflict here? Take either side (git checkout --ours|--theirs), regen on the rebased tree, commit. Never hand-merge.",
  "Definitions v2 (Task #4347 impact review, widened by Task #4425): hex = 6/8-digit #RRGGBB[AA] plus 3/4-digit",
  "short hexes containing a hex letter or a single repeated digit (all-digit non-repeated #123-style refs excluded);",
  "text = text-[<number>px|rem] and text-[length:…];",
  "rounded-* counted except -none/-full/-pill (bare rounded + side-only forms resolve to var(--radius)=0rem);",
  "z-* counted except z-auto and z-[var(--z-…)] / z-(--z-…), plus inline-style zIndex numeric/string literals",
  "(var(--z-…) values allowed). Scope: tracked client/src/**/*.{ts,tsx}; comments + regex literals masked.",
  "Definitions v3 (Task #4500): chartFontSize = any fontSize prop/key whose value expression contains a numeric",
  "literal BELOW the sanctioned 10px chart-internal label floor (fontSize={N}, fontSize=\"N\", fontSize: N,",
  "fontSize: \"Npx\", ternary/expression branches; rem/em x16). General UI floor stays text-caption 12px (audit 4.3).",
  "Definitions v4 (Task #4726): primaryWhite = a line carrying BOTH an unprefixed bg-primary[/NN] token and an",
  "unprefixed text-white[/NN] token (one count per line; variant-prefixed forms like hover:bg-primary/90 don't",
  "pair on their own). Files containing the report-surface marker class (pinned-light report deck) are exempt.",
  "Remedy: pair bg-primary with text-primary-foreground, never text-white (Task #4719 sweep convention).",
];

/** sha-256 over canonical `id.total=N` + `id:file=count` lines (sorted files, fixed category order). */
export function baselineContentHash(categories: BaselineCategories): string {
  const lines: string[] = [];
  for (const id of CATEGORY_IDS) {
    const cat = categories[id];
    if (!cat) continue; // older-version artifact predating this category (regen migration path)
    lines.push(`${id}.total=${cat.total}`);
    for (const f of Object.keys(cat.files).sort()) {
      lines.push(`${id}:${f}=${cat.files[f]}`);
    }
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function composeBaselineJson(
  categories: BaselineCategories,
  generatedAtIso: string,
): string {
  const orderedCats = {} as BaselineCategories;
  for (const id of CATEGORY_IDS) {
    const src = categories[id];
    const files: Record<string, number> = {};
    let sum = 0;
    for (const f of Object.keys(src.files).sort()) {
      const c = src.files[f]!;
      if (!Number.isInteger(c) || c <= 0) {
        throw new Error(`composeBaselineJson: ${id}:${f} count ${c} is not a positive integer`);
      }
      files[f] = c;
      sum += c;
    }
    if (sum !== src.total) {
      throw new Error(`composeBaselineJson: ${id} total ${src.total} != per-file sum ${sum}`);
    }
    orderedCats[id] = { total: src.total, files };
  }
  const artifact: DesignBaseline = {
    version: BASELINE_VERSION,
    generatedAt: generatedAtIso,
    generatedBy: "scripts/regen-design-contract-baseline.ts",
    note: ARTIFACT_NOTE,
    sha256: baselineContentHash(orderedCats),
    categories: orderedCats,
  };
  return JSON.stringify(artifact, null, 2) + "\n";
}

export interface BaselineParseResult {
  ok: boolean;
  baseline?: DesignBaseline;
  error?: string;
}

export function parseBaselineJson(raw: string): BaselineParseResult {
  if (/^(<{7}|={7}|>{7})/m.test(raw)) {
    return {
      ok: false,
      error:
        `merge conflict markers detected in ${BASELINE_RELPATH}. Resolution: take either side ` +
        `(git checkout --ours|--theirs -- ${BASELINE_RELPATH}), then regen on the rebased tree ` +
        `(${REGEN_COMMAND}) and commit. Never hand-merge.`,
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      error: `unparseable JSON (${(e as Error).message}) — restore the committed artifact or regen: ${REGEN_COMMAND}`,
    };
  }
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "artifact root is not an object" };
  }
  const b = data as Partial<DesignBaseline>;
  if (b.version !== BASELINE_VERSION && b.version !== 1 && b.version !== 2 && b.version !== 3) {
    return {
      ok: false,
      error: `unsupported baseline version ${String(b.version)} (expected ${BASELINE_VERSION}; versions 1-3 are readable only for regen migration)`,
    };
  }
  if (typeof b.sha256 !== "string" || typeof b.categories !== "object" || b.categories === null) {
    return { ok: false, error: "artifact is missing sha256/categories" };
  }
  for (const id of CATEGORY_IDS) {
    const cat = (b.categories as Record<string, BaselineCategory | undefined>)[id];
    // Older-version artifacts legitimately predate newer categories (v3 added
    // chartFontSize); the regen migration path re-freezes them.
    if (!cat && b.version !== BASELINE_VERSION) continue;
    if (!cat || typeof cat.total !== "number" || typeof cat.files !== "object" || cat.files === null) {
      return { ok: false, error: `category ${id} is missing or malformed` };
    }
    let sum = 0;
    for (const [f, c] of Object.entries(cat.files)) {
      if (!Number.isInteger(c) || c <= 0) {
        return { ok: false, error: `category ${id}: file ${f} has a non-positive count` };
      }
      sum += c;
    }
    if (sum !== cat.total) {
      return {
        ok: false,
        error:
          `category ${id}: total ${cat.total} != sum of per-file counts ${sum} — hand-edited? ` +
          `Restore the committed artifact (git checkout HEAD -- ${BASELINE_RELPATH}) or regen legitimately: ${REGEN_COMMAND}`,
      };
    }
  }
  const expected = baselineContentHash(b.categories as BaselineCategories);
  if (expected !== b.sha256) {
    return {
      ok: false,
      error:
        `sha256 mismatch — the artifact was hand-edited; hand edits are rejected by design (frozen-snapshot ratchet). ` +
        `Restore: git checkout HEAD -- ${BASELINE_RELPATH}; legitimate reductions regen via: ${REGEN_COMMAND}`,
    };
  }
  return { ok: true, baseline: b as DesignBaseline };
}

export function loadBaselineFromDisk(rootDir: string): BaselineParseResult {
  const p = resolve(rootDir, BASELINE_RELPATH);
  if (!existsSync(p)) {
    return {
      ok: false,
      error: `baseline artifact missing at ${BASELINE_RELPATH} — bootstrap it with: ${REGEN_COMMAND}`,
    };
  }
  return parseBaselineJson(readFileSync(p, "utf8"));
}

/* ------------------------------------------------------------------------- *
 * The shared lint runner (per category, two-sided vs the frozen baseline).
 * ------------------------------------------------------------------------- */
export interface RunDesignLintOptions {
  /** Fixture-tree root. When set, opts.files is required (no git discovery). */
  rootDir?: string;
  /** Repo-relative (or rootDir-relative) files to scan; default: tracked client tree. */
  files?: string[];
  /** Raw baseline JSON override (fixture mode); default: read from disk. */
  baselineJson?: string;
  /** Override for the LINT_DESIGN_CONTRACT_SKIP env value (tests). */
  skipEnv?: string;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

export interface NewViolationEntry {
  file: string;
  baseline: number;
  actual: number;
  samples: DesignMatch[];
}
export interface StaleEntry {
  file: string;
  baseline: number;
  actual: number;
}
export interface DesignLintResult {
  exitCode: number;
  skipped: boolean;
  scannedFiles: number;
  actualTotal: number;
  baselineTotal: number;
  newViolations: NewViolationEntry[];
  staleEntries: StaleEntry[];
  integrityError: string | null;
}

export function runDesignLint(
  categoryId: DesignCategoryId,
  opts: RunDesignLintOptions = {},
): DesignLintResult {
  const meta = CATEGORIES[categoryId];
  const log = opts.log ?? ((l: string) => console.log(l));
  const logError = opts.logError ?? ((l: string) => console.error(l));
  const base: DesignLintResult = {
    exitCode: 0,
    skipped: false,
    scannedFiles: 0,
    actualTotal: 0,
    baselineTotal: 0,
    newViolations: [],
    staleEntries: [],
    integrityError: null,
  };

  const skipVal = opts.skipEnv !== undefined ? opts.skipEnv : process.env[SKIP_ENV_VAR];
  if (skipVal === "1") {
    log(`⚠ ${meta.lintName}: SKIPPED via ${SKIP_ENV_VAR}=1 (audited emergency escape — Task #4347).`);
    log(`  The design-contract ratchet did NOT run; new ${meta.label} occurrences were not checked.`);
    return { ...base, skipped: true };
  }

  if (opts.rootDir !== undefined && opts.files === undefined) {
    throw new Error("runDesignLint: opts.files is required when opts.rootDir is set (fixture mode has no git discovery)");
  }
  const rootDir = opts.rootDir ?? process.cwd();
  const files = opts.files ?? discoverClientFiles();

  const parsed =
    opts.baselineJson !== undefined ? parseBaselineJson(opts.baselineJson) : loadBaselineFromDisk(rootDir);
  if (!parsed.ok || !parsed.baseline) {
    const err = parsed.error ?? "invalid baseline artifact";
    logError(`✗ ${meta.lintName}: baseline artifact problem — ${err}`);
    return { ...base, exitCode: 1, integrityError: err };
  }
  if (parsed.baseline.version !== BASELINE_VERSION) {
    const err =
      `baseline artifact version ${parsed.baseline.version} predates the current scanner definitions ` +
      `(version ${BASELINE_VERSION}) — its counts were frozen under the old definitions. ` +
      `Regen on this tree and commit: ${REGEN_COMMAND}`;
    logError(`✗ ${meta.lintName}: ${err}`);
    return { ...base, exitCode: 1, integrityError: err };
  }
  const baselineCat = parsed.baseline.categories[categoryId];

  const actualByFile = new Map<string, CategoryScan>();
  let scanned = 0;
  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(resolve(rootDir, rel), "utf8");
    } catch {
      continue; // listed but unreadable/deleted on disk: counts as 0 (surfaces as stale below)
    }
    scanned++;
    const scan = scanFileContent(src)[categoryId];
    if (scan.count > 0) actualByFile.set(rel, scan);
  }

  const newViolations: NewViolationEntry[] = [];
  const staleEntries: StaleEntry[] = [];
  let actualTotal = 0;
  for (const [file, scan] of actualByFile) {
    actualTotal += scan.count;
    const frozen = baselineCat.files[file] ?? 0;
    if (scan.count > frozen) {
      newViolations.push({ file, baseline: frozen, actual: scan.count, samples: scan.samples });
    }
  }
  for (const [file, frozen] of Object.entries(baselineCat.files)) {
    const actual = actualByFile.get(file)?.count ?? 0;
    if (actual < frozen) staleEntries.push({ file, baseline: frozen, actual });
  }
  newViolations.sort((a, b) => (a.file < b.file ? -1 : 1));
  staleEntries.sort((a, b) => (a.file < b.file ? -1 : 1));

  const result: DesignLintResult = {
    ...base,
    scannedFiles: scanned,
    actualTotal,
    baselineTotal: baselineCat.total,
    newViolations,
    staleEntries,
  };

  if (newViolations.length === 0 && staleEntries.length === 0) {
    log(
      `✓ ${meta.lintName}: ${scanned} client files scanned; ${actualTotal} ${meta.label} occurrence(s) match the frozen baseline (${BASELINE_RELPATH}).`,
    );
    log(`  Ratchet: counts only move DOWN. After removing occurrences, regen + commit: ${REGEN_COMMAND}`);
    return result;
  }

  result.exitCode = 1;
  if (newViolations.length > 0) {
    const added = newViolations.reduce((s, v) => s + (v.actual - v.baseline), 0);
    logError(
      `✗ ${meta.lintName}: ${added} new ${meta.label} occurrence(s) above the frozen baseline in ${newViolations.length} file(s).`,
    );
    logError(
      `  The design-contract ratchet only moves DOWN (Task #4347). Do not edit ${BASELINE_RELPATH} — the sha256`,
    );
    logError(
      `  self-hash rejects hand edits and the regen script refuses count increases. Use tokens instead:`,
    );
    for (const line of meta.remedy) logError(`  ${line}`);
    const shown = newViolations.slice(0, 25);
    for (const v of shown) {
      logError(`    ${v.file}: baseline ${v.baseline} → found ${v.actual} (+${v.actual - v.baseline})`);
      for (const s of v.samples.slice(0, 6)) {
        logError(`        L${s.line}: ${s.token}`);
      }
    }
    if (newViolations.length > shown.length) {
      logError(`    … and ${newViolations.length - shown.length} more file(s)`);
    }
  }
  if (staleEntries.length > 0) {
    logError(
      `✗ ${meta.lintName}: count(s) dropped BELOW the frozen baseline in ${staleEntries.length} file(s) — good news, but the ratchet must be locked in:`,
    );
    for (const s of staleEntries.slice(0, 25)) {
      logError(`    ${s.file}: baseline ${s.baseline} → found ${s.actual}`);
    }
    if (staleEntries.length > 25) logError(`    … and ${staleEntries.length - 25} more file(s)`);
    logError(`  Regen the baseline on this tree, then commit the artifact:`);
    logError(`      ${REGEN_COMMAND}`);
    logError(
      `  (Rebase/merge conflict on ${BASELINE_RELPATH}? Take either side — git checkout --ours|--theirs — then regen on the rebased tree and commit. Never hand-merge.)`,
    );
  }
  return result;
}
