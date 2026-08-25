/* test-registration
{
  "name": "Geocode failure classification (Task #2408)",
  "tier": "medium"
}
test-registration */
/**
 * Task #2408 — "Add to Command Panel" from a stale report row.
 *
 * The add path is gated by the Google Maps Geocoding API. When a geocode
 * fails we must tell the operator whether to FIX their address or whether
 * it's a SYSTEM fault (quota / denied key / provider error) that is not
 * their input. This classification drives the plain-English error the route
 * returns (400 "we couldn't find that address" vs 503 "temporarily
 * unavailable due to a system issue").
 *
 * Guards against: collapsing ZERO_RESULTS (operator-correctable) and
 * quota/key/provider faults back into one generic message, and against a
 * future status string accidentally being treated as operator-correctable.
 *
 * Status codes per developers.google.com/maps/documentation/geocoding
 * (reviewed June 2026).
 */

import { classifyGoogleGeocodeStatus } from "../server/mcu/geocoding";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    throw e;
  }
}

console.log("classifyGoogleGeocodeStatus");

run("ZERO_RESULTS is operator-correctable (not_found)", () => {
  assert(
    classifyGoogleGeocodeStatus("ZERO_RESULTS") === "not_found",
    "a syntactically valid but unfindable address must be not_found",
  );
});

run("quota / key / request faults are system faults", () => {
  for (const status of [
    "OVER_QUERY_LIMIT",
    "OVER_DAILY_LIMIT",
    "REQUEST_DENIED",
    "INVALID_REQUEST",
    "UNKNOWN_ERROR",
  ]) {
    assert(
      classifyGoogleGeocodeStatus(status) === "system",
      `${status} must classify as a system fault, not the operator's address`,
    );
  }
});

run("an unrecognized status is treated as a system fault (fail safe)", () => {
  assert(
    classifyGoogleGeocodeStatus("SOME_NEW_STATUS") === "system",
    "unknown statuses must not be reported to the operator as a bad address",
  );
});

console.log("\nAll geocode-failure-classification assertions passed.");
