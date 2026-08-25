/* test-registration
{
  "name": "Front coverage denominator-floor DB repair prod-action (Task #2801)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2801: the denominator-floor DB REPAIR prod-action — the sibling of the #2795 read-time safety net above. It proves the stored rows get permanently fixed (floor + excess stamp + preservation + convergence). Runs entirely inside an isolated per-test schema (cloned front_analytics_monthly_coverage), so it is hermetic against the shared dev DB and live workers. Gate it so a regression in the repair path (e.g. blanking Front-side columns, or losing convergence) can't rot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2801 — `repair_front_coverage_denominator_floor` prod-action
 * permanently repairs stale message-grain coverage rows whose STORED
 * `front_total_messages` is below `applied_into_nobull` (the Task #2795
 * floor invariant), instead of relying forever on the read-time in-memory
 * safety net in `getFrontAnalyticsCoverageSummary`.
 *
 * Asserts:
 *  - Action is registered in PROD_ACTIONS and opts into self-heal.
 *  - status()/apply() are not-needed with no violating rows.
 *  - status() is pending with a violating row; apply() floors the STORED
 *    denominator (front_total_messages := applied_into_nobull), recomputes
 *    the derived gap/% fields (exactly 100%, gap 0 — never >100%), and
 *    stamps denominator_floor_excess.
 *  - Repair PRESERVES untouched columns (per-direction Front/local counts,
 *    finalized flag, denominator source) and leaves compliant rows alone.
 *  - A previously stored larger denominator_floor_excess is never shrunk.
 *  - Convergence/idempotency: after one apply the WHERE clause matches
 *    zero rows — status() and a re-apply are both not-needed.
 *
 * Runs inside `runInIsolatedSchema` cloning `front_analytics_monthly_coverage`
 * so seeded violations are invisible to live workers and the count starts
 * at zero (hermetic done-state), per the isolated-schema fallthrough rule.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2795 (denominator floor invariant + in-memory safety net), #2436 /
 *   #2483 (sibling one-off coverage prod-actions + test shape), #2281
 *   (prod-action one-apply convergence), #1969 (no re-press language).
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  countMessageGrainFloorViolations,
  repairMessageGrainFloorViolations,
} from "../server/services/frontAnalyticsCoverage";
import { runInIsolatedSchema } from "./db-sandbox";

const ACTOR = "test-front-coverage-floor-repair";

const VIOLATING_MONTH = "2997-01";
const COMPLIANT_MONTH = "2997-02";
const STICKY_EXCESS_MONTH = "2997-03";

async function main() {
  const action = PROD_ACTIONS.find(
    (a) => a.id === "repair_front_coverage_denominator_floor",
  );
  assert.ok(
    action,
    "repair_front_coverage_denominator_floor must be registered in PROD_ACTIONS",
  );
  assert.ok(
    action.selfHeal,
    "the floor-repair action opts into self-heal so a stale row surfacing later is repaired without a manual press",
  );

  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Empty table → both status() and apply() are not-needed. ──────
      assert.equal(
        await countMessageGrainFloorViolations(),
        0,
        "isolated clone starts with zero violations",
      );
      const status0 = await action.status();
      assert.equal(
        status0.state,
        "not-needed",
        `status should be not-needed with no violations: ${JSON.stringify(status0)}`,
      );
      const apply0 = await action.apply(ACTOR);
      assert.equal(
        apply0.state,
        "not-needed",
        `apply should be not-needed with no violations: ${JSON.stringify(apply0)}`,
      );

      // ── Seed: one violating row, one compliant row, one violating row
      //    that already carries a LARGER stored excess. ──────────────────
      await db.execute(sql`
        INSERT INTO front_analytics_monthly_coverage (
          month, month_start, month_end,
          front_total_messages, fetched_into_nobull, applied_into_nobull,
          ingest_gap, apply_gap, fetched_coverage_pct, applied_coverage_pct,
          is_finalized_month, unrecoverable, coverage_convergence_attempts,
          denominator_unit, numerator_unit, denominator_source,
          messages_inbound_front, messages_outbound_front,
          messages_inbound_local, messages_outbound_local,
          denominator_floor_excess
        ) VALUES
        (
          ${VIOLATING_MONTH}, '2997-01-01T00:00:00Z', '2997-02-01T00:00:00Z',
          206256, 207388, 207388,
          0, 0, 100.5, 100.5,
          true, false, 0,
          'messages_all', 'messages_all', 'analytics_reports',
          113000, 93256,
          120000, 87388,
          NULL
        ),
        (
          ${COMPLIANT_MONTH}, '2997-02-01T00:00:00Z', '2997-03-01T00:00:00Z',
          1000, 800, 800,
          200, 200, 80, 80,
          true, false, 0,
          'messages_all', 'messages_all', 'analytics_reports',
          600, 400,
          500, 300,
          NULL
        ),
        (
          ${STICKY_EXCESS_MONTH}, '2997-03-01T00:00:00Z', '2997-04-01T00:00:00Z',
          90, 100, 100,
          0, 0, 111.1, 111.1,
          true, false, 0,
          'messages_all', 'messages_all', 'analytics_reports',
          NULL, NULL, NULL, NULL,
          5000
        )
      `);

      assert.equal(
        await countMessageGrainFloorViolations(),
        2,
        "both violating rows counted; the compliant row is not",
      );
      const status1 = await action.status();
      assert.equal(status1.state, "pending", "status pending with violations");
      assert.ok(
        status1.detail?.includes("2"),
        `pending detail names the violation count: ${status1.detail}`,
      );

      // ── Apply: floors the stored denominator, recomputes derived fields.
      const apply1 = await action.apply(ACTOR);
      assert.equal(
        apply1.state,
        "applied",
        `apply should repair the rows: ${JSON.stringify(apply1)}`,
      );
      assert.equal(apply1.rowsAffected, 2, "exactly the two violating rows repaired");

      const repairedRes = await db.execute(sql`
        SELECT front_total_messages, fetched_into_nobull, applied_into_nobull,
               ingest_gap, apply_gap, fetched_coverage_pct, applied_coverage_pct,
               is_finalized_month, denominator_unit, numerator_unit,
               denominator_source, denominator_floor_excess,
               messages_inbound_front, messages_outbound_front,
               messages_inbound_local, messages_outbound_local
        FROM front_analytics_monthly_coverage
        WHERE month = ${VIOLATING_MONTH}
      `);
      const repaired = (repairedRes.rows as any[])[0];
      assert.ok(repaired, "violating month row still exists after repair");
      assert.equal(
        Number(repaired.front_total_messages),
        207388,
        "STORED front_total_messages floored up to applied_into_nobull",
      );
      assert.equal(Number(repaired.applied_into_nobull), 207388, "applied unchanged");
      assert.equal(Number(repaired.applied_coverage_pct), 100, "applied pct exactly 100 — never >100%");
      assert.equal(Number(repaired.apply_gap), 0, "apply gap recomputed to 0");
      assert.equal(Number(repaired.ingest_gap), 0, "ingest gap recomputed to 0");
      assert.equal(
        Number(repaired.denominator_floor_excess),
        207388 - 206256,
        "denominator_floor_excess stamped with the floor delta",
      );
      // Untouched columns preserved (repair must not blank Front-side data).
      assert.equal(repaired.is_finalized_month, true, "finalized flag preserved");
      assert.equal(repaired.denominator_unit, "messages_all", "grain preserved");
      assert.equal(repaired.denominator_source, "analytics_reports", "denominator source preserved");
      assert.equal(Number(repaired.messages_inbound_front), 113000, "per-direction Front inbound preserved");
      assert.equal(Number(repaired.messages_outbound_front), 93256, "per-direction Front outbound preserved");
      assert.equal(Number(repaired.messages_inbound_local), 120000, "per-direction local inbound preserved");
      assert.equal(Number(repaired.messages_outbound_local), 87388, "per-direction local outbound preserved");

      // Sticky excess: stored 5000 > this repair's delta (10) → kept at 5000.
      const stickyRes = await db.execute(sql`
        SELECT front_total_messages, denominator_floor_excess, applied_coverage_pct
        FROM front_analytics_monthly_coverage
        WHERE month = ${STICKY_EXCESS_MONTH}
      `);
      const sticky = (stickyRes.rows as any[])[0];
      assert.equal(Number(sticky.front_total_messages), 100, "sticky-excess row floored 90 → 100");
      assert.equal(
        Number(sticky.denominator_floor_excess),
        5000,
        "a previously stored larger denominator_floor_excess is never shrunk by a smaller repair delta",
      );
      assert.equal(Number(sticky.applied_coverage_pct), 100, "sticky-excess row pct exactly 100");

      // Compliant row untouched byte-for-byte on the fields that matter.
      const compliantRes = await db.execute(sql`
        SELECT front_total_messages, applied_into_nobull, applied_coverage_pct,
               ingest_gap, apply_gap, denominator_floor_excess
        FROM front_analytics_monthly_coverage
        WHERE month = ${COMPLIANT_MONTH}
      `);
      const compliant = (compliantRes.rows as any[])[0];
      assert.equal(Number(compliant.front_total_messages), 1000, "compliant denominator untouched");
      assert.equal(Number(compliant.applied_coverage_pct), 80, "compliant pct untouched");
      assert.equal(Number(compliant.ingest_gap), 200, "compliant ingest gap untouched");
      assert.equal(compliant.denominator_floor_excess, null, "compliant excess stays NULL");

      // ── Convergence / idempotency: one apply reaches done-state. ─────
      assert.equal(
        await countMessageGrainFloorViolations(),
        0,
        "zero violations remain after one apply (convergent done-state)",
      );
      const status2 = await action.status();
      assert.equal(status2.state, "not-needed", "status not-needed after repair");
      const apply2 = await action.apply(ACTOR);
      assert.equal(apply2.state, "not-needed", "re-apply is not-needed (nothing left to repair)");

      // Direct-helper second pass also scans nothing (repaired rows left the WHERE clause).
      const rerun = await repairMessageGrainFloorViolations();
      assert.equal(rerun.scanned, 0, "direct re-run scans zero rows");
      assert.equal(rerun.errors.length, 0, "no errors on the empty re-run");
    },
    { tables: ["front_analytics_monthly_coverage"] },
  );

  console.log("✓ All front-coverage-floor-repair (Task #2801) tests passed");
}

await main();
