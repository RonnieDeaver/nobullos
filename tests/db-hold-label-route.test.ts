/* test-registration
{
  "name": "DB hold label + route normalization (Task #836 P1)",
  "tier": "small"
}
test-registration */
import assert from "node:assert/strict";
import {
  withDbHoldLabel,
  withDbAttribution,
  setCurrentDbHoldLabel,
  getCurrentDbHoldLabel,
  getTopDbHoldLabels,
  getDbHoldLabelCounters,
  getDbAttributionQuality,
} from "../server/db";
import { normalizeApiPathForLabel } from "../server/apiLabel";

async function run() {
  // 1. normalizeApiPathForLabel collapses high-cardinality segments so
  //    label stats stay bounded.
  assert.equal(
    normalizeApiPathForLabel("/api/clients/123/keywords"),
    "/api/clients/:id/keywords",
  );
  assert.equal(
    normalizeApiPathForLabel(
      "/api/reports/550e8400-e29b-41d4-a716-446655440000",
    ),
    "/api/reports/:id",
  );
  assert.equal(
    normalizeApiPathForLabel(
      "/api/clients/abcd1234efef5678/notes?limit=10",
    ),
    "/api/clients/:id/notes",
  );
  assert.equal(normalizeApiPathForLabel("/api/health"), "/api/health");
  assert.equal(normalizeApiPathForLabel("/"), "/");
  assert.equal(normalizeApiPathForLabel("/api/clients/"), "/api/clients");

  // 2. withDbHoldLabel installs a ref; setCurrentDbHoldLabel refines it
  //    in-place so a release after route matching sees the new label.
  await withDbHoldLabel("api:GET /pre-route", async () => {
    assert.equal(getCurrentDbHoldLabel(), "api:GET /pre-route");
    setCurrentDbHoldLabel("api:GET /api/clients/:id");
    assert.equal(getCurrentDbHoldLabel(), "api:GET /api/clients/:id");
  });

  // 3. Outside any scope, the current label falls back to "unknown".
  assert.equal(getCurrentDbHoldLabel(), "unknown");

  // 4. Top-label getters return well-shaped values even before any
  //    pool checkout has been recorded (the dashboard depends on this).
  const apiTop = getTopDbHoldLabels("api", 5);
  assert.ok(Array.isArray(apiTop.byCount));
  assert.ok(Array.isArray(apiTop.byMaxMs));
  assert.ok(Array.isArray(apiTop.byTotalMs));
  assert.equal(typeof apiTop.unknownPct, "number");

  const counters = getDbHoldLabelCounters();
  assert.equal(typeof counters.api.unknown, "number");
  assert.equal(typeof counters.worker.unknown, "number");

  // 5. Task #913C: `withDbAttribution` is the canonical public alias for
  //    `withDbHoldLabel` and must install the same ALS-scoped label so
  //    pool checkouts inside it are attributed (not "unknown").
  await withDbAttribution("worker:test-attribution", async () => {
    assert.equal(getCurrentDbHoldLabel(), "worker:test-attribution");
  });
  assert.equal(getCurrentDbHoldLabel(), "unknown");

  // 6. Task #913C: `getDbAttributionQuality()` exposes per-pool
  //    {totalHolds, attributedHolds, unknownHolds, unknownPct,
  //    uniqueLabels} so the dashboard can drive the unknown share down
  //    over time. The shape must be stable even before any checkout.
  const quality = getDbAttributionQuality();
  for (const pool of ["api", "worker"] as const) {
    const q = quality[pool];
    assert.equal(typeof q.totalHolds, "number");
    assert.equal(typeof q.attributedHolds, "number");
    assert.equal(typeof q.unknownHolds, "number");
    assert.equal(typeof q.unknownPct, "number");
    assert.equal(typeof q.uniqueLabels, "number");
    assert.ok(q.unknownPct >= 0 && q.unknownPct <= 100);
    assert.equal(q.totalHolds, q.attributedHolds + q.unknownHolds);
  }

  // 7. Task #913C: the canonical contract uses
  //    `route:/worker:/scheduler:/startup:/middleware:/maintenance:`
  //    prefixes with `unknown` as the last-resort. Every label we ever
  //    set in this test follows that contract.
  for (const label of [
    "api:GET /pre-route",
    "api:GET /api/clients/:id",
    "worker:test-attribution",
  ]) {
    assert.match(
      label,
      /^(api|route|worker|scheduler|startup|middleware|maintenance):/,
      `label "${label}" must use a canonical contract prefix`,
    );
  }

  console.log("db-hold-label-route.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(() => {}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
