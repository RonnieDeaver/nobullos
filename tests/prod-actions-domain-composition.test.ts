/* test-registration
{
  "name": "Prod-actions domain composition guard (F7, Task #4154)",
  "regression": true,
  "smoke": true,
  "smokeReason": "F7 (Task #4154): the registry is composed from explicit domain modules; this guard is what makes a duplicated action id across domains, an ordered-array entry with no owning domain, a domain action dropped from the ordered array, or an emptied domain module fail the boot instead of shipping silently. Runs against both the real composed registry (positive) and synthetic violating fixtures (negatives).",
  "scanPaths": [
    "server/services/prodActionsRegistry.ts",
    "server/services/prodActions"
  ],
  "tier": "small"
}
test-registration */
/**
 * F7 (Task #4154) — composition-root guard for the domain-split registry.
 *
 * The monolithic prodActionsRegistry.ts was split into domain modules under
 * server/services/prodActions/ composed by an explicit, statically imported
 * root (no discovery, no globs). Two views of the registry now exist:
 *   - each domain module's `ProdActionDomain` collection (ownership), and
 *   - the ordered PROD_ACTIONS literal in composition.ts (operator-facing
 *     panel + apply-all execution order).
 * assertProdActionDomainComposition() is the module-load contract that the
 * two views agree exactly. This suite proves:
 *
 * Part A — the REAL composed registry satisfies the contract (and the domain
 *          collections partition PROD_ACTIONS: same total, unique ids,
 *          unique domain names, no empty domain).
 * Part B — synthetic negative fixtures each throw loudly:
 *          B1 duplicate id across two domains;
 *          B2 duplicate id within one domain;
 *          B3 ordered-array entry owned by no registered domain (the
 *             "missing domain module" failure — e.g. a domain import
 *             dropped from composition.ts while its actions stay listed);
 *          B4 domain action missing from the ordered array;
 *          B5 empty domain collection (emptied module / rotted list);
 *          B6 same id listed twice in the ordered array (would render twice
 *             in the operator panel and Apply-all would execute it twice);
 *          B7 ordered entry substituted with a different object sharing an
 *             owned id (must be the domain-registered instance itself).
 *
 * Pure module-level checks — no DB, no network, no timers.
 */

import assert from "node:assert/strict";

import {
  assertProdActionDomainComposition,
  type ProdAction,
  type ProdActionDomain,
} from "../server/services/prodActions/kernel";
import {
  PROD_ACTIONS,
  PROD_ACTION_DOMAINS,
} from "../server/services/prodActions/composition";
import { PROD_ACTIONS as ROOT_PROD_ACTIONS } from "../server/services/prodActionsRegistry";

function mkAction(id: string): ProdAction {
  return {
    id,
    title: "synthetic",
    description: "synthetic",
    change: "synthetic",
    convergence: { kind: "converging" },
    status: async () => ({ state: "not-needed", detail: "" }),
    apply: async () => ({ state: "not-needed", detail: "" }),
  } as ProdAction;
}

function domain(name: string, actions: ProdAction[]): ProdActionDomain {
  return { name, actions };
}

async function main(): Promise<void> {
  // ── Part A — real registry satisfies the composition contract ─────────
  assert.doesNotThrow(() =>
    assertProdActionDomainComposition(PROD_ACTION_DOMAINS, PROD_ACTIONS),
  );

  const domainNames = PROD_ACTION_DOMAINS.map((d) => d.name);
  assert.equal(
    new Set(domainNames).size,
    domainNames.length,
    "domain names must be unique",
  );
  for (const d of PROD_ACTION_DOMAINS) {
    assert.ok(d.actions.length > 0, `domain "${d.name}" must not be empty`);
  }
  const totalAcrossDomains = PROD_ACTION_DOMAINS.reduce(
    (n, d) => n + d.actions.length,
    0,
  );
  assert.equal(
    totalAcrossDomains,
    PROD_ACTIONS.length,
    "domain collections must partition PROD_ACTIONS exactly (no overlap, no stragglers)",
  );
  const ids = PROD_ACTIONS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "action ids must be unique");

  // The public root re-exports the same composed array object (specifier
  // stability for the ~60 existing importers).
  assert.equal(
    ROOT_PROD_ACTIONS,
    PROD_ACTIONS,
    "root PROD_ACTIONS must be the same object as the composition's",
  );

  // ── Part B — synthetic violations each fail loudly ────────────────────
  const a1 = mkAction("f7_fixture_alpha");
  const a2 = mkAction("f7_fixture_beta");
  const a1dup = mkAction("f7_fixture_alpha");

  // B1: duplicate id across two domains.
  assert.throws(
    () =>
      assertProdActionDomainComposition(
        [domain("d1", [a1]), domain("d2", [a1dup])],
        [a1],
      ),
    /duplicate action id "f7_fixture_alpha" across domains "d1" and "d2"/,
  );

  // B2: duplicate id within one domain.
  assert.throws(
    () =>
      assertProdActionDomainComposition([domain("d1", [a1, a1dup])], [a1]),
    /duplicate action id "f7_fixture_alpha" across domains "d1" and "d1"/,
  );

  // B3: ordered entry owned by no registered domain (missing-domain fixture:
  // composition lists the action but its domain module was never registered).
  assert.throws(
    () =>
      assertProdActionDomainComposition([domain("d1", [a1])], [a1, a2]),
    /entry "f7_fixture_beta" is not owned by any registered domain/,
  );

  // B4: domain action missing from the ordered array.
  assert.throws(
    () =>
      assertProdActionDomainComposition(
        [domain("d1", [a1]), domain("d2", [a2])],
        [a1],
      ),
    /action "f7_fixture_beta" from domain "d2" is missing from the ordered PROD_ACTIONS array/,
  );

  // B5: empty domain collection.
  assert.throws(
    () =>
      assertProdActionDomainComposition(
        [domain("d1", [a1]), domain("empty-domain", [])],
        [a1],
      ),
    /domain "empty-domain" registered no actions/,
  );

  // B6: duplicate entry in the ordered array (id owned by a domain — the
  // ownership check alone would accept it; the panel would render it twice
  // and Apply-all would execute it twice).
  assert.throws(
    () =>
      assertProdActionDomainComposition(
        [domain("d1", [a1, a2])],
        [a1, a2, a1],
      ),
    /duplicate PROD_ACTIONS entry "f7_fixture_alpha"/,
  );

  // B7: ordered entry substituted with a DIFFERENT object sharing an owned
  // id — must be rejected; only the domain-registered instance may be listed.
  assert.throws(
    () =>
      assertProdActionDomainComposition(
        [domain("d1", [a1, a2])],
        [a1dup, a2],
      ),
    /entry "f7_fixture_alpha" is not the object registered by domain "d1"/,
  );

  console.log(
    `prod-actions-domain-composition: OK — ${PROD_ACTION_DOMAINS.length} domains / ${PROD_ACTIONS.length} actions partitioned; 7 synthetic violations rejected`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
