/* test-registration
{
  "name": "AM Dashboard alert badge contrast — .amd-alert.attn (amber) and .amd-alert.minor (semi-white) each meet WCAG AA ≥4.5:1 on the dark-crimson card header in both light and dark Ads OS themes, at rest and on hover",
  "regression": true,
  "smoke": true,
  "smokeReason": "The ⚠ badge on the red card header is the operators' ONLY alert signal during a quick AM-scan; unreadable text means active client alerts are missed. Pure arithmetic + CSS source assertions (no DOM/DB/network); fast.",
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/pages/adsOs/adsOs.css",
    "client/src/index.css"
  ],
  "tier": "small"
}
test-registration */
/**
 * WCAG AA contrast verification for the .amd-alert badge variants
 * that sit on the dark-crimson .amd-card-h header band.
 *
 * CSS source: client/src/pages/adsOs/adsOs.css (~lines 1842–1902)
 * Theme tokens: client/src/index.css (light :root + .dark block)
 *
 * .amd-card-h background:
 *   color-mix(in srgb, hsl(var(--status-critical)) 58%, #18000a)
 *
 * .amd-alert (base):
 *   background: rgba(0,0,0,0.35) over the card header
 *   color:      #fff          (overridden by .attn / .minor)
 *   hover:      filter: brightness(1.1)
 *
 * .amd-alert.attn:
 *   color: hsl(var(--warn-on-critical))  — vivid amber token, crimson-band only
 *
 * .amd-alert.minor:
 *   background: rgba(255,255,255,0.12) over card header
 *   color:      rgba(255,255,255,0.75)  [light]
 *               rgba(255,255,255,0.92)  [dark — .dark .ads-os .amd-alert.minor]
 *   hover:      filter: none  — brightness(1.1) clips near-white text to #fff
 *               and darkens the band, dropping contrast to ~4.4:1 in dark mode.
 *
 * WCAG AA requires ≥ 4.5:1 for normal text.
 *
 * This file also asserts that the CSS source contains the key declarations,
 * providing a lightweight guard against colour drift.
 */

process.env.NODE_ENV = "test";

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── CSS source guard ─────────────────────────────────────────────────────────
// Read the actual CSS file and verify the declarations this test depends on
// are present.  A colour change in the file without updating these assertions
// will fail early with a clear message instead of silently passing stale maths.

const CSS_PATH = resolve("client/src/pages/adsOs/adsOs.css");
const cssSource = readFileSync(CSS_PATH, "utf8");

const INDEX_CSS_PATH = resolve("client/src/index.css");
const indexCssSource = readFileSync(INDEX_CSS_PATH, "utf8");

function assertCssContains(snippet: string, label: string): void {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  assert.ok(
    norm(cssSource).includes(norm(snippet)),
    `CSS source guard failed — expected to find:\n  ${snippet}\nin ${CSS_PATH}\n(${label})`,
  );
}

// attn badge text colour — rule must reference the token; the resolved HSL
// value is parsed from index.css below so contrast arithmetic always reflects
// the current token value.
assertCssContains(
  ".amd-alert.attn { color: hsl(var(--warn-on-critical)); }",
  ".attn warn-on-critical token color property",
);
// minor hover override — brightness filter disabled for the quiet variant
assertCssContains(
  ".amd-alert.minor:hover { filter: none; }",
  ".minor filter:none hover override",
);
// dark-mode minor text opacity lift
assertCssContains(
  ".dark .ads-os .amd-alert.minor { color: rgba(255, 255, 255, 0.92); }",
  "dark .minor opacity lift",
);
// card header background expression — check the structural expression is present;
// the hex anchor is parsed live below.
assertCssContains(
  "color-mix(in srgb, hsl(var(--status-critical))",
  ".amd-card-h background",
);
console.log("  ✓ CSS source guards passed");

// ── WCAG math helpers ────────────────────────────────────────────────────────

