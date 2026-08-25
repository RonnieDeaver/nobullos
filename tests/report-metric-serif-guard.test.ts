/* test-registration
{
  "name": "Report slides: serif font never styles metric-size numbers (Task #4614)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4614 — pure static AST scan of client/src/pages/publicReport/*.tsx (no DB, no network, no server boot); sub-second and deterministic. Guards the audit §8.3 metric-typography contract: all big data figures ride the shared .metric-large/.report-hero-metric classes, so an ad-hoc font-report-serif + metric-size combo silently re-fragmenting the numerals must fail the gate.",
  "scanPaths": [
    "client/src/pages/publicReport"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4614 — audit §8.3 unified all big data figures across the public
 * report slides onto the shared metric classes (`.metric-large`,
 * `.report-hero-metric` — Montserrat 700 tabular). Serif
 * (`font-report-serif`) is reserved for display/title/verdict copy.
 *
 * Nothing structural prevents a future slide edit from reintroducing an
 * ad-hoc `font-report-serif text-2xl/3xl` metric number. This suite
 * walks every `className` JSX attribute in the slide sources, statically
 * resolves its composed class string (templates, `cn()`/`clsx()` calls,
 * conditionals, `&&`/`||`/`??` chains, and same-file const string
 * variables), and fails when serif co-occurs with a metric-size class on
 * an element that is neither title/display/verdict typography nor one of
 * the explicitly pinned legitimate usages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SLIDES_DIR = path.resolve(process.cwd(), 'client/src/pages/publicReport');

const SERIF_RE = /\bfont-report-serif\b/;

/**
 * Class names that mark an element as display/title/verdict typography —
 * serif is their contract, so any size class alongside them is fine.
 */
const TITLE_CLASS_RE = /\b(?:slide-title|report-display|report-verdict)\b/;

/**
 * The exact serif + large-size elements that are DELIBERATE display
 * typography today (cover firm-name subtitle, state-page heading, top-bar
 * firm name). Element-scoped, not file-scoped: any OTHER serif metric-size
 * element added to these files still fails. Patterns pin the class combo
 * tightly enough that repurposing them for a data figure would not match.
 */
const ALLOWED_ELEMENTS: Array<{ file: string; re: RegExp; note: string }> = [
  {
    file: 'CoverSlide.tsx',
    re: /\btext-xl\b(?=.*\btext-white\/80\b)(?=.*\bfont-report-serif\b)/,
    note: 'cover firm-name subtitle (display copy under the report-display h1)',
  },
  {
    file: 'ReportStatePage.tsx',
    re: /\bfont-report-serif\b(?=.*\btext-2xl\b)(?=.*\bfont-bold\b)(?=.*\btext-report-crimson\b)/,
    note: 'not-found/not-ready state-page heading',
  },
  {
    file: 'ReportTopBar.tsx',
    re: /\bfont-report-serif\b(?=.*\btext-lg\b)(?=.*\bfont-semibold\b)(?=.*\btruncate\b)/,
    note: 'sticky top-bar firm-name line',
  },
];

/**
 * "Metric-size" classes: the Tailwind sizes big enough to read as a data
 * figure (text-lg and up, plus arbitrary text-[__px]/[__rem] at 18px or
 * larger). text-sm/base serif prose (verdict lines, captions, agenda
 * headlines) is legitimate.
 */
