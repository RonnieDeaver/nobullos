/* test-registration
{
  "name": "Health dashboard pool-saturation isolation (Task #817)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.5s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #817 — Health dashboard separation regression test.
 *
 * Task #813 introduced a dedicated probe pool so that `dbRoundTripMs` (true
 * DB wire round-trip) and `apiPoolWaitMs` (time spent waiting for an API-pool
 * connection) are measured independently. The original verification was a
 * manual read of metrics on an idle system. This test deliberately saturates
 * the API pool and asserts that during the saturation window:
 *
 *   - `dbRoundTripMs` stays small (probe pool is independent).
 *   - `apiPoolWaitMs` reflects the actual pool wait.
 *
 * Without that separation, a saturated API pool would inflate the "DB
 * round-trip" metric and the dashboard would falsely blame the database.
 */
import assert from "node:assert";
import { apiPool } from "../server/db";
import { __test_collectSample } from "../server/services/healthMetrics";
import { PERF } from "../server/perfConfig";

const HOLD_BEFORE_RELEASE_MS = 1500;
const ROUND_TRIP_BOUND_MS = 750;
const POOL_WAIT_LOWER_BOUND_MS = 1000;

async function run() {
  const max = PERF.DB_API_POOL_MAX;
  assert.ok(max >= 2, `expected DB_API_POOL_MAX >= 2, got ${max}`);

  // Warm a baseline sample first — confirms the probe pool path works at all
  // and gives us an idle-state apiPoolWaitMs to compare against.
  const baseline = await __test_collectSample();
  assert.equal(baseline.dbConnected, true, "baseline probe must succeed");
  assert.notEqual(baseline.dbRoundTripMs, null, "baseline must report dbRoundTripMs");
  assert.notEqual(baseline.apiPoolWaitMs, null, "baseline must report apiPoolWaitMs");
  assert.ok(
    (baseline.apiPoolWaitMs ?? 0) < 500,
    `baseline (idle) apiPoolWaitMs should be small, got ${baseline.apiPoolWaitMs}`,
  );

  // Hold every API-pool connection so the next acquire on the API pool must
  // wait. Acquire serially to avoid hitting `connectionTimeoutMillis` if any
  // background warmup in this process is still in flight.
  const held: Array<Awaited<ReturnType<typeof apiPool.connect>>> = [];
  try {
    for (let i = 0; i < max; i++) {
      held.push(await apiPool.connect());
    }

    // Kick off a sample collection while the pool is fully saturated.
    const samplePromise = __test_collectSample();

    // Release one connection after a measurable delay so the sampler's
    // API-pool acquire returns instead of timing out (api pool's
    // connectionTimeoutMillis is 10s, so there is no risk of the test
    // unblocking too late).
    setTimeout(() => {
      const c = held.shift();
      if (c) c.release();
    }, HOLD_BEFORE_RELEASE_MS);

    const sample = await samplePromise;

    assert.equal(
      sample.dbConnected,
      true,
      "probe must still succeed under API-pool saturation",
    );

    // (1) dbRoundTripMs uses the dedicated probe pool — it must NOT be
    //     dragged up by API-pool contention.
    assert.notEqual(
      sample.dbRoundTripMs,
      null,
      "dbRoundTripMs must be captured under saturation",
    );
    assert.ok(
      (sample.dbRoundTripMs ?? Infinity) < ROUND_TRIP_BOUND_MS,
      `dbRoundTripMs must stay small under API saturation, got ${sample.dbRoundTripMs}ms ` +
        `(bound ${ROUND_TRIP_BOUND_MS}ms)`,
    );

    // (2) apiPoolWaitMs must reflect the saturation — it should be at least
    //     close to the time we forced the sampler to wait.
    assert.notEqual(
      sample.apiPoolWaitMs,
      null,
      "apiPoolWaitMs must be captured under saturation",
    );
    assert.ok(
      (sample.apiPoolWaitMs ?? 0) >= POOL_WAIT_LOWER_BOUND_MS,
      `apiPoolWaitMs must reflect API-pool saturation, got ${sample.apiPoolWaitMs}ms ` +
        `(lower bound ${POOL_WAIT_LOWER_BOUND_MS}ms)`,
    );

    // (3) Independence: pool wait must dwarf round-trip during saturation.
    //     This is the core invariant Task #813 introduced.
    assert.ok(
      (sample.apiPoolWaitMs ?? 0) > (sample.dbRoundTripMs ?? 0) * 2,
      `under saturation, apiPoolWaitMs (${sample.apiPoolWaitMs}ms) should ` +
        `dominate dbRoundTripMs (${sample.dbRoundTripMs}ms)`,
    );

    console.log(
      `[health-pool-saturation-isolation] baseline: rt=${baseline.dbRoundTripMs}ms ` +
        `wait=${baseline.apiPoolWaitMs}ms | saturated: rt=${sample.dbRoundTripMs}ms ` +
        `wait=${sample.apiPoolWaitMs}ms`,
    );
  } finally {
    while (held.length > 0) {
      const c = held.shift();
      try {
        c?.release();
      } catch {
        // ignore — already released by setTimeout above
      }
    }
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {
    console.log("PASS: Health dashboard separation under API-pool saturation");
  })
  .catch((err) => {
    console.error("FAIL:", err);
    process.exitCode = 1;
  });
