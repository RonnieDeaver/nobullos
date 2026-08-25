/* test-registration
{
  "name": "Governance inventory: integration reliability (--check freshness + registry validation) (Task #4178)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Freshness guard for the committed audits/governance/integration-reliability.json hardening-epic baseline: runs the generator's real --check, whose generation step existence-verifies every curated adapter/receiver file and credential env-name against the tree — an adapter rename or lane retirement fails here instead of rotting. DB-free, seconds-fast.",
  "scanPaths": ["server", "scripts/generate-integration-reliability-inventory.ts", "scripts/governanceInventoryLib.ts", "audits/governance/integration-reliability.json", "audits/governance/overrides/integration-reliability.overrides.json"],
  "tier": "small"
}
test-registration */
/**
 * Focused test for scripts/generate-integration-reliability-inventory.ts:
 *  1. REAL freshness: committed artifact matches freshly generated facts
 *     (generation itself validates adapter files exist + env names appear).
 *  2. Determinism.
 *  3. Every vendor row carries the full epic field set; grandfathered gaps
 *     stay visible as "unknown"; criticality tiers are assigned T1/T2/T3.
 *  4. T1 set matches the decision-ledger definition.
 */
import assert from "node:assert/strict";
import { generate, generateFacts, cliMain, ARTIFACT_PATH } from "../scripts/generate-integration-reliability-inventory";
import { stableStringify } from "../scripts/governanceInventoryLib";

assert.equal(
  cliMain(["--check"]),
  0,
  `committed ${ARTIFACT_PATH} is stale — regenerate: npx tsx scripts/generate-integration-reliability-inventory.ts`,
);

const doc1 = generate();
const doc2 = generate();
assert.equal(stableStringify(doc1.facts), stableStringify(doc2.facts), "generator is non-deterministic");

const facts = generateFacts();
assert.ok(facts.vendors.length >= 12, `expected 12+ vendors, got ${facts.vendors.length}`);
for (const v of facts.vendors) {
  assert.ok(["T1", "T2", "T3"].includes(v.criticalityTier), `${v.vendor}: bad tier`);
  assert.ok(["outbound", "inbound", "bidirectional"].includes(v.direction), `${v.vendor}: bad direction`);
  assert.ok(v.adapterFiles.length > 0, `${v.vendor}: no adapter files`);
  for (const field of ["owner", "retryTaxonomy", "idempotency", "auditStatusAlerts", "retention", "testBoundary"] as const) {
    assert.ok(typeof v[field] === "string" && v[field].length > 0, `${v.vendor}.${field} missing`);
  }
}
const t1 = facts.vendors.filter((v) => v.criticalityTier === "T1").map((v) => v.vendor).sort();
assert.deepEqual(t1, ["front", "openai", "twilio", "zoom"], "T1 tier drifted from the decision-ledger definition");

const front = facts.vendors.find((v) => v.vendor === "front")!;
assert.ok(front.webhookReceivers.length > 0, "front webhook receiver missing");
assert.equal(front.owner, "unknown", "grandfathered gaps must stay visible as unknown");

console.log("governance-integration-reliability-inventory: PASS");
