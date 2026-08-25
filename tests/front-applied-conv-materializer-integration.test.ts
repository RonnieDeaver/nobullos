/* test-registration
{
  "name": "Front applied-conv materializer — end-to-end rows land in DB (Task #2709)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2709: integrated end-to-end proof that the materializer tick actually commits raw_communication_records rows (the smoke test above only proves the enumeration tick returns the right counts). Closes the \"counts right\" vs \"rows actually land\" gap that would otherwise leave coverage silently stuck.",
  "tier": "small"
}
test-registration */
/**
 * Task #2709 — Integrated verification that historical Front messages
 * actually land in `raw_communication_records` after the applied-conversation
 * materializer tick runs end-to-end.
 *
 * Task #2708 added Step 2.5 (`materializeAppliedConvMessagesForMonthTick`) to
 * `reachFrontCoverageFullForMonth`, plus a smoke test proving the enumeration
 * tick collects both directions. What that smoke test did NOT prove is the
 * full integrated path: enumeration → `materializeFrontMessageRecord` →
 * actual `raw_communication_records` rows committed to the DB. This suite
 * closes that gap.
 *
 * Strategy:
 *   - Stub the enumeration walk via
 *     `__frontAnalyticsClientTestHelpers.setEnumerationOverride` so no Front
 *     call happens — it returns a fixed set of fake messages in
 *     `allMessagesThisTick` (the field the materializer consumes when it
 *     passes `collectAllMessages: true`).
 *   - Run the tick through the REAL `materializeFrontMessageRecord` (no
 *     materializer override) so the genuine storage write path executes.
 *
 * Isolation (Task #1929 pattern): everything runs inside
 * `runInIsolatedSchema` with `raw_communication_records` cloned, so the live
 * `Start application` workers (default search_path = public) can neither see
 * nor race-write the rows the test creates, and the test leaves no rows
 * behind.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import {
  materializeAppliedConvMessagesForMonthTick,
  MATERIALIZATION_SOURCE,
} from "../server/services/frontAppliedConvMaterializer";
import {
  __frontAnalyticsClientTestHelpers,
  type CollectedOutboundMessage,
  type EnumerationCheckpoint,
  type EnumerationTickResult,
  type FrontRawMessage,
} from "../server/services/frontAnalyticsClient";
import { runInIsolatedSchema } from "./db-sandbox";

const TABLES = ["raw_communication_records"] as const;

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

// June 2026 window — the month under test. Only used by the materializer for
// logging + a fallback timestamp; the stubbed enumeration ignores it.
const MONTH = "2026-06";
const MONTH_START = new Date(Date.UTC(2026, 5, 1));
const MONTH_END = new Date(Date.UTC(2026, 6, 1));
const CONV_ID = "cnv_applied_materializer";

// Three in-window messages: two inbound, one outbound, each with a distinct
// `created_at` so the materialized rows get real (not fallback) timestamps.
const FAKE_MESSAGES: CollectedOutboundMessage[] = [
  {
    conversationId: CONV_ID,
    conversationSubject: "Re: Q2 marketing review",
    message: {
      id: "msg_inbound_1",
      is_inbound: true,
      created_at: Math.floor(Date.UTC(2026, 5, 3, 9, 0) / 1000),
      body: "<p>Hi team, here is our update.</p>",
      author: { username: "Client Alice", email: "alice@lawfirm.test" },
      recipients: [{ name: "Agent Bob", handle: "bob@nobull.test", role: "to" }],
    } satisfies FrontRawMessage,
  },
  {
    conversationId: CONV_ID,
    conversationSubject: "Re: Q2 marketing review",
    message: {
      id: "msg_outbound_1",
      is_inbound: false,
      created_at: Math.floor(Date.UTC(2026, 5, 3, 10, 0) / 1000),
      body: "<p>Thanks Alice, reviewing now.</p>",
      author: { username: "Agent Bob", email: "bob@nobull.test" },
      recipients: [{ name: "Client Alice", handle: "alice@lawfirm.test", role: "to" }],
    } satisfies FrontRawMessage,
  },
  {
    conversationId: CONV_ID,
    conversationSubject: "Re: Q2 marketing review",
    message: {
      id: "msg_inbound_2",
      is_inbound: true,
      created_at: Math.floor(Date.UTC(2026, 5, 4, 8, 30) / 1000),
      body: "<p>One more question about the report.</p>",
      author: { username: "Client Alice", email: "alice@lawfirm.test" },
      recipients: [{ name: "Agent Bob", handle: "bob@nobull.test", role: "to" }],
    } satisfies FrontRawMessage,
  },
];

const EXPECTED_MESSAGE_COUNT = FAKE_MESSAGES.length;

function fakeCheckpoint(): EnumerationCheckpoint {
  return {
    searchNextUrl: null,
    searchStarted: true,
    pendingConversationIds: [],
    inboundCount: 2,
    outboundCount: 1,
    processedConversationCount: 1,
    truncated: false,
    mergedAwayCanonicalIds: [],
  };
}

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

async function getRow(
  isoDb: IsoDb,
  externalSourceId: string,
): Promise<{
  source_type: string;
  source_subtype: string;
  processing_status: string;
  client_id: string | null;
  direction: string;
  external_thread_id: string | null;
  raw_payload_json: any;
} | undefined> {
  const res = await isoDb.execute(sql`
    SELECT source_type, source_subtype, processing_status, client_id, direction,
           external_thread_id, raw_payload_json
    FROM raw_communication_records WHERE external_source_id = ${externalSourceId}
  `);
  const rows = ((res as any).rows ?? (res as unknown as any[])) as any[];
  return rows[0];
}

async function countRows(isoDb: IsoDb): Promise<number> {
  const res = await isoDb.execute(sql`
    SELECT COUNT(*)::int AS n FROM raw_communication_records
  `);
  const rows = ((res as any).rows ?? (res as unknown as any[])) as any[];
  return Number(rows[0]?.n) || 0;
}

async function main(): Promise<void> {
  // Stub the enumeration walk so no Front call happens and the materializer
  // sees a fixed set of fake messages. Returns the same set every tick so we
  // can also prove the second call is a no-op via the per-message dedup.
  __frontAnalyticsClientTestHelpers.setEnumerationOverride(async (): Promise<EnumerationTickResult> => ({
    checkpoint: fakeCheckpoint(),
    done: true,
    conversationsProcessedThisTick: 1,
    searchPagesFetchedThisTick: 1,
    messagePagesFetchedThisTick: 1,
    allMessagesThisTick: FAKE_MESSAGES,
  }));

  try {
    await runInIsolatedSchema(async ({ db }) => {
      // ── First tick: the rows must actually land in raw_communication_records ──
      const first = await materializeAppliedConvMessagesForMonthTick(
        MONTH,
        MONTH_START,
        MONTH_END,
        null,
      );

      assert.equal(
        first.inserted,
        EXPECTED_MESSAGE_COUNT,
        "first tick inserts exactly one row per injected message",
      );
      assert.equal(first.skipped, 0, "first tick skips nothing");
      assert.equal(first.done, true, "tick reports done from the stubbed walk");
      ok("first tick: inserted === expectedMessageCount, skipped 0");

      assert.equal(
        await countRows(db),
        EXPECTED_MESSAGE_COUNT,
        "raw_communication_records holds one row per injected message",
      );
      ok("coverage numerator rose: one raw_communication_records row per message");

      // Each injected message produced a correctly-shaped materialized row.
      for (const item of FAKE_MESSAGES) {
        const row = await getRow(db, item.message.id!);
        assert.ok(row, `row exists for message ${item.message.id}`);
        assert.equal(row!.source_type, "front_email", "source_type is front_email");
        assert.equal(
          row!.source_subtype,
          "email_message",
          "source_subtype is email_message (per-message grain)",
        );
        assert.equal(
          row!.processing_status,
          "processed",
          "processing_status is processed (terminal, no classifier work)",
        );
        assert.equal(
          row!.external_thread_id,
          CONV_ID,
          "external_thread_id links back to the conversation",
        );
        assert.equal(
          row!.client_id,
          null,
          "no thread rollup present → row stays clientless (attribution is a separate driver)",
        );
        const payload =
          typeof row!.raw_payload_json === "string"
            ? JSON.parse(row!.raw_payload_json)
            : row!.raw_payload_json;
        assert.equal(
          payload?.source,
          MATERIALIZATION_SOURCE,
          "raw_payload_json.source stamps the applied_conv_materializer origin",
        );
        assert.equal(
          payload?.source,
          "applied_conv_materializer",
          "stamp matches the literal source label",
        );
      }
      ok("each row: front_email / email_message / processed / correct source stamp");

      // Direction is derived from is_inbound on the fake message.
      const inbound = await getRow(db, "msg_inbound_1");
      const outbound = await getRow(db, "msg_outbound_1");
      assert.equal(inbound!.direction, "inbound", "inbound message → direction inbound");
      assert.equal(outbound!.direction, "outbound", "outbound message → direction outbound");
      ok("direction derived correctly from is_inbound (both directions captured)");

      // ── Second tick: idempotent — dedup on external_source_id ──
      const second = await materializeAppliedConvMessagesForMonthTick(
        MONTH,
        MONTH_START,
        MONTH_END,
        null,
      );
      assert.equal(second.inserted, 0, "second tick inserts nothing (all already present)");
      assert.equal(
        second.skipped,
        EXPECTED_MESSAGE_COUNT,
        "second tick skips every message via external_source_id dedup",
      );
      assert.equal(
        await countRows(db),
        EXPECTED_MESSAGE_COUNT,
        "row count unchanged after the idempotent re-run",
      );
      ok("idempotent: second tick inserted=0, skipped=N, no duplicate rows");
    }, { tables: TABLES });
  } finally {
    __frontAnalyticsClientTestHelpers.setEnumerationOverride(null);
  }

  console.log(`\nfront-applied-conv-materializer-integration: ${passed} assertions passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
