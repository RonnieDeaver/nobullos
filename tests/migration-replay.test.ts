/* test-registration
{
  "name": "Migration replay seam — timestamp migrations re-apply cleanly (Task #4179)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4179 (migration-immutability guard, CI replay seam): every timestamp-convention migration must apply cleanly — twice — against the current post-push schema in the disposable hermetic Postgres. This is the exact semantics of the dev pending-apply and prod SAFE re-apply paths (a clean-schema from-empty replay is impossible by design: genesis is push-first, verified 2026-08 — 0033 alters a push-only table). Selected on any migrations/ change via scanPaths; ~20 psql applies, seconds.",
  "scanPaths": [
    "migrations"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4179 — migration replay / upgrade seam.
 *
 * What it proves, per timestamp-named migration file (the append-only era —
 * every NEW migration lands here automatically):
 *   1. It applies without error against the current schema (the hermetic
 *      per-run database, built through the app's own push-first genesis) —
 *      the "prior/current-schema upgrade" check.
 *   2. It applies a SECOND time without error — idempotent re-apply, the
 *      property scripts/post-merge.sh SAFE re-apply and the dev
 *      ledger-drift reconciler both depend on.
 *   3. server/devMigrations' own isMigrationIdempotent() classifier agrees
 *      (a non-idempotent new migration is caught even if it happens to
 *      re-apply cleanly against today's schema).
 *
 * Why not a from-empty replay of the whole history: the migration files are
 * not a self-contained genesis path (e.g. 0033 ALTERs
 * `semrush_location_sync_state`, a push-only table — re-verified in Task
 * #4179 on a disposable cluster and documented in
 * tests/hermetic/bootstrap-db.ts). Clean genesis IS exercised every time
 * the hermetic template rebuilds on schema-hash change (push → ledger
 * baseline → SAFE re-apply → boot ensures).
 *
 * DB safety: uses ONLY the runner-injected hermetic DATABASE_URL via the
 * psql CLI; refuses production outright. Applying committed idempotent
 * migrations to the per-run DB is a no-op-shaped re-apply of schema the
 * template already carries.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMigrationIdempotent } from "../server/devMigrations";

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

const dbUrl = process.env.DATABASE_URL ?? "";
if (!dbUrl) {
  console.error("DATABASE_URL not set — this suite must run under the test runner's hermetic DB.");
  process.exit(1);
}
if (dbUrl.includes("neon.tech")) {
  console.error("REFUSING: DATABASE_URL points at the production Neon database.");
  process.exit(1);
}

const TIMESTAMP_RE = /^20\d{12}_[a-z0-9_]+\.sql$/;
const files = readdirSync("migrations")
  .filter((f) => TIMESTAMP_RE.test(f))
  .sort();
const migrationSql = new Map(
  files.map((file) => [file, readFileSync(join("migrations", file), "utf8")]),
);
const retiredOnCurrentSchema = new Map<string, string>();
for (const [successor, sql] of migrationSql) {
  for (const match of sql.matchAll(
    /^-- retires-current-schema-replay-of: (20\d{12}_[a-z0-9_]+\.sql)$/gm,
  )) {
    const predecessor = match[1];
    assert(files.includes(predecessor), `${successor} replay-retirement target exists`);
    assert(
      predecessor < successor,
      `${successor} replay-retirement target is an earlier migration`,
    );
    retiredOnCurrentSchema.set(predecessor, successor);
  }
}

console.log(`Replaying ${files.length} timestamp-convention migration(s), twice each…`);
assert(files.length > 0, "at least one timestamp-convention migration exists to replay");

for (const f of files) {
  const path = join("migrations", f);
  const retiredBy = retiredOnCurrentSchema.get(f);
  if (retiredBy) {
    console.log(
      `  ↷ ${f} apply skipped on the current pushed schema (contracted by ${retiredBy})`,
    );
    assert(
      isMigrationIdempotent(migrationSql.get(f) ?? ""),
      `${f} is classified idempotent by server/devMigrations.isMigrationIdempotent`,
    );
    continue;
  }
  for (const pass of [1, 2] as const) {
    const res = spawnSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-q", "-f", path], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const ok = res.status === 0 && !res.error;
    assert(
      ok,
      `${f} pass ${pass} (${pass === 1 ? "upgrade apply" : "idempotent re-apply"})${
        ok ? "" : ` — ${String(res.error ?? "")} ${res.stderr?.slice(0, 500) ?? ""}`
      }`,
    );
    if (!ok) break;
  }
  assert(
    isMigrationIdempotent(migrationSql.get(f) ?? ""),
    `${f} is classified idempotent by server/devMigrations.isMigrationIdempotent`,
  );
}

console.log("");
console.log(`Result: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
