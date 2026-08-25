/* test-registration
{
  "name": "Front analytics coverage overflow fix (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * Task #2436 — Front Analytics "All-time coverage" overflow regression.
 *
 * The all-time card showed numerator > denominator (>100% coverage) for
 * two reasons, both fixed here:
 *
 *   1. Grain mismatch — every historical `front_analytics_monthly_coverage`
 *      row is labeled `conversations_all` but stores a message-count
 *      numerator. Summed against a conversation-count denominator the
 *      numerator could exceed it. The all-time accumulator in
 *      `getFrontAnalyticsCoverageSummary` now only counts a month when its
 *      denominator is genuinely message-grain (`messages_all`), so the
 *      numerator and denominator always share a grain.
 *
 *   2. No adoption-floor scope — pre-`front_adoption_date` historical-
 *      recovery months polluted the all-time totals. The accumulator now
 *      only counts months at or after the adoption floor.
 *
 * Part A (read-only, live DB): pins a far-future adoption floor so every
 * real row is out of scope, then proves a pre-floor row and an in-scope
 * conversation-grain row contribute ZERO to the all-time totals while an
 * in-scope message-grain row contributes fully — and the resulting
 * coverage pct never exceeds 100. `byMonth` still returns every row.
 *
 * Part B (isolated schema, safe DELETE): exercises the
 * `countPreFloorCoverageRows` / `deletePreFloorCoverageRows` helpers that
 * back the `purge_pre_floor_front_coverage_rows` CEO prod-action — no
 * adoption date → no-op; with a floor → deletes strictly pre-floor rows
 * and is idempotent on a second run. Runs against a cloned table so the
 * destructive DELETE can never touch real dev data.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { frontAnalyticsMonthlyCoverage } from "@shared/schema";
import {
  getFrontAnalyticsCoverageSummary,
  countPreFloorCoverageRows,
  deletePreFloorCoverageRows,
  getAdoptionFloorMonth,
  DENOMINATOR_UNIT_MESSAGES_ALL,
} from "../server/services/frontAnalyticsCoverage";
import { runInIsolatedSchema } from "./db-sandbox";

// Far-future year so our fixture rows never collide with real months or
// with the sibling Front-coverage suites (#1643 uses 2999, #1675 uses 2997).
const FUTURE_YEAR = 2996;

// The adoption floor is the hard-coded FRONT_ADOPTION_DATE (2025-07-01,
// Task #2481). A "pre-floor" fixture row must therefore live strictly
// before that month. 2024-03 predates all real coverage rows (coverage
// caching started after adoption), so it can't collide with live data.
const PRE_FLOOR_YEAR = 2024;
const PRE_FLOOR_MONTH = `${PRE_FLOOR_YEAR}-03`;

async function cleanupTestRows(): Promise<void> {
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage
    WHERE month LIKE ${`${FUTURE_YEAR}-%`} OR month = ${PRE_FLOOR_MONTH}
  `);
}

function monthBounds(year: number, mIdx: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, mIdx, 1)),
    end: new Date(Date.UTC(year, mIdx + 1, 1)),
  };
}

/** Insert one coverage fixture row directly (bypassing the Front pull). */
async function insertRow(opts: {
  month: string;
  mIdx: number;
  year?: number;
  denominatorUnit: string | null;
  front: number;
  fetched: number;
  applied: number;
}): Promise<void> {
  const { start, end } = monthBounds(opts.year ?? FUTURE_YEAR, opts.mIdx);
  await db.insert(frontAnalyticsMonthlyCoverage).values({
    month: opts.month,
    monthStart: start,
    monthEnd: end,
    frontTotalMessages: opts.front,
    fetchedIntoNobull: opts.fetched,
    appliedIntoNobull: opts.applied,
    denominatorUnit: opts.denominatorUnit ?? undefined,
    numeratorUnit: opts.denominatorUnit ?? undefined,
    isFinalizedMonth: true,
    pulledAt: new Date(),
  });
}

