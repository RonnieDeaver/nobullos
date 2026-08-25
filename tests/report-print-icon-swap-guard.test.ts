/* test-registration
{
  "name": "publicReport print icon-swap guard (Task #4505) — no svg-rendering element (lucide icon or literal <svg>) in client/src/pages/publicReport/ may use a display-based breakpoint swap (md:hidden / hidden md:block pairs); the report print stylesheet forces svg { display: inline-block !important } so BOTH variants print side by side — switch ONE icon via transforms (rotate-90 md:rotate-0) instead",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4505: fast, DB-free AST source scan; this bug class shipped twice already (LifetimeValueSlide, then RevenueLeakSlide) — doubled arrows on printed client-facing report slides — and only a gate-blocking scan stops the third recurrence.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/pages/publicReport"
  ],
  "tier": "small"
}
test-registration */
// Task #4505 — lock the transform-based icon-swap rule for report slides.
//
// Background (memory: report-print-svg-display-force.md): the public-report
// print block in client/src/index.css contains
//   svg { display: inline-block !important; visibility: visible !important; }
// (to keep recharts charts from being print-suppressed). That override
// defeats Tailwind display utilities on svg elements, so a responsive icon
// swap built as an `X md:hidden` + `hidden md:block` PAIR prints BOTH icons
// side by side ("↓→" between story beats). This shipped twice
// (LifetimeValueSlide, then RevenueLeakSlide). The sanctioned pattern is ONE
// icon switched via transforms: `rotate-90 md:rotate-0`.
//
// The scan is AST-based (per lint-authoring convention — textual scans get
// bypassed by formatting): every JSX element in client/src/pages/publicReport/
// whose tag is a lucide-react import of that file, or a literal <svg>, is
// checked for display-swap className tokens. Non-svg elements (e.g.
// BookPromoSlide's decorative `hidden md:block` divs) are exempt — the print
// force targets svg only.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

let passed = 0;
const ok = (msg: string) => {
  passed++;
  console.log(`  ✓ ${msg}`);
};

const BREAKPOINTS = ["sm", "md", "lg", "xl", "2xl"];
const DISPLAY_VALUES = [
  "block",
  "inline-block",
  "inline",
  "flex",
  "inline-flex",
  "grid",
  "inline-grid",
  "contents",
  "table",
  "flow-root",
];

/**
 * True when a className string encodes a display-based breakpoint swap:
 * either a `${bp}:hidden` token, or a bare `hidden` combined with a
 * `${bp}:<display>` token. Variant-prefixed forms (e.g. `print:hidden`)
 * count via the token's final segment. Transform utilities never match.
 */
function hasDisplaySwap(className: string): boolean {
  const tokens = className.split(/\s+/).filter(Boolean);
  const segsOf = (t: string) => t.split(":");
  const hasResponsiveHidden = tokens.some((t) => {
    const segs = segsOf(t);
    return segs.length > 1 && segs[segs.length - 1] === "hidden" && segs.some((s) => BREAKPOINTS.includes(s));
  });
  if (hasResponsiveHidden) return true;
  const hasBareHidden = tokens.some((t) => t === "hidden");
  const hasResponsiveDisplay = tokens.some((t) => {
    const segs = segsOf(t);
    return (
      segs.length > 1 &&
      DISPLAY_VALUES.includes(segs[segs.length - 1]) &&
      segs.some((s) => BREAKPOINTS.includes(s))
    );
  });
  return hasBareHidden && hasResponsiveDisplay;
}

interface Violation {
  file: string;
  line: number;
  tag: string;
  className: string;
}

/** Extract scannable text from a className attribute initializer. */
function classNameText(attr: ts.JsxAttribute): string | null {
  const init = attr.initializer;
  if (!init) return null;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isTemplateExpression(e)) {
      // Scan the static parts only — dynamic parts can't be judged statically.
      return [e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join(" ");
    }
  }
  return null;
}

