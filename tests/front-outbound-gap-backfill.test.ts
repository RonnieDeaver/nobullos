/* test-registration
{
  "name": "Front outbound gap-backfill driver \u2014 message-grain repair (Task #2010)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2010 — Fill in missing outbound messages, not just count them.
 *
 * Pins the message-grain outbound-gap BACKFILL driver — the cheaper
 * counterpart to Task #1984's whole-month recovery close-gap. It runs
 * ONE bounded enumeration-walk tick per gap month (collecting the
 * in-window outbound messages), dedupes them against
 * `raw_communication_records.external_source_id`, and writes only the
 * genuinely-missing rows through the shared ingestion helper.
 *
 * Deterministic units (no live Front needed — the enumeration walk is
 * stubbed via its test override; the materialize helper writes to the
 * real test DB):
 *   1. The client walk's opt-in `collectOutboundMessages` captures ONLY
 *      in-window outbound messages (with conversation id + subject) and
 *      leaves the measurement-only contract unchanged when off.
 *   2. `runOutboundGapBackfillTick` no-ops with a reason when the master
 *      enable setting is OFF (default) — never writes.
 *   3. Enabled + a real gap → the collected outbound messages are
 *      written once, the month finishes, the checkpoint is cleared.
 *   4. A second pass dedupes (idempotent): re-collected messages insert
 *      nothing.
 *   5. A fresh local count that already covers the Front count →
 *      `already_closed`, no walk.
 *   6. A non-`done` tick persists the checkpoint and reports
 *      `backfilled` (resumable).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  setSystemSetting,
  getSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import {
  enumerateMonthlyMessagesByDirectionTick,
  __frontAnalyticsClientTestHelpers,
  type EnumerationTickResult,
  type CollectedOutboundMessage,
} from "../server/services/frontAnalyticsClient";
import {
  runOutboundGapBackfillTick,
  getLastOutboundGapBackfillRun,
  SETTING_ENABLED,
  SETTING_LAST_RUN,
  MATERIALIZATION_SOURCE,
  __frontOutboundGapBackfillTestHelpers,
} from "../server/services/frontOutboundGapBackfill";

const Y = 2989; // far-future months — never collide with real coverage rows
const ID_PREFIX = "msg_t2010_";
const CONV_PREFIX = "cnv_t2010_";

const noSleep = async (_ms: number): Promise<void> => {};

function monthBounds(month: string): { start: Date; end: Date } {
  const [yy, mm] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(yy, mm - 1, 1)),
    end: new Date(Date.UTC(yy, mm, 1)),
  };
}

async function upsertCoverage(
  month: string,
  outboundFront: number | null,
  outboundLocal: number | null,
  outboundGap: number | null,
): Promise<void> {
  const { start, end } = monthBounds(month);
  await db.execute(sql`
    INSERT INTO front_analytics_monthly_coverage
      (month, month_start, month_end, messages_outbound_front,
       messages_outbound_local, messages_outbound_gap)
    VALUES (${month}, ${start.toISOString()}, ${end.toISOString()},
            ${outboundFront}, ${outboundLocal}, ${outboundGap})
    ON CONFLICT (month) DO UPDATE SET
      messages_outbound_front = EXCLUDED.messages_outbound_front,
      messages_outbound_local = EXCLUDED.messages_outbound_local,
      messages_outbound_gap   = EXCLUDED.messages_outbound_gap
  `);
}

async function countWrittenRows(): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM raw_communication_records
    WHERE external_source_id LIKE ${`${ID_PREFIX}%`}
  `);
  const r = ((rows as any).rows ?? (rows as unknown as any[]))[0];
  return Number(r?.n ?? 0) || 0;
}

async function insertOutboundRow(
  externalSourceId: string,
  ts: Date,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO raw_communication_records
      (source_type, title, timestamp, direction, external_source_id)
    VALUES ('front_email', 'task-2010 fixture', ${ts.toISOString()},
            'outbound', ${externalSourceId})
  `);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage WHERE month LIKE ${`${Y}-%`}
  `);
  await db.execute(sql`
    DELETE FROM raw_communication_records
    WHERE external_source_id LIKE ${`${ID_PREFIX}%`}
  `);
}

/** A canned outbound message in the form the walk collects. */
function collected(
  month: string,
  n: number,
): CollectedOutboundMessage {
  const { start } = monthBounds(month);
  const tsSec = Math.floor(start.getTime() / 1000) + n * 60 + 60;
  return {
    conversationId: `${CONV_PREFIX}${month}`,
    conversationSubject: `Subject ${n}`,
    message: {
      id: `${ID_PREFIX}${month}_${n}`,
      is_inbound: false,
      created_at: tsSec,
      body: `<p>body ${n}</p>`,
      author: { username: "agent", email: "agent@firm.test" },
      recipients: [{ name: "Client", handle: "client@x.test", role: "to" }],
    },
  };
}

