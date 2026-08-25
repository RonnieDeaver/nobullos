/* test-registration
{
  "name": "Front live rate-limit header auto-pacing (Task #2721)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2721: the live rate-limit auto-pacing math + its wiring into the search/enumeration paging. It guards the proactive (pre-429) brake on the backfill so an aggressive per-tick budget can't starve other Front API consumers. Pure, fast, in-memory (no DB/network — fetcher/sleep/now seams).",
  "tier": "small"
}
test-registration */
/**
 * Task #2721 — Front live rate-limit header auto-pacing.
 *
 * Front returns its standard per-company rate-limit budget on every response
 * (`x-ratelimit-limit` / `x-ratelimit-remaining` / `x-ratelimit-reset`, the
 * last as epoch seconds — verified against https://dev.frontapp.com/docs/rate-limiting).
 * The backfill's enumeration / search paging reads those headers and slows
 * itself BEFORE hitting a 429, so an aggressive per-tick budget can't starve
 * other Front API consumers in the company.
 *
 * Pins:
 *   1. The pure pacing math (`computeRateLimitPaceMs`): full speed above the
 *      threshold, growing delay as `remaining` shrinks, wait-to-reset at zero,
 *      no-op when headers are absent, hard cap honored.
 *   2. Header parsing (`parseFrontRateLimitHeaders`) — case-insensitive, missing
 *      / non-numeric → null.
 *   3. The search fallback (`pullMonthlyMessageCountViaSearchFallback`) inserts
 *      an inter-page sleep that GROWS as the simulated remaining budget dwindles.
 *   4. The per-message enumeration walk
 *      (`enumerateMonthlyMessagesByDirectionTick`) self-paces the same way.
 *
 * Pure / fast: no DB, no network — drives the `fetcher` / `sleep` / `now` seams.
 */
import assert from "node:assert/strict";
import {
  computeRateLimitPaceMs,
  parseFrontRateLimitHeaders,
  RATE_LIMIT_PACING_ABSOLUTE_FLOOR,
  RATE_LIMIT_PACING_MAX_DELAY_MS,
  type FrontRateLimitSnapshot,
} from "../server/services/frontRateLimit";
import {
  pullMonthlyMessageCountViaSearchFallback,
  enumerateMonthlyMessagesByDirectionTick,
} from "../server/services/frontAnalyticsClient";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

// A fixed "now" so the epoch-seconds reset math is deterministic.
const NOW_MS = 1_700_000_000_000; // arbitrary fixed wall clock
const NOW_SEC = Math.floor(NOW_MS / 1000);

