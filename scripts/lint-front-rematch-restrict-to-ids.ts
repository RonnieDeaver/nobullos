/**
 * Pre-deploy lint guard for the test-only `restrictToIds` re-match scoping
 * shortcut (Task #2264).
 *
 * Task #2258 added a `restrictToIds?: string[]` option to the three
 * whole-corpus Front re-match sweeps in
 * `server/services/frontIntegration.ts`:
 *
 *   - rematchAll
 *   - reprocessDismissedNonSpam
 *   - reEvaluateExistingUnmatched
 *
 * It exists PURELY so offline tests can scope a sweep to a handful of seeded
 * ids instead of scanning the dev-DB backlog. When `restrictToIds` is passed
 * the sweep skips BOTH cursor persistence AND the full whole-corpus
 * pagination scan. If a production call site ever passes it, the background
 * sweep would silently process only those ids and never advance — a
 * hard-to-spot correctness bug.
 *
 * This guard fails if any non-test source file passes `restrictToIds` to one
 * of the three sweeps. Detection is two-tier (Task #3807 — the original
 * implementation built a typed Program over the WHOLE tsconfig closure on
 * every run, ~12s, dominating the gate's lint phase):
 *
 *   Tier 1 (fast, always): a text prefilter finds candidate files that even
 *   mention a target sweep name, then a single-file AST parse of just those
 *   candidates classifies every target-call argument. Plain object literals
 *   are decided right there:
 *
 *     rematchAll({ restrictToIds: ids })   → offender
 *     rematchAll({ maxItems, resume })     → clean
 *
 *   Tier 2 (typed, only when needed): any argument the shallow parse cannot
 *   prove clean — an identifier/call-result argument, or an object literal
 *   containing a spread — falls through to the TypeScript *type checker*,
 *   exactly as before. The typed Program is built rooted at ONLY the files
 *   that need it (their import closure), not the whole tsconfig, so the
 *   indirect forms a shallow scan would miss are still caught:
 *
 *     const opts = { restrictToIds: ids }; rematchAll(opts);
 *     rematchAll(getOpts());            // getOpts() returns { restrictToIds }
 *     rematchAll({ ...optsWithRestrict });
 *
 * For every such argument, the guard resolves the argument's type and flags
 * the call if that type carries a `restrictToIds` property. Tests
 * legitimately pass the option, so `*.test.ts` files and the tests/
 * directory are excluded.
 */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import * as ts from "typescript";

// The three sweeps that carry the test-only `restrictToIds` option.
const TARGET_FNS = new Set([
  "rematchAll",
  "reprocessDismissedNonSpam",
  "reEvaluateExistingUnmatched",
  // Task #2637 — the dismissed_operational re-match batch core carries the same
  // test-only `restrictToIds` scoping; production callers must never pass it.
  "rematchDismissedOperationalBatch",
]);

const RESTRICT_PROP = "restrictToIds";

// Roots whose files are scanned for production call sites (relative to repo
// root, posix-normalized). Tests legitimately pass `restrictToIds`.
// Scope intentionally fixed (Task #2846): discovery is driven by the
// TypeScript tsconfig file list (tsconfig include), filtered to these
// production roots precisely to EXCLUDE tests/ — not a directory-walk blind
// spot.
const SCAN_ROOTS = ["server/", "scripts/", "client/src/", "shared/"];

const TSCONFIG = "tsconfig.json";

// This guard file itself names the functions and the property in prose /
// constants, so skip it to avoid self-flagging.
const SELF = "scripts/lint-front-rematch-restrict-to-ids.ts";

// Task #2269: tests/front-rematch-restrict-to-ids.test.ts simulates an
// offender by writing a TEMP fixture file and pointing the lint at it via
// this env var (mirroring `LINT_FRONT_TRIAGE_TARGET`). When set, the guard
// scans exactly that fixture file, bypassing the SCAN_ROOTS filtering — so
// the real source tree is never mutated and a SIGKILL'd test child can't
// leave anything polluted. Any typed Program is built from ONLY the fixture.
const TARGET = process.env.LINT_FRONT_REMATCH_TARGET;

