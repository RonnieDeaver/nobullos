/* test-registration
{
  "name": "Front reconciliation hydration + per-message materialization (Task #3889)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3889: the reconciliation poller is the only Front feed that runs day-to-day, and before this fix every one of its envelopes landed direction='internal' (Front's conversation-list API sends no last_message payload), so Going Quiet / daily judgment / coverage saw ZERO live inbound signal — the root cause of the 54/56 false 'going quiet' flags. Pins: hydration stamps the envelope's direction/timestamp/messageId from the conversation's real latest message AND materializes dedupe-safe per-message email_message rows; the front_sync_emails mirror carries the hydrated timestamp; re-normalizing the same conversation skips already-present rows; breaker-open, switch-off, and hydration-failure paths all degrade to the legacy internal envelope (never a fabricated direction, never materialized rows). A drift here silently re-blinds the live inbound feed.",
  "tier": "small"
}
test-registration */
/**
 * Task #3889 — reconciliation hydration coverage.
 *
 * `normalizeReconciliationEvent` processes `source_event_log` rows written
 * by the reconciliation poller. Front's `GET /conversations` list API
 * returns NO `last_message` payload, so historically every envelope fell
 * through to direction='internal' with the conversation's created_at as
 * the timestamp — zero inbound signal from the one Front feed that still
 * runs day-to-day. The fix hydrates the conversation's real messages
 * (test seam: __setReconciliationHydrationOverrideForTest — the real
 * fetch goes through frontIntegration.hydrateConversationSnapshot with
 * its per-version snapshot cache) and this test pins:
 *
 *   (A) Hydrated envelope: direction/timestamp/messageId/preview come
 *       from the REAL latest message (inbound here), one email_message
 *       row per hydrated message lands in raw_communication_records
 *       (source 'reconciliation_per_message_materialization'), and the
 *       front_sync_emails mirror carries the hydrated timestamp.
 *   (B) Idempotency: a second event for the same conversation re-runs
 *       hydration but materializes nothing new (dedupe on
 *       external_source_id), and the envelope stays correct.
 *   (C) Breaker-open: hydration is SKIPPED entirely (the fake would
 *       throw), the envelope keeps the legacy internal/created_at shape,
 *       no message rows are written.
 *   (D) Kill switch OFF (front_reconciliation_per_message_materialization_enabled):
 *       same legacy behavior, hydration never invoked.
 *   (E) Hydration failure (fetch throws): logged + swallowed, legacy
 *       internal envelope, no message rows — never a fabricated
 *       direction.
 *
 * All rows are per-run suffixed and deleted in finally (source_event_log,
 * work_result_log, work_queue apply jobs, raw_communication_records,
 * front_sync_emails). The pool-epic switch and auth breaker are restored
 * in finally.
 */

import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  normalizeReconciliationEvent,
  __setReconciliationHydrationOverrideForTest,
} from "../server/services/frontWebhookIngestion";
import {
  setPoolEpicSwitch,
  __resetPoolEpicSwitchesForTest,
} from "../server/services/poolEpicKillSwitches";
import {
  __setFrontAuthStateForTest,
  __resetFrontAuthBreakerForTest,
} from "../server/services/frontAuthBreaker";

const RUN = `t3889r-${randomBytes(4).toString("hex")}`;

const CONV_A = `cnv_${RUN}_a`;
const CONV_C = `cnv_${RUN}_c`;
const CONV_D = `cnv_${RUN}_d`;
const CONV_E = `cnv_${RUN}_e`;
const ALL_CONVS = [CONV_A, CONV_C, CONV_D, CONV_E];

const CONV_CREATED_SEC = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000);
const T_OUT_SEC = Math.floor(Date.parse("2026-08-03T09:00:00Z") / 1000);
const T_IN_SEC = Math.floor(Date.parse("2026-08-04T15:30:00Z") / 1000);

const MSG_OUT = {
  id: `msg_${RUN}_out`,
  is_inbound: false,
  created_at: T_OUT_SEC,
  body: "<p>our reply to the client</p>",
  author: { email: "am@nobull.example", username: "am" },
  recipients: [{ handle: "client@firm.example", role: "to" }],
};
const MSG_IN = {
  id: `msg_${RUN}_in`,
  is_inbound: true,
  created_at: T_IN_SEC,
  body: "<p>client writes in with a question</p>",
  recipients: [{ handle: "team@nobull.example", role: "to" }],
};

