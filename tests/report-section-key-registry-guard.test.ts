/* test-registration
{
  "name": "Report section-key registry guard — every section key written under server/ is in KNOWN_REPORT_SECTION_KEYS (Task #4695)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4695: scripts/verify-report-completeness.ts flags any report_sections.section_key it does not know as an operator-facing 'unknown section key' problem on every dev-refresh sweep. A brand-new section key added anywhere in the server pipeline would surface only as that sweep noise. This AST-based source scan (ts.createSourceFile, no type-check program — fast) collects every section-key value under server/ — sectionKey property writes with either quote style, *_SECTION_KEY(S) constants, sectionKey comparisons, and purgeSlideVerdictKeys call arguments (Task #4902 replaced the mergeSlideVerdictsSection sink), resolving identifier keys through a repo-wide const-string map — and fails at gate time when one is missing from KNOWN_REPORT_SECTION_KEYS. Embedded negative fixtures prove the detectors catch single-quoted and indirect-constant writers. Pure fs scan + one script import: deterministic, no DB.",
  "scanPaths": [
    "server",
    "scripts/verify-report-completeness.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4695 — keep the completeness checker's KNOWN_REPORT_SECTION_KEYS in
 * lockstep with every section-key writer in the server pipeline.
 *
 * AST detectors (per-file ts.createSourceFile walk over server/**\/*.ts(x)):
 *   1. `sectionKey: <expr>` property assignments — writer call sites
 *      (upsertReportSection / direct reportSections .values inserts). The
 *      expr is resolved to string key(s): string literals (any quote style),
 *      no-substitution template literals, ternary branches, and identifiers
 *      resolved through a repo-wide top-level const-string map (so a writer
 *      routing its key through ANY named constant is still collected).
 *   2. `sectionKey ===/!== <literal>` comparisons — reads, but a read of an
 *      unknown key means the same drift.
 *   3. `*_SECTION_KEY` / `*_SECTION_KEYS` const declarations — single string
 *      and string-array key registries.
 *   4. `purgeSlideVerdictKeys(<reportId>, <key>, …)` call sites — the
 *      non-upsert write sink (Task #4902 purge writer, successor of the
 *      deleted mergeSlideVerdictsSection); its 2nd argument is resolved
 *      like (1).
 *
 * Every collected key must be present in KNOWN_REPORT_SECTION_KEYS
 * (scripts/verify-report-completeness.ts). Guards against silent rot:
 *   - embedded negative fixtures (single-quoted literal, indirect constant,
 *     merge-sink call) must each be detected or the test fails;
 *   - a volume floor + known-key pinning fail a scan that matches nothing.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const SERVER_DIR = "server";

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

interface FoundKey {
  file: string;
  via: string;
  key: string;
}

function parse(file: string, src: string): ts.SourceFile {
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function literalOf(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

/** Pass 1: every top-level-reachable `const NAME = "<string>"` in a file. */
function collectConstStrings(sf: ts.SourceFile, into: Map<string, string[]>) {
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = ts.isAsExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      const lit = literalOf(init as ts.Expression);
      if (lit !== null) {
        const arr = into.get(node.name.text) ?? [];
        arr.push(lit);
        into.set(node.name.text, arr);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * Resolve an expression used as a section key into concrete string values.
 * Unresolvable expressions (pass-through variables like `row.sectionKey`,
 * shorthand `sectionKey`) yield [] — they re-route existing keys whose
 * literal origin is collected where it is declared.
 */
function resolveKeyExpr(expr: ts.Expression, consts: Map<string, string[]>): string[] {
  const e = ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)
    ? (expr as ts.AsExpression | ts.ParenthesizedExpression).expression
    : expr;
  const lit = literalOf(e);
  if (lit !== null) return [lit];
  if (ts.isIdentifier(e)) return consts.get(e.text) ?? [];
  if (ts.isConditionalExpression(e)) {
    return [
      ...resolveKeyExpr(e.whenTrue, consts),
      ...resolveKeyExpr(e.whenFalse, consts),
    ];
  }
  return [];
}

/** Pass 2: collect section-key usages from one parsed file. */
function collectFileKeys(
  sf: ts.SourceFile,
  consts: Map<string, string[]>,
  found: FoundKey[],
) {
  const file = sf.fileName;
  const visit = (node: ts.Node) => {
    // Detector 1: `sectionKey: <expr>` property assignment (writers).
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === "sectionKey"
    ) {
      for (const key of resolveKeyExpr(node.initializer, consts)) {
        found.push({ file, via: "sectionKey property", key });
      }
    }
    // Detector 2: `<x>.sectionKey ===/!== <expr>` comparisons.
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const sides = [
        [node.left, node.right],
        [node.right, node.left],
      ] as const;
      for (const [a, b] of sides) {
        const isSectionKeyAccess =
          (ts.isPropertyAccessExpression(a) && a.name.text === "sectionKey") ||
          (ts.isIdentifier(a) && a.text === "sectionKey");
        if (isSectionKeyAccess) {
          for (const key of resolveKeyExpr(b, consts)) {
            found.push({ file, via: "sectionKey comparison", key });
          }
        }
      }
    }
    // Detector 3: *_SECTION_KEY / *_SECTION_KEYS const declarations.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text;
      const init = ts.isAsExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (/_SECTION_KEY$/.test(name)) {
        const lit = literalOf(init as ts.Expression);
        if (lit !== null) found.push({ file, via: name, key: lit });
      } else if (/_SECTION_KEYS$/.test(name) && ts.isArrayLiteralExpression(init)) {
        for (const el of init.elements) {
          const lit = literalOf(el);
          if (lit !== null) found.push({ file, via: name, key: lit });
        }
      }
    }
    // Detector 4: purgeSlideVerdictKeys(reportId, <key>, …) call sites.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : null;
      if (calleeName === "purgeSlideVerdictKeys" && node.arguments.length >= 2) {
        for (const key of resolveKeyExpr(node.arguments[1], consts)) {
          found.push({ file, via: "purgeSlideVerdictKeys arg", key });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function scanSources(sources: Array<{ file: string; src: string }>): FoundKey[] {
  const parsed = sources.map((s) => parse(s.file, s.src));
  const consts = new Map<string, string[]>();
  for (const sf of parsed) collectConstStrings(sf, consts);
  const found: FoundKey[] = [];
  for (const sf of parsed) collectFileKeys(sf, consts, found);
  return found;
}

// ── Detector self-test on embedded negative fixtures: a scan that cannot
// see these shapes must fail here, never silently pass on the real corpus.
function runDetectorFixtures() {
  const fixtures = scanSources([
    {
      file: "fixture-a.ts",
      src: `
        const INDIRECT_KEY = 'fixtureIndirectKey';
        export async function w(storage: any, id: string) {
          await storage.upsertReportSection({ reportId: id, sectionKey: 'fixtureSingleQuoted', data: {} });
          await storage.upsertReportSection({ reportId: id, sectionKey: INDIRECT_KEY, data: {} });
          await storage.purgeSlideVerdictKeys(id, \`fixtureMergeSink\`, [], {});
          if (('' as string) === 'x') return;
        }
        export const FIXTURE_GUARD_SECTION_KEY = "fixtureNamedConst";
      `,
    },
    {
      file: "fixture-b.ts",
      src: `
        export function r(s: { sectionKey: string }) {
          return s.sectionKey === 'fixtureComparedKey';
        }
      `,
    },
  ]);
  const keys = new Set(fixtures.map((f) => f.key));
  for (const expected of [
    "fixtureSingleQuoted",
    "fixtureIndirectKey",
    "fixtureMergeSink",
    "fixtureNamedConst",
    "fixtureComparedKey",
  ]) {
    assert.ok(
      keys.has(expected),
      `detector self-test: fixture key "${expected}" was NOT detected — a detector rotted; fix the scan before trusting the corpus result`,
    );
  }
}

async function main() {
  runDetectorFixtures();

  const { KNOWN_REPORT_SECTION_KEYS } = await import(
    "../scripts/verify-report-completeness"
  );
  const known = new Set<string>(KNOWN_REPORT_SECTION_KEYS);

  const found = scanSources(
    listTsFiles(SERVER_DIR).map((file) => ({
      file,
      src: readFileSync(file, "utf8"),
    })),
  );

  // Volume floor: today's corpus has dozens of hits (the four operator
  // section literals in routes/reports.ts alone appear several times, plus
  // the AI section-key constants and the *_SECTION_KEYS lists). Fewer means
  // the scan root broke — fail loudly rather than pass on an empty scan.
  assert.ok(
    found.length >= 10,
    `section-key scan found only ${found.length} occurrences under ${SERVER_DIR} — detectors or scan root broke (expected ≥ 10)`,
  );

  // Corpus self-test: the scan must see each known writer family.
  for (const expected of [
    "intake",
    "sales",
    "marketing",
    "nextActions",
    "seasonalTrendsAi",
    "slideVerdicts",
  ]) {
    assert.ok(
      found.some((f) => f.key === expected),
      `section-key scan no longer detects "${expected}" anywhere under ${SERVER_DIR} — a detector rotted; fix the scan, don't delete this assert`,
    );
  }

  // Core guard: every section key the server pipeline writes/handles must be
  // known to the completeness checker, or the next dev-refresh sweep flags
  // real rows as "unknown section key" noise.
  const unknown = found.filter((f) => !known.has(f.key));
  const unique = [...new Map(unknown.map((f) => [`${f.file}|${f.key}`, f])).values()];
  assert.deepEqual(
    unique,
    [],
    "Section key(s) used under server/ but missing from KNOWN_REPORT_SECTION_KEYS " +
      "(scripts/verify-report-completeness.ts). Add each new key there — import " +
      "the owning module's *_SECTION_KEY constant so a rename can't drift:\n" +
      unique.map((f) => `  ${f.file}: "${f.key}" (via ${f.via})`).join("\n"),
  );

  console.log(
    `report-section-key-registry-guard: ${found.length} section-key occurrences scanned (AST), ` +
      `${known.size} known keys — OK`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
