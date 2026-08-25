/* test-registration
{
  "name": "Hermetic DB guardrails — schema hash, child env injection, dev-DB refusal guard, lint self-test, cache namespace (Task #3797)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Keeps every OTHER suite hermetic: guards the per-run DB provisioning contract (schema hash, child env injection, dev-DB refusal, guardrail lint). A regression here silently un-hermetics the whole suite.",
  "tier": "small"
}
test-registration */
/**
 * Hermetic DB guardrails (Task #3797).
 *
 * The full suite runs against a private per-run Postgres; this suite proves
 * the guard machinery that keeps it that way:
 *
 *   A. computeSchemaHash — stable across calls, sensitive to migration
 *      content changes (template cache key).
 *   B. buildChildDbEnv — injects every connection-string variant children
 *      inherit and unsets the pooled/migrations fallbacks (`??` chains would
 *      otherwise resurrect the shared dev URL).
 *   C. server/db.ts inverse guard — a spawned test-mode child REFUSES the
 *      shared dev DB (heliumdb) and prod Neon (even under the retired
 *      TEST_SHARED_DEV_DB=1 legacy flag, which no longer exists), and
 *      accepts the hermetic URL.
 *   D. lint-test-hermetic-db — self-test of the gate lint that blocks new
 *      tests from raw pools / dev-DB literals / self-granted escape hatches.
 *   E. Redis cache isolation — the per-run namespace injected by the runner
 *      is what redisCache actually prefixes keys with.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildChildDbEnv, computeSchemaHash } from "./hermetic/provision";
import { lintSource, runLint } from "../scripts/lint-test-hermetic-db";

const ROOT = resolve(import.meta.dirname, "..");

function fail(msg: string): never {
  console.error(`FAILED: ${msg}`);
  process.exit(1);
}

// ── A. Schema-content hash ──────────────────────────────────────────────
function testSchemaHash(): void {
  const a = computeSchemaHash();
  const b = computeSchemaHash();
  assert.equal(a.hash, b.hash, "hash must be deterministic");
  assert.match(a.hash, /^[0-9a-f]{16}$/, "hash is 16 hex chars");
  assert.ok(a.fileCount > 200, `hash covers the schema-defining corpus (got ${a.fileCount} files)`);

  // Sensitivity: a new migration file must change the hash. Probe file is
  // created inside migrations/ and removed in finally (unique name so a
  // crashed run is recognizable and harmless to re-run).
  const probe = resolve(ROOT, `migrations/zzzz_hermetic_hash_probe_${process.pid}.sql`);
  writeFileSync(probe, `-- hermetic hash probe ${Date.now()}\nSELECT 1;\n`);
  try {
    const c = computeSchemaHash();
    assert.notEqual(c.hash, a.hash, "adding a migration file must change the schema hash");
    assert.equal(c.fileCount, a.fileCount + 1, "probe file counted exactly once");
  } finally {
    unlinkSync(probe);
  }
  const d = computeSchemaHash();
  assert.equal(d.hash, a.hash, "hash returns to baseline after probe removal");
  console.log("  ok  A: computeSchemaHash stable, hex16, migration-sensitive");
}

// ── B. Child env injection ──────────────────────────────────────────────
function testChildDbEnv(): void {
  const env = buildChildDbEnv({
    url: "postgresql://postgres@127.0.0.1:55001/nobull_test",
    host: "127.0.0.1",
    port: 55001,
    user: "postgres",
    password: "",
    database: "nobull_test",
    runId: "run-guard-test",
  });
  for (const key of ["DATABASE_URL", "DATABASE_URL_DIRECT", "PGDATABASE_URL"]) {
    assert.equal(env.set[key], "postgresql://postgres@127.0.0.1:55001/nobull_test", `${key} injected`);
  }
  assert.equal(env.set.PGHOST, "127.0.0.1");
  assert.equal(env.set.PGPORT, "55001");
  assert.equal(env.set.PGDATABASE, "nobull_test");
  assert.equal(env.set.PGSSLMODE, "disable", "local cluster runs without TLS");
  assert.equal(env.set.NOBULL_HERMETIC_DB, "1", "hermetic marker set");
  assert.equal(env.set.NOBULL_TEST_CACHE_NAMESPACE, "run-guard-test", "per-run cache namespace set");
  for (const key of ["DATABASE_URL_POOLED", "DATABASE_URL_MIGRATIONS"]) {
    assert.ok(env.unset.includes(key), `${key} must be UNSET (?? fallbacks would resurrect shared URLs)`);
  }
  console.log("  ok  B: buildChildDbEnv sets every variant + unsets pooled/migrations fallbacks");
}

// ── C. server/db.ts inverse guard (spawned children) ────────────────────
interface ChildOutcome {
  status: number | null;
  out: string;
}

function importDbInChild(dbUrl: string, extraEnv: Record<string, string> = {}): ChildOutcome {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NODE_ENV: "test",
    DATABASE_URL: dbUrl,
    DATABASE_URL_DIRECT: dbUrl,
    PGDATABASE_URL: dbUrl,
    ...extraEnv,
  };
  delete env.DATABASE_URL_POOLED;
  delete env.DATABASE_URL_MIGRATIONS;
  delete env.TEST_SHARED_DEV_DB;
  Object.assign(env, extraEnv);
  const res = spawnSync(
    "npx",
    [
      "tsx",
      "-e",
      `import("./server/db.js").then(()=>{console.log("EVAL_OK");process.exit(0)}).catch(e=>{console.error(String((e&&e.message)||e));process.exit(1)})`,
    ],
    { cwd: ROOT, env, encoding: "utf8", timeout: 90_000 },
  );
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

function testDbGuard(): void {
  const heliumUrl = "postgresql://user:pw@127.0.0.1:59999/heliumdb";

  const refused = importDbInChild(heliumUrl);
  assert.notEqual(refused.status, 0, "heliumdb URL in test mode must refuse to boot");
  assert.match(refused.out, /refuses the SHARED dev database/i, `guard message present, got: ${refused.out.slice(0, 400)}`);
  console.log("  ok  C1: test mode refuses the shared dev DB (heliumdb)");

  // The whole-run TEST_SHARED_DEV_DB=1 legacy mode was retired (unused);
  // setting it must NOT reopen the shared dev DB.
  const escaped = importDbInChild(heliumUrl, { TEST_SHARED_DEV_DB: "1" });
  assert.notEqual(escaped.status, 0, `retired TEST_SHARED_DEV_DB=1 flag must NOT admit heliumdb, got: ${escaped.out.slice(0, 400)}`);
  assert.match(escaped.out, /refuses the SHARED dev database/i, "guard message present even with retired flag set");
  console.log("  ok  C2: retired TEST_SHARED_DEV_DB=1 flag no longer admits heliumdb");

  const neon = importDbInChild("postgresql://u:p@ep-guard-probe.us-east-2.aws.neon.tech/neondb");
  assert.notEqual(neon.status, 0, "prod Neon URL in test mode must refuse to boot");
  assert.match(neon.out, /refuses the production Neon database/i, `neon guard message present, got: ${neon.out.slice(0, 400)}`);
  console.log("  ok  C3: test mode still refuses prod Neon");

  const hermeticUrl = process.env.DATABASE_URL ?? "";
  assert.ok(!/heliumdb/.test(hermeticUrl), "suite itself must be running hermetically (runner injects private DB)");
  const hermetic = importDbInChild(hermeticUrl);
  assert.equal(hermetic.status, 0, `hermetic URL must be accepted, got: ${hermetic.out.slice(0, 400)}`);
  console.log("  ok  C4: hermetic per-run URL admitted");
}

// ── D. Lint self-test ───────────────────────────────────────────────────
function testLint(): void {
  const repo = runLint(ROOT);
  assert.equal(repo.ok, true, `repo must be lint-clean, got: ${JSON.stringify(repo.violations.slice(0, 5))}`);
  assert.ok(repo.scanned > 500, `lint scans the whole tests tree (got ${repo.scanned})`);

  const rawPool = lintSource(
    "tests/fixture.test.ts",
    `import { Pool } from "pg";\nconst p = new Pool({ connectionString: "x" });\n`,
  );
  assert.equal(rawPool.length, 1);
  assert.equal(rawPool[0].rule, "raw-pool");

  const marked = lintSource(
    "tests/fixture.test.ts",
    `import { Pool } from "pg";\n// lint-hermetic-db-ok: fixture reason\nconst p = new Pool({});\n`,
  );
  assert.equal(marked.length, 0, "suppress marker on the line above is honored");

  const literal = lintSource("tests/fixture.test.ts", `const url = "postgresql://u@h/heliumdb";\n`);
  assert.equal(literal.length, 1);
  assert.equal(literal[0].rule, "dev-db-literal");

  const grant = lintSource("tests/fixture.test.ts", `process.env.TEST_SHARED_DEV_DB = "1";\n`);
  assert.equal(grant.length, 1);
  assert.equal(grant[0].rule, "shared-dev-grant");

  const sanctioned = lintSource("tests/run-all.ts", `process.env.TEST_SHARED_DEV_DB = "1";\n`);
  assert.equal(sanctioned.length, 0, "runner itself is sanctioned");

  const commented = lintSource("tests/fixture.test.ts", `// const p = new Pool({}); from "pg"\n`);
  assert.equal(commented.length, 0, "commented-out code does not trip the lint");
  console.log("  ok  D: lint-test-hermetic-db self-test (rules, marker, sanctioned files, comments)");
}

// ── E. Redis cache namespace ────────────────────────────────────────────
async function testCacheNamespace(): Promise<void> {
  const ns = process.env.NOBULL_TEST_CACHE_NAMESPACE;
  assert.ok(ns, "runner must inject NOBULL_TEST_CACHE_NAMESPACE for every hermetic run");
  const { __getCacheKeyPrefixForTest } = await import("../server/services/cache/redisCache");
  const prefix = __getCacheKeyPrefixForTest();
  assert.equal(prefix, `nobull:test:${ns}`, `cache keys must live under the per-run namespace (got ${prefix})`);
  console.log("  ok  E: redis cache keys namespaced per run");
}

async function main(): Promise<void> {
  console.log("Hermetic DB guard tests (Task #3797)");
  testSchemaHash();
  testChildDbEnv();
  testDbGuard();
  testLint();
  await testCacheNamespace();
  console.log("\nAll hermetic-db-guard tests passed");
  process.exit(0);
}

main().catch((err) => {
  fail(err?.stack ?? String(err));
});
