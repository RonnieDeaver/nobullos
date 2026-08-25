/* test-registration
{
  "name": "Prod actions finish front message grain (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * Task #2511 — the single consolidated "Finish Front message-grain coverage"
 * operator control.
 *
 * One press drives EVERY in-scope Front coverage month (at/after the hard-coded
 * FRONT_ADOPTION_DATE floor) to a real message-grain (`messages_all`)
 * denominator so the all-time headline — which sums ONLY message-grain months
 * (Task #2436) — reports honest message coverage. "Done" is
 * `inScopeExcludedMonths === 0` (`listInScopeNonMessageGrainMonths()` returns no
 * months).
 *
 * Apply runs in two phases:
 *   1. FREE relabel first — `backfillInScopeMessageGrain()` converts every
 *      in-scope row that already carries per-direction Front counts to message
 *      grain with ZERO Front calls (runs even when Front auth is down).
 *   2. ENUMERATION for the rest — a worker-pool background drain forces the
 *      per-message enumeration walk to re-measure the denominator. GRAIN-ONLY:
 *      no numerator recovery.
 *
 * The free-relabel path lives in `backfillInScopeMessageGrain → recomputeAllMonths`,
 * which uses the bare `db` import (not `getDb()`), so it does NOT route into an
 * isolated schema — exactly like the sibling
 * `tests/front-analytics-coverage-inscope-confirmation.test.ts` Part C. This suite
 * therefore exercises the free-relabel and blocked paths against the LIVE dev DB
 * (far-future fixtures + scoped cleanup), with the Front auth breaker tripped so
 * the action returns BEFORE ever starting the heavy background drain (no real
 * Front calls). The clean global done-state assertion runs in an isolated schema.
 *
 * Mirrors the fixture style of the inscope-confirmation suite.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { frontAnalyticsMonthlyCoverage } from "@shared/schema";
import {
  applyFinishFrontMessageGrainCoverage,
  getFinishFrontMessageGrainCoverageStatus,
} from "../server/services/prodActionsRegistry";
import {
  listInScopeNonMessageGrainMonths,
  isTerminalPlanLimitedForMessageGrain,
  FRONT_ADOPTION_DATE,
  DENOMINATOR_UNIT_MESSAGES_ALL,
} from "../server/services/frontAnalyticsCoverage";
import {
  tripFrontAuthBreaker,
  __resetFrontAuthBreakerForTest,
} from "../server/services/frontAuthBreaker";
import { runInIsolatedSchema } from "./db-sandbox";

const MSG_ALL = DENOMINATOR_UNIT_MESSAGES_ALL;

// The hard-coded adoption floor (Task #2481), as a YYYY-MM prefix.
const FLOOR_MONTH = FRONT_ADOPTION_DATE.slice(0, 7);

// Far-future year above every sibling Front-coverage suite (inscope-confirmation
// uses 3001) so our in-scope fixtures never collide with real coverage data.
const FUTURE_YEAR = 3002;

function monthBoundsFromLabel(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1)),
    end: new Date(Date.UTC(y, m, 1)),
  };
}

async function cleanupTestRows(): Promise<void> {
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage
    WHERE month LIKE ${`${FUTURE_YEAR}-%`}
  `);
}

async function insertRow(opts: {
  month: string;
  denominatorUnit: string | null;
  front: number;
  fetched: number;
  applied: number;
  // When BOTH are set, the Task #2290 free conversion can upgrade the row to
  // message grain with zero Front calls.
  messagesInboundFront?: number;
  messagesOutboundFront?: number;
  // Task #2674 — when set, the row is terminally plan-limited: Front's plan
  // does not expose its per-message history, so it can NEVER reach message
  // grain and must be excluded from the finish action's candidate set.
  analyticsPlanLimitedAt?: Date;
}): Promise<void> {
  const { start, end } = monthBoundsFromLabel(opts.month);
  await db.insert(frontAnalyticsMonthlyCoverage).values({
    month: opts.month,
    monthStart: start,
    monthEnd: end,
    frontTotalMessages: opts.front,
    fetchedIntoNobull: opts.fetched,
    appliedIntoNobull: opts.applied,
    denominatorUnit: opts.denominatorUnit ?? undefined,
    numeratorUnit: opts.denominatorUnit ?? undefined,
    messagesInboundFront: opts.messagesInboundFront ?? undefined,
    messagesOutboundFront: opts.messagesOutboundFront ?? undefined,
    analyticsPlanLimitedAt: opts.analyticsPlanLimitedAt ?? undefined,
    isFinalizedMonth: true,
    pulledAt: new Date(),
  });
}

async function denominatorUnitOf(month: string): Promise<string | null> {
  const rows = await db.execute(sql`
    SELECT denominator_unit
    FROM front_analytics_monthly_coverage
    WHERE month = ${month}
  `);
  return ((rows.rows as any[])[0]?.denominator_unit ?? null) as string | null;
}

// Part A (live DB) — the FREE relabel converges THROUGH the action with zero
// Front calls. The breaker is tripped so the action returns BEFORE starting any
// background drain, but the free relabel (phase 1) runs regardless. Idempotent.
async function freeRelabelConvergesThroughAction(): Promise<void> {
  await cleanupTestRows();
  try {
    tripFrontAuthBreaker("front_not_connected");

    // Two IN-SCOPE (far future) conversation-grain rows WITH per-direction
    // Front counts — free-convertible to message grain.
    await insertRow({
      month: `${FUTURE_YEAR}-07`,
      denominatorUnit: "conversations_all",
      front: 50,
      fetched: 40,
      applied: 30,
      messagesInboundFront: 120,
      messagesOutboundFront: 80,
    });
    await insertRow({
      month: `${FUTURE_YEAR}-08`,
      denominatorUnit: "conversations_all",
      front: 60,
      fetched: 50,
      applied: 45,
      messagesInboundFront: 200,
      messagesOutboundFront: 100,
    });

    // Pre-state: both rows are in-scope and excluded (not yet message-grain).
    const before = await listInScopeNonMessageGrainMonths();
    assert.equal(before.floorMonth, FLOOR_MONTH);
    const beforeMonths = new Set(before.months.map((m) => m.month));
    assert.ok(
      beforeMonths.has(`${FUTURE_YEAR}-07`) &&
        beforeMonths.has(`${FUTURE_YEAR}-08`),
      "both convertible in-scope rows start excluded",
    );

    // Apply: phase 1 relabels both rows for free. Breaker tripped → the action
    // returns applied (if nothing else remains) or blocked (if other real
    // in-scope months still need a Front re-pull) — never a drain.
    const out = await applyFinishFrontMessageGrainCoverage(null);
    assert.ok(
      out.state === "applied" || out.state === "blocked",
      `breaker tripped → applied or blocked, never a drain (got ${out.state})`,
    );
    assert.match(
      out.detail,
      /Relabeled \d+ in-scope month/,
      "detail reports the free relabel",
    );

    // Both fixtures now carry a message-grain denominator on disk...
    assert.equal(await denominatorUnitOf(`${FUTURE_YEAR}-07`), MSG_ALL);
    assert.equal(await denominatorUnitOf(`${FUTURE_YEAR}-08`), MSG_ALL);
    // ...and are no longer excluded targets.
    const after = await listInScopeNonMessageGrainMonths();
    const afterMonths = new Set(after.months.map((m) => m.month));
    assert.ok(
      !afterMonths.has(`${FUTURE_YEAR}-07`) &&
        !afterMonths.has(`${FUTURE_YEAR}-08`),
      "convertible fixtures are no longer excluded after the relabel",
    );

    // Idempotent: a second apply leaves the fixtures message-grain.
    await applyFinishFrontMessageGrainCoverage(null);
    assert.equal(await denominatorUnitOf(`${FUTURE_YEAR}-07`), MSG_ALL);
    assert.equal(await denominatorUnitOf(`${FUTURE_YEAR}-08`), MSG_ALL);
    console.log("  ok  free relabel converges through the action, idempotent");
  } finally {
    __resetFrontAuthBreakerForTest();
    await cleanupTestRows();
  }
}

// Part A2 (live DB) — "work remains, press to start" must stay clickable. When
// excluded months exist and NO drain is running, status is `pending` WITHOUT the
// `running` flag, so the amber-banner button is enabled (the bug code review
// caught: disabling on every `pending` blocked the operator from ever launching).
async function pendingNeedsRunStaysClickable(): Promise<void> {
  await cleanupTestRows();
  try {
    // Breaker reset so status takes the work-remains branch, not blocked.
    __resetFrontAuthBreakerForTest();

    // An in-scope row WITHOUT per-direction counts — excluded, not yet started.
    await insertRow({
      month: `${FUTURE_YEAR}-11`,
      denominatorUnit: "conversations_all",
      front: 30,
      fetched: 8,
      applied: 4,
    });

    const status = await getFinishFrontMessageGrainCoverageStatus();
    assert.equal(
      status.state,
      "pending",
      "work remains (no drain running) → pending",
    );
    assert.notEqual(
      (status as { running?: boolean }).running,
      true,
      "no active drain → not running → button stays clickable",
    );
    console.log("  ok  needs-run pending stays clickable (not running)");
  } finally {
    __resetFrontAuthBreakerForTest();
    await cleanupTestRows();
  }
}

// Part B (live DB) — Front auth dead + an un-convertible in-scope month: the
// action reports `blocked` (naming Front) instead of starting a drain that
// cannot succeed, and the month stays a target so it converges once Front heals.
async function blockedWhenFrontAuthDead(): Promise<void> {
  await cleanupTestRows();
  try {
    // IN-SCOPE conversation-grain row WITHOUT per-direction counts — NOT
    // free-convertible, so only a Front re-pull could lift it.
    await insertRow({
      month: `${FUTURE_YEAR}-09`,
      denominatorUnit: "conversations_all",
      front: 70,
      fetched: 10,
      applied: 5,
    });

    tripFrontAuthBreaker("front_not_connected");

    const status = await getFinishFrontMessageGrainCoverageStatus();
    assert.equal(status.state, "blocked", "breaker open → status blocked");
    assert.equal(
      (status as { integration?: string }).integration,
      "Front",
      "blocked status names Front",
    );

    const out = await applyFinishFrontMessageGrainCoverage(null);
    assert.equal(out.state, "blocked", "breaker open → apply blocked");
    assert.equal(
      (out as { integration?: string }).integration,
      "Front",
      "blocked outcome names Front",
    );

    // The un-convertible row is still a target (not silently dropped).
    const listed = await listInScopeNonMessageGrainMonths();
    assert.ok(
      listed.months.some((m) => m.month === `${FUTURE_YEAR}-09`),
      "the un-convertible in-scope month is still a target",
    );
    console.log("  ok  Front auth dead → blocked(Front), no drain");
  } finally {
    __resetFrontAuthBreakerForTest();
    await cleanupTestRows();
  }
}

// Part C (isolated schema) — clean global done-state: when EVERY in-scope month
// already carries a message-grain denominator, both status() and apply() report
// the explicit not-needed done-state. Isolated so the assertion is global, not
// scoped to fixtures (the cloned table holds only our row).
async function notNeededWhenAllMessageGrain(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: iso }) => {
      const { start, end } = monthBoundsFromLabel(`${FUTURE_YEAR}-10`);
      await iso.execute(sql`
        INSERT INTO front_analytics_monthly_coverage
          (month, month_start, month_end, denominator_unit, numerator_unit,
           front_total_messages, fetched_into_nobull, applied_into_nobull,
           is_finalized_month, pulled_at)
        VALUES (
          ${`${FUTURE_YEAR}-10`}, ${start.toISOString()}, ${end.toISOString()},
          ${MSG_ALL}, ${MSG_ALL}, 1000, 900, 850, true, NOW()
        )
      `);

      const listed = await listInScopeNonMessageGrainMonths();
      assert.equal(
        listed.months.length,
        0,
        "an already-message-grain in-scope row is not a target",
      );
      const status = await getFinishFrontMessageGrainCoverageStatus();
      assert.equal(status.state, "not-needed", "status reports done-state");
      const out = await applyFinishFrontMessageGrainCoverage(null);
      assert.equal(out.state, "not-needed", "apply reports done-state");
      console.log("  ok  all message-grain → not-needed done-state");
    },
    { tables: ["front_analytics_monthly_coverage", "system_settings"] },
  );
}

// Task #2674 — the pure predicate: any non-null memo (string or Date) is
// terminal; null/undefined is convertible.
function terminalPlanLimitedPredicate(): void {
  assert.equal(
    isTerminalPlanLimitedForMessageGrain(new Date().toISOString()),
    true,
    "ISO-string memo → terminal",
  );
  assert.equal(
    isTerminalPlanLimitedForMessageGrain(new Date()),
    true,
    "Date memo → terminal",
  );
  assert.equal(
    isTerminalPlanLimitedForMessageGrain(null),
    false,
    "null memo → convertible",
  );
  assert.equal(
    isTerminalPlanLimitedForMessageGrain(undefined),
    false,
    "undefined memo → convertible",
  );
  console.log("  ok  terminal-plan-limited predicate");
}

// Task #2674 (live DB, scoped) — a terminally plan-limited in-scope month is
// NOT a finish-action target (it can never reach message grain), but it IS
// surfaced in `terminalPlanLimitedMonths` so the done-state can name it. A
// convertible sibling stays a target. This is the perpetual-pending fix: the
// plan-limited month no longer keeps the candidate count above zero forever.
async function planLimitedMonthExcludedButSurfaced(): Promise<void> {
  await cleanupTestRows();
  try {
    __resetFrontAuthBreakerForTest();

    // Terminally plan-limited in-scope row (conversation grain, memo set).
    await insertRow({
      month: `${FUTURE_YEAR}-02`,
      denominatorUnit: "conversations_all",
      front: 90,
      fetched: 20,
      applied: 10,
      analyticsPlanLimitedAt: new Date(),
    });
    // Convertible in-scope row WITHOUT per-direction counts — a genuine target.
    await insertRow({
      month: `${FUTURE_YEAR}-03`,
      denominatorUnit: "conversations_all",
      front: 40,
      fetched: 10,
      applied: 5,
    });

    const listed = await listInScopeNonMessageGrainMonths();
    const targets = new Set(listed.months.map((m) => m.month));
    assert.ok(
      !targets.has(`${FUTURE_YEAR}-02`),
      "terminally plan-limited month is NOT a finish target",
    );
    assert.ok(
      targets.has(`${FUTURE_YEAR}-03`),
      "the convertible month IS still a finish target",
    );
    assert.ok(
      listed.terminalPlanLimitedMonths.includes(`${FUTURE_YEAR}-02`),
      "the plan-limited month is surfaced (not silently dropped)",
    );
    assert.ok(
      !listed.terminalPlanLimitedMonths.includes(`${FUTURE_YEAR}-03`),
      "the convertible month is not mistaken for terminal",
    );
    console.log(
      "  ok  plan-limited month excluded from targets but surfaced",
    );
  } finally {
    __resetFrontAuthBreakerForTest();
    await cleanupTestRows();
  }
}

// Task #2674 (live DB, scoped) — REVIVAL PATH: a month that was terminally
// plan-limited re-enters the candidate set the moment the plan-limit memo is
// cleared (e.g. a Front plan upgrade exposes its per-message history). The
// exclusion is never a permanent silent drop of convertible work.
async function planLimitClearRevivesCandidate(): Promise<void> {
  await cleanupTestRows();
  try {
    __resetFrontAuthBreakerForTest();

    await insertRow({
      month: `${FUTURE_YEAR}-04`,
      denominatorUnit: "conversations_all",
      front: 90,
      fetched: 20,
      applied: 10,
      analyticsPlanLimitedAt: new Date(),
    });

    const before = await listInScopeNonMessageGrainMonths();
    assert.ok(
      !before.months.some((m) => m.month === `${FUTURE_YEAR}-04`),
      "plan-limited month starts excluded from targets",
    );

    // The plan-limit memo clears (a successful Analytics pull would set it null).
    await db.execute(sql`
      UPDATE front_analytics_monthly_coverage
      SET analytics_plan_limited_at = NULL
      WHERE month = ${`${FUTURE_YEAR}-04`}
    `);

    const after = await listInScopeNonMessageGrainMonths();
    assert.ok(
      after.months.some((m) => m.month === `${FUTURE_YEAR}-04`),
      "clearing the plan-limit memo revives the month as a target",
    );
    assert.ok(
      !after.terminalPlanLimitedMonths.includes(`${FUTURE_YEAR}-04`),
      "the revived month is no longer reported as terminal",
    );
    console.log("  ok  clearing the plan-limit memo revives the candidate");
  } finally {
    __resetFrontAuthBreakerForTest();
    await cleanupTestRows();
  }
}

// Task #2674 (isolated schema) — the perpetual-pending settle: when the ONLY
// remaining in-scope non-message-grain month is terminally plan-limited,
// status() reports the not-needed done-state (button settles) and names the
// terminal month honestly instead of claiming every month is message-grain.
// Isolated so the assertion is global (the cloned table holds only our rows).
async function notNeededWhenOnlyPlanLimitedRemains(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: iso }) => {
      const grain = monthBoundsFromLabel(`${FUTURE_YEAR}-05`);
      // One already-message-grain in-scope row (counted) ...
      await iso.execute(sql`
        INSERT INTO front_analytics_monthly_coverage
          (month, month_start, month_end, denominator_unit, numerator_unit,
           front_total_messages, fetched_into_nobull, applied_into_nobull,
           is_finalized_month, pulled_at)
        VALUES (
          ${`${FUTURE_YEAR}-05`}, ${grain.start.toISOString()},
          ${grain.end.toISOString()}, ${MSG_ALL}, ${MSG_ALL},
          1000, 900, 850, true, NOW()
        )
      `);
      // ... and one terminally plan-limited conversation-grain in-scope row.
      const limited = monthBoundsFromLabel(`${FUTURE_YEAR}-06`);
      await iso.execute(sql`
        INSERT INTO front_analytics_monthly_coverage
          (month, month_start, month_end, denominator_unit, numerator_unit,
           front_total_messages, fetched_into_nobull, applied_into_nobull,
           analytics_plan_limited_at, is_finalized_month, pulled_at)
        VALUES (
          ${`${FUTURE_YEAR}-06`}, ${limited.start.toISOString()},
          ${limited.end.toISOString()}, 'conversations_all', 'conversations_all',
          500, 120, 60, NOW(), true, NOW()
        )
      `);

      const listed = await listInScopeNonMessageGrainMonths();
      assert.equal(
        listed.months.length,
        0,
        "no convertible targets remain (the plan-limited month is excluded)",
      );
      assert.deepEqual(
        listed.terminalPlanLimitedMonths,
        [`${FUTURE_YEAR}-06`],
        "the lone plan-limited month is surfaced as terminal",
      );

      const status = await getFinishFrontMessageGrainCoverageStatus();
      assert.equal(
        status.state,
        "not-needed",
        "button settles: only a terminal plan-limited month remains",
      );
      assert.match(
        status.detail,
        /plan/i,
        "done-state names the plan limitation honestly",
      );
      console.log(
        "  ok  only-plan-limited-remaining → not-needed (button settles)",
      );
    },
    { tables: ["front_analytics_monthly_coverage", "system_settings"] },
  );
}

async function main(): Promise<void> {
  terminalPlanLimitedPredicate();
  await freeRelabelConvergesThroughAction();
  await pendingNeedsRunStaysClickable();
  await blockedWhenFrontAuthDead();
  await notNeededWhenAllMessageGrain();
  await planLimitedMonthExcludedButSurfaced();
  await planLimitClearRevivesCandidate();
  await notNeededWhenOnlyPlanLimitedRemains();
  console.log("prod-actions-finish-front-message-grain.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
await main();
