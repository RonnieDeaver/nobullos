/* test-registration
{
  "name": "Front coverage message-grain everywhere (Task #2290)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2290 — Front coverage at message grain, both directions.
 *
 * Finishes rolling out the per-direction MESSAGE-grain model so EVERY
 * month reports a message denominator + numerator (split inbound /
 * outbound) and no month silently uses conversation counts as a
 * stand-in. Two real gaps remained after #1974 / #1983 / #1920:
 *
 *   A. The in-plan Analytics path (`refreshMonth` when the per-direction
 *      Analytics pull succeeds for BOTH directions) used to publish a
 *      CONVERSATION-grain headline (from the Conversations Search
 *      companion pull) even though it already held message-grain
 *      both-direction data. It now publishes a message-grain headline
 *      AND skips the now-redundant search pull (saving Front budget).
 *
 *   B. `recomputeAllMonths` (the throttled backfill) did not upgrade
 *      rows that already carry both Front-side per-direction counts but
 *      whose headline is still conversation-grain. It now converts them
 *      to message grain IN PLACE for FREE (zero Front calls).
 *
 * Far-future months (2997-*) so this never overlaps real adoption or the
 * 2995-/2998-/2999-* fixtures other Front suites use. Cleans up every row
 * it creates by month prefix.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { frontAnalyticsMonthlyCoverage } from "@shared/schema";
import {
  __frontAnalyticsClientTestHelpers,
  type MonthlyMetricResult,
  type MonthlyMessagesByDirection,
} from "../server/services/frontAnalyticsClient";
import {
  refreshMonth,
  recomputeAllMonths,
  getExistingMonth,
  DENOMINATOR_UNIT_MESSAGES_ALL,
  DENOMINATOR_UNIT_CONVERSATIONS_ALL,
  NUMERATOR_UNIT_CONVERSATIONS_ALL,
  DENOMINATOR_SOURCE_ANALYTICS,
  DIRECTION_DATA_SOURCE_ANALYTICS,
} from "../server/services/frontAnalyticsCoverage";

const FUTURE_YEAR = 2997;

function utcMonth(
  year: number,
  mIdx: number,
): { start: Date; end: Date; label: string } {
  return {
    start: new Date(Date.UTC(year, mIdx, 1)),
    end: new Date(Date.UTC(year, mIdx + 1, 1)),
    label: `${year}-${String(mIdx + 1).padStart(2, "0")}`,
  };
}

async function cleanupTestRows(): Promise<void> {
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage
    WHERE month LIKE ${`${FUTURE_YEAR}-%`}
  `);
}

function dirResult(inbound: number, outbound: number): MonthlyMessagesByDirection {
  return {
    inbound: {
      value: inbound,
      reportId: "dir-in",
      status: "done",
      metric: "num_messages_received",
    },
    outbound: {
      value: outbound,
      reportId: "dir-out",
      status: "done",
      metric: "num_messages_sent",
    },
  };
}

async function main(): Promise<void> {
  await cleanupTestRows();

  // ───────────────────────────────────────────────────────────────────
  // A. In-plan path: both-direction Analytics → MESSAGE-grain headline,
  //    search companion pull SKIPPED.
  // ───────────────────────────────────────────────────────────────────
  {
    const M = utcMonth(FUTURE_YEAR, 0); // 2997-01

    // Headline Analytics pull (num_messages_received) — inbound only.
    __frontAnalyticsClientTestHelpers.setPullOverride(async () => {
      return {
        reportId: "headline-a",
        value: 70,
        status: "done",
        metric: "num_messages_received",
      } as MonthlyMetricResult;
    });
    // Per-direction Analytics pull succeeds for BOTH directions.
    __frontAnalyticsClientTestHelpers.setDirectionPullOverride(async () =>
      dirResult(70, 30),
    );
    // The Conversations Search companion pull MUST NOT run when both
    // directions are known — count invocations to prove it.
    let searchCalls = 0;
    __frontAnalyticsClientTestHelpers.setSearchFallbackOverride(async () => {
      searchCalls += 1;
      return { count: 999, pagesFetched: 1, truncated: false } as any;
    });

    try {
      const r = await refreshMonth({
        month: M.label,
        monthStart: M.start,
        monthEnd: M.end,
        isCurrentMonth: false,
      });
      assert.equal(r.outcome, "ok", "A: in-plan path should succeed");
      assert.equal(
        searchCalls,
        0,
        "A: search-conversations companion pull must be SKIPPED when both directions are known",
      );

      const row = await getExistingMonth(M.label);
      assert.ok(row, "A: row must exist");
      assert.equal(
        row!.denominatorUnit,
        DENOMINATOR_UNIT_MESSAGES_ALL,
        "A: denominator must be message-grain",
      );
      assert.equal(
        row!.numeratorUnit,
        DENOMINATOR_UNIT_MESSAGES_ALL,
        "A: numerator must be message-grain (units comparable → no badge)",
      );
      assert.equal(
        row!.denominatorSource,
        DENOMINATOR_SOURCE_ANALYTICS,
        "A: denominator source is the per-direction Analytics sum",
      );
      assert.equal(
        row!.frontTotalMessages,
        100,
        "A: message denominator = inbound(70) + outbound(30)",
      );
      assert.equal(row!.messagesInboundFront, 70, "A: inbound front count");
      assert.equal(row!.messagesOutboundFront, 30, "A: outbound front count");
      assert.equal(
        row!.directionDataSource,
        DIRECTION_DATA_SOURCE_ANALYTICS,
        "A: direction data source recorded",
      );
    } finally {
      __frontAnalyticsClientTestHelpers.setPullOverride(null);
      __frontAnalyticsClientTestHelpers.setDirectionPullOverride(null);
      __frontAnalyticsClientTestHelpers.setSearchFallbackOverride(null);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // B. In-plan path: only ONE direction known → falls back to the
  //    conversation-grain search denominator (no silent message claim).
  // ───────────────────────────────────────────────────────────────────
  {
    const M = utcMonth(FUTURE_YEAR, 1); // 2997-02

    __frontAnalyticsClientTestHelpers.setPullOverride(async () => {
      return {
        reportId: "headline-b",
        value: 50,
        status: "done",
        metric: "num_messages_received",
      } as MonthlyMetricResult;
    });
    // Direction pull fails → both Front counts left NULL → directionKnown=false.
    __frontAnalyticsClientTestHelpers.setDirectionPullOverride(async () => {
      throw new Error("simulated per-direction Analytics failure");
    });
    let searchCalls = 0;
    __frontAnalyticsClientTestHelpers.setSearchFallbackOverride(async () => {
      searchCalls += 1;
      return { count: 222, pagesFetched: 1, truncated: false } as any;
    });

    try {
      const r = await refreshMonth({
        month: M.label,
        monthStart: M.start,
        monthEnd: M.end,
        isCurrentMonth: false,
      });
      assert.equal(r.outcome, "ok", "B: in-plan path should succeed");
      assert.equal(
        searchCalls,
        1,
        "B: search companion pull MUST run when direction data is unavailable",
      );

      const row = await getExistingMonth(M.label);
      assert.equal(
        row!.denominatorUnit,
        DENOMINATOR_UNIT_CONVERSATIONS_ALL,
        "B: denominator falls back to conversation grain",
      );
      assert.equal(
        row!.frontTotalMessages,
        222,
        "B: denominator is the search-conversation count",
      );
      assert.equal(
        row!.messagesInboundFront,
        null,
        "B: inbound front stays NULL on a failed direction pull",
      );
    } finally {
      __frontAnalyticsClientTestHelpers.setPullOverride(null);
      __frontAnalyticsClientTestHelpers.setDirectionPullOverride(null);
      __frontAnalyticsClientTestHelpers.setSearchFallbackOverride(null);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // C. recomputeAllMonths: FREE message-grain conversion of a
  //    conversation-grain row that already carries both Front-side
  //    per-direction counts. Zero Front calls (budget 0).
  // ───────────────────────────────────────────────────────────────────
  {
    const Mconvert = utcMonth(FUTURE_YEAR, 2); // 2997-03 — converts
    const Mstay = utcMonth(FUTURE_YEAR, 3); // 2997-04 — no direction data, stays

    // Seed a conversation-grain row WITH both Front-side direction counts.
    await db
      .insert(frontAnalyticsMonthlyCoverage)
      .values({
        month: Mconvert.label,
        monthStart: Mconvert.start,
        monthEnd: Mconvert.end,
        frontTotalMessages: 500, // conversation count (pre-#2290)
        fetchedIntoNobull: 480,
        appliedIntoNobull: 470,
        ingestGap: 20,
        applyGap: 10,
        fetchedCoveragePct: 0,
        appliedCoveragePct: 0,
        isFinalizedMonth: true,
        unrecoverable: false,
        denominatorUnit: DENOMINATOR_UNIT_CONVERSATIONS_ALL,
        numeratorUnit: NUMERATOR_UNIT_CONVERSATIONS_ALL,
        denominatorSource: "search_conversations",
        messagesInboundFront: 120,
        messagesOutboundFront: 80,
        directionDataSource: DIRECTION_DATA_SOURCE_ANALYTICS,
        pulledAt: new Date("2026-05-20T00:00:00Z"),
      })
      .onConflictDoNothing();

    // Seed a conversation-grain row WITHOUT direction data → must NOT convert.
    await db
      .insert(frontAnalyticsMonthlyCoverage)
      .values({
        month: Mstay.label,
        monthStart: Mstay.start,
        monthEnd: Mstay.end,
        frontTotalMessages: 300,
        fetchedIntoNobull: 290,
        appliedIntoNobull: 285,
        ingestGap: 10,
        applyGap: 5,
        fetchedCoveragePct: 0,
        appliedCoveragePct: 0,
        isFinalizedMonth: true,
        unrecoverable: false,
        denominatorUnit: DENOMINATOR_UNIT_CONVERSATIONS_ALL,
        numeratorUnit: NUMERATOR_UNIT_CONVERSATIONS_ALL,
        denominatorSource: "search_conversations",
        messagesInboundFront: null,
        messagesOutboundFront: null,
        directionDataSource: null,
        pulledAt: new Date("2026-05-20T00:00:00Z"),
      })
      .onConflictDoNothing();

    // budget 0 → no Front pulls anywhere; conversion branch is free.
    let pullCalls = 0;
    __frontAnalyticsClientTestHelpers.setSearchFallbackOverride(async () => {
      pullCalls += 1;
      return { count: 1, pagesFetched: 1, truncated: false } as any;
    });

    try {
      await recomputeAllMonths({ frontPullsBudget: 0 });
      assert.equal(
        pullCalls,
        0,
        "C: free conversion must consume ZERO Front pulls",
      );

      const converted = await getExistingMonth(Mconvert.label);
      assert.equal(
        converted!.denominatorUnit,
        DENOMINATOR_UNIT_MESSAGES_ALL,
        "C: row with direction data converts to message grain",
      );
      assert.equal(
        converted!.numeratorUnit,
        DENOMINATOR_UNIT_MESSAGES_ALL,
        "C: numerator becomes message grain",
      );
      assert.equal(
        converted!.frontTotalMessages,
        200,
        "C: denominator = inbound(120) + outbound(80), not the old conv count",
      );
      assert.equal(
        converted!.denominatorSource,
        DENOMINATOR_SOURCE_ANALYTICS,
        "C: denominator source restamped to the per-direction Analytics sum",
      );

      const stayed = await getExistingMonth(Mstay.label);
      assert.equal(
        stayed!.denominatorUnit,
        DENOMINATOR_UNIT_CONVERSATIONS_ALL,
        "C: row WITHOUT direction data stays conversation grain",
      );
      assert.equal(
        stayed!.frontTotalMessages,
        300,
        "C: untouched denominator stays the conversation count",
      );

      // Idempotent — a second pass keeps the converted row message-grain.
      await recomputeAllMonths({ frontPullsBudget: 0 });
      const converted2 = await getExistingMonth(Mconvert.label);
      assert.equal(
        converted2!.denominatorUnit,
        DENOMINATOR_UNIT_MESSAGES_ALL,
        "C: conversion is idempotent (stays message grain on re-run)",
      );
      assert.equal(
        converted2!.frontTotalMessages,
        200,
        "C: denominator stays the message sum on re-run",
      );
    } finally {
      __frontAnalyticsClientTestHelpers.setSearchFallbackOverride(null);
    }
  }

  await cleanupTestRows();
  console.log("PASS — Front coverage message-grain everywhere (Task #2290)");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
