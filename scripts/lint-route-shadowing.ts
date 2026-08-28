/**
 * Task #3102 — Catch literal-vs-param Express route shadowing before it
 * ships app-wide.
 *
 * Background: the Sheets last-activity 404 bug happened because the literal
 * route GET /api/sheets/workbooks/last-activity was registered AFTER the
 * parameterized route GET /api/sheets/workbooks/:id. Express matches routes
 * in registration order, so ":id" silently swallowed "last-activity" and the
 * handler looked up a workbook with id "last-activity" → 404. Nothing
 * automated catches this pattern; this lint does.
 *
 * What it flags: within a single file and receiver (e.g. `app` or `router`),
 * a route registration whose path would ALSO match an EARLIER registration
 * on the same HTTP method (or an earlier `.all`) where the earlier path uses
 * a `:param` segment in a position the later path fills with a literal.
 * Registration order wins in Express, so the later, more-specific literal
 * route is unreachable (shadowed).
 *
 * Matching model (conservative, low-false-positive):
 *   - Only string paths starting with "/" are considered routes (so
 *     `map.get("key")` etc. never match). Array paths
 *     (`app.get(["/a/:x", "/b/:x"], ...)`) contribute each element.
 *   - Paths containing regex-ish syntax ("*", "(", ")", "?", "+") are
 *     skipped — we can't reason about them segment-wise.
 *   - Earlier pattern P shadows later path L when they have the same number
 *     of segments and every P segment either equals the L segment or is a
 *     `:param`; at least one position must be param-in-P vs literal-in-L
 *     (identical paths are duplicates, a different bug class, not flagged).
 *
 * Scope: every `server/routes/*.ts` file plus `server/routes.ts` (the
 * registration hub). Fixture mode: pass explicit `files`.
 *
 * Gating: the managed Long validation workflow runs the reviewed routine-gate profile, including
 * this lint through scripts/gate.ts LINT_CHECKS. It is also enforced by tests/lint-route-shadowing.test.ts,
 * whose FIRST assertion runs runLint() against the real tree and which is
 * registered in SMOKE_FILES (see
 * .agents/memory/lint-workflow-limit-smoke-gate.md).
 *
 * Exit codes (CLI mode): 0 — clean; 1 — at least one shadowed route.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SELF = "lint-route-shadowing";

const METHODS = new Set(["get", "post", "put", "patch", "delete", "all"]);

export interface RouteReg {
  file: string;
  line: number;
  receiver: string;
  method: string;
  path: string;
}

export interface Offender {
  file: string;
  line: number;
  method: string;
  path: string;
  shadowedBy: { line: number; path: string };
}

export interface LintResult {
  ok: boolean;
  offenders: Offender[];
  scannedFiles: number;
  routeCount: number;
}

// Extract route registrations like:
//   app.get("/api/x", ...)      router.delete('/y/:id', ...)
//   app.get(["/a/:s", "/b/:s"], ...)
// Receiver is any identifier; non-route calls are filtered out by requiring
// each path string to start with "/".
const CALL_RX =
  /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all)\(\s*(\[[\s\S]*?\]|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`)/g;

const STRING_RX = /["'`]([^"'`\n]*)["'`]/g;

export function extractRoutes(file: string, source: string): RouteReg[] {
  const routes: RouteReg[] = [];
  let m: RegExpExecArray | null;
  CALL_RX.lastIndex = 0;
  while ((m = CALL_RX.exec(source)) !== null) {
    const [, receiver, method, firstArg] = m;
    if (!METHODS.has(method)) continue;
    const line = source.slice(0, m.index).split("\n").length;
    STRING_RX.lastIndex = 0;
    let s: RegExpExecArray | null;
    while ((s = STRING_RX.exec(firstArg)) !== null) {
      const path = s[1];
      if (!path.startsWith("/")) continue;
      routes.push({ file, line, receiver, method, path });
    }
  }
  return routes;
}

function isAnalyzable(path: string): boolean {
  return !/[*()?+]/.test(path);
}

/** Does earlier pattern P (may contain :params) also match later path L,
 *  with at least one param-in-P vs literal-in-L position? */
export function paramPatternShadows(earlier: string, later: string): boolean {
  if (!isAnalyzable(earlier) || !isAnalyzable(later)) return false;
  const p = earlier.split("/").filter(Boolean);
  const l = later.split("/").filter(Boolean);
  if (p.length !== l.length) return false;
  let sawParamVsLiteral = false;
  for (let i = 0; i < p.length; i++) {
    const ps = p[i];
    const ls = l[i];
    if (ps.startsWith(":")) {
      if (!ls.startsWith(":")) sawParamVsLiteral = true;
      continue; // param matches anything
    }
    if (ps !== ls) return false;
  }
  return sawParamVsLiteral;
}

export function findShadowedRoutes(routes: RouteReg[]): Offender[] {
  const offenders: Offender[] = [];
  // Group by file + receiver (registration order only meaningful within one
  // router object in one file).
  const groups = new Map<string, RouteReg[]>();
  for (const r of routes) {
    const key = `${r.file}\u0000${r.receiver}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(r);
  }
  for (const g of groups.values()) {
    for (let i = 0; i < g.length; i++) {
      const later = g[i];
      for (let j = 0; j < i; j++) {
        const earlier = g[j];
        if (earlier.method !== later.method && earlier.method !== "all")
          continue;
        if (paramPatternShadows(earlier.path, later.path)) {
          offenders.push({
            file: later.file,
            line: later.line,
            method: later.method,
            path: later.path,
            shadowedBy: { line: earlier.line, path: earlier.path },
          });
          break; // one report per shadowed route is enough
        }
      }
    }
  }
  return offenders;
}

export function defaultRouteFiles(): string[] {
  const files: string[] = [];
  const dir = "server/routes";
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".ts")) files.push(join(dir, f));
  }
  if (existsSync("server/routes.ts")) files.push("server/routes.ts");
  return files.sort();
}

export function runLint(options?: { files?: string[] }): LintResult {
  const files = options?.files ?? defaultRouteFiles();
  const routes: RouteReg[] = [];
  let scannedFiles = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    scannedFiles++;
    routes.push(...extractRoutes(file, text));
  }
  const offenders = findShadowedRoutes(routes);
  return {
    ok: offenders.length === 0,
    offenders,
    scannedFiles,
    routeCount: routes.length,
  };
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith(`${SELF}.ts`);

if (isMain) {
  const result = runLint();
  if (result.ok) {
    console.log(
      `[${SELF}] OK — ${result.routeCount} route registrations across ${result.scannedFiles} files, no literal-vs-param shadowing.`,
    );
    process.exit(0);
  }
  console.error(
    `[${SELF}] FAILED — ${result.offenders.length} shadowed route(s):`,
  );
  for (const o of result.offenders) {
    console.error(
      `  ${o.file}:${o.line}  ${o.method.toUpperCase()} ${o.path}`,
    );
    console.error(
      `    unreachable: shadowed by earlier ${o.shadowedBy.path} (line ${o.shadowedBy.line})`,
    );
  }
  console.error(
    "\nExpress matches routes in registration order: a literal segment",
  );
  console.error(
    "registered AFTER a :param route on the same prefix is never reached",
  );
  console.error(
    "(the Sheets last-activity 404 bug). Move the literal route ABOVE the",
  );
  console.error("param route.");
  process.exit(1);
}
