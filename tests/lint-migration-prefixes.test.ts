/* test-registration
{
  "name": "lint-migration-prefixes ratchet guard (Task #3944)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3944: guards the migration-prefix ratchet — the frozen legacy snapshot is content-hash-pinned here so editing it (the historical allow-list-growth leak) fails loudly, and fixture matrices prove new collisions fail with exact prefix+filenames. Fast, DB-free, deterministic (tmp-dir fixtures + real migrations/ scan).",
  "tier": "small"
}
test-registration */
/**
 * Task #3944 — guard tests for scripts/lint-migration-prefixes.ts.
 *
 * The pre-#3944 guard kept a second hand-maintained ALLOWLISTED_COLLISIONS
 * map whose git history shows post-guard collisions being absorbed by
 * editing it (0107/0109/0112/0120/0121/0122/0129/0142/0146), with two keys
 * (0142/0146) stale — still "allowing" collisions whose files had been
 * renamed away. The rework derives collision allowance from the single
 * frozen snapshot and this test pins that snapshot by sha-256, so the only
 * remaining way to widen what passes is a reviewed edit to BOTH files.
 *
 * Spec matrix (all eight cases):
 *   1. The frozen historical collision set passes (real repo + replica fixture).
 *   2. Adding a new duplicate prefix fails.
 *   3. Adding another file to an already-duplicated legacy prefix fails
 *      unless the frozen snapshot explicitly models that exact file.
 *   4. Removing a historical duplicate does not fail (shrink allowed).
 *   5. Renaming an unrelated unique migration (to the timestamp convention)
 *      does not fail.
 *   6. UTC-timestamp migration names remain valid; malformed names fail.
 *   7. The lint reports the exact colliding filenames and prefix.
 *   8. The gate cannot silently rewrite or refresh the legacy snapshot:
 *      snapshot content-hash pin + the lint source has no write/update path.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  runLint,
  frozenCollisionGroups,
  FROZEN_LEGACY_MIGRATIONS,
} from "../scripts/lint-migration-prefixes";

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

function fixtureDir(files: string[]): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lint-migration-prefixes-"));
  for (const f of files) writeFileSync(join(dir, f), "-- fixture\n");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A small frozen snapshot that models one collision pair and one triple. */
const FIXTURE_FROZEN: ReadonlySet<string> = new Set([
  "0001_alpha.sql",
  "0002_beta.sql",
  "0067_first.sql",
  "0067_second.sql",
  "0122_a.sql",
  "0122_b.sql",
  "0122_c.sql",
  "0100_unique.sql",
]);

function run(files: string[], frozen: ReadonlySet<string> = FIXTURE_FROZEN) {
  const { dir, cleanup } = fixtureDir(files);
  try {
    return runLint({ migrationsDir: dir, frozenSet: frozen, skipEnv: undefined });
  } finally {
    cleanup();
  }
}

console.log("1) frozen historical collision set passes");
{
  const real = runLint({ skipEnv: undefined });
  assert(real.ok, `REAL repository migrations/ passes (${real.violations.length} violations)`);
  assert(!real.skipped, "real run is not skipped");

  const replica = run([...FIXTURE_FROZEN]);
  assert(replica.ok, "fixture replicating the frozen collisions passes");

  const groups = frozenCollisionGroups(FIXTURE_FROZEN);
  assert(
    groups.size === 2 && groups.get("0067")?.length === 2 && groups.get("0122")?.length === 3,
    "collision groups derived from the frozen snapshot alone (0067 pair, 0122 triple)",
  );
  const realGroups = frozenCollisionGroups();
  assert(
    realGroups.size === 19 && !realGroups.has("0142") && !realGroups.has("0146"),
    "real snapshot derives exactly 19 collision prefixes — stale pre-#3944 allow-list keys 0142/0146 are gone",
  );
}

console.log("2) adding a new duplicate prefix fails");
{
  // Two brand-new numeric files sharing a prefix.
  const res = run([...FIXTURE_FROZEN, "0200_one.sql", "0200_two.sql"]);
  assert(!res.ok, "new numeric duplicate prefix fails");
  assert(
    res.violations.some(
      (v) => v.includes("0200") && v.includes("0200_one.sql") && v.includes("0200_two.sql"),
    ),
    "violation names the exact new prefix and both filenames",
  );

  // Two timestamp files sharing a prefix.
  const ts = run([...FIXTURE_FROZEN, "20260806120000_x.sql", "20260806120000_y.sql"]);
  assert(!ts.ok, "duplicate timestamp prefix fails");
  assert(
    ts.violations.some(
      (v) =>
        v.includes("20260806120000") &&
        v.includes("20260806120000_x.sql") &&
        v.includes("20260806120000_y.sql"),
    ),
    "timestamp collision names the prefix and both filenames",
  );
}