const repoRoot = process.cwd();

const targetAbs = TARGET ? resolve(repoRoot, TARGET) : null;

function posixRel(file: string): string {
  return relative(repoRoot, file).replace(/\\/g, "/");
}

function isScanned(file: string): boolean {
  // Override mode: scan exactly the fixture file the test pointed us at.
  if (targetAbs) return resolve(file) === targetAbs;
  const rel = posixRel(file);
  if (rel === SELF) return false;
  if (rel.includes("node_modules/")) return false;
  // Tests legitimately use the option.
  if (rel.startsWith("tests/")) return false;
  if (/\.test\.tsx?$/.test(rel)) return false;
  return SCAN_ROOTS.some((root) => rel.startsWith(root));
}

// ---------- Detection ----------

type Offender = { file: string; line: number; fn: string; via: string };

function isTargetCallee(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr) && TARGET_FNS.has(expr.text)) return expr.text;
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.name) &&
    TARGET_FNS.has(expr.name.text)
  ) {
    return expr.name.text;
  }
  return null;
}

// True if `type` (or, for a union, any constituent) exposes a
// `restrictToIds` property.
function typeHasRestrict(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.isUnion()) return type.types.some((t) => typeHasRestrict(t, checker));
  return checker.getPropertyOfType(type, RESTRICT_PROP) !== undefined;
}

// ---------- Tier 1: shallow (checker-free) classification ----------

// Verdict of the shallow, single-file classification of one call argument:
//   "offender"  — the argument literally names `restrictToIds`; no checker
//                 needed to condemn it.
//   "clean"     — an object literal whose every property is a plain (non-
//                 spread) assignment with a different name; a checker could
//                 never find `restrictToIds` on it either.
//   "typed"     — cannot be decided without the type checker (identifier /
//                 call-result argument, or a spread inside the literal).
type ShallowVerdict = "offender" | "clean" | "typed";

