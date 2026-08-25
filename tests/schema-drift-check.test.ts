/* test-registration
{
  "name": "Dev/prod schema-drift check — SAFE_MIGRATIONS netting, diff exclusions, alert outcomes (Task #4640)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4640: this suite guards the automated safety net that catches the 0085 incident class (drizzle push stripping raw-SQL objects from dev before a Publish diff drops them from prod). It also pins the SAFE_MIGRATIONS pending-drop netting against the real repo corpus, so a parser regression can't silently blind the nightly comparator. Fast, pure, in-memory (injected deps — no DB, no object storage, no network).",
  "scanPaths": ["server/services/schemaDriftCheck.ts", "scripts/post-merge.sh", "migrations"],
  "tier": "small"
}
test-registration */
/**
 * Task #4640 — unit coverage for the dev/prod schema-drift check:
 *  - SAFE_MIGRATIONS list parsing + net-pending-drop computation (drop wins
 *    unless re-created later; table drops net their known indexes);
 *  - the real repo corpus nets the 20260811155925 legacy-chat drops (the
 *    exact exclusions the 2026-08-12 manual audit applied);
 *  - diffCatalogs prod→dev-only direction with pending-drop exclusions and
 *    table-qualified constraint identity;
 *  - runSchemaDriftCheck outcome → notify dispatch mapping (drift /
 *    snapshot_missing / snapshot_stale / check_error alert with the stable
 *    dedupe key and outcome-specific failureType; clean marks recovered and
 *    never notifies) — the check is never silent.
 */