function hasMetricSizeClass(s: string): boolean {
  if (/\btext-(?:lg|xl|[2-9]xl)\b/.test(s)) return true;
  for (const m of s.matchAll(/\btext-\[(\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const n = parseFloat(m[1]);
    if ((m[2] === 'px' && n >= 18) || (m[2] === 'rem' && n >= 1.125)) return true;
  }
  return false;
}

// ---------- static className composition resolution ----------

const VARIANT_CAP = 32;

function capJoin(lists: string[][], sep: string): string[] {
  let acc: string[] = [''];
  for (const list of lists) {
    const next: string[] = [];
    for (const a of acc) {
      for (const b of list) {
        next.push(a === '' ? b : `${a}${sep}${b}`);
        if (next.length >= VARIANT_CAP) break;
      }
      if (next.length >= VARIANT_CAP) break;
    }
    acc = next;
  }
  return acc;
}

/**
 * Collect the possible statically-resolvable class strings an expression
 * can produce. Dynamic/unknown parts resolve to '' — this can only make
 * the guard MISS purely runtime-composed combos, never false-positive.
 */
function collectVariants(
  node: ts.Expression,
  constMap: Map<string, ts.Expression>,
  seen: Set<string>,
): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }
  if (ts.isTemplateExpression(node)) {
    const parts: string[][] = [[node.head.text]];
    for (const span of node.templateSpans) {
      parts.push(collectVariants(span.expression, constMap, seen));
      parts.push([span.literal.text]);
    }
    return capJoin(parts, '');
  }
  if (ts.isCallExpression(node)) {
    // cn()/clsx()/twMerge()-style composition: union of argument classes.
    const argLists = node.arguments.map((a) =>
      ts.isExpression(a) ? collectVariants(a, constMap, seen) : [''],
    );
    return argLists.length ? capJoin(argLists, ' ') : [''];
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...collectVariants(node.whenTrue, constMap, seen),
      ...collectVariants(node.whenFalse, constMap, seen),
    ].slice(0, VARIANT_CAP);
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return [
        ...collectVariants(node.left, constMap, seen),
        ...collectVariants(node.right, constMap, seen),
        '',
      ].slice(0, VARIANT_CAP);
    }
    if (op === ts.SyntaxKind.PlusToken) {
      return capJoin(
        [
          collectVariants(node.left, constMap, seen),
          collectVariants(node.right, constMap, seen),
        ],
        '',
      );
    }
    return [''];
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return collectVariants(node.expression, constMap, seen);
  }
  if (ts.isIdentifier(node)) {
    // Same-file const string composition: resolve the initializer once
    // (cycle-guarded) so `const big = "font-report-serif"; className={big + ...}`
    // cannot slip past.
    const init = constMap.get(node.text);
    if (init && !seen.has(node.text)) {
      seen.add(node.text);
      const out = collectVariants(init, constMap, seen);
      seen.delete(node.text);
      return out;
    }
    return [''];
  }
  return [''];
}

