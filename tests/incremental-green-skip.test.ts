/* test-registration
{
  "name": "Incremental green-skip — fingerprints, store safety invariants, sweep cadence (Task #3791)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3791: the green-skip engine decides which suites EXECUTE AT ALL in every run mode; a bug here silently skips real regressions everywhere. Fast, pure fixture-repo test (tmpdir + esbuild trace): no DB, no spawned children, no network. It is also in the always-run core so the skip layer can never skip its own guard.",
  "tier": "medium",
  "tierReason": "The fixture-repository and import-tracing matrix is mechanically small but broad by design; medium reserves enough gate budget for its execution-critical safety coverage."
}
test-registration */
/**
 * Task #3791 — Proves the safety invariants of the incremental test-skip
 * layer (tests/suiteFingerprint.ts) against a throwaway fixture repo:
 *
 *   1. Fingerprints are stable for identical inputs and change when the test
 *      file, its traced closure, global inputs (package.json), or the shim
 *      tree (for extraNodeArgs suites) change. Task #4077: migrations/ is a
 *      per-suite input — it invalidates ONLY DB-backed suites (closure
 *      reaches server/db.ts / tests/hermetic/, or a closure file matches a
 *      DB content marker), never pure suites.
 *   2. A suite with an unresolvable import is never skippable; a whole-trace
 *      failure falls open to executing everything.
 *   3. decideSuite: skip ONLY on a fresh, fingerprint-matching green; force,
 *      core membership, failed verdict, mismatch, and expiry all execute.
 *   4. Full-mode runs execute everything until a genuine full-suite green
 *      exists within the staleness window (predeploy integrity guard).
 *   5. recordRunOutcomes: failures never record green (and overwrite prior
 *      greens); flaky retry-passes record green with the flaky flag; the
 *      full-green stamp; pruning; corrupt/mismatched stores are discarded.
 *   6. Sweep report + scheduler cadence: skippedGreen passthrough, the
 *      unchanged verdict line, weekly full-integrity day selection, and the
 *      exact runner argv for both cadences.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSweepReport,
  buildSweepRunArgs,
  isFullIntegritySweepDate,
  parseSweepReport,
  reportIndicatesFailure,
  summarizeSweepResult,
  type SweepTestResult,
} from "../server/services/regressionSweep";
import { DEFAULT_CORE_RULES, coreReason, type CoreRule } from "./relatedSmokeSelection";
import { buildTestRegistry } from "./testRegistry";
import {
  DEFAULT_GREEN_BASELINE_PATH,
  DEFAULT_GREEN_MAX_AGE_DAYS,
  FINGERPRINT_ALGO_VERSION,
  GREEN_STORE_SCHEMA_VERSION,
  computeSuiteFingerprints,
  POISON_REPEAT_THRESHOLD,
  decideSuite,
  emptyGreenStore,
  extractMigrationTables,
  extractPoisonFromReason,
  formatExecutedSkippedLine,
  formatIncrementalSummary,
  formatRepeatPoisonWarnings,
  fullGreenWithinWindow,
  loadGreenBaseline,
  loadGreenStore,
  planIncrementalRun,
  publishGreenBaseline,
  recordRunOutcomes,
  updateSkipPoisonHistory,
  writeSkipAudit,
  type GreenRecord,
  type SuiteLike,
} from "./suiteFingerprint";

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixture repo
// ---------------------------------------------------------------------------

function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "green-skip-fixture-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests", "helpers"), { recursive: true });
  mkdirSync(join(root, "migrations"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  writeFileSync(join(root, "migrations", "0001_init.sql"), "CREATE TABLE IF NOT EXISTS t (id int);\n");
  writeFileSync(join(root, "src", "util.ts"), "export const util = () => 1;\n");
  writeFileSync(
    join(root, "tests", "a.test.ts"),
    'import { util } from "../src/util";\nif (util() !== 1) throw new Error("no");\n',
  );
  writeFileSync(join(root, "tests", "b.test.ts"), "export const b = 2;\n");
  // Generated-artifact ownership fixture: this guard reads source and output
  // files via fs in production, so those non-import inputs must be fingerprinted.
  mkdirSync(join(root, "server", "routes"), { recursive: true });
  mkdirSync(join(root, "server", "services"), { recursive: true });
  mkdirSync(join(root, "client", "src"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "audits"), { recursive: true });
  mkdirSync(join(root, "audits", "governance"), { recursive: true });
  writeFileSync(join(root, "server", "routes.ts"), "export const routes = [];\n");
  writeFileSync(join(root, "server", "routes", "fixture.ts"), "export const route = 1;\n");
  writeFileSync(join(root, "tests", "route-inventory.ts"), "export const parse = () => [];\n");
  writeFileSync(
    join(root, "scripts", "regen-route-inventory.mjs"),
    'const outputs = ["tests/route-inventory.json", "tests/route-inventory-report.md"];\n',
  );
  writeFileSync(
    join(root, "scripts", "lint-route-inventory-freshness.ts"),
    'const outputs = ["tests/route-inventory.json", "tests/route-inventory-report.md"];\n',
  );
  writeFileSync(
    join(root, "scripts", "generate-endpoint-contract-table.mjs"),
    'const outputs = ["audits/D-endpoint-contract-table.md", "audits/D-endpoint-contract-table.json"];\n',
  );
  writeFileSync(join(root, "scripts", "contract-table-classifiers.mjs"), "export {};\n");
  writeFileSync(
    join(root, "scripts", "generate-test-portfolio-baseline.ts"),
    'const output = "audits/governance/test-portfolio-baseline.json";\n',
  );
  writeFileSync(join(root, "scripts", "governanceInventoryLib.ts"), "export const stable = true;\n");
  writeFileSync(join(root, "tests", "testRegistry.ts"), "export const registry = true;\n");
  writeFileSync(
    join(root, "scripts", "lint-contract-table-freshness.ts"),
    'const outputs = ["audits/D-endpoint-contract-table.md", "audits/D-endpoint-contract-table.json"];\n',
  );
  writeFileSync(join(root, "tests", "route-inventory.json"), "[]\n");
  writeFileSync(join(root, "tests", "route-inventory-report.md"), "# fixture\n");
  writeFileSync(join(root, "tests", "lint-route-inventory-freshness.test.ts"), "export {};\n");
  writeFileSync(join(root, "tests", "post-merge-route-inventory-refresh.test.ts"), "export {};\n");
  writeFileSync(join(root, "tests", "lint-contract-table-freshness.test.ts"), "export {};\n");
  writeFileSync(join(root, "tests", "post-merge-generated-artifact-refresh.test.ts"), "export {};\n");
  writeFileSync(join(root, "tests", "governance-test-portfolio-baseline.test.ts"), "export {};\n");
  writeFileSync(join(root, "audits", "D-endpoint-contract-table.json"), "[]\n");
  writeFileSync(join(root, "audits", "D-endpoint-contract-table.md"), "# fixture\n");
  writeFileSync(join(root, "audits", "governance", "test-portfolio-baseline.json"), '{"facts":{}}\n');
  writeFileSync(join(root, "client", "src", "contract-caller.tsx"), "export const caller = 'client';\n");
  writeFileSync(join(root, "scripts", "contract-caller.mjs"), "export const caller = 'script';\n");
  writeFileSync(join(root, "tests", "contract-caller.test.ts"), "export const caller = 'test';\n");
  writeFileSync(join(root, "server", "services", "contract-caller.ts"), "export const caller = 'service';\n");
  // DB-flavored pair (Task #4077): db.test.ts reaches a file that reads
  // process.env.DATABASE_URL — a DB content marker — so it (and only it)
  // is migration-sensitive.
  writeFileSync(join(root, "src", "dbClient.ts"), 'export const dbUrl = () => process.env.DATABASE_URL ?? "";\n');
  writeFileSync(
    join(root, "tests", "db.test.ts"),
    'import { dbUrl } from "../src/dbClient";\nif (typeof dbUrl() !== "string") throw new Error("no");\n',
  );
  // Loader shim pair: setup.mjs is a registered entry; stub.mjs is referenced
  // only by STRING inside it (invisible to import tracing) — exactly the
  // pattern the shim-tree hash exists for.
  writeFileSync(join(root, "tests", "helpers", "setup.mjs"), 'const stub = "./stub.mjs";\nexport {};\n');
  writeFileSync(join(root, "tests", "helpers", "stub.mjs"), "export const stubbed = true;\n");
  // Task #4503 per-table scoping fixtures: a pgTable-defining schema module,
  // a DAO that references ONE table's export identifier (plus the
  // DATABASE_URL sensitivity marker), and a suite reaching it.
  writeFileSync(
    join(root, "src", "schema.ts"),
    'const pgTable = (name: string, cols: Record<string, unknown>) => ({ name, cols });\n' +
      'export const widgetRows = pgTable("widget_rows", {});\n' +
      'export const gadgetRows = pgTable("gadget_rows", {});\n',
  );
  writeFileSync(
    join(root, "src", "widgetsDao.ts"),
    'import { widgetRows } from "./schema";\nexport const listWidgets = () => [widgetRows, process.env.DATABASE_URL];\n',
  );
  writeFileSync(
    join(root, "tests", "widgets.test.ts"),
    'import { listWidgets } from "../src/widgetsDao";\nif (listWidgets().length !== 2) throw new Error("no");\n',
  );
  return root;
}

const SUITE_A: SuiteLike = { file: "tests/a.test.ts" };
const SUITE_B: SuiteLike = {
  file: "tests/b.test.ts",
  extraNodeArgs: ["--import", "./tests/helpers/setup.mjs"],
  timeoutMs: 60_000,
};
const SUITE_DB: SuiteLike = { file: "tests/db.test.ts" };
const SUITE_WIDGETS: SuiteLike = { file: "tests/widgets.test.ts" };
const SUITE_ROUTE_INVENTORY_OWNER: SuiteLike = { file: "tests/lint-route-inventory-freshness.test.ts" };
const SUITE_CONTRACT_TABLE_OWNER: SuiteLike = { file: "tests/lint-contract-table-freshness.test.ts" };
const SUITE_TEST_PORTFOLIO_OWNER: SuiteLike = { file: "tests/governance-test-portfolio-baseline.test.ts" };
const NO_CORE: CoreRule[] = [];
const NOW = new Date("2026-08-05T12:00:00.000Z");

async function fingerprintsFor(root: string, suites: SuiteLike[]): Promise<Map<string, string | null>> {
  const comp = await computeSuiteFingerprints(suites, root);
  assert.equal(comp.ok, true, `computation ok (got error: ${comp.error})`);
  const out = new Map<string, string | null>();
  for (const [file, info] of comp.bySuite) {
    assert.equal(info.unskippableReason, null, `${file} should be skippable, got: ${info.unskippableReason}`);
    out.set(file, info.fingerprint);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Fingerprint stability + change detection
// ---------------------------------------------------------------------------

test("fingerprints are stable across recomputation on identical inputs", async () => {
  const root = makeFixtureRepo();
  try {
    const first = await fingerprintsFor(root, [SUITE_A, SUITE_B]);
    const second = await fingerprintsFor(root, [SUITE_A, SUITE_B]);
    assert.ok(first.get("tests/a.test.ts"), "A has a fingerprint");
    assert.ok(first.get("tests/b.test.ts"), "B has a fingerprint");
    assert.deepEqual([...first.entries()].sort(), [...second.entries()].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("editing a traced closure file changes ONLY the suites that reach it", async () => {
  const root = makeFixtureRepo();
  try {
    const before = await fingerprintsFor(root, [SUITE_A, SUITE_B]);
    writeFileSync(join(root, "src", "util.ts"), "export const util = () => 2;\n");
    const after = await fingerprintsFor(root, [SUITE_A, SUITE_B]);
    assert.notEqual(after.get("tests/a.test.ts"), before.get("tests/a.test.ts"), "A imports util → changed");
    assert.equal(after.get("tests/b.test.ts"), before.get("tests/b.test.ts"), "B does not import util → unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated artifact ownership inputs invalidate the owning guard fingerprint", async () => {
  const root = makeFixtureRepo();
  try {
    const before = await fingerprintsFor(root, [SUITE_ROUTE_INVENTORY_OWNER]);
    writeFileSync(join(root, "server", "routes", "fixture.ts"), "export const route = 2;\n");
    const afterSource = await fingerprintsFor(root, [SUITE_ROUTE_INVENTORY_OWNER]);
    assert.notEqual(
      afterSource.get(SUITE_ROUTE_INVENTORY_OWNER.file),
      before.get(SUITE_ROUTE_INVENTORY_OWNER.file),
      "declared route source must invalidate its fs-reading guard",
    );
    writeFileSync(join(root, "tests", "route-inventory.json"), '[{"path":"/fixture"}]\n');
    const afterArtifact = await fingerprintsFor(root, [SUITE_ROUTE_INVENTORY_OWNER]);
    assert.notEqual(
      afterArtifact.get(SUITE_ROUTE_INVENTORY_OWNER.file),
      afterSource.get(SUITE_ROUTE_INVENTORY_OWNER.file),
      "a regenerated output must also invalidate the owning guard",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all endpoint contract-table filesystem inputs invalidate its owning guard fingerprint", async () => {
  const root = makeFixtureRepo();
  try {
    let before = await fingerprintsFor(root, [SUITE_CONTRACT_TABLE_OWNER]);
    for (const [label, rel, replacement] of [
      ["client caller", "client/src/contract-caller.tsx", "export const caller = 'client-next';\n"],
      ["script caller", "scripts/contract-caller.mjs", "export const caller = 'script-next';\n"],
      ["test caller", "tests/contract-caller.test.ts", "export const caller = 'test-next';\n"],
      ["service caller", "server/services/contract-caller.ts", "export const caller = 'service-next';\n"],
      ["route handler", "server/routes/fixture.ts", "export const route = 2;\n"],
    ] as const) {
      writeFileSync(join(root, rel), replacement);
      const after = await fingerprintsFor(root, [SUITE_CONTRACT_TABLE_OWNER]);
      assert.notEqual(
        after.get(SUITE_CONTRACT_TABLE_OWNER.file),
        before.get(SUITE_CONTRACT_TABLE_OWNER.file),
        `${label} must invalidate its filesystem-reading contract-table guard`,
      );
      before = after;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("test-portfolio generator inputs and output invalidate its owning guard fingerprint", async () => {
  const root = makeFixtureRepo();
  try {
    const before = await fingerprintsFor(root, [SUITE_TEST_PORTFOLIO_OWNER]);
    writeFileSync(join(root, "scripts", "governanceInventoryLib.ts"), "export const stable = false;\n");
    const afterGeneratorInput = await fingerprintsFor(root, [SUITE_TEST_PORTFOLIO_OWNER]);
    assert.notEqual(
      afterGeneratorInput.get(SUITE_TEST_PORTFOLIO_OWNER.file),
      before.get(SUITE_TEST_PORTFOLIO_OWNER.file),
      "governance-inventory helper must invalidate the portfolio freshness guard",
    );
    writeFileSync(
      join(root, "audits", "governance", "test-portfolio-baseline.json"),
      '{"facts":{"updated":true}}\n',
    );
    const afterArtifact = await fingerprintsFor(root, [SUITE_TEST_PORTFOLIO_OWNER]);
    assert.notEqual(
      afterArtifact.get(SUITE_TEST_PORTFOLIO_OWNER.file),
      afterGeneratorInput.get(SUITE_TEST_PORTFOLIO_OWNER.file),
      "a regenerated portfolio output must invalidate its owning guard",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweep reports retain the aggregate task-gate rail proof", () => {
  const taskGateRailProof = {
    directAffected: { selected: 1, executed: 1, skippedGreen: 0, deferred: 0 },
    core: { selected: 2, executed: 2, skippedGreen: 0, deferred: 0 },
  };
  const report = buildSweepReport([sweepResult({})], {
    ...SWEEP_META,
    taskGateRailProof,
  });
  assert.deepEqual(
    report.taskGateRailProof,
    taskGateRailProof,
    "the private bounded-gate receipt needs the runner's aggregate rail accounting",
  );
});

test("editing a string-referenced loader stub re-fingerprints extraNodeArgs suites via the shim tree", async () => {
  const root = makeFixtureRepo();
  try {
    const before = await fingerprintsFor(root, [SUITE_A, SUITE_B]);
    writeFileSync(join(root, "tests", "helpers", "stub.mjs"), "export const stubbed = false;\n");
    const after = await fingerprintsFor(root, [SUITE_A, SUITE_B]);
    assert.notEqual(after.get("tests/b.test.ts"), before.get("tests/b.test.ts"), "B has extraNodeArgs → shim tree applies");
    assert.equal(after.get("tests/a.test.ts"), before.get("tests/a.test.ts"), "A has no extraNodeArgs → unaffected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package.json invalidates every suite; migrations invalidate ONLY DB-backed suites", async () => {
  const root = makeFixtureRepo();
  try {
    const before = await fingerprintsFor(root, [SUITE_A, SUITE_B, SUITE_DB]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.1" }));
    const afterPkg = await fingerprintsFor(root, [SUITE_A, SUITE_B, SUITE_DB]);
    assert.notEqual(afterPkg.get("tests/a.test.ts"), before.get("tests/a.test.ts"));
    assert.notEqual(afterPkg.get("tests/b.test.ts"), before.get("tests/b.test.ts"));
    assert.notEqual(afterPkg.get("tests/db.test.ts"), before.get("tests/db.test.ts"));

    // Task #4077: migrations moved OUT of the shared global inputs. Task
    // #4503 narrowed further: an UNATTRIBUTABLE migration (no plain table
    // statements) still re-runs every DB-sensitive suite via the global
    // bucket, while pure suites ignore it entirely.
    writeFileSync(join(root, "migrations", "0002_more.sql"), "DO $$ BEGIN PERFORM 1; END $$;\n");
    const afterMig = await fingerprintsFor(root, [SUITE_A, SUITE_B, SUITE_DB]);
    assert.equal(afterMig.get("tests/a.test.ts"), afterPkg.get("tests/a.test.ts"), "pure suite ignores migrations");
    assert.equal(afterMig.get("tests/b.test.ts"), afterPkg.get("tests/b.test.ts"), "shim suite with no DB closure ignores migrations");
    assert.notEqual(
      afterMig.get("tests/db.test.ts"),
      afterPkg.get("tests/db.test.ts"),
      "DATABASE_URL-reading suite re-runs on an unattributable migration",
    );

    // Editing an EXISTING unattributable migration must also invalidate it.
    writeFileSync(join(root, "migrations", "0002_more.sql"), "DO $$ BEGIN PERFORM 2; END $$;\n");
    const afterEdit = await fingerprintsFor(root, [SUITE_A, SUITE_DB]);
    assert.equal(afterEdit.get("tests/a.test.ts"), afterMig.get("tests/a.test.ts"));
    assert.notEqual(afterEdit.get("tests/db.test.ts"), afterMig.get("tests/db.test.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DB classification by PATH: a closure reaching server/db.ts is migration-sensitive", async () => {
  const root = makeFixtureRepo();
  try {
    // The fixture's server/db.ts is content-innocent (no pg import, no
    // DATABASE_URL) so this exercises the path prong specifically.
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "db.ts"), "export const pool = { query: () => 0 };\n");
    writeFileSync(
      join(root, "tests", "viaDb.test.ts"),
      'import { pool } from "../server/db";\nif (!pool) throw new Error("no");\n',
    );
    const suites = [{ file: "tests/viaDb.test.ts" }, SUITE_A];
    const before = await fingerprintsFor(root, suites);
    // Unattributable migration → hits every sensitive suite (Task #4503).
    writeFileSync(join(root, "migrations", "0002_more.sql"), "DO $$ BEGIN PERFORM 1; END $$;\n");
    const after = await fingerprintsFor(root, suites);
    assert.notEqual(after.get("tests/viaDb.test.ts"), before.get("tests/viaDb.test.ts"), "server/db.ts in closure → migration-sensitive");
    assert.equal(after.get("tests/a.test.ts"), before.get("tests/a.test.ts"), "pure sibling unaffected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DB classification by CONTENT: a server/index.ts boot reference (spawned server) is migration-sensitive", async () => {
  const root = makeFixtureRepo();
  try {
    // Layout-sweep-style suite: no DB import anywhere, but it spawns the full
    // server — which applies migrations — so the boot reference marks it.
    writeFileSync(
      join(root, "tests", "spawn.test.ts"),
      'const argv = ["tsx", "server/index.ts"];\nif (argv.length !== 2) throw new Error("no");\n',
    );
    const suites = [{ file: "tests/spawn.test.ts" }, SUITE_A];
    const comp = await computeSuiteFingerprints(suites, root);
    assert.equal(comp.bySuite.get("tests/spawn.test.ts")?.migrationScope, "full", "spawned-server suite pins FULL scope (boot applies every migration)");
    const before = await fingerprintsFor(root, suites);
    // Task #4503: full scope means even a table-attributable migration for an
    // unreferenced table re-runs the spawned-server suite.
    writeFileSync(join(root, "migrations", "0002_more.sql"), "ALTER TABLE t ADD COLUMN x int;\n");
    const after = await fingerprintsFor(root, suites);
    assert.notEqual(after.get("tests/spawn.test.ts"), before.get("tests/spawn.test.ts"), "server-boot reference → migration-sensitive");
    assert.equal(after.get("tests/a.test.ts"), before.get("tests/a.test.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrationSensitive flag is exposed per suite and matches the fingerprint behavior (Task #4081)", async () => {
  const root = makeFixtureRepo();
  try {
    const comp = await computeSuiteFingerprints([SUITE_A, SUITE_B, SUITE_DB], root);
    assert.equal(comp.ok, true, `computation ok (got error: ${comp.error})`);
    assert.equal(comp.bySuite.get("tests/a.test.ts")?.migrationSensitive, false, "pure suite classified insensitive");
    assert.equal(comp.bySuite.get("tests/b.test.ts")?.migrationSensitive, false, "shim suite with no DB closure classified insensitive");
    assert.equal(comp.bySuite.get("tests/db.test.ts")?.migrationSensitive, true, "DATABASE_URL-reading suite classified sensitive");
    // The flag must be an honest report of what the fingerprint folds in:
    // adding an UNATTRIBUTABLE probe migration (global bucket, Task #4503)
    // changes fingerprints for exactly the suites flagged sensitive.
    writeFileSync(join(root, "migrations", "0002_probe.sql"), "DO $$ BEGIN PERFORM 1; END $$;\n");
    const after = await computeSuiteFingerprints([SUITE_A, SUITE_B, SUITE_DB], root);
    for (const file of ["tests/a.test.ts", "tests/b.test.ts", "tests/db.test.ts"]) {
      const flagged = comp.bySuite.get(file)?.migrationSensitive;
      const changed = after.bySuite.get(file)?.fingerprint !== comp.bySuite.get(file)?.fingerprint;
      assert.equal(changed, flagged, `${file}: migrationSensitive=${flagged} must equal fingerprint-changed=${changed}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1a-ter. Tracer stall protection (Task #4560)
// ---------------------------------------------------------------------------

test("a stalled import trace times out and falls open to executing everything (Task #4560)", async () => {
  const root = makeFixtureRepo();
  try {
    // A tracer that never settles: only the Task #4560 timeout race can end
    // this call. The pending promise holds no live handle, so a hung test
    // here would mean the ref'd-timer contract broke (exit-13 note in
    // traceImportClosuresWithBudget).
    const stalledTracer = () => new Promise<never>(() => {});
    const started = Date.now();
    const comp = await computeSuiteFingerprints([SUITE_A, SUITE_B], root, {
      traceTimeoutMs: 150,
      traceFn: stalledTracer as never,
    });
    assert.equal(comp.ok, false, "timed-out trace → computation unavailable");
    assert.match(comp.error ?? "", /import trace timed out/, "error names the timeout");
    assert.ok(Date.now() - started < 5_000, "returned promptly after the budget, not the tracer");

    // Env-default path: FINGERPRINT_TRACE_TIMEOUT_MS is honored when no
    // explicit traceTimeoutMs is injected.
    const compEnv = await computeSuiteFingerprints([SUITE_A], root, {
      env: { FINGERPRINT_TRACE_TIMEOUT_MS: "150" } as NodeJS.ProcessEnv,
      traceFn: stalledTracer as never,
    });
    assert.equal(compEnv.ok, false, "env-configured budget also falls open");
    assert.match(compEnv.error ?? "", /timed out/);

    // A REJECTING tracer is normalized into the same ok:false fall-open —
    // promptly, with the timeout handle cleared (a crashed trace must not
    // leave a live budget timer keeping the process alive).
    const rejectStart = Date.now();
    const compReject = await computeSuiteFingerprints([SUITE_A], root, {
      traceTimeoutMs: 60_000,
      traceFn: (() => Promise.reject(new Error("esbuild exploded"))) as never,
    });
    assert.equal(compReject.ok, false, "rejecting tracer → computation unavailable");
    assert.match(compReject.error ?? "", /import trace crashed/, "error names the crash");
    assert.ok(Date.now() - rejectStart < 5_000, "rejecting tracer returns promptly (timer cleared, not awaited)");

    // A synchronously THROWING tracer takes the same path.
    const compThrow = await computeSuiteFingerprints([SUITE_A], root, {
      traceTimeoutMs: 60_000,
      traceFn: (() => {
        throw new Error("sync boom");
      }) as never,
    });
    assert.equal(compThrow.ok, false, "throwing tracer → computation unavailable");
    assert.match(compThrow.error ?? "", /crashed/);

    // End-to-end: planIncrementalRun with a stalled tracer EXECUTES every
    // suite — fingerprinting unavailable is a fall-open, never a skip.
    const storePath = join(root, "store.json");
    const store = emptyGreenStore();
    // A fresh same-fingerprint green would normally allow a skip; the
    // timeout must override it because no fingerprint can be computed.
    store.records["tests/a.test.ts"] = {
      fingerprint: "irrelevant",
      verdict: "green",
      flaky: false,
      durationMs: 10,
      recordedAt: NOW.toISOString(),
      mode: "smoke",
    };
    writeFileSync(storePath, JSON.stringify(store));
    const plan = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {} as NodeJS.ProcessEnv,
      now: NOW,
      coreRules: NO_CORE,
      traceTimeoutMs: 150,
      traceFn: stalledTracer as never,
    });
    assert.equal(plan.executeFiles.size, 2, "every suite executes on a timed-out trace");
    assert.equal(plan.skippedFiles.length, 0, "nothing is skipped");
    assert.match(plan.skippingDisabledReason ?? "", /timed out/, "run-level reason names the timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1a-bis. Per-table migration scoping boundaries (Task #4503)
// ---------------------------------------------------------------------------

test("extractMigrationTables: plain table DDL/DML attributes; anything else is global (null)", () => {
  assert.deepEqual(
    [...(extractMigrationTables(
      'CREATE TABLE IF NOT EXISTS "widget_rows" (id bigint REFERENCES "owners"(id));\n--> statement-breakpoint\nALTER TABLE public.gadget_rows ADD COLUMN x int;\nCREATE INDEX CONCURRENTLY IF NOT EXISTS idx_w ON widget_rows (x);\n-- comment mentioning phantom_table is ignored\n',
    ) ?? [])].sort(),
    ["gadget_rows", "owners", "widget_rows"],
    "CREATE/ALTER/INDEX/REFERENCES attribute; SQL comments are stripped",
  );
  // SOURCE relations in DML attribute too — missing them is a WRONG-SKIP
  // (a suite referencing only the read table would keep its green).
  assert.ok(extractMigrationTables("UPDATE command_panels SET x = c.y FROM clients c WHERE c.id = 1;")?.has("clients"), "UPDATE … FROM source attributes");
  assert.ok(extractMigrationTables("INSERT INTO command_panels (x) SELECT y FROM clients;")?.has("clients"), "INSERT … SELECT … FROM source attributes");
  assert.ok(extractMigrationTables("DELETE FROM command_panels USING clients WHERE clients.id = command_panels.cid;")?.has("clients"), "DELETE … USING source attributes");
  assert.ok(extractMigrationTables("UPDATE a SET x = 1 WHERE id IN (SELECT id FROM b JOIN c ON b.i = c.i);")?.has("c"), "joins/subqueries attribute");
  // Comma-separated relation lists attribute EVERY relation — recording only
  // the first one is a WRONG-SKIP for suites scoped to the omitted tables.
  {
    const drop = extractMigrationTables("DROP TABLE a, b;");
    assert.ok(drop?.has("a") && drop?.has("b"), "DROP TABLE a, b attributes both");
    const trunc = extractMigrationTables("TRUNCATE a, b;");
    assert.ok(trunc?.has("a") && trunc?.has("b"), "TRUNCATE a, b attributes both");
    const from = extractMigrationTables("UPDATE t SET x = 1 FROM a aa, b bb WHERE aa.i = bb.i;");
    assert.ok(from?.has("a") && from?.has("b"), "FROM a, b attributes both (aliases skipped)");
    const using = extractMigrationTables("DELETE FROM t USING a, b WHERE a.i = b.i;");
    assert.ok(using?.has("a") && using?.has("b"), "USING a, b attributes both");
  }
  assert.equal(extractMigrationTables("DO $$ BEGIN PERFORM 1; END $$;"), null, "DO block → global");
  assert.equal(extractMigrationTables("CREATE OR REPLACE FUNCTION f() RETURNS int AS 'select 1' LANGUAGE sql;"), null, "function → global");
  assert.equal(
    extractMigrationTables("ALTER TABLE t ADD COLUMN x int;\nCREATE VIEW v AS SELECT 1;"),
    null,
    "ONE unattributable statement makes the whole file global — never partial attribution",
  );
  assert.equal(extractMigrationTables("SET search_path TO public;"), null, "search_path → global");
  assert.equal(extractMigrationTables("-- only comments\n"), null, "zero extracted tables → global (leans open)");
});

test("per-table scoping: a migration re-runs ONLY table-scoped suites referencing a touched table (Task #4503)", async () => {
  const root = makeFixtureRepo();
  try {
    const suites = [SUITE_A, SUITE_DB, SUITE_WIDGETS];
    const comp = await computeSuiteFingerprints(suites, root);
    assert.equal(comp.ok, true, `computation ok (got error: ${comp.error})`);
    const widgets = comp.bySuite.get("tests/widgets.test.ts");
    assert.equal(widgets?.migrationSensitive, true, "DATABASE_URL in the DAO → sensitive");
    assert.equal(widgets?.migrationScope, "tables", "no full-scope marker → table-scoped");
    assert.deepEqual(widgets?.migrationTables, ["widget_rows"], "pgTable export ident `widgetRows` maps to its SQL name");
    // A DB-sensitive suite referencing ZERO known tables cannot be attributed
    // (dynamic table names, exotic access) → pinned FULL, never table-scoped.
    const db = comp.bySuite.get("tests/db.test.ts");
    assert.equal(db?.migrationScope, "full", "zero referenced tables → full scope (leans open)");

    const before = await fingerprintsFor(root, suites);
    // Migration touching the REFERENCED table → widgets re-runs; pure doesn't.
    writeFileSync(join(root, "migrations", "0002_widgets.sql"), "ALTER TABLE widget_rows ADD COLUMN x int;\n");
    const afterWidget = await fingerprintsFor(root, suites);
    assert.notEqual(afterWidget.get("tests/widgets.test.ts"), before.get("tests/widgets.test.ts"), "touched referenced table → re-run");
    assert.notEqual(afterWidget.get("tests/db.test.ts"), before.get("tests/db.test.ts"), "full-scope suite re-runs on every migration");
    assert.equal(afterWidget.get("tests/a.test.ts"), before.get("tests/a.test.ts"), "pure suite unaffected");

    // Migration touching a DEFINED but UNREFERENCED table → widgets skips.
    writeFileSync(join(root, "migrations", "0003_gadgets.sql"), "ALTER TABLE gadget_rows ADD COLUMN y int;\n");
    const afterGadget = await fingerprintsFor(root, suites);
    assert.equal(afterGadget.get("tests/widgets.test.ts"), afterWidget.get("tests/widgets.test.ts"), "unreferenced table → widgets skips");

    // Editing an EXISTING migration of the referenced table → re-run.
    writeFileSync(join(root, "migrations", "0002_widgets.sql"), "ALTER TABLE widget_rows ADD COLUMN x bigint;\n");
    const afterEdit = await fingerprintsFor(root, suites);
    assert.notEqual(afterEdit.get("tests/widgets.test.ts"), afterGadget.get("tests/widgets.test.ts"), "edited migration of referenced table → re-run");

    // SOURCE relations in DML: migrations WRITING another table but READING
    // the referenced one must still re-run the referencing suite (reviewer
    // regression: UPDATE…FROM / INSERT…SELECT / DELETE…USING).
    writeFileSync(join(root, "migrations", "0005_upd.sql"), "UPDATE gadget_rows SET y = w.x FROM widget_rows w;\n");
    const afterUpdFrom = await fingerprintsFor(root, suites);
    assert.notEqual(afterUpdFrom.get("tests/widgets.test.ts"), afterEdit.get("tests/widgets.test.ts"), "UPDATE … FROM widget_rows → widgets re-runs");
    writeFileSync(join(root, "migrations", "0006_ins.sql"), "INSERT INTO gadget_rows (y) SELECT x FROM widget_rows;\n");
    const afterInsSel = await fingerprintsFor(root, suites);
    assert.notEqual(afterInsSel.get("tests/widgets.test.ts"), afterUpdFrom.get("tests/widgets.test.ts"), "INSERT … SELECT FROM widget_rows → widgets re-runs");
    writeFileSync(join(root, "migrations", "0007_del.sql"), "DELETE FROM gadget_rows USING widget_rows WHERE widget_rows.id = gadget_rows.wid;\n");
    const afterDelUsing = await fingerprintsFor(root, suites);
    assert.notEqual(afterDelUsing.get("tests/widgets.test.ts"), afterInsSel.get("tests/widgets.test.ts"), "DELETE … USING widget_rows → widgets re-runs");

    // UNATTRIBUTABLE migration → EVERY sensitive suite re-runs (global bucket).
    writeFileSync(join(root, "migrations", "0008_do.sql"), "DO $$ BEGIN PERFORM 1; END $$;\n");
    const afterGlobal = await fingerprintsFor(root, suites);
    assert.notEqual(afterGlobal.get("tests/widgets.test.ts"), afterDelUsing.get("tests/widgets.test.ts"), "global migration hits table-scoped suites");
    assert.equal(afterGlobal.get("tests/a.test.ts"), afterDelUsing.get("tests/a.test.ts"), "pure suite still unaffected");

    // MIXED file: unsupported DDL alongside a plain ALTER TABLE of an
    // UNREFERENCED table must go GLOBAL — partial attribution is a wrong-skip.
    writeFileSync(
      join(root, "migrations", "0009_mixed.sql"),
      "CREATE DOMAIN money_cents AS bigint;\nALTER TABLE gadget_rows ADD COLUMN price money_cents;\n",
    );
    const afterMixed = await fingerprintsFor(root, suites);
    assert.notEqual(afterMixed.get("tests/widgets.test.ts"), afterGlobal.get("tests/widgets.test.ts"), "mixed unsupported+table file is global, not gadget-scoped");

    // Raw-SQL-only suite: references widget_rows by NAME without importing the
    // schema — the repo-wide universe must still attribute it.
    writeFileSync(
      join(root, "tests", "rawsql.test.ts"),
      'const q = "select count(*) from widget_rows";\nconst u = process.env.DATABASE_URL;\nif (!q || u === "x") throw new Error("no");\n',
    );
    const rawSuites = [...suites, { file: "tests/rawsql.test.ts" }];
    const compRaw = await computeSuiteFingerprints(rawSuites, root);
    assert.equal(compRaw.bySuite.get("tests/rawsql.test.ts")?.migrationScope, "tables");
    assert.deepEqual(compRaw.bySuite.get("tests/rawsql.test.ts")?.migrationTables, ["widget_rows"], "raw SQL name matches without any schema import");
    const beforeRaw = await fingerprintsFor(root, rawSuites);
    writeFileSync(join(root, "migrations", "0010_w.sql"), "ALTER TABLE widget_rows ADD COLUMN z int;\n");
    const afterRaw = await fingerprintsFor(root, rawSuites);
    assert.notEqual(afterRaw.get("tests/rawsql.test.ts"), beforeRaw.get("tests/rawsql.test.ts"), "raw-SQL suite re-runs on its table's migration");

    // Migration-ONLY table (no pgTable def anywhere): its name still becomes
    // a token via the migration ledger, so raw references attribute.
    writeFileSync(join(root, "migrations", "0011_legacy.sql"), "CREATE TABLE legacy_rows (id bigint);\n");
    writeFileSync(
      join(root, "tests", "legacy.test.ts"),
      'const q = "select * from legacy_rows";\nconst u = process.env.DATABASE_URL;\nif (!q || u === "x") throw new Error("no");\n',
    );
    const legacySuites = [{ file: "tests/legacy.test.ts" }, SUITE_A];
    const compLegacy = await computeSuiteFingerprints(legacySuites, root);
    assert.deepEqual(compLegacy.bySuite.get("tests/legacy.test.ts")?.migrationTables, ["legacy_rows"], "migration-only table names are tokens too");
    const beforeLegacy = await fingerprintsFor(root, legacySuites);
    writeFileSync(join(root, "migrations", "0012_legacy2.sql"), "ALTER TABLE legacy_rows ADD COLUMN x int;\n");
    const afterLegacy = await fingerprintsFor(root, legacySuites);
    assert.notEqual(afterLegacy.get("tests/legacy.test.ts"), beforeLegacy.get("tests/legacy.test.ts"), "raw reference to migration-only table re-runs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("full-scope pins: migration runner in closure, or catalog queries in test code (Task #4503)", async () => {
  const root = makeFixtureRepo();
  try {
    // Closure reaches server/devMigrations.ts (reads the whole migrations tree).
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "devMigrations.ts"), "export const run = () => process.env.DATABASE_URL;\n");
    writeFileSync(
      join(root, "tests", "runner.test.ts"),
      'import { run } from "../server/devMigrations";\nif (!run) throw new Error("no");\n',
    );
    // A tests/-side catalog query pins full scope; the same string in a
    // COMMENT must NOT (comment-stripped scan).
    writeFileSync(
      join(root, "tests", "catalog.test.ts"),
      'const q = "select * from information_schema.tables";\nconst u = process.env.DATABASE_URL;\nif (!q || u === "x") throw new Error("no");\n',
    );
    writeFileSync(
      join(root, "tests", "commentOnly.test.ts"),
      '// mentions information_schema and server/index.ts only in this comment\nconst q = "select * from widget_rows";\nconst u = process.env.DATABASE_URL;\nif (!q || u === "x") throw new Error("no");\n',
    );
    const suites = [{ file: "tests/runner.test.ts" }, { file: "tests/catalog.test.ts" }, { file: "tests/commentOnly.test.ts" }];
    const comp = await computeSuiteFingerprints(suites, root);
    assert.equal(comp.ok, true, `computation ok (got error: ${comp.error})`);
    assert.equal(comp.bySuite.get("tests/runner.test.ts")?.migrationScope, "full", "migration-runner closure → full scope");
    assert.equal(comp.bySuite.get("tests/catalog.test.ts")?.migrationScope, "full", "catalog query in test code → full scope");
    assert.equal(
      comp.bySuite.get("tests/commentOnly.test.ts")?.migrationScope,
      "tables",
      "full-scope markers in COMMENTS must not pin full scope (they'd collapse the whole #4503 win)",
    );

    // Full scope keeps whole-tree behavior: an attributable migration for an
    // unreferenced table still re-runs full-scope suites, not table-scoped ones.
    const before = await fingerprintsFor(root, suites);
    writeFileSync(join(root, "migrations", "0002_more.sql"), "ALTER TABLE some_unrelated (x);\nALTER TABLE some_unrelated ADD COLUMN x int;\n");
    const after = await fingerprintsFor(root, suites);
    assert.notEqual(after.get("tests/runner.test.ts"), before.get("tests/runner.test.ts"));
    assert.notEqual(after.get("tests/catalog.test.ts"), before.get("tests/catalog.test.ts"));
    assert.equal(after.get("tests/commentOnly.test.ts"), before.get("tests/commentOnly.test.ts"), "table-scoped suite ignores unreferenced-table migration");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1b. Real-tree classification pins (Task #4081)
// ---------------------------------------------------------------------------

/**
 * Task #4081 — pin the REAL repo's migration-sensitivity split. Task #4077
 * measured 622 of 877 suites migration-sensitive and 255 insensitive (the
 * stubbed jsdom client family, lint suites, pure parsers). Nothing else pins
 * that split: if a widely-imported client/test helper ever grows a DB content
 * marker (a `pg` import, a process.env.DATABASE_URL read, a server/index.ts
 * boot reference — see DB_CONTENT_PATTERNS / DB_PATH_MARKERS in
 * tests/suiteFingerprint.ts), hundreds of pure suites silently become
 * migration-sensitive again and every migration merge re-inflates validation
 * time. Classification errors fall open to executing, so drift can never
 * cause a wrong skip — only silent slowness, which is exactly why it needs an
 * explicit guard in the always-run core.
 *
 * False-positive path: if a pinned pure suite LEGITIMATELY grows a DB
 * dependency, the fix is a one-line pin update — move that file from
 * PURE_REAL_PINS to a different pure suite (any stubbed tests/client/*.test.tsx
 * or tests/lint-*.test.ts with no DB closure). If MANY pure suites flipped at
 * once, do NOT re-pin: find the shared helper that grew the DB marker and
 * split the DB reference out of it instead.
 */
