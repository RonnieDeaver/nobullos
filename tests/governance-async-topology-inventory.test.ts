/* test-registration
{
  "name": "Governance inventory: async topology (--check freshness + generator contract) (Task #4178)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Freshness guard for the committed audits/governance/async-topology.json hardening-epic baseline: runs the generator's real --check so new/renamed queue handlers, schedulers, or interval surfaces fail the gate that introduced them. DB-free, deterministic source scan, seconds-fast.",
  "scanPaths": ["server/services", "server/boot", "server/routes", "scripts/generate-async-topology-inventory.ts", "scripts/governanceInventoryLib.ts", "audits/governance/async-topology.json", "audits/governance/overrides/async-topology.overrides.json"],
  "tier": "small"
}
test-registration */
/**
 * Focused test for scripts/generate-async-topology-inventory.ts:
 *  1. REAL freshness: committed artifact matches freshly generated facts.
 *  2. Determinism.
 *  3. Known topology members are captured: a queue handler registered in
 *     workQueueHandlers.ts, a scheduler label from schedulerInits.ts with a
 *     resolved module, WORKER_STAGGER_OFFSETS keys, shared mechanisms.
 *  4. Judgment fields default to "unknown" (never guessed).
 */
import assert from "node:assert/strict";
import { generate, generateFacts, cliMain, ARTIFACT_PATH } from "../scripts/generate-async-topology-inventory";
import { stableStringify } from "../scripts/governanceInventoryLib";

assert.equal(
  cliMain(["--check"]),
  0,
  `committed ${ARTIFACT_PATH} is stale — regenerate: npx tsx scripts/generate-async-topology-inventory.ts`,
);

const doc1 = generate();
const doc2 = generate();
assert.equal(stableStringify(doc1.facts), stableStringify(doc2.facts), "generator is non-deterministic");

const facts = generateFacts();
assert.ok(facts.handlers.length >= 50, `expected 50+ handlers, got ${facts.handlers.length}`);
const apply = facts.handlers.find((h) => h.jobType === "communication_apply");
assert.ok(apply, "communication_apply handler missing");
assert.ok(apply!.registeredIn.length > 0);
assert.ok(apply!.referencedBy.length >= apply!.registeredIn.length);
assert.equal(apply!.class, "unknown", "judgment fields must stay unknown unless overridden");

assert.ok(facts.schedulers.length >= 40, `expected 40+ schedulers, got ${facts.schedulers.length}`);
const memWatch = facts.schedulers.find((s) => s.label === "memory-watchdog-init");
assert.ok(memWatch, "memory-watchdog-init scheduler missing");
assert.ok(memWatch!.module.startsWith("server/services/"), `module not resolved: ${memWatch!.module}`);

// Constant-backed registrations must resolve to their string values — both
// same-module constants (zoom_face_sentiment_sweep) and imported ones
// (user_slack_dm, heatmap_coverage_check) — and unresolvable identifiers must
// surface loudly instead of being silently omitted.
for (const jt of ["user_slack_dm", "heatmap_coverage_check", "zoom_face_sentiment_sweep", "zoom_match_sweep"]) {
  assert.ok(facts.handlers.some((h) => h.jobType === jt), `constant-backed handler ${jt} missing from inventory`);
}
assert.ok(
  !facts.handlers.some((h) => h.jobType.startsWith("unresolved-constant:") || h.jobType.startsWith("ambiguous-constant:")),
  `unresolved constant-backed handler registration(s): ${facts.handlers.filter((h) => h.jobType.includes("-constant:")).map((h) => h.jobType).join(", ")} — define the queue-name constant as a string literal the generator can resolve`,
);

assert.ok(facts.workerStaggerOffsetKeys.includes("front_sync"), "WORKER_STAGGER_OFFSETS keys not parsed");
assert.ok(facts.intervalSurfaces.length > 0, "no interval surfaces found");
assert.ok(facts.sharedMechanisms.queue.includes("dead_letter"));
assert.ok(facts.sharedMechanisms.pauseDrain.includes("queueDrainControl"));

console.log("governance-async-topology-inventory: PASS");
