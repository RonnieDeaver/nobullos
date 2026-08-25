/**
 * lint-single-line-bare-ref-routes.ts
 *
 * Guards against route registrations whose handler is a bare imported
 * reference written on a single line:
 *
 *   // FORBIDDEN — invisible to the route-inventory parser:
 *   app.get("/api/foo", isAuthenticated, importedHandler);
 *
 *   // REQUIRED — stitched correctly by BARE_REF_CLOSE_REGEX:
 *   app.get(
 *     "/api/foo",
 *     isAuthenticated,
 *     importedHandler,
 *   );
 *
 * Background (tests/route-inventory.ts):
 *   ROUTE_REGEX only fires when an inline `(req` / `async (` handler appears
 *   on the same line.  MULTI_LINE_OPEN_REGEX only fires when `app.get(` is
 *   alone on its line.  A single-line registration whose last argument is a
 *   bare identifier satisfies NEITHER pattern, silently vanishing from
 *   tests/route-inventory.json and every downstream audit artifact — including
 *   the freshness lint, which re-runs the same flawed parse.
 *
 * Task #4990 worked around this by using the multi-line form for
 * /api/clients/export.csv.  This lint prevents the next contributor from
 * inadvertently writing the invisible one-line form.
 *
 * Detection:
 *   A line is a violation when it:
 *     (1) Is a complete, single-line `app.METHOD("path", ...)` call — meaning
 *         it contains `app.METHOD(` with a quoted path and closes with `)`
 *         followed optionally by `;` on the SAME line.
 *     (2) Does NOT carry an inline handler — no `async (`, `function (`, or
 *         `(req` after the method and path.
 *     (3) Is not a comment line.
 *   Because the single-line form with an inline handler is already parsed
 *   correctly by ROUTE_REGEX, only the bare-ref variant triggers.
 *
 * Exit 0 = clean; 1 = violations found.
 *
 * Usage: npx tsx scripts/lint-single-line-bare-ref-routes.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROUTES_DIR = "server/routes";
const ROOT_ROUTE_FILE = "server/routes.ts";

/** Matches a single-line complete app.METHOD registration (path + args + closing paren on same line). */
const COMPLETE_SINGLE_LINE_ROUTE =
  /\bapp\.(get|post|put|patch|delete)\(\s*["'`](\/[^"'`]+)["'`].*\)\s*;/;

/** Matches any inline handler signature — these are already handled correctly by ROUTE_REGEX. */
const INLINE_HANDLER = /(?:\basync\s*\(|\bfunction\s*[\w(]|\(\s*req\b)/;

/** Matches `app.METHOD(` alone on a line — the multi-line opener that the stitcher handles. */
const MULTI_LINE_OPEN_ALONE = /^\s*app\.(get|post|put|patch|delete)\(\s*$/;

/** Matches a comment-only line (// …, /* …, or * … inside a block comment). */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

export interface SingleLineBareRefViolation {
  file: string;
  line: number;
  text: string;
}

export interface SingleLineBareRefLintResult {
  ok: boolean;
  violations: SingleLineBareRefViolation[];
}

function collectRouteFiles(dir: string): string[] {
  const files: string[] = [];
  if (existsSync(ROOT_ROUTE_FILE)) {
    files.push(ROOT_ROUTE_FILE);
  }
  if (!existsSync(dir)) return files;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(full.split(/[\\/]/).join("/"));
      }
    }
  };
  walk(dir);
  return files.sort();
}

/** Pure core, unit-testable: scan source lines for single-line bare-ref violations. */
export function runLint(options?: {
  /** Override the list of route files to scan (for fixture testing). */
  routeFiles?: Array<{ path: string; content: string }>;
}): SingleLineBareRefLintResult {
  const violations: SingleLineBareRefViolation[] = [];

  const inputs: Array<{ path: string; content: string }> = options?.routeFiles
    ? options.routeFiles
    : collectRouteFiles(ROUTES_DIR).map((f) => ({
        path: f,
        content: readFileSync(f, "utf-8"),
      }));

  for (const { path: filePath, content } of inputs) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip comment lines.
      if (COMMENT_LINE.test(line)) continue;

      // Skip the multi-line opener form — those are correctly stitched.
      if (MULTI_LINE_OPEN_ALONE.test(line)) continue;

      // If this line is NOT a complete single-line app.METHOD call, skip.
      if (!COMPLETE_SINGLE_LINE_ROUTE.test(line)) continue;

      // If it has an inline handler, ROUTE_REGEX already handles it — skip.
      if (INLINE_HANDLER.test(line)) continue;

      // The line is a complete single-line route with a bare-reference handler.
      violations.push({ file: filePath, line: i + 1, text: line.trim() });
    }
  }

  return { ok: violations.length === 0, violations };
}

export function cliMain(): number {
  const result = runLint();
  if (!result.ok) {
    console.error("");
    console.error(
      "✗ lint-single-line-bare-ref-routes: single-line bare-reference route registration(s) found",
    );
    console.error("");
    console.error(
      "  A route registered as `app.get(\"/path\", mw, importedHandler);` on ONE line",
    );
    console.error(
      "  is invisible to the route-inventory parser: it matches neither ROUTE_REGEX",
    );
    console.error(
      "  (requires an inline handler) nor the multi-line stitcher (requires `app.get(`",
    );
    console.error(
      "  alone on its line). The route silently vanishes from tests/route-inventory.json",
    );
    console.error(
      "  and every downstream audit artifact — with all lints green.",
    );
    console.error("");
    console.error("  Use the multi-line form instead (see server/routes/clients.ts");
    console.error("  around /api/clients/export.csv for an example):");
    console.error("");
    console.error("    app.get(");
    console.error('      "/api/path",');
    console.error("      isAuthenticated,");
    console.error("      importedHandler,");
    console.error("    );");
    console.error("");
    console.error("  Violations:");
    for (const v of result.violations) {
      console.error(`    ${v.file}:${v.line}  ${v.text}`);
    }
    console.error("");
    return 1;
  }
  console.log(
    `lint-single-line-bare-ref-routes: OK (no single-line bare-reference route registrations found in ${ROUTES_DIR})`,
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("lint-single-line-bare-ref-routes.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
