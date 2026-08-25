/**
 * Pre-merge lint guard for the broken Postgres array-binding pattern
 * (Task #779, expanded to operational script trees by Task #3944).
 *
 * Task #759 introduced `bindArrayParam` (server/utils/sqlArray.ts) as the
 * single canonical helper for binding a JS array into a Postgres `ANY(...)`
 * lookup. The original bug — using `ANY(${jsArray}::text[])` directly in a
 * Drizzle `sql` template — silently produced "cannot cast type record to
 * text[]" errors and dropped review-decision data for months before anyone
 * noticed.
 *
 * Scope (Task #3944): `server/` + `shared/` (production runtime, original
 * scope) PLUS `scripts/` (operational one-off scripts run against the real
 * database — a broken binding there drops the very rows an operator is
 * trying to remediate). `server/scripts/` is covered via the `server` root.
 * Deliberately excluded: `node_modules/` and dot-directories (vendored),
 * `dist/`/`build/` (generated output), and — by not being listed as roots —
 * `website/public` (committed generator output) and `artifacts/` (separate
 * package with its own package.json). The pre-#3944 "scope intentionally
 * fixed (Task #2846)" carve-out for scripts/ is retired: the two known raw
 * uses it referenced are fixed with `bindArrayParam` in the same change.
 *
 * Task #4303 broadened the guard to the CAST-LESS bare form — `ANY(${arr})`
 * with no `::type[]` cast. Drizzle expands a bare JS array into a
 * parenthesized tuple, so the query executes as `ANY(($1, $2))` — invalid
 * SQL; every non-empty call errors (the Sheets last-activity endpoint
 * shipped this way and 500ed on every library visit). Allowed
 * interpolations inside `ANY(...)`:
 *   - `bindArrayParam(...)` fragments (the canonical helper), and
 *   - pure dotted identifier paths (Drizzle column refs to real Postgres
 *     array columns, e.g. `${actionLogEntries.impactedSystems}`).
 * Everything else is flagged, including variable-held helper results
 * (`const p = bindArrayParam(...); … ANY(${p})`) — textually
 * indistinguishable from a bare array, so inline the helper call at the
 * use site. Known residual: a dotted path to a plain JS array (e.g.
 * `${opts.ids}`) passes the column-ref allowance; the corpus has no such
 * site today and new code should reach for bindArrayParam regardless.
 *
 * False-positive hygiene: comments, ordinary string literals, and regex
 * literals are masked before matching, so documentation that *mentions* the
 * broken shape (like this header, or the lint's own error text) can never
 * trip the lint. Template-literal text is NOT masked — that is exactly
 * where the genuine offenders live (drizzle `sql` templates).
 *
 * `tests/lint-sql-array-bindings.test.ts` (always-core) pins the fixture
 * matrix; `tests/sql-array-binding.test.ts` pins the helper's compile
 * behavior and re-runs this sweep in lockstep via the exports below.
 *
 * Exit code:
 *   0 — no offenders found.
 *   1 — at least one file still uses the broken pattern. The error message
 *       names every offending file and points at the canonical helper.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Match any cast type, not just the current allow-list — a brand-new
// type (e.g. ::date[], ::timestamp[]) is just as broken and we want
// the lint to catch it too.
export const BROKEN = /ANY\(\s*\$\{[^}]+\}\s*::\s*\w+\s*\[\]\s*\)/;

// Cast-less bare form (Task #4303): `ANY(${expr})` with nothing between the
// closing brace and the closing paren. Capture the interpolated expression
// so the allow-rules below can inspect it. (The cast-carrying form above
// never matches this — after `}` it has `::`, not `)`.)
export const BROKEN_BARE = /ANY\(\s*\$\{([^}]*)\}\s*\)/g;

// Allow-rule: a pure dotted identifier path (at least one dot, no calls,
// no operators) is a Drizzle column reference to a real Postgres array
// column — `= ANY(${table.column})` compiles to `= ANY("table"."column")`,
// which is valid SQL.
export const DRIZZLE_COLUMN_REF = /^\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+\s*$/;

/**
 * True when masked source contains either broken array-binding shape:
 * the historical cast-carrying form, or a cast-less `ANY(${…})` whose
 * interpolation is neither a `bindArrayParam(...)` fragment nor a Drizzle
 * column reference.
 */
