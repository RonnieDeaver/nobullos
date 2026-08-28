/* test-registration
{
  "name": "lint-single-line-bare-ref-routes guard",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4995: guards against single-line bare-reference route registrations that silently vanish from the route-inventory parser. The first assertion runs the lint over the REAL server/routes tree, so any new `app.get(\"/path\", mw, importedHandler);` one-liner fails the routine gate instead of silently disappearing from tests/route-inventory.json. The managed Long validation workflow runs the reviewed routine-gate profile, including this lint through gate.ts LINT_CHECKS. Fast, DB-free, deterministic (filesystem scan + in-memory fixtures).",
  "tier": "small"
}
test-registration */
/**
 * Guard test for scripts/lint-single-line-bare-ref-routes.ts.
 *
 * Proves:
 *   1. The REAL server/routes tree has NO single-line bare-ref violations
 *      (the actual live-tree assertion — any new one-liner fails here).
 *   2. A fixture with a single-line bare-ref handler is flagged with the
 *      correct file/line, pointing at the multi-line form.
 *   3. A fixture with an inline async handler on one line is NOT flagged
 *      (ROUTE_REGEX already handles it correctly).
 *   4. A fixture with the sanctioned multi-line form (`app.get(\n  "path",\n
 *      mw,\n  handler,\n);`) is NOT flagged.
 *   5. A comment line that mentions the bare-ref pattern is NOT flagged.
 *   6. A fixture with multiple violations reports all of them.
 *   7. Wiring lockstep: gate.ts LINT_CHECKS registers this lint and
 *      lint-gate-workflow-drift.ts defines `LONG_VALIDATION_WORKFLOW` with the
 *      exact managed Long validation command.
 */

import { readFileSync } from "node:fs";
import { runLint } from "../scripts/lint-single-line-bare-ref-routes";

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

/** Build an in-memory fixture that runLint() accepts. */
function fixture(
  content: string,
  path = "server/routes/fixture.ts",
): Array<{ path: string; content: string }> {
  return [{ path, content }];
}

async function main(): Promise<void> {
  // 1. The real server/routes tree is clean.
  {
    const result = runLint();
    assert(
      result.ok,
      `REAL server/routes tree has no single-line bare-ref violations` +
        (result.ok
          ? ""
          : ` — violations: ${result.violations.map((v) => `${v.file}:${v.line}`).join(", ")}`),
    );
  }

  // 2. A single-line bare-ref handler is flagged.
  {
    const content = [
      `import type { Express } from "express";`,
      `import { isAuthenticated } from "../middlewares/requireAuth";`,
      `import { myHandler } from "./myHandler";`,
      ``,
      `export function registerRoutes(app: Express) {`,
      `  app.get("/api/export.csv", isAuthenticated, myHandler);`,
      `}`,
    ].join("\n");
    const result = runLint({ routeFiles: fixture(content) });
    assert(!result.ok, "single-line bare-ref is flagged as a violation");
    assert(
      result.violations.length === 1,
      `exactly one violation reported (got ${result.violations.length})`,
    );
    assert(
      result.violations[0]?.line === 6,
      `violation reported at line 6 (got ${result.violations[0]?.line})`,
    );
    assert(
      result.violations[0]?.text.includes("myHandler"),
      "violation text includes the bare reference name",
    );
  }

  // 3. An inline async handler on one line is NOT flagged (already parsed by ROUTE_REGEX).
  {
    const content = [
      `export function registerRoutes(app: Express) {`,
      `  app.get("/api/foo", isAuthenticated, async (req, res) => { res.json({}); });`,
      `}`,
    ].join("\n");
    const result = runLint({ routeFiles: fixture(content) });
    assert(
      result.ok,
      "inline async handler on one line is not flagged (ROUTE_REGEX already handles it)",
    );
  }

  // 4. The sanctioned multi-line form is NOT flagged.
  {
    const content = [
      `export function registerRoutes(app: Express) {`,
      `  app.get(`,
      `    "/api/export.csv",`,
      `    isAuthenticated,`,
      `    myHandler,`,
      `  );`,
      `}`,
    ].join("\n");
    const result = runLint({ routeFiles: fixture(content) });
    assert(result.ok, "multi-line bare-ref form (sanctioned) is not flagged");
  }

  // 5. A comment line mentioning the pattern is not flagged.
  {
    const content = [
      `// app.get("/api/foo", isAuthenticated, handler);`,
      `/* app.post("/api/bar", isAuthenticated, handler); */`,
      `export function registerRoutes(app: Express) {`,
      `  app.get(`,
      `    "/api/foo",`,
      `    isAuthenticated,`,
      `    async (req, res) => { res.json({}); },`,
      `  );`,
      `}`,
    ].join("\n");
    const result = runLint({ routeFiles: fixture(content) });
    assert(result.ok, "comment lines containing the pattern are not flagged");
  }

  // 6. Multiple violations are all reported.
  {
    const content = [
      `export function registerRoutes(app: Express) {`,
      `  app.get("/api/a", isAuthenticated, handlerA);`,
      `  app.post("/api/b", isAuthenticated, handlerB);`,
      `  app.delete("/api/c", isAuthenticated, handlerC);`,
      `}`,
    ].join("\n");
    const result = runLint({ routeFiles: fixture(content) });
    assert(!result.ok, "multiple single-line bare-ref violations are all flagged");
    assert(
      result.violations.length === 3,
      `three violations reported (got ${result.violations.length})`,
    );
    const lines = result.violations.map((v) => v.line).sort((a, b) => a - b);
    assert(
      lines[0] === 2 && lines[1] === 3 && lines[2] === 4,
      `violations at lines 2, 3, 4 (got ${lines.join(", ")})`,
    );
  }

  // 7. Wiring lockstep: gate.ts LINT_CHECKS and the managed Long validation workflow command.
  {
    const gate = readFileSync("scripts/gate.ts", "utf-8");
    assert(
      gate.includes('"lint-single-line-bare-ref-routes"') &&
        gate.includes("scripts/lint-single-line-bare-ref-routes.ts"),
      "gate.ts LINT_CHECKS registers lint-single-line-bare-ref-routes",
    );
    const drift = readFileSync("scripts/lint-gate-workflow-drift.ts", "utf-8");
    assert(
      /export const LONG_VALIDATION_WORKFLOW\s*=\s*\{[\s\S]*?command:\s*"npm run validate:long -- --request \.local\/runs\/long-validation-request\.json"/.test(drift),
      "lint-gate-workflow-drift.ts defines LONG_VALIDATION_WORKFLOW with the exact managed Long validation command",
    );
  }

  console.log(
    `\nlint-single-line-bare-ref-routes guard: passed: ${passed}, failed: ${failed}`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