const PURE_REAL_PINS = [
  // Repo-source scanner: reads files via fs, never touches the DB layer.
  "tests/lint-merge-conflict-markers.test.ts",
  // Stubbed jsdom client suite: representative of the ~255-strong pure
  // client family whose skip on migration merges Task #4077 bought.
  "tests/client/breaker-detail-row-empty-fields.test.tsx",
];
// This very suite is migration-sensitive (suiteFingerprint.ts carries the
// DATABASE_URL marker pattern in its own source, and the regressionSweep
// import reaches the server tree) — a stable in-repo sensitive pin.
const DB_REAL_PIN = "tests/incremental-green-skip.test.ts";
// Task #4503: pin one representative TABLE-scoped real suite. If this flips
// to "full", some widely-imported file grew a full-scope marker (a tests/-
// side server/index.ts / information_schema reference outside comments, or
// server/devMigrations.ts entering the closure) and the per-table win
// silently collapses back to whole-tree re-runs on every migration merge.
// If THIS suite legitimately pinned full, swap it for another table-scoped
// suite (one-line change) — do NOT weaken the full-scope markers.
const TABLE_SCOPED_REAL_PIN = "tests/abandoned-upload-cleanup.test.ts";

test("real-tree pins: known-pure suites stay migration-INsensitive, a known-DB suite stays sensitive (Task #4081)", async () => {
  const registry = buildTestRegistry();
  assert.equal(registry.problems.length, 0, `registry unusable: ${registry.problems.map((p) => p.message).join("; ")}`);
  const byFile = new Map(registry.tests.map((t) => [t.file, t]));
  const suites: SuiteLike[] = [...PURE_REAL_PINS, DB_REAL_PIN, TABLE_SCOPED_REAL_PIN].map((file) => {
    const def = byFile.get(file);
    assert.ok(def, `${file} is no longer registered — update the pin lists in this test (see PURE_REAL_PINS/DB_REAL_PIN)`);
    return { file: def.file, extraNodeArgs: def.extraNodeArgs, extraEnv: def.extraEnv, timeoutMs: def.timeoutMs };
  });
  const comp = await computeSuiteFingerprints(suites, process.cwd());
  assert.equal(comp.ok, true, `real-tree fingerprint computation failed: ${comp.error}`);
  for (const file of PURE_REAL_PINS) {
    const info = comp.bySuite.get(file);
    assert.equal(info?.unskippableReason, null, `${file} must fingerprint cleanly, got: ${info?.unskippableReason}`);
    assert.equal(
      info?.migrationSensitive,
      false,
      `${file} became migration-SENSITIVE: some file in its import closure now matches a DB classification marker ` +
        `(DB_PATH_MARKERS / DB_PATH_PREFIXES / DB_CONTENT_PATTERNS in tests/suiteFingerprint.ts — server/db.ts, ` +
        `tests/hermetic/, a "pg" import, process.env.DATABASE_URL, or a server/index.ts boot reference). ` +
        `If a shared helper grew that reference, split the DB dependency out of it — otherwise every pure suite ` +
        `importing it re-runs on EVERY migration merge and validation silently re-slows (Task #4077 regression). ` +
        `If THIS suite legitimately became DB-backed, re-pin: swap it for another pure suite in PURE_REAL_PINS (one-line change).`,
    );
  }
  const dbInfo = comp.bySuite.get(DB_REAL_PIN);
  assert.equal(
    dbInfo?.migrationSensitive,
    true,
    `${DB_REAL_PIN} is no longer classified migration-sensitive — the DB classification markers in ` +
      `tests/suiteFingerprint.ts (DB_PATH_MARKERS / DB_CONTENT_PATTERNS) may have been weakened; a DB-backed suite ` +
      `that skips on migration merges is a WRONG-SKIP risk, fix the markers before anything else.`,
  );
  assert.equal(
    dbInfo?.migrationScope,
    "full",
    `${DB_REAL_PIN} spawns/quotes server-boot fixtures, so it must stay FULL scope`,
  );
  const scopedInfo = comp.bySuite.get(TABLE_SCOPED_REAL_PIN);
  assert.equal(scopedInfo?.migrationSensitive, true, `${TABLE_SCOPED_REAL_PIN} must stay migration-sensitive`);
  assert.equal(
    scopedInfo?.migrationScope,
    "tables",
    `${TABLE_SCOPED_REAL_PIN} flipped to FULL migration scope — see TABLE_SCOPED_REAL_PIN comment: a shared file ` +
      `likely grew a full-scope marker and the Task #4503 per-table win is collapsing; find and split it, or re-pin ` +
      `only if THIS suite legitimately became a spawned-server/catalog suite.`,
  );
});