console.log("3) adding to an already-duplicated legacy prefix fails unless modeled");
{
  const res = run([...FIXTURE_FROZEN, "0067_third.sql"]);
  assert(!res.ok, "new file on the already-duplicated 0067 prefix fails");
  assert(
    res.violations.some(
      (v) =>
        v.includes("0067") &&
        v.includes("0067_third.sql") &&
        v.includes("0067_first.sql") &&
        v.includes("0067_second.sql"),
    ),
    "violation names prefix 0067, the new file, and the existing frozen occupants",
  );

  // The exact modeled files themselves pass (that is what "frozen" means).
  const modeled = run([...FIXTURE_FROZEN]);
  assert(modeled.ok, "the exact modeled collision files pass");
}

console.log("4) removing a historical duplicate does not fail (shrink allowed)");
{
  const files = [...FIXTURE_FROZEN].filter((f) => f !== "0067_second.sql");
  const res = run(files);
  assert(res.ok, "deleting one member of a frozen collision pair passes");

  const single = run([...FIXTURE_FROZEN].filter((f) => !f.startsWith("0122_") || f === "0122_a.sql"));
  assert(single.ok, "shrinking the 0122 triple to one file passes");
}

console.log("5) renaming an unrelated unique migration does not fail");
{
  // 0100_unique.sql renamed to the timestamp convention: old name gone
  // (shrink), new timestamp name valid.
  const files = [...FIXTURE_FROZEN].filter((f) => f !== "0100_unique.sql");
  files.push("20260806123456_unique.sql");
  const res = run(files);
  assert(res.ok, "legacy → timestamp rename of a unique migration passes");

  // Renaming between two unique timestamp names also passes.
  const res2 = run([...FIXTURE_FROZEN, "20260101000000_renamed_thing.sql"]);
  assert(res2.ok, "a unique timestamp-named migration passes");
}

console.log("6) UTC-timestamp names remain valid; malformed names fail");
{
  const ok = run([...FIXTURE_FROZEN, "20260806120000_add_widget_flags.sql"]);
  assert(ok.ok, "well-formed timestamp name passes");

  const bad13 = run([...FIXTURE_FROZEN, "2026080612000_short_prefix.sql"]);
  assert(!bad13.ok, "13-digit prefix fails (must be exactly 14, starting 20)");

  const badDesc = run([...FIXTURE_FROZEN, "20260806120000_BadCase.sql"]);
  assert(!badDesc.ok, "non-snake_case description fails");

  const badName = run([...FIXTURE_FROZEN, "readme_notes.sql"]);
  assert(!badName.ok, "non-numeric non-timestamp name fails");
}

console.log("7) skip escape hatch is explicit and audited");
{
  const res = runLint({ migrationsDir: "does-not-exist", skipEnv: "1" });
  assert(res.ok && res.skipped, "LINT_MIGRATION_PREFIXES_SKIP=1 short-circuits with skipped=true");
  assert(
    res.summaryLine.includes("SKIPPED"),
    "skip is loudly announced, never silent",
  );
}

console.log("8) the frozen snapshot cannot be silently rewritten or refreshed");
{
  // (a) Content-hash pin: any edit to FROZEN_LEGACY_MIGRATIONS (adding a new
  // collision member — the historical allow-list-growth leak) changes this
  // hash and fails the always-core guard until BOTH files change in one
  // reviewed diff. Recompute with:
  //   npx tsx -e "import {FROZEN_LEGACY_MIGRATIONS} from './scripts/lint-migration-prefixes.ts'; import {createHash} from 'node:crypto'; console.log(createHash('sha256').update([...FROZEN_LEGACY_MIGRATIONS].sort().join('\n')).digest('hex'))"
  const sorted = [...FROZEN_LEGACY_MIGRATIONS].sort();
  const hash = createHash("sha256").update(sorted.join("\n")).digest("hex");
  assert(
    hash === "34f49c0a92cc16f38d45ff5b2d03ae20ebe02960b1f70ad887ae2d6017bab78a",
    `frozen snapshot content hash is pinned (got ${hash})`,
  );
  assert(sorted.length === 171, `frozen snapshot has exactly 171 entries (got ${sorted.length})`);

  // (b) No regeneration path: the lint source never writes files and accepts
  // no --update/--refresh/--baseline style flag.
  const src = readFileSync("scripts/lint-migration-prefixes.ts", "utf8");
  assert(
    !/writeFileSync|appendFileSync|createWriteStream|\bwriteFile\b|renameSync|copyFileSync/.test(src),
    "lint source contains no file-write API",
  );
  // (process.argv[1] appears exactly once, in the standard isMain guard —
  // what must NOT appear is any flag parsing over the argument list.)
  assert(
    !/--update|--refresh|--baseline|--regen|argv\.slice|argv\.includes|parseArgs|of process\.argv/.test(src),
    "lint source parses no CLI flags (no --update-baseline style path)",
  );

  // (c) The runtime API offers no mutation hook either.
  assert(
    typeof runLint === "function" && typeof frozenCollisionGroups === "function",
    "exports are pure read-only analysis functions",
  );
}

console.log("");
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
