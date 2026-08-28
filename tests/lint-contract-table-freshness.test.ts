/* test-registration
{
  "name": "lint-contract-table-freshness guard",
  "regression": true,
  "smoke": true,
  "smokeReason": "Freshness guard for the committed endpoint contract table (audits/D-endpoint-contract-table.{md,json} once rotted ~37 added / 4 removed rows unnoticed, misleading audits). The managed Long validation workflow runs the reviewed routine-gate profile, including this lint through gate.ts LINT_CHECKS; this SMOKE_FILES entry adds real-artifact coverage. Fast, DB-free, deterministic (JSON-vs-JSON comparison + tmpdir fixtures).",
  "tier": "small"
}
test-registration */
/**
 * Guard test for scripts/lint-contract-table-freshness.ts.
 *
 * Proves:
 *   1. The REAL committed audits/D-endpoint-contract-table.{md,json} matches
 *      the committed tests/route-inventory.json (the actual freshness
 *      assertion — if a task changes routes and regenerates the inventory
 *      without regenerating the contract table, this fails).
 *   2. Positive control: a fixture table with a phantom row is flagged, and
 *      the message carries the remediation command.
 *   3. A fixture table missing an inventory route is flagged.
 *   4. Detail-only drift (same route set, handler moved) is flagged.
 *   5. A stale md "Total routes" header is flagged even when the JSON matches.
 *   6. Missing artifacts are flagged.
 *   7. Wiring lockstep: gate.ts LINT_CHECKS registers the lint and the drift
 *      guard defines `LONG_VALIDATION_WORKFLOW` with the exact managed Long validation command.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint, REMEDIATION } from "../scripts/lint-contract-table-freshness";

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

interface FixtureRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  middleware?: string[];
}

function invRoute(
  method: string,
  path: string,
  line = 10,
  middleware: string[] = ["isAuthenticated"],
): FixtureRoute {
  return { method, path, file: "server/routes/fixture.ts", line, middleware };
}

function rowFor(r: FixtureRoute) {
  return {
    method: r.method,
    path: r.path,
    handler: `${r.file}:${r.line}`,
    auth: "session",
    role: "—",
    request: "raw",
    response: "json",
    fe: "—",
    ex: "—",
    classification: "authenticated",
  };
}

function mdFor(rows: ReturnType<typeof rowFor>[], headerCount: number): string {
  const lines = [
    "# Canonical API Endpoint Contract Table",
    "",
    "Generated: 2026-01-01T00:00:00.000Z",
    `Total routes: ${headerCount}`,
    "",
    "## Per-endpoint contract",
    "",
    "| method | path | handler | auth | role | request | response | frontend callers | external callers | classification |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.method} | \`${r.path}\` | ${r.handler} | ${r.auth} | ${r.role} | ${r.request} | ${r.response} | ${r.fe} | ${r.ex} | ${r.classification} |`,
    );
  }
  return lines.join("\n") + "\n";
}

function writeFixture(
  dir: string,
  rows: ReturnType<typeof rowFor>[],
  headerCount: number,
  mdRows?: ReturnType<typeof rowFor>[],
): { contractJsonPath: string; contractMdPath: string } {
  const contractJsonPath = join(dir, "contract-table.json");
  const contractMdPath = join(dir, "contract-table.md");
  writeFileSync(contractJsonPath, JSON.stringify(rows, null, 2));
  writeFileSync(contractMdPath, mdFor(mdRows ?? rows, headerCount));
  return { contractJsonPath, contractMdPath };
}

async function main(): Promise<void> {
  // 1. The real committed contract table is fresh vs the committed inventory.
  const real = runLint();
  assert(
    real.ok,
    `REAL committed contract table matches tests/route-inventory.json (${real.inventoryCount} routes)` +
      (real.ok ? "" : ` — problems: ${real.problems.join(" | ")}`),
  );
  assert(
    real.inventoryCount > 500,
    `inventory has a substantial route count (${real.inventoryCount} > 500)`,
  );

  const dir = mkdtempSync(join(tmpdir(), "contract-table-lint-"));
  try {
    const inventory = [invRoute("GET", "/api/a"), invRoute("POST", "/api/b", 42)];
    const freshRows = inventory.map(rowFor);

    // Baseline fixture passes.
    {
      const { contractJsonPath, contractMdPath } = writeFixture(dir, freshRows, inventory.length);
      const r = runLint({ inventoryRoutes: inventory, contractJsonPath, contractMdPath });
      assert(r.ok, "matching fixture table passes");
    }

    // 2. Phantom row in the table.
    {
      const rows = [...freshRows, rowFor(invRoute("DELETE", "/api/ghost"))];
      const { contractJsonPath, contractMdPath } = writeFixture(dir, rows, inventory.length);
      const r = runLint({ inventoryRoutes: inventory, contractJsonPath, contractMdPath });
      assert(!r.ok, "phantom row in the table is flagged");
      assert(
        r.problems.some((p) => p.includes("phantom") && p.includes("DELETE /api/ghost")),
        "phantom row named in the problem message",
      );
      assert(
        r.problems.some((p) => p.includes("generate-endpoint-contract-table.mjs")),
        "remediation message cites scripts/generate-endpoint-contract-table.mjs",
      );
    }

    // 3. Inventory route missing from the table.
    {
      const rows = [freshRows[0]];
      const { contractJsonPath, contractMdPath } = writeFixture(dir, rows, inventory.length);
      const r = runLint({ inventoryRoutes: inventory, contractJsonPath, contractMdPath });
      assert(
        !r.ok &&
          r.problems.some(
            (p) => p.includes("not in contract table") && p.includes("POST /api/b"),
          ),
        "inventory route missing from the table is flagged",
      );
    }

    // 4. Detail-only drift (same route set, handler line moved).
    {
      const rows = [
        { ...freshRows[0], handler: "server/routes/fixture.ts:999" },
        freshRows[1],
      ];
      const { contractJsonPath, contractMdPath } = writeFixture(dir, rows, inventory.length);
      const r = runLint({ inventoryRoutes: inventory, contractJsonPath, contractMdPath });
      assert(
        !r.ok && r.problems.some((p) => p.includes("handler file:line or row order drifted")),
        "detail-only drift (handler moved, same route set) is flagged",
      );
    }

    // 5. Stale md header count with fresh JSON.
    {
      const { contractJsonPath, contractMdPath } = writeFixture(dir, freshRows, 775);
      const r = runLint({ inventoryRoutes: inventory, contractJsonPath, contractMdPath });
      assert(
        !r.ok && r.problems.some((p) => p.includes("header says 775")),
        "stale md header count is flagged even when JSON matches",
      );
    }

    // 5b. Stale md ROW CONTENT with matching count and fresh JSON — the
    //     md table itself is validated, not just its "Total routes" header.
    {
      const staleMdRows = [
        { ...freshRows[0], handler: "server/routes/fixture.ts:777" },
        freshRows[1],
      ];
      const { contractJsonPath, contractMdPath } = writeFixture(
        dir,
        freshRows,
        inventory.length,
        staleMdRows,
      );
      const r = runLint({ inventoryRoutes: inventory, contractJsonPath, contractMdPath });
      assert(
        !r.ok && r.problems.some((p) => p.includes("table rows are STALE")),
        "stale md row content (handler moved, count unchanged, JSON fresh) is flagged",
      );
    }

    // 5c. md missing an endpoint row with matching header count.
    {
      const { contractJsonPath, contractMdPath } = writeFixture(
        dir,
        freshRows,
        inventory.length,
        [freshRows[0]],
      );
      const r = runLint({ inventoryRoutes: inventory, contractJsonPath, contractMdPath });
      assert(
        !r.ok &&
          r.problems.some(
            (p) => p.includes("missing from md table") && p.includes("POST /api/b"),
          ),
        "inventory row missing from the md table is flagged",
      );
    }

    // 5d. Middleware-only drift (Task #4105): same method/path/handler, but
    //     the inventory's middleware changed (isAuthenticated → requireCeo)
    //     so the table's auth/role/classification columns are stale. This is
    //     exactly the gap the signature comparison alone would miss.
    {
      const ceoInventory = [
        invRoute("GET", "/api/a", 10, ["requireCeo"]),
        inventory[1],
      ];
      const { contractJsonPath, contractMdPath } = writeFixture(dir, freshRows, inventory.length);
      const r = runLint({ inventoryRoutes: ceoInventory, contractJsonPath, contractMdPath });
      assert(
        !r.ok,
        "middleware-only change (same registration line) is flagged",
      );
      assert(
        r.problems.some(
          (p) =>
            p.includes("middleware-derived columns") &&
            p.includes('role is "—", middleware implies "ceo"') &&
            p.includes('classification is "authenticated", middleware implies "admin"'),
        ),
        "stale role and classification cells named in the problem message",
      );
      assert(
        r.problems.filter((p) => p.includes("middleware-derived columns")).length === 2,
        "both the JSON and md artifacts are flagged for middleware drift",
      );
    }

    // 5e. Auth-column drift alone (middleware removed entirely).
    {
      const openInventory = [
        invRoute("GET", "/api/a", 10, []),
        inventory[1],
      ];
      const { contractJsonPath, contractMdPath } = writeFixture(dir, freshRows, inventory.length);
      const r = runLint({ inventoryRoutes: openInventory, contractJsonPath, contractMdPath });
      assert(
        !r.ok &&
          r.problems.some((p) => p.includes('auth is "session", middleware implies "none"')),
        "auth column drift (middleware removed) is flagged",
      );
    }

    // 5f. Truncated md row (Task #4105 review): a row whose trailing cells
    //     (classification, or auth/role onward) were dropped still matches
    //     the method/path/handler signature — it must be flagged as
    //     malformed, never silently skipped.
    {
      const { contractJsonPath, contractMdPath } = writeFixture(dir, freshRows, inventory.length);
      const md = readFileSync(contractMdPath, "utf-8");
      // Drop the final classification cell from the first endpoint row.
      const truncated = md.replace(
        /^(\| GET \| `\/api\/a` \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+ \| [^|]+) \| [^|]+ \|$/m,
        "$1 |",
      );
      assert(truncated !== md, "fixture md row was actually truncated");
      writeFileSync(contractMdPath, truncated);
      const r = runLint({ inventoryRoutes: inventory, contractJsonPath, contractMdPath });
      assert(
        !r.ok && r.problems.some((p) => p.includes("malformed/truncated")),
        "md row missing its classification cell is flagged as malformed, not skipped",
      );
    }

    // 5g. Severely truncated md row (auth cell onward missing).
    {
      const { contractJsonPath, contractMdPath } = writeFixture(dir, freshRows, inventory.length);
      const md = readFileSync(contractMdPath, "utf-8");
      const truncated = md.replace(
        /^(\| GET \| `\/api\/a` \| [^|]+) \|.*$/m,
        "$1 |",
      );
      assert(truncated !== md, "fixture md row was truncated at the auth cell");
      writeFileSync(contractMdPath, truncated);
      const r = runLint({ inventoryRoutes: inventory, contractJsonPath, contractMdPath });
      assert(
        !r.ok && r.problems.some((p) => p.includes("malformed/truncated")),
        "md row truncated from the auth cell onward is flagged as malformed",
      );
    }

    // 6. Missing artifacts.
    {
      const r = runLint({
        inventoryRoutes: inventory,
        contractJsonPath: join(dir, "nope.json"),
        contractMdPath: join(dir, "nope.md"),
      });
      assert(
        !r.ok &&
          r.problems.some((p) => p.includes("nope.json is missing")) &&
          r.problems.some((p) => p.includes("nope.md is missing")),
        "missing contract-table artifacts are flagged",
      );
    }

    // Sanity: REMEDIATION export matches what the messages embed.
    assert(
      REMEDIATION.includes("generate-endpoint-contract-table.mjs"),
      "REMEDIATION cites the generator script",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 7. Wiring lockstep.
  {
    const gate = readFileSync("scripts/gate.ts", "utf-8");
    assert(
      gate.includes('"lint-contract-table-freshness"') &&
        gate.includes("scripts/lint-contract-table-freshness.ts"),
      "gate.ts LINT_CHECKS registers lint-contract-table-freshness",
    );
    const drift = readFileSync("scripts/lint-gate-workflow-drift.ts", "utf-8");
    assert(
    /export const LONG_VALIDATION_WORKFLOW\s*=\s*\{[\s\S]*?command:\s*"npm run validate:long -- --request \.local\/runs\/long-validation-request\.json"/.test(drift),
    "lint-gate-workflow-drift.ts defines LONG_VALIDATION_WORKFLOW with the exact managed Long validation command",
    );
  }

  console.log(`\nlint-contract-table-freshness guard: passed: ${passed}, failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
