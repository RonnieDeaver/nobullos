/* test-registration
{
  "name": "Dev-DB refresh guard rails: deployment/Neon refusal + newest-dump selection (Task #4552)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4552: scripts/refresh-dev-db-from-backup.ts DROPS its target's public schema before restoring a prod dump. These pure guards are the only thing standing between it and production: refuse REPLIT_DEPLOYMENT=1, refuse Neon/neondb targets (fail-closed on unparseable strings), restore only real database-dump keys, and pick the NEWEST dated dump (never a manifest or the files/ archive). DB-free pure unit — fast.",
  "tier": "small"
}
test-registration */
/**
 * Task #4552 — guard rails for the dev-DB refresh tool
 * (`scripts/refresh-dev-db-from-backup.ts`).
 *
 * The restore is DESTRUCTIVE (drop/recreate `public`, then apply a prod
 * dump), so the module exports its guards as pure functions with zero
 * project imports, and this suite pins them without touching real Object
 * Storage or a real database:
 *
 *   1. DEPLOYMENT GATE — `REPLIT_DEPLOYMENT === "1"` is refused: a
 *      deployment run would aim the drop at production.
 *   2. NEON-TARGET REFUSAL — prod is Neon `neondb`, dev is Helium
 *      `heliumdb`; any neon.tech host or neondb database name is refused,
 *      raw-substring checks fire even for unparseable strings, and an
 *      unparseable target is refused outright (fail closed).
 *   3. CONFIRM FLAG — `--confirm-refresh-dev` must be explicit.
 *   4. DUMP SELECTION — only `backups/<date>/database-*.sql.gz` keys are
 *      candidates (manifests and the content-addressed `backups/files/`
 *      archive are excluded) and lexicographic-newest wins, including a
 *      manual afternoon press over the same day's 04:00 scheduled run.
 *   5. SCHEMA PEEK — the dump-head check that decides whether the script
 *      must CREATE SCHEMA public itself (PG15+ dumps carry their own).
 */

import assert from "node:assert/strict";

import {
  RefreshRefusedError,
  assertNotInDeployment,
  assertRefreshTargetSafe,
  assertDumpKeyRestorable,
  parseRefreshArgs,
  pickNewestDump,
  dumpHeadCreatesPublicSchema,
  parseDumpHeadExtraSchemas,
} from "../scripts/refresh-dev-db-from-backup";

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

// ── 1. Deployment gate ──────────────────────────────────────────────────────

assert.throws(
  () => assertNotInDeployment({ REPLIT_DEPLOYMENT: "1" }),
  RefreshRefusedError,
);
ok("REPLIT_DEPLOYMENT=1 is refused");

assertNotInDeployment({});
assertNotInDeployment({ REPLIT_DEPLOYMENT: "0" });
ok("non-deployment env passes the gate");

// ── 2. Neon-target refusal ──────────────────────────────────────────────────

const NEON_URLS = [
  // Real prod shape: Neon host + neondb database.
  "postgresql://app:pw@ep-cool-mud-123456.us-east-2.aws.neon.tech/neondb?sslmode=require",
  // Neon host alone is enough.
  "postgresql://app:pw@ep-x.aws.neon.tech/whatever",
  // A database named neondb is refused on ANY host.
  "postgresql://app:pw@db.example.com/neondb",
  // Raw-substring checks fire even when the string is not a parseable URL.
  "host=ep-a.neon.tech dbname=whatever",
  "some junk mentioning neondb here",
];
for (const url of NEON_URLS) {
  assert.throws(() => assertRefreshTargetSafe(url), RefreshRefusedError);
}
ok(`all ${NEON_URLS.length} Neon-flavored targets are refused`);

assert.throws(() => assertRefreshTargetSafe(undefined), RefreshRefusedError);
assert.throws(() => assertRefreshTargetSafe(""), RefreshRefusedError);
ok("a missing/empty target is refused");

// Fail closed: an unverifiable (unparseable) target is refused even with no
// Neon marker in it.
assert.throws(
  () => assertRefreshTargetSafe("host=devhost dbname=devclone"),
  RefreshRefusedError,
);
ok("an unparseable connection string is refused (fail closed)");

// Dev-shaped targets pass: the shared Helium dev DB and a hermetic per-run
// test DB. (No real hostnames here — the guard is pure string logic.)
assertRefreshTargetSafe(
  "postgresql://user:pw@dev-db.internal:5432/devclone?sslmode=disable",
);
assertRefreshTargetSafe("postgresql://postgres:pw@127.0.0.1:5432/testdb_ab12");
ok("dev/hermetic-shaped targets are accepted");

// ── 3. Confirm flag + dump-key parsing ──────────────────────────────────────

assert.deepEqual(parseRefreshArgs([]), { confirmed: false, dumpKey: null });
assert.deepEqual(parseRefreshArgs(["--confirm-refresh-dev"]), {
  confirmed: true,
  dumpKey: null,
});
assert.deepEqual(
  parseRefreshArgs([
    "--dump-key=backups/2026-08-01/database-x.sql.gz",
    "--confirm-refresh-dev",
  ]),
  { confirmed: true, dumpKey: "backups/2026-08-01/database-x.sql.gz" },
);
ok("--confirm-refresh-dev is required and --dump-key= is parsed");