function buildConstMap(sf: ts.SourceFile): Map<string, ts.Expression> {
  const map = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (!map.has(node.name.text)) map.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

interface Violation {
  file: string;
  line: number;
  composed: string;
}

interface ScanResult {
  classNameAttrs: number;
  violations: Violation[];
  serifSeen: boolean;
}

function scanSource(fileName: string, source: string): ScanResult {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constMap = buildConstMap(sf);
  const base = path.basename(fileName);
  const allowed = ALLOWED_ELEMENTS.filter((a) => a.file === base);
  const result: ScanResult = { classNameAttrs: 0, violations: [], serifSeen: SERIF_RE.test(source) };

  const checkAttrExpr = (expr: ts.Expression, node: ts.Node) => {
    result.classNameAttrs += 1;
    const variants = collectVariants(expr, constMap, new Set());
    for (const composed of variants) {
      if (!SERIF_RE.test(composed)) continue;
      if (!hasMetricSizeClass(composed)) continue;
      if (TITLE_CLASS_RE.test(composed)) continue;
      if (allowed.some((a) => a.re.test(composed))) continue;
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      result.violations.push({ file: base, line: line + 1, composed });
      break; // one violation per element is enough
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'className' && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) {
        checkAttrExpr(node.initializer, node);
      } else if (
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression &&
        ts.isExpression(node.initializer.expression)
      ) {
        checkAttrExpr(node.initializer.expression, node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
}

// ---------- detector self-tests (prove the negatives EXECUTE) ----------

test('detector self-test: flags serif+metric-size combos in every static composition form', () => {
  const flag = (src: string, file = 'FakeSlide.tsx') => scanSource(file, src).violations.length;

  assert.equal(
    flag('const x = <div className="font-report-serif text-3xl font-bold">{v}</div>;'),
    1,
    'plain string literal',
  );
  assert.equal(
    flag('const x = <div className={`font-report-serif ${tone} text-2xl`}>{v}</div>;'),
    1,
    'template with a dynamic hole between the classes',
  );
  assert.equal(
    flag('const x = <div className={cn("font-report-serif", tone, "text-3xl")}>{v}</div>;'),
    1,
    'cn()/clsx() argument composition',
  );
  assert.equal(
    flag(
      'const serif = "font-report-serif italic";\n' +
        'const x = <div className={`${serif} text-2xl`}>{v}</div>;',
    ),
    1,
    'same-file const string interpolated into the className',
  );
  assert.equal(
    flag('const x = <div className={cond ? "font-report-serif text-3xl" : "metric-large"}>{v}</div>;'),
    1,
    'conditional branch carrying the full combo',
  );
  assert.equal(
    flag('const x = <div className={"font-report-serif " + "text-[28px]"}>{v}</div>;'),
    1,
    'string concatenation + arbitrary px size ≥18',
  );
});

test('detector self-test: legitimate serif typography passes', () => {
  const flag = (src: string, file = 'FakeSlide.tsx') => scanSource(file, src).violations.length;

  assert.equal(
    flag('const x = <h2 className="slide-title font-report-serif text-3xl">T</h2>;'),
    0,
    'slide-title elements keep their serif contract',
  );
  assert.equal(
    flag('const x = <p className="report-verdict font-report-serif text-xl">V.</p>;'),
    0,
    'report-verdict elements keep their serif contract',
  );
  assert.equal(
    flag('const x = <p className="font-report-serif text-sm italic">caption</p>;'),
    0,
    'small serif prose is legitimate',
  );
  assert.equal(
    flag('// never use font-report-serif text-3xl for metrics\nconst x = 1;'),
    0,
    'comments are not class strings (AST walk, not grep)',
  );
  // Serif in one conditional branch, size only in the OTHER branch must
  // not cross-contaminate: branches are separate variants.
  assert.equal(
    flag('const x = <div className={cond ? "font-report-serif" : "text-3xl"}>{v}</div>;'),
    0,
    'classes in mutually exclusive branches never co-occur',
  );
});

test('detector self-test: allow-list is element-scoped, never file-scoped', () => {
  // The pinned CoverSlide subtitle passes…
  const ok = scanSource(
    'CoverSlide.tsx',
    'const x = <div className="text-xl text-white/80 font-report-serif">{firm}</div>;',
  );
  assert.equal(ok.violations.length, 0, 'the pinned cover subtitle element stays allowed');
  // …but a NEW serif metric number in the same allow-listed file fails.
  const bad = scanSource(
    'CoverSlide.tsx',
    'const x = <div className="font-report-serif text-3xl font-bold">{revenue}</div>;',
  );
  assert.equal(
    bad.violations.length,
    1,
    'a non-pinned serif metric element inside an allow-listed file must still fail',
  );
  const badState = scanSource(
    'ReportStatePage.tsx',
    'const x = <div className="font-report-serif text-4xl tabular-nums">{count}</div>;',
  );
  assert.equal(badState.violations.length, 1, 'same for ReportStatePage');
  const badBar = scanSource(
    'ReportTopBar.tsx',
    'const x = <span className={cn("font-report-serif", "text-2xl")}>{n}</span>;',
  );
  assert.equal(badBar.violations.length, 1, 'same for ReportTopBar, through cn()');
});

// ---------- the real scan ----------

test('publicReport slides: no serif + metric-size class outside title/pinned elements', () => {
  const files = fs
    .readdirSync(SLIDES_DIR)
    .filter((f) => f.endsWith('.tsx'))
    .sort();
  // Volume floor: the slide directory has ~20 .tsx files; a collapse here
  // means the scan is misrooted, not that the code is clean.
  assert.ok(files.length >= 10, `expected ≥10 .tsx slide files, saw ${files.length} — scan misrooted?`);

  let totalClassNameAttrs = 0;
  let serifFiles = 0;
  const violations: Violation[] = [];
  for (const f of files) {
    const r = scanSource(f, fs.readFileSync(path.join(SLIDES_DIR, f), 'utf8'));
    totalClassNameAttrs += r.classNameAttrs;
    if (r.serifSeen) serifFiles += 1;
    violations.push(...r.violations);
  }

  // Extraction volume floors — if the AST walk ever silently sees nothing,
  // fail loudly instead of green-lighting an empty scan.
  assert.ok(
    totalClassNameAttrs >= 200,
    `scanned only ${totalClassNameAttrs} className attributes across ${files.length} files — extraction broken?`,
  );
  // The serif class is known-present (cover/state-page/top-bar); zero hits
  // would mean the class was renamed and this guard went blind.
  assert.ok(
    serifFiles >= 1,
    'no font-report-serif usage found anywhere — was the serif class renamed? Update this guard in lockstep.',
  );

  // The pinned allow-list entries must still match a live element; a stale
  // pin means the pattern (or the element) changed and the list needs a
  // matching update, not silent rot.
  for (const a of ALLOWED_ELEMENTS) {
    const src = fs.readFileSync(path.join(SLIDES_DIR, a.file), 'utf8');
    const r = scanSource(a.file, src);
    assert.ok(
      SERIF_RE.test(src),
      `allow-list entry for ${a.file} (${a.note}) is stale — no serif usage left in the file; remove or update the pin`,
    );
    assert.equal(
      r.violations.length,
      0,
      `${a.file}: serif metric-size element no longer matches its pinned allow pattern (${a.note}) — update the pin deliberately or fix the element`,
    );
  }

  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} "${v.composed.trim()}"`),
    [],
    'Serif metric numbers detected. Big data figures must use the shared metric classes ' +
      '(.metric-large / .report-hero-metric — audit §8.3); font-report-serif is reserved for ' +
      'slide-title/report-display/report-verdict typography. Either switch the element to the ' +
      'shared metric classes or, if this is genuinely display/title copy, add the title class ' +
      'or pin it in ALLOWED_ELEMENTS with a justification.',
  );
});
