/* test-registration
{
  "name": "lint-migration-immutability guard (Task #4179)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4179: guards the migration-immutability ledger — the frozen sha-256 ledger is content-hash-pinned here so silent regeneration fails loudly, and fixture matrices prove the intentional-failure cases (edit / delete / rename an old migration, destructive SQL without an approval marker) each fail with an actionable message. Fast, DB-free, deterministic (tmp-dir fixtures + real migrations/ scan).",
  "scanPaths": [
    "migrations"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4179 — guard tests for scripts/lint-migration-immutability.ts
 * (Architecture Governor hardening, first-wave guard #1).
 *
 * Spec matrix (activation sequence's intentional-failure step included):
 *   1. The REAL repository migrations/ tree passes (false-positive review:
 *      zero violations against the reviewed frozen ledger).
 *   2. Intentional failure — editing an old (frozen) migration fails and
 *      names the file + hash mismatch.
 *   3. Deleting a frozen migration fails.
 *   4. Renaming a frozen migration fails (missing old name).
 *   5. Adding a NEW migration passes (append-only history) — but
 *      destructive SQL in a new file fails without the in-file
 *      "-- destructive-approved:" marker and passes (with a notice) with it.
 *   6. Commented-out destructive SQL never trips the scan.
 *   7. Report-only + skip escape hatches are explicit and audited.
 *   8. The ledger cannot be silently rewritten: content-hash pin + the lint
 *      source has no write/update/regeneration path.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  runLint,
  findDestructiveStatements,
  FROZEN_MIGRATION_HASHES,
} from "../scripts/lint-migration-immutability";

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

/** Copy the real migrations tree into a scratch dir we can mutate. */
function cloneMigrations(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lint-migration-immutability-"));
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql"))) {
    copyFileSync(join("migrations", f), join(dir, f));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const SOME_FROZEN = [...FROZEN_MIGRATION_HASHES.keys()].sort()[10];

console.log("1) real repository migrations/ passes (false-positive review)");
{
  const real = runLint({ skipEnv: undefined, reportOnlyEnv: undefined });
  assert(real.ok, `REAL migrations/ passes (${real.violations.length} violations)`);
  assert(!real.skipped && !real.reportOnly, "real run is enforced (not skipped/report-only)");
}

console.log("2) intentional failure: editing an old migration fails");
{
  const { dir, cleanup } = cloneMigrations();
  try {
    writeFileSync(join(dir, SOME_FROZEN), readFileSync(join(dir, SOME_FROZEN), "utf8") + "\n-- tampered\n");
    const res = runLint({ migrationsDir: dir, skipEnv: undefined, reportOnlyEnv: undefined });
    assert(!res.ok, "edited frozen migration fails");
    assert(
      res.violations.some((v) => v.includes(SOME_FROZEN) && v.includes("EDITED")),
      "violation names the edited file and says EDITED with hash evidence",
    );
  } finally {
    cleanup();
  }
}

console.log("3) deleting a frozen migration fails");
{
  const { dir, cleanup } = cloneMigrations();
  try {
    rmSync(join(dir, SOME_FROZEN));
    const res = runLint({ migrationsDir: dir, skipEnv: undefined, reportOnlyEnv: undefined });
    assert(!res.ok, "deleted frozen migration fails");
    assert(
      res.violations.some((v) => v.includes(SOME_FROZEN) && v.includes("MISSING")),
      "violation names the deleted file as MISSING",
    );
  } finally {
    cleanup();
  }
}

console.log("4) renaming a frozen migration fails");
{
  const { dir, cleanup } = cloneMigrations();
  try {
    const renamed = "20991231235959_renamed_history.sql";
    copyFileSync(join(dir, SOME_FROZEN), join(dir, renamed));
    rmSync(join(dir, SOME_FROZEN));
    const res = runLint({ migrationsDir: dir, skipEnv: undefined, reportOnlyEnv: undefined });
    assert(!res.ok, "renamed frozen migration fails (old name missing)");
    assert(
      res.violations.some((v) => v.includes(SOME_FROZEN)),
      "violation names the vanished original filename",
    );
  } finally {
    cleanup();
  }
}

console.log("5) new migrations: append-only pass; destructive SQL needs the marker");
{
  const { dir, cleanup } = cloneMigrations();
  try {
    writeFileSync(
      join(dir, "20991231000000_additive_change.sql"),
      "ALTER TABLE clients ADD COLUMN IF NOT EXISTS widget_flag boolean;\n",
    );
    const additive = runLint({ migrationsDir: dir, skipEnv: undefined, reportOnlyEnv: undefined });
    assert(additive.ok, "new additive migration passes without ledger edits");

    writeFileSync(
      join(dir, "20991231000001_drop_legacy.sql"),
      "DROP TABLE legacy_widgets;\nALTER TABLE clients DROP COLUMN old_flag;\n",
    );
    const unapproved = runLint({ migrationsDir: dir, skipEnv: undefined, reportOnlyEnv: undefined });
    assert(!unapproved.ok, "destructive SQL without approval marker fails");
    assert(
      unapproved.violations.some(
        (v) =>
          v.includes("20991231000001_drop_legacy.sql") &&
          v.includes("DROP TABLE") &&
          v.includes("DROP COLUMN") &&
          v.includes("destructive-approved"),
      ),
      "violation names the file, the destructive statements, and the marker remedy",
    );

    writeFileSync(
      join(dir, "20991231000001_drop_legacy.sql"),
      "-- destructive-approved: owner-approved 2026-08-09; table unused since X, no rewrite/lock risk (drop only)\n" +
        "DROP TABLE legacy_widgets;\nALTER TABLE clients DROP COLUMN old_flag;\n",
    );
    const approved = runLint({ migrationsDir: dir, skipEnv: undefined, reportOnlyEnv: undefined });
    assert(approved.ok, "destructive SQL WITH approval marker passes");
    assert(
      approved.notices.some((n) => n.includes("20991231000001_drop_legacy.sql")),
      "approved destructive migration still surfaces an informational notice",
    );
  } finally {
    cleanup();
  }
}

console.log("6) commented-out destructive SQL never trips the scan");
{
  assert(
    findDestructiveStatements("-- DROP TABLE example;\nSELECT 1;\n").length === 0,
    "line-commented DROP TABLE is ignored",
  );
  assert(
    findDestructiveStatements("ALTER TABLE t ALTER COLUMN c TYPE bigint;").length === 1,
    "ALTER COLUMN … TYPE rewrite is detected",
  );
  assert(
    findDestructiveStatements("ALTER TABLE t ALTER COLUMN c SET NOT NULL;").length === 1,
    "SET NOT NULL is detected",
  );
  assert(
    findDestructiveStatements("CREATE INDEX IF NOT EXISTS i ON t(c);").length === 0,
    "plain CREATE INDEX is deliberately NOT flagged (in-transaction migrations)",
  );
}

console.log("7) report-only and skip escape hatches are explicit");
{
  const { dir, cleanup } = cloneMigrations();
  try {
    writeFileSync(join(dir, SOME_FROZEN), "-- tampered entirely\n");
    const report = runLint({ migrationsDir: dir, skipEnv: undefined, reportOnlyEnv: "1" });
    assert(!report.ok && report.reportOnly, "report-only still REPORTS the violation (ok=false, reportOnly=true)");
    assert(report.summaryLine.includes("REPORT-ONLY"), "report-only is loudly announced");

    const skip = runLint({ migrationsDir: "does-not-exist", skipEnv: "1", reportOnlyEnv: undefined });
    assert(skip.ok && skip.skipped, "LINT_MIGRATION_IMMUTABILITY_SKIP=1 short-circuits with skipped=true");
    assert(skip.summaryLine.includes("SKIPPED"), "skip is loudly announced, never silent");
  } finally {
    cleanup();
  }
}

console.log("8) the frozen ledger cannot be silently rewritten or regenerated");
{
  // (a) Content-hash pin: any edit to FROZEN_MIGRATION_HASHES changes this
  // hash and fails this always-core guard until BOTH files change in one
  // reviewed diff. Recompute with:
  //   npx tsx -e "import {FROZEN_MIGRATION_HASHES} from './scripts/lint-migration-immutability.ts'; import {createHash} from 'node:crypto'; console.log(createHash('sha256').update([...FROZEN_MIGRATION_HASHES.entries()].map(([n,h])=>n+':'+h).sort().join('\n')).digest('hex'))"
  const lines = [...FROZEN_MIGRATION_HASHES.entries()].map(([n, h]) => `${n}:${h}`).sort();
  const hash = createHash("sha256").update(lines.join("\n")).digest("hex");
  assert(
    // Re-freeze #1 (2026-08-10, Task #4190): 190 → 192 entries.
    hash === "b2f7ef74aaa9295b546dcebd092a0116617eff3bb8b103f29b621aea53be2a90",
    `frozen ledger content hash is pinned (got ${hash})`,
  );
  assert(lines.length === 192, `frozen ledger has exactly 192 entries (got ${lines.length})`);

  // (b) No regeneration path: the lint source never writes files and accepts
  // no --update/--refresh/--baseline style flag.
  const src = readFileSync("scripts/lint-migration-immutability.ts", "utf8");
  assert(
    !/writeFileSync|appendFileSync|createWriteStream|\bwriteFile\b|renameSync|copyFileSync/.test(src),
    "lint source contains no file-write API",
  );
  assert(
    !/--update|--refresh|--regen|argv\.slice|argv\.includes|parseArgs|of process\.argv/.test(src),
    "lint source parses no CLI flags (no --update-ledger style path)",
  );
}

console.log("");
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