import "./helpers/forceTestEnv";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  LAST_RUN_MAX_AGE_MS,
  SCHEMA_DRIFT_DEDUPE_KEY,
  SCHEMA_DRIFT_LAST_RUN_STALE_DEDUPE_KEY,
  SNAPSHOT_MAX_AGE_MS,
  readLastSchemaDriftRun,
  runLastRunStalenessWatchdogOnce,
  type SchemaDriftLastRunStamp,
  __setSchemaDriftTestDeps,
  computePendingDrops,
  computePendingDropsFromRepo,
  diffCatalogs,
  isDriftEmpty,
  parseSafeMigrationsList,
  runSchemaDriftCheck,
  startSchemaDriftScheduler,
  stopSchemaDriftScheduler,
  type Catalog,
  type DevCatalogSnapshot,
} from "../server/services/schemaDriftCheck";

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function snapshot(over: Partial<DevCatalogSnapshot> = {}): DevCatalogSnapshot {
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    tables: ["users", "clients"],
    indexes: [{ name: "users_pkey", table: "users" }],
    constraints: [{ name: "users_pkey", table: "users" }],
    pendingDropTables: [],
    pendingDropIndexes: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// SAFE_MIGRATIONS parsing + netting
// ---------------------------------------------------------------------------

test("parseSafeMigrationsList extracts quoted entries and ignores comment parens", () => {
  const sh = `x=1\nSAFE_MIGRATIONS=(\n  # keep (Task #123)\n  "migrations/a.sql"\n  "migrations/b.sql"\n)\nrest`;
  assert.deepEqual(parseSafeMigrationsList(sh), ["migrations/a.sql", "migrations/b.sql"]); // fs-scan-inputs-ignore -- synthetic SAFE_MIGRATIONS fixture names parsed from an in-test string; no repo file is read
  assert.throws(() => parseSafeMigrationsList("no array here"));
});

test("computePendingDrops: drop stays pending unless re-created later in order", () => {
  const { tables } = computePendingDrops([
    "DROP TABLE IF EXISTS foo;",
    "CREATE TABLE IF NOT EXISTS bar (id int);",
    "DROP TABLE IF EXISTS bar;",
    "CREATE TABLE IF NOT EXISTS foo (id int);", // re-created → not pending
  ]);
  assert.deepEqual([...tables].sort(), ["bar"]);
});

test("computePendingDrops: a table drop nets its known indexes; explicit index drops count", () => {
  const { tables, indexes } = computePendingDrops([
    "CREATE UNIQUE INDEX IF NOT EXISTS foo_uq ON foo (name);",
    "CREATE INDEX IF NOT EXISTS other_idx ON other (x);",
    "DROP TABLE IF EXISTS foo;",
    "DROP INDEX IF EXISTS stray_idx;",
  ]);
  assert.deepEqual([...tables], ["foo"]);
  assert.deepEqual([...indexes].sort(), ["foo_uq", "stray_idx"]);
});

test("computePendingDrops ignores commented-out statements and non-idempotent forms", () => {
  const { tables } = computePendingDrops([
    "-- DROP TABLE IF EXISTS commented;\n/* DROP TABLE IF EXISTS blocked; */\nDROP TABLE plain_form;",
  ]);
  assert.equal(tables.size, 0);
});

test("real repo corpus nets the 20260811155925 legacy-chat drops (audit parity)", () => {
  // Runs against the actual scripts/post-merge.sh + migrations/ — the same
  // exclusions the 2026-08-12 manual audit applied. If the pending drops
  // ship in a Publish and the migration is delisted, this pins the new net.
  const { tables } = computePendingDropsFromRepo((rel) =>
    fs.existsSync(rel) ? fs.readFileSync(rel, "utf8") : null,
  );
  for (const t of ["messages", "conversations", "intake_stats"]) {
    assert.ok(tables.includes(t), `expected pending-drop table ${t}, got: ${tables.join(", ")}`);
  }
});

// ---------------------------------------------------------------------------
// diffCatalogs
// ---------------------------------------------------------------------------

test("diffCatalogs reports only prod→dev-only objects and applies pending-drop exclusions", () => {
  const prod: Catalog = {
    tables: ["users", "legacy_chat", "stripped_tbl"],
    indexes: [
      { name: "users_pkey", table: "users" },
      { name: "legacy_idx", table: "legacy_chat" },
      { name: "stripped_idx", table: "users" },
    ],
    constraints: [
      { name: "users_pkey", table: "users" },
      { name: "legacy_pkey", table: "legacy_chat" },
      { name: "stripped_con", table: "users" },
    ],
  };
  const dev = snapshot({
    tables: ["users", "dev_only_table"], // dev-only extras never alert
    pendingDropTables: ["legacy_chat"],
    pendingDropIndexes: [],
  });
  const diff = diffCatalogs(prod, dev);
  assert.deepEqual(diff.prodOnlyTables, ["stripped_tbl"]);
  assert.deepEqual(diff.prodOnlyIndexes, ["users.stripped_idx"]);
  assert.deepEqual(diff.prodOnlyConstraints, ["users.stripped_con"]);
});

test("diffCatalogs: constraints on prod-only tables fold into the table finding; identity is table-qualified", () => {
  const prod: Catalog = {
    tables: ["users", "orphan"],
    indexes: [],
    constraints: [
      { name: "pk", table: "orphan" }, // implied by orphan table → not re-listed
      { name: "pk", table: "users" }, // same conname, different table → distinct
    ],
  };
  const dev = snapshot({ tables: ["users"], constraints: [{ name: "pk", table: "other" }] });
  const diff = diffCatalogs(prod, dev);
  assert.deepEqual(diff.prodOnlyTables, ["orphan"]);
  assert.deepEqual(diff.prodOnlyConstraints, ["users.pk"]);
});

test("identical catalogs (plus dev extras) are drift-empty", () => {
  const dev = snapshot();
  const prod: Catalog = { tables: ["users"], indexes: dev.indexes, constraints: dev.constraints };
  assert.ok(isDriftEmpty(diffCatalogs(prod, dev)));
});

// ---------------------------------------------------------------------------
// runSchemaDriftCheck outcome → alert mapping (injected deps, no real IO)
// ---------------------------------------------------------------------------

interface NotifyCall {
  payload: { text: string };
  options: Record<string, unknown>;
}

function harness(over: {
  snapshot?: DevCatalogSnapshot | null;
  catalog?: Catalog | (() => Promise<Catalog>);
}) {
  const notifies: NotifyCall[] = [];
  let recovered = 0;
  const stamps: string[] = [];
  __setSchemaDriftTestDeps({
    loadDevSnapshot: async () => over.snapshot ?? null,
    captureCatalog:
      typeof over.catalog === "function"
        ? over.catalog
        : async () => over.catalog ?? { tables: [], indexes: [], constraints: [] },
    notify: async (payload, options) => {
      notifies.push({ payload, options });
      return { delivered: true, status: "delivered" };
    },
    markRecovered: async () => {
      recovered++;
    },
    // Stamp persistence stubbed in-memory — no real system_settings writes.
    persistLastRunStamp: async (json) => {
      stamps.push(json);
    },
    readLastRunStamp: async () => stamps[stamps.length - 1] ?? null,
  });
  return {
    notifies,
    recoveredCount: () => recovered,
    stamps,
    lastStamp: (): SchemaDriftLastRunStamp =>
      JSON.parse(stamps[stamps.length - 1]) as SchemaDriftLastRunStamp,
  };
}

test("drift outcome alerts with the stable dedupe key + prod_only_objects failureType", async () => {
  const dev = snapshot();
  const h = harness({
    snapshot: dev,
    catalog: { tables: [...dev.tables, "stripped_tbl"], indexes: dev.indexes, constraints: dev.constraints },
  });
  const outcome = await runSchemaDriftCheck();
  assert.equal(outcome.kind, "drift");
  assert.equal(h.notifies.length, 1);
  assert.equal(h.notifies[0].options.dedupeKey, SCHEMA_DRIFT_DEDUPE_KEY);
  assert.equal(h.notifies[0].options.failureType, "prod_only_objects");
  assert.match(h.notifies[0].payload.text, /stripped_tbl/);
});

test("missing snapshot alerts (snapshot_missing) — never a silent skip", async () => {
  const h = harness({ snapshot: null });
  const outcome = await runSchemaDriftCheck();
  assert.equal(outcome.kind, "snapshot_missing");
  assert.equal(h.notifies.length, 1);
  assert.equal(h.notifies[0].options.failureType, "snapshot_missing");
});

test("stale snapshot alerts (snapshot_stale) instead of comparing blind", async () => {
  const stale = snapshot({
    capturedAt: new Date(Date.now() - SNAPSHOT_MAX_AGE_MS - 60_000).toISOString(),
  });
  const h = harness({ snapshot: stale });
  const outcome = await runSchemaDriftCheck();
  assert.equal(outcome.kind, "snapshot_stale");
  assert.equal(h.notifies[0].options.failureType, "snapshot_stale");
});

test("catalog capture failure alerts (check_error) — errors are alerted, not swallowed", async () => {
  const h = harness({
    snapshot: snapshot(),
    catalog: async () => {
      throw new Error("pg exploded");
    },
  });
  const outcome = await runSchemaDriftCheck();
  assert.equal(outcome.kind, "check_error");
  assert.equal(h.notifies[0].options.failureType, "check_error");
  assert.match(h.notifies[0].payload.text, /pg exploded/);
});

test("clean run marks recovered and dispatches nothing", async () => {
  const dev = snapshot();
  const h = harness({
    snapshot: dev,
    catalog: { tables: dev.tables, indexes: dev.indexes, constraints: dev.constraints },
  });
  const outcome = await runSchemaDriftCheck();
  assert.equal(outcome.kind, "clean");
  assert.equal(h.notifies.length, 0);
  assert.equal(h.recoveredCount(), 1);
});

// ---------------------------------------------------------------------------
// Durable last-run stamp + staleness watchdog (Task #4749)
// ---------------------------------------------------------------------------

test("every outcome writes a durable last-run stamp — clean, drift, and check_error", async () => {
  const dev = snapshot();
  const clean = harness({
    snapshot: dev,
    catalog: { tables: dev.tables, indexes: dev.indexes, constraints: dev.constraints },
  });
  await runSchemaDriftCheck();
  assert.equal(clean.stamps.length, 1);
  assert.equal(clean.lastStamp().outcome, "clean");
  assert.ok(Number.isFinite(Date.parse(clean.lastStamp().ranAt)));

  const drift = harness({
    snapshot: dev,
    catalog: { tables: [...dev.tables, "stripped_tbl"], indexes: dev.indexes, constraints: dev.constraints },
  });
  await runSchemaDriftCheck();
  assert.equal(drift.lastStamp().outcome, "drift");
  assert.match(drift.lastStamp().detail ?? "", /1 tables/);

  const errored = harness({
    snapshot: dev,
    catalog: async () => {
      throw new Error("pg exploded");
    },
  });
  await runSchemaDriftCheck();
  assert.equal(errored.lastStamp().outcome, "check_error");
  assert.match(errored.lastStamp().detail ?? "", /pg exploded/);
});

test("stamp persistence failure never fails the tick (best-effort)", async () => {
  const dev = snapshot();
  __setSchemaDriftTestDeps({
    loadDevSnapshot: async () => dev,
    captureCatalog: async () => ({
      tables: dev.tables,
      indexes: dev.indexes,
      constraints: dev.constraints,
    }),
    notify: async () => ({ delivered: true, status: "delivered" }),
    markRecovered: async () => {},
    persistLastRunStamp: async () => {
      throw new Error("settings store down");
    },
  });
  const outcome = await runSchemaDriftCheck();
  assert.equal(outcome.kind, "clean");
});

test("readLastSchemaDriftRun classifies ok / never_run / unreadable", async () => {
  const h = harness({ snapshot: null });
  assert.deepEqual(await readLastSchemaDriftRun(), { status: "never_run", lastRun: null });
  await runSchemaDriftCheck(); // snapshot_missing → stamp written
  const ok = await readLastSchemaDriftRun();
  assert.equal(ok.status, "ok");
  assert.equal(ok.lastRun?.outcome, "snapshot_missing");
  h.stamps.push("{not json");
  const bad = await readLastSchemaDriftRun();
  assert.equal(bad.status, "unreadable");
  assert.ok(bad.error);
});

test("stamp validation is strict: unknown outcome, non-ISO ranAt, and future ranAt are unreadable (and alert)", async () => {
  const nowIso = new Date().toISOString();
  const cases: Array<{ raw: string; label: string; errMatch: RegExp }> = [
    {
      raw: JSON.stringify({ ranAt: nowIso, outcome: "garbage" }),
      label: "unknown outcome",
      errMatch: /unknown outcome/,
    },
    {
      raw: JSON.stringify({ ranAt: "yesterday", outcome: "clean" }),
      label: "unparseable ranAt",
      errMatch: /not a valid ISO/,
    },
    {
      // Parseable by Date.parse but NOT strict ISO — must still be rejected.
      raw: JSON.stringify({ ranAt: "Aug 14 2026", outcome: "clean" }),
      label: "non-ISO parseable ranAt",
      errMatch: /not a valid ISO/,
    },
    {
      raw: JSON.stringify({
        ranAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        outcome: "clean",
      }),
      label: "materially-future ranAt",
      errMatch: /in the future/,
    },
    {
      raw: JSON.stringify({ outcome: "clean" }),
      label: "ranAt missing",
      errMatch: /ranAt missing/,
    },
  ];
  for (const c of cases) {
    const notifies: NotifyCall[] = [];
    __setSchemaDriftTestDeps({
      readLastRunStamp: async () => c.raw,
      notify: async (payload, options) => {
        notifies.push({ payload, options });
        return { delivered: true, status: "delivered" };
      },
      markLastRunStaleRecovered: async () => {},
    });
    const read = await readLastSchemaDriftRun();
    assert.equal(read.status, "unreadable", c.label);
    assert.match(read.error ?? "", c.errMatch, c.label);
    // A corrupt stamp must ALERT, never mark the stale episode recovered.
    assert.equal(await runLastRunStalenessWatchdogOnce(), "unreadable", c.label);
    assert.equal(notifies.length, 1, c.label);
    assert.equal(notifies[0].options.failureType, "last_run_unreadable", c.label);
  }
});

test("small forward clock skew on ranAt is tolerated (fresh, not corrupt)", async () => {
  let staleRecovered = 0;
  const notifies: NotifyCall[] = [];
  __setSchemaDriftTestDeps({
    readLastRunStamp: async () =>
      JSON.stringify({
        ranAt: new Date(Date.now() + 60_000).toISOString(), // +1 min skew
        outcome: "clean",
      }),
    notify: async (payload, options) => {
      notifies.push({ payload, options });
      return { delivered: true, status: "delivered" };
    },
    markLastRunStaleRecovered: async () => {
      staleRecovered++;
    },
  });
  assert.equal(await runLastRunStalenessWatchdogOnce(), "fresh");
  assert.equal(notifies.length, 0);
  assert.equal(staleRecovered, 1);
});

test("watchdog: fresh stamp → no alert + stale-episode recovery", async () => {
  const h = harness({ snapshot: null });
  let staleRecovered = 0;
  __setSchemaDriftTestDeps({
    readLastRunStamp: async () =>
      JSON.stringify({ ranAt: new Date().toISOString(), outcome: "clean" }),
    notify: async (payload, options) => {
      h.notifies.push({ payload, options });
      return { delivered: true, status: "delivered" };
    },
    markLastRunStaleRecovered: async () => {
      staleRecovered++;
    },
  });
  assert.equal(await runLastRunStalenessWatchdogOnce(), "fresh");
  assert.equal(h.notifies.length, 0);
  assert.equal(staleRecovered, 1);
});

test("watchdog: stale / missing / unreadable stamp each alert on the dedicated dedupe key", async () => {
  const cases: Array<{
    raw: string | null;
    verdict: string;
    failureType: string;
  }> = [
    {
      raw: JSON.stringify({
        ranAt: new Date(Date.now() - LAST_RUN_MAX_AGE_MS - 60_000).toISOString(),
        outcome: "clean",
      }),
      verdict: "stale",
      failureType: "last_run_stale",
    },
    { raw: null, verdict: "never_run", failureType: "last_run_missing" },
    { raw: "{corrupt", verdict: "unreadable", failureType: "last_run_unreadable" },
  ];
  for (const c of cases) {
    const notifies: NotifyCall[] = [];
    __setSchemaDriftTestDeps({
      readLastRunStamp: async () => c.raw,
      notify: async (payload, options) => {
        notifies.push({ payload, options });
        return { delivered: true, status: "delivered" };
      },
      markLastRunStaleRecovered: async () => {},
    });
    assert.equal(await runLastRunStalenessWatchdogOnce(), c.verdict);
    assert.equal(notifies.length, 1, c.verdict);
    assert.equal(notifies[0].options.dedupeKey, SCHEMA_DRIFT_LAST_RUN_STALE_DEDUPE_KEY);
    assert.equal(notifies[0].options.failureType, c.failureType);
  }
});

test("kill-switch skip still stamps: skipped_kill_switch is visible, not stale", async () => {
  // checkTick is module-internal; the contract is pinned via the stamp shape
  // + the source marker (skipped ticks call writeLastRunStamp). Verify the
  // outcome value survives a stamp round-trip through the reader.
  const h = harness({ snapshot: null });
  h.stamps.push(
    JSON.stringify({ ranAt: new Date().toISOString(), outcome: "skipped_kill_switch" }),
  );
  const read = await readLastSchemaDriftRun();
  assert.equal(read.status, "ok");
  assert.equal(read.lastRun?.outcome, "skipped_kill_switch");
  assert.equal(await runLastRunStalenessWatchdogOnce(), "fresh");
});

test("scheduler start is inert under NODE_ENV=test outside a deployment (no publisher, no timers)", async () => {
  let published = 0;
  __setSchemaDriftTestDeps({
    publishSnapshot: async () => {
      published++;
    },
  });
  await startSchemaDriftScheduler();
  assert.equal(published, 0);
  stopSchemaDriftScheduler();
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(err instanceof Error ? err.stack : err);
    } finally {
      stopSchemaDriftScheduler();
    }
  }
  console.log(`\nschema-drift-check tests: ${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) {
    process.exitCode = 1;
    throw new Error(`${failed} schema-drift-check test(s) failed`);
  }
  console.log("schema-drift-check.test.ts: OK");
})();