const SWITCH = "front_reconciliation_per_message_materialization_enabled" as const;

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
  }
}

function convPayload(convId: string): any {
  // Mirrors what the reconciliation poller stores from GET /conversations:
  // NO last_message payload — only metadata (the regression under test).
  return {
    id: convId,
    subject: `${RUN} hydration subject`,
    created_at: CONV_CREATED_SEC,
    recipient: { handle: "client@firm.example", name: "Client", role: "from" },
    _links: { related: {} },
  };
}

async function seedEvent(convId: string, dedupeSuffix: string): Promise<string> {
  const r: any = await db.execute(sql`
    INSERT INTO source_event_log
      (source_system, source_event_type, source_object_id, dedupe_key, payload_json, status)
    VALUES
      ('front', 'reconciliation_scan', ${convId}, ${`${RUN}-${dedupeSuffix}`},
       ${JSON.stringify(convPayload(convId))}::jsonb, 'received')
    RETURNING id
  `);
  const id = (Array.isArray(r) ? r : r?.rows ?? [])[0]?.id;
  if (!id) throw new Error("failed to seed source_event_log row");
  return String(id);
}

async function messageRows(convId: string): Promise<any[]> {
  const r: any = await db.execute(sql`
    SELECT external_source_id, direction, timestamp, source_subtype, raw_payload_json
    FROM raw_communication_records
    WHERE external_thread_id = ${convId} AND source_subtype = 'email_message'
    ORDER BY timestamp
  `);
  return (r as any).rows ?? [];
}