test("registration metadata (extraNodeArgs/extraEnv/timeoutMs) is part of the fingerprint", async () => {
  const root = makeFixtureRepo();
  try {
    const plain = await fingerprintsFor(root, [SUITE_A]);
    const withEnv = await fingerprintsFor(root, [{ ...SUITE_A, extraEnv: { FOO: "1" } }]);
    assert.notEqual(withEnv.get("tests/a.test.ts"), plain.get("tests/a.test.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a suite with an unresolvable import is never skippable; others are unaffected", async () => {
  const root = makeFixtureRepo();
  try {
    writeFileSync(join(root, "tests", "c.test.ts"), 'import "./does-not-exist-xyz";\n');
    const comp = await computeSuiteFingerprints([SUITE_A, { file: "tests/c.test.ts" }], root);
    assert.equal(comp.ok, true, "tolerant trace: whole computation still succeeds");
    const c = comp.bySuite.get("tests/c.test.ts");
    assert.ok(c?.unskippableReason?.includes("unresolvable"), `C unskippable, got: ${c?.unskippableReason}`);
    assert.equal(c?.fingerprint, null);
    assert.equal(comp.bySuite.get("tests/a.test.ts")?.unskippableReason, null, "A unaffected by C's bad import");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a suite with a per-file build error (parse failure) poisons only itself, not the universe", async () => {
  // Regression guard for the failure mode observed live on 2026-08-05: ONE
  // test file with `const r = ...; r = ...` (an esbuild parse ERROR, not a
  // resolution error) failed the whole-universe trace, so fingerprinting was
  // "unavailable" and every run fell open to executing all ~262 suites — the
  // skip layer could never engage until that unrelated file was fixed.
  const root = makeFixtureRepo();
  try {
    writeFileSync(
      join(root, "tests", "broken.test.ts"),
      'import { util } from "../src/util";\nconst r = util();\nr = 2;\nexport { r };\n',
    );
    const comp = await computeSuiteFingerprints([SUITE_A, { file: "tests/broken.test.ts" }], root);
    assert.equal(comp.ok, true, `tolerant trace must survive a parse error, got: ${comp.error}`);
    const broken = comp.bySuite.get("tests/broken.test.ts");
    assert.ok(
      broken?.unskippableReason?.includes("build error"),
      `broken suite unskippable via build-error poisoning, got: ${broken?.unskippableReason}`,
    );
    assert.equal(broken?.fingerprint, null);
    const a = comp.bySuite.get("tests/a.test.ts");
    assert.equal(a?.unskippableReason, null, "sibling suite still fingerprints normally");
    assert.ok(a?.fingerprint, "sibling suite has a real fingerprint");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. decideSuite rules
// ---------------------------------------------------------------------------

function greenRecord(over: Partial<GreenRecord> = {}): GreenRecord {
  return {
    fingerprint: "fp-1",
    verdict: "green",
    flaky: false,
    durationMs: 1000,
    recordedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), // 1h ago
    mode: "smoke",
    ...over,
  };
}

const DECIDE_BASE = {
  file: "tests/x.test.ts",
  runLevelExecuteReason: null as string | null,
  coreWhy: null as string | null,
  fingerprint: "fp-1" as string | null,
  unskippableReason: null as string | null,
  record: greenRecord() as GreenRecord | undefined,
  nowMs: NOW.getTime(),
  greenMaxAgeMs: DEFAULT_GREEN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
};

test("decideSuite skips ONLY on a fresh fingerprint-matching green", () => {
  assert.equal(decideSuite({ ...DECIDE_BASE }).action, "skip", "matching fresh green → skip");
  assert.ok(decideSuite({ ...DECIDE_BASE }).reason.includes("green on identical inputs"));

  const cases: Array<[string, Partial<typeof DECIDE_BASE>]> = [
    ["force-all / run-level", { runLevelExecuteReason: "force-all requested" }],
    ["always-run core", { coreWhy: "guards the lint gate" }],
    ["unskippable (unresolvable import)", { unskippableReason: "closure member x has unresolvable import(s)" }],
    ["no fingerprint", { fingerprint: null }],
    ["no record", { record: undefined }],
    ["last run FAILED", { record: greenRecord({ verdict: "failed" }) }],
    ["fingerprint mismatch (inputs changed)", { record: greenRecord({ fingerprint: "fp-OLD" }) }],
    [
      "green expired",
      { record: greenRecord({ recordedAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString() }) },
    ],
    ["unparseable recordedAt", { record: greenRecord({ recordedAt: "not-a-date" }) }],
  ];
  for (const [label, over] of cases) {
    assert.equal(decideSuite({ ...DECIDE_BASE, ...over }).action, "execute", `${label} → execute`);
  }
});

test("core precedence: a core suite executes even with a perfect green record", () => {
  const d = decideSuite({ ...DECIDE_BASE, coreWhy: "core rule" });
  assert.equal(d.action, "execute");
  assert.ok(d.reason.startsWith("always-run core:"));
});

// ---------------------------------------------------------------------------
// 3. planIncrementalRun + recordRunOutcomes end-to-end on a fixture repo
// ---------------------------------------------------------------------------

test("end-to-end: first run executes all → greens recorded → second run skips (smoke mode)", async () => {
  const root = makeFixtureRepo();
  const storePath = join(root, "store.json");
  try {
    const plan1 = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    assert.equal(plan1.skippingDisabledReason, null, "smoke mode has no full-green window guard");
    assert.equal(plan1.executeFiles.size, 2, "no store → everything executes");
    assert.ok(plan1.notes.some((n) => n.includes("green store missing")));

    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: plan1.fingerprints,
      outcomes: [
        { file: "tests/a.test.ts", passed: true, flaky: false, durationMs: 900 },
        { file: "tests/b.test.ts", passed: true, flaky: true, durationMs: 2100 },
      ],
      fullRunGreen: false,
      now: NOW,
    });

    const { store } = loadGreenStore(storePath);
    assert.equal(store.records["tests/a.test.ts"]?.verdict, "green");
    assert.equal(store.records["tests/b.test.ts"]?.flaky, true, "retry-pass keeps its flaky flag");
    assert.equal(store.lastFullRunGreenAt, null, "smoke run never stamps the full-green marker");

    const plan2 = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: new Date(NOW.getTime() + 60_000),
      coreRules: NO_CORE,
    });
    assert.equal(plan2.executeFiles.size, 0, "identical inputs → everything skips");
    assert.deepEqual([...plan2.skippedFiles].sort(), ["tests/a.test.ts", "tests/b.test.ts"]);

    // Change one input → only that suite re-executes.
    writeFileSync(join(root, "src", "util.ts"), "export const util = () => 3;\n");
    const plan3 = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: new Date(NOW.getTime() + 60_000),
      coreRules: NO_CORE,
    });
    assert.deepEqual([...plan3.executeFiles], ["tests/a.test.ts"], "only the changed-closure suite executes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mode 'all' executes everything until a genuine full green exists in the window", async () => {
  const root = makeFixtureRepo();
  const storePath = join(root, "store.json");
  try {
    const plan1 = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "all",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    assert.ok(plan1.skippingDisabledReason?.includes("no full-suite green"), "integrity guard fires");
    assert.equal(plan1.executeFiles.size, 1);

    recordRunOutcomes({
      storePath,
      mode: "all",
      fingerprints: plan1.fingerprints,
      outcomes: [{ file: "tests/a.test.ts", passed: true, flaky: false, durationMs: 500 }],
      fullRunGreen: true,
      now: NOW,
    });
    const { store } = loadGreenStore(storePath);
    assert.equal(store.lastFullRunGreenAt, NOW.toISOString());
    assert.equal(fullGreenWithinWindow(store, NOW.getTime() + 1000, 7 * 24 * 60 * 60 * 1000), true);

    const plan2 = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "all",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: new Date(NOW.getTime() + 60_000),
      coreRules: NO_CORE,
    });
    assert.equal(plan2.skippingDisabledReason, null, "full green in window → skipping allowed");
    assert.equal(plan2.executeFiles.size, 0);

    // ...but an EXPIRED full green re-arms the guard (default window 7d).
    const plan3 = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "all",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000),
      coreRules: NO_CORE,
    });
    assert.ok(plan3.skippingDisabledReason?.includes("no full-suite green"), "stale full green → full run again");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("force-all bypasses skipping in every mode; failures never record green and overwrite prior greens", async () => {
  const root = makeFixtureRepo();
  const storePath = join(root, "store.json");
  try {
    const plan1 = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: plan1.fingerprints,
      outcomes: [{ file: "tests/a.test.ts", passed: true, flaky: false, durationMs: 500 }],
      fullRunGreen: false,
      now: NOW,
    });

    const forced = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "smoke",
      forceAll: true,
      repoRoot: root,
      storePath,
      env: {},
      now: new Date(NOW.getTime() + 1000),
      coreRules: NO_CORE,
    });
    assert.ok(forced.skippingDisabledReason?.includes("force-all"), "force-all disables skipping");
    assert.equal(forced.executeFiles.size, 1);

    // The forced run FAILS the suite → its green must be overwritten.
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: forced.fingerprints,
      outcomes: [{ file: "tests/a.test.ts", passed: false, flaky: false, durationMs: 700 }],
      fullRunGreen: false,
      now: new Date(NOW.getTime() + 2000),
    });
    const { store } = loadGreenStore(storePath);
    assert.equal(store.records["tests/a.test.ts"]?.verdict, "failed", "failure overwrites the stale green");

    const afterFail = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: new Date(NOW.getTime() + 3000),
      coreRules: NO_CORE,
    });
    assert.equal(afterFail.executeFiles.size, 1, "failed verdict → executes despite identical inputs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("always-run core suites are exempt from skipping in planIncrementalRun", async () => {
  const root = makeFixtureRepo();
  const storePath = join(root, "store.json");
  const core: CoreRule[] = [{ kind: "exact", value: "tests/a.test.ts", why: "fixture core" }];
  try {
    const plan1 = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: core,
    });
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: plan1.fingerprints,
      outcomes: [
        { file: "tests/a.test.ts", passed: true, flaky: false, durationMs: 100 },
        { file: "tests/b.test.ts", passed: true, flaky: false, durationMs: 100 },
      ],
      fullRunGreen: false,
      now: NOW,
    });
    const plan2 = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: new Date(NOW.getTime() + 1000),
      coreRules: core,
    });
    assert.deepEqual([...plan2.executeFiles], ["tests/a.test.ts"], "core suite executes even when green");
    assert.deepEqual(plan2.skippedFiles, ["tests/b.test.ts"]);
    const coreDecision = plan2.decisions.find((d) => d.file === "tests/a.test.ts");
    assert.ok(coreDecision?.reason.includes("always-run core"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("store hygiene: schema/algo mismatch and corrupt JSON are discarded (fall open); old records pruned", async () => {
  const root = makeFixtureRepo();
  const storePath = join(root, "store.json");
  try {
    writeFileSync(
      storePath,
      JSON.stringify({ schemaVersion: 999, fingerprintAlgo: "fp-v0", lastFullRunGreenAt: null, records: { x: {} } }),
    );
    const mismatch = loadGreenStore(storePath);
    assert.deepEqual(mismatch.store.records, {}, "mismatched schema discarded");
    assert.ok(mismatch.note?.includes("mismatch"));

    writeFileSync(storePath, "{ not valid json !!!");
    const corrupt = loadGreenStore(storePath);
    assert.deepEqual(corrupt.store.records, {}, "corrupt store discarded");
    assert.ok(corrupt.note, "corrupt store carries a note");

    // Pruning: a 40-day-old record disappears on the next save.
    rmSync(storePath, { force: true });
    const plan = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: plan.fingerprints,
      outcomes: [{ file: "tests/a.test.ts", passed: true, flaky: false, durationMs: 100 }],
      fullRunGreen: false,
      now: new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000),
    });
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: new Map(),
      outcomes: [],
      fullRunGreen: false,
      now: NOW,
    });
    const { store } = loadGreenStore(storePath);
    assert.equal(store.records["tests/a.test.ts"], undefined, "40-day-old record pruned");

    // Env knob: TEST_GREEN_MAX_AGE_DAYS shortens expiry.
    const planKnob = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: planKnob.fingerprints,
      outcomes: [{ file: "tests/a.test.ts", passed: true, flaky: false, durationMs: 100 }],
      fullRunGreen: false,
      now: NOW,
    });
    const planShortAge = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: { TEST_GREEN_MAX_AGE_DAYS: "0.001" }, // ~86s
      now: new Date(NOW.getTime() + 10 * 60 * 1000),
      coreRules: NO_CORE,
    });
    assert.equal(planShortAge.executeFiles.size, 1, "TEST_GREEN_MAX_AGE_DAYS override expires the green");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pass without a fingerprint records nothing; a fail without one still records failed", async () => {
  const root = makeFixtureRepo();
  const storePath = join(root, "store.json");
  try {
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: new Map([["tests/a.test.ts", null]]),
      outcomes: [
        { file: "tests/a.test.ts", passed: true, flaky: false, durationMs: 100 },
        { file: "tests/z.test.ts", passed: false, flaky: false, durationMs: 100 },
      ],
      fullRunGreen: false,
      now: NOW,
    });
    const { store } = loadGreenStore(storePath);
    assert.equal(store.records["tests/a.test.ts"], undefined, "no fingerprint → no green record (cannot prove inputs)");
    assert.equal(store.records["tests/z.test.ts"]?.verdict, "failed", "failures are always recorded");
    assert.equal(store.records["tests/z.test.ts"]?.fingerprint, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3b. Task #5306 — per-suite persistence: an interrupted sweep (killed
// process, timeout, lost connection) must leave every already-finished,
// already-passed suite recorded, fabricate nothing for suites that never
// finished, and tolerate concurrent writers without corrupting the store.
// ---------------------------------------------------------------------------

test("interrupted sweep: outcomes recorded suite-by-suite as they complete survive a kill; a suite that never finished is neither green nor failed", async () => {
  const root = makeFixtureRepo();
  const storePath = join(root, "store.json");
  try {
    const plan1 = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B, SUITE_DB],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    // Simulate the runner persisting each suite's outcome the moment it is
    // known (as the serial loop / sharded lane runner now do): a.test.ts
    // finishes and passes, b.test.ts finishes and passes, then the process
    // is killed (SIGKILL / disconnect / timeout) before db.test.ts ever
    // starts. Each write is its own recordRunOutcomes call.
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: plan1.fingerprints,
      outcomes: [{ file: "tests/a.test.ts", passed: true, flaky: false, durationMs: 100 }],
      fullRunGreen: false,
      now: NOW,
    });
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: plan1.fingerprints,
      outcomes: [{ file: "tests/b.test.ts", passed: true, flaky: false, durationMs: 150 }],
      fullRunGreen: false,
      now: new Date(NOW.getTime() + 1000),
    });
    // "Kill" happens here — no further writes, no end-of-sweep fullRunGreen
    // stamp is ever reached.

    const { store: afterKill } = loadGreenStore(storePath);
    assert.equal(afterKill.records["tests/a.test.ts"]?.verdict, "green", "already-finished, already-passed suite survives the kill");
    assert.equal(afterKill.records["tests/b.test.ts"]?.verdict, "green", "second finished suite also survives the kill");
    assert.equal(
      afterKill.records["tests/db.test.ts"],
      undefined,
      "a suite that never finished is not fabricated as green (or failed) — left exactly as it was before the run",
    );
    assert.equal(afterKill.lastFullRunGreenAt, null, "no full-green stamp — that remains a whole-sweep, end-of-run concern");

    // A retry plans against the same suites: A and B skip (green, unchanged
    // inputs); only the suite that never finished re-executes.
    const retryPlan = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B, SUITE_DB],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: new Date(NOW.getTime() + 2000),
      coreRules: NO_CORE,
    });
    assert.deepEqual(
      retryPlan.skippedFiles.slice().sort(),
      ["tests/a.test.ts", "tests/b.test.ts"],
      "retry skips exactly the suites the interrupted run had already finished",
    );
    assert.deepEqual(
      [...retryPlan.executeFiles],
      ["tests/db.test.ts"],
      "retry re-executes only the suite that never got to finish",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted sweep: a genuine failure is recorded immediately, per-suite, and is never masked by the sweep never reaching its end-of-run write", async () => {
  const root = makeFixtureRepo();
  const storePath = join(root, "store.json");
  try {
    const plan1 = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: plan1.fingerprints,
      outcomes: [{ file: "tests/a.test.ts", passed: false, flaky: false, durationMs: 300 }],
      fullRunGreen: false,
      now: NOW,
    });
    // Killed before tests/b.test.ts ever ran.
    const { store } = loadGreenStore(storePath);
    assert.equal(store.records["tests/a.test.ts"]?.verdict, "failed", "a genuine failure persists immediately, per-suite");
    assert.equal(store.records["tests/b.test.ts"], undefined, "the suite that never started has no record");

    const retryPlan = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: new Date(NOW.getTime() + 1000),
      coreRules: NO_CORE,
    });
    assert.deepEqual(
      [...retryPlan.executeFiles].sort(),
      ["tests/a.test.ts", "tests/b.test.ts"],
      "retry re-executes the failed suite AND the never-run one; nothing wrongly skips",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent per-suite writers (e.g. two shard lanes in one run, or an orphaned killed run overlapping a fresh retry) merge via read-merge-write without dropping or corrupting either record", async () => {
  const root = makeFixtureRepo();
  const storePath = join(root, "store.json");
  try {
    const plan1 = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    // Two independent writers persist DIFFERENT suites' outcomes around the
    // same time — modeling two shard lanes in one process (each
    // recordRunOutcomes call is synchronous end-to-end, so calls cannot
    // interleave mid-write) or two separate orphaned/fresh-retry processes
    // (each call re-reads the store at save time). Neither writer knows
    // about the other's suite.
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: plan1.fingerprints,
      outcomes: [{ file: "tests/a.test.ts", passed: true, flaky: false, durationMs: 120 }],
      fullRunGreen: false,
      now: NOW,
    });
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: plan1.fingerprints,
      outcomes: [{ file: "tests/b.test.ts", passed: true, flaky: false, durationMs: 90 }],
      fullRunGreen: false,
      now: NOW,
    });
    const { store } = loadGreenStore(storePath);
    assert.equal(store.records["tests/a.test.ts"]?.verdict, "green", "the first writer's record survives the second writer's write");
    assert.equal(store.records["tests/b.test.ts"]?.verdict, "green", "the second writer's record is also present");
    assert.equal(Object.keys(store.records).length, 2, "no phantom or duplicate records — exactly the two genuinely-recorded suites");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("per-suite persistence wiring: run-all persists each suite's outcome the moment it completes, in both the serial and sharded lane paths — not only after the whole sweep finishes", () => {
  const runAllSrc = readFileSync("tests/run-all.ts", "utf8");
  const perSuiteMarker = "outcomes: [{ file: t.file, passed, flaky: passed && attempts > 1, durationMs: elapsedMs }],";
  const perSuiteCount = runAllSrc.split(perSuiteMarker).length - 1;
  assert.equal(
    perSuiteCount,
    2,
    "exactly one per-suite persistence call site in the serial loop and one in the sharded lane runner (Task #5306) — a regression back to end-of-sweep-only persistence, or a widened batch flush, changes this count",
  );

  const totalCallSites = runAllSrc.split("recordRunOutcomes({").length - 1;
  assert.equal(
    totalCallSites,
    4,
    "4 call sites total: per-suite (serial), per-suite (lane), incomplete-shard invalidation, and the final full write — the last two remain the closing end-of-sweep safety net",
  );

  const laneStart = runAllSrc.indexOf("async function runLane(");
  const laneEnd = runAllSrc.indexOf("end Task #5029 sharded lane runner");
  assert.ok(laneStart > 0 && laneEnd > laneStart, "locates the runLane function body");
  assert.ok(
    runAllSrc.slice(laneStart, laneEnd).includes(perSuiteMarker),
    "runLane persists each suite's outcome inside its own loop body, before the lane's promise resolves — required for the sharded path to survive a mid-sweep kill",
  );

  const serialLoopStart = runAllSrc.indexOf("if (effectiveShardCount <= 1) {");
  const killWorkers = runAllSrc.indexOf("killAllBatchWorkers();", serialLoopStart);
  const firstPerSuiteInSerial = runAllSrc.indexOf(perSuiteMarker, serialLoopStart);
  assert.ok(serialLoopStart > 0 && killWorkers > 0 && firstPerSuiteInSerial > 0, "locates the serial per-suite loop");
  assert.ok(
    firstPerSuiteInSerial < killWorkers,
    "serial path persists each suite's outcome inside the per-suite loop, before batch workers are torn down at the end of the sweep",
  );

  // The end-of-sweep safety net must remain intact and unconditional.
  assert.ok(
    runAllSrc.includes("Invalidate every selected suite's prior green"),
    "incomplete-shard invalidation still overwrites every selected suite's outcome at end-of-sweep, including any per-suite green written during this same untrustworthy run",
  );
  assert.ok(
    runAllSrc.includes("toRun.length === selected.length"),
    "fullRunGreen stamping still gates on whole-sweep completion — a whole-sweep concern, never a per-suite write",
  );
});

