/**
 * lint-test-fs-scan-inputs.ts (Task #4103)
 *
 * Guards the green-skip/related-selection blindness class fixed for the
 * rate-limit guards in Task #4091: a test that reads its SUBJECT via fs
 * (readFileSync/readdirSync source scans) has inputs invisible to import
 * tracing, so it can stay green-skipped — and never be selected by the
 * related smoke selector — while the code it audits changes.
 *
 * Rule: any test file that (a) calls an fs read API and (b) references a
 * repo-source path literal (server/, client/, shared/, scripts/, migrations/,
 * website/, .replit — including ../-relative forms) must either
 *   - be part of the always-run core (tests/lint-*.test.ts naming or an
 *     explicit DEFAULT_CORE_RULES entry in tests/relatedSmokeSelection.ts), or
 *   - declare every such path in its registration block's "scanPaths" field
 *     (exact file, or an ancestor directory). scanPaths feed both the
 *     related-smoke selector and the green-skip fingerprint.
 *
 * Declared scanPaths must exist on disk — a renamed/deleted subject would
 * otherwise silently rot the declaration.
 *
 * Because a constructed path (path.join, template with variables) is invisible
 * to literal analysis, the rule is CONSERVATIVE: any non-core test file that
 * calls an fs read API must either declare "scanPaths" or carry a file-level
 *   // fs-scan-fixture-only -- <reason>
 * marker asserting it only reads fixtures/tmp/run artifacts — never live repo
 * source. Repo-source literals must additionally be covered by the declared
 * scanPaths.
 *
 * Task #4113 tightening: an fs read call whose path argument contains NO
 * literal text at all (wholly dynamic — variables/config only) could target
 * repo source without any literal appearing in the file, and the fixture-only
 * marker is unverifiable against it. Such calls in a non-core file require
 * declared "scanPaths" or a per-line fs-scan-inputs-ignore justification.
 *
 * Escape hatch for genuine false positives (a repo-source-looking string
 * that is NOT an fs-read target): append
 *   // fs-scan-inputs-ignore -- <reason>
 * to the literal's line.
 *
 * Literals are collected via the TypeScript AST (comments/regexes/dynamic
 * templates are structurally excluded; import/require specifiers skipped —
 * imported modules are visible to import tracing).
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, posix, resolve } from "node:path";
import ts from "typescript";
import { discoverTestFiles, parseRegistration } from "../tests/testRegistry.ts";
import { DEFAULT_CORE_RULES, coreReason, scanPathHit } from "../tests/relatedSmokeSelection.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const FS_READ_RE = /\b(readFileSync|readdirSync|readFile|readdir)\s*\(/;
const REPO_SOURCE_RE = /^(server|client|shared|scripts|migrations|website)\//;
const IGNORE_MARKER = "fs-scan-inputs-ignore";
const FIXTURE_ONLY_MARKER = "fs-scan-fixture-only";

const FS_READ_NAMES = new Set(["readFileSync", "readdirSync", "readFile", "readdir"]);

/**
 * Task #4117: an escape-hatch marker is only valid with a written
 * justification — `// <marker> -- <non-empty reason>`. A bare marker is a
 * rubber-stamp suppression and is rejected outright.
 */
/**
 * Blank out the contents of string/template/regex literals (newlines kept) so
 * marker scans only see markers in real comments/code — not marker TEXT that
 * happens to live inside a test fixture string or an assertion regex.
 */