assertDumpKeyRestorable(
  "backups/2026-08-11/database-2026-08-11T08-00-00-529Z.sql.gz",
);
for (const bad of [
  // A manifest is not a restorable dump.
  "backups/2026-08-11/2026-08-11T08-00-00-529Z/file-manifest.json.gz",
  // Neither is a content-addressed archive object.
  "backups/files/0a1b2c/1723363200000000",
  // Nor an arbitrary object outside backups/.
  "comms-draft-attachments/whatever.sql.gz",
]) {
  assert.throws(() => assertDumpKeyRestorable(bad), RefreshRefusedError);
}
ok("--dump-key only accepts real database-dump keys");

// ── 4. Newest-dump selection ────────────────────────────────────────────────

const listing = [
  { objectKey: "backups/2026-08-09/database-2026-08-09T08-00-00-101Z.sql.gz" },
  { objectKey: "backups/2026-08-10/database-2026-08-10T08-00-00-202Z.sql.gz" },
  // Same-day manifest and files/ archive objects are never candidates.
  { objectKey: "backups/2026-08-11/2026-08-11T08-00-00-529Z/file-manifest.json.gz" },
  { objectKey: "backups/files/deadbeef/1723363200000000" },
  { objectKey: "backups/2026-08-11/database-2026-08-11T08-00-00-529Z.sql.gz" },
];
assert.equal(
  pickNewestDump(listing),
  "backups/2026-08-11/database-2026-08-11T08-00-00-529Z.sql.gz",
);
ok("newest dated dump wins; manifests and files/ archive are excluded");

// A manual "Run backup now" press later the same day sorts after the 04:00
// scheduled run (ISO run stamps make lexicographic = chronological).
assert.equal(
  pickNewestDump([
    ...listing,
    {
      objectKey:
        "backups/2026-08-11/database-2026-08-11T14-30-00-000Z.sql.gz",
    },
  ]),
  "backups/2026-08-11/database-2026-08-11T14-30-00-000Z.sql.gz",
);
ok("same-day manual run beats the scheduled 04:00 dump");

assert.throws(() => pickNewestDump([]));
assert.throws(() =>
  pickNewestDump([{ objectKey: "backups/files/deadbeef/1" }]),
);
ok("an empty/dump-free listing throws instead of restoring nothing");

// ── 5. Dump-head schema peek ────────────────────────────────────────────────

const HEAD_WITH_SCHEMA = [
  "--",
  "-- PostgreSQL database dump",
  "--",
  "SET statement_timeout = 0;",
  "CREATE SCHEMA public;",
  "ALTER SCHEMA public OWNER TO neondb_owner;",
].join("\n");
const HEAD_WITHOUT_SCHEMA = [
  "--",
  "-- PostgreSQL database dump",
  "--",
  "SET statement_timeout = 0;",
  "-- CREATE SCHEMA public; (commented mention only)",
  "COMMENT ON SCHEMA public IS 'standard public schema';",
  "CREATE TABLE public.clients (id uuid);",
].join("\n");

assert.equal(dumpHeadCreatesPublicSchema(HEAD_WITH_SCHEMA), true);
assert.equal(
  dumpHeadCreatesPublicSchema(
    HEAD_WITH_SCHEMA.replace(
      "CREATE SCHEMA public;",
      "CREATE SCHEMA IF NOT EXISTS public;",
    ),
  ),
  true,
);
assert.equal(dumpHeadCreatesPublicSchema(HEAD_WITHOUT_SCHEMA), false);
ok("dump-head CREATE SCHEMA public detection (incl. IF NOT EXISTS; ignores comments)");

// Extra (non-public) schemas the dump creates must be dropped pre-restore or
// their CREATE SCHEMA aborts under ON_ERROR_STOP. Prod's dump carries
// _system and stripe (verified against the 2026-08-11 dump head).
const HEAD_PROD_SHAPE = [
  "SET row_security = off;",
  "CREATE SCHEMA _system;",
  "CREATE SCHEMA stripe;",
  'CREATE SCHEMA "Weird Name";',
  "CREATE SCHEMA _system;",
  "-- CREATE SCHEMA commented_out;",
  "CREATE SCHEMA pg_smuggled;",
  "CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;",
].join("\n");
assert.deepEqual(parseDumpHeadExtraSchemas(HEAD_PROD_SHAPE), [
  "_system",
  "stripe",
  "Weird Name",
]);
assert.deepEqual(parseDumpHeadExtraSchemas(HEAD_WITH_SCHEMA), []);
ok(
  "extra dump-created schemas parsed (deduped, quoted names supported, public/pg_* never returned)",
);

console.log(`\nrefresh-dev-db-guards: ${passed} assertion group(s) passed`);
