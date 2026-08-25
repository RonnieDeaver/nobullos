/* test-registration
{
  "name": "lint-route-inventory-freshness guard",
  "regression": true,
  "smoke": true,
  "smokeReason": "Freshness guard for the committed API route inventory (tests/route-inventory.json drifted 775 → 1349 routes unnoticed and misled audits with phantom routes). The Validate workflow runs npm run gate, including this lint through gate.ts LINT_CHECKS; this SMOKE_FILES entry adds real-inventory coverage. Fast, DB-free, deterministic (parseRoutes source scan + tmpdir fixtures).",
  "tier": "small"
}
test-registration */
/**
 * Guard test for scripts/lint-route-inventory-freshness.ts.
 *
 * Proves:
 *   1. The REAL committed tests/route-inventory.json matches a fresh
 *      parseRoutes() scan (the actual freshness assertion — if a task adds
 *      or removes routes without regenerating, this fails).
 *   2. Positive control: a fixture inventory with a route removed (phantom)
 *      is flagged as stale, and the message carries the remediation command.
 *   3. A fixture inventory missing a route that exists in code is flagged.
 *   4. Detail-only drift (same route set, changed protection) is flagged.
 *   5. A stale report header count is flagged even when the JSON matches.
 *   6. Duplicate live method+path registrations are flagged (first-wins
 *      shadowing means the later handler is dead code).
 *   7. Wiring lockstep: gate.ts LINT_CHECKS registers the lint and the drift
 *      guard defines `VALIDATION_WORKFLOW` with command `npm run gate`.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint, REMEDIATION } from "../scripts/lint-route-inventory-freshness";
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
    classifications: ["authenticated"],
    hasUpload: false,
    hasRateLimiter: false,
    ...overrides,
  };
}

function writeFixture(
  dir: string,
  committed: RouteEntry[],
  reportCount: number,
): { jsonPath: string; reportPath: string } {
  const jsonPath = join(dir, "route-inventory.json");
  const reportPath = join(dir, "route-inventory-report.md");
  writeFileSync(jsonPath, JSON.stringify(committed, null, 2));
  writeFileSync(
    reportPath,
    `# Route Inventory Report\nGenerated: 2026-01-01T00:00:00.000Z\nTotal routes discovered: ${reportCount}\n`,
  );
  return { jsonPath, reportPath };
}

async function main(): Promise<void> {
  // 1. The real committed inventory is fresh.
  const real = runLint();
  assert(
    real.ok,
    `REAL committed inventory matches a fresh parseRoutes() scan (${real.freshCount} routes)` +
      (real.ok ? "" : ` — problems: ${real.problems.join(" | ")}`),
  );
  assert(real.freshCount > 500, `real scan finds a substantial route count (${real.freshCount} > 500)`);

  const dir = mkdtempSync(join(tmpdir(), "route-inv-lint-"));
  try {
    const fresh = [
      makeRoute({ path: "/api/a" }),
      makeRoute({ path: "/api/b", method: "POST" }),
    ];

    // Baseline fixture passes.
    {
      const { jsonPath, reportPath } = writeFixture(dir, fresh, fresh.length);
      const r = runLint({ freshRoutes: fresh, inventoryJsonPath: jsonPath, inventoryReportPath: reportPath });
      assert(r.ok, "matching fixture inventory passes");
    }

    // 2. Phantom route in committed inventory.
    {
      const committed = [...fresh, makeRoute({ path: "/api/ghost" })];
      const { jsonPath, reportPath } = writeFixture(dir, committed, fresh.length);
      const r = runLint({ freshRoutes: fresh, inventoryJsonPath: jsonPath, inventoryReportPath: reportPath });
      assert(!r.ok, "phantom route in committed inventory is flagged");
      assert(
        r.problems.some((p) => p.includes("phantom") && p.includes("GET /api/ghost")),
        "phantom route named in the problem message",
      );
      assert(
        r.problems.some((p) => p.includes("regen-route-inventory.mjs")),
        "remediation message cites scripts/regen-route-inventory.mjs",
      );
    }

    // 3. Route in code missing from committed inventory.
    {
      const committed = [fresh[0]];
      const { jsonPath, reportPath } = writeFixture(dir, committed, fresh.length);
      const r = runLint({ freshRoutes: fresh, inventoryJsonPath: jsonPath, inventoryReportPath: reportPath });
      assert(
        !r.ok && r.problems.some((p) => p.includes("not in committed inventory") && p.includes("POST /api/b")),
        "route present in code but missing from committed inventory is flagged",
      );
    }

    // 4. Detail-only drift (same route set, protection changed).
    {
      const committed = [
        makeRoute({ path: "/api/a", protection: "public", middleware: [], classifications: ["public"] }),
        fresh[1],
      ];
      const { jsonPath, reportPath } = writeFixture(dir, committed, fresh.length);
      const r = runLint({ freshRoutes: fresh, inventoryJsonPath: jsonPath, inventoryReportPath: reportPath });
      assert(
        !r.ok && r.problems.some((p) => p.includes("entry details drifted")),
        "detail-only drift (changed protection, same route set) is flagged",
      );
    }

    // 5. Stale report header count with fresh JSON.
    {
      const { jsonPath, reportPath } = writeFixture(dir, fresh, 775);
      const r = runLint({ freshRoutes: fresh, inventoryJsonPath: jsonPath, inventoryReportPath: reportPath });
      assert(
        !r.ok && r.problems.some((p) => p.includes("report") && p.includes("775")),
        "stale report header count is flagged even when JSON matches",
      );
    }

    // 6. Duplicate live registrations.
    {
      const dupFresh = [...fresh, makeRoute({ path: "/api/a", line: 99 })];
      const { jsonPath, reportPath } = writeFixture(dir, dupFresh, dupFresh.length);
      const r = runLint({ freshRoutes: dupFresh, inventoryJsonPath: jsonPath, inventoryReportPath: reportPath });
      assert(
        !r.ok && r.problems.some((p) => p.includes("duplicate live registration for GET /api/a")),
        "duplicate live method+path registration is flagged",
      );
    }

    // Sanity: REMEDIATION export matches what the messages embed.
    assert(REMEDIATION.includes("regen-route-inventory.mjs"), "REMEDIATION cites the regen script");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 7. Wiring lockstep.
  {
    const gate = readFileSync("scripts/gate.ts", "utf-8");
    assert(
      gate.includes('"lint-route-inventory-freshness"') &&
        gate.includes("scripts/lint-route-inventory-freshness.ts"),
      "gate.ts LINT_CHECKS registers lint-route-inventory-freshness",
    );
    const drift = readFileSync("scripts/lint-gate-workflow-drift.ts", "utf-8");
    assert(
      /export const VALIDATION_WORKFLOW\s*=\s*\{[\s\S]*?command:\s*"npm run gate"/.test(drift),
      "lint-gate-workflow-drift.ts defines VALIDATION_WORKFLOW with command npm run gate",
    );
  }

  // Cross-check parseRoutes is the same function the lint defaults to (import identity).
  assert(typeof parseRoutes === "function", "parseRoutes importable from tests/route-inventory");

  console.log(`\nlint-route-inventory-freshness guard: passed: ${passed}, failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