/** Install an enumeration-walk override that returns a canned tick. */
function stubWalk(result: Partial<EnumerationTickResult> & { done: boolean }) {
  __frontAnalyticsClientTestHelpers.setEnumerationOverride(async () => ({
    checkpoint: {
      searchStarted: true,
      searchNextUrl: null,
      pendingConversationIds: [],
      processedConversationCount: 0,
      inboundCount: 0,
      outboundCount: 0,
      truncated: false,
      ...(result.checkpoint as any),
    } as any,
    conversationsProcessedThisTick: 0,
    searchPagesFetchedThisTick: 0,
    messagePagesFetchedThisTick: 0,
    ...result,
  }));
}

test("Task #2010 outbound-gap backfill", async (t) => {
  await cleanup();
  // Snapshot + restore the master switch + last-run key so a loaded dev
  // DB is left as we found it.
  const savedEnabled = (await getSystemSetting(SETTING_ENABLED).catch(() => null))
    ?.value;
  const savedLastRun = (await getSystemSetting(SETTING_LAST_RUN).catch(() => null))
    ?.value;

  t.after(async () => {
    __frontAnalyticsClientTestHelpers.setEnumerationOverride(null);
    await cleanup();
    if (savedEnabled == null) await deleteSystemSetting(SETTING_ENABLED);
    else await setSystemSetting(SETTING_ENABLED, savedEnabled, "system");
    if (savedLastRun == null) await deleteSystemSetting(SETTING_LAST_RUN);
    else await setSystemSetting(SETTING_LAST_RUN, savedLastRun, "system");
  });

  // ── 1. The client walk's opt-in collection captures only in-window
  //       outbound messages, with conversation id + subject. ──────────
  await t.test("walk collectOutboundMessages opt-in", async () => {
    const month = `${Y}-03`;
    const { start, end } = monthBounds(month);
    const inWin = Math.floor(start.getTime() / 1000) + 3600;
    const outWin = Math.floor(end.getTime() / 1000) + 3600; // next month
    const fetcher = async (path: string): Promise<Response> => {
      const json = (o: unknown) =>
        new Response(JSON.stringify(o), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (path.includes("/conversations/search/")) {
        return json({
          _results: [{ id: "cA", subject: "Hello A" }],
          _pagination: { next: null },
        });
      }
      if (/\/conversations\/[^/]+\/messages/.test(path)) {
        return json({
          _results: [
            { id: "m_in", is_inbound: true, created_at: inWin },
            { id: "m_out1", is_inbound: false, created_at: inWin + 10 },
            { id: "m_out2", is_inbound: false, created_at: inWin + 20 },
            { id: "m_out_oob", is_inbound: false, created_at: outWin },
          ],
          _pagination: { next: null },
        });
      }
      return new Response("not found", { status: 404 });
    };

    // OFF (default): no collection, measurement contract unchanged.
    const off = await enumerateMonthlyMessagesByDirectionTick({
      monthStart: start,
      monthEnd: end,
      fetcher,
      sleep: noSleep,
    });
    assert.equal(off.outboundMessagesThisTick, undefined);
    assert.equal(off.checkpoint.outboundCount, 2);

    // ON: only the 2 in-window OUTBOUND messages, with conv id + subject.
    const on = await enumerateMonthlyMessagesByDirectionTick({
      monthStart: start,
      monthEnd: end,
      fetcher,
      sleep: noSleep,
      collectOutboundMessages: true,
    });
    const got = on.outboundMessagesThisTick ?? [];
    assert.equal(got.length, 2, "only in-window outbound collected");
    assert.deepEqual(
      got.map((g) => g.message.id).sort(),
      ["m_out1", "m_out2"],
    );
    assert.equal(got[0].conversationId, "cA");
    assert.equal(got[0].conversationSubject, "Hello A");
  });

  // ── 2. Master switch OFF → no-op, no writes. ─────────────────────
  await t.test("disabled → reason, no writes", async () => {
    const month = `${Y}-04`;
    await upsertCoverage(month, 3, 0, 3);
    await setSystemSetting(SETTING_ENABLED, "false", "system");
    let walked = false;
    stubWalk({ done: true });
    __frontAnalyticsClientTestHelpers.setEnumerationOverride(async () => {
      walked = true;
      return {
        checkpoint: {} as any,
        done: true,
        conversationsProcessedThisTick: 0,
        searchPagesFetchedThisTick: 0,
        messagePagesFetchedThisTick: 0,
      };
    });
    const r = await runOutboundGapBackfillTick({ month });
    assert.equal(r.enabled, false);
    assert.match(r.reason ?? "", /disabled/);
    assert.equal(walked, false, "walk never runs while disabled");
    assert.equal(await countWrittenRows(), 0);
  });

  // ── 3. Enabled + real gap → writes once, finishes, clears checkpoint.
  await t.test("enabled gap → writes + month_complete", async () => {
    const month = `${Y}-05`;
    await upsertCoverage(month, 3, 0, 3);
    await setSystemSetting(SETTING_ENABLED, "true", "system");
    stubWalk({
      done: true,
      outboundMessagesThisTick: [
        collected(month, 1),
        collected(month, 2),
        collected(month, 3),
      ],
    });
    const r = await runOutboundGapBackfillTick({ month });
    const a = r.attempted.find((x) => x.month === month)!;
    assert.equal(a.outcome, "month_complete");
    assert.equal(a.inserted, 3);
    assert.equal(a.skipped, 0);
    assert.equal(a.done, true);
    assert.equal(await countWrittenRows(), 3);
    // Checkpoint cleared on completion.
    const cp = await getSystemSetting(
      __frontOutboundGapBackfillTestHelpers.checkpointKey(month),
    ).catch(() => null);
    assert.ok(!cp?.value, "checkpoint cleared when done");
    // Rows carry this driver's source tag.
    const rows = await db.execute(sql`
      SELECT raw_payload_json FROM raw_communication_records
      WHERE external_source_id = ${`${ID_PREFIX}${month}_1`} LIMIT 1
    `);
    const row = ((rows as any).rows ?? (rows as unknown as any[]))[0];
    assert.equal(row?.raw_payload_json?.source, MATERIALIZATION_SOURCE);
    // Last-run summary persisted.
    const last = await getLastOutboundGapBackfillRun();
    assert.ok(last && last.enabled === true);
  });

  // ── 4. Idempotent: a second pass re-collecting the same ids writes
  //       nothing (dedupe on external_source_id). ───────────────────
  await t.test("second pass dedupes", async () => {
    const month = `${Y}-05`;
    // Gap still positive vs the now-3 local rows so the walk re-runs.
    await upsertCoverage(month, 6, 0, 6);
    stubWalk({
      done: true,
      outboundMessagesThisTick: [
        collected(month, 1),
        collected(month, 2),
        collected(month, 3),
      ],
    });
    const r = await runOutboundGapBackfillTick({ month });
    const a = r.attempted.find((x) => x.month === month)!;
    assert.equal(a.inserted, 0, "all re-collected ids already present");
    assert.equal(a.skipped, 3);
    assert.equal(await countWrittenRows(), 3, "no duplicate rows written");
  });

  // ── 5. Fresh local count already covers Front → already_closed. ──
  await t.test("already_closed when local caught up", async () => {
    const month = `${Y}-06`;
    const { start } = monthBounds(month);
    await insertOutboundRow(`${ID_PREFIX}${month}_pre1`, new Date(start.getTime() + 3600_000));
    await insertOutboundRow(`${ID_PREFIX}${month}_pre2`, new Date(start.getTime() + 7200_000));
    await upsertCoverage(month, 2, 0, 2); // stored gap stale; fresh local = 2
    let walked = false;
    __frontAnalyticsClientTestHelpers.setEnumerationOverride(async () => {
      walked = true;
      return {
        checkpoint: {} as any,
        done: true,
        conversationsProcessedThisTick: 0,
        searchPagesFetchedThisTick: 0,
        messagePagesFetchedThisTick: 0,
      };
    });
    const r = await runOutboundGapBackfillTick({ month });
    const a = r.attempted.find((x) => x.month === month)!;
    assert.equal(a.outcome, "already_closed");
    assert.equal(walked, false, "no walk when the gap is already closed");
  });

  // ── 6. Non-done tick persists the checkpoint (resumable). ────────
  await t.test("non-done tick persists checkpoint", async () => {
    const month = `${Y}-07`;
    await upsertCoverage(month, 50, 0, 50);
    stubWalk({
      done: false,
      checkpoint: {
        searchStarted: true,
        searchNextUrl: "/conversations/search/x?page_token=1",
        pendingConversationIds: ["cZ"],
        processedConversationCount: 5,
        inboundCount: 0,
        outboundCount: 1,
        truncated: false,
      } as any,
      outboundMessagesThisTick: [collected(month, 1)],
    });
    const r = await runOutboundGapBackfillTick({ month });
    const a = r.attempted.find((x) => x.month === month)!;
    assert.equal(a.outcome, "backfilled");
    assert.equal(a.done, false);
    assert.equal(a.inserted, 1);
    const cp = await getSystemSetting(
      __frontOutboundGapBackfillTestHelpers.checkpointKey(month),
    ).catch(() => null);
    assert.ok(cp?.value, "checkpoint persisted for resume");
    const parsed = JSON.parse(cp!.value);
    assert.deepEqual(parsed.pendingConversationIds, ["cZ"]);
  });
});
