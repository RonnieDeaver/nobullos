/**
 * Task #1724 Phase 4.1 — Lint guard against unattributed `getDb()` callers.
 *
 * Background: Task #1721 Phase 1.1 fixed a `notifyUser()` hot path that
 * issued four DB round trips per call without an attribution label, so
 * the slow-query dashboard reported the time against `unknown` and
 * nobody noticed for months. The fix wraps the work in
 * `withDbAttribution("userNotifications:notifyCombined", …)` so the
 * label namespaces in `server/db.ts` can answer "which surface owns
 * this query?".
 *
 * This guard prevents the regression class at **AST callsite**
 * granularity. For every `getDb()` invocation in `server/` and
 * `shared/`, the lint walks the TypeScript AST and asks:
 *
 *     Is this call lexically inside a callback passed to
 *     `withDbAttribution(...)` (or `withDbHoldLabel(...)` /
 *     `setCurrentDbHoldLabel(...)`)?
 *
 * If the answer is yes, the call is *attributed*. If no, it is
 * *unattributed*. Token presence elsewhere in the file does NOT count
 * — a file with `import { withDbAttribution }` but no actual wrap
 * around the `getDb()` call is still unattributed.
 *
 * The baseline (`scripts/lint-getdb-attribution.baseline.txt`) records
 * the allowed number of UNATTRIBUTED `getDb()` call sites per file.
 * The lint fails when:
 *
 *   1. A new file appears that has any unattributed call site and is
 *      not in the baseline.
 *   2. A baselined file's unattributed count exceeds its baselined
 *      number — i.e. a new unattributed call site was added inside an
 *      already-grandfathered file.
 *   3. A baselined file no longer calls `getDb()` (stale entry).
 *
 * Wrap the new call in `withDbAttribution(...)` to make the lint pass
 * without touching the baseline. Bumping a baseline count is the
 * explicit "I checked, this new call also runs inside an
 * already-attributed caller scope" escape hatch.
 *
 * Baseline format: `<path> <count>` per line. Comments (`#`) and
 * blank lines are ignored.
 *
 * Exit code:
 *   0 — every getDb() call site is either attributed, baselined, or
 *       the file is at/under its baselined unattributed count.
 *   1 — at least one new offender, count regression, or stale entry.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// Scope intentionally fixed (Task #2846): getDb() attribution applies to
// production runtime code (server/, shared/); one-off scripts and tests are
// deliberately out of scope for pool-attribution rules.
const DEFAULT_ROOTS = ["server", "shared"];
const DEFAULT_BASELINE_PATH = "scripts/lint-getdb-attribution.baseline.txt";

const WRAP_NAMES = new Set([
  "withDbAttribution",
  "withDbHoldLabel",
  "setCurrentDbHoldLabel",
]);

export interface LintOptions {
  roots: string[];
  baselinePath: string;
}

export interface CallsiteCount {
  /** Total `getDb()` call sites in the file. */
  total: number;
  /** Call sites NOT inside a wrap callback. */
  unattributed: number;
}

export interface LintResult {
  ok: boolean;
  scannedFiles: number;
  baselineSize: number;
  /** New files with at least one unattributed call site. */
  newOffenders: Array<{ file: string; unattributed: number }>;
  /** Baselined files whose unattributed count grew. */
  countRegressions: Array<{
    file: string;
    baselined: number;
    actual: number;
  }>;
  /** Baselined files that no longer call `getDb()`. */
  staleBaseline: string[];
  /** Per-file counts (for diagnostics / baseline seeding). */
  perFile: Map<string, CallsiteCount>;
}

interface BaselineEntry {
  /** Allowed unattributed count, or `null` for "any count" (legacy). */
  count: number | null;
}

function loadBaseline(path: string): Map<string, BaselineEntry> {
  const out = new Map<string, BaselineEntry>();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1) {
      out.set(parts[0], { count: null });
    } else {
      const n = Number(parts[parts.length - 1]);
      const file = parts.slice(0, -1).join(" ");
      out.set(file, { count: Number.isFinite(n) ? n : null });
    }
  }
  return out;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent === "node_modules" || ent.startsWith(".")) continue;
    const full = join(dir, ent);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!full.endsWith(".ts") && !full.endsWith(".tsx")) continue;
    out.push(full);
  }
}

/**
 * Returns true when the callee identifier of `call` is one of the
 * recognised wrap helpers (bare identifier or property access whose
 * rightmost name is a wrap helper, e.g. `db.withDbAttribution`).
 */
function isWrapCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  if (ts.isIdentifier(expr)) return WRAP_NAMES.has(expr.text);
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    return WRAP_NAMES.has(expr.name.text);
  }
  return false;
}

/**
 * A `getDb()` call is "attributed" iff its nearest enclosing wrap-call
 * argument contains it. We walk upward from the call node; if we cross
 * into an Argument of a wrap CallExpression before hitting the source
 * file root, it is attributed.
 */
function isInsideWrapCallback(call: ts.Node): boolean {
  let prev: ts.Node = call;
  let parent: ts.Node | undefined = call.parent;
  while (parent) {
    if (isWrapCall(parent)) {
      const wrapCall = parent as ts.CallExpression;
      // `prev` must be one of the wrap call's arguments (or a
      // descendant thereof — but since we walk one parent at a time,
      // by the time we hit the wrap CallExpression, `prev` is its
      // direct child, which is either the callee `expression` or one
      // of the `arguments`).
      for (const arg of wrapCall.arguments) {
        if (arg === prev) return true;
      }
      // Falling through the callee position (`expression`) means the
      // `getDb()` is being called *as the wrap helper itself*, which
      // shouldn't happen but is definitively not "inside the wrap
      // callback".
      return false;
    }
    prev = parent;
    parent = parent.parent;
  }
  return false;
}