/** Convert an sRGB channel [0,255] to its linear-light value. */
function linearize(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance per WCAG 2.x. */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio (always ≥ 1). */
function contrast(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// ── Colour helpers ───────────────────────────────────────────────────────────

/** Convert HSL (h ∈ [0,360), s ∈ [0,1], l ∈ [0,1]) to rgb [0,255]. */
function hsl(h: number, s: number, l: number): [number, number, number] {
  const C = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const X = C * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if      (hp < 1) { r1 = C; g1 = X; }
  else if (hp < 2) { r1 = X; g1 = C; }
  else if (hp < 3) { g1 = C; b1 = X; }
  else if (hp < 4) { g1 = X; b1 = C; }
  else if (hp < 5) { r1 = X; b1 = C; }
  else             { r1 = C; b1 = X; }
  const m = l - C / 2;
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

/**
 * Alpha-composite an rgba overlay onto an opaque rgb base.
 * Returns the resulting opaque rgb [0,255].
 */
function composite(
  overlay: [number, number, number, number],
  base:    [number, number, number],
): [number, number, number] {
  const [or, og, ob, oa] = overlay;
  const [br, bg, bb]     = base;
  return [
    Math.round(or * oa + br * (1 - oa)),
    Math.round(og * oa + bg * (1 - oa)),
    Math.round(ob * oa + bb * (1 - oa)),
  ];
}

/** color-mix(in srgb, c1 p1%, c2 (1-p1)%) — linear sRGB blend. */
function colorMix(
  c1: [number, number, number],
  p1: number,
  c2: [number, number, number],
): [number, number, number] {
  return [
    Math.round(c1[0] * p1 + c2[0] * (1 - p1)),
    Math.round(c1[1] * p1 + c2[1] * (1 - p1)),
    Math.round(c1[2] * p1 + c2[2] * (1 - p1)),
  ];
}

/**
 * CSS `filter: brightness(1.1)` applied to an opaque rgb pixel.
 * Each channel is multiplied by 1.1 and clamped to [0,255].
 */
function brightness11(rgb: [number, number, number]): [number, number, number] {
  return [
    Math.min(Math.round(rgb[0] * 1.1), 255),
    Math.min(Math.round(rgb[1] * 1.1), 255),
    Math.min(Math.round(rgb[2] * 1.1), 255),
  ];
}

// ── Token values — parsed live from client/src/index.css ─────────────────────
//
// The HSL triplets for --status-critical are extracted at test-run time so the
// contrast arithmetic always reflects the current token values.  If a token is
// re-tuned in index.css the test automatically uses the new numbers and either
// continues to pass (the badge is still readable) or fails with an accurate
// ratio (the badge is no longer readable) — never silently passes stale maths.

/**
 * Extract the content between the opening and closing braces of the first CSS
 * rule-block whose selector matches `selector` at the start of a line.
 * Handles nested braces correctly via depth counting.
 */
function extractCssBlock(css: string, selector: string): string {
  const idx = css.search(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "m"));
  if (idx === -1) throw new Error(`CSS block not found for selector: ${selector}`);
  const start = css.indexOf("{", idx);
  if (start === -1) throw new Error(`No opening brace after selector: ${selector}`);
  let depth = 0;
  let i = start;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return css.slice(start + 1, i);
}

/**
 * Parse a CSS custom property declared as `--name: H S% L%;` within `block`
 * and return `[h, s/100, l/100]` ready for the `hsl()` helper above.
 */
function parseCssHslVar(block: string, varName: string): [number, number, number] {
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `${escaped}\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)%\\s+(\\d+(?:\\.\\d+)?)%\\s*;`,
  );
  const m = block.match(re);
  if (!m) {
    throw new Error(
      `CSS variable ${varName} not found (or not in "H S% L%" form) in the extracted block`,
    );
  }
  return [parseFloat(m[1]), parseFloat(m[2]) / 100, parseFloat(m[3]) / 100];
}

/**
 * Extract the first 6-digit hex colour (`#RRGGBB`) from the `background`
 * property within `block` (expected to be the hex anchor inside a
 * `color-mix(…, #RRGGBB)` expression) and return `[r, g, b]`.
 */
function parseCssBackgroundHex(block: string): [number, number, number] {
  const m = block.match(/background\s*:[^;]*#([0-9a-fA-F]{6})/);
  if (!m) {
    throw new Error(
      "No 6-digit hex anchor found in the background property of the extracted block",
    );
  }
  const hex = m[1];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/**
 * Extract the blend percentage from a `color-mix(in srgb, … N%, …)` expression
 * in the `background` property within `block` and return it as a fraction [0, 1].
 *
 * For example, `color-mix(in srgb, hsl(var(--status-critical)) 58%, #18000a)`
 * returns `0.58`.  If the percentage is ever re-tuned in the CSS the test will
 * automatically use the new number instead of silently computing against a
 * stale hardcoded weight.
 */
function parseCssBlendRatio(block: string): number {
  // Match `hsl(var(--…)) N%` — the percentage that follows the first color
  // argument in `color-mix(in srgb, hsl(var(--status-critical)) N%, …)`.
  // Using a literal pattern for the nested parens avoids the [^)]* trap.
  const m = block.match(/background\s*:[^;]*hsl\(var\([^)]+\)\)\s+([\d]+(?:\.[\d]+)?)%/);
  if (!m) {
    throw new Error(
      "No blend percentage found in the color-mix() background expression of the extracted block",
    );
  }
  return parseFloat(m[1]) / 100;
}

const rootBlock = extractCssBlock(indexCssSource, ":root");
const darkBlock = extractCssBlock(indexCssSource, ".dark");

const STATUS_CRITICAL = {
  light: hsl(...parseCssHslVar(rootBlock, "--status-critical")),
  dark:  hsl(...parseCssHslVar(darkBlock, "--status-critical")),
} as const;

// .amd-card-h: color-mix(in srgb, hsl(--status-critical) N%, <hex anchor>)
// Both the hex anchor and the blend percentage are parsed live from adsOs.css
// so the arithmetic stays in lockstep with the source.  If either value is
// re-tuned the test automatically uses the new number and either continues to
// pass (the badge is still readable) or fails with an accurate ratio — it
// never silently computes against stale hardcoded values.
const cardHBlock = extractCssBlock(cssSource, ".amd-card-h");
const MIX_DARK: [number, number, number] = parseCssBackgroundHex(cardHBlock);
const MIX_RATIO: number = parseCssBlendRatio(cardHBlock);

function cardHeaderBg(theme: "light" | "dark"): [number, number, number] {
  return colorMix(STATUS_CRITICAL[theme], MIX_RATIO, MIX_DARK);
}

// ── .amd-alert.attn ─────────────────────────────────────────────────────────
// Base badge bg: rgba(0,0,0,0.35) over card header
// Text: hsl(var(--warn-on-critical)) — vivid amber token, same in both themes
// (no dark override; single value clears AA on both light and dark bands).

// Resolved live from `--warn-on-critical` in the :root block of index.css so
// the contrast arithmetic automatically reflects any future token re-tuning.
const ATTN_TEXT: [number, number, number] = hsl(
  ...parseCssHslVar(rootBlock, "--warn-on-critical"),
);

function attnBadgeBg(theme: "light" | "dark"): [number, number, number] {
  return composite([0, 0, 0, 0.35], cardHeaderBg(theme));
}

// ── .amd-alert.minor ────────────────────────────────────────────────────────
// Badge bg: rgba(255,255,255,0.12) over card header
// Text opacity: 0.75 in light, 0.92 in dark (.dark override)
// Hover: filter:none → hover state = resting state

function minorBadgeBg(theme: "light" | "dark"): [number, number, number] {
  return composite([255, 255, 255, 0.12], cardHeaderBg(theme));
}

const MINOR_TEXT_ALPHA = { light: 0.75, dark: 0.92 } as const;

/** Effective text colour: rgba(255,255,255,alpha) composited over badge bg. */
function minorTextEffective(
  textAlpha: number,
  badgeBg: [number, number, number],
): [number, number, number] {
  return composite([255, 255, 255, textAlpha], badgeBg);
}

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

const MIN_AA = 4.5;

// ── Assertions ───────────────────────────────────────────────────────────────

for (const theme of ["light", "dark"] as const) {
  console.log(`\n── ${theme} mode ──`);

  const cardH = cardHeaderBg(theme);
  console.log(`   .amd-card-h bg: rgb(${cardH})`);

  // ─── .amd-alert.attn — resting ───────────────────────────────────────────
  {
    const badgeBg = attnBadgeBg(theme);
    const lBg     = luminance(...badgeBg);
    const lText   = luminance(...ATTN_TEXT);
    const ratio   = contrast(lText, lBg);
    console.log(`   .attn resting: bg=rgb(${badgeBg}) L=${lBg.toFixed(4)}, text=rgb(${ATTN_TEXT}) L=${lText.toFixed(4)}, contrast=${ratio.toFixed(2)}:1`);
    ok(ratio >= MIN_AA, `.attn amber text meets WCAG AA at rest in ${theme} mode (${ratio.toFixed(2)}:1)`);
  }

  // ─── .amd-alert.attn — hover (filter: brightness(1.1)) ───────────────────
  // brightness(1.1) is applied to the rendered element as a whole:
  // bg pixels  → brightness11(badgeBg)
  // text pixels → brightness11(ATTN_TEXT)  [opaque colour, not composited]
  {
    const badgeBgHover = brightness11(attnBadgeBg(theme));
    const textHover    = brightness11(ATTN_TEXT);
    const lBg   = luminance(...badgeBgHover);
    const lText = luminance(...textHover);
    const ratio = contrast(lText, lBg);
    console.log(`   .attn hover:   bg=rgb(${badgeBgHover}) L=${lBg.toFixed(4)}, text=rgb(${textHover}) L=${lText.toFixed(4)}, contrast=${ratio.toFixed(2)}:1`);
    ok(ratio >= MIN_AA, `.attn amber text meets WCAG AA on hover in ${theme} mode (${ratio.toFixed(2)}:1)`);
  }

  // ─── .amd-alert.minor — resting ──────────────────────────────────────────
  // .amd-alert.minor:hover { filter: none } means hover = resting state,
  // so we verify the resting state twice (once for each label) rather than
  // computing a separate hover path.
  {
    const alpha   = MINOR_TEXT_ALPHA[theme];
    const badgeBg = minorBadgeBg(theme);
    const textEff = minorTextEffective(alpha, badgeBg);
    const lBg     = luminance(...badgeBg);
    const lText   = luminance(...textEff);
    const ratio   = contrast(lText, lBg);
    console.log(`   .minor resting (alpha ${alpha}): bg=rgb(${badgeBg}) L=${lBg.toFixed(4)}, eff text=rgb(${textEff}) L=${lText.toFixed(4)}, contrast=${ratio.toFixed(2)}:1`);
    ok(ratio >= MIN_AA, `.minor semi-white text meets WCAG AA at rest in ${theme} mode (${ratio.toFixed(2)}:1)`);

    // hover state = resting (filter: none override), so the same ratio applies.
    ok(ratio >= MIN_AA, `.minor semi-white text meets WCAG AA on hover in ${theme} mode — filter:none keeps resting ratio (${ratio.toFixed(2)}:1)`);
  }
}

console.log(`\nads-os-am-alert-badge-contrast: ${passed} assertion(s) passed.`);
