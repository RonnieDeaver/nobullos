/* test-registration
{
  "name": "RIS launch-only period contract (Task #2367)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Smoke-gate member migrated from the pre-#3786 SMOKE_FILES set (no explanatory comment was recorded).",
  "tier": "small"
}
test-registration */
/**
 * RIS launch-only period contract regression test (Task #2367).
 *
 * Bug (code review round 3): the result-save route forced launch-only
 * results to a static `period = "launch"` sentinel, while the read path
 * (expandInstances) generated/looked up SCOPED launch periods
 * (`launch:<scopeSig>` for product-level checks, `launch:loc:<id>` for
 * location-specific ones). Saved launch results therefore never matched
 * the rendered instance, so launch checks appeared perpetually untouched
 * and the intended "re-open on scope change" behaviour was broken.
 *
 * Fix: both paths now derive the period from the SAME shared helper
 * `launchPeriodFor(...)`. This test locks that contract:
 *   (1) product-level: same product mix + location set => same key
 *       (write matches read), so a saved result resolves its instance.
 *   (2) product-level: changing the product mix OR the active location
 *       set => a DIFFERENT key (the check re-opens as untouched).
 *   (3) location-specific: each location id gets its own key, and a
 *       newly added location gets a fresh (untouched) key while the
 *       existing one is unchanged.
 *   (4) the helper is order-insensitive (sorted basis) so cosmetic
 *       reordering of products/locations does NOT spuriously re-open.
 */

import assert from "node:assert/strict";

import { launchPeriodFor, LAUNCH_PERIOD } from "../server/services/ris/risService";
import { isFlagWorthy } from "../server/services/ris/risFlagging";

/**
 * Escalation semantics (Task #2367, code review round 4).
 *
 * Requirement: flag on High/Critical Fails AND on Blocked (Blocked
 * escalates regardless of severity — an operator is actively stuck).
 * Round 4 bug: blocked was severity-gated to high+, so low/medium blocked
 * results never alerted. Lock the corrected matrix here.
 */
function runFlagSemantics() {
  // Blocked always flags, at every severity.
  for (const sev of ["low", "medium", "high", "critical"]) {
    assert.equal(
      isFlagWorthy("blocked", sev),
      true,
      `blocked must flag at severity=${sev}`,
    );
  }

  // Fail flags only at high / critical.
  assert.equal(isFlagWorthy("fail", "low"), false, "low fail must not flag");
  assert.equal(isFlagWorthy("fail", "medium"), false, "medium fail must not flag");
  assert.equal(isFlagWorthy("fail", "high"), true, "high fail must flag");
  assert.equal(isFlagWorthy("fail", "critical"), true, "critical fail must flag");

  // Non-fail / non-blocked statuses never flag, regardless of severity.
  for (const status of ["pass", "na", "needs_review", null, undefined]) {
    assert.equal(
      isFlagWorthy(status, "critical"),
      false,
      `status=${status} must never flag`,
    );
  }

  console.log("ris-flag-semantics: all cases passed");
}

function run() {
  // (1) write/read contract: identical scope inputs -> identical key.
  const products = ["gbp", "google_ads"];
  const locationIds = ["loc-a", "loc-b"];
  const readKey = launchPeriodFor(false, null, products, locationIds);
  const writeKey = launchPeriodFor(false, null, products, locationIds);
  assert.equal(writeKey, readKey, "same scope must yield the same period key");
  assert.ok(
    readKey.startsWith(`${LAUNCH_PERIOD}:`),
    "product-level launch period must be scope-signature keyed",
  );

  // (4) order-insensitive: reordering inputs must NOT change the key.
  const reordered = launchPeriodFor(
    false,
    null,
    ["google_ads", "gbp"],
    ["loc-b", "loc-a"],
  );
  assert.equal(reordered, readKey, "reordered scope must not re-open the check");

  // (2a) product mix change -> different key (re-opens as untouched).
  const productsChanged = launchPeriodFor(
    false,
    null,
    ["gbp"],
    locationIds,
  );
  assert.notEqual(
    productsChanged,
    readKey,
    "changing the product mix must re-open the launch check",
  );

  // (2b) active location set change -> different key.
  const locationsChanged = launchPeriodFor(
    false,
    null,
    products,
    ["loc-a", "loc-b", "loc-c"],
  );
  assert.notEqual(
    locationsChanged,
    readKey,
    "changing the active location set must re-open the launch check",
  );

  // (3) location-specific: each location keys independently.
  const locA = launchPeriodFor(true, "loc-a", products, locationIds);
  const locB = launchPeriodFor(true, "loc-b", products, locationIds);
  assert.equal(locA, `${LAUNCH_PERIOD}:loc:loc-a`);
  assert.equal(locB, `${LAUNCH_PERIOD}:loc:loc-b`);
  assert.notEqual(locA, locB, "distinct locations must get distinct keys");

  // location-specific key is stable regardless of the surrounding scope,
  // so an existing location is NOT re-opened when another is added.
  const locAAfterAdd = launchPeriodFor(true, "loc-a", products, [
    ...locationIds,
    "loc-c",
  ]);
  assert.equal(
    locAAfterAdd,
    locA,
    "existing location must keep its key when a new location is added",
  );
  const locCNew = launchPeriodFor(true, "loc-c", products, [
    ...locationIds,
    "loc-c",
  ]);
  assert.equal(locCNew, `${LAUNCH_PERIOD}:loc:loc-c`);
  assert.notEqual(locCNew, locA, "newly added location gets its own fresh key");

  // location-specific check with NO location falls back to scope signature
  // (mirrors expandInstances' scopes=[null] branch).
  const locSpecificNoLoc = launchPeriodFor(true, null, products, locationIds);
  assert.equal(
    locSpecificNoLoc,
    readKey,
    "location-specific check without a location uses the scope signature",
  );

  console.log("ris-launch-period-contract: all cases passed");
}

runFlagSemantics();
run();