function classifyArgShallow(arg: ts.Expression): ShallowVerdict {
  if (ts.isObjectLiteralExpression(arg)) {
    let sawSpread = false;
    for (const prop of arg.properties) {
      // { restrictToIds: ... } or shorthand { restrictToIds }
      if (
        (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === RESTRICT_PROP
      ) {
        return "offender";
      }
      // { ...opts } — the spread source's type must be resolved by the checker.
      if (ts.isSpreadAssignment(prop)) sawSpread = true;
    }
    return sawSpread ? "typed" : "clean";
  }
  // Indirect argument: a variable, a function call result, etc. — only the
  // type checker can tell whether its type carries the option.
  return "typed";
}

// Decide whether a single call argument carries `restrictToIds`, with the
// full type checker available (Tier 2). Returns a short label describing HOW
// it was detected, or null if clean.
function argCarriesRestrict(arg: ts.Expression, checker: ts.TypeChecker): string | null {
  if (ts.isObjectLiteralExpression(arg)) {
    for (const prop of arg.properties) {
      if (
        (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === RESTRICT_PROP
      ) {
        return "object literal";
      }
      if (ts.isSpreadAssignment(prop)) {
        const t = checker.getTypeAtLocation(prop.expression);
        if (typeHasRestrict(t, checker)) return "spread into object literal";
      }
    }
    return null;
  }
  const t = checker.getTypeAtLocation(arg);
  if (typeHasRestrict(t, checker)) return "resolved argument type";
  return null;
}

// Walk one parsed source file for target-sweep calls. Object-literal
// arguments are decided immediately; anything else queues the file for the
// typed pass.
function scanFileShallow(
  sf: ts.SourceFile,
  offenders: Offender[],
): boolean {
  let needsTyped = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const fn = isTargetCallee(node.expression);
      if (fn) {
        for (const arg of node.arguments) {
          const verdict = classifyArgShallow(arg);
          if (verdict === "offender") {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            offenders.push({
              file: posixRel(sf.fileName),
              line: line + 1,
              fn,
              via: "object literal",
            });
            break;
          }
          if (verdict === "typed") needsTyped = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return needsTyped;
}

// ---------- Tier 2: typed pass over only the files that need it ----------

function scanFilesTyped(
  files: string[],
  options: ts.CompilerOptions,
  offenders: Offender[],
): void {
  const program = ts.createProgram({ rootNames: files, options });
  const checker = program.getTypeChecker();
  const wanted = new Set(files.map((f) => resolve(f)));
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!wanted.has(resolve(sf.fileName))) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const fn = isTargetCallee(node.expression);
        if (fn) {
          for (const arg of node.arguments) {
            // Object-literal `restrictToIds` offenders were already reported
            // by the shallow pass; only re-examine the checker-dependent
            // shapes so nothing is double-reported.
            if (classifyArgShallow(arg) !== "typed") continue;
            const via = argCarriesRestrict(arg, checker);
            if (via) {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              offenders.push({ file: posixRel(sf.fileName), line: line + 1, fn, via });
              break;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

export function cliMain(): number {
  // ---------- Discover candidate files from tsconfig.json ----------

  const configPath = resolve(repoRoot, TSCONFIG);
  const configRaw = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configRaw.error) {
    console.error(
      `lint-front-rematch-restrict-to-ids: could not read ${TSCONFIG}: ` +
        ts.flattenDiagnosticMessageText(configRaw.error.messageText, "\n"),
    );
    return 2;
  }
  const parsedConfig = ts.parseJsonConfigFileContent(
    configRaw.config,
    ts.sys,
    dirname(configPath),
  );

  // Discovery is driven by the tsconfig file list (same universe the old
  // whole-program pass saw), filtered to production roots, then text-
  // prefiltered: a file that never even mentions a target sweep name cannot
  // contain a call to one.
  const candidateFiles: { fileName: string; text: string }[] = [];
  const discovered = targetAbs ? [targetAbs] : parsedConfig.fileNames;
  const fnNames = [...TARGET_FNS];
  for (const fileName of discovered) {
    if (!isScanned(fileName)) continue;
    let text: string;
    try {
      text = readFileSync(fileName, "utf8");
    } catch {
      continue; // deleted between enumeration and read — nothing to scan
    }
    if (!fnNames.some((fn) => text.includes(fn))) continue;
    candidateFiles.push({ fileName, text });
  }

  // ---------- Tier 1: shallow AST pass over candidates ----------

  const offenders: Offender[] = [];
  const needsTypedFiles: string[] = [];
  for (const { fileName, text } of candidateFiles) {
    const sf = ts.createSourceFile(
      fileName,
      text,
      parsedConfig.options.target ?? ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    if (scanFileShallow(sf, offenders)) needsTypedFiles.push(fileName);
  }

  // ---------- Tier 2: typed pass, only if some call needs the checker ----------

  if (needsTypedFiles.length > 0) {
    scanFilesTyped(needsTypedFiles, parsedConfig.options, offenders);
  }

  // ---------- Report ----------

  if (offenders.length > 0) {
    console.error("");
    console.error("✗ lint-front-rematch-restrict-to-ids: production use of a test-only option");
    console.error("");
    console.error("  `restrictToIds` is a TEST-ONLY scoping shortcut for the whole-corpus");
    console.error("  Front re-match sweeps. Passing it from production code makes the sweep");
    console.error("  skip cursor persistence and the full pagination scan — it will silently");
    console.error("  process only the named ids and never drain the backlog.");
    console.error("");
    console.error("  Offenders:");
    for (const o of offenders) {
      console.error(
        `    ${o.file}:${o.line} passes ${RESTRICT_PROP} to ${o.fn}() (${o.via}). ` +
          `Remove it — production sweeps must scan the whole corpus.`,
      );
    }
    console.error("");
    return 1;
  }

  console.log(
    `lint-front-rematch-restrict-to-ids: OK (type-checked ${SCAN_ROOTS.join(", ")} for ` +
      `${RESTRICT_PROP} passed to ${[...TARGET_FNS].join(" / ")})`,
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-front-rematch-restrict-to-ids.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
