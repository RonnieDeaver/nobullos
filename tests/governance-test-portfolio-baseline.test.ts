/* test-registration
{
  "name": "Governance inventory: test-portfolio static baseline (--check freshness + separation from green-baseline) (Task #4178)",
  "regression": true,
  "smoke": true,
  "tier": "small",
  "tierReason": "Deliberately small, overriding the unmeasured default of medium: the generator freshness contract is a bounded filesystem-only check with no database, browser, child process, or network.",
  "smokeReason": "Freshness guard for the committed audits/governance/test-portfolio-baseline.json hardening-epic baseline: any suite add/edit/registration change must regenerate the portfolio inventory in the same diff or the gate fails here. Also proves the generator never touches tests/green-baseline.json. DB-free, seconds-fast.",
  "scanPaths": ["tests", "client/src", "scripts/generate-test-portfolio-baseline.ts", "scripts/governanceInventoryLib.ts", "audits/governance/test-portfolio-baseline.json"]
}
test-registration */
/**
 * Focused test for scripts/generate-test-portfolio-baseline.ts:
 *  1. REAL freshness: committed artifact matches freshly generated facts.
 *  2. Determinism + provenance completeness (generatorVersion, sourceCommit,
 *     universeHash).
 *  3. Row contract: registry metadata, effective timeout, process boundary,
 *     DB-sensitivity hint, size tier, per-suite source hash; this suite indexes itself.
 *  4. Separation: the artifact path is not tests/green-baseline.json and the
 *     generator source never references that file.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generate, generateFacts, cliMain, ARTIFACT_PATH, DEFAULT_TIMEOUT_MS } from "../scripts/generate-test-portfolio-baseline";
import { stableStringify } from "../scripts/governanceInventoryLib";

assert.equal(
  cliMain(["--check"]),
  0,
  `committed ${ARTIFACT_PATH} is stale — regenerate: npx tsx scripts/generate-test-portfolio-baseline.ts`,
);

const doc1 = generate();
const doc2 = generate();
assert.equal(stableStringify(doc1.facts), stableStringify(doc2.facts), "generator is non-deterministic");
assert.ok(doc1.provenance.generatorVersion >= 1);
assert.ok(doc1.provenance.sourceCommit.length > 0);
assert.equal(doc1.provenance.universeHash.length, 64);

const facts = generateFacts();
assert.ok(facts.suites.length > 500, `expected 500+ suites, got ${facts.suites.length}`);
const self = facts.suites.find((s) => s.file === "tests/governance-test-portfolio-baseline.test.ts");
assert.ok(self, "this suite must index itself");
assert.equal(self!.smoke, true);
  assert.equal(self!.tier, "small");
assert.equal(self!.processBoundary, "batchable");
assert.equal(self!.sourceHash.length, 64);
for (const s of facts.suites) {
  assert.ok(s.timeoutMs > 0);
  assert.ok(s.timeoutIsOverride || s.timeoutMs === DEFAULT_TIMEOUT_MS, `${s.file}: bad effective timeout`);
  assert.ok(["solo", "batchable"].includes(s.processBoundary));
  assert.ok(["db-marker-in-file", "hermetic-harness-import", "unknown"].includes(s.dbSensitivityHint));
    assert.ok(["small", "medium", "large"].includes(s.tier ?? ""));
}
assert.equal(facts.totals.suites, facts.suites.length);

// 4. Separation from the green baseline.
assert.notEqual(ARTIFACT_PATH, "tests/green-baseline.json");
assert.ok(!ARTIFACT_PATH.startsWith("tests/"), "portfolio baseline must live in audits/governance/");
const generatorSource = readFileSync("scripts/generate-test-portfolio-baseline.ts", "utf8");
assert.ok(
  !generatorSource.replace(/never reads or writes\s*\n?\s*\* tests\/green-baseline\.json/, "").includes("green-baseline.json"),
  "generator must never reference tests/green-baseline.json outside its doc comment",
);

console.log("governance-test-portfolio-baseline: PASS");
