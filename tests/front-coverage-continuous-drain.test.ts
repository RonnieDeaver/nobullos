/* test-registration
{
  "name": "Reach-coverage continuous-round drain — multi-round, breaker/switch halt, convergence (Task #2761)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy: isolated-schema clones + background drains; flakes under dev-server contention",
  "tier": "small"
}
test-registration */
/**
 * Task #2761 — continuous-round drain for reach_front_coverage_full_message_grain.
 *
 * Before this task the reach action's background drain processed each
 * candidate month at most once per run and then waited for the 60-minute
 * self-heal cadence before the next bite.  Task #2761 converts it to a
 * continuous round-based loop governed by Front's x-ratelimit-* headers.
 *
 * Tests (each in an isolated schema so the live workers can't interfere):
 *
 *   1. MULTI-ROUND — with a single sub-floor month and a driver that makes
 *      no progress, the drain processes the month in two consecutive rounds
 *      (not one) before the zero-progress convergence check stops it.  This
 *      proves the loop does not wait for a scheduler tick between rounds.
 *
 *   2. BREAKER TRIP — the driver trips the Front auth breaker on its first
 *      call; the pre-chunk breaker re-check stops the drain after that single
 *      invocation (no round 2 starts).
 *
 *   3. KILL SWITCH — the driver turns off the search-strategy switch on its
 *      first call; the pre-chunk switch re-check stops the drain after one
 *      invocation.
 *
 *   4. PROGRESS RESETS ZERO STREAK — a driver that makes progress in round 1
 *      but not in rounds 2 and 3 triggers convergence only after two
 *      consecutive zero-progress rounds (not after the first), proving the
 *      counter is reset correctly on a progress round.
 *
 * Isolation (Task #1929 pattern): every test runs inside `runInIsolatedSchema`
 * so the live Start-application workers cannot see or race-write the seeded
 * coverage rows, and `listFrontCoverageSubFloorMonths` (which reads via
 * `getDb()`) returns only the test's own data.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import {
  applyReachFrontCoverageFull,
  __setReachFrontCoverageFullForMonthOverrideForTest,
} from "../server/services/prodActionsRegistry";
import {
  getDrainState,
  __resetDrainsForTest,
  type DrainState,
} from "../server/services/prodActionBackgroundDrain";
import {
  setPoolEpicSwitch,
  __resetPoolEpicSwitchesForTest,
} from "../server/services/poolEpicKillSwitches";
import {
  tripFrontAuthBreaker,
  __resetFrontAuthBreakerForTest,
} from "../server/services/frontAuthBreaker";
import { runInIsolatedSchema } from "./db-sandbox";

const ACTION_ID = "reach_front_coverage_full_message_grain";
const SEARCH_SWITCH = "front_recovery_sparse_month_search_strategy_enabled";
const MSG_ALL = "messages_all";
const TABLES = [
  "front_analytics_monthly_coverage",
  "system_settings",
  "prod_action_runs",
] as const;

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

function monthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1)),
    end: new Date(Date.UTC(y, m, 1)),
  };
}

async function seedMonth(isoDb: IsoDb, month: string, ingestGap = 500): Promise<void> {
  const { start, end } = monthBounds(month);
  await isoDb.execute(sql`
    INSERT INTO front_analytics_monthly_coverage
      (month, month_start, month_end,
       front_total_messages, fetched_into_nobull, applied_into_nobull,
       ingest_gap, applied_coverage_pct,
       denominator_unit, numerator_unit,
       analytics_plan_limited_at,
       front_analytics_status, front_analytics_error,
       coverage_convergence_attempts, is_finalized_month, pulled_at)
    VALUES (
      ${month}, ${start.toISOString()}, ${end.toISOString()},
      ${ingestGap + 1000}, 1000, 1000,
      ${ingestGap}, 50,
      ${MSG_ALL}, ${MSG_ALL},
      NULL,
      NULL, NULL,
      0, true, NOW()
    )
  `);
}

async function awaitDrain(timeoutMs = 20_000): Promise<DrainState> {
  const start = Date.now();
  for (;;) {
    const st = getDrainState(ACTION_ID);
    if (st && st.finishedAt !== null) return st;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `drain ${ACTION_ID} did not finish within ${timeoutMs}ms (state=${JSON.stringify(st)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ── 1. MULTI-ROUND ──────────────────────────────────────────────────────────
//
// One month, driver always returns no-progress.
// Expected: month is processed TWICE (two zero-progress rounds) then convergence
// stops the drain — no scheduler tick needed between rounds.
async function testMultiRound(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      __resetDrainsForTest();
      __resetPoolEpicSwitchesForTest();
      __resetFrontAuthBreakerForTest();
      await setPoolEpicSwitch(SEARCH_SWITCH, true);

      await seedMonth(isoDb, "3001-01");

      const calls: string[] = [];
      __setReachFrontCoverageFullForMonthOverrideForTest(async (m) => {
        calls.push(m.month);
        return { before: 50, after: 50, ingested: 0, status: "no_progress" };
      });

      try {
        const out = await applyReachFrontCoverageFull(null);
        assert.equal(out.state, "applied", `expected applied, got ${JSON.stringify(out)}`);

        const state = await awaitDrain();
        assert.equal(state.error, null, `drain must not error — ${state.error}`);

        assert.equal(
          calls.length,
          2,
          `month must be driven in TWO rounds before convergence, got ${calls.length} call(s)`,
        );
        assert.ok(
          calls.every((c) => c === "3001-01"),
          `all calls must be for the same month (got ${JSON.stringify(calls)})`,
        );
        ok(
          "drain processes the same month in two rounds before zero-progress convergence stops it",
        );
      } finally {
        __setReachFrontCoverageFullForMonthOverrideForTest(null);
        __resetPoolEpicSwitchesForTest();
        __resetDrainsForTest();
      }
    },
    { tables: TABLES },
  );
}

// ── 2. BREAKER TRIP ─────────────────────────────────────────────────────────
//
// Driver trips the Front auth breaker on its first call.
// Expected: drain stops after that single invocation (pre-chunk breaker check
// fires on the next chunk, before round 2 begins).
async function testBreakerTripStopsDrain(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      __resetDrainsForTest();
      __resetPoolEpicSwitchesForTest();
      __resetFrontAuthBreakerForTest();
      await setPoolEpicSwitch(SEARCH_SWITCH, true);

      await seedMonth(isoDb, "3001-02");

      let callCount = 0;
      __setReachFrontCoverageFullForMonthOverrideForTest(async () => {
        callCount++;
        tripFrontAuthBreaker("front_not_connected");
        return { before: 50, after: 50, ingested: 0, status: "no_progress" };
      });

      try {
        const out = await applyReachFrontCoverageFull(null);
        assert.equal(out.state, "applied", `expected applied, got ${JSON.stringify(out)}`);

        const state = await awaitDrain();
        assert.equal(state.error, null, `drain must not error — ${state.error}`);

        assert.equal(
          callCount,
          1,
          `breaker trip must stop the drain after 1 call — got ${callCount}`,
        );
        ok("breaker trip during drain stops the loop before round 2 begins");
      } finally {
        __setReachFrontCoverageFullForMonthOverrideForTest(null);
        __resetFrontAuthBreakerForTest();
        __resetPoolEpicSwitchesForTest();
        __resetDrainsForTest();
      }
    },
    { tables: TABLES },
  );
}

// ── 3. KILL SWITCH ──────────────────────────────────────────────────────────
//
// Driver turns off the search-strategy switch on its first call.
// Expected: drain stops after that single invocation (pre-chunk switch check
// fires on the next chunk).
async function testKillSwitchStopsDrain(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      __resetDrainsForTest();
      __resetPoolEpicSwitchesForTest();
      __resetFrontAuthBreakerForTest();
      await setPoolEpicSwitch(SEARCH_SWITCH, true);

      await seedMonth(isoDb, "3001-03");

      let callCount = 0;
      __setReachFrontCoverageFullForMonthOverrideForTest(async () => {
        callCount++;
        await setPoolEpicSwitch(SEARCH_SWITCH, false);
        return { before: 50, after: 50, ingested: 0, status: "no_progress" };
      });

      try {
        const out = await applyReachFrontCoverageFull(null);
        assert.equal(out.state, "applied", `expected applied, got ${JSON.stringify(out)}`);

        const state = await awaitDrain();
        assert.equal(state.error, null, `drain must not error — ${state.error}`);

        assert.equal(
          callCount,
          1,
          `switch-off must stop the drain after 1 call — got ${callCount}`,
        );
        ok("search-strategy switch turned off mid-drain stops the loop before round 2");
      } finally {
        __setReachFrontCoverageFullForMonthOverrideForTest(null);
        __resetPoolEpicSwitchesForTest();
        __resetDrainsForTest();
      }
    },
    { tables: TABLES },
  );
}

// ── 4. PROGRESS RESETS ZERO STREAK ─────────────────────────────────────────
//
// Driver makes progress (ingested=5) on call 1 (round 1), then no-progress on
// calls 2 and 3 (rounds 2 and 3).
// Expected: convergence fires only after TWO consecutive zero-progress rounds
// (rounds 2 + 3), so the driver is called 3 times total — not 2.
// This verifies the zero-streak counter resets correctly on a progress round.
async function testProgressResetsZeroStreak(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      __resetDrainsForTest();
      __resetPoolEpicSwitchesForTest();
      __resetFrontAuthBreakerForTest();
      await setPoolEpicSwitch(SEARCH_SWITCH, true);

      await seedMonth(isoDb, "3001-04");

      let callCount = 0;
      __setReachFrontCoverageFullForMonthOverrideForTest(async () => {
        callCount++;
        if (callCount === 1) {
          return { before: 50, after: 55, ingested: 5, status: "ok" };
        }
        return { before: 55, after: 55, ingested: 0, status: "no_progress" };
      });

      try {
        const out = await applyReachFrontCoverageFull(null);
        assert.equal(out.state, "applied", `expected applied, got ${JSON.stringify(out)}`);

        const state = await awaitDrain();
        assert.equal(state.error, null, `drain must not error — ${state.error}`);

        assert.equal(
          callCount,
          3,
          `progress in round 1 resets the zero-streak: convergence fires after rounds 2+3 → 3 total calls (got ${callCount})`,
        );
        ok(
          "progress in round 1 resets zero-streak: convergence only fires after 2 consecutive zero-progress rounds",
        );
      } finally {
        __setReachFrontCoverageFullForMonthOverrideForTest(null);
        __resetPoolEpicSwitchesForTest();
        __resetDrainsForTest();
      }
    },
    { tables: TABLES },
  );
}

async function main(): Promise<void> {
  await testMultiRound();
  await testBreakerTripStopsDrain();
  await testKillSwitchStopsDrain();
  await testProgressResetsZeroStreak();
  console.log(`\n${passed} assertion group(s) passed`);
  console.log("front-coverage-continuous-drain.test.ts: OK");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
