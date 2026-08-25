/* test-registration
{
  "name": "Migration-genesis safeguard wiring — a new migration always gets applied to the scratch hermetic DB during the gate (Task #4594)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4594: the #4503 per-table migration scoping means a table-attributable migration touching only unreferenced tables re-runs zero ordinary DB suites — tests/migration-replay.test.ts (psql-applying every timestamp migration to the scratch hermetic DB) is the SOLE safeguard that a syntactically broken migration of that kind blocks the merge. This guard pins that safeguard's wiring (smoke membership, scanPaths selection, FULL migration fingerprint scope, filename-convention subset proof against the executable prefix-lint regex, gate membership of the prefix/immutability lints) so it cannot silently rot. Milliseconds of fs reads plus one single-suite import trace; no DB.",
  "scanPaths": [
    "tests/migration-replay.test.ts",
    "migrations"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4594 — pin the "migration genesis" safeguard end-to-end wiring.
 *
 * Guarantee under guard, scoped precisely: a NEW timestamp-convention
 * migration file always gets syntax-executed against a scratch hermetic DB
 * during pre-merge validation, INDEPENDENT of which tables it touches, and a
 * failure blocks the merge loudly. (Frozen legacy migrations are a different
 * guarantee: gate-wired lint-migration-immutability blocks any edit/delete/
 * rename of an already-applied file outright — pinned in section 5 — so
 * "changed migration" can only mean a NEW timestamp file.)
 *
 * Delivered today by tests/migration-replay.test.ts, which relies on
 * separately-editable pieces of wiring — each could rot without any existing
 * lint noticing, silently reopening the #4503-review residual gap:
 *
 *   1. The replay suite is registered smoke:true (gate membership) AND
 *      regression:true (nightly), with scanPaths covering "migrations" so
 *      related-smoke selection picks it whenever ANY migrations/ file
 *      changes — no table-reference attribution involved.
 *   2. scanPathHit() (the selection primitive) actually matches a file
 *      inside a declared directory — the semantics scanPaths relies on.
 *   3. The suite's fingerprint is migration-sensitive with scope "full"
 *      (its closure reaches server/devMigrations.ts): ANY migration change
 *      busts its recorded green, so incremental green-skip can never skip
 *      it when a migration changed — even a table-scoped one.
 *   4. Filename-convention SUBSET proof: every filename the EXECUTABLE
 *      lint-migration-prefixes TIMESTAMP_RE accepts is also accepted by the
 *      replay suite's own filter (regex extracted from its source — the
 *      suite is an executable script). Proven over discriminating boundary
 *      cases plus a deterministic generated corpus, so a future broadening
 *      of the lint regex that the replay filter does not follow fails here
 *      — not silently ship un-replayed migrations.
 *   5. Both lint-migration-prefixes (new files must be timestamp-named →
 *      land inside the replayed namespace) and lint-migration-immutability
 *      (frozen history cannot be edited) remain wired into the gate's
 *      LINT_CHECKS.
 *
 * Verified live during Task #4594: an untracked broken migration
 * (`ALTER TABLE nonexistent … ; THIS IS NOT SQL (`) made the replay suite
 * fail with the exact filename and psql syntax error, exiting non-zero.
 */
import { readFileSync } from "node:fs";

import { LINT_CHECKS } from "../scripts/gate";
import { TIMESTAMP_RE as LINT_TIMESTAMP_RE } from "../scripts/lint-migration-prefixes";
import { computeSuiteFingerprints } from "./suiteFingerprint";
import { scanPathHit } from "./relatedSmokeSelection";
import { parseRegistration } from "./testRegistry";

const REPLAY_FILE = "tests/migration-replay.test.ts";

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

