/* test-registration
{
  "name": "Report design-token lockstep + AA contrast contract (Task #4272)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4272 — pure static parse of index.css + the reportTokens TS mirror (no DB, no network, no server boot); sub-second and fully deterministic, and it guards the CSS-vs-TS token parity that every report slide now depends on, so it earns a routine-gate slot.",
  "scanPaths": [
    "client/src/index.css",
    "client/src/pages/publicReport/reportTokens.ts",
    "client/src/pages/publicReport/StatusTag.tsx"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4272 — the report design-token layer exists in two forms that
 * MUST stay in lockstep:
 *
 *   1. CSS custom properties in client/src/index.css
 *      (":root client-report token layer" + `.report-surface` status
 *      scale) — the canonical definition, consumed by classes/print.
 *   2. The TS mirror `client/src/pages/publicReport/reportTokens.ts` —
 *      consumed by recharts/SVG code that cannot resolve var().
 *
 * This suite fails if either side drifts, and re-computes the WCAG AA
 * contrast contract for each token in its documented role (audit
 * §8.2/§5.3) so a "small" hex tweak cannot silently reintroduce the
 * contrast defects this layer was built to fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  REPORT_COLORS,
  REPORT_STATUS_COLORS,
  REPORT_STATUS_GLYPHS,
  REPORT_PHASE_COLORS,
  REPORT_TICK_FONT_SIZE,
  REPORT_CAPTION_FONT_SIZE,
  type ReportStatusLevel,
} from '../client/src/pages/publicReport/reportTokens';

const cssPath = path.resolve(process.cwd(), 'client/src/index.css');
const css = fs.readFileSync(cssPath, 'utf8');

// ---------- helpers ----------

/**
 * The :root client-report token layer is anchored on its header comment
 * (stable) rather than a `:root { … --report-crimson:` regex — the
 * dark-mode capstone introduced other braces between the nearest
 * `:root {` and the token vars, which broke the old anchor. We slice
 * from the first `--report-*` declaration after the header to the
 * block's closing brace; custom-property declarations contain no
 * nested braces, so the first `}` closes the layer's rule block.
 */
function extractReportLayerBlock(): string {
  const label = 'client-report token layer';
  const headerIdx = css.indexOf('Client-report token layer (Task #4272');
  assert.ok(headerIdx >= 0, `${label}: start marker not found in index.css`);
  const varsIdx = css.indexOf('--report-crimson:', headerIdx);
  assert.ok(varsIdx >= 0, `${label}: --report-crimson not found after the header comment`);
  const close = css.indexOf('}', varsIdx);
  assert.ok(close > varsIdx, `${label}: closing brace not found`);
  return css.slice(varsIdx, close);
}

/**
 * The `.report-surface` status scale is anchored the same way as
 * extractReportLayerBlock() above: on its header comment ("Report
 * status scale") rather than a `.report-surface { --status-healthy:`
 * regex, which required --status-healthy to be the FIRST declaration
 * after the brace (any leading comment, new var, or reorder broke it —
 * exactly how the :root anchor broke during the dark-mode capstone).
 * We find the `.report-surface` selector after the header, take its
 * opening brace, and slice to the first `}` — the block holds only
 * custom-property declarations, so no nested braces occur.
 */
function extractStatusScaleBlock(): string {
  const label = '.report-surface status scale';
  const headerIdx = css.indexOf('Report status scale');
  assert.ok(headerIdx >= 0, `${label}: header comment not found in index.css`);
  const selIdx = css.indexOf('.report-surface', headerIdx);
  assert.ok(selIdx >= 0, `${label}: .report-surface selector not found after the header comment`);
  const open = css.indexOf('{', selIdx);
  const close = css.indexOf('}', open);
  assert.ok(open >= 0 && close > open, `${label}: block braces not found`);
  return css.slice(open + 1, close);
}

function parseVars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim().replace(/\s*\/\*.*$/, '');
  }
  return out;
}

const kebab = (camel: string) =>
  camel.replace(/([A-Z])/g, '-$1').toLowerCase();

// WCAG relative luminance / contrast
function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const full =
    c.length === 3 ? c.split('').map((ch) => ch + ch).join('') : c;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function assertAA(fg: string, bg: string, min: number, why: string) {
  const r = contrast(fg, bg);
  assert.ok(
    r >= min,
    `${why}: contrast ${r.toFixed(2)}:1 < required ${min}:1 (fg ${fg} on bg ${bg})`,
  );
}