export function hasBrokenArrayBinding(masked: string): boolean {
  if (BROKEN.test(masked)) return true;
  const bare = new RegExp(BROKEN_BARE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = bare.exec(masked)) !== null) {
    const expr = m[1];
    if (expr.includes("bindArrayParam")) continue;
    if (DRIZZLE_COLUMN_REF.test(expr)) continue;
    return true;
  }
  return false;
}

// Production runtime code plus the operational script trees (Task #3944).
export const ROOTS = ["server", "shared", "scripts"];

// Extensions that exist in the scanned corpus today. The pattern only
// arises in JS/TS sources; .mjs/.cjs/.js are included so an operational
// script written without types is still covered.
export const SCANNED_EXTENSIONS = [".ts", ".tsx", ".mts", ".mjs", ".cjs", ".js"];

// Directory names never descended into: vendored or generated trees.
export const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", "build"]);

const KEYWORDS_BEFORE_REGEX = new Set([
  "return", "typeof", "instanceof", "in", "of", "case", "do", "else",
  "void", "delete", "yield", "await", "new", "throw",
]);

/**
 * Mask comment, ordinary-string, and regex-literal CONTENTS to spaces
 * (newlines preserved) so the broken-pattern regex only sees real code and
 * template-literal text. Template literals stay visible because drizzle
 * `sql` templates are where the defect class lives; their `${...}`
 * interpolations re-enter code mode (nested strings/comments are masked).
 *
 * Regex literals must be masked too: a regex containing a quote character
 * would otherwise flip a naive masker into string mode and swallow real
 * code (see .agents/memory — source-scanner masking lesson).
 */