function jsonPage(body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function main(): Promise<void> {
  // ── 1. computeRateLimitPaceMs ────────────────────────────────────────
  {
    // No snapshot / absent remaining → no pacing.
    check(
      "null snapshot → 0",
      computeRateLimitPaceMs(null, NOW_MS) === 0,
    );
    check(
      "remaining null → 0",
      computeRateLimitPaceMs(
        { limit: 100, remaining: null, resetEpochSec: NOW_SEC + 60 },
        NOW_MS,
      ) === 0,
    );

    // Healthy budget (above the 20% threshold of limit) → full speed.
    check(
      "remaining well above threshold → 0",
      computeRateLimitPaceMs(
        { limit: 100, remaining: 80, resetEpochSec: NOW_SEC + 60 },
        NOW_MS,
      ) === 0,
    );

    // Low budget with a usable reset → spread remaining across time left.
    // 10s left / 10 remaining = 1000ms.
    const lowPace = computeRateLimitPaceMs(
      { limit: 100, remaining: 10, resetEpochSec: NOW_SEC + 10 },
      NOW_MS,
    );
    check("low budget pace = timeLeft/remaining (1000ms)", lowPace === 1000);

    // As remaining drops the per-request delay grows (same window).
    const pace10 = computeRateLimitPaceMs(
      { limit: 100, remaining: 10, resetEpochSec: NOW_SEC + 30 },
      NOW_MS,
    );
    const pace5 = computeRateLimitPaceMs(
      { limit: 100, remaining: 5, resetEpochSec: NOW_SEC + 30 },
      NOW_MS,
    );
    const pace2 = computeRateLimitPaceMs(
      { limit: 100, remaining: 2, resetEpochSec: NOW_SEC + 30 },
      NOW_MS,
    );
    check("pace grows as remaining shrinks", pace5 > pace10 && pace2 > pace5);

    // remaining === 0 → wait until reset (capped).
    check(
      "remaining 0 waits to reset (capped at max)",
      computeRateLimitPaceMs(
        { limit: 100, remaining: 0, resetEpochSec: NOW_SEC + 3 },
        NOW_MS,
      ) === 3000,
    );
    check(
      "remaining 0 + far reset clamps to max",
      computeRateLimitPaceMs(
        { limit: 100, remaining: 0, resetEpochSec: NOW_SEC + 9999 },
        NOW_MS,
      ) === RATE_LIMIT_PACING_MAX_DELAY_MS,
    );

    // Pace is capped even for a low-but-nonzero remaining with a far reset.
    check(
      "low remaining + far reset clamps to max",
      computeRateLimitPaceMs(
        { limit: 100, remaining: 1, resetEpochSec: NOW_SEC + 99999 },
        NOW_MS,
      ) === RATE_LIMIT_PACING_MAX_DELAY_MS,
    );

    // No limit header → falls back to the absolute floor (20). 25 > 20 → full
    // speed; 10 ≤ 20 → paces.
    check(
      "no limit, remaining above absolute floor → 0",
      computeRateLimitPaceMs(
        {
          limit: null,
          remaining: RATE_LIMIT_PACING_ABSOLUTE_FLOOR + 5,
          resetEpochSec: NOW_SEC + 10,
        },
        NOW_MS,
      ) === 0,
    );
    check(
      "no limit, remaining at/below absolute floor → paces",
      computeRateLimitPaceMs(
        { limit: null, remaining: 10, resetEpochSec: NOW_SEC + 10 },
        NOW_MS,
      ) > 0,
    );
  }

  // ── 2. parseFrontRateLimitHeaders ────────────────────────────────────
  {
    const res = new Response("{}", {
      headers: {
        "X-RateLimit-Limit": "100",
        "x-ratelimit-remaining": "37",
        "X-RATELIMIT-RESET": String(NOW_SEC + 42),
      },
    });
    const snap = parseFrontRateLimitHeaders(res);
    check("parses case-insensitively", snap.limit === 100 && snap.remaining === 37);
    check("parses reset epoch", snap.resetEpochSec === NOW_SEC + 42);

    const empty = parseFrontRateLimitHeaders(new Response("{}"));
    check(
      "absent headers → all null",
      empty.limit === null &&
        empty.remaining === null &&
        empty.resetEpochSec === null,
    );

    const bad = parseFrontRateLimitHeaders(
      new Response("{}", { headers: { "x-ratelimit-remaining": "abc" } }),
    );
    check("non-numeric header → null", bad.remaining === null);
  }

  // ── 3. Search fallback inter-page pacing dwindles → grows ─────────────
  {
    // Three pages of results, each advertising a smaller remaining budget,
    // all in the same 30s window. The inter-page sleeps should grow.
    const monthStart = new Date(Date.UTC(2025, 6, 1));
    const monthEnd = new Date(Date.UTC(2025, 7, 1));
    const remainingByPage = [12, 6, 3];
    let call = 0;
    const fetcher = async (_url: string): Promise<Response> => {
      const idx = call;
      call += 1;
      const isLast = idx === remainingByPage.length - 1;
      return jsonPage(
        {
          _results: [{ id: `c${idx}` }],
          _pagination: { next: isLast ? null : `https://api2.frontapp.com/next${idx}` },
        },
        {
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": String(remainingByPage[idx]),
          "x-ratelimit-reset": String(NOW_SEC + 30),
        },
      );
    };
    const sleeps: number[] = [];
    const result = await pullMonthlyMessageCountViaSearchFallback({
      monthStart,
      monthEnd,
      fetcher,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => NOW_MS,
    });
    check("search fallback walked all pages", result.pagesFetched === 3);
    // Two inter-page sleeps (after page 1 and page 2; none after the last).
    check("search fallback paced between pages only", sleeps.length === 2);
    check(
      "search fallback pacing grows as remaining dwindles",
      sleeps.length === 2 && sleeps[1] > sleeps[0],
    );
    // 30000/12 = 2500, 30000/6 = 5000.
    check("search fallback pace matches timeLeft/remaining", sleeps[0] === 2500 && sleeps[1] === 5000);
  }

  // ── 4. Healthy budget → no search pacing ─────────────────────────────
  {
    const fetcher = async (_url: string): Promise<Response> =>
      jsonPage(
        { _results: [{ id: "c0" }], _pagination: { next: "https://api2.frontapp.com/n0" } },
        { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "90", "x-ratelimit-reset": String(NOW_SEC + 30) },
      );
    let count = 0;
    const fetcher2 = async (url: string): Promise<Response> => {
      count += 1;
      if (count >= 2) {
        return jsonPage(
          { _results: [{ id: "c1" }], _pagination: { next: null } },
          { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "89", "x-ratelimit-reset": String(NOW_SEC + 30) },
        );
      }
      return fetcher(url);
    };
    const sleeps: number[] = [];
    await pullMonthlyMessageCountViaSearchFallback({
      monthStart: new Date(Date.UTC(2025, 6, 1)),
      monthEnd: new Date(Date.UTC(2025, 7, 1)),
      fetcher: fetcher2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => NOW_MS,
    });
    check("healthy budget → no search pacing", sleeps.length === 0);
  }

  // ── 5. Enumeration walk self-paces on dwindling remaining ────────────
  {
    const monthStart = new Date(Date.UTC(2025, 6, 1));
    const monthEnd = new Date(Date.UTC(2025, 7, 1));
    const inWindowSec = Math.floor(Date.UTC(2025, 6, 15) / 1000);
    // 1 search page returns 2 conversations; each conversation has 1 message
    // page. The remaining budget dwindles across the calls so the pacing
    // (applied inside frontGetJsonWithRetries after each successful page)
    // should grow.
    const remainingByCall = [12, 6, 3]; // search page, conv0 msgs, conv1 msgs
    let call = 0;
    const fetcher = async (url: string): Promise<Response> => {
      const idx = call;
      call += 1;
      const remaining = remainingByCall[Math.min(idx, remainingByCall.length - 1)];
      const headers = {
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": String(remaining),
        "x-ratelimit-reset": String(NOW_SEC + 30),
      };
      if (url.includes("/conversations/search/")) {
        return jsonPage(
          { _results: [{ id: "A" }, { id: "B" }], _pagination: { next: null } },
          headers,
        );
      }
      // messages page for a conversation
      return jsonPage(
        {
          _results: [{ id: `m${idx}`, is_inbound: true, created_at: inWindowSec }],
          _pagination: { next: null },
        },
        headers,
      );
    };
    const sleeps: number[] = [];
    const res = await enumerateMonthlyMessagesByDirectionTick({
      monthStart,
      monthEnd,
      fetcher,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => NOW_MS,
    });
    check("enumeration processed both conversations", res.conversationsProcessedThisTick === 2);
    check("enumeration counted inbound messages", res.checkpoint.inboundCount === 2);
    // Pacing fires after each successful page (search + 2 message pages) since
    // every call advertised a low budget: 30000/12, 30000/6, 30000/3.
    check("enumeration paced after each low-budget page", sleeps.length === 3);
    check(
      "enumeration pacing grows as remaining dwindles",
      sleeps[0] === 2500 && sleeps[1] === 5000 && sleeps[2] === 10000,
    );
  }

  console.log(`\nfront-rate-limit-pacing.test.ts: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

await main();