export function maskLiteralContents(source: string): string {
  const sf = ts.createSourceFile("f.tsx", source, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX);
  const chars = source.split("");
  const blank = (start: number, end: number): void => {
    for (let i = start; i < end; i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddleOrTemplateTail(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      blank(node.getStart(sf), node.getEnd());
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return chars.join("");
}

export function markerHasReason(line: string, marker: string): boolean {
  const idx = line.indexOf(marker);
  if (idx === -1) return false;
  const tail = line.slice(idx + marker.length);
  const m = /^\s*--\s*(\S.*)$/.exec(tail);
  return m !== null;
}

export interface DynamicFsReadCall {
  /** Callee name, e.g. "readFileSync". */
  callee: string;
  /** 1-based line of the call expression's start. */
  line: number;
}

/**
 * Collect fs read CALLS whose path argument contains no literal text at all
 * (no string literal, no-substitution template, or non-empty template chunk
 * anywhere inside the argument expression). Such a wholly dynamic path is
 * invisible to literal analysis — the call could target repo source without
 * any repo-source literal appearing in the file (Task #4113).
 */
export function collectDynamicFsReadCalls(source: string): DynamicFsReadCall[] {
  const sf = ts.createSourceFile("f.tsx", source, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX);
  const out: DynamicFsReadCall[] = [];
  const calleeName = (expr: ts.Expression): string | null => {
    if (ts.isIdentifier(expr) && FS_READ_NAMES.has(expr.text)) return expr.text;
    if (ts.isPropertyAccessExpression(expr) && FS_READ_NAMES.has(expr.name.text)) return expr.name.text;
    return null;
  };
  const hasLiteralText = (node: ts.Node): boolean => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.length > 0;
    if (ts.isTemplateExpression(node)) {
      if (node.head.text.length > 0) return true;
      // template spans' literal chunks count too; fall through to children.
    }
    if (ts.isTemplateMiddleOrTemplateTail(node)) return node.text.length > 0;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && hasLiteralText(child)) found = true;
    });
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const arg = node.arguments[0];
      if (name && arg && !hasLiteralText(arg)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push({ callee: name, line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface FoundLiteral {
  value: string;
  /** 1-based line of the literal's opening quote. */
  line: number;
}

/**
 * Collect plain string literal values from TS/TSX source via the TypeScript
 * AST. Comments, regex literals, and templates with substitutions are
 * structurally excluded; import/export/require specifiers are skipped
 * (imported modules are already visible to import tracing).
 */
export function collectStringLiterals(source: string): FoundLiteral[] {
  const sf = ts.createSourceFile("f.tsx", source, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX);
  const out: FoundLiteral[] = [];
  const isSpecifier = (node: ts.Node): boolean => {
    const p = node.parent;
    if (!p) return false;
    if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === node) return true;
    if (ts.isLiteralTypeNode(p)) return true; // type-position literal, e.g. import("mod") types
    if (ts.isImportTypeNode(p)) return true;
    if (ts.isCallExpression(p) && p.arguments[0] === node) {
      if (p.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
      if (ts.isIdentifier(p.expression) && p.expression.text === "require") return true;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text.length > 0 &&
      !isSpecifier(node)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({ value: node.text, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Normalize a literal to a repo-relative repo-source path, or null. */
export function normalizeRepoSourceLiteral(value: string, testFile: string): string | null {
  let v = value.replace(/^\.\//, "");
  if (v.startsWith("../")) {
    v = posix.normalize(posix.join(posix.dirname(testFile), v));
  }
  if (v === ".replit") return v;
  if (!REPO_SOURCE_RE.test(v)) return null;
  // Require a plausible path (has an extension or is an existing directory);
  // bare prose like "server/boot" IS a real dir — keep it. Skip obvious
  // non-paths (spaces, glob chars, template leftovers).
  if (/[\s*{}()`$]/.test(v)) return null;
  return v;
}

export interface Violation {
  file: string;
  message: string;
}

export function runLint(repoRoot: string = ROOT): { ok: boolean; violations: Violation[]; checked: number } {
  const violations: Violation[] = [];
  const files = discoverTestFiles(undefined, repoRoot);
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(resolve(repoRoot, file), "utf8");
    const lines = source.split("\n");
    const { registration } = parseRegistration(source);
    const scanPaths = registration?.scanPaths;

    // Declared scanPaths must exist regardless of anything else.
    for (const p of scanPaths ?? []) {
      if (!existsSync(resolve(repoRoot, p))) {
        violations.push({
          file,
          message: `declared scanPath "${p}" does not exist — update the registration to the renamed/current path`,
        });
      }
    }

    // Task #4117: escape-hatch markers must carry a written justification.
    // A bare marker (no `-- <reason>` tail) is a violation on its own and
    // never suppresses anything below. Literal contents are masked so marker
    // TEXT inside a fixture string/regex doesn't count.
    const maskedLines = maskLiteralContents(source).split("\n");
    for (const marker of [IGNORE_MARKER, FIXTURE_ONLY_MARKER]) {
      maskedLines.forEach((ln, i) => {
        if (ln.includes(marker) && !markerHasReason(ln, marker)) {
          violations.push({
            file,
            message:
              `bare "${marker}" marker on line ${i + 1} has no justification. ` +
              `Escape hatches must be written as "// ${marker} -- <reason>" with a non-empty reason.`,
          });
        }
      });
    }

    if (!FS_READ_RE.test(source)) continue;
    checked++;

    const literals = collectStringLiterals(source);
    const targets = new Map<string, number>();
    for (const lit of literals) {
      const norm = normalizeRepoSourceLiteral(lit.value, file);
      if (!norm) continue;
      const litLine = maskedLines[lit.line - 1] ?? "";
      if (markerHasReason(litLine, IGNORE_MARKER)) continue;
      if (!targets.has(norm)) targets.set(norm, lit.line);
    }
    if (coreReason(file, DEFAULT_CORE_RULES)) continue; // always-run core

    // Task #4113: an fs read whose path argument carries NO literal text at
    // all is invisible to literal analysis and could target repo source with
    // zero repo-source literals in the file. Such a call needs the file to
    // declare scanPaths, or a per-line ignore justification — the file-level
    // fixture-only marker alone is not enough (it is unverifiable against a
    // wholly dynamic path).
    if (!scanPaths) {
      const dynCalls = collectDynamicFsReadCalls(source).filter(
        (c) => !markerHasReason(maskedLines[c.line - 1] ?? "", IGNORE_MARKER),
      );
      if (dynCalls.length > 0) {
        const list = dynCalls.map((c) => `${c.callee} (line ${c.line})`).join(", ");
        violations.push({
          file,
          message:
            `calls fs read API(s) with a wholly dynamic path argument (no literal text): ${list}. ` +
            `A dynamic path can silently target repo source. Fix: declare the scanned files/dirs in registration ` +
            `"scanPaths", rename the test to tests/lint-*.test.ts if it is a cheap always-run invariant, or append ` +
            `"// ${IGNORE_MARKER} -- <reason>" to the call's line if the path provably never reaches repo source.`,
        });
        continue;
      }
    }

    // Conservative closure: constructed paths (path.join, templates with
    // variables) are invisible to literal analysis, so an fs-reading non-core
    // suite must either declare scanPaths or explicitly assert fixture-only.
    // (When repo-source literals ARE present, fall through to the specific
    // uncovered-targets message below instead.)
    const hasFixtureOnly = maskedLines.some((ln) => markerHasReason(ln, FIXTURE_ONLY_MARKER));
    if (!scanPaths && !hasFixtureOnly && targets.size === 0) {
      violations.push({
        file,
        message:
          `calls an fs read API but is not always-run core, declares no registration "scanPaths", and carries no ` +
          `"// ${FIXTURE_ONLY_MARKER} -- <reason>" marker. If it scans live repo source, declare every scanned ` +
          `file/dir in "scanPaths" (constructed paths too); if it only reads fixtures/tmp/run artifacts, add the marker.`,
      });
      continue;
    }
    if (targets.size === 0) continue; // scanPaths declared or fixture-only asserted, no literals to cover

    const uncovered = [...targets.entries()].filter(([t]) => !scanPathHit(t, scanPaths));
    if (uncovered.length > 0) {
      const list = uncovered.map(([t, ln]) => `${t} (line ${ln})`).join(", ");
      violations.push({
        file,
        message:
          `fs-reads repo source but is not always-run core and does not declare these targets in registration "scanPaths": ${list}. ` +
          `Fix: add them to "scanPaths" (file or ancestor dir), rename the test to tests/lint-*.test.ts, ` +
          `or append "// ${IGNORE_MARKER} -- <reason>" to a genuinely-non-target literal's line.`,
      });
    }
  }
  return { ok: violations.length === 0, violations, checked };
}

/** Gate worker-pool entry (cliMain contract): prints and returns exit code. */
export function cliMain(): number {
  const { ok, violations, checked } = runLint();
  if (ok) {
    console.log(`lint-test-fs-scan-inputs: OK (${checked} fs-reading test file(s) checked)`);
    return 0;
  }
  console.error(`lint-test-fs-scan-inputs: ${violations.length} violation(s)`);
  for (const v of violations) console.error(`  ${v.file}: ${v.message}`);
  return 1;
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  process.exit(cliMain());
}
