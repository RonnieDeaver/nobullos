/* test-registration
{
  "name": "pinned-column tint source scan — --os-sticky-col-bg never hard-codes a light color (Task #4739)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4734 fixed three call sites where a tinted row set --os-sticky-col-bg to a literal light color (white / #fef2f2 / #F8F5EF), which turned the pinned identity column near-white in dark mode while the row text stayed light. The convention doc (os-table.tsx / index.css) now teaches the color-mix-over-hsl(var(--os-table-surface)) form, but only this scan enforces it — the next tinted-row feature can silently reintroduce the bug. Pure filesystem AST scan of client/src; fast, no DB.",
  "scanPaths": [
    "client/src"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4739 — guard the pinned-column tint convention.
 *
 * Rule: any client STRING (string literal, template chunk — extracted via
 * the TypeScript AST, so comments never match) that SETS
 * `--os-sticky-col-bg` (Tailwind arbitrary property
 * `[--os-sticky-col-bg:…]` or a quoted-name style-object / setProperty
 * value) to a value containing a raw hex color or the literal `white` is a
 * violation UNLESS the value composes over the table surface token
 * (`hsl(var(--os-table-surface))`) or the SAME string carries a paired
 * `dark:[--os-sticky-col-bg:…]` override (order-independent — the pair
 * must live in the same className string, so an unrelated override on a
 * neighboring element can never excuse a violation).
 *
 * Replacement vocabulary (what to write instead):
 *   [--os-sticky-col-bg:color-mix(in_srgb,<tint>_N%,hsl(var(--os-table-surface)))]
 * so the pinned cell flips with the theme exactly like the tinted row.
 */

import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const ROOT = process.cwd();
const SCAN_ROOT = "client/src";

// The three call sites Task #4734 fixed — must still exist (statSync so a
// rename fails loudly) and must each still contain at least one compliant
// setter, proving the scan actually sees real occurrences (0-of-0 = skipped
// is not a pass).
const KNOWN_SETTER_FILES = [
  "client/src/pages/Dashboard.tsx",
  "client/src/components/admin/health/PostDeployVerificationPanel.tsx",
  "client/src/pages/admin/ActivityDashboard.tsx",
] as const;

const VAR_NAME = "--os-sticky-col-bg";

interface ExtractedString {
  /** Literal text content (no quotes/backticks). */
  text: string;
  /** 1-based line of the string's start in the source file. */
  line: number;
}

/**
 * AST string extraction (house pattern — see
 * .agents/memory/client-copy-ast-guard.md): string literals,
 * no-substitution templates, and template-expression head/middle/tail
 * chunks. Comments are structurally invisible to this pass, and each
 * extracted string is an independent analysis unit — the dark-override
 * pairing check below never crosses a string boundary.
 */
