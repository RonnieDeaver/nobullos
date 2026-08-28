/* test-registration
{
  "name": "lint-route-shadowing guard (Task #3102)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3102: literal-vs-param route shadowing guard (the Sheets last-activity 404 bug class: a literal segment registered AFTER a :param route on the same method + prefix is unreachable). First assertion runs scripts/lint-route-shadowing.ts over the REAL server/routes tree; positive control re-orders the real sheets.ts routes to prove the original bug would be caught. The managed Long validation workflow runs the reviewed routine-gate profile, including this lint through gate.ts LINT_CHECKS and this SMOKE_FILES coverage. Fast, DB-free, deterministic (static source scan + tmpdir fixtures).",
  "tier": "small"
}
test-registration */
/**
 * Task #3102 — Guard test for scripts/lint-route-shadowing.ts.
 *
 * Background: the Sheets last-activity 404 bug — the literal route
 * GET /api/sheets/workbooks/last-activity registered AFTER
 * GET /api/sheets/workbooks/:id was silently swallowed by :id (Express
 * matches in registration order). The managed Long validation workflow runs
 * the reviewed routine-gate profile; this SMOKE_FILES-gated test's FIRST assertion also runs
 * the lint against the real server/routes tree (see
 * .agents/memory/lint-workflow-limit-smoke-gate.md).
 *
 * Proves:
 *   1. The real route tree passes (no literal-vs-param shadowing) and the
 *      scan covers a substantial number of registrations.
 *   2. Positive control: the REAL server/routes/sheets.ts source, with the
 *      last-activity route moved AFTER the /:id route (the original bug),
 *      IS flagged — i.e. the guard would have caught the shipped bug.
 *   3. A literal route after a param route on the same method + prefix is
 *      flagged, with the shadowing route identified.
 *   4. Correct order (literal first, param after) passes.
 *   5. A different HTTP method does NOT shadow (GET :id doesn't shadow
 *      POST literal), but an earlier `.all` param route DOES shadow.
 *   6. A different prefix / segment count does NOT flag.
 *   7. Array paths (app.get(["/a/:x", ...])) are extracted and can shadow.
 *   8. Non-route .get() calls (map.get("key")) are ignored, and routes are
 *      grouped per receiver (app vs router don't cross-shadow).
 *   9. Deeper param routes shadow deeper literals too
 *      (/x/:id/edit before /x/settings/edit-like shapes).
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractRoutes,
  findShadowedRoutes,
  paramPatternShadows,
  runLint,
} from "../scripts/lint-route-shadowing";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function fixture(files: Record<string, string>): {
  paths: string[];
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "lint-route-shadowing-"));
  const paths: string[] = [];
  for (const [name, contents] of Object.entries(files)) {
    const p = join(root, name);
    writeFileSync(p, contents);
    paths.push(p);
  }
  return { paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// 1. Real route tree passes.
{
  const res = runLint();
  if (!res.ok) {
    for (const o of res.offenders) {
      console.error(
        `    ${o.file}:${o.line} ${o.method.toUpperCase()} ${o.path} shadowed by ${o.shadowedBy.path}`,
      );
    }
  }
  assert(res.ok, "real server/routes tree has no literal-vs-param shadowing");
  assert(
    res.scannedFiles > 30 && res.routeCount > 500,
    `substantial scan (${res.scannedFiles} files, ${res.routeCount} routes)`,
  );
}

// 2. Positive control: the real sheets.ts with last-activity moved AFTER
//    /:id (the original shipped bug) IS flagged.
{
  const real = readFileSync("server/routes/sheets.ts", "utf8");
  const routes = extractRoutes("sheets.ts", real);
  const lastActivity = routes.find(
    (r) => r.path === "/api/sheets/workbooks/last-activity" && r.method === "get",
  );
  const byId = routes.find(
    (r) => r.path === "/api/sheets/workbooks/:id" && r.method === "get",
  );
  assert(!!lastActivity && !!byId, "real sheets.ts still registers both routes");
  assert(
    !!lastActivity && !!byId && lastActivity.line < byId.line,
    "real sheets.ts keeps last-activity BEFORE /:id (the fix holds)",
  );

  // Simulate the original bug by reversing their registration order.
  const reversed = routes.map((r) => {
    if (r === lastActivity) return { ...r, line: byId!.line };
    if (r === byId) return { ...r, line: lastActivity!.line };
    return r;
  });
  reversed.sort((a, b) => a.line - b.line);
  const offenders = findShadowedRoutes(reversed);
  assert(
    offenders.some(
      (o) =>
        o.path === "/api/sheets/workbooks/last-activity" &&
        o.shadowedBy.path === "/api/sheets/workbooks/:id",
    ),
    "positive control: the original last-activity-after-:id ordering is flagged",
  );
}

// 3. Literal after param on same method + prefix is flagged.
{
  const { paths, cleanup } = fixture({
    "bad.ts": [
      'app.get("/api/things/:id", handler);',
      'app.get("/api/things/summary", handler);',
    ].join("\n"),
  });
  try {
    const res = runLint({ files: paths });
    assert(!res.ok, "literal-after-param trips the lint");
    const o = res.offenders[0];
    assert(
      o?.path === "/api/things/summary" &&
        o?.shadowedBy.path === "/api/things/:id" &&
        o?.line === 2 &&
        o?.shadowedBy.line === 1,
      "offender identifies both routes with lines",
    );
  } finally {
    cleanup();
  }
}

// 4. Correct order passes.
{
  const { paths, cleanup } = fixture({
    "good.ts": [
      'app.get("/api/things/summary", handler);',
      'app.get("/api/things/:id", handler);',
      'app.delete("/api/things/:id", handler);',
      'app.patch("/api/things/:id", handler);',
    ].join("\n"),
  });
  try {
    assert(runLint({ files: paths }).ok, "literal-before-param passes");
  } finally {
    cleanup();
  }
}

// 5. Different method does not shadow; earlier .all DOES.
{
  const { paths, cleanup } = fixture({
    "methods.ts": [
      'app.get("/api/x/:id", handler);',
      'app.post("/api/x/refresh", handler);',
    ].join("\n"),
    "all.ts": [
      'app.all("/api/y/:id", handler);',
      'app.get("/api/y/summary", handler);',
    ].join("\n"),
  });
  try {
    const res = runLint({ files: [paths[0]] });
    assert(res.ok, "GET :id does not shadow POST literal");
    const resAll = runLint({ files: [paths[1]] });
    assert(
      !resAll.ok && resAll.offenders[0]?.path === "/api/y/summary",
      "earlier .all param route shadows a later GET literal",
    );
  } finally {
    cleanup();
  }
}

// 6. Different prefix / segment count does not flag.
{
  const { paths, cleanup } = fixture({
    "prefix.ts": [
      'app.get("/api/a/:id", handler);',
      'app.get("/api/b/summary", handler);',
      'app.get("/api/a/:id/notes", handler);',
      'app.get("/api/a/summary/deep/path", handler);',
    ].join("\n"),
  });
  try {
    assert(
      runLint({ files: paths }).ok,
      "different prefixes and segment counts do not flag",
    );
  } finally {
    cleanup();
  }
}

// 7. Array paths are extracted and can shadow.
{
  const { paths, cleanup } = fixture({
    "arrays.ts": [
      'app.get(["/api/book/:slug", "/api/public/booking/:slug"], handler);',
      'app.get("/api/book/latest", handler);',
    ].join("\n"),
  });
  try {
    const res = runLint({ files: paths });
    assert(
      !res.ok && res.offenders[0]?.shadowedBy.path === "/api/book/:slug",
      "array-path param route shadows a later literal",
    );
  } finally {
    cleanup();
  }
}

// 8. Non-route .get() calls ignored; receivers are grouped separately.
{
  const { paths, cleanup } = fixture({
    "noise.ts": [
      'const v = map.get("someKey");',
      'headers.get("content-type");',
      'app.get("/api/z/:id", handler);',
      'router.get("/api/z/summary", handler);',
    ].join("\n"),
  });
  try {
    const res = runLint({ files: paths });
    assert(res.ok, "non-route .get() calls ignored; app vs router don't cross-shadow");
  } finally {
    cleanup();
  }
}

// 9. Deeper shadowing shapes + unit checks on the matcher.
{
  assert(
    paramPatternShadows("/a/:id/edit", "/a/settings/edit"),
    "mid-path param shadows a literal in the same position",
  );
  assert(
    !paramPatternShadows("/a/:id", "/a/:key"),
    "param vs param is not flagged",
  );
  assert(
    !paramPatternShadows("/a/:id", "/a/:id"),
    "identical paths are not flagged",
  );
  assert(
    !paramPatternShadows("/a/*", "/a/literal"),
    "regex-ish wildcard patterns are skipped conservatively",
  );
}

console.log(`\n  passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
