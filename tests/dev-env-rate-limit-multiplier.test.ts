/* test-registration
{
  "name": "Dev-environment rate-limit headroom multiplier (Task #4683)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4683: pins the NODE_ENV gating of the dev-only rate-limit headroom multiplier — if the development gate ever loosened, production abuse limits would silently 10x. Pure-function test, DB-free, deterministic, sub-second.",
  "tier": "small"
}
test-registration */
/**
 * Task #4683 — fast navigation / QA sweeps in development tripped the
 * production-sized rate-limit budgets into 429 toast storms. Development gets
 * a headroom multiplier applied at the roleAwareMax seam; this test pins the
 * environment gating so it can never leak into production or test runs:
 *
 *   - NODE_ENV=production / test / unset  → multiplier is exactly 1
 *   - NODE_ENV=development                → default 10
 *   - DEV_RATE_LIMIT_MULTIPLIER override honored in development only,
 *     clamped to 1..1000 (invalid values fall back to the default 10)
 *
 * Pure function test — no DB, no express, no env mutation (the computation
 * takes the env as an argument).
 */
import "./helpers/forceTestEnv";
import assert from "node:assert/strict";
import { computeDevEnvRateLimitMultiplier } from "../server/routes/middleware";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check("production env gets no headroom", () => {
  assert.equal(computeDevEnvRateLimitMultiplier({ NODE_ENV: "production" }), 1);
});

check("test env gets no headroom", () => {
  assert.equal(computeDevEnvRateLimitMultiplier({ NODE_ENV: "test" }), 1);
});

check("unset NODE_ENV gets no headroom", () => {
  assert.equal(computeDevEnvRateLimitMultiplier({}), 1);
});

check("production ignores DEV_RATE_LIMIT_MULTIPLIER override", () => {
  assert.equal(
    computeDevEnvRateLimitMultiplier({
      NODE_ENV: "production",
      DEV_RATE_LIMIT_MULTIPLIER: "50",
    }),
    1,
  );
});

check("development defaults to 10x", () => {
  assert.equal(computeDevEnvRateLimitMultiplier({ NODE_ENV: "development" }), 10);
});

check("development honors a valid override", () => {
  assert.equal(
    computeDevEnvRateLimitMultiplier({
      NODE_ENV: "development",
      DEV_RATE_LIMIT_MULTIPLIER: "25",
    }),
    25,
  );
});

check("development clamps invalid overrides back to the default", () => {
  for (const bad of ["0", "-3", "1001", "abc", ""]) {
    assert.equal(
      computeDevEnvRateLimitMultiplier({
        NODE_ENV: "development",
        DEV_RATE_LIMIT_MULTIPLIER: bad,
      }),
      10,
      `override ${JSON.stringify(bad)} should fall back to 10`,
    );
  }
});

console.log(`\n${passed} checks passed`);