export function extractStrings(source: string, fileName: string): ExtractedString[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: ExtractedString[] = [];
  const push = (text: string, pos: number) => {
    out.push({ text, line: sf.getLineAndCharacterOfPosition(pos).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node.text, node.getStart(sf));
    } else if (ts.isTemplateExpression(node)) {
      push(node.head.text, node.head.getStart(sf));
      for (const span of node.templateSpans) {
        push(span.literal.text, span.literal.getStart(sf));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

interface Setter {
  /** The value the variable is being set to. */
  value: string;
  /** True when the setter itself is the `dark:` override lane. */
  isDarkOverride: boolean;
}

/** Every place ONE extracted string SETS the variable (not reads it). */
export function extractSetters(text: string): Setter[] {
  const out: Setter[] = [];
  // Tailwind arbitrary-property form: [--os-sticky-col-bg:VALUE]
  // (bracket-free values only; color-mix uses parens, not brackets).
  const arb = /\[--os-sticky-col-bg:([^\]]*)\]/g;
  for (let m = arb.exec(text); m; m = arb.exec(text)) {
    const isDark = text.slice(Math.max(0, m.index - 5), m.index) === "dark:";
    out.push({ value: m[1], isDarkOverride: isDark });
  }
  // A bare quoted "--os-sticky-col-bg" string (style-object key or
  // setProperty first argument) is its own AST string; its VALUE arrives as
  // a separate string node. Handled in analyzeStrings via key/value pairing.
  return out;
}

function isLightLiteral(value: string): boolean {
  return /#[0-9a-fA-F]{3,8}\b/.test(value) || /\bwhite\b/i.test(value);
}

function composesOverSurface(value: string): boolean {
  return value.includes("--os-table-surface");
}

function violationMessage(rel: string, line: number, value: string): string {
  return (
    `${rel}:${line} — ${VAR_NAME} set to a hard-coded light color (${JSON.stringify(value)}). ` +
    `Compose the tint over the table surface token instead, e.g. ` +
    `[${VAR_NAME}:color-mix(in_srgb,<tint>_N%,hsl(var(--os-table-surface)))] ` +
    `(or pair a dark:[${VAR_NAME}:…] override IN THE SAME className string). ` +
    `See client/src/index.css.`
  );
}

export interface AnalysisResult {
  violations: string[];
  setterCount: number;
}

/**
 * Analyze all extracted strings of one file. Two setter shapes:
 *
 * 1. Tailwind className strings — setters and any `dark:` pair live in the
 *    SAME string; the excuse never crosses a string boundary.
 * 2. Style-object / setProperty — the string exactly equal to the var name
 *    is a KEY; the next extracted string is its value. Since that lane has
 *    no `dark:` variant, a light literal there must compose over the
 *    surface token (conservative rule).
 */
export function analyzeStrings(strings: ExtractedString[], rel: string): AnalysisResult {
  const violations: string[] = [];
  let setterCount = 0;
  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    // Lane 2: quoted var name used as a key/argument.
    if (s.text.trim() === VAR_NAME) {
      const valueStr = strings[i + 1];
      setterCount++;
      if (
        valueStr &&
        isLightLiteral(valueStr.text) &&
        !composesOverSurface(valueStr.text)
      ) {
        violations.push(violationMessage(rel, s.line, valueStr.text));
      }
      continue;
    }
    // Lane 1: className-style setters inside this one string.
    const setters = extractSetters(s.text);
    if (setters.length === 0) continue;
    setterCount += setters.length;
    const hasDarkPair = setters.some((x) => x.isDarkOverride);
    for (const setter of setters) {
      if (setter.isDarkOverride) continue; // the dark lane IS the override
      if (!isLightLiteral(setter.value)) continue;
      if (composesOverSurface(setter.value)) continue;
      if (hasDarkPair) continue; // paired override in the SAME string
      violations.push(violationMessage(rel, s.line, setter.value));
    }
  }
  return { violations, setterCount };
}

export function analyzeSource(source: string, rel: string): AnalysisResult {
  return analyzeStrings(extractStrings(source, rel), rel);
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

/** Inline extractor/checker self-test — vacuous-green protection #1. */
function selfTest(): void {
  const flagged: Array<[string, string]> = [
    ["literal white", 'const a = <div className="[--os-sticky-col-bg:white]" />;'],
    ["raw hex", 'const a = <div className="[--os-sticky-col-bg:#fef2f2]" />;'],
    ["hex among classes", 'const a = <div className="bg-x [--os-sticky-col-bg:#F8F5EF] text-y" />;'],
    ["style-object white", 'const s = { "--os-sticky-col-bg": "white" };'],
    ["setProperty hex", "el.style.setProperty('--os-sticky-col-bg', '#ffffff');"],
    [
      "template chunk",
      "const c = `border-b ${x} [--os-sticky-col-bg:white] ${y}`;",
    ],
    [
      // The review-mandated bypass fixture: a dark: override in a SEPARATE
      // string (e.g. a neighboring element) must NOT excuse the violation.
      "override on a different string never excuses",
      'const a = "[--os-sticky-col-bg:white]"; const b = "dark:[--os-sticky-col-bg:hsl(var(--card))]";',
    ],
  ];
  for (const [label, src] of flagged) {
    const r = analyzeSource(src, "fixture.tsx");
    assert(r.violations.length === 1, `fixture must be flagged (${label}): ${src}`);
  }
  const clean: Array<[string, string]> = [
    [
      "Task #4734 primary-tint shape",
      'const a = <div className="[--os-sticky-col-bg:color-mix(in_srgb,hsl(var(--primary))_5%,hsl(var(--os-table-surface)))]" />;',
    ],
    [
      "Task #4734 red-50/red-950 twin shape",
      'const a = <div className="[--os-sticky-col-bg:color-mix(in_srgb,var(--color-red-50)_70%,hsl(var(--os-table-surface)))] dark:[--os-sticky-col-bg:color-mix(in_srgb,var(--color-red-950)_25%,hsl(var(--os-table-surface)))]" />;',
    ],
    [
      "paired dark override, light-first order",
      'const a = <div className="[--os-sticky-col-bg:#fff] dark:[--os-sticky-col-bg:hsl(var(--card))]" />;',
    ],
    [
      "paired dark override, dark-FIRST order (order-independent)",
      'const a = <div className="dark:[--os-sticky-col-bg:hsl(var(--card))] [--os-sticky-col-bg:#fff]" />;',
    ],
    [
      "quoting the bad form in comments is legal",
      "// never write [--os-sticky-col-bg:white]\n/* a raw light hex like [--os-sticky-col-bg:#fef2f2] is banned */\nexport {};",
    ],
    [
      "reading the var is not a setter",
      'const v = "var(--os-sticky-col-bg, hsl(var(--os-table-surface)))";',
    ],
  ];
  for (const [label, src] of clean) {
    const r = analyzeSource(src, "fixture.tsx");
    assert(
      r.violations.length === 0,
      `fixture must pass (${label}): ${src}\n  ${r.violations.join("\n  ")}`,
    );
  }
  // Extractor must SEE the compliant setters (not just "no match") and must
  // see nothing at all in the comments-only fixture.
  assert(
    analyzeSource(clean[0][1], "fixture.tsx").setterCount === 1 &&
      analyzeSource(clean[1][1], "fixture.tsx").setterCount === 2,
    "extractor must find compliant setters",
  );
  assert(
    analyzeSource(clean[4][1], "fixture.tsx").setterCount === 0,
    "comments must be invisible to the extractor",
  );
  console.log("  ✓ extractor/checker self-test passed");
}

async function main(): Promise<void> {
  console.log("pinned-column tint source scan (Task #4739)");
  selfTest();

  for (const rel of KNOWN_SETTER_FILES) {
    statSync(path.join(ROOT, rel)); // throws loudly on rename/move
  }

  const violations: string[] = [];
  const setterCountByFile = new Map<string, number>();
  let scanned = 0;
  for await (const file of walk(path.join(ROOT, SCAN_ROOT))) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const raw = await fs.readFile(file, "utf8");
    scanned++;
    if (!raw.includes(VAR_NAME)) continue; // cheap prefilter before parsing
    const result = analyzeSource(raw, rel);
    if (result.setterCount > 0) setterCountByFile.set(rel, result.setterCount);
    violations.push(...result.violations);
  }

  // Vacuous-green protection #2: volume floors on the real scan.
  assert(scanned > 200, `sanity: scan actually walked client/src (saw ${scanned} files)`);
  let totalSetters = 0;
  for (const n of setterCountByFile.values()) totalSetters += n;
  assert(
    totalSetters >= 3,
    `sanity: expected ≥3 real ${VAR_NAME} setters in client/src (saw ${totalSetters}) — ` +
      "if the convention moved, update this scan rather than letting it go vacuous",
  );
  for (const rel of KNOWN_SETTER_FILES) {
    assert(
      (setterCountByFile.get(rel) ?? 0) >= 1,
      `sanity: ${rel} should still contain a ${VAR_NAME} setter (Task #4734 call site) — ` +
        "if it was legitimately removed, repoint KNOWN_SETTER_FILES at current setters",
    );
  }

  assert(
    violations.length === 0,
    `hard-coded light ${VAR_NAME} values found:\n  ${violations.join("\n  ")}`,
  );
  console.log(
    `  ✓ ${scanned} files scanned, ${totalSetters} setters across ${setterCountByFile.size} files — all theme-aware`,
  );
  console.log("\nos-sticky-col-bg-theme-scan: all checks passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
