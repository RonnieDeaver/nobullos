/* test-registration
{
  "name": "lint-route-classification guard",
  "regression": true,
  "smoke": true,
  "smokeReason": "Architecture Governor first-wave guard (Task #4180, extended Task #4209): there is no blanket /api auth guard, so an omitted middleware array ships a PUBLIC route silently. Proves the gate lint fires on a net-new observed-public route without an allow-list entry, and that the real committed allow-list exactly covers the current observed-public set. Also proves check #4: every intentional_public entry must have a detectable caller in client/src or website/ or a documented external_caller. Fast, DB-free, deterministic (parseRoutes source scan + tmpdir fixtures).",
  "tier": "small"
}
test-registration */
/**
 * Guard test for scripts/lint-route-classification.ts.
 *
 * Proves:
 *   1. REAL state: the committed allow-list exactly covers today's
 *      observed-public routes (lint passes against the live tree).
 *   2. Intentional failure: a net-new unauthenticated route ⇒ fail, with the
 *      route named and the L3 remediation attached.
 *   3. Stale allow-list entry (route gained middleware / deleted) ⇒ fail.
 *   4. Duplicate + malformed + unknown-class allow-list entries ⇒ fail.
 *   5. Wiring lockstep: gate.ts LINT_CHECKS registers the lint and the drift
 *      guard defines `VALIDATION_WORKFLOW` with command `npm run gate`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runLint,
  REMEDIATION,
  callerPrefix,
  hasCallerInRoots,
  extractCallerFilePaths,
} from "../scripts/lint-route-classification";
import { parseRoutes, type RouteEntry } from "./route-inventory";

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

function makeRoute(overrides: Partial<RouteEntry>): RouteEntry {
  return {
    method: "GET",
    path: "/api/fixture",
    file: "server/routes/fixture.ts",
    line: 1,
    middleware: ["isAuthenticated"],
    protection: "authenticated",
    authClass: "session",
    classifications: ["authenticated"],
    hasUpload: false,
    hasRateLimiter: false,
    ...overrides,
  };
}

const tmp = mkdtempSync(join(tmpdir(), "route-classification-"));
function writeAllowlist(entries: unknown[]): string {
  const p = join(tmp, `allowlist-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ entries }));
  return p;
}

try {
  // 1. Real committed state.
  const real = runLint();
  assert(
    real.ok,
    `REAL committed allow-list exactly covers the ${real.observedPublicCount} observed-public routes`,
  );
  if (!real.ok) for (const p of real.problems) console.error(`    real problem: ${p}`);

  // 2. Intentional failure: net-new unauthenticated route.
  const freshPublic = makeRoute({
    method: "POST",
    path: "/api/fixture/unauthenticated",
    middleware: [],
    protection: "public",
    authClass: "observed_public",
    classifications: ["public"],
  });
  const emptyAllow = writeAllowlist([]);
  const netNew = runLint({ freshRoutes: [freshPublic], allowlistPath: emptyAllow });
  assert(!netNew.ok, "net-new observed-public route without allow-list entry FAILS");
  assert(
    netNew.problems.some(
      (p) => p.includes("POST /api/fixture/unauthenticated") && p.includes("NET-NEW"),
    ),
    "failure names the offending route",
  );
  assert(REMEDIATION.includes("owner approval"), "remediation states owner approval (L3)");

  // Same route WITH an approved entry passes (external_caller satisfies check #4 for fixture paths).
  const withEntry = writeAllowlist([
    {
      method: "POST",
      path: "/api/fixture/unauthenticated",
      class: "intentional_public",
      reason: "fixture",
      external_caller: "test fixture — no real client caller",
    },
  ]);
  assert(
    runLint({ freshRoutes: [freshPublic], allowlistPath: withEntry }).ok,
    "same route with an owner-approved entry passes",
  );

  // 3. Stale entry: allow-list names a route that is no longer observed-public.
  const sessionRoute = makeRoute({});
  const stale = runLint({ freshRoutes: [sessionRoute], allowlistPath: withEntry });
  assert(
    !stale.ok && stale.problems.some((p) => p.includes("stale allow-list entry")),
    "stale allow-list entry FAILS with shrink-only remediation",
  );

  // 4. Duplicate / malformed / unknown class.
  const dupPath = writeAllowlist([
    { method: "POST", path: "/x", class: "intentional_public", reason: "a" },
    { method: "POST", path: "/x", class: "intentional_public", reason: "b" },
  ]);
  const dup = runLint({
    freshRoutes: [
      makeRoute({
        method: "POST",
        path: "/x",
        middleware: [],
        protection: "public",
        authClass: "observed_public",
      }),
    ],
    allowlistPath: dupPath,
  });
  assert(
    !dup.ok && dup.problems.some((p) => p.includes("duplicate allow-list entry")),
    "duplicate allow-list entries FAIL",
  );
  const badPath = writeAllowlist([
    { method: "GET", path: "/y", class: "not_a_class", reason: "z" },
    { method: "GET", path: "/z" },
  ]);
  const bad = runLint({ freshRoutes: [], allowlistPath: badPath });
  assert(
    !bad.ok &&
      bad.problems.some((p) => p.includes("unknown class")) &&
      bad.problems.some((p) => p.includes("incomplete")),
    "unknown-class and incomplete entries FAIL",
  );

  // Sanity: parser really emits authClass on every route.
  const routes = parseRoutes();
  assert(
    routes.length > 0 && routes.every((r) => typeof r.authClass === "string"),
    "parseRoutes stamps authClass on every route",
  );

  // 5. Check #4: intentional_public caller detection.
  //    Orphaned intentional_public entry (no caller in scan roots, no external_caller) → FAIL.
  const orphanedRoute = makeRoute({
    method: "GET",
    path: "/api/fixture/orphaned",
    middleware: [],
    protection: "public",
    authClass: "observed_public",
    classifications: ["public"],
  });
  const orphanedAllow = writeAllowlist([
    {
      method: "GET",
      path: "/api/fixture/orphaned",
      class: "intentional_public",
      reason: "fixture — no caller",
    },
  ]);
  const orphaned = runLint({
    freshRoutes: [orphanedRoute],
    allowlistPath: orphanedAllow,
    callerScanRoots: [], // empty roots → no caller found
  });
  assert(!orphaned.ok, "orphaned intentional_public entry with no caller FAILS check #4");
  assert(
    orphaned.problems.some(
      (p) =>
        p.includes("GET /api/fixture/orphaned") &&
        p.includes("no detectable caller") &&
        p.includes("external_caller"),
    ),
    "failure message names the route and mentions external_caller",
  );

  //    Same entry with external_caller → PASS.
  const externalCallerAllow = writeAllowlist([
    {
      method: "GET",
      path: "/api/fixture/orphaned",
      class: "intentional_public",
      reason: "fixture",
      external_caller: "test harness external system",
    },
  ]);
  assert(
    runLint({
      freshRoutes: [orphanedRoute],
      allowlistPath: externalCallerAllow,
      callerScanRoots: [], // no scan needed when external_caller is present
    }).ok,
    "intentional_public entry with external_caller passes check #4",
  );

  //    Same entry with caller found in scan roots → PASS.
  const callerDir = join(tmp, "fake-client");
  mkdirSync(callerDir, { recursive: true });
  writeFileSync(
    join(callerDir, "fixture.ts"),
    `apiRequest("/api/fixture/orphaned", { method: "GET" })`,
  );
  assert(
    runLint({
      freshRoutes: [orphanedRoute],
      allowlistPath: orphanedAllow,
      callerScanRoots: [callerDir],
    }).ok,
    "intentional_public entry with caller found in scan roots passes check #4",
  );

  //    callerPrefix helper: exact path (no params) → unchanged.
  assert(
    callerPrefix("/api/health") === "/api/health",
    "callerPrefix: exact path (no params) returns full path",
  );
  //    callerPrefix helper: parameterised path → prefix up to trailing slash.
  assert(
    callerPrefix("/api/book/:slug/recurrence") === "/api/book/",
    "callerPrefix: parameterised path truncates at first param segment",
  );
  assert(
    callerPrefix("/api/ceo-pulse-charts/:monthKey/chart-:index.png") ===
      "/api/ceo-pulse-charts/",
    "callerPrefix: handles multiple param tokens, truncates at first",
  );

  //    hasCallerInRoots: non-existent root → false (no crash).
  assert(
    !hasCallerInRoots("/api/fixture/orphaned", ["/nonexistent-dir"]),
    "hasCallerInRoots: non-existent root returns false without crashing",
  );
  //    hasCallerInRoots: real root with matching file → true.
  assert(
    hasCallerInRoots("/api/fixture/orphaned", [callerDir]),
    "hasCallerInRoots: finds caller in real scan root",
  );

  //    Check #4b (Task #4244): stale external_caller naming a deleted file → FAIL.
  const fakeRepo = join(tmp, "fake-repo");
  mkdirSync(join(fakeRepo, "server", "services"), { recursive: true });
  writeFileSync(
    join(fakeRepo, "server", "services", "liveGenerator.ts"),
    "export {};",
  );
  const fileBackedAllow = (file: string) =>
    writeAllowlist([
      {
        method: "GET",
        path: "/api/fixture/orphaned",
        class: "intentional_public",
        reason: "fixture",
        external_caller: `server-rendered HTML — URLs embedded by ${file}; fetched by the viewer's browser`,
      },
    ]);
  const staleCaller = runLint({
    freshRoutes: [orphanedRoute],
    allowlistPath: fileBackedAllow("server/services/deletedGenerator.ts"),
    callerScanRoots: [],
    externalCallerFileRoot: fakeRepo,
  });
  assert(
    !staleCaller.ok,
    "external_caller naming a DELETED file FAILS check #4b",
  );
  assert(
    staleCaller.problems.some(
      (p) =>
        p.includes("STALE external_caller") &&
        p.includes("server/services/deletedGenerator.ts") &&
        p.includes("GET /api/fixture/orphaned"),
    ),
    "stale external_caller failure names the missing file and the route",
  );
  //    Same annotation naming a file that EXISTS → PASS.
  assert(
    runLint({
      freshRoutes: [orphanedRoute],
      allowlistPath: fileBackedAllow("server/services/liveGenerator.ts"),
      callerScanRoots: [],
      externalCallerFileRoot: fakeRepo,
    }).ok,
    "external_caller naming an existing file passes check #4b",
  );
  //    Prose-only external_caller (no file path) → exempt from #4b, still passes.
  assert(
    runLint({
      freshRoutes: [orphanedRoute],
      allowlistPath: externalCallerAllow,
      callerScanRoots: [],
      externalCallerFileRoot: fakeRepo,
    }).ok,
    "prose-only external_caller (no file path) is exempt from check #4b",
  );

  //    extractCallerFilePaths helper.
  assert(
    extractCallerFilePaths(
      "URLs embedded by resolveChartPlaceholders (server/services/chartImageGenerator.ts); fetched by browser",
    ).join(",") === "server/services/chartImageGenerator.ts",
    "extractCallerFilePaths pulls the repo path out of prose",
  );
  assert(
    extractCallerFilePaths("external partner API").length === 0,
    "extractCallerFilePaths returns nothing for prose-only annotations",
  );
  assert(
    extractCallerFilePaths("a/b.ts and a/b.ts plus c/d.tsx").join(",") ===
      "a/b.ts,c/d.tsx",
    "extractCallerFilePaths dedupes and finds multiple paths",
  );

  //    Real committed state still passes with real scan roots (regression).
  assert(real.ok, "REAL committed state passes check #4 with default scan roots");

  // 6. Wiring lockstep.
  const gate = readFileSync("scripts/gate.ts", "utf-8");
  const drift = readFileSync("scripts/lint-gate-workflow-drift.ts", "utf-8");
  assert(
    gate.includes("scripts/lint-route-classification.ts"),
    "gate.ts LINT_CHECKS registers lint-route-classification",
  );
  assert(
    /export const VALIDATION_WORKFLOW\s*=\s*\{[\s\S]*?command:\s*"npm run gate"/.test(drift),
    "VALIDATION_WORKFLOW uses command npm run gate",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nlint-route-classification guard: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