export function maskSource(src: string): string {
  const out = src.split("");
  const n = src.length;
  // Stack of template-literal expression contexts: each entry tracks brace
  // depth inside a ${ ... } so we know when the template text resumes.
  const exprStack: number[] = [];
  let inTemplate = false;

  let i = 0;
  let prevSig = ""; // previous significant char in code mode
  let prevWord = ""; // previous identifier-ish token in code mode

  const maskChar = (idx: number): void => {
    if (out[idx] !== "\n" && out[idx] !== "\r") out[idx] = " ";
  };

  const regexCanStart = (): boolean => {
    if (prevSig === "") return true;
    if (/[({\[,;:=!&|?+\-*/%^~<>]/.test(prevSig)) return true;
    if (/[A-Za-z0-9_$]/.test(prevSig)) return KEYWORDS_BEFORE_REGEX.has(prevWord);
    return false;
  };

  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : "";

    if (inTemplate) {
      // Template TEXT: keep visible. Watch for end-backtick and ${.
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        inTemplate = false;
        prevSig = "`";
        prevWord = "";
        i++;
        continue;
      }
      if (c === "$" && c2 === "{") {
        exprStack.push(0);
        inTemplate = false;
        prevSig = "{";
        prevWord = "";
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // ---- code mode ----
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") {
        maskChar(i);
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      maskChar(i);
      maskChar(i + 1);
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        maskChar(i);
        i++;
      }
      if (i < n) {
        maskChar(i);
        maskChar(i + 1);
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          maskChar(i);
          maskChar(i + 1);
          i += 2;
          continue;
        }
        if (src[i] === "\n") break; // unterminated — bail at line end
        maskChar(i);
        i++;
      }
      if (i < n && src[i] === quote) i++;
      prevSig = quote;
      prevWord = "";
      continue;
    }
    if (c === "`") {
      inTemplate = true;
      prevSig = "`";
      prevWord = "";
      i++;
      continue;
    }
    if (c === "/" && regexCanStart()) {
      // Regex literal: mask body + flags. Respect \ escapes and [...] classes.
      i++;
      let inClass = false;
      while (i < n) {
        const rc = src[i];
        if (rc === "\\") {
          maskChar(i);
          maskChar(i + 1);
          i += 2;
          continue;
        }
        if (rc === "\n") break; // not a regex after all — stop masking
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        else if (rc === "/" && !inClass) break;
        maskChar(i);
        i++;
      }
      if (i < n && src[i] === "/") {
        i++;
        while (i < n && /[a-z]/i.test(src[i])) {
          maskChar(i);
          i++;
        }
      }
      prevSig = "/";
      prevWord = "";
      continue;
    }
    if (exprStack.length > 0) {
      if (c === "{") exprStack[exprStack.length - 1]++;
      else if (c === "}") {
        if (exprStack[exprStack.length - 1] === 0) {
          exprStack.pop();
          inTemplate = true;
          i++;
          continue;
        }
        exprStack[exprStack.length - 1]--;
      }
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      // accumulate identifier for keyword detection
      let j = i;
      let word = "";
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) {
        word += src[j];
        j++;
      }
      prevWord = word;
      prevSig = src[j - 1];
      i = j;
      continue;
    }
    if (!/\s/.test(c)) {
      prevSig = c;
      prevWord = "";
    }
    i++;
  }
  return out.join("");
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const ent of entries) {
    if (EXCLUDED_DIR_NAMES.has(ent) || ent.startsWith(".")) continue;
    const full = join(dir, ent);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!SCANNED_EXTENSIONS.some((ext) => full.endsWith(ext))) continue;
    // Skip the helper itself — its docstring legitimately documents the
    // broken shape it replaces (belt-and-suspenders; masking already
    // covers comments).
    if (full.endsWith("server/utils/sqlArray.ts")) continue;
    const src = readFileSync(full, "utf8");
    if (hasBrokenArrayBinding(maskSource(src))) out.push(full);
  }
}

export interface SqlArrayLintResult {
  offenders: string[];
  scannedRoots: string[];
}

export function runLint(opts: { cwd?: string; roots?: string[] } = {}): SqlArrayLintResult {
  const roots = opts.roots ?? ROOTS;
  const offenders: string[] = [];
  for (const root of roots) {
    walk(opts.cwd ? join(opts.cwd, root) : root, offenders);
  }
  return { offenders, scannedRoots: roots };
}

export function cliMain(): number {
  const { offenders, scannedRoots } = runLint();

  if (offenders.length > 0) {
    console.error("");
    console.error("✗ lint-sql-array-bindings: broken Postgres array binding detected");
    console.error("");
    console.error("  The pattern  ANY(${arr}::TYPE[])  inside a Drizzle `sql` template");
    console.error("  silently produces \"cannot cast type record to TYPE[]\" at runtime");
    console.error("  and drops the matched rows. The cast-less form  ANY(${arr})  is");
    console.error("  just as broken: Drizzle tuple-expands the bare array, the SQL");
    console.error("  executes as ANY(($1, $2)) and every non-empty call errors.");
    console.error("  Use the canonical helper instead (inline at the use site — a");
    console.error("  variable-held fragment is indistinguishable from a bare array):");
    console.error("");
    console.error("    import { bindArrayParam } from \"server/utils/sqlArray\";");
    console.error("    sql`... WHERE col = ANY(${bindArrayParam(arr, \"text\")})`");
    console.error("");
    console.error("  (Drizzle column refs to Postgres array columns are fine:");
    console.error("   `= ANY(${table.column})` compiles to valid SQL and is allowed.)");
    console.error("");
    console.error("  Offending files:");
    for (const f of offenders) console.error(`    - ${f}`);
    console.error("");
    return 1;
  }

  console.log(`lint-sql-array-bindings: OK (scanned ${scannedRoots.join(", ")}, no offenders)`);
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-sql-array-bindings.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