export function analyzeFile(filePath: string, src: string): CallsiteCount {
  if (!src.includes("getDb")) return { total: 0, unattributed: 0 };
  const sf = ts.createSourceFile(
    filePath,
    src,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let total = 0;
  let unattributed = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "getDb" &&
      node.arguments.length === 0
    ) {
      total++;
      if (!isInsideWrapCallback(node)) unattributed++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { total, unattributed };
}

export function runLint(options: LintOptions): LintResult {
  const baseline = loadBaseline(options.baselinePath);
  const files: string[] = [];
  for (const root of options.roots) walk(root, files);

  const perFile = new Map<string, CallsiteCount>();
  const newOffenders: LintResult["newOffenders"] = [];
  const countRegressions: LintResult["countRegressions"] = [];
  const seenInScan = new Set<string>();

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const counts = analyzeFile(file, src);
    if (counts.total === 0) continue;
    perFile.set(file, counts);
    seenInScan.add(file);
    const entry = baseline.get(file);
    if (!entry) {
      if (counts.unattributed > 0) {
        newOffenders.push({ file, unattributed: counts.unattributed });
      }
      continue;
    }
    if (entry.count !== null && counts.unattributed > entry.count) {
      countRegressions.push({
        file,
        baselined: entry.count,
        actual: counts.unattributed,
      });
    }
  }

  const staleBaseline: string[] = [];
  for (const baselined of baseline.keys()) {
    if (!seenInScan.has(baselined)) staleBaseline.push(baselined);
  }

  return {
    ok:
      newOffenders.length === 0 &&
      countRegressions.length === 0 &&
      staleBaseline.length === 0,
    scannedFiles: seenInScan.size,
    baselineSize: baseline.size,
    newOffenders,
    countRegressions,
    staleBaseline,
    perFile,
  };
}

function isMainModule(): boolean {
  try {
    const argv1 = process.argv[1] ?? "";
    return argv1.endsWith("lint-getdb-attribution.ts");
  } catch {
    return false;
  }
}

export function cliMain(argv: string[] = process.argv.slice(2)): number {
  const printCounts = argv.includes("--print-counts");
  const result = runLint({
    roots: DEFAULT_ROOTS,
    baselinePath: DEFAULT_BASELINE_PATH,
  });

  if (printCounts) {
    const sorted = Array.from(result.perFile.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [file, c] of sorted) {
      console.log(`${file} ${c.unattributed} # total=${c.total}`);
    }
    return 0;
  }

  if (result.newOffenders.length > 0) {
    console.error("");
    console.error(
      "✗ lint-getdb-attribution: unattributed getDb() call site(s) in new file(s)",
    );
    console.error("");
    console.error(
      "  Every getDb() call must run inside a withDbAttribution callback",
    );
    console.error(
      "  so the slow-query dashboard can answer 'which surface owns this query?'.",
    );
    console.error(
      "  Importing the helper is not enough — the call site itself must be",
    );
    console.error("  lexically inside the wrap callback.");
    console.error("");
    console.error("  Fix one of two ways:");
    console.error("");
    console.error("    A) Wrap the work in withDbAttribution (preferred):");
    console.error('       import { withDbAttribution } from "../db";');
    console.error(
      '       return withDbAttribution("namespace:name", async () => {',
    );
    console.error("         return getDb().select()...;");
    console.error("       });");
    console.error("");
    console.error(
      "    B) If the caller already establishes a scope (rare — verify in",
    );
    console.error(
      "       routes/middleware/worker/startup) add the file to the baseline:",
    );
    console.error(`       ${DEFAULT_BASELINE_PATH}`);
    console.error("");
    console.error("  Offending files (unattributed call site count):");
    for (const o of result.newOffenders) {
      console.error(`    - ${o.file}  (${o.unattributed})`);
    }
    console.error("");
  }

  if (result.countRegressions.length > 0) {
    console.error("");
    console.error(
      "✗ lint-getdb-attribution: unattributed getDb() count exceeds baseline",
    );
    console.error("");
    console.error(
      "  These files added new unattributed getDb() call sites since baseline.",
    );
    console.error(
      "  Wrap each new call in withDbAttribution(...) — that is almost always",
    );
    console.error(
      "  the right answer; baseline bumps are the escape hatch.",
    );
    console.error("");
    for (const r of result.countRegressions) {
      console.error(
        `    - ${r.file}: baselined=${r.baselined}, actual=${r.actual} (+${r.actual - r.baselined})`,
      );
    }
    console.error("");
  }

  if (result.staleBaseline.length > 0) {
    console.error("");
    console.error(
      "✗ lint-getdb-attribution: stale entries in baseline (no longer call getDb())",
    );
    console.error("");
    console.error(`  Remove these from ${DEFAULT_BASELINE_PATH}:`);
    for (const f of result.staleBaseline) console.error(`    - ${f}`);
    console.error("");
  }

  if (!result.ok) {
    return 1;
  }

  console.log(
    `lint-getdb-attribution: OK (scanned ${DEFAULT_ROOTS.join(", ")}, ${result.scannedFiles} files with getDb(), ${result.baselineSize} baselined)`,
  );
  return 0;
}

if (isMainModule()) {
  process.exit(cliMain());
}
