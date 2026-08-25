/* test-registration
{
  "name": "Prod-actions recover plan-limited Front months via search — selector + drain + guards (Task #2706)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy: isolated-schema clones + background drains; flakes under dev-server contention",
  "tier": "small"
}
test-registration */
/**
 * Task #2706 — end-to-end verification for the
 * `recover_front_plan_limited_messages` prod-action (added in Task #2705).
 *
 * The pure target math is covered by `tests/front-console-metrics.test.ts`
 * (`isFrontMonthSearchRecoverable`). This suite covers the SERVER-SIDE drive
 * that math feeds, which previously had no integration test:
 *
 *   1. SELECTOR — `listFrontPlanLimitedSearchRecoverableMonths()` returns a
 *      plan-limited, message-grain month with an ingest gap whose convergence
 *      budget is spent, and EXCLUDES months that are search-failed,
 *      auth_blocked, not-yet-message-grain, gap-free, or still inside the
 *      convergence budget.
 *
 *   2. DRAIN — `applyRecoverFrontPlanLimitedMessages` drives a background drain
 *      that processes each candidate month AT MOST ONCE (so it always
 *      terminates), records the before→after delta per month in `perKey`, and
 *      finishes. The per-month search-recovery driver is stubbed via a
 *      test-only seam so no real Front I/O happens.
 *
 *   3. GUARDS — the action returns `blocked` (NOT `error`) while the Front auth
 *      breaker is active, and `not-needed` when the search-strategy switch is
 *      OFF.
 *
 * Isolation (Task #1929 pattern): everything runs inside `runInIsolatedSchema`
 * so the live `Start application` workers (default search_path = public) can
 * neither see nor race-write the seeded coverage rows, and the global
 * `listFrontPlanLimitedSearchRecoverableMonths()` assertion is exact (the
 * cloned table holds only our rows).
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import {
  applyRecoverFrontPlanLimitedMessages,
  getRecoverFrontPlanLimitedMessagesStatus,
  listFrontPlanLimitedSearchRecoverableMonths,
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

const ACTION_ID = "recover_front_plan_limited_messages";
const SEARCH_SWITCH = "front_recovery_sparse_month_search_strategy_enabled";
const MSG_ALL = "messages_all";
const CONVERGENCE_CAP = 3;

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

interface SeedOpts {
  month: string;
  /** message grain unless overridden */
  denominatorUnit?: string;
  ingestGap?: number;
  convergenceAttempts?: number;
  /** plan-limited by default — the action targets ONLY plan-limited months */
  planLimited?: boolean;
  frontAnalyticsStatus?: string | null;
  frontAnalyticsError?: string | null;
}

