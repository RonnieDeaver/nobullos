/* test-registration
{
  "name": "Governance inventory: data ownership (--check freshness + generator contract) (Task #4178)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Freshness guard for the committed audits/governance/data-ownership.json hardening-epic baseline: runs the generator's real --check against the committed tree so schema/writer/reader drift fails the gate that caused it instead of rotting until a nightly. DB-free, deterministic source scan, seconds-fast.",
  "scanPaths": ["shared", "server", "scripts/generate-data-ownership-inventory.ts", "scripts/governanceInventoryLib.ts", "audits/governance/data-ownership.json", "audits/governance/overrides/data-ownership.overrides.json"],
  "tier": "small"
}
test-registration */
/**
 * Focused test for scripts/generate-data-ownership-inventory.ts:
 *  1. REAL freshness: committed artifact matches freshly generated facts.
 *  2. Determinism: two generations produce identical facts + universeHash.
 *  3. Every table row carries the full judgment-field set, `unknown` unless
 *     proven; drizzle tables have a model-derived owning domain.
 *  4. Staleness + hand-edit detection via checkArtifact on fixtures.
 *  5. Orphan override keys fail loudly (decisions never silently orphan).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, generateFacts, cliMain, ARTIFACT_PATH } from "../scripts/generate-data-ownership-inventory";
import { applyOverrides, checkArtifact, sha256, stableStringify, sortKeysDeep } from "../scripts/governanceInventoryLib";

// 1. Real freshness check against the committed artifact.
assert.equal(
  cliMain(["--check"]),
  0,
  `committed ${ARTIFACT_PATH} is stale — regenerate: npx tsx scripts/generate-data-ownership-inventory.ts`,
);

// 2. Determinism.
const doc1 = generate();
const doc2 = generate();
assert.equal(stableStringify(doc1.facts), stableStringify(doc2.facts), "generator is non-deterministic");
assert.equal(doc1.provenance.universeHash, doc2.provenance.universeHash);
assert.ok(doc1.provenance.sourceCommit.length > 0);

// 3. Shape: judgment fields present, unknown-unless-proven; clients table proven.
const facts = generateFacts();
assert.ok(facts.tables.length > 100, "expected 100+ tables");
for (const t of facts.tables) {
  for (const field of ["scoping", "sensitivity", "retention", "conflictPolicy", "growthClass"] as const) {
    assert.ok(typeof t[field] === "string" && t[field].length > 0, `${t.table}.${field} missing`);
  }
}
const clients = facts.tables.find((t) => t.table === "clients");
assert.ok(clients, "clients table missing");
assert.equal(clients!.owningDomain, "clients");
assert.ok(clients!.writers.length > 0, "clients writers not derived");
assert.equal(clients!.scoping, "unknown", "judgment fields must stay unknown unless proven/overridden");

// 4. checkArtifact fixtures: stale facts + hand-edited facts both flagged.
const tmp = mkdtempSync(join(tmpdir(), "gov-inv-"));
try {
  const stalePath = join(tmp, "artifact.json");
  const tampered = JSON.parse(JSON.stringify(sortKeysDeep(doc1)));
  tampered.facts.tables[0].table = "phantom_table_zzz";
  tampered.provenance.universeHash = sha256(stableStringify(sortKeysDeep(tampered.facts)));
  writeFileSync(stalePath, JSON.stringify(tampered, null, 2));
  const stale = checkArtifact(stalePath, doc1);
  assert.equal(stale.ok, false, "stale artifact must fail --check");
  assert.ok(stale.problems.some((p) => p.includes("stale committed facts")));

  const handEdited = JSON.parse(JSON.stringify(sortKeysDeep(doc1)));
  handEdited.facts.tables[0].sensitivity = "high"; // edit facts without regenerating hash
  const editPath = join(tmp, "edited.json");
  writeFileSync(editPath, JSON.stringify(handEdited, null, 2));
  const edited = checkArtifact(editPath, doc1);
  assert.equal(edited.ok, false);
  assert.ok(edited.problems.some((p) => p.includes("universeHash mismatch")), "hand-edit must be detected");

  // 5. Orphan override key throws.
  const orphanPath = join(tmp, "orphan.overrides.json");
  writeFileSync(orphanPath, JSON.stringify({ no_such_table_zzz: { sensitivity: "high" } }));
  assert.throws(
    () => applyOverrides(new Map([["clients", { review: undefined }]]), orphanPath),
    /matches no generated entry/,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("governance-data-ownership-inventory: PASS");
