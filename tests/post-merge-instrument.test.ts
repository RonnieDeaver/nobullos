/* test-registration
{
  "name": "Post-merge instrumentation + fingerprint skips (Task #4617)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4617: post-merge.sh's npm/schema-trio fingerprint skips are merge-critical — a fall-closed bug would silently skip real setup work and drift every environment (the 0117/0136 prod-drop class), and a lost write-ahead stamp would make outer-timeout SIGKILLs unattributable again. Fast fixture tests (tmpdir + injected deps, no DB, no spawned children).",
  "scanPaths": [
    "scripts/post-merge-instrument.mjs",
    "scripts/post-merge.sh",
    "migrations",
    "migrations/0085_readd_user_notifications_dedupe_unique_index.sql",
    "migrations/0108_add_google_ads_os.sql",
    "migrations/0117_add_sheet_workbook_dashboards.sql",
    "migrations/0138_drop_legacy_google_ads_os_tables.sql"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4617 — Guard tests for the post-merge instrumentation helper and its
 * wiring into scripts/post-merge.sh:
 *
 *   1. Skip decisions FALL OPEN: any missing/mismatched/erroring input means
 *      "run the phase". A skip is only ever honored on a recorded successful
 *      fingerprint match (npm additionally probes the installed tree; the
 *      trio additionally runs the to_regclass sentinel).
 *   2. The trio sentinel's protected-object extraction is comment-stripping
 *      and drop-aware (0108 creates the retired google_ads_* tables, 0138
 *      drops them — expecting dropped objects would disable skips forever;
 *      counting commented-out CREATEs would fabricate expectations).
 *   3. Write-ahead phase stamps: the in-flight phase is on disk BEFORE the
 *      phase command runs, so an untrappable SIGKILL still attributes it;
 *      an unfinished prior run lands in history as interrupted.
 *   4. post-merge.sh wiring: skip guards wrap the right phases, the trio
 *      fingerprint is recorded only AFTER the post-push re-apply completes,
 *      and the SAFE_MIGRATIONS array stays parseable and carries 0085 (the
 *      dedupe-index entry the first live sentinel run discovered missing).
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HISTORY_MAX_LINES,
  LAST_RUN_PATH,
  HISTORY_PATH,
  FINGERPRINT_STATE_PATH,
  appendHistory,
  beginRun,
  computeNpmFingerprint,
  computeProtectedObjects,
  computeTrioFingerprint,
  decideNpmSkip,
  decideTrioSkip,
  endRun,
  extractObjectOps,
  parseSafeMigrations,
  phaseEnd,
  phaseStart,
  realDeps,
  recordPhaseFingerprint,
  runTrioSentinel,
  stripSqlComments,
} from "../scripts/post-merge-instrument.mjs";

// ---------------------------------------------------------------------------
// Mini test runner
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

/** Build a throwaway repo root with the minimum layout the helper touches. */
function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "post-merge-instrument-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "migrations"), { recursive: true });
  mkdirSync(join(root, "shared"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  writeFileSync(join(root, "drizzle.config.ts"), "export default {};\n");
  writeFileSync(join(root, "shared", "schema.ts"), "export const x = 1;\n");
  writeFileSync(
    join(root, "migrations", "a.sql"),
    "CREATE TABLE IF NOT EXISTS sentinel_foo (id int);\n" +
      "CREATE UNIQUE INDEX IF NOT EXISTS sentinel_foo_uq ON sentinel_foo (id);\n",
  );
  writeFileSync(
    join(root, "scripts", "post-merge.sh"),
    '#!/bin/bash\nSAFE_MIGRATIONS=(\n  "migrations/a.sql"\n)\nfor f in x; do echo; done\n',
  );
  return root;
}

function fixtureDeps(root: string, overrides: Record<string, unknown> = {}) {
  return realDeps({
    root,
    env: {},
    spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    log: () => {},
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. SQL extraction: comments, drops, implicit index drops
// ---------------------------------------------------------------------------

test("stripSqlComments removes line and block comments", () => {
  const sql = "-- CREATE TABLE IF NOT EXISTS ghost (id int);\n/* CREATE TABLE IF NOT EXISTS ghost2 (id int); */\nCREATE TABLE IF NOT EXISTS real_table (id int);";
  const clean = stripSqlComments(sql);
  assert.ok(!clean.includes("ghost"), "line comment content must be stripped");
  assert.ok(!clean.includes("ghost2"), "block comment content must be stripped");
  assert.ok(clean.includes("real_table"), "real statements survive");
});

test("extractObjectOps: commented-out CREATE never counts (the 0067 disabled-index incident)", () => {
  // Migration 0067 carries its old CREATE UNIQUE INDEX only inside comments
  // (disabled 2026-05-26, re-added by 0085). Counting it would make the
  // sentinel expect an object no migration in the list creates.
  const sql =
    "-- Disabled: CREATE UNIQUE INDEX IF NOT EXISTS old_uniq ON t (a);\n" +
    "CREATE INDEX IF NOT EXISTS live_idx ON t (b);\n";
  const { creates } = extractObjectOps(sql);
  assert.deepEqual(
    creates.map((c: { name: string }) => c.name),
    ["live_idx"],
    "only the uncommented CREATE counts",
  );
});

test("extractObjectOps captures create table/index (with ON table) and multi-name drops", () => {
  const sql =
    'CREATE TABLE IF NOT EXISTS "tbl_a" (id int);\n' +
    "CREATE UNIQUE INDEX IF NOT EXISTS tbl_a_uq ON tbl_a (id);\n" +
    "DROP TABLE IF EXISTS old_one, old_two CASCADE;\n" +
    "DROP INDEX IF EXISTS stale_idx;\n";
  const { creates, drops } = extractObjectOps(sql);
  assert.deepEqual(creates, [
    { kind: "table", name: "tbl_a" },
    { kind: "index", name: "tbl_a_uq", onTable: "tbl_a" },
  ]);
  assert.deepEqual(drops, [
    { kind: "table", name: "old_one" },
    { kind: "table", name: "old_two" },
    { kind: "index", name: "stale_idx" },
  ]);
});

test("computeProtectedObjects: a later DROP TABLE removes the table AND its indexes (0108→0138 class)", () => {
  const create =
    "CREATE TABLE IF NOT EXISTS google_ads_pacing_store (id int);\n" +
    "CREATE UNIQUE INDEX IF NOT EXISTS google_ads_pacing_store_uq ON google_ads_pacing_store (id);\n" +
    "CREATE TABLE IF NOT EXISTS keeper (id int);\n";
  const drop = "DROP TABLE IF EXISTS google_ads_pacing_store CASCADE;\n";
  const net = computeProtectedObjects([create, drop]);
  assert.deepEqual(net.sort(), ["keeper"], "dropped table and its dependent index both leave the expected set");
});

test("computeProtectedObjects: drop-then-recreate across files nets to present", () => {
  const drop = "DROP TABLE IF EXISTS reborn;\n";
  const create = "CREATE TABLE IF NOT EXISTS reborn (id int);\n";
  assert.deepEqual(computeProtectedObjects([drop, create]), ["reborn"]);
});

test("real corpus: 0108+0117+0085 create / 0138 drops — net set pins the incident class", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const contents = [
    read("migrations/0108_add_google_ads_os.sql"),
    read("migrations/0117_add_sheet_workbook_dashboards.sql"),
    read("migrations/0085_readd_user_notifications_dedupe_unique_index.sql"),
    read("migrations/0138_drop_legacy_google_ads_os_tables.sql"),
  ];
  const net = new Set(computeProtectedObjects(contents));
  assert.ok(net.has("sheet_workbook_dashboards"), "0117's runtime-ensured table is protected");
  assert.ok(
    net.has("user_notifications_user_dedupe_unread_uniq"),
    "0085's dedupe index is protected (the object the first live sentinel run found missing from dev)",
  );
  assert.ok(!net.has("google_ads_pacing_store"), "0138-dropped table is NOT expected");
  assert.ok(
    ![...net].some((n) => n.startsWith("google_ads_pacing_store")),
    "indexes on 0138-dropped tables are NOT expected either",
  );
});

test("real corpus: every migration claiming post-merge/runtime reliance is listed in SAFE_MIGRATIONS (or explicitly justified)", () => {
  // Task #4625 — mechanizes the Task #4617 incident class: 0085 CLAIMED (in
  // its own comments) to be applied by the post-merge psql step but was never
  // listed in SAFE_MIGRATIONS, so drizzle push silently stripped its index
  // from dev while prod kept it. The trio sentinel only protects objects from
  // LISTED files, so an unlisted claiming migration is invisible to it.
  //
  // Signals are matched on whitespace-normalized, lowercased file content
  // (0085's own phrase is split across comment lines). Pure idempotency
  // claims ("safe under the post-merge runner", "can both apply it safely")
  // are deliberately NOT signals — those migrations' objects are owned by
  // shared/schema.ts and drizzle push re-creates them (see
  // audits/safe-migrations-sweep-2026-08-12.md for the per-file evidence).
  const RELIANCE_SIGNALS = [
    "not in shared/schema",
    "runtime-ensured",
    "bootstrap-managed",
    "applied by the post-merge",
    "drizzle push drops",
    "drizzle push won't create",
    "re-applied post-push",
  ];
  // Filename → written justification for staying UNLISTED. Empty today; any
  // future entry must cite an audit doc explaining why the sentinel need not
  // protect it.
  const JUSTIFIED_UNLISTED: Record<string, string> = {};
  const listed = new Set(parseSafeMigrations(readFileSync("scripts/post-merge.sh", "utf8")));
  const migrationFiles = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
  assert.ok(migrationFiles.length >= 150, `corpus sanity: expected the full migrations dir, got ${migrationFiles.length}`);
  const claiming: string[] = [];
  for (const f of migrationFiles) {
    // Strip SQL comment dashes BEFORE collapsing whitespace: 0085's phrase is
    // split across comment lines ("applied by\n-- the post-merge psql step").
    const norm = readFileSync(join("migrations", f), "utf8")
      .replace(/^\s*--/gm, " ")
      .replace(/\s+/g, " ")
      .toLowerCase();
    if (RELIANCE_SIGNALS.some((s) => norm.includes(s))) claiming.push(f);
  }
  // Self-test: the three known reliance-claiming migrations must be detected,
  // or the signal list has rotted and the guard is scanning air.
  for (const known of [
    "0085_readd_user_notifications_dedupe_unique_index.sql",
    "0117_add_sheet_workbook_dashboards.sql",
    "0149_restore_raw_comm_external_source_id_unique_idx.sql",
  ]) {
    assert.ok(claiming.includes(known), `signal self-test: expected ${known} to match a reliance signal`);
  }
  const unprotected = claiming.filter(
    (f) => !listed.has(`migrations/${f}`) && !(f in JUSTIFIED_UNLISTED),
  );
  assert.deepEqual(
    unprotected,
    [],
    `migration(s) claim post-merge/runtime application but are neither in SAFE_MIGRATIONS nor justified: ${unprotected.join(", ")} — add each to SAFE_MIGRATIONS in scripts/post-merge.sh (fully idempotent, 0085 is the model) or record a written justification here + in audits/`,
  );
});

// ---------------------------------------------------------------------------
// 2. parseSafeMigrations — real file + failure modes
// ---------------------------------------------------------------------------

test("parseSafeMigrations parses the real post-merge.sh (comments inside the array tolerated)", () => {
  const sh = readFileSync("scripts/post-merge.sh", "utf8");
  const entries = parseSafeMigrations(sh);
  assert.ok(entries.length >= 30, `expected a full list, got ${entries.length}`);
  assert.ok(entries.includes("migrations/0029_add_import_entity_suggestions.sql"), "first entry intact"); // fs-scan-inputs-ignore -- assert-only literal compared against parseSafeMigrations output, never an fs-read target
  assert.ok(
    entries.includes("migrations/0085_readd_user_notifications_dedupe_unique_index.sql"),
    "Task #4617: 0085 (dedupe index) must stay listed — its absence let drizzle push silently strip the index from dev",
  );
  assert.ok(
    entries.includes("migrations/20260807152551_drop_google_ads_connection.sql"), // fs-scan-inputs-ignore -- assert-only literal compared against parseSafeMigrations output, never an fs-read target
    "retired-connection drop entry intact",
  );
});

test("parseSafeMigrations throws on absent or empty arrays (callers fall open)", () => {
  assert.throws(() => parseSafeMigrations("#!/bin/bash\necho no array\n"));
  assert.throws(() => parseSafeMigrations("SAFE_MIGRATIONS=(\n)\n"));
});

// ---------------------------------------------------------------------------
// 3. npm-install skip decision — fall-open matrix
// ---------------------------------------------------------------------------

test("decideNpmSkip: no recorded state → run", () => {
  const root = makeFixtureRoot();
  try {
    const d = decideNpmSkip(fixtureDeps(root));
    assert.equal(d.skip, false);
    assert.match(d.reason, /no recorded successful/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("decideNpmSkip: recorded match + installed-tree probe → skip; probe missing → run", () => {
  const root = makeFixtureRoot();
  try {
    const deps = fixtureDeps(root);
    recordPhaseFingerprint(deps, "npm", computeNpmFingerprint(deps));
    // Probe absent → run.
    const noProbe = decideNpmSkip(deps);
    assert.equal(noProbe.skip, false);
    assert.match(noProbe.reason, /node_modules/);
    // Probe present → skip, with the canonical wording.
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".package-lock.json"), "{}");
    const withProbe = decideNpmSkip(deps);
    assert.equal(withProbe.skip, true);
    assert.match(withProbe.reason, /inputs unchanged since last successful run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("decideNpmSkip: manifest change, FORCE_ALL, and thrown reads all → run (fall open)", () => {
  const root = makeFixtureRoot();
  try {
    const deps = fixtureDeps(root);
    recordPhaseFingerprint(deps, "npm", computeNpmFingerprint(deps));
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".package-lock.json"), "{}");
    assert.equal(decideNpmSkip(deps).skip, true, "baseline: skip is honored");

    // Dependency manifest changed → run.
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.1" }));
    const changed = decideNpmSkip(deps);
    assert.equal(changed.skip, false);
    assert.match(changed.reason, /changed/);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));

    // Escape lever → run.
    const forced = decideNpmSkip(fixtureDeps(root, { env: { POST_MERGE_FORCE_ALL: "1" } }));
    assert.equal(forced.skip, false);
    assert.match(forced.reason, /POST_MERGE_FORCE_ALL/);

    // Reads throwing → run, never throw out of the decision. (The reason
    // wording depends on which layer catches — the state loader swallows a
    // dead disk into "no recorded state" — so assert only the fall-open.)
    const broken = decideNpmSkip(
      fixtureDeps(root, {
        readFile: () => {
          throw new Error("disk gone");
        },
      }),
    );
    assert.equal(broken.skip, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Schema-trio skip decision — sentinel probe + fall-open matrix
// ---------------------------------------------------------------------------

test("decideTrioSkip: recorded match + sentinel all-present → skip", () => {
  const root = makeFixtureRoot();
  try {
    const deps = fixtureDeps(root); // fake psql: status 0, empty stdout = nothing missing
    recordPhaseFingerprint(deps, "trio", computeTrioFingerprint(deps));
    const d = decideTrioSkip(deps);
    assert.equal(d.skip, true, d.reason);
    assert.match(d.reason, /protected objects present/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("decideTrioSkip: sentinel-reported missing objects → run, names disclosed", () => {
  const root = makeFixtureRoot();
  try {
    const deps = fixtureDeps(root, {
      spawn: () => ({ status: 0, stdout: "sentinel_foo_uq\n", stderr: "" }),
    });
    recordPhaseFingerprint(deps, "trio", computeTrioFingerprint(deps));
    const d = decideTrioSkip(deps);
    assert.equal(d.skip, false);
    assert.match(d.reason, /sentinel_foo_uq/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("decideTrioSkip: psql failure, fingerprint mismatch, no state, FORCE_ALL all → run", () => {
  const root = makeFixtureRoot();
  try {
    // No state → run.
    assert.equal(decideTrioSkip(fixtureDeps(root)).skip, false);

    const deps = fixtureDeps(root);
    recordPhaseFingerprint(deps, "trio", computeTrioFingerprint(deps));

    // psql probe fails → run (fall open).
    const psqlDead = decideTrioSkip(fixtureDeps(root, { spawn: () => ({ status: 1, stdout: "", stderr: "boom" }) }));
    assert.equal(psqlDead.skip, false);
    assert.match(psqlDead.reason, /psql probe failed/);

    // Schema input changed → run.
    writeFileSync(join(root, "shared", "schema.ts"), "export const x = 2;\n");
    const changed = decideTrioSkip(deps);
    assert.equal(changed.skip, false);
    assert.match(changed.reason, /changed/);
    writeFileSync(join(root, "shared", "schema.ts"), "export const x = 1;\n");

    // Escape lever → run.
    assert.equal(decideTrioSkip(fixtureDeps(root, { env: { POST_MERGE_FORCE_ALL: "1" } })).skip, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runTrioSentinel: unparseable SAFE_MIGRATIONS or zero extracted objects → not ok (fall open)", () => {
  const root = makeFixtureRoot();
  try {
    // Empty array in the script → parse throws → sentinel not ok.
    writeFileSync(join(root, "scripts", "post-merge.sh"), "#!/bin/bash\nSAFE_MIGRATIONS=(\n)\n");
    const parseDead = runTrioSentinel(fixtureDeps(root));
    assert.equal(parseDead.ok, false);

    // Array lists only a file whose statements are all commented out → zero
    // protected objects → not ok (an empty expectation set proves nothing).
    writeFileSync(join(root, "scripts", "post-merge.sh"), '#!/bin/bash\nSAFE_MIGRATIONS=(\n  "migrations/b.sql"\n)\n');
    writeFileSync(join(root, "migrations", "b.sql"), "-- CREATE TABLE IF NOT EXISTS ghost (id int);\n");
    const empty = runTrioSentinel(fixtureDeps(root));
    assert.equal(empty.ok, false);
    assert.match(empty.reason, /no protected objects/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Run/phase instrumentation — write-ahead stamps, interrupts, history trim
// ---------------------------------------------------------------------------

test("phase stamps are WRITE-AHEAD: the in-flight phase is on disk before the command runs", () => {
  const root = makeFixtureRoot();
  try {
    const deps = fixtureDeps(root);
    beginRun(deps, { mergeSha: "abc", mergeBase: "def" });
    phaseStart(deps, "drizzle-push");
    // Simulate the SIGKILL window: nothing else has happened, yet the stamp
    // must already be durable.
    const onDisk = JSON.parse(readFileSync(join(root, LAST_RUN_PATH), "utf8"));
    assert.equal(onDisk.mergeSha, "abc");
    assert.equal(onDisk.phases.length, 1);
    assert.equal(onDisk.phases[0].name, "drizzle-push");
    assert.equal(onDisk.phases[0].endedAt, null, "in-flight phase has no end stamp");

    phaseEnd(deps, "drizzle-push", { exit: 0 });
    endRun(deps, { exit: 0 });
    const finished = JSON.parse(readFileSync(join(root, LAST_RUN_PATH), "utf8"));
    assert.ok(finished.finishedAt, "endRun stamps finishedAt");
    assert.ok(finished.phases[0].endedAt, "phaseEnd stamps endedAt");
    assert.ok(finished.phases[0].durationMs >= 0, "duration computed");
    const history = readFileSync(join(root, HISTORY_PATH), "utf8").trim().split("\n");
    assert.equal(history.length, 1, "finished run appended to history once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unfinished prior run lands in history as interrupted, attributing the in-flight phase", () => {
  const root = makeFixtureRoot();
  try {
    const deps = fixtureDeps(root);
    beginRun(deps, { mergeSha: "run1", mergeBase: "" });
    phaseStart(deps, "npm-install");
    // No phaseEnd / endRun — the outer timeout SIGKILLed us here.
    beginRun(deps, { mergeSha: "run2", mergeBase: "" });
    const lines = readFileSync(join(root, HISTORY_PATH), "utf8").trim().split("\n");
    const interrupted = JSON.parse(lines[lines.length - 1]);
    assert.equal(interrupted.mergeSha, "run1");
    assert.equal(interrupted.interrupted, true);
    assert.equal(interrupted.interruptedPhase, "npm-install");
    // Interrupted runs never recorded fingerprints — both skips still fall open.
    assert.equal(decideNpmSkip(deps).skip, false);
    assert.equal(decideTrioSkip(deps).skip, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(`history is trimmed to ${HISTORY_MAX_LINES} lines`, () => {
  const root = makeFixtureRoot();
  try {
    const deps = fixtureDeps(root);
    for (let i = 0; i < HISTORY_MAX_LINES + 7; i++) appendHistory(deps, { runId: `r${i}` });
    const lines = readFileSync(join(root, HISTORY_PATH), "utf8").trim().split("\n");
    assert.equal(lines.length, HISTORY_MAX_LINES);
    assert.equal(JSON.parse(lines[lines.length - 1]).runId, `r${HISTORY_MAX_LINES + 6}`, "newest kept");
    assert.equal(JSON.parse(lines[0]).runId, "r7", "oldest trimmed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("should-skip decisions never write fingerprint state (only record-* does)", () => {
  const root = makeFixtureRoot();
  try {
    const deps = fixtureDeps(root);
    decideNpmSkip(deps);
    decideTrioSkip(deps);
    assert.ok(!existsSync(join(root, FINGERPRINT_STATE_PATH)), "no implicit state writes");
    recordPhaseFingerprint(deps, "npm", "fp");
    assert.ok(existsSync(join(root, FINGERPRINT_STATE_PATH)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. post-merge.sh wiring pins
// ---------------------------------------------------------------------------

test("post-merge.sh wiring: skip guards, write-ahead stamps, and trio-record ordering", () => {
  const sh = readFileSync("scripts/post-merge.sh", "utf8");

  // Skip guards wrap exactly the two approved phases.
  assert.ok(sh.includes('if node "$INSTR" should-skip-npm; then'), "npm skip guard present");
  assert.ok(sh.includes('if node "$INSTR" should-skip-trio; then'), "trio skip guard present");

  // Instrumentation lifecycle present and best-effort (|| true).
  assert.ok(sh.includes("begin-run"), "begin-run wired");
  assert.ok(/trap 'node "\$INSTR" end-run --exit=\$\? \|\| true' EXIT/.test(sh), "end-run trap wired");
  for (const phase of [
    "npm-install",
    "clean-scratch",
    "migrations-pre-apply",
    "drizzle-push",
    "migrations-re-apply",
    "merge-integrity",
    "route-inventory-refresh",
    "generated-artifact-refresh",
    "canary",
  ]) {
    assert.ok(sh.includes(`--phase=${phase}`), `phase ${phase} instrumented`);
  }

  // The trio fingerprint is recorded ONLY after the post-push re-apply loop —
  // recording earlier would let a skip absolve an unfinished trio (P8 class).
  const recordTrioAt = sh.indexOf("record-trio-success");
  const reApplyAt = sh.indexOf(">>> re-applying");
  assert.ok(recordTrioAt !== -1 && reApplyAt !== -1, "both markers exist");
  assert.ok(recordTrioAt > reApplyAt, "record-trio-success comes after the re-apply loop");

  // npm success recorded only after install (with one retry for transients).
  const recordNpmAt = sh.indexOf("record-npm-success");
  const retryAt = sh.indexOf("retrying once");
  assert.ok(recordNpmAt > retryAt && retryAt !== -1, "record-npm-success after the retry path");

  // Escape lever documented where operators will look.
  assert.ok(sh.includes("POST_MERGE_FORCE_ALL"), "escape lever documented in post-merge.sh");

  // Migration failures must name the failing file (three-failure diagnosis pain).
  assert.ok(sh.includes("migration apply FAILED: $f"), "failing migration file is named");

  // Transient database connection failures get a bounded retry at the
  // idempotent file boundary. Both pre-apply and re-apply must use the same
  // helper; the final failure still flows through the diagnostic above.
  assert.ok(sh.includes("POST_MERGE_PSQL_MAX_ATTEMPTS=3"), "psql retry count stays bounded");
  assert.ok(
    sh.includes("POST_MERGE_PSQL_CONNECT_TIMEOUT_SECONDS=10"),
    "each psql connection attempt has a fixed timeout",
  );
  assert.ok(sh.includes("apply_safe_migration()"), "safe-migration retry helper is defined");
  assert.equal(
    sh.match(/apply_safe_migration "\$f"/g)?.length,
    2,
    "pre-apply and re-apply both use the retry helper",
  );

  // Drizzle push wall time is logged diagnostic-only (never auto-killed).
  assert.ok(sh.includes("drizzle-kit push took"), "push timing logged");

  // Merge-SHA capture still precedes the npm phase (canary diff basis; the
  // header comments mention "npm install" earlier, so anchor on the guard).
  const shaAt = sh.indexOf("CANARY_MERGE_SHA=");
  const npmGuardAt = sh.indexOf('if node "$INSTR" should-skip-npm; then');
  assert.ok(shaAt !== -1 && npmGuardAt !== -1 && shaAt < npmGuardAt, "merge SHA captured before the npm phase");

  // Canary stays non-fatal.
  assert.ok(/npx tsx scripts\/post-merge-canary\.ts \|\| \{/.test(sh), "canary wrapper stays non-fatal");
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

console.log(`\n${tests.length - failures}/${tests.length} post-merge-instrument tests passed`);
process.exit(failures > 0 ? 1 : 0);