async function seedMonth(isoDb: IsoDb, opts: SeedOpts): Promise<void> {
  const { start, end } = monthBounds(opts.month);
  const unit = opts.denominatorUnit ?? MSG_ALL;
  const ingestGap = opts.ingestGap ?? 1000;
  const attempts = opts.convergenceAttempts ?? CONVERGENCE_CAP;
  const planLimited = opts.planLimited ?? true;
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
      ${opts.month}, ${start.toISOString()}, ${end.toISOString()},
      ${ingestGap + 1000}, 1000, 1000,
      ${ingestGap}, 40,
      ${unit}, ${unit},
      ${planLimited ? sql`NOW()` : sql`NULL`},
      ${opts.frontAnalyticsStatus ?? null}, ${opts.frontAnalyticsError ?? null},
      ${attempts}, true, NOW()
    )
  `);
}

// ── 1. SELECTOR — qualifying month returned; every disqualifier excluded ──
async function testSelectorScoping(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      __resetFrontAuthBreakerForTest();

      // The one genuinely recoverable month.
      await seedMonth(isoDb, { month: "3002-07" });

      // Disqualifiers — each must be excluded.
      await seedMonth(isoDb, {
        month: "3002-08",
        frontAnalyticsError: "front_analytics_search_failed: 403 plan limit",
      }); // search itself hard-failed
      await seedMonth(isoDb, {
        month: "3002-09",
        frontAnalyticsStatus: "auth_blocked",
      }); // auth-blocked → not search-recoverable
      await seedMonth(isoDb, {
        month: "3002-10",
        denominatorUnit: "conversations_all",
      }); // not yet message grain
      await seedMonth(isoDb, { month: "3002-11", ingestGap: 0 }); // nothing to ingest
      await seedMonth(isoDb, {
        month: "3002-12",
        convergenceAttempts: CONVERGENCE_CAP - 1,
      }); // budget not yet spent (reach still owns it)
      await seedMonth(isoDb, { month: "3001-06", planLimited: false }); // not plan-limited

      const months = await listFrontPlanLimitedSearchRecoverableMonths();
      const labels = months.map((m) => m.month);
      assert.deepEqual(
        labels,
        ["3002-07"],
        `selector must return ONLY the recoverable month (got ${JSON.stringify(labels)})`,
      );
      ok("selector returns the recoverable month and excludes every disqualifier");
    },
    { tables: TABLES },
  );
}

// ── 2. DRAIN — processes each month once, records delta, terminates ──
async function testDrainProcessesEachMonthOnce(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      __resetDrainsForTest();
      __resetPoolEpicSwitchesForTest();
      __resetFrontAuthBreakerForTest();
      await setPoolEpicSwitch(SEARCH_SWITCH, true);

      await seedMonth(isoDb, { month: "3002-01" });
      await seedMonth(isoDb, { month: "3002-02" });
      await seedMonth(isoDb, { month: "3002-03" });

      // Stub the per-month search-recovery driver so no real Front I/O runs.
      // Each call reports a positive before→after delta and records the month
      // so we can prove every month is driven at most once.
      const calls: string[] = [];
      __setReachFrontCoverageFullForMonthOverrideForTest(async (m) => {
        calls.push(m.month);
        return { before: 10, after: 20, ingested: 5, status: "ok" };
      });

      try {
        const out = await applyRecoverFrontPlanLimitedMessages(null);
        assert.equal(
          out.state,
          "applied",
          `apply should start the drain (got ${JSON.stringify(out)})`,
        );

        const state = await awaitDrain();
        assert.equal(state.error, null, `drain must not error — ${state.error}`);

        // Each of the 3 months driven exactly once → terminates.
        assert.equal(state.processed, 3, `expected 3 processed, got ${state.processed}`);
        assert.deepEqual(
          [...calls].sort(),
          ["3002-01", "3002-02", "3002-03"],
          `every month driven exactly once (got ${JSON.stringify(calls)})`,
        );
        assert.equal(
          new Set(calls).size,
          calls.length,
          "no month is driven more than once",
        );

        // perKey records the before→after delta: 3 processed, 3 advanced
        // (after>before each), 15 messages ingested (5 × 3).
        assert.deepEqual(
          state.perKey,
          { months_processed: 3, months_advanced: 3, messages_ingested: 15 },
          `unexpected perKey ${JSON.stringify(state.perKey)}`,
        );
        ok("drain processes each month once, records before→after delta, terminates");
      } finally {
        __setReachFrontCoverageFullForMonthOverrideForTest(null);
        __resetPoolEpicSwitchesForTest();
        __resetDrainsForTest();
      }
    },
    { tables: TABLES },
  );
}

// A month that makes NO progress (after === before) is counted processed but
// not advanced — the perKey delta is honest, not inflated.
async function testDrainRecordsNoProgressHonestly(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      __resetDrainsForTest();
      __resetPoolEpicSwitchesForTest();
      __resetFrontAuthBreakerForTest();
      await setPoolEpicSwitch(SEARCH_SWITCH, true);

      await seedMonth(isoDb, { month: "3002-04" });

      __setReachFrontCoverageFullForMonthOverrideForTest(async () => ({
        before: 30,
        after: 30,
        ingested: 0,
        status: "no_progress",
      }));

      try {
        const out = await applyRecoverFrontPlanLimitedMessages(null);
        assert.equal(out.state, "applied", `expected applied, got ${JSON.stringify(out)}`);
        const state = await awaitDrain();
        assert.equal(state.error, null, `drain must not error — ${state.error}`);
        assert.deepEqual(
          state.perKey,
          { months_processed: 1, months_advanced: 0, messages_ingested: 0 },
          `no-progress month must not inflate the advanced/ingested delta (got ${JSON.stringify(state.perKey)})`,
        );
        ok("drain records a no-progress month honestly (advanced=0)");
      } finally {
        __setReachFrontCoverageFullForMonthOverrideForTest(null);
        __resetPoolEpicSwitchesForTest();
        __resetDrainsForTest();
      }
    },
    { tables: TABLES },
  );
}

// ── 3a. GUARD — Front auth breaker active → blocked (NOT error) ──
async function testBlockedWhenAuthBreakerActive(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      __resetDrainsForTest();
      __resetPoolEpicSwitchesForTest();
      __resetFrontAuthBreakerForTest();
      await setPoolEpicSwitch(SEARCH_SWITCH, true);

      await seedMonth(isoDb, { month: "3002-05" });

      // The driver must NEVER run while the breaker is open.
      let driverRan = false;
      __setReachFrontCoverageFullForMonthOverrideForTest(async () => {
        driverRan = true;
        return { before: 0, after: 0, ingested: 0, status: "ok" };
      });
      tripFrontAuthBreaker("front_not_connected");

      try {
        const status = await getRecoverFrontPlanLimitedMessagesStatus();
        assert.equal(status.state, "blocked", `status must be blocked, got ${status.state}`);
        assert.notEqual(status.state, "error", "blocked must never surface as error");
        assert.equal(
          (status as { integration?: string }).integration,
          "Front",
          "blocked status names Front",
        );

        const out = await applyRecoverFrontPlanLimitedMessages(null);
        assert.equal(out.state, "blocked", `apply must be blocked, got ${out.state}`);
        assert.notEqual(out.state, "error", "blocked apply must never surface as error");
        assert.equal(
          (out as { integration?: string }).integration,
          "Front",
          "blocked outcome names Front",
        );
        assert.equal(driverRan, false, "no Front drive starts while auth is dead");
        assert.equal(getDrainState(ACTION_ID), undefined, "no drain started while blocked");
        ok("breaker active → blocked (not error), no drain, no Front drive");
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

// ── 3b. GUARD — search-strategy switch OFF → not-needed ──
async function testNotNeededWhenSwitchOff(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      __resetDrainsForTest();
      __resetPoolEpicSwitchesForTest();
      __resetFrontAuthBreakerForTest();
      await setPoolEpicSwitch(SEARCH_SWITCH, false);

      // A would-be-recoverable month exists, but the switch is OFF.
      await seedMonth(isoDb, { month: "3002-06" });

      let driverRan = false;
      __setReachFrontCoverageFullForMonthOverrideForTest(async () => {
        driverRan = true;
        return { before: 0, after: 0, ingested: 0, status: "ok" };
      });

      try {
        const status = await getRecoverFrontPlanLimitedMessagesStatus();
        assert.equal(status.state, "not-needed", `status must be not-needed, got ${status.state}`);

        const out = await applyRecoverFrontPlanLimitedMessages(null);
        assert.equal(out.state, "not-needed", `apply must be not-needed, got ${out.state}`);
        assert.equal(driverRan, false, "switch OFF → no Front drive");
        assert.equal(getDrainState(ACTION_ID), undefined, "switch OFF → no drain started");
        ok("search switch OFF → not-needed, no drain");
      } finally {
        __setReachFrontCoverageFullForMonthOverrideForTest(null);
        __resetPoolEpicSwitchesForTest();
        __resetDrainsForTest();
      }
    },
    { tables: TABLES },
  );
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

async function main(): Promise<void> {
  await testSelectorScoping();
  await testDrainProcessesEachMonthOnce();
  await testDrainRecordsNoProgressHonestly();
  await testBlockedWhenAuthBreakerActive();
  await testNotNeededWhenSwitchOff();
  console.log(`\n${passed} assertion group(s) passed`);
  console.log("prod-actions-recover-front-plan-limited.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit(), so a
// leaked handle surfaces as a real hang instead of being masked.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