/** Scan one source text; returns violations and how many svg elements were seen. */
function scanSource(fileLabel: string, source: string): { violations: Violation[]; svgElements: number } {
  const sf = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // Collect this file's lucide-react import names (aliased local names).
  const lucideNames = new Set<string>();
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === "lucide-react" &&
      stmt.importClause?.namedBindings &&
      ts.isNamedImports(stmt.importClause.namedBindings)
    ) {
      for (const el of stmt.importClause.namedBindings.elements) lucideNames.add(el.name.text);
    }
  }

  const violations: Violation[] = [];
  let svgElements = 0;

  const visit = (node: ts.Node) => {
    let opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement | null = null;
    if (ts.isJsxElement(node)) opening = node.openingElement;
    else if (ts.isJsxSelfClosingElement(node)) opening = node;
    if (opening) {
      const tag = opening.tagName.getText(sf);
      const rendersSvg = tag === "svg" || lucideNames.has(tag);
      if (rendersSvg) {
        svgElements++;
        for (const prop of opening.attributes.properties) {
          if (ts.isJsxAttribute(prop) && prop.name.getText(sf) === "className") {
            const text = classNameText(prop);
            if (text && hasDisplaySwap(text)) {
              const { line } = sf.getLineAndCharacterOfPosition(opening.getStart(sf));
              violations.push({ file: fileLabel, line: line + 1, tag, className: text });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { violations, svgElements };
}

// (1) Self-test: the detector catches the bug pattern and passes the
// sanctioned/exempt patterns (scanner must be proven live before the sweep).
{
  const badPair = `
    import { MoveRight } from "lucide-react";
    export const X = () => (
      <div>
        <MoveRight className="w-5 h-5 md:hidden" />
        <MoveRight className="w-5 h-5 hidden md:block" />
      </div>
    );`;
  assert.equal(scanSource("fixture-bad-pair.tsx", badPair).violations.length, 2, "hidden/md pair must flag both svgs");

  const badLiteralSvg = `export const X = () => <svg className="hidden md:inline-flex" />;`;
  assert.equal(scanSource("fixture-bad-svg.tsx", badLiteralSvg).violations.length, 1, "literal <svg> display swap must flag");

  const badTemplate = `
    import { Star } from "lucide-react";
    export const X = ({ c }: { c: string }) => <Star className={\`hidden md:block \${c}\`} />;`;
  assert.equal(scanSource("fixture-bad-tpl.tsx", badTemplate).violations.length, 1, "template-literal static parts must be scanned");

  const goodTransform = `
    import { MoveRight } from "lucide-react";
    export const X = () => <MoveRight className="w-5 h-5 rotate-90 md:rotate-0" />;`;
  assert.equal(scanSource("fixture-good.tsx", goodTransform).violations.length, 0, "transform-based swap must pass");

  const goodDiv = `export const X = () => <div className="hidden md:block absolute" />;`;
  assert.equal(scanSource("fixture-good-div.tsx", goodDiv).violations.length, 0, "non-svg display swaps are exempt");

  const goodAlwaysHidden = `
    import { Star } from "lucide-react";
    export const X = () => <Star className="hidden" />;`;
  assert.equal(scanSource("fixture-good-hidden.tsx", goodAlwaysHidden).violations.length, 0, "unconditional hidden (no responsive display) must pass");

  ok("detector self-test: flags hidden-pair svgs (string + template), passes transform swap, non-svg divs, unconditional hidden");
}

// (2) The sweep: every .tsx source under client/src/pages/publicReport/.
{
  const dir = "client/src/pages/publicReport";
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".tsx"))
    .sort();
  assert.ok(files.length >= 10, `volume floor: expected ≥10 .tsx files under ${dir}, saw ${files.length} — scan target moved?`);

  const violations: Violation[] = [];
  let totalSvgElements = 0;
  for (const f of files) {
    const res = scanSource(join(dir, f), readFileSync(join(dir, f), "utf8"));
    violations.push(...res.violations);
    totalSvgElements += res.svgElements;
  }
  // Liveness floor: the slides render plenty of lucide icons; zero seen
  // means the scanner (or the import detection) went blind, not that the
  // deck went icon-free.
  assert.ok(totalSvgElements >= 10, `liveness floor: expected ≥10 svg-rendering elements scanned, saw ${totalSvgElements}`);

  assert.deepEqual(
    violations,
    [],
    `display-based breakpoint icon swaps found in publicReport slides — the print stylesheet forces svg display, so BOTH variants print. Use ONE icon with transform switching (e.g. "rotate-90 md:rotate-0", see LifetimeValueSlide's StageArrow):\n` +
      violations.map((v) => `  ${v.file}:${v.line} <${v.tag} className="${v.className}">`).join("\n"),
  );
  ok(`scanned ${files.length} files / ${totalSvgElements} svg elements — no display-based icon swaps`);
}

console.log(`\npublicReport print icon-swap guard: ${passed} checks passed`);
