/* test-registration
{
  "name": "Front coverage in-scope confirmation + backfill (Task #2439)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "timeoutMs": 120000,
  "tier": "small"
}
test-registration */
/**
 * Task #2439 — Front Analytics all-time "in-scope confirmation" diagnostics.
 *
 * The all-time accumulator silently skips any in-scope month (at/after the
 * adoption floor) whose denominator is not yet message-grain. Operators had
 * no way to tell whether the headline already counts EVERY in-scope month or
 * is quietly excluding some. `getFrontAnalyticsCoverageSummary().allTime` now
 * carries an explicit split — `inScopeMonths` / `inScopeCountedMonths` /
 * `inScopeExcludedMonths` — derived from the same floor + grain predicate the
 * accumulator uses, so the two can never disagree. The exported helper
 * `listInScopeNonMessageGrainMonths()` names the exact excluded months (the
 * targets to drive to message grain).
 *
 * Task #2481 hard-coded the adoption floor to the constant
 * `FRONT_ADOPTION_DATE` ("2025-07-01"), so the floor is ALWAYS present and the
 * (now dead) `system_settings.front_adoption_date` row is ignored. This suite
 * therefore exercises only the real, always-non-null floor: it can no longer
 * pin a movable floor via `system_settings`, so it straddles the fixed floor
 * with far-past (pre-floor) and far-future (in-scope) fixture months that
 * never collide with real coverage data.
 *
 * Part A (read-only, live DB): seeds a pre-floor (far-past) message-grain row,
 * an in-scope (far-future) conversation-grain row, and an in-scope (far-future)
 * message-grain row, then proves the in-scope split deltas and the message-grain
 * numerator total (the Task #2436 overflow fix) behave correctly against the
 * hard-coded floor.
 *
 * Part B (isolated schema): exercises `listInScopeNonMessageGrainMonths()` floor
 * scoping precisely against a cloned table — pre-floor months are excluded,
 * at/after-floor non-message-grain months (including NULL-unit) are targets, and
 * the message-grain month is excluded — all relative to the hard-coded floor.
 *
 * Part C (isolated schema): the BACKFILL EXECUTION path. Because
 * `recomputeAllMonths` / `backfillInScopeMessageGrain` now resolve their DB
 * handle via `getDb()`, this runs against a fresh cloned schema and can assert
 * EXACT absolute counts. Seeds two in-scope (far-future) convertible
 * conversation-grain rows (with per-direction Front counts) and one
 * un-convertible one, then proves `backfillInScopeMessageGrain()` upgrades both
 * convertible rows to message grain (exact `examined` / `upgraded` /
 * `stillExcludedMonths`), is idempotent on re-run, and reports the
 * un-convertible row in `stillExcludedMonths`.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import {
  getFrontAnalyticsCoverageSummary,
  listInScopeNonMessageGrainMonths,
  backfillInScopeMessageGrain,
  getAdoptionFloorMonth,
  FRONT_ADOPTION_DATE,
  DENOMINATOR_UNIT_MESSAGES_ALL,
} from "../server/services/frontAnalyticsCoverage";
import { runInIsolatedSchema } from "./db-sandbox";

const MSG_ALL = DENOMINATOR_UNIT_MESSAGES_ALL;

// The hard-coded adoption floor (Task #2481), as a YYYY-MM prefix. Every
// expectation derives from this constant so the suite tracks the code if the
// constant ever moves.
const FLOOR_MONTH = FRONT_ADOPTION_DATE.slice(0, 7);

// Far-future year above every sibling Front-coverage suite (#1643 uses 2999,
// #1675 uses 2997, #2436 uses 2996) so our in-scope fixtures never collide.
const FUTURE_YEAR = 3001;
// Far-past year — guaranteed below the fixed floor (Front adoption is 2025-07)
// and never present in real coverage data, used for the pre-floor fixture.
const PAST_YEAR = 1990;

function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthBoundsFromLabel(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1)),
    end: new Date(Date.UTC(y, m, 1)),
  };
}

// Part A (isolated schema): the IN-SCOPE SPLIT read path. Because
// `getFrontAnalyticsCoverageSummary` resolves its DB handle via `getDb()`,
// running against a fresh cloned schema (no other coverage rows) lets us
// assert EXACT absolute in-scope split totals and the message-grain
// numerator total instead of before/after deltas — removing the last
// shared dev-DB dependency in this suite.
async function partA(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: iso }) => {
      const insert = async (opts: {
        month: string;
        denominatorUnit: string | null;
        front: number;
        fetched: number;
        applied: number;
      }) => {
        const { start, end } = monthBoundsFromLabel(opts.month);
        await iso.execute(sql`
          INSERT INTO front_analytics_monthly_coverage
            (month, month_start, month_end, front_total_messages,
             fetched_into_nobull, applied_into_nobull, denominator_unit,
             numerator_unit, is_finalized_month, pulled_at)
          VALUES (
            ${opts.month}, ${start.toISOString()}, ${end.toISOString()},
            ${opts.front}, ${opts.fetched}, ${opts.applied},
            ${opts.denominatorUnit}, ${opts.denominatorUnit},
            true, ${new Date().toISOString()}
          )
        `);
      };

      // (a) PRE-FLOOR (far past), message-grain — out of scope entirely (not
      // counted in inScopeMonths at all).
      await insert({
        month: `${PAST_YEAR}-03`,
        denominatorUnit: MSG_ALL,
        front: 100,
        fetched: 80,
        applied: 70,
      });
      // (b) IN-SCOPE (far future), conversation-grain — in scope but excluded
      // from the headline purely because it is not yet message-grain.
      await insert({
        month: `${FUTURE_YEAR}-07`,
        denominatorUnit: "conversations_all",
        front: 50,
        fetched: 300,
        applied: 250,
      });
      // (c) IN-SCOPE (far future), message-grain — in scope AND counted.
      await insert({
        month: `${FUTURE_YEAR}-08`,
        denominatorUnit: MSG_ALL,
        front: 1000,
        fetched: 900,
        applied: 850,
      });

      const after = await getFrontAnalyticsCoverageSummary();

      // The isolated schema holds ONLY these three rows, so the all-time
      // diagnostics are absolute, not deltas. (b) and (c) are in scope; only
      // (c) is counted; (b) is the lone excluded month. (a) is pre-floor so
      // contributes to none of the in-scope counters.
      assert.equal(after.allTime.totalMonths, 3, "exactly three seeded rows");
      assert.equal(
        after.allTime.inScopeMonths,
        2,
        "both at/after-floor months are in scope",
      );
      assert.equal(
        after.allTime.inScopeCountedMonths,
        1,
        "only the message-grain in-scope month is counted",
      );
      assert.equal(
        after.allTime.inScopeExcludedMonths,
        1,
        "the conversation-grain in-scope month is excluded",
      );
      assert.equal(
        after.allTime.excludedPreFloorMonths,
        1,
        "the far-past row is the lone pre-floor exclusion",
      );

      // The split must always reconcile.
      assert.equal(
        after.allTime.inScopeExcludedMonths,
        after.allTime.inScopeMonths - after.allTime.inScopeCountedMonths,
        "excluded == inScope - counted",
      );

      // No regression of the Task #2436 overflow fix: only the in-scope
      // message-grain row contributes to the numerator/denominator totals and
      // coverage never overflows.
      assert.equal(
        after.allTime.frontTotalMessages,
        1000,
        "only the in-scope message-grain denominator is summed",
      );
      assert.ok(
        after.allTime.appliedCoveragePct <= 100,
        `applied coverage must not overflow (got ${after.allTime.appliedCoveragePct})`,
      );

      // listInScopeNonMessageGrainMonths names the in-scope excluded month and
      // reports the hard-coded floor — and, in isolation, it is the SOLE target.
      const listed = await listInScopeNonMessageGrainMonths();
      assert.equal(listed.floorMonth, FLOOR_MONTH);
      assert.deepEqual(
        listed.months.map((m) => m.month),
        [`${FUTURE_YEAR}-07`],
        "exactly the in-scope conversation-grain month is listed as a target",
      );
      const target = listed.months.find((m) => m.month === `${FUTURE_YEAR}-07`);
      assert.equal(
        target?.denominatorUnit,
        "conversations_all",
        "listed target carries its current (non-message) grain",
      );
    },
    { tables: ["front_analytics_monthly_coverage", "system_settings"] },
  );
}

async function partB(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: iso }) => {
      const insert = async (month: string, unit: string | null) => {
        const { start, end } = monthBoundsFromLabel(month);
        await iso.execute(sql`
          INSERT INTO front_analytics_monthly_coverage
            (month, month_start, month_end, denominator_unit)
          VALUES (
            ${month},
            ${start.toISOString()},
            ${end.toISOString()},
            ${unit}
          )
        `);
      };

      // The floor is the hard-coded FRONT_ADOPTION_DATE (Task #2481), always
      // non-null and independent of system_settings. Straddle it:
      //   floor-2 conv-grain (pre-floor), floor-1 NULL (pre-floor),
      //   floor    conv-grain (at-floor target),
      //   floor+1  message-grain (excluded — already counted),
      //   floor+2  NULL (after-floor target),
      //   floor+3  conv-grain (after-floor target).
      await insert(addMonths(FLOOR_MONTH, -2), "conversations_all");
      await insert(addMonths(FLOOR_MONTH, -1), null);
      await insert(FLOOR_MONTH, "conversations_all");
      await insert(addMonths(FLOOR_MONTH, 1), MSG_ALL);
      await insert(addMonths(FLOOR_MONTH, 2), null);
      await insert(addMonths(FLOOR_MONTH, 3), "conversations_all");

      // The floor is always present (never null) post-#2481.
      assert.equal(await getAdoptionFloorMonth(), FLOOR_MONTH);

      const listed = await listInScopeNonMessageGrainMonths();
      assert.equal(listed.floorMonth, FLOOR_MONTH);
      assert.deepEqual(
        listed.months.map((m) => m.month).sort(),
        [
          FLOOR_MONTH,
          addMonths(FLOOR_MONTH, 2),
          addMonths(FLOOR_MONTH, 3),
        ].sort(),
        "floor scopes targets to at/after-floor non-message-grain months",
      );
    },
    { tables: ["front_analytics_monthly_coverage", "system_settings"] },
  );
}

// Part C (isolated schema): the BACKFILL EXECUTION path. Because
// `recomputeAllMonths` / `backfillInScopeMessageGrain` now resolve their DB
// handle via `getDb()`, the whole backfill (read rows → recompute → write)
// honors the isolated schema's search_path. Running against a fresh cloned
// schema (no other coverage rows, empty cloned source tables) lets us assert
// EXACT absolute counts instead of loose fixture-membership checks:
//   1. exactly the two convertible in-scope rows are examined and upgraded,
//   2. zero remain excluded, and both carry a message-grain denominator on disk,
//   3. a second run is a no-op (examined == upgraded == 0), and
//   4. an in-scope row WITHOUT per-direction counts is examined, NOT upgraded,
//      and is the sole entry in `stillExcludedMonths`.
async function partC(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: iso }) => {
      const insert = async (opts: {
        month: string;
        denominatorUnit: string | null;
        front: number;
        fetched: number;
        applied: number;
        messagesInboundFront?: number;
        messagesOutboundFront?: number;
      }) => {
        const { start, end } = monthBoundsFromLabel(opts.month);
        await iso.execute(sql`
          INSERT INTO front_analytics_monthly_coverage
            (month, month_start, month_end, front_total_messages,
             fetched_into_nobull, applied_into_nobull, denominator_unit,
             numerator_unit, messages_inbound_front, messages_outbound_front,
             is_finalized_month, pulled_at)
          VALUES (
            ${opts.month}, ${start.toISOString()}, ${end.toISOString()},
            ${opts.front}, ${opts.fetched}, ${opts.applied},
            ${opts.denominatorUnit}, ${opts.denominatorUnit},
            ${opts.messagesInboundFront ?? null},
            ${opts.messagesOutboundFront ?? null},
            true, ${new Date().toISOString()}
          )
        `);
      };

      // Two IN-SCOPE (far future) conversation-grain rows WITH per-direction
      // Front counts — free-convertible to message grain.
      await insert({
        month: `${FUTURE_YEAR}-07`,
        denominatorUnit: "conversations_all",
        front: 50,
        fetched: 40,
        applied: 30,
        messagesInboundFront: 120,
        messagesOutboundFront: 80,
      });
      await insert({
        month: `${FUTURE_YEAR}-08`,
        denominatorUnit: "conversations_all",
        front: 60,
        fetched: 50,
        applied: 45,
        messagesInboundFront: 200,
        messagesOutboundFront: 100,
      });

      // Pre-run: EXACTLY these two in-scope rows are excluded — the isolated
      // schema holds no other coverage data, so this is an absolute set.
      const beforeList = await listInScopeNonMessageGrainMonths();
      assert.equal(beforeList.floorMonth, FLOOR_MONTH);
      assert.deepEqual(
        beforeList.months.map((m) => m.month).sort(),
        [`${FUTURE_YEAR}-07`, `${FUTURE_YEAR}-08`].sort(),
        "exactly the two convertible in-scope rows start excluded",
      );

      // Run 1 — both convertible rows upgrade to message grain. Exact counts.
      const run1 = await backfillInScopeMessageGrain();
      assert.equal(run1.floorMonth, FLOOR_MONTH);
      assert.equal(run1.examined, 2, "two in-scope non-message-grain rows examined");
      assert.equal(run1.upgraded, 2, "both convertible rows upgraded");
      assert.deepEqual(
        run1.stillExcludedMonths,
        [],
        "zero in-scope months remain excluded after the backfill",
      );

      // Both rows now carry a message-grain denominator on disk — and they are
      // the only rows present.
      const rows1 = await iso.execute(sql`
        SELECT month, denominator_unit
        FROM front_analytics_monthly_coverage
        ORDER BY month
      `);
      assert.deepEqual(
        (rows1.rows as any[]).map((r) => [r.month, r.denominator_unit]),
        [
          [`${FUTURE_YEAR}-07`, MSG_ALL],
          [`${FUTURE_YEAR}-08`, MSG_ALL],
        ],
        "both rows upgraded to message grain on disk",
      );

      // Global invariant: coverage never overflows after the backfill.
      const summary = await getFrontAnalyticsCoverageSummary();
      assert.ok(
        summary.allTime.appliedCoveragePct <= 100,
        `no overflow regression (got ${summary.allTime.appliedCoveragePct})`,
      );

      // Run 2 — idempotent: nothing left to examine or upgrade.
      const run2 = await backfillInScopeMessageGrain();
      assert.equal(run2.examined, 0, "no in-scope non-message-grain rows remain");
      assert.equal(run2.upgraded, 0, "idempotent re-run upgrades nothing");
      assert.deepEqual(
        run2.stillExcludedMonths,
        [],
        "idempotent re-run leaves nothing excluded",
      );

      // Now add an IN-SCOPE row that LACKS per-direction counts — it cannot be
      // converted for free, so the backfill must REPORT it (not silently drop
      // it) for the heavy Front-re-pull driver.
      await insert({
        month: `${FUTURE_YEAR}-09`,
        denominatorUnit: "conversations_all",
        front: 70,
        fetched: 10,
        applied: 5,
      });
      const run3 = await backfillInScopeMessageGrain();
      assert.equal(run3.examined, 1, "only the un-convertible row is examined");
      assert.equal(run3.upgraded, 0, "un-convertible row cannot upgrade for free");
      assert.deepEqual(
        run3.stillExcludedMonths,
        [`${FUTURE_YEAR}-09`],
        "un-convertible in-scope row is the sole entry in stillExcludedMonths",
      );
    },
    {
      tables: [
        "front_analytics_monthly_coverage",
        "front_sync_emails",
        "raw_communication_records",
        "system_settings",
      ],
    },
  );
}

async function main(): Promise<void> {
  await partA();
  await partB();
  await partC();
  console.log("front-analytics-coverage-inscope-confirmation.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
await main();
