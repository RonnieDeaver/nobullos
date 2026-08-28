/* test-registration
{
  "name": "Health overview & SLO regression (Task #861)",
  "tier": "small"
}
test-registration */
/**
 * Task #861 Phase 6/7 — overview / SLO / regression detection (shape contract).
 *
 * The test runs `computeOverview()` against the live test DB and verifies the
 * response shape and invariants that the dashboard, Slack digest, and report
 * exporter all rely on. We deliberately do NOT seed isolated data: the
 * function intentionally aggregates from `health_samples` and there is no
 * tag column to scope inserts. Instead we pin the *contract*:
 *
 *   1. Top-level keys: generatedAt, currentStatus, windows, slo, latency,
 *      regression, incidents.
 *   2. Each window has sampleCount/okPct/degradedPct/errorPct.
 *      When sampleCount > 0 the three pcts sum to ~100.
 *   3. SLO target/used/remaining are coherent: used ∈ [0, 100],
 *      remaining = max(0, 100 - used), target ∈ (0, 100].
 *   4. Latency p95 ≤ p99 when both are present.
 *   5. Regression block, if present, has metric/currentP95/baselineP95/
 *      deltaPct/isRegression/summary.
 *   6. Incidents counts are non-negative integers.
 *   7. Custom monthlyTargetPct option flows through.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { computeOverview } from "../server/services/healthOverview";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function ensureSchema(): Promise<void> {
  await db.execute(sql`ALTER TABLE health_samples ADD COLUMN IF NOT EXISTS db_probe_connect_ms INTEGER`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS health_incidents (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      fingerprint VARCHAR(256) NOT NULL,
      metric VARCHAR(128) NOT NULL,
      severity VARCHAR(16) NOT NULL,
      title TEXT NOT NULL,
      first_seen_at BIGINT NOT NULL,
      last_seen_at BIGINT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      peak_value INTEGER NOT NULL DEFAULT 0,
      latest_value INTEGER NOT NULL DEFAULT 0,
      threshold INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'firing',
      acknowledged_by VARCHAR(128),
      acknowledged_at BIGINT,
      snoozed_until BIGINT,
      resolved_at BIGINT,
      sample_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

async function run(): Promise<void> {
  await ensureSchema();

  const result = await computeOverview();

  // 1. Top-level keys
  assert(typeof result.generatedAt === "number", "generatedAt missing");
  // Task #992: `unknown` is a legal currentStatus when no recent sample.
  assert(
    ["ok", "degraded", "error", "unknown"].includes(result.currentStatus),
    "currentStatus invalid",
  );
  assert(
    result.latestSampleAt === null || typeof result.latestSampleAt === "number",
    "latestSampleAt missing from contract",
  );
  assert(result.windows && result.slo && result.latency && result.incidents, "missing top-level keys");

  // 2. Window invariants
  for (const k of ["h24", "d7", "d30"] as const) {
    const w = result.windows[k];
    assert(typeof w.sampleCount === "number" && w.sampleCount >= 0, `${k} sampleCount invalid`);
    assert(typeof w.okPct === "number", `${k} okPct missing`);
    assert(typeof w.degradedPct === "number", `${k} degradedPct missing`);
    assert(typeof w.errorPct === "number", `${k} errorPct missing`);
    if (w.sampleCount > 0) {
      const sum = w.okPct + w.degradedPct + w.errorPct;
      assert(Math.abs(sum - 100) < 1.5, `${k} pcts should sum to ~100, got ${sum}`);
    }
  }

  // 3. SLO coherence
  assert(result.slo.errorBudgetTargetPct > 0 && result.slo.errorBudgetTargetPct <= 100, "target out of range");
  assert(
    result.slo.errorBudgetUsedPct >= 0 && result.slo.errorBudgetUsedPct <= 100 + 0.01,
    `used out of range: ${result.slo.errorBudgetUsedPct}`,
  );
  assert(
    Math.abs(result.slo.errorBudgetRemainingPct - Math.max(0, 100 - result.slo.errorBudgetUsedPct)) < 0.01,
    `remaining inconsistent: ${JSON.stringify(result.slo)}`,
  );

  // Task #992 — per-window sampler-stale separation in SLO block.
  for (const k of [
    "samplerStaleSecondsLast24h",
    "samplerStaleSecondsLast7d",
    "samplerStaleSecondsLast30d",
  ] as const) {
    const v = (result.slo as any)[k];
    assert(typeof v === "number" && v >= 0, `${k} missing or invalid`);
  }
  // Per-window monotonicity: 24h ⊆ 7d ⊆ 30d.
  assert(
    result.slo.samplerStaleSecondsLast24h <= result.slo.samplerStaleSecondsLast7d + 1,
    "samplerStaleSecondsLast24h must be ≤ Last7d",
  );
  assert(
    result.slo.samplerStaleSecondsLast7d <= result.slo.samplerStaleSecondsLast30d + 1,
    "samplerStaleSecondsLast7d must be ≤ Last30d",
  );
  assert(
    typeof result.slo.confirmedErrorPct30d === "number" &&
      result.slo.confirmedErrorPct30d >= 0,
    "confirmedErrorPct30d missing or invalid",
  );
  assert(
    typeof result.slo.rawErrorPct30d === "number" && result.slo.rawErrorPct30d >= 0,
    "rawErrorPct30d missing or invalid",
  );
  // Canonical ≤ raw (writer-stale was subtracted from raw, never added).
  assert(
    result.slo.confirmedErrorPct30d <= result.slo.rawErrorPct30d + 0.01,
    `confirmedErrorPct30d (${result.slo.confirmedErrorPct30d}) must be ≤ rawErrorPct30d (${result.slo.rawErrorPct30d})`,
  );
  assert(
    typeof result.slo.errorBudgetUsedPctRaw === "number" &&
      result.slo.errorBudgetUsedPctRaw >= 0 &&
      result.slo.errorBudgetUsedPctRaw + 0.01 >= result.slo.errorBudgetUsedPct,
    "errorBudgetUsedPctRaw must be ≥ errorBudgetUsedPct (canonical excludes writer stall)",
  );

  // Task #992 — sampler runtime block (may be null when watchdog hasn't
  // registered the writer yet, e.g. in pure unit-test contexts).
  assert("sampler" in result, "sampler key missing");
  if (result.sampler !== null) {
    assert(typeof result.sampler.name === "string", "sampler.name missing");
    assert(typeof result.sampler.healthy === "boolean", "sampler.healthy missing");
    assert(typeof result.sampler.consecutiveMisses === "number", "consecutiveMisses missing");
    assert(typeof result.sampler.hasOpenStallIncident === "boolean", "hasOpenStallIncident missing");
  }

  // 4. Latency p95 ≤ p99 when both present (round-trip + probe-connect)
  if (result.latency.roundTripP95Ms !== null && result.latency.roundTripP99Ms !== null) {
    assert(
      result.latency.roundTripP95Ms <= result.latency.roundTripP99Ms,
      `rt p95 (${result.latency.roundTripP95Ms}) > p99 (${result.latency.roundTripP99Ms})`,
    );
  }
  if (result.latency.dbProbeP95Ms !== null && result.latency.dbProbeP99Ms !== null) {
    assert(
      result.latency.dbProbeP95Ms <= result.latency.dbProbeP99Ms,
      `probe p95 (${result.latency.dbProbeP95Ms}) > p99 (${result.latency.dbProbeP99Ms})`,
    );
  }
  // dbProbeP99Ms is part of the overview contract (operator headline + report)
  assert("dbProbeP99Ms" in result.latency, "dbProbeP99Ms missing from latency block");

  // 5. Regression block contract
  if (result.regression) {
    assert(typeof result.regression.metric === "string", "regression.metric missing");
    assert(typeof result.regression.currentP95 === "number", "currentP95 missing");
    assert(typeof result.regression.baselineP95 === "number", "baselineP95 missing");
    assert(typeof result.regression.deltaPct === "number", "deltaPct missing");
    assert(typeof result.regression.isRegression === "boolean", "isRegression missing");
    assert(typeof result.regression.summary === "string" && result.regression.summary.length > 0, "summary missing");
  }

  // 6. Incidents
  assert(
    typeof result.incidents.openCount === "number" &&
      result.incidents.openCount >= 0 &&
      Number.isInteger(result.incidents.openCount),
    "openCount invalid",
  );
  assert(
    typeof result.incidents.last24hCount === "number" &&
      result.incidents.last24hCount >= 0 &&
      Number.isInteger(result.incidents.last24hCount),
    "last24hCount invalid",
  );

  // 7. Custom target flows through
  const custom = await computeOverview({ monthlyTargetPct: 99.0 });
  assert(custom.slo.errorBudgetTargetPct === 99.0, `custom target not applied: ${custom.slo.errorBudgetTargetPct}`);

  console.log("✓ Health overview & SLO contract");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