async function main(): Promise<void> {
  // ── 1. Gate membership + scanPaths selection wiring ─────────────────────
  const replaySource = readFileSync(REPLAY_FILE, "utf8");
  const { registration, errors } = parseRegistration(replaySource);
  assert(errors.length === 0 && registration, `replay suite registration parses (${errors.join("; ") || "ok"})`);
  assert(registration?.smoke === true, "replay suite is smoke:true — it runs in the pre-merge gate");
  assert(registration?.regression === true, "replay suite is regression:true — nightly sweep coverage");
  assert(
    (registration?.scanPaths ?? []).includes("migrations"),
    'replay suite declares scanPaths ["migrations"] — selected on ANY migrations/ change, independent of table attribution',
  );

  // ── 2. Selection primitive semantics ────────────────────────────────────
  assert(
    scanPathHit("migrations/20991231235959_example.sql", ["migrations"]) === "migrations",
    "scanPathHit matches a new migration file inside the declared migrations/ directory",
  );
  assert(
    scanPathHit("server/db.ts", ["migrations"]) === null, // fs-scan-inputs-ignore -- literal is a negative-match probe passed to scanPathHit, never read from disk
    "scanPathHit does not over-match unrelated files (sanity)",
  );

  // ── 3. Fingerprint scope: FULL — green-skip can never skip the replay
  //       suite across ANY migration change ────────────────────────────────
  const suite = {
    file: REPLAY_FILE,
    scanPaths: registration?.scanPaths,
    extraNodeArgs: registration?.extraNodeArgs,
  };
  const fp = await computeSuiteFingerprints([suite]);
  assert(fp.ok, `fingerprint computation succeeded (${fp.error ?? "ok"})`);
  const info = fp.bySuite.get(REPLAY_FILE);
  assert(info?.migrationSensitive === true, "replay suite is classified migration-sensitive");
  assert(
    info?.migrationScope === "full",
    `replay suite migration scope is "full" (got ${info?.migrationScope ?? "null"}) — any migration change, table-scoped or not, busts its recorded green`,
  );

  // ── 4. Filename-convention SUBSET proof vs the executable lint regex ────
  // Extract the replay suite's own filter from its source (importing the
  // suite would run psql), then prove: lint-accepted ⇒ replay-accepted.
  const reMatch = /const TIMESTAMP_RE = \/(.+)\/;/.exec(replaySource);
  assert(reMatch, "replay suite still declares its TIMESTAMP_RE filename filter");
  if (reMatch) {
    const replayRe = new RegExp(reMatch[1]);

    // Discriminating boundary cases: [name, lint-accepts?]. Each row that
    // the lint accepts MUST be replay-accepted; lint-rejected rows document
    // the boundary (and replay may reject them too — that's fine, they can
    // never reach migrations/ through the gate).
    const boundary: Array<[string, boolean]> = [
      ["20260812153012_add_widget_flags.sql", true],
      ["20991231235959_x.sql", true], // digit extremes inside the 20… namespace
      ["20000101000000_a_b_c.sql", true],
      ["21001231235959_x.sql", false], // 14 digits but not 20… — outside both
      ["19991231235959_x.sql", false],
      ["2026081215301_x.sql", false], // 13 digits
      ["202608121530122_x.sql", false], // 15 digits
      ["20260812153012_Add.sql", false], // uppercase description
      ["20260812153012_.sql", false], // empty description
      ["20260812153012-x.sql", false], // wrong separator
      ["20260812153012_x.SQL", false], // wrong extension case
      ["0099_legacy_style.sql", false], // legacy numeric prefix — frozen namespace
    ];
    for (const [name, lintAccepts] of boundary) {
      assert(
        LINT_TIMESTAMP_RE.test(name) === lintAccepts,
        `lint TIMESTAMP_RE ${lintAccepts ? "accepts" : "rejects"} ${name} (boundary pin)`,
      );
      if (LINT_TIMESTAMP_RE.test(name)) {
        assert(replayRe.test(name), `replay filter accepts lint-accepted ${name} (subset proof)`);
      }
    }

    // Deterministic generated corpus: every lint-accepted candidate must be
    // replay-accepted. Mixes valid/invalid prefixes and description chars.
    const prefixes = ["20", "21", "19", "2a"];
    const digitBodies = ["000000000000", "991231235959", "260812153012", "26081215301", "2608121530122"];
    const descs = ["a", "add_widget_flags", "x9_y", "Bad", "", "has-dash", "has.dot"];
    let corpusChecked = 0;
    let subsetViolations = 0;
    for (const p of prefixes) {
      for (const d of digitBodies) {
        for (const desc of descs) {
          const name = `${p}${d}_${desc}.sql`;
          corpusChecked++;
          if (LINT_TIMESTAMP_RE.test(name) && !replayRe.test(name)) {
            subsetViolations++;
            console.error(`    subset violation: lint accepts but replay rejects ${name}`);
          }
        }
      }
    }
    assert(
      subsetViolations === 0,
      `generated corpus (${corpusChecked} candidates): every lint-accepted filename is replay-accepted`,
    );
  }

  // ── 5. Gate wiring of the two migration lints ────────────────────────────
  const lintNames = new Set(LINT_CHECKS.map((c) => c.name));
  assert(
    lintNames.has("lint-migration-prefixes"),
    "gate LINT_CHECKS includes lint-migration-prefixes — every NEW migration is forced into the timestamp namespace the replay suite covers",
  );
  assert(
    lintNames.has("lint-migration-immutability"),
    "gate LINT_CHECKS includes lint-migration-immutability — frozen/applied migrations cannot be edited, so 'changed migration' can only mean a new timestamp file",
  );

  console.log("");
  console.log(`Result: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("migration-genesis-wiring guard crashed:", err);
  process.exit(1);
});