async function partA(): Promise<void> {
  {
    await cleanupTestRows();
    // Task #2481 hard-coded the adoption floor (`FRONT_ADOPTION_DATE`,
    // 2025-07-01) — the `front_adoption_date` setting is dead, so pinning
    // it no longer moves the floor. The pre-floor fixture row therefore
    // has to live in a month strictly BEFORE the hard-coded floor
    // (PRE_FLOOR_MONTH below); the in-scope rows stay in the far-future
    // year where they can't collide with real months.

    // Baseline BEFORE our rows. Other far-future message-grain rows left by
    // a concurrently-running sibling would appear in BOTH baseline and
    // after, so they cancel in the delta — making this robust to leftovers.
    const before = await getFrontAnalyticsCoverageSummary();

    try {
      // (a) PRE-FLOOR, message-grain — excluded purely by the floor.
      await insertRow({
        month: PRE_FLOOR_MONTH,
        mIdx: 2,
        year: PRE_FLOOR_YEAR,
        denominatorUnit: DENOMINATOR_UNIT_MESSAGES_ALL,
        front: 100,
        fetched: 80,
        applied: 70,
      });
      // (b) IN-SCOPE, conversation-grain — excluded by the grain gate. Note
      // fetched(300) > front(50): this is exactly the overflow shape the
      // bug summed into the all-time card. It must contribute ZERO.
      await insertRow({
        month: `${FUTURE_YEAR}-07`,
        mIdx: 6,
        denominatorUnit: "conversations_all",
        front: 50,
        fetched: 300,
        applied: 250,
      });
      // (c) IN-SCOPE, message-grain — the only row that should count.
      await insertRow({
        month: `${FUTURE_YEAR}-08`,
        mIdx: 7,
        denominatorUnit: DENOMINATOR_UNIT_MESSAGES_ALL,
        front: 1000,
        fetched: 900,
        applied: 850,
      });

      const after = await getFrontAnalyticsCoverageSummary();

      // Only the in-scope message-grain row (c) contributes to all-time.
      assert.equal(
        after.allTime.frontTotalMessages - before.allTime.frontTotalMessages,
        1000,
        "only the in-scope message-grain denominator is summed",
      );
      assert.equal(
        after.allTime.fetchedIntoNobull - before.allTime.fetchedIntoNobull,
        900,
        "pre-floor + conversation-grain fetched numerators are excluded",
      );
      assert.equal(
        after.allTime.appliedIntoNobull - before.allTime.appliedIntoNobull,
        850,
        "pre-floor + conversation-grain applied numerators are excluded",
      );

      // The whole point: numerator can never exceed denominator now.
      assert.ok(
        after.allTime.fetchedCoveragePct <= 100,
        `fetched coverage must not overflow (got ${after.allTime.fetchedCoveragePct})`,
      );
      assert.ok(
        after.allTime.appliedCoveragePct <= 100,
        `applied coverage must not overflow (got ${after.allTime.appliedCoveragePct})`,
      );

      // Task #2440 — the diagnostics counts must classify the three fixture
      // rows: (a) pre-floor, (b) in-scope wrong-grain, (c) in-scope included.
      assert.equal(
        after.allTime.totalMonths - before.allTime.totalMonths,
        3,
        "all three fixture rows counted in totalMonths",
      );
      assert.equal(
        after.allTime.inScopeMonths - before.allTime.inScopeMonths,
        2,
        "rows (b) and (c) are at/after the floor",
      );
      assert.equal(
        after.allTime.includedMonths - before.allTime.includedMonths,
        1,
        "only the in-scope message-grain row (c) is included",
      );
      assert.equal(
        after.allTime.excludedWrongGrainMonths -
          before.allTime.excludedWrongGrainMonths,
        1,
        "the in-scope conversation-grain row (b) is wrong-grain-excluded",
      );
      assert.equal(
        after.allTime.excludedPreFloorMonths -
          before.allTime.excludedPreFloorMonths,
        1,
        "the pre-floor row (a) is pre-floor-excluded",
      );

      // Contract preserved: byMonth still returns EVERY cached row, floor or
      // not (the adoption floor is consumer-side, not a row filter).
      const months = new Set(after.byMonth.map((m) => m.month));
      for (const m of [
        PRE_FLOOR_MONTH,
        `${FUTURE_YEAR}-07`,
        `${FUTURE_YEAR}-08`,
      ]) {
        assert.ok(months.has(m), `byMonth still includes ${m}`);
      }
      assert.equal(
        after.byMonth.length,
        after.months.length,
        "months is an alias of byMonth",
      );
    } finally {
      await cleanupTestRows();
    }
  }
}

async function partB(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: iso }) => {
      // Task #2481 — the floor is the hard-coded FRONT_ADOPTION_DATE
      // (2025-07-01); it never comes from system_settings and is never
      // null. Fixture months are chosen relative to that constant.
      const floorMonth = await getAdoptionFloorMonth();
      assert.equal(floorMonth, "2025-07", "floor is the hard-coded 2025-07");

      // Two pre-floor rows + two in-scope rows (relative to 2025-07).
      const rows = [
        { month: "2025-01", mIdx: 0 },
        { month: "2025-03", mIdx: 2 },
        { month: "2025-07", mIdx: 6 },
        { month: "2025-08", mIdx: 7 },
      ];
      for (const r of rows) {
        await iso.execute(sql`
          INSERT INTO front_analytics_monthly_coverage
            (month, month_start, month_end, denominator_unit)
          VALUES (
            ${r.month},
            ${new Date(Date.UTC(2025, r.mIdx, 1)).toISOString()},
            ${new Date(Date.UTC(2025, r.mIdx + 1, 1)).toISOString()},
            ${DENOMINATOR_UNIT_MESSAGES_ALL}
          )
        `);
      }

      // Count then delete the strictly-pre-floor rows.
      const c1 = await countPreFloorCoverageRows();
      assert.deepEqual(c1, { floorMonth: "2025-07", count: 2 });
      const d1 = await deletePreFloorCoverageRows();
      assert.deepEqual(d1, { floorMonth: "2025-07", deleted: 2 });

      // Idempotent: a second run finds nothing.
      const c2 = await countPreFloorCoverageRows();
      assert.deepEqual(c2, { floorMonth: "2025-07", count: 0 });
      const d2 = await deletePreFloorCoverageRows();
      assert.deepEqual(d2, { floorMonth: "2025-07", deleted: 0 });

      // The two in-scope rows survived.
      const remaining = await iso.execute(sql`
        SELECT month FROM front_analytics_monthly_coverage ORDER BY month
      `);
      const survived = (remaining.rows as any[]).map((r) => r.month);
      assert.deepEqual(survived, ["2025-07", "2025-08"]);
    },
    { tables: ["front_analytics_monthly_coverage", "system_settings"] },
  );
}

async function main(): Promise<void> {
  await partA();
  await partB();
  console.log("front-analytics-coverage-overflow-fix.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
await main();
