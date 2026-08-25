/* test-registration
{
  "name": "Front applied-conv materializer — collectAllMessages + tick wiring (Task #2708)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2708: the applied-conversation materializer introduces `collectAllMessages` on the enumeration tick — the lever that finally moves the \"Bring it to 100%\" number for months with all conversations already `applied`. Pins A–E verify the enumeration contract and counter wiring (DB-free, in-memory). Pin F is an isolated-schema integration test that writes real rows to raw_communication_records via the real materializeFrontMessageRecord and verifies idempotency. A regression in any of these paths would silently re-break coverage for those months.",
  "tier": "small"
}
test-registration */
/**
 * Task #2708 — Applied-conversation message materializer.
 *
 * Root cause: reachFrontCoverageFullForMonth relies on
 * runTargetedWindowBackfill to fill the numerator, but that driver
 * returns 100% `duplicate_ignored` for months where all conversations are
 * already `applied` in front_sync_emails — the messages inside those
 * conversations were never written to raw_communication_records.
 *
 * Fix: frontAppliedConvMaterializer.ts adds a Step 2.5 that walks the same
 * conversations via the enumeration search with `collectAllMessages: true`
 * and calls materializeFrontMessageRecord for each missing message.
 *
 * Pins:
 *   A. enumerateMonthlyMessagesByDirectionTick with collectAllMessages:true
 *      returns BOTH inbound and outbound messages in `allMessagesThisTick`.
 *   B. With collectAllMessages:false (default), `allMessagesThisTick` is
 *      absent — the measurement-only #1983 contract is unchanged.
 *   C. allMessagesThisTick is conversation-atomic: messages for an
 *      incomplete conversation (mid-walk) are not flushed prematurely.
 *   D. outboundMessagesThisTick still works correctly when both
 *      collectOutboundMessages and collectAllMessages are NOT set.
 *   E. materializeAppliedConvMessagesForMonthTick correctly counts
 *      inserted vs skipped, passes the updated checkpoint, and marks
 *      done when the walk is exhausted.
 *   F. materializeFrontMessageRecord writes real, idempotent rows.
 *   G. materializer_in_progress maps to auth_blocked ⇒ attempts unchanged.
 *   H. duplicate external_source_id is a clean ON CONFLICT skip (no throw).
 *
 * Task #2711 — prevent old months from being re-walked / prematurely retired
 * if the button is pressed while materialization is in progress:
 *   I. deriveCoverageConvergenceOutcome treats materializer-only progress
 *      (ingested>0 from Step 2.5, Step 3 ingested=0) as "progress", not
 *      "unreachable", so the sweep cannot retire a still-progressing month.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import {
  enumerateMonthlyMessagesByDirectionTick,
  __frontAnalyticsClientTestHelpers,
  type EnumerationCheckpoint,
  type CollectedOutboundMessage,
} from "../server/services/frontAnalyticsClient";
import {
  materializeAppliedConvMessagesForMonthTick,
  listActiveMaterializationProgress,
  formatMaterializationProgressDetail,
  CHECKPOINT_KEY_PREFIX,
  __frontAppliedConvMaterializerTestHelpers,
} from "../server/services/frontAppliedConvMaterializer";
import { createRawCommunicationOnConflictSkip } from "../server/storage/communicationStorage";
import { runInIsolatedSchema } from "./db-sandbox";

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_START = new Date(Date.UTC(2025, 8, 1)); // 2025-09-01
const MONTH_END = new Date(Date.UTC(2025, 9, 1)); // 2025-10-01
const IN_WINDOW_SECS = Math.floor(MONTH_START.getTime() / 1000) + 3600;

const noSleep = async (_ms: number): Promise<void> => {};

interface FixMsg {
  id: string;
  is_inbound: boolean;
  created_at: number;
}

/** Minimal fetcher: one search page + one messages page per conversation. */
function makeFetcher(
  convIds: string[],
  messagesMap: Record<string, FixMsg[]>,
): (path: string) => Promise<Response> {
  const json = (o: unknown) =>
    new Response(JSON.stringify(o), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return async (path: string) => {
    if (path.includes("/conversations/search/")) {
      return json({
        _results: convIds.map((id) => ({ id, subject: `Subject-${id}` })),
        _pagination: { next: null },
      });
    }
    const convMatch = path.match(/\/conversations\/([^/]+)\/messages/);
    if (convMatch) {
      const convId = decodeURIComponent(convMatch[1]);
      const msgs = messagesMap[convId] ?? [];
      return json({ _results: msgs, _pagination: { next: null } });
    }
    return json({ _results: [], _pagination: { next: null } });
  };
}

// ── Pin A: collectAllMessages captures both inbound and outbound ──────────

{
  const convIds = ["conv1"];
  const msgs: FixMsg[] = [
    { id: "msg-in-1", is_inbound: true, created_at: IN_WINDOW_SECS },
    { id: "msg-out-1", is_inbound: false, created_at: IN_WINDOW_SECS },
    { id: "msg-in-2", is_inbound: true, created_at: IN_WINDOW_SECS + 60 },
  ];
  const fetcher = makeFetcher(convIds, { conv1: msgs });

  const tick = await enumerateMonthlyMessagesByDirectionTick({
    monthStart: MONTH_START,
    monthEnd: MONTH_END,
    fetcher,
    sleep: noSleep,
    collectAllMessages: true,
  });

  const all = tick.allMessagesThisTick;
  assert.ok(Array.isArray(all), "allMessagesThisTick should be an array");
  assert.equal(all!.length, 3, "Should collect all 3 messages (2 inbound + 1 outbound)");

  const inbound = all!.filter((m) => m.message.is_inbound === true);
  const outbound = all!.filter((m) => m.message.is_inbound === false);
  assert.equal(inbound.length, 2, "2 inbound messages collected");
  assert.equal(outbound.length, 1, "1 outbound message collected");

  assert.ok(
    all!.every((m) => m.conversationId === "conv1"),
    "All messages carry the parent conversationId",
  );
  assert.ok(
    all!.every((m) => m.conversationSubject === "Subject-conv1"),
    "All messages carry the conversation subject",
  );

  ok("A: collectAllMessages:true returns both inbound and outbound in allMessagesThisTick");
}

// ── Pin B: without collectAllMessages, allMessagesThisTick is absent ──────

{
  const convIds = ["conv2"];
  const msgs: FixMsg[] = [
    { id: "msg-b1", is_inbound: true, created_at: IN_WINDOW_SECS },
    { id: "msg-b2", is_inbound: false, created_at: IN_WINDOW_SECS },
  ];
  const fetcher = makeFetcher(convIds, { conv2: msgs });

  const tick = await enumerateMonthlyMessagesByDirectionTick({
    monthStart: MONTH_START,
    monthEnd: MONTH_END,
    fetcher,
    sleep: noSleep,
  });

  assert.equal(
    tick.allMessagesThisTick,
    undefined,
    "allMessagesThisTick must be absent when collectAllMessages is not set",
  );
  assert.equal(tick.checkpoint.inboundCount, 1, "inbound count still measured correctly");
  assert.equal(tick.checkpoint.outboundCount, 1, "outbound count still measured correctly");

  ok("B: collectAllMessages:false (default) — allMessagesThisTick is absent, counts are correct");
}

// ── Pin C: allMessagesThisTick respects conversationBudget (atomic) ──────

{
  const convIds = ["cA", "cB"];
  const msgs: Record<string, FixMsg[]> = {
    cA: [
      { id: "cA-in", is_inbound: true, created_at: IN_WINDOW_SECS },
      { id: "cA-out", is_inbound: false, created_at: IN_WINDOW_SECS },
    ],
    cB: [{ id: "cB-in", is_inbound: true, created_at: IN_WINDOW_SECS }],
  };
  const fetcher = makeFetcher(convIds, msgs);

  const tick = await enumerateMonthlyMessagesByDirectionTick({
    monthStart: MONTH_START,
    monthEnd: MONTH_END,
    fetcher,
    sleep: noSleep,
    conversationBudget: 1, // only walk cA
    collectAllMessages: true,
  });

  const all = tick.allMessagesThisTick!;
  assert.ok(!tick.done, "Not done after 1-conv budget");
  assert.equal(all.length, 2, "Only cA's 2 messages collected (budget=1)");
  assert.ok(
    all.every((m) => m.conversationId === "cA"),
    "Only cA messages collected — cB not yet walked",
  );

  ok("C: conversationBudget respected — allMessagesThisTick is conversation-atomic");
}

// ── Pin D: collectOutboundMessages still works independently ──────────────

{
  const convIds = ["convD"];
  const msgs: FixMsg[] = [
    { id: "d-in", is_inbound: true, created_at: IN_WINDOW_SECS },
    { id: "d-out", is_inbound: false, created_at: IN_WINDOW_SECS },
  ];
  const fetcher = makeFetcher(convIds, { convD: msgs });

  const tick = await enumerateMonthlyMessagesByDirectionTick({
    monthStart: MONTH_START,
    monthEnd: MONTH_END,
    fetcher,
    sleep: noSleep,
    collectOutboundMessages: true, // only outbound
  });

  const outbound = tick.outboundMessagesThisTick!;
  assert.equal(outbound.length, 1, "outboundMessagesThisTick has 1 outbound message");
  assert.equal(outbound[0].message.id, "d-out");
  assert.equal(tick.allMessagesThisTick, undefined, "allMessagesThisTick absent");

  ok("D: collectOutboundMessages still works independently; allMessagesThisTick absent");
}

// ── Pin E: materializeAppliedConvMessagesForMonthTick — inserted/skipped ─
//
// Proves the counter wiring: enumeration returns 2 messages (inbound +
// outbound), the fake materializer returns "inserted" for the first and
// "skipped" for the second, and the tick correctly tallies both.
// No real DB connection is used — the materializer override injects a pure
// in-memory stub following the same pattern as setEnumerationOverride.

{
  const fakeInbound: CollectedOutboundMessage = {
    conversationId: "e-conv",
    conversationSubject: "Test subject",
    message: { id: "e-msg-in", is_inbound: true, created_at: IN_WINDOW_SECS },
  };
  const fakeOutbound: CollectedOutboundMessage = {
    conversationId: "e-conv",
    conversationSubject: "Test subject",
    message: { id: "e-msg-out", is_inbound: false, created_at: IN_WINDOW_SECS },
  };

  const fakeCheckpoint: EnumerationCheckpoint = {
    searchStarted: true,
    searchNextUrl: null,
    pendingConversationIds: [],
    processedConversationCount: 1,
    inboundCount: 1,
    outboundCount: 1,
    mergedAwayCanonicalIds: [],
    truncated: false,
  };

  // Enumeration returns 2 messages and signals done.
  __frontAnalyticsClientTestHelpers.setEnumerationOverride(async () => ({
    checkpoint: fakeCheckpoint,
    done: true,
    conversationsProcessedThisTick: 1,
    searchPagesFetchedThisTick: 1,
    messagePagesFetchedThisTick: 1,
    allMessagesThisTick: [fakeInbound, fakeOutbound],
  }));

  // Materializer stub: first call → "inserted", second → "skipped".
  // Verifies the counter loop processes both messages and tallies correctly.
  const calls: string[] = [];
  __frontAppliedConvMaterializerTestHelpers.setMaterializerOverride(
    async (opts) => {
      const id = (opts.msg as { id?: string }).id ?? "?";
      calls.push(id);
      return calls.length === 1 ? "inserted" : "skipped";
    },
  );

  const result = await materializeAppliedConvMessagesForMonthTick(
    "2025-09",
    MONTH_START,
    MONTH_END,
    null,
  );

  assert.equal(calls.length, 2, "materializeFn called once per collected message");
  assert.equal(result.inserted, 1, "inserted=1 for the first message");
  assert.equal(result.skipped, 1, "skipped=1 for the second message");
  assert.equal(result.done, true, "done reflects the enumeration tick done flag");
  assert.deepEqual(
    result.checkpoint,
    fakeCheckpoint,
    "checkpoint forwarded from enumeration tick unchanged",
  );

  __frontAnalyticsClientTestHelpers.setEnumerationOverride(null);
  __frontAppliedConvMaterializerTestHelpers.setMaterializerOverride(null);

  ok("E: materializeAppliedConvMessagesForMonthTick counts inserted/skipped and forwards checkpoint");
}

// ── Pin E2: Task #2714 — the per-tick Front budget knob is honored ────────
//
// Operators can speed up (or gentle-down) the "Bring it to 100%" backfill via
// two system_settings rows WITHOUT a code change. This pin proves:
//   1. resolveMaterializerBudget is a pure clamp/fallback (no DB).
//   2. materializeAppliedConvMessagesForMonthTick READS the rows and PASSES the
//      resolved budgets through to the enumeration tick — the leaf consumer —
//      so a configured value actually changes the per-tick Front call budget.

{
  const {
    resolveMaterializerBudget,
    MATERIALIZER_CONVERSATION_BUDGET_MAX,
    MATERIALIZER_MESSAGE_PAGE_BUDGET_MAX,
    SETTING_MATERIALIZER_CONVERSATION_BUDGET,
    SETTING_MATERIALIZER_MESSAGE_PAGE_BUDGET,
  } = await import("../server/services/frontAppliedConvMaterializer");
  const {
    ENUM_CONVERSATIONS_PER_TICK_DEFAULT,
    ENUM_MESSAGE_PAGES_PER_TICK_DEFAULT,
  } = await import("../server/services/frontAnalyticsClient");

  // (1) Pure resolver — unset/blank/invalid → in-code defaults (today's behavior).
  for (const blank of [null, undefined, "", "  ", "abc", "0", "-5"]) {
    const r = resolveMaterializerBudget(blank, blank);
    assert.equal(
      r.conversationBudget,
      ENUM_CONVERSATIONS_PER_TICK_DEFAULT,
      `E2.1: conversationBudget falls back to default for ${JSON.stringify(blank)}`,
    );
    assert.equal(
      r.messagePageBudget,
      ENUM_MESSAGE_PAGES_PER_TICK_DEFAULT,
      `E2.1: messagePageBudget falls back to default for ${JSON.stringify(blank)}`,
    );
  }

  // A valid value is honored; a fractional value floors; an over-ceiling value clamps.
  assert.deepEqual(
    resolveMaterializerBudget("300", "1200"),
    { conversationBudget: 300, messagePageBudget: 1200 },
    "E2.2: valid values honored verbatim",
  );
  assert.equal(
    resolveMaterializerBudget("42.9", "10").conversationBudget,
    42,
    "E2.2: fractional value floors",
  );
  assert.deepEqual(
    resolveMaterializerBudget("999999", "999999"),
    {
      conversationBudget: MATERIALIZER_CONVERSATION_BUDGET_MAX,
      messagePageBudget: MATERIALIZER_MESSAGE_PAGE_BUDGET_MAX,
    },
    "E2.3: over-ceiling values clamp to the safety max",
  );

  // (2) End-to-end: a configured row must reach the enumeration tick's budget.
  // Use an isolated schema so getSystemSetting/setSystemSetting hit the cloned
  // system_settings table rather than the live dev DB.
  await runInIsolatedSchema(
    async () => {
      const { setSystemSetting } = await import(
        "../server/storage/settingsStorage"
      );
      await setSystemSetting(SETTING_MATERIALIZER_CONVERSATION_BUDGET, "37");
      await setSystemSetting(SETTING_MATERIALIZER_MESSAGE_PAGE_BUDGET, "211");

      let seenConvBudget: number | undefined;
      let seenMsgPageBudget: number | undefined;
      __frontAnalyticsClientTestHelpers.setEnumerationOverride(async (opts) => {
        seenConvBudget = opts.conversationBudget;
        seenMsgPageBudget = opts.messagePageBudget;
        return {
          checkpoint: {
            searchStarted: true,
            searchNextUrl: null,
            pendingConversationIds: [],
            processedConversationCount: 0,
            inboundCount: 0,
            outboundCount: 0,
            mergedAwayCanonicalIds: [],
            truncated: false,
          },
          done: true,
          conversationsProcessedThisTick: 0,
          searchPagesFetchedThisTick: 0,
          messagePagesFetchedThisTick: 0,
          allMessagesThisTick: [],
        };
      });

      try {
        await materializeAppliedConvMessagesForMonthTick(
          "2025-09",
          MONTH_START,
          MONTH_END,
          null,
        );
        assert.equal(
          seenConvBudget,
          37,
          "E2.4: configured conversation budget reaches the enumeration tick",
        );
        assert.equal(
          seenMsgPageBudget,
          211,
          "E2.4: configured message-page budget reaches the enumeration tick",
        );
      } finally {
        __frontAnalyticsClientTestHelpers.setEnumerationOverride(null);
      }
    },
    { tables: ["system_settings"] },
  );

  ok("E2: per-tick Front budget knob is honored (pure resolver + reaches the leaf enumeration tick)");
}

// ── Pin F: integration — real rows written to raw_communication_records ───
//
// Uses runInIsolatedSchema so the real materializeFrontMessageRecord (which
// uses getDb() → storage.createRawCommunication) writes into the isolated
// table clone and never touches the live dev DB. Proves:
//   1. Two fake messages produce 2 inserted rows with correct column values.
//   2. A second call with the same messages returns inserted=0, skipped=2
//      (idempotency via external_source_id dedup in storage).

{
  const ISO_TABLES = ["raw_communication_records"] as const;

  const fakeInF: CollectedOutboundMessage = {
    conversationId: "f-conv",
    conversationSubject: "Integration test",
    message: { id: "f-msg-in", is_inbound: true, created_at: IN_WINDOW_SECS },
  };
  const fakeOutF: CollectedOutboundMessage = {
    conversationId: "f-conv",
    conversationSubject: "Integration test",
    message: { id: "f-msg-out", is_inbound: false, created_at: IN_WINDOW_SECS },
  };
  const fakeCheckpointF: EnumerationCheckpoint = {
    searchStarted: true,
    searchNextUrl: null,
    pendingConversationIds: [],
    processedConversationCount: 1,
    inboundCount: 1,
    outboundCount: 1,
    mergedAwayCanonicalIds: [],
    truncated: false,
  };

  await runInIsolatedSchema(
    async ({ db: _db }) => {
      // Enumeration override — returns 2 messages, done=true, no Front API calls.
      __frontAnalyticsClientTestHelpers.setEnumerationOverride(async () => ({
        checkpoint: fakeCheckpointF,
        done: true,
        conversationsProcessedThisTick: 1,
        searchPagesFetchedThisTick: 1,
        messagePagesFetchedThisTick: 1,
        allMessagesThisTick: [fakeInF, fakeOutF],
      }));

      try {
        // First run: materializer override NOT set → real materializeFrontMessageRecord
        // uses getDb() which is redirected to the isolated schema by runInIsolatedSchema.
        const r1 = await materializeAppliedConvMessagesForMonthTick(
          "2025-09",
          MONTH_START,
          MONTH_END,
          null,
        );

        assert.equal(r1.inserted, 2, "F1: both messages inserted on first run");
        assert.equal(r1.skipped, 0, "F1: no skips on first run");
        assert.equal(r1.done, true, "F1: done after single tick");

        // Verify the rows actually landed in the isolated raw_communication_records.
        const res = await _db.execute(sql`
          SELECT external_source_id, source_subtype, processing_status, direction
          FROM raw_communication_records
          WHERE external_source_id IN (${"f-msg-in"}, ${"f-msg-out"})
          ORDER BY external_source_id
        `);
        const rows = ((res as any).rows ?? (res as unknown as any[])) as any[];
        assert.equal(rows.length, 2, "F2: 2 rows in raw_communication_records");
        assert.ok(
          rows.every((r: any) => r.source_subtype === "email_message"),
          "F3: source_subtype = email_message",
        );
        assert.ok(
          rows.every((r: any) => r.processing_status === "processed"),
          "F4: processing_status = processed (terminal, no classifier queue)",
        );
        const dirs = new Set(rows.map((r: any) => r.direction));
        assert.ok(dirs.has("inbound") && dirs.has("outbound"), "F5: both directions written");

        // Second run — idempotency: same enumeration override, same external_source_ids.
        const r2 = await materializeAppliedConvMessagesForMonthTick(
          "2025-09",
          MONTH_START,
          MONTH_END,
          null,
        );
        assert.equal(r2.inserted, 0, "F6: idempotent — second run inserts 0");
        assert.equal(r2.skipped, 2, "F7: idempotent — second run skips both");
      } finally {
        __frontAnalyticsClientTestHelpers.setEnumerationOverride(null);
      }
    },
    { tables: ISO_TABLES },
  );

  ok("F: materializeFrontMessageRecord writes real rows to raw_communication_records (idempotent)");
}

// ── Pin G: convergence budget not capped while materializer is in progress ─
//
// Verifies the safety guarantee introduced with the Step 3 gate:
//   When materializeDone=false the orchestrator sets status="materializer_in_progress"
//   which maps to the "auth_blocked" convergence outcome → nextCoverageConvergenceAttempts
//   returns null (leave attempts unchanged). This prevents the sweep from
//   retiring the month as "unreachable" while messages are still being written.
//
// Tests nextCoverageConvergenceAttempts directly (pure function, no DB) and
// contrasts it with the "unreachable" outcome that DOES advance the cap.

{
  const { nextCoverageConvergenceAttempts } = await import(
    "../server/services/frontAnalyticsCoverage"
  );

  // auth_blocked (the outcome mapped from materializer_in_progress) → null = no change
  for (const current of [0, 1, 2, 5]) {
    const result = nextCoverageConvergenceAttempts(current, "auth_blocked");
    assert.equal(
      result,
      null,
      `G1: auth_blocked at attempts=${current} leaves unchanged (returns null)`,
    );
  }

  // "unreachable" (the outcome that WOULD fire if the bug were present) → advances cap
  const capAdvanced = nextCoverageConvergenceAttempts(0, "unreachable");
  assert.ok(
    capAdvanced !== null && capAdvanced > 0,
    "G2: unreachable advances convergence cap (contrast case)",
  );

  ok("G: materializer_in_progress maps to auth_blocked outcome → convergence attempts left unchanged");
}

// ── Pin H: duplicate external_source_id is a CLEAN skip — no thrown error ──
//
// Task #2713 — the previous SELECT-then-INSERT threw a duplicate-key error
// when two materializer ticks / autoscale instances both passed the pre-check
// and then collided on the unique index. The loser's throw produced the
// `[FrontAppliedConvMaterializer] ... msg write failed: duplicate key value
// violates unique constraint "raw_comm_external_source_id_unique_idx"` log
// storm. createRawCommunicationOnConflictSkip closes that race by pushing the
// dedupe into the DB (ON CONFLICT (external_source_id) DO NOTHING): a conflict
// returns undefined ("skipped"), never an exception. This pin exercises the
// ON CONFLICT path DIRECTLY (the race), not the pre-check fast-path Pin F
// covers, and asserts: (1) first insert returns the row, (2) the colliding
// second insert returns undefined and does NOT throw, (3) only one row lands
// and its content is unchanged (DO NOTHING did not overwrite), (4) NULL
// external_source_id has no arbiter so it always inserts.

{
  const ISO_TABLES = ["raw_communication_records"] as const;

  await runInIsolatedSchema(
    async ({ db: _db }) => {
      // Guarantee the partial unique index exists in the isolated schema so
      // the ON CONFLICT arbiter is present regardless of dev-DB bootstrap
      // state (the index is created by raw SQL in server/index.ts, not by the
      // Drizzle schema, and bootstrap is skipped under NODE_ENV=test).
      await _db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS raw_comm_external_source_id_unique_idx
        ON raw_communication_records (external_source_id)
        WHERE external_source_id IS NOT NULL
      `);

      const base = {
        sourceType: "front_email" as const,
        sourceSubtype: "email_message" as const,
        title: "H subject",
        timestamp: new Date(IN_WINDOW_SECS * 1000),
        direction: "inbound" as const,
        externalSourceId: "h-dup-msg",
        externalThreadId: "h-conv",
        contentText: "original body",
        processingStatus: "processed" as const,
        reviewStatus: "unreviewed" as const,
      };

      const first = await createRawCommunicationOnConflictSkip(base);
      assert.ok(first, "H1: first insert returns the new row");
      assert.equal(first!.externalSourceId, "h-dup-msg", "H1: row carries the id");

      // The colliding second write (simulating the race loser) must NOT throw.
      let threw = false;
      let second: typeof first;
      try {
        second = await createRawCommunicationOnConflictSkip({
          ...base,
          contentText: "second body — should be ignored",
        });
      } catch {
        threw = true;
      }
      assert.equal(threw, false, "H2: duplicate insert does NOT throw");
      assert.equal(second, undefined, "H3: duplicate insert returns undefined (clean skip)");

      const res = await _db.execute(sql`
        SELECT external_source_id, content_text
        FROM raw_communication_records
        WHERE external_source_id = ${"h-dup-msg"}
      `);
      const rows = ((res as any).rows ?? (res as unknown as any[])) as any[];
      assert.equal(rows.length, 1, "H4: exactly one row exists after the collision");
      assert.equal(
        rows[0].content_text,
        "original body",
        "H5: DO NOTHING did not overwrite the original row",
      );

      // NULL external_source_id has no arbiter — every call inserts.
      const n1 = await createRawCommunicationOnConflictSkip({
        ...base,
        externalSourceId: undefined,
      });
      const n2 = await createRawCommunicationOnConflictSkip({
        ...base,
        externalSourceId: undefined,
      });
      assert.ok(n1 && n2, "H6: NULL external_source_id always inserts (no conflict arbiter)");
      assert.notEqual(n1!.id, n2!.id, "H6: two distinct rows for NULL external_source_id");
    },
    { tables: ISO_TABLES },
  );

  ok("H: duplicate external_source_id is a clean skip (ON CONFLICT DO NOTHING, no throw)");
}

// ── Pin I: materializer progress counts even when Step 3 ingested 0 (Task #2711) ─
//
// Scenario the task guards against: the "Bring it to 100%" button is pressed
// while a month's materialization is still finishing. On the tick that finally
// exhausts the materializer (materializeDone=true), Step 2.5 inserted real
// per-message rows (materializeInserted > 0) but Step 3
// (`runTargetedWindowBackfill`) returns ingested = 0 because every conversation
// in the window is already `applied` in front_sync_emails (100%
// duplicate_ignored). `reachFrontCoverageFullForMonth` accumulates BOTH into
// `ingested` (let ingested = materializeInserted; ingested += cp.ingested), so
// `deriveCoverageConvergenceOutcome` must still report "progress" — NOT
// "unreachable" — so the sweep does not prematurely retire a month that is still
// making real per-message progress.

{
  const { deriveCoverageConvergenceOutcome } = await import(
    "../server/services/frontAnalyticsCoverage"
  );

  // The exact Task #2711 case: materializer inserted rows (folded into
  // ingested), Step 3 found nothing new (cp.ingested=0), coverage % did not
  // move yet, grain unchanged, auth healthy, recovery did not throw.
  const progressOutcome = deriveCoverageConvergenceOutcome({
    before: 42,
    after: 42, // applied % unchanged this tick
    ingested: 17, // materializeInserted=17 + cp.ingested=0
    grainAdvanced: false,
    authBlocked: false,
    status: "ok", // Step 3 ran cleanly (resolved 100% duplicate_ignored)
  });
  assert.equal(
    progressOutcome,
    "progress",
    "I1: materializer inserts (ingested>0) with Step 3 ingested=0 ⇒ progress, not unreachable",
  );

  // Contrast: a genuinely clean drive with ZERO progress on every signal is
  // the only case that should retire the month as unreachable.
  const unreachableOutcome = deriveCoverageConvergenceOutcome({
    before: 42,
    after: 42,
    ingested: 0,
    grainAdvanced: false,
    authBlocked: false,
    status: "ok",
  });
  assert.equal(
    unreachableOutcome,
    "unreachable",
    "I2: no progress on any signal (ingested=0) ⇒ unreachable (contrast case)",
  );

  ok("I: ingested accumulates materializer + recovery; materializer-only progress ⇒ progress (Task #2711)");
}

// ── Pin J: formatMaterializationProgressDetail — N of M vs N so far vs "" ──
//
// Task #2710 — surfaces the per-month materializer progress in the Front
// Console / prod-action detail. The formatter is pure: it must emit "N of M
// conversations done" once the conversation total is known (search exhausted),
// "N conversations done so far" while still discovering, and "" for no work.

{
  assert.equal(
    formatMaterializationProgressDetail([]),
    "",
    "I1: empty list formats to empty string (append-safe)",
  );

  assert.equal(
    formatMaterializationProgressDetail([
      { month: "2025-09", done: 1200, total: 3737 },
    ]),
    "materializing messages for 2025-09: 1,200 of 3,737 conversations done",
    "I2: known total → 'N of M conversations done' with thousands separators",
  );

  assert.equal(
    formatMaterializationProgressDetail([
      { month: "2025-09", done: 50, total: null },
    ]),
    "materializing messages for 2025-09: 50 conversations done so far",
    "I3: unknown total (still discovering) → 'N conversations done so far'",
  );

  assert.equal(
    formatMaterializationProgressDetail([
      { month: "2025-08", done: 10, total: 20 },
      { month: "2025-09", done: 5, total: null },
    ]),
    "materializing messages for 2025-08: 10 of 20 conversations done; materializing messages for 2025-09: 5 conversations done so far",
    "I4: multiple months joined with '; '",
  );

  ok("J: formatMaterializationProgressDetail covers known/unknown total and empty");
}

// ── Pin K: listActiveMaterializationProgress — parse, skip, sort, derive M ──
//
// Pure against a fake DB executor (no real DB): it must skip cleared/blank and
// corrupt checkpoints, derive the total only when search is exhausted
// (searchStarted && searchNextUrl null), and sort months ascending.

{
  const mk = (cp: Partial<EnumerationCheckpoint> | null): string =>
    cp === null ? "" : JSON.stringify(cp);

  const fakeDb = {
    execute: async (_q: unknown) => ({
      rows: [
        // 2025-09: search exhausted → total = processed(2) + pending(3) = 5
        {
          key: `${CHECKPOINT_KEY_PREFIX}2025-09`,
          value: mk({
            searchStarted: true,
            searchNextUrl: null,
            pendingConversationIds: ["a", "b", "c"],
            processedConversationCount: 2,
          }),
        },
        // 2025-07: search still running → total unknown (null)
        {
          key: `${CHECKPOINT_KEY_PREFIX}2025-07`,
          value: mk({
            searchStarted: true,
            searchNextUrl: "https://api.frontapp.com/next",
            pendingConversationIds: ["x"],
            processedConversationCount: 9,
          }),
        },
        // Cleared checkpoint (month done) → skipped entirely
        { key: `${CHECKPOINT_KEY_PREFIX}2025-06`, value: "" },
        // Corrupt JSON → skipped entirely
        { key: `${CHECKPOINT_KEY_PREFIX}2025-05`, value: "{not json" },
      ],
    }),
  };

  const rows = await listActiveMaterializationProgress(fakeDb as any);

  assert.equal(rows.length, 2, "J1: cleared + corrupt rows are skipped");
  assert.equal(rows[0].month, "2025-07", "J2: sorted ascending (2025-07 first)");
  assert.equal(rows[1].month, "2025-09", "J2: sorted ascending (2025-09 second)");

  const sep = rows.find((r) => r.month === "2025-09")!;
  assert.equal(sep.done, 2, "J3: done = processedConversationCount");
  assert.equal(sep.total, 5, "J3: total = processed + pending when search exhausted");

  const jul = rows.find((r) => r.month === "2025-07")!;
  assert.equal(jul.done, 9, "J4: done while discovering");
  assert.equal(jul.total, null, "J4: total null while search still running");

  ok("K: listActiveMaterializationProgress skips blank/corrupt, derives total, sorts");
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} test(s) passed.\n`);
if (passed < 12) {
  console.error("Not all tests passed");
  process.exit(1);
}
