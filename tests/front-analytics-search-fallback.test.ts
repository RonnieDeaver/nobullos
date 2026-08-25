/* test-registration
{
  "name": "Front Analytics search-API fallback (Task #1681)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.5s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1681 — Front Analytics search-API fallback for plan-limited months.
 *
 * Pins:
 *   1. `isPlanLimitSnippet` classifies the literal Front phrase.
 *   2. `submitReport` raises `front_analytics_plan_limited` (not auth_failed)
 *      when the response is 403 + plan-retention phrase.
 *   3. `refreshMonth` falls back to the search API on plan_limited and
 *      persists `denominator_source='search_conversations'` +
 *      `denominator_unit='inbound_conversations'` +
 *      `analytics_plan_limited_at = now`.
 *   4. Within the plan-limit TTL the worker skips Analytics entirely
 *      and goes straight to the search fallback.
 *   5. Once the TTL is stale, the worker re-probes Analytics; a
 *      successful Analytics pull clears the plan-limit memo and
 *      restores `denominator_source='analytics_reports'`.
 *   6. Real 403 auth failures (NOT plan-limited) still classify as
 *      `front_analytics_auth_failed` and DO NOT trigger the fallback.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  __frontAnalyticsClientTestHelpers,
  FrontAnalyticsError,
  isPlanLimitSnippet,
  isTransportLevelFetchError,
  pullMonthlyMessageCountViaSearchFallback,
  SEARCH_FALLBACK_MAX_429_RETRIES,
  SEARCH_FALLBACK_MAX_5XX_RETRIES,
  SEARCH_FALLBACK_MAX_TRANSPORT_RETRIES,
  type MonthlyMetricResult,
  type SearchFallbackResult,
} from "../server/services/frontAnalyticsClient";
import {
  refreshMonth,
  getExistingMonth,
  isUnrecoverableErrorCode,
  shouldReEvaluateMisclassifiedUnrecoverable,
  SETTING_ADOPTION_DATE,
  SETTING_REFRESH_ENABLED,
  DENOMINATOR_SOURCE_ANALYTICS,
  DENOMINATOR_SOURCE_SEARCH,
  DENOMINATOR_UNIT_MESSAGES,
  DENOMINATOR_UNIT_CONVERSATIONS_ALL,
  PLAN_LIMIT_REPROBE_TTL_MS,
  __setAnalyticsForceRefreshOverrideForTest,
} from "../server/services/frontAnalyticsCoverage";
import { FrontAuthError } from "../server/services/frontIntegration";

const FUTURE_YEAR = 2996;

function utcMonth(year: number, mIdx: number): { start: Date; end: Date; label: string } {
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

async function withSettingsBackup<T>(
  keys: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | null>();
  for (const k of keys) {
    const row = await storage.getSystemSetting(k).catch(() => null);
    saved.set(k, row?.value ?? null);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved.entries()) {
      if (v === null) {
        await storage.deleteSystemSetting(k);
      } else {
        await storage.setSystemSetting(k, v, "system");
      }
    }
  }
}

async function main(): Promise<void> {
  await cleanupTestRows();

  // ── 1. isPlanLimitSnippet classification ─────────────────────────
  {
    assert.equal(
      isPlanLimitSnippet(
        '{"_error":{"status":403,"message":"Your plan does not give you access to that time period"}}',
      ),
      true,
    );
    assert.equal(isPlanLimitSnippet("Plan doesn't give you access"), true);
    assert.equal(
      isPlanLimitSnippet('{"_error":{"message":"Missing analytics:read scope"}}'),
      false,
    );
    assert.equal(isPlanLimitSnippet(""), false);
    assert.equal(isPlanLimitSnippet(null), false);
    assert.equal(isPlanLimitSnippet(undefined), false);
  }

  // ── 2. isUnrecoverableErrorCode treats plan_limited as recoverable
  {
    assert.equal(
      isUnrecoverableErrorCode("front_analytics_plan_limited", 403),
      false,
      "plan-limited must NOT be unrecoverable — search fallback handles it",
    );
    assert.equal(
      isUnrecoverableErrorCode("front_analytics_auth_failed", 403),
      true,
      "real auth failure stays unrecoverable",
    );
  }

  await withSettingsBackup(
    [SETTING_ADOPTION_DATE, SETTING_REFRESH_ENABLED],
    async () => {
      // Pin the global refresh master ON. A SIGKILL'd sibling suite can
      // leave `front_analytics_refresh_enabled=false` durable in the
      // shared dev DB (Task #2366); without this pin `runCoverageRefreshTick`
      // would short-circuit and this suite's pull assertions would flake.
      // Enforced by `lint-test-shared-setting-pinning`.
      await storage.setSystemSetting(SETTING_REFRESH_ENABLED, "true", "test");
      // Track Analytics pulls + search fallbacks via scripted queues.
      const analyticsScript: Array<
        { kind: "ok"; value: number } | { kind: "throw"; err: Error }
      > = [];
      const searchScript: Array<
        | { kind: "ok"; count: number; truncated?: boolean }
        | { kind: "throw"; err: Error }
      > = [];
      let analyticsCalls = 0;
      let searchCalls = 0;

      __frontAnalyticsClientTestHelpers.setPullOverride(async () => {
        analyticsCalls += 1;
        const next = analyticsScript.shift();
        if (!next) throw new Error("test: analytics script empty");
        if (next.kind === "throw") throw next.err;
        return {
          reportId: `rpt-${analyticsCalls}`,
          value: next.value,
          status: "done",
          metric: "num_messages_received",
        } as MonthlyMetricResult;
      });
      __frontAnalyticsClientTestHelpers.setSearchFallbackOverride(async () => {
        searchCalls += 1;
        const next = searchScript.shift();
        if (!next) throw new Error("test: search script empty");
        if (next.kind === "throw") throw next.err;
        return {
          count: next.count,
          source: "search_conversations",
          unit: "conversations_all",
          pagesFetched: Math.ceil(next.count / 100) || 1,
          frontTotalHint: null,
          truncated: !!next.truncated,
        } as SearchFallbackResult;
      });

      try {
        // ── 3. refreshMonth: plan-limited 403 → search fallback ─────
        const m = utcMonth(FUTURE_YEAR, 6); // YYYY-07
        const t0 = new Date(Date.UTC(FUTURE_YEAR, 6, 15, 12, 0, 0));

        analyticsScript.push({
          kind: "throw",
          err: new FrontAnalyticsError(
            "front_analytics_plan_limited",
            "Front analytics submit plan-limited (403): plan does not give you access",
            403,
          ),
        });
        searchScript.push({ kind: "ok", count: 1234 });

        const r1 = await refreshMonth({
          month: m.label,
          monthStart: m.start,
          monthEnd: m.end,
          isCurrentMonth: false,
          now: t0,
        });
        assert.equal(r1.outcome, "ok_search_fallback");
        assert.equal(r1.denominatorSource, DENOMINATOR_SOURCE_SEARCH);
        assert.equal(r1.denominatorUnit, DENOMINATOR_UNIT_CONVERSATIONS_ALL);
        assert.equal(r1.frontTotalMessages, 1234);

        const row1 = await getExistingMonth(m.label);
        assert.ok(row1);
        assert.equal(row1!.denominatorSource, DENOMINATOR_SOURCE_SEARCH);
        assert.equal(row1!.denominatorUnit, DENOMINATOR_UNIT_CONVERSATIONS_ALL);
        assert.equal(row1!.frontTotalMessages, 1234);
        assert.equal(row1!.unrecoverable, false);
        assert.ok(row1!.analyticsPlanLimitedAt, "plan-limit memo stamped");
        assert.equal(row1!.frontAnalyticsError, null);
        assert.equal(row1!.frontAnalyticsStatus, "search");
        assert.equal(row1!.isFinalizedMonth, true);

        // ── 4. Within TTL, worker skips Analytics entirely ──────────
        const analyticsCallsBefore = analyticsCalls;
        const searchCallsBefore = searchCalls;
        searchScript.push({ kind: "ok", count: 1240 });
        // Same day → memo well within TTL. Use a fresh `now` slightly later.
        const t1 = new Date(t0.getTime() + 60_000);
        // Force re-attempt by clearing isFinalized via stale memo? No —
        // we want to assert the within-TTL skip. We need the row to NOT
        // be skipped via the "finalized" early-return. So we use the
        // operator-style call: simulate the manual refresh-month flow
        // which always proceeds (isCurrentMonth=false but we want it to
        // still attempt). The "skipped_existing_finalized" branch
        // returns immediately when memo is fresh AND row is finalized,
        // which is the *desired* prod behavior. Assert that here:
        const r2 = await refreshMonth({
          month: m.label,
          monthStart: m.start,
          monthEnd: m.end,
          isCurrentMonth: false,
          now: t1,
        });
        assert.equal(
          r2.outcome,
          "skipped_existing_finalized",
          "within-TTL finalized-via-search row must be skipped",
        );
        assert.equal(
          analyticsCalls,
          analyticsCallsBefore,
          "Analytics MUST NOT be called for within-TTL plan-limited row",
        );
        assert.equal(
          searchCalls,
          searchCallsBefore,
          "Search MUST NOT be called either (skipped-finalized short-circuit)",
        );
        searchScript.shift(); // un-consume the unused script entry

        // 4b. If the row were NOT finalized (e.g. an error row), the
        // within-TTL memo would short-circuit Analytics. Simulate by
        // forcibly de-finalizing.
        await db.execute(sql`
          UPDATE front_analytics_monthly_coverage
          SET is_finalized_month = false, front_analytics_error = 'simulated retriable error'
          WHERE month = ${m.label}
        `);
        searchScript.push({ kind: "ok", count: 1250 });
        const r2b = await refreshMonth({
          month: m.label,
          monthStart: m.start,
          monthEnd: m.end,
          isCurrentMonth: false,
          now: t1,
        });
        assert.equal(r2b.outcome, "ok_search_fallback");
        assert.equal(
          analyticsCalls,
          analyticsCallsBefore,
          "Within-TTL plan-limit memo must skip Analytics submit",
        );
        assert.equal(searchCalls, searchCallsBefore + 1);

        // ── 5. After TTL is stale, Analytics is re-probed and a
        //       successful pull clears the memo. ───────────────────────
        const tStale = new Date(t0.getTime() + PLAN_LIMIT_REPROBE_TTL_MS + 60_000);
        analyticsScript.push({ kind: "ok", value: 9999 });

        const r3 = await refreshMonth({
          month: m.label,
          monthStart: m.start,
          monthEnd: m.end,
          isCurrentMonth: false,
          now: tStale,
        });
        assert.equal(r3.outcome, "ok");
        assert.equal(r3.denominatorSource, DENOMINATOR_SOURCE_ANALYTICS);
        assert.equal(r3.denominatorUnit, DENOMINATOR_UNIT_MESSAGES);
        assert.equal(r3.frontTotalMessages, 9999);

        const row3 = await getExistingMonth(m.label);
        assert.equal(row3!.denominatorSource, DENOMINATOR_SOURCE_ANALYTICS);
        assert.equal(row3!.denominatorUnit, DENOMINATOR_UNIT_MESSAGES);
        assert.equal(
          row3!.analyticsPlanLimitedAt,
          null,
          "successful Analytics pull MUST clear the plan-limit memo",
        );
        assert.equal(row3!.frontTotalMessages, 9999);

        // ── 6. Real auth_failed (NOT plan-limited) MUST NOT trigger
        //       the search fallback. ──────────────────────────────────
        const m2 = utcMonth(FUTURE_YEAR, 7); // YYYY-08
        const searchBefore = searchCalls;
        const analyticsCallsBeforeAuthFail = analyticsCalls;
        // `pullAnalyticsWithAuthRetry` force-refreshes the Front token and
        // re-pulls exactly once on a `front_analytics_auth_failed` whenever
        // the auth breaker is closed (it gates on the error CODE, not the
        // 401-vs-403 status). The forced refresh is scripted via
        // `__setAnalyticsForceRefreshOverrideForTest` to succeed, so the
        // inline retry ALWAYS fires — no live Front OAuth call, no
        // dependence on leftover token freshness, and no risk of tripping
        // the auth-dead breaker mid-sweep. Script BOTH attempts to the
        // same 403 so the outcome is `auth_failed`.
        let forcedRefreshes = 0;
        __setAnalyticsForceRefreshOverrideForTest(async () => {
          forcedRefreshes += 1;
        });
        const authFailErr = () =>
          new FrontAnalyticsError(
            "front_analytics_auth_failed",
            "Front analytics submit auth failed (403): missing analytics:read scope",
            403,
          );
        analyticsScript.push({ kind: "throw", err: authFailErr() });
        analyticsScript.push({ kind: "throw", err: authFailErr() });
        const r4 = await refreshMonth({
          month: m2.label,
          monthStart: m2.start,
          monthEnd: m2.end,
          isCurrentMonth: false,
          now: t0,
        });
        assert.equal(
          forcedRefreshes,
          1,
          "scripted (stubbed) force-refresh fired exactly once — never the live Front OAuth path",
        );
        assert.equal(
          analyticsCalls,
          analyticsCallsBeforeAuthFail + 2,
          "successful scripted refresh makes the inline retry fire deterministically",
        );
        assert.equal(r4.outcome, "front_error");
        assert.equal(r4.errorCode, "front_analytics_auth_failed");
        assert.equal(r4.unrecoverable, true);
        assert.equal(
          searchCalls,
          searchBefore,
          "real auth failure MUST NOT trigger search fallback",
        );

        // ── 7. Search fallback failure persists the error but does
        //       NOT mark the row unrecoverable. ──────────────────────
        const m3 = utcMonth(FUTURE_YEAR, 8); // YYYY-09
        analyticsScript.push({
          kind: "throw",
          err: new FrontAnalyticsError(
            "front_analytics_plan_limited",
            "Front analytics submit plan-limited (403): plan does not give you access",
            403,
          ),
        });
        searchScript.push({
          kind: "throw",
          err: new FrontAnalyticsError(
            "front_analytics_search_failed",
            "Front search failed (502): bad gateway",
            502,
          ),
        });
        const r5 = await refreshMonth({
          month: m3.label,
          monthStart: m3.start,
          monthEnd: m3.end,
          isCurrentMonth: false,
          now: t0,
        });
        assert.equal(r5.outcome, "front_error");
        assert.equal(r5.errorCode, "front_analytics_search_failed");
        assert.equal(
          r5.unrecoverable,
          false,
          "search fallback transport failure stays retriable",
        );
        const row5 = await getExistingMonth(m3.label);
        assert.ok(row5!.analyticsPlanLimitedAt, "memo still stamped on search failure");
        assert.equal(row5!.unrecoverable, false);

        // ── 8. Truncated search fallback flags the row but still
        //       persists the (capped) count. ───────────────────────────
        const m4 = utcMonth(FUTURE_YEAR, 9); // YYYY-10
        analyticsScript.push({
          kind: "throw",
          err: new FrontAnalyticsError(
            "front_analytics_plan_limited",
            "Front analytics submit plan-limited (403): plan does not give you access",
            403,
          ),
        });
        searchScript.push({ kind: "ok", count: 20_000, truncated: true });
        const r6 = await refreshMonth({
          month: m4.label,
          monthStart: m4.start,
          monthEnd: m4.end,
          isCurrentMonth: false,
          now: t0,
        });
        assert.equal(r6.outcome, "ok_search_fallback");
        assert.equal(r6.frontTotalMessages, 20_000);
        const row6 = await getExistingMonth(m4.label);
        assert.equal(row6!.frontAnalyticsStatus, "search_truncated");
        assert.ok(
          row6!.frontAnalyticsError?.startsWith("search_truncated"),
          `expected search_truncated marker, got: ${row6!.frontAnalyticsError}`,
        );

        // ── Task #1780 — manual `forceRerun: true` + `forceSearchFallback`
        //    on a clean finalized row must bypass the
        //    skipped_existing_finalized short-circuit and run the
        //    Search fallback, producing a fresh `ok_search_fallback`
        //    outcome with the search denominator source. ──────────────
        const m5 = utcMonth(FUTURE_YEAR, 10); // YYYY-11
        // Seed a clean finalized Analytics-sourced row first.
        analyticsScript.push({ kind: "ok", value: 7777 });
        const seedAnalytics = await refreshMonth({
          month: m5.label,
          monthStart: m5.start,
          monthEnd: m5.end,
          isCurrentMonth: false,
          now: t0,
        });
        assert.equal(seedAnalytics.outcome, "ok");
        const seededRow = await getExistingMonth(m5.label);
        assert.equal(seededRow!.isFinalizedMonth, true);
        assert.equal(seededRow!.denominatorSource, DENOMINATOR_SOURCE_ANALYTICS);

        // Same-day worker tick on this clean row would short-circuit;
        // confirm baseline first.
        const baselineTick = await refreshMonth({
          month: m5.label,
          monthStart: m5.start,
          monthEnd: m5.end,
          isCurrentMonth: false,
          now: t0,
        });
        assert.equal(
          baselineTick.outcome,
          "skipped_existing_finalized",
          "baseline: worker tick still skips clean finalized rows",
        );

        // Operator clicks Retry (search) — forceRerun + forceSearchFallback.
        searchScript.push({ kind: "ok", count: 4242 });
        const forceSearch = await refreshMonth({
          month: m5.label,
          monthStart: m5.start,
          monthEnd: m5.end,
          isCurrentMonth: false,
          now: t0,
          forceRerun: true,
          forceSearchFallback: true,
        });
        assert.equal(forceSearch.outcome, "ok_search_fallback");
        assert.equal(forceSearch.denominatorSource, DENOMINATOR_SOURCE_SEARCH);
        assert.equal(forceSearch.frontTotalMessages, 4242);
        assert.equal(forceSearch.frontAnalyticsStatus, "search");
        assert.ok(forceSearch.pulledAt, "pulledAt surfaced for UI");

        // ── Task #1780 — Re-probe path: forceRerun: true on a clean
        //    finalized Analytics-sourced row produces a fresh outcome
        //    (operator can force a re-pull even if the row looks clean).
        const m6 = utcMonth(FUTURE_YEAR, 11); // YYYY-12
        analyticsScript.push({ kind: "ok", value: 1111 });
        const seedM6 = await refreshMonth({
          month: m6.label,
          monthStart: m6.start,
          monthEnd: m6.end,
          isCurrentMonth: false,
          now: t0,
        });
        assert.equal(seedM6.outcome, "ok");
        const baselineM6 = await refreshMonth({
          month: m6.label,
          monthStart: m6.start,
          monthEnd: m6.end,
          isCurrentMonth: false,
          now: t0,
        });
        assert.equal(baselineM6.outcome, "skipped_existing_finalized");
        analyticsScript.push({ kind: "ok", value: 2222 });
        const reprobe = await refreshMonth({
          month: m6.label,
          monthStart: m6.start,
          monthEnd: m6.end,
          isCurrentMonth: false,
          now: t0,
          forceRerun: true,
        });
        assert.equal(reprobe.outcome, "ok");
        assert.equal(reprobe.frontTotalMessages, 2222);
        assert.equal(reprobe.denominatorSource, DENOMINATOR_SOURCE_ANALYTICS);
      } finally {
        __frontAnalyticsClientTestHelpers.setPullOverride(null);
        __frontAnalyticsClientTestHelpers.setSearchFallbackOverride(null);
        __setAnalyticsForceRefreshOverrideForTest(null);
        await cleanupTestRows();
      }
    },
  );

  // ── 9. Bounded 429 retry budget — repeated 429s on a single page
  //       MUST exit with a typed `front_analytics_rate_limited` error
  //       instead of looping forever. This pins the fix for the
  //       reliability bug surfaced in review of Task #1681. ───────────
  {
    let fetchCalls = 0;
    const fakeFetch = async (_url: string): Promise<Response> => {
      fetchCalls += 1;
      // Always 429 with a tiny retry-after so the test is fast but the
      // sleep path is exercised. POLL_MAX_DELAY_MS caps the sleep so a
      // hostile Retry-After can't slow us down either.
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0.001" },
      });
    };

    let caught: unknown = null;
    try {
      await pullMonthlyMessageCountViaSearchFallback({
        monthStart: new Date(Date.UTC(2025, 6, 1)),
        monthEnd: new Date(Date.UTC(2025, 7, 1)),
        fetcher: fakeFetch,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught instanceof FrontAnalyticsError,
      `expected FrontAnalyticsError on bounded 429, got: ${caught}`,
    );
    assert.equal((caught as FrontAnalyticsError).code, "front_analytics_rate_limited");
    assert.equal((caught as FrontAnalyticsError).status, 429);
    // Budget is N retries → N+1 fetches before the throw.
    assert.equal(
      fetchCalls,
      SEARCH_FALLBACK_MAX_429_RETRIES + 1,
      `expected exactly ${SEARCH_FALLBACK_MAX_429_RETRIES + 1} fetches, got ${fetchCalls}`,
    );
    // Confirm it's NOT classified as unrecoverable so the coverage row
    // stays retriable on the next worker tick.
    assert.equal(
      isUnrecoverableErrorCode("front_analytics_rate_limited", 429),
      false,
      "rate-limited fallback must stay retriable",
    );
  }

  // ── 10. Task #1709: search-fallback query no longer ships `is:inbound`,
  //        which Front rejects with `400 Unsupported search modifier
  //        provided`. The corrected query only carries the
  //        `after:<unix> before:<unix>` half-open window. ──────────────
  {
    const capturedUrls: string[] = [];
    const fakeFetch = async (url: string): Promise<Response> => {
      capturedUrls.push(url);
      return new Response(
        JSON.stringify({
          _results: [],
          _pagination: { next: null },
          _total: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await pullMonthlyMessageCountViaSearchFallback({
      monthStart: new Date(Date.UTC(2025, 6, 1)),
      monthEnd: new Date(Date.UTC(2025, 7, 1)),
      fetcher: fakeFetch,
    });

    assert.equal(capturedUrls.length, 1, "expected exactly one fetch");
    const url = capturedUrls[0]!;
    const decoded = decodeURIComponent(url);
    assert.ok(
      !decoded.includes("is:inbound"),
      `query must NOT contain is:inbound (Front rejects it): ${decoded}`,
    );
    assert.ok(
      !decoded.includes("is:outbound"),
      `query must not contain is:outbound either: ${decoded}`,
    );
    const afterUnix = Math.floor(Date.UTC(2025, 6, 1) / 1000);
    const beforeUnix = Math.floor(Date.UTC(2025, 7, 1) / 1000);
    assert.ok(
      decoded.includes(`after:${afterUnix}`),
      `query must include after:${afterUnix}: ${decoded}`,
    );
    assert.ok(
      decoded.includes(`before:${beforeUnix}`),
      `query must include before:${beforeUnix}: ${decoded}`,
    );
  }

  // ── 11. Task #1709: the response-body snippet read by submitReport
  //        survives the envelope-wrapped 403 from Front so
  //        `isPlanLimitSnippet` can still detect the plan-history
  //        phrase. This is the regression that left 2025-07..10
  //        stuck on `front_analytics_auth_failed` + unrecoverable. ─
  {
    // Simulated production body: heavy envelope padding before the
    // `message` so the plan-history phrase lands well past the old
    // 200-char cap. The bumped cap (>= ~1 KB) must still capture it.
    const envelopedBody = JSON.stringify({
      _error: {
        status: 403,
        code: "forbidden",
        title: "Forbidden",
        more_info: "https://dev.frontapp.com/docs/errors-1",
        documentation_url:
          "https://dev.frontapp.com/reference/analytics-overview",
        request_id: "req_" + "x".repeat(80),
        message:
          "Your plan does not give you access to that time period.",
      },
    });
    const phraseAt = envelopedBody.indexOf("plan does not give you access");
    assert.ok(
      phraseAt > 200,
      `setup sanity: phrase must sit past 200 chars (got ${phraseAt})`,
    );
    assert.ok(
      __frontAnalyticsClientTestHelpers.bodySnippetMaxChars >= phraseAt + 40,
      `bodySnippetMaxChars (${__frontAnalyticsClientTestHelpers.bodySnippetMaxChars}) must cover the phrase position (${phraseAt})`,
    );

    const res = new Response(envelopedBody, {
      status: 403,
      headers: { "content-type": "application/json" },
    });
    const snippet =
      await __frontAnalyticsClientTestHelpers.safeReadBodySnippet(res);
    assert.ok(
      snippet.length > 0,
      "snippet must not be empty for a 403 body",
    );
    assert.equal(
      isPlanLimitSnippet(snippet),
      true,
      `enveloped 403 snippet must classify as plan-limited: ${snippet}`,
    );
  }

  // ── 12. Task #1709: a genuine missing-scope 403 (no plan phrase)
  //        does NOT trip the plan-limit detector even when wrapped
  //        in the same envelope. The error code stays auth_failed
  //        and remains unrecoverable so the worker stops retrying. ─
  {
    const scopeBody = JSON.stringify({
      _error: {
        status: 403,
        code: "forbidden",
        title: "Forbidden",
        message: "Missing scope analytics:read.",
      },
    });
    const res = new Response(scopeBody, {
      status: 403,
      headers: { "content-type": "application/json" },
    });
    const snippet =
      await __frontAnalyticsClientTestHelpers.safeReadBodySnippet(res);
    assert.equal(
      isPlanLimitSnippet(snippet),
      false,
      `non-plan 403 must NOT match plan-limit detector: ${snippet}`,
    );
    assert.equal(
      isUnrecoverableErrorCode("front_analytics_auth_failed", 403),
      true,
    );
  }

  // ── 13. Task #1709: shouldReEvaluateMisclassifiedUnrecoverable
  //        re-arms rows stamped auth_failed+unrecoverable=true whose
  //        stored error text now matches the broadened plan-limit
  //        detector, and leaves legitimate auth failures alone. ─────
  {
    const base = {
      id: 0,
      month: "2025-07",
      monthStart: new Date(Date.UTC(2025, 6, 1)),
      monthEnd: new Date(Date.UTC(2025, 7, 1)),
      isFinalizedMonth: true,
      pulledAt: new Date(),
      frontAnalyticsValue: null,
      frontAnalyticsReportId: null,
      analyticsPlanLimitedAt: null,
      denominatorSource: null,
      denominatorUnit: null,
      searchPagesFetched: null,
      searchTotalHint: null,
      truncated: false,
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;

    // Misclassified row — envelope body containing the literal phrase.
    const misclassified = {
      ...base,
      unrecoverable: true,
      frontAnalyticsError:
        'front_analytics_auth_failed: Front analytics submit failed (403): {"_error":{"status":403,"message":"Your plan does not give you access to that time period."}}',
    };
    assert.equal(
      shouldReEvaluateMisclassifiedUnrecoverable(misclassified),
      true,
      "misclassified plan-history row must re-arm",
    );

    // Legitimate missing-scope failure — same error code, different body.
    const legitimateAuthFail = {
      ...base,
      unrecoverable: true,
      frontAnalyticsError:
        "front_analytics_auth_failed: Front analytics submit failed (403): Missing scope analytics:read.",
    };
    assert.equal(
      shouldReEvaluateMisclassifiedUnrecoverable(legitimateAuthFail),
      false,
      "real auth failure must stay unrecoverable",
    );

    // Healthy row — not unrecoverable at all.
    assert.equal(
      shouldReEvaluateMisclassifiedUnrecoverable({
        ...base,
        unrecoverable: false,
        frontAnalyticsError: null,
      }),
      false,
    );

    // Unrecoverable for a different reason (report_failed 4xx).
    assert.equal(
      shouldReEvaluateMisclassifiedUnrecoverable({
        ...base,
        unrecoverable: true,
        frontAnalyticsError:
          "front_analytics_report_failed: 404 not found",
      }),
      false,
      "non-auth_failed unrecoverable rows must not be re-armed",
    );

    assert.equal(shouldReEvaluateMisclassifiedUnrecoverable(undefined), false);
  }

  // ── 14. Task #1767: bounded 5xx retry — transient 503 then 200
  //        on the same page MUST succeed instead of poisoning the row.
  //        Pins the primary fix for the stuck plan-limited months. ─
  {
    let calls = 0;
    const sleeps: number[] = [];
    const fakeFetch = async (_url: string): Promise<Response> => {
      calls += 1;
      // First call: transient 503. Second: 200 with empty page.
      if (calls === 1) {
        return new Response("service unavailable", {
          status: 503,
          headers: { "retry-after": "0.001" },
        });
      }
      return new Response(
        JSON.stringify({ _results: [], _pagination: { next: null }, _total: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await pullMonthlyMessageCountViaSearchFallback({
      monthStart: new Date(Date.UTC(2025, 6, 1)),
      monthEnd: new Date(Date.UTC(2025, 7, 1)),
      fetcher: fakeFetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(calls, 2, "expected one retry after 503");
    assert.equal(sleeps.length, 1, "expected exactly one backoff sleep");
    assert.equal(result.count, 0);
    assert.equal(result.source, "search_conversations");
  }

  // ── 15. Task #1767: 5xx retry budget exhaustion — repeated 503
  //        beyond the budget MUST throw front_analytics_search_failed
  //        with status/body snippet, and stay retriable
  //        (unrecoverable=false). ───────────────────────────────────
  {
    let calls = 0;
    const fakeFetch = async (_url: string): Promise<Response> => {
      calls += 1;
      return new Response("upstream gateway timeout", {
        status: 504,
      });
    };

    let caught: unknown = null;
    try {
      await pullMonthlyMessageCountViaSearchFallback({
        monthStart: new Date(Date.UTC(2025, 6, 1)),
        monthEnd: new Date(Date.UTC(2025, 7, 1)),
        fetcher: fakeFetch,
        sleep: async () => {},
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught instanceof FrontAnalyticsError,
      `expected FrontAnalyticsError on exhausted 5xx, got: ${caught}`,
    );
    const fe = caught as FrontAnalyticsError;
    assert.equal(fe.code, "front_analytics_search_failed");
    assert.equal(fe.status, 504);
    assert.match(
      fe.message,
      /504/,
      `terminal 5xx message must include status: ${fe.message}`,
    );
    assert.match(
      fe.message,
      /upstream gateway timeout/,
      `terminal 5xx message must include body snippet: ${fe.message}`,
    );
    assert.match(
      fe.message,
      new RegExp(`${SEARCH_FALLBACK_MAX_5XX_RETRIES} 5xx retries`),
      `terminal 5xx message must call out the retry budget: ${fe.message}`,
    );
    // Budget is N retries → N+1 fetches before the throw.
    assert.equal(
      calls,
      SEARCH_FALLBACK_MAX_5XX_RETRIES + 1,
      `expected exactly ${SEARCH_FALLBACK_MAX_5XX_RETRIES + 1} fetches, got ${calls}`,
    );
    // The failure stays retriable so the worker re-tries on next tick.
    assert.equal(
      isUnrecoverableErrorCode("front_analytics_search_failed", 504),
      false,
      "transient-exhausted search failure must stay retriable",
    );
  }

  // ── 16. Task #1767: terminal 4xx (non-401/403/429) — no retry,
  //        immediate front_analytics_search_failed with status+body. ─
  {
    let calls = 0;
    const fakeFetch = async (_url: string): Promise<Response> => {
      calls += 1;
      return new Response('{"_error":{"message":"bad query"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };

    let caught: unknown = null;
    try {
      await pullMonthlyMessageCountViaSearchFallback({
        monthStart: new Date(Date.UTC(2025, 6, 1)),
        monthEnd: new Date(Date.UTC(2025, 7, 1)),
        fetcher: fakeFetch,
        sleep: async () => {
          assert.fail("terminal 4xx must not sleep / retry");
        },
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof FrontAnalyticsError);
    const fe = caught as FrontAnalyticsError;
    assert.equal(fe.code, "front_analytics_search_failed");
    assert.equal(fe.status, 400);
    assert.match(fe.message, /400/, `expected status in message: ${fe.message}`);
    assert.match(fe.message, /bad query/, `expected body snippet: ${fe.message}`);
    assert.equal(calls, 1, "terminal 4xx must not retry");
  }

  // ── 17. Task #1767: 429 path is unchanged by the 5xx retry. A
  //        429-only page still surfaces front_analytics_rate_limited
  //        after exhausting the existing 429 budget. ─────────────────
  {
    let calls = 0;
    const fakeFetch = async (_url: string): Promise<Response> => {
      calls += 1;
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0.001" },
      });
    };
    let caught: unknown = null;
    try {
      await pullMonthlyMessageCountViaSearchFallback({
        monthStart: new Date(Date.UTC(2025, 6, 1)),
        monthEnd: new Date(Date.UTC(2025, 7, 1)),
        fetcher: fakeFetch,
        sleep: async () => {},
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof FrontAnalyticsError);
    assert.equal(
      (caught as FrontAnalyticsError).code,
      "front_analytics_rate_limited",
      "429 budget must classify as rate_limited (not search_failed)",
    );
    assert.equal(
      calls,
      SEARCH_FALLBACK_MAX_429_RETRIES + 1,
      `429 budget unchanged: expected ${SEARCH_FALLBACK_MAX_429_RETRIES + 1} calls, got ${calls}`,
    );
  }

  // ── 18. Task #1767: pagination retry-budget reset — page 1 success,
  //        page 2 transient 503 → 200, page 3 success. Final count
  //        includes all pages; one transient blip must NOT poison the
  //        full month. ────────────────────────────────────────────────
  {
    const responses: Array<() => Response> = [
      // Page 1: 50 results, next URL → page 2.
      () =>
        new Response(
          JSON.stringify({
            _results: new Array(50).fill({}),
            _pagination: { next: "https://api2.frontapp.com/page2" },
            _total: 150,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      // Page 2 attempt 1: transient 503.
      () =>
        new Response("temporarily unavailable", {
          status: 503,
          headers: { "retry-after": "0.001" },
        }),
      // Page 2 attempt 2: 50 results, next URL → page 3.
      () =>
        new Response(
          JSON.stringify({
            _results: new Array(50).fill({}),
            _pagination: { next: "https://api2.frontapp.com/page3" },
            _total: 150,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      // Page 3: 50 results, end of pagination.
      () =>
        new Response(
          JSON.stringify({
            _results: new Array(50).fill({}),
            _pagination: { next: null },
            _total: 150,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ];
    let idx = 0;
    const fakeFetch = async (_url: string): Promise<Response> => {
      const resp = responses[idx]?.();
      idx += 1;
      if (!resp) throw new Error("test: no more scripted responses");
      return resp;
    };

    const result = await pullMonthlyMessageCountViaSearchFallback({
      monthStart: new Date(Date.UTC(2025, 6, 1)),
      monthEnd: new Date(Date.UTC(2025, 7, 1)),
      fetcher: fakeFetch,
      sleep: async () => {},
    });
    assert.equal(idx, 4, "expected 4 total fetches across the 3 pages");
    assert.equal(result.count, 150, "all three pages must accumulate");
    assert.equal(result.pagesFetched, 3, "transient retry does not count as a page");
    assert.equal(result.truncated, false);
  }

  // ── 19. Task #1767: 5xx budget resets after a successful page so
  //        late-pagination transient blips don't sum into earlier
  //        ones. Page 1 has 3 503s then 200, page 2 has 3 503s then
  //        200 (each within budget). Whole month succeeds. ──────────
  {
    let calls = 0;
    const responses: Array<() => Response> = [
      // Page 1: 3 transient 503s then success.
      () => new Response("x", { status: 503 }),
      () => new Response("x", { status: 503 }),
      () => new Response("x", { status: 503 }),
      () =>
        new Response(
          JSON.stringify({
            _results: new Array(10).fill({}),
            _pagination: { next: "https://api2.frontapp.com/page2" },
            _total: 20,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      // Page 2: again 3 transient 503s then success. If the budget
      // didn't reset, the 4th 503 across the run would exhaust.
      () => new Response("x", { status: 503 }),
      () => new Response("x", { status: 503 }),
      () => new Response("x", { status: 503 }),
      () =>
        new Response(
          JSON.stringify({
            _results: new Array(10).fill({}),
            _pagination: { next: null },
            _total: 20,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ];
    const fakeFetch = async (_url: string): Promise<Response> => {
      const resp = responses[calls]?.();
      calls += 1;
      if (!resp) throw new Error("test: no more scripted responses");
      return resp;
    };

    const result = await pullMonthlyMessageCountViaSearchFallback({
      monthStart: new Date(Date.UTC(2025, 6, 1)),
      monthEnd: new Date(Date.UTC(2025, 7, 1)),
      fetcher: fakeFetch,
      sleep: async () => {},
    });
    assert.equal(result.count, 20);
    assert.equal(result.pagesFetched, 2);
    // Sanity-check the budget actually resets: 3 503s per page is
    // within the per-page budget of SEARCH_FALLBACK_MAX_5XX_RETRIES,
    // so the second page must succeed too.
    assert.ok(SEARCH_FALLBACK_MAX_5XX_RETRIES >= 3);
  }

  // ── 20. Task #2743: bounded transport-abort retry — a transient
  //        fetch rejection (abort/timeout/ECONNRESET) then a 200 on the
  //        same page MUST succeed instead of poisoning the row. This is
  //        the primary fix for the Nov-2025 ceiling bug where a single
  //        aborted request latched a reachable month as a false plan-limit.
  {
    let calls = 0;
    const sleeps: number[] = [];
    const fakeFetch = async (_url: string): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        // Simulate `fetch` itself rejecting (AbortController timeout).
        const e = new Error("This operation was aborted");
        e.name = "AbortError";
        throw e;
      }
      return new Response(
        JSON.stringify({ _results: [], _pagination: { next: null }, _total: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await pullMonthlyMessageCountViaSearchFallback({
      monthStart: new Date(Date.UTC(2025, 6, 1)),
      monthEnd: new Date(Date.UTC(2025, 7, 1)),
      fetcher: fakeFetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(calls, 2, "expected one retry after the transport abort");
    assert.equal(sleeps.length, 1, "expected exactly one backoff sleep");
    assert.equal(result.count, 0);
    assert.equal(result.source, "search_conversations");
  }

  // ── 21. Task #2743: transport-retry budget exhaustion — a persistent
  //        transport abort MUST throw the RETRIABLE
  //        `front_analytics_transport_failed` (NOT the terminal
  //        `front_analytics_search_failed`), stay retriable
  //        (unrecoverable=false), and burn exactly budget+1 fetches. ─────
  {
    let calls = 0;
    const fakeFetch = async (_url: string): Promise<Response> => {
      calls += 1;
      const e = new Error("read ECONNRESET");
      (e as { code?: string }).code = "ECONNRESET";
      throw e;
    };

    let caught: unknown = null;
    try {
      await pullMonthlyMessageCountViaSearchFallback({
        monthStart: new Date(Date.UTC(2025, 6, 1)),
        monthEnd: new Date(Date.UTC(2025, 7, 1)),
        fetcher: fakeFetch,
        sleep: async () => {},
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught instanceof FrontAnalyticsError,
      `expected FrontAnalyticsError on exhausted transport retries, got: ${caught}`,
    );
    const fe = caught as FrontAnalyticsError;
    assert.equal(
      fe.code,
      "front_analytics_transport_failed",
      "persistent transport abort must be retriable, not terminal search_failed",
    );
    assert.match(
      fe.message,
      new RegExp(`${SEARCH_FALLBACK_MAX_TRANSPORT_RETRIES} retries`),
      `transport message must call out the retry budget: ${fe.message}`,
    );
    assert.match(
      fe.message,
      /ECONNRESET/,
      `transport message must include the underlying cause: ${fe.message}`,
    );
    assert.equal(
      calls,
      SEARCH_FALLBACK_MAX_TRANSPORT_RETRIES + 1,
      `expected exactly ${SEARCH_FALLBACK_MAX_TRANSPORT_RETRIES + 1} fetches, got ${calls}`,
    );
    // Must NOT be marked unrecoverable → row stays retriable next tick.
    assert.equal(
      isUnrecoverableErrorCode("front_analytics_transport_failed"),
      false,
      "exhausted transport abort must stay retriable (not unrecoverable)",
    );
  }

  // ── 22. Task #2743: transport-retry budget resets after a successful
  //        page so late-pagination transport blips don't sum into earlier
  //        ones. Page 1 has (budget) aborts then 200; page 2 has (budget)
  //        aborts then 200. If the budget didn't reset the run would fail. ─
  {
    let calls = 0;
    const abort = (): never => {
      throw new Error("This operation was aborted");
    };
    const responses: Array<() => Response> = [
      // Page 1: budget-many aborts then success.
      ...new Array(SEARCH_FALLBACK_MAX_TRANSPORT_RETRIES).fill(abort),
      () =>
        new Response(
          JSON.stringify({
            _results: new Array(10).fill({}),
            _pagination: { next: "https://api2.frontapp.com/page2" },
            _total: 20,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      // Page 2: again budget-many aborts then success.
      ...new Array(SEARCH_FALLBACK_MAX_TRANSPORT_RETRIES).fill(abort),
      () =>
        new Response(
          JSON.stringify({
            _results: new Array(10).fill({}),
            _pagination: { next: null },
            _total: 20,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ];
    const fakeFetch = async (_url: string): Promise<Response> => {
      // Advance the pointer BEFORE invoking so an aborting step (which throws)
      // still moves us forward — otherwise a synchronous throw would replay the
      // same abort forever and never reach the success response.
      const step = responses[calls];
      calls += 1;
      if (step === undefined) throw new Error("test: no more scripted responses");
      return step();
    };

    const result = await pullMonthlyMessageCountViaSearchFallback({
      monthStart: new Date(Date.UTC(2025, 6, 1)),
      monthEnd: new Date(Date.UTC(2025, 7, 1)),
      fetcher: fakeFetch,
      sleep: async () => {},
    });
    assert.equal(result.count, 20);
    assert.equal(result.pagesFetched, 2);
    assert.ok(SEARCH_FALLBACK_MAX_TRANSPORT_RETRIES >= 1);
  }

  // ── 23. Task #2743: a NON-transport throw from the fetcher (a terminal
  //        `FrontAuthError` raised by the token accessor BEFORE the HTTP
  //        round-trip) MUST propagate untouched — never retried, never
  //        wrapped as the retriable/reachable `front_analytics_transport_failed`.
  //        Otherwise a dead Front auth would masquerade as a reachable month. ─
  {
    let calls = 0;
    const fakeFetch = async (_url: string): Promise<Response> => {
      calls += 1;
      throw new FrontAuthError(
        "front_not_connected",
        "Front not connected. Please authorize via Settings → Integrations.",
      );
    };

    let caught: unknown = null;
    try {
      await pullMonthlyMessageCountViaSearchFallback({
        monthStart: new Date(Date.UTC(2025, 6, 1)),
        monthEnd: new Date(Date.UTC(2025, 7, 1)),
        fetcher: fakeFetch,
        sleep: async () => {
          assert.fail("terminal auth error must not sleep / retry");
        },
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "expected the auth error to propagate");
    assert.equal(
      caught instanceof FrontAnalyticsError &&
        caught.code === "front_analytics_transport_failed",
      false,
      "terminal auth failure must NOT be re-wrapped as transport_failed",
    );
    assert.ok(
      caught instanceof FrontAuthError &&
        (caught as FrontAuthError).code === "front_not_connected",
      `terminal auth error must propagate untouched, got: ${caught}`,
    );
    assert.equal(calls, 1, "terminal auth error must not be retried");
  }

  // ── 24. Task #2743: isTransportLevelFetchError allow-list — genuine
  //        fetch-level rejects are retriable; auth / analytics / plain
  //        errors are NOT (keeping terminal failures terminal). ─────────────
  {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    assert.equal(isTransportLevelFetchError(abort), true, "AbortError is transport");

    const reset = new Error("read ECONNRESET");
    (reset as { code?: string }).code = "ECONNRESET";
    assert.equal(isTransportLevelFetchError(reset), true, "ECONNRESET code is transport");

    const undiciNetwork = new TypeError("fetch failed");
    (undiciNetwork as { cause?: { code?: string } }).cause = { code: "UND_ERR_SOCKET" };
    assert.equal(
      isTransportLevelFetchError(undiciNetwork),
      true,
      "undici 'fetch failed' TypeError is transport",
    );

    assert.equal(
      isTransportLevelFetchError(
        new FrontAuthError("front_not_connected", "Front not connected."),
      ),
      false,
      "FrontAuthError is NOT transport",
    );
    assert.equal(
      isTransportLevelFetchError(
        new FrontAnalyticsError("front_analytics_auth_failed", "403 forbidden", 403),
      ),
      false,
      "FrontAnalyticsError is NOT transport",
    );
    assert.equal(
      isTransportLevelFetchError(new Error("bad query")),
      false,
      "a generic error with no transport signal is NOT transport",
    );
  }

  console.log("front-analytics-search-fallback.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
await main();