// ---------- CSS ↔ TS parity ----------

test('CSS --report-* hexes match the TS mirror exactly', () => {
  const block = extractReportLayerBlock();
  const vars = parseVars(block);

  for (const [camel, hex] of Object.entries(REPORT_COLORS)) {
    if (camel === 'white') continue; // TS-only convenience constant
    const cssName = `report-${kebab(camel)}`;
    assert.ok(
      vars[cssName],
      `CSS is missing --${cssName} (TS mirror has ${camel}=${hex})`,
    );
    assert.equal(
      vars[cssName].toUpperCase(),
      hex.toUpperCase(),
      `--${cssName} drifted from the TS mirror`,
    );
  }

  // Reverse direction: every literal-hex --report-* color var in the CSS
  // block must exist in the TS mirror (aliases via var() are exempt).
  for (const [name, value] of Object.entries(vars)) {
    if (!name.startsWith('report-')) continue;
    if (!/^#[0-9A-Fa-f]{3,8}$/.test(value)) continue;
    const camel = name
      .replace(/^report-/, '')
      .replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    assert.ok(
      camel in REPORT_COLORS,
      `CSS --${name}: ${value} has no counterpart in REPORT_COLORS — update reportTokens.ts in lockstep`,
    );
  }
});

test('.report-surface status scale matches REPORT_STATUS_COLORS', () => {
  const block = extractStatusScaleBlock();
  const vars = parseVars(block);
  const expectVar = (name: string, level: ReportStatusLevel) => {
    const raw = vars[name];
    assert.ok(raw, `.report-surface missing --${name}`);
    const resolved = raw.startsWith('var(')
      ? (() => {
          const ref = raw.match(/var\(--report-([a-z-]+)\)/)?.[1];
          assert.ok(ref, `--${name}: unrecognized var() form "${raw}"`);
          const camel = ref!.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
          return (REPORT_COLORS as Record<string, string>)[camel];
        })()
      : raw;
    assert.equal(
      resolved?.toUpperCase(),
      REPORT_STATUS_COLORS[level].toUpperCase(),
      `--${name} drifted from REPORT_STATUS_COLORS.${level}`,
    );
  };
  expectVar('status-healthy', 'healthy');
  expectVar('status-watch', 'watch');
  expectVar('status-attention', 'attention');
  expectVar('status-critical', 'critical');
  expectVar('status-neutral', 'neutral');
});

test('phase aliases resolve to the REPORT_PHASE_COLORS hexes', () => {
  // CSS defines --report-phase-* as var() aliases; resolve through the
  // mirror and compare against REPORT_PHASE_COLORS.
  const aliases: Record<keyof typeof REPORT_PHASE_COLORS, string> = {
    Peak: 'peak',
    Hold: 'hold',
    Taper: 'taper',
    Soft: 'soft',
    Rebuild: 'rebuild',
  };
  for (const [phase, suffix] of Object.entries(aliases)) {
    const m = css.match(
      new RegExp(`--report-phase-${suffix}:\\s*var\\(--report-([a-z-]+)\\)`),
    );
    assert.ok(m, `index.css missing --report-phase-${suffix} alias`);
    const camel = m![1].replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    assert.equal(
      (REPORT_COLORS as Record<string, string>)[camel]?.toUpperCase(),
      REPORT_PHASE_COLORS[phase as keyof typeof REPORT_PHASE_COLORS].toUpperCase(),
      `--report-phase-${suffix} alias drifted from REPORT_PHASE_COLORS.${phase}`,
    );
  }
});

test('geometric pattern data-URL stays baked with the gold hex', () => {
  // .pattern-geometric re-bakes the gold hex URL-encoded (%23…); if gold
  // ever changes, the data-URL must be re-baked in the same commit.
  const encoded = `%23${REPORT_COLORS.gold.slice(1)}`;
  assert.ok(
    css.includes(encoded),
    `index.css pattern data-URL no longer contains ${encoded} — re-bake .pattern-geometric against REPORT_COLORS.gold`,
  );
});

// ---------- AA contrast contract (audit §8.2 roles) ----------

test('light-surface text roles meet AA', () => {
  const C = REPORT_COLORS;
  for (const bg of [C.eggshell, C.paper, C.paperBright, '#FFFFFF']) {
    assertAA(C.ink, bg, 4.5, 'ink body text on light');
    assertAA(C.inkMuted, bg, 4.5, 'ink-muted secondary text on light');
    assertAA(C.goldInk, bg, 4.5, 'gold-ink accent text on light');
    assertAA(C.crimson, bg, 4.5, 'crimson accent text on light');
    assertAA(C.liberty, bg, 4.5, 'liberty info text on light');
    assertAA(C.earth, bg, 4.5, 'earth accent text on light');
  }
});

test('dark-surface text roles meet AA', () => {
  const C = REPORT_COLORS;
  for (const bg of [C.charcoal, C.charcoalHi, C.charcoalCard, C.charcoalDeep]) {
    assertAA(C.inkInverse, bg, 4.5, 'ink-inverse body text on dark');
    assertAA(C.inkInverseMuted, bg, 4.5, 'ink-inverse-muted text on dark');
  }
  // Bright status inks carry small text on charcoal/card (delta chips).
  for (const bg of [C.charcoal, C.charcoalCard]) {
    assertAA(C.healthyBright, bg, 4.5, 'healthy-bright text on dark');
    assertAA(C.crimsonBright, bg, 4.5, 'crimson-bright text on dark');
  }
  // As data accents (≥3:1 non-text) they must also clear every step.
  for (const bg of [C.charcoal, C.charcoalHi, C.charcoalCard, C.charcoalDeep]) {
    assertAA(C.healthyBright, bg, 3, 'healthy-bright data accent on dark');
    assertAA(C.crimsonBright, bg, 3, 'crimson-bright data accent on dark');
    assertAA(C.gold, bg, 3, 'gold decoration/large-text on dark');
  }
});

test('status colors meet AA as text on light AND as fills under white', () => {
  for (const [level, hex] of Object.entries(REPORT_STATUS_COLORS)) {
    for (const bg of ['#FFFFFF', REPORT_COLORS.eggshell, REPORT_COLORS.paper]) {
      assertAA(hex, bg, 4.5, `status-${level} as text on light`);
    }
    assertAA('#FFFFFF', hex, 4.5, `white text on status-${level} fill`);
  }
});

test('cross-checks: audit §5.3 defects stay dead', () => {
  const C = REPORT_COLORS;
  // Gold (decoration-only) must NOT be treated as light-surface text —
  // if someone "fixes" gold to pass on eggshell they likely swapped the
  // decoration hex for an ink; gold-ink owns that role instead.
  assert.ok(
    contrast(C.gold, C.eggshell) < 4.5,
    'gold unexpectedly passes AA on eggshell — did gold and gold-ink get swapped?',
  );
  // Watch/gold-ink share one ink (deliberate Task #4272 deviation from
  // the audit hexes, which failed their own roles).
  assert.equal(REPORT_STATUS_COLORS.watch, C.goldInk);
});

// ---------- type scale + glyph redundancy ----------

test('type-scale floors and glyph map', () => {
  assert.equal(REPORT_TICK_FONT_SIZE, 11, 'tick/eyebrow floor is 11px');
  assert.equal(REPORT_CAPTION_FONT_SIZE, 12, 'caption floor is 12px');
  const levels: ReportStatusLevel[] = [
    'healthy',
    'watch',
    'attention',
    'critical',
    'neutral',
  ];
  for (const level of levels) {
    assert.ok(
      REPORT_STATUS_GLYPHS[level],
      `status level ${level} missing its redundancy glyph`,
    );
  }
  // CSS floors: the report band must not reintroduce sub-11px sizes.
  const reportBand = css.slice(css.indexOf('--report-crimson:'));
  for (const bad of ['font-size: 0.6rem', 'font-size: 0.625rem', 'font-size: 0.65rem']) {
    assert.ok(
      !reportBand.includes(bad),
      `index.css report band reintroduced a sub-floor size (${bad})`,
    );
  }
  // .report-prose measure cap
  assert.match(
    css,
    /\.report-prose\s*\{[^}]*max-width:\s*68ch/,
    '.report-prose must cap measure at 68ch',
  );
  // .report-display fluid clamp for the cover
  assert.match(
    css,
    /\.report-display\s*\{[^}]*clamp\(/,
    '.report-display must use a fluid clamp() size',
  );
});
