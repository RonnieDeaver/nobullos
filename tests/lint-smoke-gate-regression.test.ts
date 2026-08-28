/* test-registration
{
  "name": "lint-smoke-gate-regression guard (Task #2616, reworked by Task #3786)",
  "regression": true,
  "smoke": true,
  "tier": "small",
  "smokeReason": "Task #2616/#3786: the smoke-gate guard's own test. This guard stops the recurring \"regression-flagged-but-unselected\" rot (#2523 / #2554 / #2577 / #2599 / #2601); since #3786 the decision lives in each test's own registration block (smoke+smokeReason vs sweepOnlyReason) instead of a shared baseline file. The final assertions run the lint over the REAL repo. Fast, DB-free, deterministic.",
  "notes": "Tier reconciled to the mechanical unmeasured default during the 2026-08 blocking-portfolio audit; membership is unchanged."
}
test-registration */
/**
 * Tests for scripts/lint-smoke-gate-regression.ts (Task #2616, reworked by
 * Task #3786: the smoke-vs-sweep gate decision now lives in each test file's
 * own `/* test-registration` block — no SMOKE_FILES set, no baseline txt).
 *
 * Covers:
 *  - validateGateDecision semantics (all five rule classes)
 *  - runLint over a fixture tree (offenders, counts, structural fallthrough)
 *  - the real repo is clean (every regression test records its decision)
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  DEFAULT_FROZEN_PATH,
  FROZEN_SNAPSHOT_SHA256,
  MIGRATED_BOILERPLATE_PREFIX,
  runLint,
} from "../scripts/lint-smoke-gate-regression";
import { validateGateDecision } from "./testRegistry";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function block(json: unknown): string {
  return `/* test-registration\n${JSON.stringify({ tier: "medium", ...(json as object) }, null, 2)}\ntest-registration */\nexport {};\n`;
}

// ---------------------------------------------------------------------------
console.log("validateGateDecision — rule classes");
{
  check("plain test (no flags) is fine", validateGateDecision({ name: "X" }).length === 0);
  check(
    "regression + smoke + smokeReason is fine",
    validateGateDecision({ name: "X", regression: true, smoke: true, smokeReason: "fast" }).length === 0,
  );
  check(
    "regression + sweepOnlyReason is fine",
    validateGateDecision({ name: "X", regression: true, sweepOnlyReason: "DB-heavy" }).length === 0,
  );
  check(
    "non-regression smoke + smokeReason is fine",
    validateGateDecision({ name: "X", smoke: true, smokeReason: "fast" }).length === 0,
  );

  const gap = validateGateDecision({ name: "X", regression: true });
  check(
    "regression without a decision is the silent-gap error",
    gap.some((e) => /sweepOnlyReason/.test(e)),
    gap.join("; "),
  );
  check(
    "smoke without smokeReason is an error",
    validateGateDecision({ name: "X", smoke: true }).some((e) => /smokeReason/.test(e)),
  );
  check(
    "smoke + sweepOnlyReason is a contradiction",
    validateGateDecision({
      name: "X",
      regression: true,
      smoke: true,
      smokeReason: "fast",
      sweepOnlyReason: "slow",
    }).some((e) => /contradicts/.test(e)),
  );
  check(
    "sweepOnlyReason without regression is an error",
    validateGateDecision({ name: "X", sweepOnlyReason: "slow" }).length === 1,
  );
  check(
    "smokeReason without smoke is an error",
    validateGateDecision({ name: "X", smokeReason: "fast" }).length === 1,
  );
}

// ---------------------------------------------------------------------------
console.log("runLint — fixture tree");
const root = mkdtempSync(join(tmpdir(), "lint-smoke-gate-"));
try {
  mkdirSync(join(root, "tests"), { recursive: true });
  mkdirSync(join(root, "client/src"), { recursive: true });

  // Good shapes:
  writeFileSync(join(root, "tests/plain.test.ts"), block({ name: "Plain" }));
  writeFileSync(
    join(root, "tests/gated.test.ts"),
    block({ name: "Gated", regression: true, smoke: true, smokeReason: "fast pure logic" }),
  );
  writeFileSync(
    join(root, "tests/sweep-only.test.ts"),
    block({ name: "SweepOnly", regression: true, sweepOnlyReason: "shared-DB drain contention" }),
  );
  // Offenders:
  writeFileSync(join(root, "tests/gap.test.ts"), block({ name: "Gap", regression: true }));
  writeFileSync(
    join(root, "tests/noreason.test.ts"),
    block({ name: "NoReason", smoke: true }),
  );
  writeFileSync(
    join(root, "tests/contradiction.test.ts"),
    block({
      name: "Contra",
      regression: true,
      smoke: true,
      smokeReason: "fast",
      sweepOnlyReason: "slow",
    }),
  );
  // client/src regression test without a decision — the pre-#3786 lint only
  // matched `file: "tests/..."` entries, so this class was invisible to it.
  writeFileSync(join(root, "client/src/blind.test.ts"), block({ name: "Blind", regression: true }));
  // Structurally broken block → surfaced here as unreadable.
  writeFileSync(join(root, "tests/broken.test.ts"), "/* test-registration\n{ nope\n");
  writeFileSync(
    join(root, "tests/missing-tier.test.ts"),
    `/* test-registration\n${JSON.stringify({ name: "Missing tier" }, null, 2)}\ntest-registration */\nexport {};\n`,
  );

  const res = runLint({ repoRoot: root, grandfatheredPath: join(root, "no-grandfathered.txt") });
  check("fixture: not ok", res.ok === false);
  check("fixture: regressionCount", res.regressionCount === 5, String(res.regressionCount));
  check("fixture: gatedCount", res.gatedCount === 2, String(res.gatedCount));
  check("fixture: sweepOnlyCount", res.sweepOnlyCount === 1, String(res.sweepOnlyCount));
  const files = res.offenders.map((o) => o.file);
  check("fixture: silent gap flagged", files.includes("tests/gap.test.ts"));
  check("fixture: smoke-without-reason flagged", files.includes("tests/noreason.test.ts"));
  check("fixture: contradiction flagged", files.includes("tests/contradiction.test.ts"));
  check(
    "fixture: client/src gap flagged (old lint's blind spot closed)",
    files.includes("client/src/blind.test.ts"),
  );
  check(
    "fixture: broken block surfaced as unreadable",
    res.offenders.some((o) => o.file === "tests/broken.test.ts" && /unreadable/.test(o.message)),
  );
  check(
    "fixture: missing tier flagged with a remedy",
    res.offenders.some((o) => o.file === "tests/missing-tier.test.ts" && /"tier" is required/.test(o.message)),
  );
  check(
    "fixture: compliant files not flagged",
    !files.includes("tests/plain.test.ts") &&
      !files.includes("tests/gated.test.ts") &&
      !files.includes("tests/sweep-only.test.ts"),
  );

  // Record the missing decisions → lint turns green.
  writeFileSync(
    join(root, "tests/gap.test.ts"),
    block({ name: "Gap", regression: true, sweepOnlyReason: "slow e2e" }),
  );
  writeFileSync(
    join(root, "tests/noreason.test.ts"),
    block({ name: "NoReason", smoke: true, smokeReason: "fast" }),
  );
  writeFileSync(
    join(root, "tests/contradiction.test.ts"),
    block({ name: "Contra", regression: true, smoke: true, smokeReason: "fast" }),
  );
  writeFileSync(
    join(root, "client/src/blind.test.ts"),
    block({ name: "Blind", regression: true, smoke: true, smokeReason: "fast jsdom render" }),
  );
  writeFileSync(join(root, "tests/broken.test.ts"), block({ name: "Fixed" }));
  writeFileSync(join(root, "tests/missing-tier.test.ts"), block({ name: "Tier fixed" }));
  const green = runLint({ repoRoot: root, grandfatheredPath: join(root, "no-grandfathered.txt") });
  check(
    "fixture: all decisions recorded → ok",
    green.ok === true && green.regressionCount === 5,
    JSON.stringify(green.offenders),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Task #3841 — migrated-boilerplate ratchet: the no-reason boilerplate that
// the #3786 conversion stamped is frozen to a grandfathered list; new
// sweep-only decisions must state a real reason, and stale list entries fail.
console.log("runLint — grandfathered-boilerplate ratchet (Task #3841)");
const root2 = mkdtempSync(join(tmpdir(), "lint-smoke-gate-gf-"));
try {
  mkdirSync(join(root2, "tests"), { recursive: true });
  const boiler =
    MIGRATED_BOILERPLATE_PREFIX +
    " (scripts/lint-smoke-gate-regression.baseline.txt), which recorded no reason for this file.";
  writeFileSync(
    join(root2, "tests/grandfathered.test.ts"),
    block({ name: "GF", regression: true, sweepOnlyReason: boiler }),
  );
  writeFileSync(
    join(root2, "tests/new-boiler.test.ts"),
    block({ name: "NewBoiler", regression: true, sweepOnlyReason: boiler }),
  );
  writeFileSync(
    join(root2, "tests/real-reason.test.ts"),
    block({ name: "Real", regression: true, sweepOnlyReason: "DB-heavy e2e; routes gated elsewhere" }),
  );
  const gfPath = join(root2, "grandfathered.txt");
  writeFileSync(
    gfPath,
    "# comment line\n\ntests/grandfathered.test.ts\ntests/stale-entry.test.ts\n",
  );
  // Fixture frozen snapshot (the immutable ceiling) + its hash pin.
  const frozenPath = join(root2, "frozen.txt");
  const frozenContent = "# frozen\ntests/grandfathered.test.ts\ntests/stale-entry.test.ts\n";
  writeFileSync(frozenPath, frozenContent);
  const frozenSha256 = createHash("sha256").update(frozenContent).digest("hex");
  const gfOpts = { repoRoot: root2, grandfatheredPath: gfPath, frozenPath, frozenSha256 };

  const res = runLint(gfOpts);
  check("ratchet: not ok", res.ok === false);
  check("ratchet: boilerplateCount counts only grandfathered", res.boilerplateCount === 1, String(res.boilerplateCount));
  check(
    "ratchet: new boilerplate use flagged",
    res.offenders.some((o) => o.file === "tests/new-boiler.test.ts" && /frozen/.test(o.message)),
  );
  check(
    "ratchet: stale grandfathered entry flagged",
    res.offenders.some((o) => o.file === "tests/stale-entry.test.ts" && /stale entry/.test(o.message)),
  );
  check(
    "ratchet: grandfathered + substantive reasons not flagged",
    !res.offenders.some(
      (o) => o.file === "tests/grandfathered.test.ts" || o.file === "tests/real-reason.test.ts",
    ),
    JSON.stringify(res.offenders),
  );

  // Upgrade the new-boiler suite to a real reason + prune the stale line → green.
  writeFileSync(
    join(root2, "tests/new-boiler.test.ts"),
    block({ name: "NewBoiler", regression: true, sweepOnlyReason: "slow isolated-schema walk" }),
  );
  writeFileSync(gfPath, "tests/grandfathered.test.ts\n");
  const green2 = runLint(gfOpts);
  check("ratchet: upgraded + pruned → ok", green2.ok === true, JSON.stringify(green2.offenders));

  // Missing list file = nothing grandfathered (fixture trees): boilerplate fails.
  const missing = runLint({ ...gfOpts, grandfatheredPath: join(root2, "nope.txt") });
  check(
    "ratchet: missing list → boilerplate use fails",
    missing.offenders.some((o) => o.file === "tests/grandfathered.test.ts"),
  );

  // ADDITION attack: keep the boilerplate on a NEW suite and add its path to
  // the editable grandfathered list in the same change. The frozen snapshot
  // is the ceiling — the addition must still fail.
  writeFileSync(
    join(root2, "tests/new-boiler.test.ts"),
    block({ name: "NewBoiler", regression: true, sweepOnlyReason: boiler }),
  );
  writeFileSync(gfPath, "tests/grandfathered.test.ts\ntests/new-boiler.test.ts\n");
  const added = runLint(gfOpts);
  check("ratchet: added grandfather entry → not ok", added.ok === false);
  check(
    "ratchet: addition flagged as shrink-only violation",
    added.offenders.some((o) => o.file === "tests/new-boiler.test.ts" && /shrink-only/.test(o.message)),
    JSON.stringify(added.offenders),
  );

  // TAMPER attack: editing the frozen snapshot itself (to admit the addition)
  // trips the pinned-hash check.
  writeFileSync(frozenPath, frozenContent + "tests/new-boiler.test.ts\n");
  const tampered = runLint(gfOpts);
  check(
    "ratchet: tampered frozen snapshot → hash-mismatch offender",
    tampered.offenders.some((o) => /hash mismatch/.test(o.message)),
    JSON.stringify(tampered.offenders.map((o) => o.message)),
  );

  // MISSING frozen snapshot (deleted) also fails.
  rmSync(frozenPath);
  const noFrozen = runLint(gfOpts);
  check(
    "ratchet: missing frozen snapshot → offender",
    noFrozen.offenders.some((o) => /frozen snapshot missing/.test(o.message)),
  );
} finally {
  rmSync(root2, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Real repo: the committed frozen snapshot matches its pinned hash, and the
// live grandfathered list is a subset of it.
console.log("real repo — frozen snapshot integrity");
{
  const rawFrozen = readFileSync(DEFAULT_FROZEN_PATH, "utf8");
  const sha = createHash("sha256").update(rawFrozen).digest("hex");
  check("real repo: frozen snapshot hash matches the pin", sha === FROZEN_SNAPSHOT_SHA256, sha);
}

// ---------------------------------------------------------------------------
console.log("real repo is clean");
{
  const real = runLint();
  check("real repo: ok", real.ok === true, JSON.stringify(real.offenders.slice(0, 5)));
  check(
    "real repo: regression population sane (>400)",
    real.regressionCount > 400,
    String(real.regressionCount),
  );
  check(
    "real repo: every regression test gated or recorded sweep-only",
    real.gatedCount + real.sweepOnlyCount === real.regressionCount,
    `${real.gatedCount} + ${real.sweepOnlyCount} !== ${real.regressionCount}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll lint-smoke-gate-regression checks passed");