async function cleanup(eventIds: string[]): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM work_queue WHERE dedupe_key IN (${sql.join(eventIds.map((id) => sql`${`apply:${id}`}`), sql`, `)})`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM work_result_log WHERE source_event_id IN (${sql.join(eventIds.map((id) => sql`${id}`), sql`, `)})`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM source_event_log WHERE id IN (${sql.join(eventIds.map((id) => sql`${id}`), sql`, `)})`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM raw_communication_records WHERE external_thread_id IN (${sql.join(ALL_CONVS.map((c) => sql`${c}`), sql`, `)})`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM front_sync_emails WHERE conversation_id IN (${sql.join(ALL_CONVS.map((c) => sql`${c}`), sql`, `)})`);
  } catch {}
}

async function main(): Promise<void> {
  console.log(`Front reconciliation hydration coverage (Task #3889) [${RUN}]`);

  const eventIds: string[] = [];
  let hydrateCalls = 0;

  try {
    // ── (A) hydrated envelope + materialized rows ──
    await step("hydrated envelope: direction/timestamp/preview from the real latest message", async () => {
      __setReconciliationHydrationOverrideForTest(async () => {
        hydrateCalls += 1;
        return { messages: [MSG_OUT, MSG_IN] };
      });
      const id = await seedEvent(CONV_A, "a1");
      eventIds.push(id);
      const normalized = await normalizeReconciliationEvent(id);
      assert(normalized, "normalize returned a result");
      assertEq(normalized!.direction, "inbound", "direction from the latest (inbound) message");
      assertEq(normalized!.messageId, MSG_IN.id, "messageId from the latest message");
      assertEq(normalized!.timestamp.getTime(), T_IN_SEC * 1000, "timestamp from the latest message");
      assert(
        normalized!.contentPreview.includes("client writes in"),
        "preview from the latest message body",
      );
      assertEq(hydrateCalls, 1, "hydration invoked once");
    });

    await step("per-message email_message rows materialized (both directions)", async () => {
      const rows = await messageRows(CONV_A);
      assertEq(rows.length, 2, "one row per hydrated message");
      const byId = new Map(rows.map((r: any) => [r.external_source_id, r]));
      assertEq(byId.get(MSG_IN.id)?.direction, "inbound", "inbound message row direction");
      assertEq(byId.get(MSG_OUT.id)?.direction, "outbound", "outbound message row direction");
      assertEq(
        new Date(byId.get(MSG_IN.id)?.timestamp).getTime(),
        T_IN_SEC * 1000,
        "message row keeps the real message timestamp",
      );
      assertEq(
        byId.get(MSG_IN.id)?.raw_payload_json?.source,
        "reconciliation_per_message_materialization",
        "row is attributed to the reconciliation materializer",
      );
    });

    await step("front_sync_emails mirror carries the hydrated timestamp", async () => {
      const r: any = await db.execute(sql`
        SELECT last_message_at, last_message_id FROM front_sync_emails WHERE conversation_id = ${CONV_A}
      `);
      const row = (r as any).rows?.[0];
      assert(row, "mirror row exists");
      assertEq(new Date(row.last_message_at).getTime(), T_IN_SEC * 1000, "mirror last_message_at");
      assertEq(row.last_message_id, MSG_IN.id, "mirror last_message_id");
    });

    // ── (B) idempotency on re-poll ──
    await step("second event for the same conversation: hydrates again, materializes nothing new", async () => {
      const id = await seedEvent(CONV_A, "a2");
      eventIds.push(id);
      const normalized = await normalizeReconciliationEvent(id);
      assertEq(normalized?.direction, "inbound", "envelope still hydrated");
      assertEq(hydrateCalls, 2, "hydration invoked for the new event");
      const rows = await messageRows(CONV_A);
      assertEq(rows.length, 2, "no duplicate message rows (external_source_id dedupe)");
    });

    // ── (C) breaker-open skips hydration entirely ──
    await step("breaker open: legacy internal envelope, hydration never invoked, no rows", async () => {
      __setReconciliationHydrationOverrideForTest(async () => {
        throw new Error("hydration must not be called while the breaker is open");
      });
      __setFrontAuthStateForTest({ breakerOpenUntilMs: Date.now() + 60_000 });
      try {
        const id = await seedEvent(CONV_C, "c1");
        eventIds.push(id);
        const normalized = await normalizeReconciliationEvent(id);
        assertEq(normalized?.direction, "internal", "legacy internal direction");
        assertEq(
          normalized?.timestamp.getTime(),
          CONV_CREATED_SEC * 1000,
          "legacy created_at timestamp",
        );
        assertEq(normalized?.messageId, null, "no message id without a payload");
        assertEq((await messageRows(CONV_C)).length, 0, "no materialized rows");
      } finally {
        __resetFrontAuthBreakerForTest();
      }
    });

    // ── (D) kill switch OFF ──
    await step("materialization switch OFF: legacy internal envelope, hydration never invoked", async () => {
      __setReconciliationHydrationOverrideForTest(async () => {
        throw new Error("hydration must not be called while the switch is off");
      });
      await setPoolEpicSwitch(SWITCH, false);
      try {
        const id = await seedEvent(CONV_D, "d1");
        eventIds.push(id);
        const normalized = await normalizeReconciliationEvent(id);
        assertEq(normalized?.direction, "internal", "legacy internal direction");
        assertEq((await messageRows(CONV_D)).length, 0, "no materialized rows");
      } finally {
        await setPoolEpicSwitch(SWITCH, true);
      }
    });

    // ── (E) hydration failure degrades to legacy shape ──
    await step("hydration failure: swallowed, legacy internal envelope, no rows", async () => {
      __setReconciliationHydrationOverrideForTest(async () => {
        throw new Error(`${RUN} simulated Front fetch failure`);
      });
      const id = await seedEvent(CONV_E, "e1");
      eventIds.push(id);
      const normalized = await normalizeReconciliationEvent(id);
      assert(normalized, "normalize still completes");
      assertEq(normalized!.direction, "internal", "legacy internal direction on failure");
      assertEq((await messageRows(CONV_E)).length, 0, "no materialized rows on failure");
    });
  } finally {
    __setReconciliationHydrationOverrideForTest(null);
    __resetFrontAuthBreakerForTest();
    __resetPoolEpicSwitchesForTest();
    await cleanup(eventIds);
  }

  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll front-reconciliation-hydration tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit(); a
// leaked handle surfaces as a hang instead of being masked by a forced exit.
let exitCode = 0;
main()
  .catch((err) => {
    console.error("front-reconciliation-hydration: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