test("skip audit manifest is written with per-suite decisions", async () => {
  const root = makeFixtureRepo();
  const storePath = join(root, "store.json");
  const auditPath = join(root, "audit.json");
  try {
    const plan = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B, SUITE_DB],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    writeSkipAudit(plan, auditPath);
    assert.ok(existsSync(auditPath));
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    assert.equal(audit.mode, "smoke");
    assert.equal(audit.executed, 3);
    assert.equal(audit.skipped, 0);
    assert.equal(audit.decisions.length, 3);
    assert.ok(audit.decisions.some((d: { file: string }) => d.file === "tests/a.test.ts"));
    assert.ok(audit.decisions.every((d: { reason: string }) => typeof d.reason === "string" && d.reason.length > 0));

    // Task #4081: the audit records the migration-classification split so
    // drift (pure suites silently turning DB-sensitive) is visible in run
    // summaries, not only when the pin test fires.
    assert.equal(plan.migrationSensitiveCount, 1, "only the DATABASE_URL-reading fixture suite is sensitive");
    assert.equal(plan.migrationInsensitiveCount, 2);
    assert.equal(plan.migrationUnclassifiedCount, 0);
    // Task #4503: the table-scoped vs full-scope split is audited too. The
    // dbClient fixture references no known table → pinned full scope.
    assert.equal(plan.migrationTableScopedCount, 0);
    assert.equal(plan.migrationFullScopeCount, 1);
    assert.equal(audit.migrationSensitiveCount, 1);
    assert.equal(audit.migrationInsensitiveCount, 2);
    assert.equal(audit.migrationUnclassifiedCount, 0);
    assert.equal(audit.migrationTableScopedCount, 0);
    assert.equal(audit.migrationFullScopeCount, 1);
    // Task #4595: realized-skip counters — nothing skipped on a first run.
    assert.equal(plan.migrationTableScopedSkippedCount, 0);
    assert.equal(plan.migrationFullScopeSkippedCount, 0);
    assert.equal(audit.migrationTableScopedSkippedCount, 0);
    assert.equal(audit.migrationFullScopeSkippedCount, 0);
    const summary = formatIncrementalSummary(plan).join("\n");
    assert.ok(
      summary.includes("migration classification: 1 DB-sensitive (0 table-scoped, 1 full-scope), 2 insensitive, 0 unclassified"),
      `summary carries the classification split, got:\n${summary}`,
    );
    assert.ok(
      summary.includes("migration-scoping realized skips: 0 table-scoped, 0 full-scope DB-sensitive suite(s) skipped this run"),
      `summary carries the realized-skip line, got:\n${summary}`,
    );

    // Task #4595 — realized skips: record every suite green, replan on
    // identical inputs, and the skipped DB-sensitive suites are counted by
    // scope (widgets = table-scoped, dbClient = full-scope). This is the
    // per-run number the sweep report trends to prove the #4503 scoping is
    // still saving re-runs.
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: plan.fingerprints,
      outcomes: [SUITE_A, SUITE_B, SUITE_DB].map((s) => ({
        file: s.file,
        passed: true,
        flaky: false,
        durationMs: 10,
      })),
      fullRunGreen: false,
      now: NOW,
    });
    const plan2 = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B, SUITE_DB, SUITE_WIDGETS],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    // widgets has no green record yet → executes; the other three skip.
    assert.equal(plan2.skippedFiles.length, 3, `expected 3 skips, decisions: ${JSON.stringify(plan2.decisions)}`);
    assert.equal(plan2.migrationTableScopedSkippedCount, 0, "widgets (table-scoped) executed, not skipped");
    assert.equal(plan2.migrationFullScopeSkippedCount, 1, "db.test.ts (full-scope) skipped");
    // Now green-record widgets too → the table-scoped realized skip appears.
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: plan2.fingerprints,
      outcomes: [{ file: SUITE_WIDGETS.file, passed: true, flaky: false, durationMs: 10 }],
      fullRunGreen: false,
      now: NOW,
    });
    const plan3 = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B, SUITE_DB, SUITE_WIDGETS],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    assert.equal(plan3.skippedFiles.length, 4);
    assert.equal(plan3.migrationTableScopedSkippedCount, 1);
    assert.equal(plan3.migrationFullScopeSkippedCount, 1);
    writeSkipAudit(plan3, auditPath);
    const audit3 = JSON.parse(readFileSync(auditPath, "utf8"));
    assert.equal(audit3.migrationTableScopedSkippedCount, 1);
    assert.equal(audit3.migrationFullScopeSkippedCount, 1);
    const summary3 = formatIncrementalSummary(plan3).join("\n");
    assert.ok(
      summary3.includes("migration-scoping realized skips: 1 table-scoped, 1 full-scope DB-sensitive suite(s) skipped this run"),
      `summary carries realized skips, got:\n${summary3}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3b. Committed green baseline: publish + seed (main → task environments)
// ---------------------------------------------------------------------------

test("seed-from-baseline: a fresh environment inherits main's greens and skips matching suites", async () => {
  const root = makeFixtureRepo();
  const storePath = join(root, "store.json");
  try {
    // Compute the real fingerprints "main" would have recorded.
    const fps = await fingerprintsFor(root, [SUITE_A, SUITE_B]);
    writeFileSync(
      join(root, DEFAULT_GREEN_BASELINE_PATH),
      JSON.stringify({
        schemaVersion: GREEN_STORE_SCHEMA_VERSION,
        fingerprintAlgo: FINGERPRINT_ALGO_VERSION,
        publishedAt: NOW.toISOString(),
        records: {
          "tests/a.test.ts": {
            fingerprint: fps.get("tests/a.test.ts"),
            verdict: "green",
            flaky: false,
            durationMs: 800,
            recordedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
            mode: "smoke",
          },
        },
      }),
    );
    const plan = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    assert.ok(plan.notes.some((n) => n.includes("seeded 1 green record(s) from committed baseline")), `seed note present, got: ${plan.notes}`);
    assert.deepEqual(plan.skippedFiles, ["tests/a.test.ts"], "baseline green with matching fingerprint skips");
    assert.deepEqual([...plan.executeFiles], ["tests/b.test.ts"], "suite absent from baseline executes");
    // The seed is materialized so recordRunOutcomes' read-merge-write keeps it.
    const { store } = loadGreenStore(storePath);
    assert.equal(store.records["tests/a.test.ts"]?.verdict, "green", "seed persisted to the local store");
    assert.equal(store.lastFullRunGreenAt, null, "lastFullRunGreenAt is NEVER inherited from the baseline");

    // A local diff still forces the seeded suite to run (fingerprint mismatch).
    writeFileSync(join(root, "src", "util.ts"), "export const util = () => 9;\n");
    const planDiff = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    assert.deepEqual([...planDiff.executeFiles], ["tests/a.test.ts"], "task's own diff overrides the inherited green");

    // TEST_GREEN_SEED_FROM_BASELINE=0 opts out entirely.
    rmSync(storePath, { force: true });
    const planOptOut = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: { TEST_GREEN_SEED_FROM_BASELINE: "0" },
      now: NOW,
      coreRules: NO_CORE,
    });
    assert.equal(planOptOut.executeFiles.size, 1, "opt-out ignores the baseline");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("baseline rails: version mismatch discards; failures never seed; non-empty local store wins; mode 'all' integrity guard unaffected", async () => {
  const root = makeFixtureRepo();
  const storePath = join(root, "store.json");
  const baselinePath = join(root, DEFAULT_GREEN_BASELINE_PATH);
  try {
    const fps = await fingerprintsFor(root, [SUITE_A]);
    const fpA = fps.get("tests/a.test.ts")!;
    const rec = (verdict: "green" | "failed", fingerprint = fpA) => ({
      fingerprint,
      verdict,
      flaky: false,
      durationMs: 100,
      recordedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      mode: "smoke",
    });

    // Schema/algo mismatch → discarded wholesale, exactly like the local store.
    writeFileSync(
      baselinePath,
      JSON.stringify({ schemaVersion: 999, fingerprintAlgo: "fp-v0", publishedAt: NOW.toISOString(), records: { "tests/a.test.ts": rec("green") } }),
    );
    const mismatch = loadGreenBaseline(baselinePath);
    assert.equal(mismatch.baseline, null, "mismatched baseline discarded");
    assert.ok(mismatch.note?.includes("mismatch"));
    const planMismatch = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    assert.equal(planMismatch.executeFiles.size, 1, "mismatched baseline seeds nothing → executes");

    // Corrupt JSON → ignored, fall open.
    writeFileSync(baselinePath, "{ nope !!!");
    assert.equal(loadGreenBaseline(baselinePath).baseline, null, "corrupt baseline ignored");
    // Missing baseline → null with no note (normal before main first publishes).
    rmSync(baselinePath, { force: true });
    assert.deepEqual(loadGreenBaseline(baselinePath), { baseline: null, note: null });

    // A "failed" record in the baseline is dropped at load — failure never seeds.
    writeFileSync(
      baselinePath,
      JSON.stringify({
        schemaVersion: GREEN_STORE_SCHEMA_VERSION,
        fingerprintAlgo: FINGERPRINT_ALGO_VERSION,
        publishedAt: NOW.toISOString(),
        records: { "tests/a.test.ts": rec("failed") },
      }),
    );
    const failedOnly = loadGreenBaseline(baselinePath);
    assert.deepEqual(failedOnly.baseline?.records, {}, "failed records never survive the baseline load");
    rmSync(storePath, { force: true });
    const planFailed = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    assert.equal(planFailed.executeFiles.size, 1, "a baseline failure cannot make anything skip");

    // A NON-empty local store is never overwritten: a local failure beats a
    // baseline green for the same suite.
    writeFileSync(
      baselinePath,
      JSON.stringify({
        schemaVersion: GREEN_STORE_SCHEMA_VERSION,
        fingerprintAlgo: FINGERPRINT_ALGO_VERSION,
        publishedAt: NOW.toISOString(),
        records: { "tests/a.test.ts": rec("green") },
      }),
    );
    writeFileSync(
      storePath,
      JSON.stringify({
        schemaVersion: GREEN_STORE_SCHEMA_VERSION,
        fingerprintAlgo: FINGERPRINT_ALGO_VERSION,
        lastFullRunGreenAt: null,
        records: { "tests/a.test.ts": rec("failed") },
      }),
    );
    const planLocalWins = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    assert.equal(planLocalWins.executeFiles.size, 1, "local failed record wins over baseline green");
    assert.ok(!planLocalWins.notes.some((n) => n.includes("seeded")), "no seeding when local store is non-empty");

    // Seeding never satisfies the mode-"all" integrity guard.
    rmSync(storePath, { force: true });
    const planAll = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "all",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    assert.ok(planAll.skippingDisabledReason?.includes("no full-suite green"), "integrity guard still fires in a seeded env");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishGreenBaseline snapshots ONLY green records; round-trips through the seeder", async () => {
  const root = makeFixtureRepo();
  const storePath = join(root, "store.json");
  const baselinePath = join(root, DEFAULT_GREEN_BASELINE_PATH);
  try {
    const plan = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    recordRunOutcomes({
      storePath,
      mode: "smoke",
      fingerprints: plan.fingerprints,
      outcomes: [
        { file: "tests/a.test.ts", passed: true, flaky: false, durationMs: 100 },
        { file: "tests/b.test.ts", passed: false, flaky: false, durationMs: 100 },
      ],
      fullRunGreen: false,
      now: NOW,
    });
    const pub = publishGreenBaseline({ storePath, baselinePath, now: NOW });
    assert.equal(pub.published, true);
    assert.equal(pub.count, 1, "only the green record is published");
    const raw = JSON.parse(readFileSync(baselinePath, "utf8"));
    assert.equal(raw.schemaVersion, GREEN_STORE_SCHEMA_VERSION);
    assert.equal(raw.fingerprintAlgo, FINGERPRINT_ALGO_VERSION);
    assert.equal(raw.publishedAt, NOW.toISOString());
    assert.equal(raw.records["tests/a.test.ts"].verdict, "green");
    assert.equal(raw.records["tests/b.test.ts"], undefined, "failed suite is absent from the baseline");

    // Round-trip: a fresh environment seeded from this snapshot skips A and
    // executes B (absent), on identical inputs.
    rmSync(storePath, { force: true });
    const seeded = await planIncrementalRun({
      suites: [SUITE_A, SUITE_B],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: new Date(NOW.getTime() + 60_000),
      coreRules: NO_CORE,
    });
    assert.deepEqual(seeded.skippedFiles, ["tests/a.test.ts"]);
    assert.deepEqual([...seeded.executeFiles], ["tests/b.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan surfaces committed-baseline age (Task #4077 skip-health) and the summary prints it", async () => {
  const root = makeFixtureRepo();
  const storePath = join(root, "store.json");
  try {
    // No baseline at all → nulls + explicit "absent" summary line.
    const bare = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    assert.equal(bare.baselinePublishedAt, null);
    assert.equal(bare.baselineAgeDays, null);
    assert.ok(
      formatIncrementalSummary(bare).some((l) => l.includes("baseline: absent or unreadable")),
      "summary names the missing baseline",
    );

    // A 3-day-old committed baseline → age surfaces in the plan and summary,
    // even though it has no records to seed (skip-health is independent of
    // seeding).
    const publishedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(root, DEFAULT_GREEN_BASELINE_PATH),
      `${JSON.stringify({
        schemaVersion: GREEN_STORE_SCHEMA_VERSION,
        fingerprintAlgo: FINGERPRINT_ALGO_VERSION,
        publishedAt,
        records: {},
      })}\n`,
    );
    const plan = await planIncrementalRun({
      suites: [SUITE_A],
      mode: "smoke",
      forceAll: false,
      repoRoot: root,
      storePath,
      env: {},
      now: NOW,
      coreRules: NO_CORE,
    });
    assert.equal(plan.baselinePublishedAt, publishedAt);
    assert.ok(plan.baselineAgeDays !== null && Math.abs(plan.baselineAgeDays - 3) < 0.01, `age ≈ 3d, got ${plan.baselineAgeDays}`);
    const summary = formatIncrementalSummary(plan).join("\n");
    assert.ok(summary.includes("committed green baseline age 3.0d"), `summary carries the age, got:\n${summary}`);
    assert.ok(summary.includes(publishedAt), "summary carries the publish stamp");
    // Task #4437 — stale baseline (3d > 2d threshold) must emit an unmissable banner.
    assert.ok(
      summary.includes("⚠️") && summary.includes("BASELINE STALE"),
      `stale baseline triggers ⚠️ banner in summary, got:\n${summary}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("baseline single-writer wiring: publish is env-gated in run-all, armed only by the nightly scheduler, and the .gitignore policy names the committed path", () => {
  // Lockstep guard (merge-surface protection): task-branch test runs must
  // never write tests/green-baseline.json. That holds because (a) the only
  // production call site of publishGreenBaseline is run-all.ts, gated on
  // TEST_GREEN_BASELINE_PUBLISH=1, and (b) the only code that SETS that env
  // is the nightly sweep scheduler, which runs solely in the main dev
  // workspace. If this test fails, a second writer or ungated publish path
  // was introduced — that re-creates the merge surface Task #3791 banned.
  const runAll = readFileSync("tests/run-all.ts", "utf8");
  assert.ok(runAll.includes('process.env.TEST_GREEN_BASELINE_PUBLISH === "1"'), "run-all gates publish on the env flag");
  assert.ok(runAll.includes("publishGreenBaseline({"), "run-all is the publish call site");
  assert.ok(
    runAll.indexOf("publishGreenBaseline({") === runAll.lastIndexOf("publishGreenBaseline({"),
    "exactly one publish call site in run-all",
  );
  // The green publish is deliberately NOT gated on ordinary test failures:
  // requiring a fully-green nightly froze the baseline for days whenever main
  // carried a few reds. An explicit incomplete-verification guard is required,
  // however, because a partial shard result is not trustworthy evidence.
  assert.ok(
    runAll.includes('if (plan && process.env.TEST_GREEN_BASELINE_PUBLISH === "1" && !incompleteShardResults) {'),
    "green publish allows ordinary reds but refuses incomplete verification",
  );

  const scheduler = readFileSync("server/services/regressionSweepScheduler.ts", "utf8");
  assert.ok(scheduler.includes('TEST_GREEN_BASELINE_PUBLISH: "1"'), "nightly scheduler arms the publish flag");
  // Task #4437 — catch-up arm exports: callable entrypoint + durable telemetry paths + thresholds.
  assert.ok(
    scheduler.includes("export async function runRegressionSweepNow"),
    "scheduler exports callable sweep entrypoint (unblocks Task #2625 without opening a second publish arm)",
  );
  assert.ok(
    scheduler.includes("export const LAST_TICK_STATE_PATH"),
    "scheduler exports durable last-tick state path (makes 'did the nightly run?' answerable from disk)",
  );
  assert.ok(
    scheduler.includes("export const CATCHUP_BASELINE_AGE_THRESHOLD_DAYS"),
    "scheduler exports catch-up baseline-age threshold",
  );
  assert.ok(
    scheduler.includes("export const DEFAULT_WATCHDOG_STALENESS_STATE_PATH"),
    "scheduler exports watchdog staleness state path (independent of tick state)",
  );

  // No other production code touches the flag or the writer. Task #3922
  // extended the sanctioned chain: run-all publishes the RED manifest under
  // the same flag (tests/redManifest.ts itself deliberately avoids the
  // literal — it receives booleans — so it stays OUT of this list), and
  // tests/upstream-red-attribution.test.ts pins that wiring.
  const hits = execSync(
    "grep -rl 'TEST_GREEN_BASELINE_PUBLISH' server tests scripts client shared 2>/dev/null || true",
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    hits,
    [
      // READER/sanitizer only: the long-run wrapper deletes any inherited
      // publisher arm before spawning a validation child; it never sets it.
      "scripts/long-run-validation.ts",
      // Doc comment naming the sanctioned publisher (prose reference in
      // the SweepReport field docs — not a writer).
      "server/services/regressionSweep.ts",
      "server/services/regressionSweepScheduler.ts",
      // Quarantine-stage guard suite: READS the literal to verify every
      // saveQuarantineLedger call site sits inside the publish guard —
      // a reader enforcing the single writer, not a second arm.
      "tests/flake-quarantine-state.test.ts",
      // Quarantine ledger module: header docs pin the single writer
      // (run-all's publish block). (The quarantine stage landed upstream
      // without list entries; reconciled here — same pattern as the
      // 2026-08-11 reconciliation below.)
      "tests/flakeQuarantine.ts",
      // Task #5030's deferral guard: READS the literal to prove the
      // rotation-day deferral block never engages on the publish arm
      // (the nightly must measure the full universe).
      "tests/full-lane-deferral.test.ts",
      "tests/incremental-green-skip.test.ts",
      // READER guard: verifies the long-run wrapper strips inherited
      // publisher state before any focused/control child can start.
      "tests/long-run-validation.test.ts",
      // Task #4501's canary suite asserts the canary script does NOT
      // reference the flag — the asserting source necessarily contains
      // the literal. A reader, not a second publish arm.
      "tests/post-merge-canary.test.ts",
      // Task #4437's catch-up suite pins buildSweepSpawnEnv's flag
      // handling (arm on main, strip inherited values elsewhere) — it
      // READS the literal to test the sanctioned writer, it is not a
      // second publish arm. (Both landed upstream 2026-08-11 without
      // list entries; reconciled here.)
      "tests/regression-sweep-catchup.test.ts",
      "tests/run-all.ts",
      "tests/suiteFingerprint.ts",
      "tests/upstream-red-attribution.test.ts",
    ],
    "publish flag referenced only by the sanctioned writer chain",
  );

  // .gitignore policy comment updated in lockstep with the committed path.
  const gitignore = readFileSync(".gitignore", "utf8");
  assert.ok(gitignore.includes("tests/green-baseline.json"), ".gitignore Task #3791 comment names the committed baseline");
  assert.equal(DEFAULT_GREEN_BASELINE_PATH, "tests/green-baseline.json");
});

test("REPO INTEGRATION: the committed baseline snapshot exists, is valid, and seeds a fresh environment's empty store", async () => {
  // Unlike the fixture tests above, this runs against the REAL repository:
  // it proves that an environment provisioned from this repo (task envs get
  // a full copy of main's tree) actually has a committed, schema-valid
  // tests/green-baseline.json and that the planner seeds an empty local
  // store from it — no test-manufactured baseline involved.
  const { baseline, note } = loadGreenBaseline(DEFAULT_GREEN_BASELINE_PATH);
  assert.equal(note, null, `committed baseline must load cleanly, got: ${note}`);
  assert.ok(baseline, "tests/green-baseline.json is committed and schema/algo-valid");
  const count = Object.keys(baseline!.records).length;
  assert.ok(count > 0, "committed baseline carries at least one green record");
  for (const rec of Object.values(baseline!.records)) {
    assert.equal(rec.verdict, "green", "committed baseline contains ONLY green records");
  }

  const tmp = mkdtempSync(join(tmpdir(), "green-baseline-seed-"));
  try {
    const storePath = join(tmp, "store.json");
    const plan = await planIncrementalRun({
      suites: [{ file: "tests/incremental-green-skip.test.ts" }],
      mode: "smoke",
      forceAll: false,
      storePath,
      env: {},
      coreRules: NO_CORE,
    });
    assert.ok(
      plan.notes.some((n) => n.includes(`seeded ${count} green record(s) from committed baseline`)),
      `empty store seeds from the committed snapshot, notes: ${plan.notes}`,
    );
    const { store } = loadGreenStore(storePath);
    assert.equal(Object.keys(store.records).length, count, "seed materialized into the local store");
    assert.equal(store.lastFullRunGreenAt, null, "full-green marker never inherited");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Wiring contracts: core rules, output line, store constants
// ---------------------------------------------------------------------------

test("this guard test is itself in the always-run core (the skip layer can never skip its own guard)", () => {
  assert.ok(coreReason("tests/incremental-green-skip.test.ts", DEFAULT_CORE_RULES));
  // The lint-style suites that scan the repo via fs (invisible to import
  // tracing) stay core too — spot-check the pattern rule.
  assert.ok(coreReason("tests/lint-sql-array-bindings.test.ts", DEFAULT_CORE_RULES));
});

test("formatExecutedSkippedLine emits the required audit line verbatim", () => {
  assert.equal(formatExecutedSkippedLine(12, 240), "executed 12, skipped 240 (green on identical inputs)");
});

test("store constants: schema is versioned so a runner change invalidates wholesale", () => {
  assert.equal(typeof GREEN_STORE_SCHEMA_VERSION, "number");
  assert.ok(FINGERPRINT_ALGO_VERSION.startsWith("fp-v"));
  const fresh = emptyGreenStore();
  assert.equal(fresh.schemaVersion, GREEN_STORE_SCHEMA_VERSION);
  assert.equal(fresh.fingerprintAlgo, FINGERPRINT_ALGO_VERSION);
});

// ---------------------------------------------------------------------------
// 5. Sweep report + scheduler cadence
// ---------------------------------------------------------------------------

function sweepResult(over: Partial<SweepTestResult>): SweepTestResult {
  return {
    name: over.name ?? "Some test",
    file: over.file ?? "tests/some.test.ts",
    outcome: over.outcome ?? "passed",
    quarantined: over.quarantined ?? false,
    attempts: over.attempts ?? 1,
    elapsedMs: over.elapsedMs ?? 1000,
    ...(over.failureReason ? { failureReason: over.failureReason } : {}),
  };
}

const SWEEP_META = {
  startedAt: "2026-08-05T03:30:00.000Z",
  finishedAt: "2026-08-05T03:55:00.000Z",
  mode: "regression" as const,
};

test("sweep report carries skippedGreen and the summary distinguishes executed vs skipped", () => {
  const report = buildSweepReport([sweepResult({})], {
    ...SWEEP_META,
    skippedGreen: 3,
    skippedGreenFiles: ["tests/x.test.ts", "tests/y.test.ts", "tests/z.test.ts"],
  });
  assert.equal(report.skippedGreen, 3);
  assert.deepEqual(report.skippedGreenFiles?.length, 3);
  const text = summarizeSweepResult(report);
  assert.ok(text.startsWith("Test run passed: 1 of 1 regression test(s) green."), "verdict line format untouched");
  assert.ok(text.includes("Skipped 3 suite(s) green on identical inputs"));

  // Zero skips (or a pre-#3791 report) → no skip line at all.
  const noSkips = buildSweepReport([sweepResult({})], SWEEP_META);
  assert.equal(noSkips.skippedGreen, 0);
  assert.ok(!summarizeSweepResult(noSkips).includes("Skipped"));
});

test("incomplete sweep records fail closed and render as runner verification loss, not test-code red", () => {
  const report = buildSweepReport(
    [
      sweepResult({ name: "Completed", file: "tests/completed.test.ts" }),
      sweepResult({
        name: "Lost lane",
        file: "tests/lost.test.ts",
        outcome: "incomplete",
        attempts: 0,
        elapsedMs: 0,
        failureReason: "no terminal result returned by its shard lane",
      }),
    ],
    SWEEP_META,
  );
  assert.equal(report.incomplete, 1);
  assert.equal(report.verificationComplete, false);
  assert.equal(report.hardFailed, 0, "a lane loss is not a test-code failure for red-manifest attribution");
  assert.equal(reportIndicatesFailure(report), true, "incomplete execution must fail the sweep");
  const text = summarizeSweepResult(report);
  assert.ok(text.startsWith("Test run INCOMPLETE: 1 of 2 regression test(s) were not verified."));
  assert.ok(text.includes("Incomplete verification (runner/lane failure, not a test failure):"));
  assert.ok(text.includes("Lost lane (no terminal result returned by its shard lane)"));
});

test("pre-#3791 report JSON (no skippedGreen) still parses and summarizes", () => {
  const legacy = JSON.stringify({
    startedAt: SWEEP_META.startedAt,
    finishedAt: SWEEP_META.finishedAt,
    mode: "regression",
    total: 1,
    passed: 1,
    hardFailed: 0,
    quarantinedFailed: 0,
    flaky: 0,
    verificationComplete: true,
    results: [sweepResult({})],
    hardFailedNames: [],
    quarantinedFailedNames: [],
    flakyNames: [],
  });
  const parsed = parseSweepReport(legacy);
  assert.ok(parsed, "legacy report parses");
  assert.ok(!summarizeSweepResult(parsed!).includes("Skipped"), "no skip line for legacy reports");
});

test("weekly full-integrity cadence: Sunday 03:30 ET forces the full run, weeknights stay incremental", () => {
  // 2026-08-09 is a Sunday; 03:30 EDT = 07:30 UTC.
  assert.equal(isFullIntegritySweepDate(new Date("2026-08-09T07:30:00.000Z")), true);
  // Monday 03:30 EDT → incremental.
  assert.equal(isFullIntegritySweepDate(new Date("2026-08-10T07:30:00.000Z")), false);
  // UTC-Sunday but still Saturday evening in New York → NOT the integrity run
  // (the cron fires at 03:30 America/New_York, so the day check must use ET).
  assert.equal(isFullIntegritySweepDate(new Date("2026-08-09T01:00:00.000Z")), false);
});

test("buildSweepRunArgs: incremental weeknights, --force-all on the integrity night", () => {
  assert.deepEqual(buildSweepRunArgs("/tmp/report.json", false), [
    "tests/run-all.ts",
    "--regression",
    "--sweep",
    "--json-report=/tmp/report.json",
  ]);
  assert.deepEqual(buildSweepRunArgs("/tmp/report.json", true), [
    "tests/run-all.ts",
    "--regression",
    "--sweep",
    "--json-report=/tmp/report.json",
    "--force-all",
  ]);
});

// ---------------------------------------------------------------------------
// 7. Task #4101 — repeat-poison detection: `<build error: …>` poisonings are
// tracked across consecutive audits and warn loudly once the same file
// repeats, closing the runtime window the merge-time parseability lint
// cannot cover (nightly sweep on main, task envs mid-work).
// ---------------------------------------------------------------------------

test("extractPoisonFromReason: build errors extract; plain unresolvable imports never alert", () => {
  const hit = extractPoisonFromReason(
    'closure member tests/broken.test.ts has unresolvable import(s): <build error: Unexpected "}">',
  );
  assert.deepEqual(hit, ["tests/broken.test.ts", '<build error: Unexpected "}">']);
  assert.equal(
    extractPoisonFromReason(
      "closure member tests/shimmed.test.ts has unresolvable import(s): ./stubbed-at-runtime",
    ),
    null,
    "sanctioned shim-replaced imports must not alert",
  );
  assert.equal(extractPoisonFromReason("no green record in this environment"), null);
});

test("plan surfaces poisonedFiles even when run-level reasons mask decision text (force-all)", async () => {
  const root = makeFixtureRepo();
  try {
    writeFileSync(
      join(root, "tests", "broken.test.ts"),
      'import { util } from "../src/util";\nconst r = util();\nr = 2;\nexport { r };\n',
    );
    const suites: SuiteLike[] = [SUITE_A, { file: "tests/broken.test.ts" }];
    const plan = await planIncrementalRun({ suites, mode: "smoke", forceAll: false, repoRoot: root });
    assert.equal(plan.poisonObservable, true);
    assert.ok(
      plan.poisonedFiles["tests/broken.test.ts"]?.includes("<build error"),
      `poisoned file recorded with error text, got: ${JSON.stringify(plan.poisonedFiles)}`,
    );
    // force-all replaces every decision reason with the run-level one — the
    // poison set must come from the computation, not the decisions.
    const forced = await planIncrementalRun({ suites, mode: "smoke", forceAll: true, repoRoot: root });
    assert.ok(
      forced.poisonedFiles["tests/broken.test.ts"]?.includes("<build error"),
      "force-all run still observes the poisoning",
    );
    // Healed file drops out of the poison set.
    writeFileSync(join(root, "tests", "broken.test.ts"), "export const ok = 1;\n");
    const healed = await planIncrementalRun({ suites, mode: "smoke", forceAll: false, repoRoot: root });
    assert.deepEqual(healed.poisonedFiles, {}, "healed file no longer poisoned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updateSkipPoisonHistory: consecutive streaks warn at the threshold; healing resets; blind runs preserve", () => {
  const dir = mkdtempSync(join(tmpdir(), "poison-history-"));
  const historyPath = join(dir, "history.json");
  try {
    const poisonedPlan = {
      poisonedFiles: { "tests/broken.test.ts": '<build error: Unexpected "}">' },
      poisonObservable: true,
    };
    const cleanPlan = { poisonedFiles: {}, poisonObservable: true };
    const blindPlan = { poisonedFiles: {}, poisonObservable: false };

    // Runs 1..2: below the threshold of 3 — no warning yet.
    for (let i = 1; i <= POISON_REPEAT_THRESHOLD - 1; i++) {
      const r = updateSkipPoisonHistory({ plan: poisonedPlan, historyPath });
      assert.equal(r.poisonedThisRun, 1);
      assert.equal(r.warnings.length, 0, `run ${i}: below threshold, no warning`);
    }
    // A blind run (fingerprinting unavailable) must NOT reset the streak.
    const blind = updateSkipPoisonHistory({ plan: blindPlan, historyPath });
    assert.equal(blind.warnings.length, 0);
    // Run 3: threshold reached — loud warning naming file + error text.
    const third = updateSkipPoisonHistory({ plan: poisonedPlan, historyPath });
    assert.equal(third.warnings.length, 1, "threshold run warns");
    assert.equal(third.warnings[0].file, "tests/broken.test.ts");
    assert.equal(third.warnings[0].streak, POISON_REPEAT_THRESHOLD);
    assert.ok(third.warnings[0].error.includes("<build error"));
    const lines = formatRepeatPoisonWarnings(third.warnings);
    assert.ok(lines.some((l) => l.includes("REPEAT-POISONED")), "loud header line");
    assert.ok(lines.some((l) => l.includes("tests/broken.test.ts")), "names the file");
    assert.ok(lines.some((l) => l.includes('<build error: Unexpected "}">')), "carries the build error text");
    assert.equal(formatRepeatPoisonWarnings([]).length, 0, "quiet when nothing repeats");
    // A clean OBSERVED run clears the streak: the next poisoning starts at 1.
    updateSkipPoisonHistory({ plan: cleanPlan, historyPath });
    const restart = updateSkipPoisonHistory({ plan: poisonedPlan, historyPath });
    assert.equal(restart.warnings.length, 0, "streak restarted after a healed run");
    // Corrupt history falls open to a fresh one — never throws.
    writeFileSync(historyPath, "{ not json");
    const afterCorrupt = updateSkipPoisonHistory({ plan: poisonedPlan, historyPath });
    assert.equal(afterCorrupt.warnings.length, 0, "corrupt history restarts streaks silently");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

let failures = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${t.name}`);
    console.error(err);
  }
}
if (failures > 0) {
  console.error(`\n${failures} of ${tests.length} incremental green-skip test(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} incremental green-skip tests passed.`);
process.exit(0);
