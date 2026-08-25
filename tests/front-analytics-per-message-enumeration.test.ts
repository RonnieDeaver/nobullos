/* test-registration
{
  "name": "Front Analytics per-message enumeration (Task #1983)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1983 — Front Analytics per-message enumeration fallback.
 *
 * Plan-limited months have no Analytics per-direction denominators, so
 * the coverage panel used to show "not yet measured" for inbound /
 * outbound. This fallback walks Conversations Search → Messages and
 * counts messages per direction at MESSAGE grain.
 *
 * Pins:
 *   A. The client walk counts inbound / outbound correctly and filters
 *      to the month window by message `created_at`.
 *   B. Search + per-conversation message pagination are followed.
 *   C. The walk is resumable: a bounded tick stops mid-way and returns
 *      a checkpoint; resuming from it completes WITHOUT double-counting.
 *   D. A per-tick message-page budget stops the walk at a conversation
 *      boundary (conversation-atomic).
 *   E. Bounded 429 retries surface `front_analytics_rate_limited`.
 *   F. Coverage wiring (opt-in): when enabled and the walk completes,
 *      `messages_*_front` are populated and
 *      `direction_data_source='per_message_enumeration'`; the checkpoint
 *      is cleared.
 *   G. When the walk is NOT done, the per-direction counts stay NULL and
 *      the checkpoint is persisted + handed back on the next tick.
 *   H. When the switch is OFF, enumeration never runs.
 *   I. A month already sourced from `per_message_enumeration` is not
 *      re-walked.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  __frontAnalyticsClientTestHelpers,
  FrontAnalyticsError,
  enumerateMonthlyMessagesByDirectionTick,
  SEARCH_FALLBACK_MAX_429_RETRIES,
  type EnumerationCheckpoint,
  type EnumerationTickResult,
  type MonthlyMetricResult,
} from "../server/services/frontAnalyticsClient";
import {
  refreshMonth,
  getExistingMonth,
  SETTING_ADOPTION_DATE,
  SETTING_REFRESH_ENABLED,
  SETTING_PER_MESSAGE_ENUM_ENABLED,
  SETTING_ENUM_CHECKPOINT_PREFIX,
  DIRECTION_DATA_SOURCE_PER_MESSAGE,
  DENOMINATOR_UNIT_MESSAGES_ALL,
} from "../server/services/frontAnalyticsCoverage";

const FUTURE_YEAR = 2995;

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

const noSleep = async (_ms: number): Promise<void> => {};

interface Fixture {
  // Each entry is one search page = a list of conversation IDs.
  searchPages: string[][];
  // Per-conversation message lists (Unix-SECONDS created_at).
  messages: Record<string, Array<{ is_inbound: boolean; created_at: number }>>;
  // Forces per-conversation message pagination when set.
  messagesPageSize?: number;
}

function makeFrontFetcher(
  fx: Fixture,
  counter?: { searchPages: number; messagePages: number },
): (path: string) => Promise<Response> {
  const msgPageSize = fx.messagesPageSize ?? 10_000;
  const json = (o: unknown): Response =>
    new Response(JSON.stringify(o), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return async (path: string): Promise<Response> => {
    if (path.includes("/conversations/search/")) {
      if (counter) counter.searchPages += 1;
      const m = path.match(/[?&]page_token=(\d+)/);
      const idx = m ? Number(m[1]) : 0;
      const ids = fx.searchPages[idx] ?? [];
      const hasNext = idx + 1 < fx.searchPages.length;
      return json({
        _results: ids.map((id) => ({ id })),
        _pagination: {
          next: hasNext
            ? `/conversations/search/x?limit=100&page_token=${idx + 1}`
            : null,
        },
      });
    }
    const mm = path.match(/\/conversations\/([^/]+)\/messages/);
    if (mm) {
      if (counter) counter.messagePages += 1;
      const convId = decodeURIComponent(mm[1]);
      const all = fx.messages[convId] ?? [];
      const pm = path.match(/[?&]page_token=(\d+)/);
      const pageIdx = pm ? Number(pm[1]) : 0;
      const start = pageIdx * msgPageSize;
      const slice = all.slice(start, start + msgPageSize);
      const hasNext = start + msgPageSize < all.length;
      return json({
        _results: slice,
        _pagination: {
          next: hasNext
            ? `/conversations/${encodeURIComponent(
                convId,
              )}/messages?limit=100&page_token=${pageIdx + 1}`
            : null,
        },
      });
    }
    return new Response("not found", { status: 404 });
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

  const M = utcMonth(FUTURE_YEAR, 2); // YYYY-03
  const inWin = Math.floor(
    (Date.UTC(FUTURE_YEAR, 2, 10) ) / 1000,
  ); // mid-month
  const beforeWin = Math.floor((Date.UTC(FUTURE_YEAR, 1, 20)) / 1000); // prev month
  const afterWin = Math.floor((Date.UTC(FUTURE_YEAR, 3, 5)) / 1000); // next month

  // ── A. Basic counting + window filtering ─────────────────────────
  {
    const fx: Fixture = {
      searchPages: [["c1", "c2"]],
      messages: {
        c1: [
          { is_inbound: true, created_at: inWin },
          { is_inbound: true, created_at: inWin + 60 },
          { is_inbound: true, created_at: inWin + 120 },
          { is_inbound: false, created_at: inWin + 180 },
          { is_inbound: false, created_at: inWin + 240 },
          // out of window — must be ignored:
          { is_inbound: true, created_at: beforeWin },
          { is_inbound: false, created_at: afterWin },
        ],
        c2: [
          { is_inbound: true, created_at: inWin + 300 },
          { is_inbound: false, created_at: inWin + 360 },
        ],
      },
    };
    const res = await enumerateMonthlyMessagesByDirectionTick({
      monthStart: M.start,
      monthEnd: M.end,
      fetcher: makeFrontFetcher(fx),
      sleep: noSleep,
    });
    assert.equal(res.done, true, "single tick should finish a small month");
    assert.equal(res.checkpoint.inboundCount, 4, "3 (c1) + 1 (c2) inbound");
    assert.equal(res.checkpoint.outboundCount, 3, "2 (c1) + 1 (c2) outbound");
    assert.equal(res.checkpoint.processedConversationCount, 2);
  }

  // ── A3. Cross-month conversation: each month counts only its own
  //        in-window messages (Task #2718). ───────────────────────────
  //
  // Regression pin for the #2715 finding (cnv_1mm9ruhq): one long-lived
  // conversation spans multiple months and is returned by Front's
  // `/conversations/search/after:X before:Y` for BOTH adjacent month
  // windows. Without a per-message `created_at` filter the walk would
  // count the conversation's FULL history under every month it appears
  // in, inflating each month's message-grain denominator. The filter at
  // the message-fold means each month's walk counts ONLY the messages
  // whose `created_at` falls inside that month, so summing the two
  // adjacent months counts every message exactly once.
  {
    const MARCH = utcMonth(FUTURE_YEAR, 2); // YYYY-03 (== M)
    const APRIL = utcMonth(FUTURE_YEAR, 3); // YYYY-04
    const marchA = Math.floor(Date.UTC(FUTURE_YEAR, 2, 5) / 1000);
    const marchB = Math.floor(Date.UTC(FUTURE_YEAR, 2, 20) / 1000);
    const aprilA = Math.floor(Date.UTC(FUTURE_YEAR, 3, 8) / 1000);
    const febOld = Math.floor(Date.UTC(FUTURE_YEAR, 1, 14) / 1000);
    // The SAME conversation returned for both month windows, with a
    // history that straddles February, March, and April.
    const fx: Fixture = {
      searchPages: [["xMonth"]],
      messages: {
        xMonth: [
          { is_inbound: true, created_at: febOld }, // before both windows
          { is_inbound: true, created_at: marchA }, // March only
          { is_inbound: false, created_at: marchB }, // March only
          { is_inbound: true, created_at: aprilA }, // April only
        ],
      },
    };
    const marchRes = await enumerateMonthlyMessagesByDirectionTick({
      monthStart: MARCH.start,
      monthEnd: MARCH.end,
      fetcher: makeFrontFetcher(fx),
      sleep: noSleep,
    });
    const aprilRes = await enumerateMonthlyMessagesByDirectionTick({
      monthStart: APRIL.start,
      monthEnd: APRIL.end,
      fetcher: makeFrontFetcher(fx),
      sleep: noSleep,
    });
    assert.equal(
      marchRes.checkpoint.inboundCount,
      1,
      "March counts only the in-window inbound message",
    );
    assert.equal(
      marchRes.checkpoint.outboundCount,
      1,
      "March counts only the in-window outbound message",
    );
    assert.equal(
      aprilRes.checkpoint.inboundCount,
      1,
      "April counts only its own in-window inbound message",
    );
    assert.equal(
      aprilRes.checkpoint.outboundCount,
      0,
      "April has no outbound message in window",
    );
    // The conversation's 4-message history (1 Feb + 2 March + 1 April) is
    // counted exactly once across the two month windows — never doubled.
    const marchTotal =
      marchRes.checkpoint.inboundCount + marchRes.checkpoint.outboundCount;
    const aprilTotal =
      aprilRes.checkpoint.inboundCount + aprilRes.checkpoint.outboundCount;
    assert.equal(
      marchTotal + aprilTotal,
      3,
      "cross-month conversation contributes each in-window message once " +
        "(2 March + 1 April), the Feb message falls outside both windows",
    );
  }

  // ── A2. 301 merge follow + dedup (Task #1920) ────────────────────
  // A conversation that was merged into another resolves (via Front's 301
  // on GET /conversations/{id}/messages, which native fetch follows) to the
  // canonical conversation. When BOTH the merged-away source and the
  // canonical conversation come back from search, the canonical messages
  // must be counted ONCE — never doubled (a double-count inflates the
  // message-grain denominator and stops a month from honestly hitting 100%).
  {
    const canonMsgs = [
      { is_inbound: true, created_at: inWin },
      { is_inbound: true, created_at: inWin + 60 },
      { is_inbound: false, created_at: inWin + 120 },
    ];
    // Builds a 200 JSON Response whose read-only `.url` is the post-redirect
    // (canonical) URL, mirroring what native fetch exposes after following a
    // 301. The standard `makeFrontFetcher` can't do this because
    // `new Response()` leaves `.url` empty.
    const jsonWithUrl = (o: unknown, finalUrl: string): Response => {
      const res = new Response(JSON.stringify(o), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      Object.defineProperty(res, "url", {
        value: finalUrl,
        configurable: true,
      });
      return res;
    };
    const canonUrl =
      "https://api2.frontapp.com/conversations/canonZ/messages?limit=100";
    // `mergedA` was merged INTO `canonZ`; both appear in search. Every
    // messages fetch resolves to canonZ's messages with the canonical URL.
    const mergeFetcher = async (path: string): Promise<Response> => {
      if (path.includes("/conversations/search/")) {
        return jsonWithUrl(
          {
            _results: [{ id: "mergedA" }, { id: "canonZ" }],
            _pagination: { next: null },
          },
          `https://api2.frontapp.com${path}`,
        );
      }
      if (/\/conversations\/([^/]+)\/messages/.test(path)) {
        return jsonWithUrl(
          { _results: canonMsgs, _pagination: { next: null } },
          canonUrl,
        );
      }
      return new Response("not found", { status: 404 });
    };
    const res = await enumerateMonthlyMessagesByDirectionTick({
      monthStart: M.start,
      monthEnd: M.end,
      fetcher: mergeFetcher,
      sleep: noSleep,
    });
    assert.equal(res.done, true, "single tick should finish");
    assert.equal(
      res.checkpoint.inboundCount,
      2,
      "merged conversation inbound counted once, not doubled",
    );
    assert.equal(
      res.checkpoint.outboundCount,
      1,
      "merged conversation outbound counted once, not doubled",
    );
    assert.equal(
      res.checkpoint.processedConversationCount,
      2,
      "both conversations processed (one as a merge duplicate)",
    );
    assert.deepEqual(
      res.checkpoint.mergedAwayCanonicalIds,
      ["canonZ"],
      "canonical merge target recorded exactly once",
    );
  }

  // ── B. Search + message pagination are followed ──────────────────
  {
    const counter = { searchPages: 0, messagePages: 0 };
    const fx: Fixture = {
      searchPages: [["c1"], ["c2"]], // two search pages
      messagesPageSize: 1, // force per-message pagination
      messages: {
        c1: [
          { is_inbound: true, created_at: inWin },
          { is_inbound: false, created_at: inWin + 1 },
        ],
        c2: [{ is_inbound: true, created_at: inWin + 2 }],
      },
    };
    const res = await enumerateMonthlyMessagesByDirectionTick({
      monthStart: M.start,
      monthEnd: M.end,
      fetcher: makeFrontFetcher(fx, counter),
      sleep: noSleep,
    });
    assert.equal(res.done, true);
    assert.equal(res.checkpoint.inboundCount, 2);
    assert.equal(res.checkpoint.outboundCount, 1);
    assert.equal(counter.searchPages, 2, "both search pages fetched");
    // c1 has 2 msgs @ pageSize 1 → 2 message pages; c2 has 1 → 1 page.
    // The total (3 > conversation count of 2) proves per-conversation
    // message pagination was followed.
    assert.ok(
      counter.messagePages >= 3,
      `expected message pagination, got ${counter.messagePages} pages`,
    );
  }

  // ── C. Resumability across ticks (no double-count) ───────────────
  {
    const fx: Fixture = {
      searchPages: [["c1", "c2", "c3"]],
      messages: {
        c1: [{ is_inbound: true, created_at: inWin }],
        c2: [{ is_inbound: false, created_at: inWin + 1 }],
        c3: [
          { is_inbound: true, created_at: inWin + 2 },
          { is_inbound: false, created_at: inWin + 3 },
        ],
      },
    };
    const fetcher = makeFrontFetcher(fx);
    // Tick 1 — only one conversation per tick.
    const t1 = await enumerateMonthlyMessagesByDirectionTick({
      monthStart: M.start,
      monthEnd: M.end,
      conversationBudget: 1,
      fetcher,
      sleep: noSleep,
    });
    assert.equal(t1.done, false, "budget=1 must not finish a 3-conv month");
    assert.equal(t1.conversationsProcessedThisTick, 1);

    // Tick 2 — resume.
    const t2 = await enumerateMonthlyMessagesByDirectionTick({
      monthStart: M.start,
      monthEnd: M.end,
      conversationBudget: 1,
      checkpoint: t1.checkpoint,
      fetcher,
      sleep: noSleep,
    });
    assert.equal(t2.done, false);

    // Tick 3 — finish.
    const t3 = await enumerateMonthlyMessagesByDirectionTick({
      monthStart: M.start,
      monthEnd: M.end,
      conversationBudget: 1,
      checkpoint: t2.checkpoint,
      fetcher,
      sleep: noSleep,
    });
    assert.equal(t3.done, true, "third tick completes the month");
    assert.equal(t3.checkpoint.processedConversationCount, 3);
    assert.equal(t3.checkpoint.inboundCount, 2, "c1 + c3 inbound");
    assert.equal(t3.checkpoint.outboundCount, 2, "c2 + c3 outbound");
  }

  // ── D. Per-tick message-page budget stops at a conv boundary ─────
  {
    const fx: Fixture = {
      searchPages: [["c1", "c2"]],
      messages: {
        c1: [{ is_inbound: true, created_at: inWin }],
        c2: [{ is_inbound: false, created_at: inWin + 1 }],
      },
    };
    const fetcher = makeFrontFetcher(fx);
    const t1 = await enumerateMonthlyMessagesByDirectionTick({
      monthStart: M.start,
      monthEnd: M.end,
      messagePageBudget: 1, // one message page → stop after c1
      fetcher,
      sleep: noSleep,
    });
    assert.equal(t1.done, false, "message-page budget must pause the walk");
    assert.equal(t1.conversationsProcessedThisTick, 1);
    assert.equal(t1.checkpoint.inboundCount, 1);
    assert.equal(t1.checkpoint.outboundCount, 0);
    const t2 = await enumerateMonthlyMessagesByDirectionTick({
      monthStart: M.start,
      monthEnd: M.end,
      messagePageBudget: 1,
      checkpoint: t1.checkpoint,
      fetcher,
      sleep: noSleep,
    });
    assert.equal(t2.done, true);
    assert.equal(t2.checkpoint.inboundCount, 1);
    assert.equal(t2.checkpoint.outboundCount, 1);
  }

  // ── E2. Per-conversation page cap → checkpoint flagged truncated ──
  //       A single huge thread that exceeds the per-conversation page
  //       cap must mark the walk truncated (the fold is an undercount),
  //       so the caller refuses to publish a real denominator. ────────
  {
    // > per-conversation page cap (50) message pages @ pageSize 1.
    const msgs = Array.from({ length: 60 }, (_, i) => ({
      is_inbound: i % 2 === 0,
      created_at: inWin + i,
    }));
    const fx: Fixture = {
      searchPages: [["cBig"]],
      messagesPageSize: 1, // one message per page → 60 message pages
      messages: { cBig: msgs },
    };
    const res = await enumerateMonthlyMessagesByDirectionTick({
      monthStart: M.start,
      monthEnd: M.end,
      fetcher: makeFrontFetcher(fx),
      sleep: noSleep,
    });
    assert.equal(res.done, true, "search exhausted → tick reports done");
    assert.equal(
      res.checkpoint.truncated,
      true,
      "a conversation past the per-conversation page cap must flag truncated",
    );
  }

  // ── E. Bounded 429 retries → front_analytics_rate_limited ────────
  {
    let fetchCalls = 0;
    const fetcher = async (_path: string): Promise<Response> => {
      fetchCalls += 1;
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0.001" },
      });
    };
    let caught: unknown = null;
    try {
      await enumerateMonthlyMessagesByDirectionTick({
        monthStart: M.start,
        monthEnd: M.end,
        fetcher,
        sleep: noSleep,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught instanceof FrontAnalyticsError,
      `expected FrontAnalyticsError, got ${caught}`,
    );
    assert.equal(
      (caught as FrontAnalyticsError).code,
      "front_analytics_rate_limited",
    );
    assert.equal(
      fetchCalls,
      SEARCH_FALLBACK_MAX_429_RETRIES + 1,
      `expected ${SEARCH_FALLBACK_MAX_429_RETRIES + 1} fetches`,
    );
  }

  // ── Coverage wiring (F / G / H / I) ──────────────────────────────
  await withSettingsBackup(
    [
      SETTING_ADOPTION_DATE,
      SETTING_REFRESH_ENABLED,
      SETTING_PER_MESSAGE_ENUM_ENABLED,
      `${SETTING_ENUM_CHECKPOINT_PREFIX}${utcMonth(FUTURE_YEAR, 5).label}`,
      `${SETTING_ENUM_CHECKPOINT_PREFIX}${utcMonth(FUTURE_YEAR, 6).label}`,
      `${SETTING_ENUM_CHECKPOINT_PREFIX}${utcMonth(FUTURE_YEAR, 7).label}`,
      `${SETTING_ENUM_CHECKPOINT_PREFIX}${utcMonth(FUTURE_YEAR, 8).label}`,
      `${SETTING_ENUM_CHECKPOINT_PREFIX}${utcMonth(FUTURE_YEAR, 9).label}`,
    ],
    async () => {
      await storage.setSystemSetting(SETTING_REFRESH_ENABLED, "true", "test");
      await storage.setSystemSetting(
        SETTING_ADOPTION_DATE,
        `${FUTURE_YEAR}-01-01`,
        "test",
      );

      // Drift fix: the per-month enumeration checkpoint is a durable
      // `system_setting`. A previous run of section G persists a
      // (done:false) checkpoint for its month, and the shared dev DB
      // retains it, so "first tick starts fresh (null)" saw a stale
      // checkpoint instead of null. Explicitly clear the enumeration
      // checkpoint for every test month here so each tick that expects a
      // fresh start is deterministic; withSettingsBackup restores the
      // prior values on exit.
      for (const mIdx of [5, 6, 7, 8]) {
        await storage.deleteSystemSetting(
          `${SETTING_ENUM_CHECKPOINT_PREFIX}${utcMonth(FUTURE_YEAR, mIdx).label}`,
        );
      }

      // Analytics always plan-limited → forces the search-fallback path
      // where enumeration lives.
      __frontAnalyticsClientTestHelpers.setPullOverride(async () => {
        throw new FrontAnalyticsError(
          "front_analytics_plan_limited",
          "plan does not give you access",
          403,
        );
      });
      __frontAnalyticsClientTestHelpers.setSearchFallbackOverride(async () => ({
        count: 999,
        source: "search_conversations",
        unit: "conversations_all",
        pagesFetched: 1,
        frontTotalHint: null,
        truncated: false,
      }));

      try {
        const t0 = new Date(Date.UTC(FUTURE_YEAR, 5, 15, 12, 0, 0));

        // ── F. Enabled + walk completes → row populated, memo cleared
        {
          await storage.setSystemSetting(
            SETTING_PER_MESSAGE_ENUM_ENABLED,
            "true",
            "test",
          );
          const m = utcMonth(FUTURE_YEAR, 5); // YYYY-06
          let enumCalls = 0;
          __frontAnalyticsClientTestHelpers.setEnumerationOverride(
            async (opts): Promise<EnumerationTickResult> => {
              enumCalls += 1;
              return {
                checkpoint: {
                  searchNextUrl: null,
                  searchStarted: true,
                  pendingConversationIds: [],
                  inboundCount: 41,
                  outboundCount: 19,
                  processedConversationCount: 5,
                  truncated: false,
                },
                done: true,
                conversationsProcessedThisTick: 5,
                searchPagesFetchedThisTick: 1,
                messagePagesFetchedThisTick: 5,
              };
            },
          );
          const r = await refreshMonth({
            month: m.label,
            monthStart: m.start,
            monthEnd: m.end,
            isCurrentMonth: false,
            now: t0,
          });
          assert.equal(r.outcome, "ok_search_fallback");
          assert.equal(enumCalls, 1, "enumeration ran once");
          const row = await getExistingMonth(m.label);
          assert.equal(row!.messagesInboundFront, 41);
          assert.equal(row!.messagesOutboundFront, 19);
          assert.equal(
            row!.directionDataSource,
            DIRECTION_DATA_SOURCE_PER_MESSAGE,
          );
          // Checkpoint cleared on completion.
          const cp = await storage
            .getSystemSetting(`${SETTING_ENUM_CHECKPOINT_PREFIX}${m.label}`)
            .catch(() => null);
          assert.ok(
            !cp || cp.value == null,
            "checkpoint must be cleared after completion",
          );
        }

        // ── G. Not done → counts stay NULL, checkpoint persisted and
        //       handed back to the next tick. ───────────────────────
        {
          const m = utcMonth(FUTURE_YEAR, 6); // YYYY-07
          const partialCp: EnumerationCheckpoint = {
            searchNextUrl: "/conversations/search/x?limit=100&page_token=1",
            searchStarted: true,
            pendingConversationIds: ["cZ"],
            inboundCount: 3,
            outboundCount: 2,
            processedConversationCount: 1,
            truncated: false,
          };
          let seenCheckpoint: EnumerationCheckpoint | null | undefined;
          __frontAnalyticsClientTestHelpers.setEnumerationOverride(
            async (opts): Promise<EnumerationTickResult> => {
              seenCheckpoint = opts.checkpoint;
              return {
                checkpoint: partialCp,
                done: false,
                conversationsProcessedThisTick: 1,
                searchPagesFetchedThisTick: 1,
                messagePagesFetchedThisTick: 1,
              };
            },
          );
          const r1 = await refreshMonth({
            month: m.label,
            monthStart: m.start,
            monthEnd: m.end,
            isCurrentMonth: false,
            now: t0,
          });
          assert.equal(r1.outcome, "ok_search_fallback");
          assert.equal(seenCheckpoint, null, "first tick starts fresh (null)");
          const row1 = await getExistingMonth(m.label);
          assert.equal(
            row1!.messagesInboundFront,
            null,
            "incomplete walk must NOT surface a partial denominator",
          );
          assert.equal(row1!.directionDataSource, null);
          const saved = await storage.getSystemSetting(
            `${SETTING_ENUM_CHECKPOINT_PREFIX}${m.label}`,
          );
          assert.ok(saved?.value, "checkpoint persisted for resume");
          assert.deepEqual(
            JSON.parse(saved!.value!),
            partialCp,
            "persisted checkpoint matches the tick output",
          );

          // Second tick (force the search path again) → override must
          // receive the saved checkpoint.
          const r2 = await refreshMonth({
            month: m.label,
            monthStart: m.start,
            monthEnd: m.end,
            isCurrentMonth: false,
            now: t0,
            forceRerun: true,
            forceSearchFallback: true,
          });
          assert.equal(r2.outcome, "ok_search_fallback");
          assert.deepEqual(
            seenCheckpoint,
            partialCp,
            "resume must hand the saved checkpoint to the walk",
          );
        }

        // ── H. Switch OFF → enumeration never runs ───────────────────
        {
          await storage.setSystemSetting(
            SETTING_PER_MESSAGE_ENUM_ENABLED,
            "false",
            "test",
          );
          const m = utcMonth(FUTURE_YEAR, 7); // YYYY-08
          let calls = 0;
          __frontAnalyticsClientTestHelpers.setEnumerationOverride(async () => {
            calls += 1;
            throw new Error("must not be called when disabled");
          });
          const r = await refreshMonth({
            month: m.label,
            monthStart: m.start,
            monthEnd: m.end,
            isCurrentMonth: false,
            now: t0,
          });
          assert.equal(r.outcome, "ok_search_fallback");
          assert.equal(calls, 0, "enumeration must not run when disabled");
          const row = await getExistingMonth(m.label);
          assert.equal(row!.messagesInboundFront, null);
          assert.equal(row!.directionDataSource, null);
        }

        // ── H2. Task #2482 — switch OFF but forcePerMessageEnum:true →
        //        enumeration STILL runs and republishes the headline at
        //        message grain. This is the path the
        //        reach_front_coverage_full_message_grain prod-action uses
        //        to re-measure the ~9 dropped-history months WITHOUT
        //        flipping the heavy global enumeration switch. The grain
        //        flip (denominator_unit → messages_all) is the user-facing
        //        fix: the all-time #2436 headline sums only message-grain
        //        rows, so a conversation-grain month reads as ~0 there. ───
        {
          // Switch is OFF (left so by section H above).
          const m = utcMonth(FUTURE_YEAR, 9); // YYYY-10
          await storage.deleteSystemSetting(
            `${SETTING_ENUM_CHECKPOINT_PREFIX}${m.label}`,
          );
          let calls = 0;
          __frontAnalyticsClientTestHelpers.setEnumerationOverride(
            async (): Promise<EnumerationTickResult> => {
              calls += 1;
              return {
                checkpoint: {
                  searchNextUrl: null,
                  searchStarted: true,
                  pendingConversationIds: [],
                  inboundCount: 33,
                  outboundCount: 22,
                  processedConversationCount: 4,
                  truncated: false,
                },
                done: true,
                conversationsProcessedThisTick: 4,
                searchPagesFetchedThisTick: 1,
                messagePagesFetchedThisTick: 4,
              };
            },
          );
          const r = await refreshMonth({
            month: m.label,
            monthStart: m.start,
            monthEnd: m.end,
            isCurrentMonth: false,
            now: t0,
            forceSearchFallback: true,
            forceRerun: true,
            forcePerMessageEnum: true,
          });
          assert.equal(r.outcome, "ok_search_fallback");
          assert.equal(
            calls,
            1,
            "forcePerMessageEnum must run the walk even with the global switch OFF",
          );
          const row = await getExistingMonth(m.label);
          assert.equal(row!.messagesInboundFront, 33);
          assert.equal(row!.messagesOutboundFront, 22);
          assert.equal(
            row!.directionDataSource,
            DIRECTION_DATA_SOURCE_PER_MESSAGE,
            "forced walk records per-message direction source",
          );
          assert.equal(
            row!.denominatorUnit,
            DENOMINATOR_UNIT_MESSAGES_ALL,
            "forced walk republishes the headline at message grain (the #2436-headline fix)",
          );
        }

        // ── I. Already per_message_enumeration → not re-walked ───────
        {
          await storage.setSystemSetting(
            SETTING_PER_MESSAGE_ENUM_ENABLED,
            "true",
            "test",
          );
          const m = utcMonth(FUTURE_YEAR, 8); // YYYY-09
          // Seed a completed enumeration row.
          let calls = 0;
          __frontAnalyticsClientTestHelpers.setEnumerationOverride(
            async (): Promise<EnumerationTickResult> => {
              calls += 1;
              return {
                checkpoint: {
                  searchNextUrl: null,
                  searchStarted: true,
                  pendingConversationIds: [],
                  inboundCount: 7,
                  outboundCount: 5,
                  processedConversationCount: 2,
                  truncated: false,
                },
                done: true,
                conversationsProcessedThisTick: 2,
                searchPagesFetchedThisTick: 1,
                messagePagesFetchedThisTick: 2,
              };
            },
          );
          await refreshMonth({
            month: m.label,
            monthStart: m.start,
            monthEnd: m.end,
            isCurrentMonth: false,
            now: t0,
          });
          assert.equal(calls, 1, "first walk runs");
          const callsAfterFirst = calls;
          // Force the search path again — the row is already
          // per_message_enumeration so the walk must be skipped.
          await refreshMonth({
            month: m.label,
            monthStart: m.start,
            monthEnd: m.end,
            isCurrentMonth: false,
            now: t0,
            forceRerun: true,
            forceSearchFallback: true,
          });
          assert.equal(
            calls,
            callsAfterFirst,
            "a completed-enumeration month must not be re-walked",
          );
        }

        // ── J. Truncated walk (done but capped) must NOT publish ─────
        //       per-direction denominators, and must clear the
        //       checkpoint (the cap won't resolve on retry). ──────────
        {
          const m = utcMonth(FUTURE_YEAR, 4); // YYYY-05
          // Pre-seed a checkpoint so we can assert it gets cleared.
          await storage.setSystemSetting(
            `${SETTING_ENUM_CHECKPOINT_PREFIX}${m.label}`,
            JSON.stringify({
              searchNextUrl: null,
              searchStarted: true,
              pendingConversationIds: [],
              inboundCount: 0,
              outboundCount: 0,
              processedConversationCount: 0,
              truncated: false,
            }),
            "system",
          );
          __frontAnalyticsClientTestHelpers.setEnumerationOverride(
            async (): Promise<EnumerationTickResult> => ({
              checkpoint: {
                searchNextUrl: null,
                searchStarted: true,
                pendingConversationIds: [],
                inboundCount: 123,
                outboundCount: 456,
                processedConversationCount: 9999,
                truncated: true, // capped → undercount
              },
              done: true,
              conversationsProcessedThisTick: 9999,
              searchPagesFetchedThisTick: 10,
              messagePagesFetchedThisTick: 10,
            }),
          );
          const r = await refreshMonth({
            month: m.label,
            monthStart: m.start,
            monthEnd: m.end,
            isCurrentMonth: false,
            now: t0,
          });
          assert.equal(r.outcome, "ok_search_fallback");
          const row = await getExistingMonth(m.label);
          assert.equal(
            row!.messagesInboundFront,
            null,
            "truncated walk must NOT publish an undercounted inbound denominator",
          );
          assert.equal(row!.messagesOutboundFront, null);
          assert.equal(
            row!.directionDataSource,
            null,
            "truncated walk must NOT claim per_message_enumeration",
          );
          const cp = await storage
            .getSystemSetting(`${SETTING_ENUM_CHECKPOINT_PREFIX}${m.label}`)
            .catch(() => null);
          assert.ok(
            !cp || cp.value == null,
            "truncated walk must clear its checkpoint",
          );
        }
      } finally {
        __frontAnalyticsClientTestHelpers.setPullOverride(null);
        __frontAnalyticsClientTestHelpers.setSearchFallbackOverride(null);
        __frontAnalyticsClientTestHelpers.setEnumerationOverride(null);
        await cleanupTestRows();
      }
    },
  );

  console.log("front-analytics-per-message-enumeration: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
