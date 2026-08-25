/* test-registration
{
  "name": "Raw-comm unique index vanish — detect + self-heal + alert (Task #3703)",
  "regression": true,
  "sweepOnlyReason": "Task #3703 — DB-heavy (runInIsolatedSchema clone of raw_communication_records + real DDL drop/recreate of the arbiter index); runs in full sweep, not the gate",
  "tier": "small"
}
test-registration */
/**
 * Task #3703 — Detection + self-heal when the ON CONFLICT arbiter index
 * `raw_comm_external_source_id_unique_idx` vanishes from
 * raw_communication_records.
 *
 * Incident (Task #3697 gate run): the index silently vanished from the dev
 * DB; every Front applied-conv materializer write then failed with 42P10
 * ("no unique or exclusion constraint matching the ON CONFLICT
 * specification") and was swallowed into per-message "msg write failed"
 * warn lines — no alert, no self-heal, rows silently stopped landing.
 *
 * This suite proves the fix end-to-end in an isolated schema:
 *   (1) With the index DROPPED, a materializer tick still lands every row:
 *       the leaf writer detects the arbiter-missing error class, runs the
 *       one-shot self-heal (recreates the index), retries the insert, and
 *       fires exactly ONE infra alert (captured via the notify override) —
 *       instead of N silent per-message failures.
 *   (2) The index actually exists again in the schema after the tick.
 *   (3) Duplicates present while the arbiter was missing are pruned
 *       keep-oldest by the heal.
 *   (4) The heal is once-per-process: after a second drop,
 *       reportAndHealMissingArbiterIndex returns false (no heal loop).
 *   (5) isMissingOnConflictArbiterError classifies the error only for the
 *       42P10 / arbiter-missing class (incl. drizzle `cause` wrapping).
 *
 * Isolation (Task #1929 pattern): runs inside `runInIsolatedSchema` with
 * `raw_communication_records` cloned (INCLUDING ALL clones the partial
 * unique index too), so dropping the index and pruning duplicate rows never
 * touches public.*.
 *
 * Usage: NODE_ENV=test tsx tests/raw-comm-index-self-heal.test.ts
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { materializeAppliedConvMessagesForMonthTick } from "../server/services/frontAppliedConvMaterializer";
import {
  __frontAnalyticsClientTestHelpers,
  type CollectedOutboundMessage,
  type EnumerationCheckpoint,
  type EnumerationTickResult,
  type FrontRawMessage,
} from "../server/services/frontAnalyticsClient";
import {
  isMissingOnConflictArbiterError,
  reportAndHealMissingArbiterIndex,
  RAW_COMM_UNIQUE_INDEX_NAME,
  __rawCommIndexSelfHealTestHelpers,
} from "../server/services/rawCommIndexSelfHeal";
import { runInIsolatedSchema } from "./db-sandbox";

const TABLES = ["raw_communication_records"] as const;

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

const MONTH = "2026-07";
const MONTH_START = new Date(Date.UTC(2026, 6, 1));
const MONTH_END = new Date(Date.UTC(2026, 7, 1));
// Per-run token so a leak (should never happen in the isolated schema, but
// route-test collision lore says be safe) can't collide across runs.
const RUN = `t3703-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CONV_ID = `cnv_${RUN}`;

function fakeMsg(id: string, inbound: boolean, hour: number): CollectedOutboundMessage {
  return {
    conversationId: CONV_ID,
    conversationSubject: "Re: index drop drill",
    message: {
      id,
      is_inbound: inbound,
      created_at: Math.floor(Date.UTC(2026, 6, 2, hour, 0) / 1000),
      body: `<p>body of ${id}</p>`,
      author: { username: "Someone", email: "someone@lawfirm.test" },
      recipients: [{ name: "Agent", handle: "agent@nobull.test", role: "to" }],
    } satisfies FrontRawMessage,
  };
}

const FAKE_MESSAGES: CollectedOutboundMessage[] = [
  fakeMsg(`msg_${RUN}_1`, true, 9),
  fakeMsg(`msg_${RUN}_2`, false, 10),
  fakeMsg(`msg_${RUN}_3`, true, 11),
];

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

// The LIKE ... INCLUDING ALL clone copies the index but Postgres assigns it a
// generated name, so locate the arbiter by DEFINITION (unique partial index on
// external_source_id), not by the canonical name.
async function arbiterIndexNames(isoDb: IsoDb, schema: string): Promise<string[]> {
  const res = await isoDb.execute(sql`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = ${schema}
      AND tablename = 'raw_communication_records'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%(external_source_id)%WHERE%external_source_id IS NOT NULL%'
  `);
  return (((res as any).rows ?? []) as any[]).map((r) => r.indexname);
}

async function arbiterIndexExists(isoDb: IsoDb, schema: string): Promise<boolean> {
  return (await arbiterIndexNames(isoDb, schema)).length > 0;
}

async function dropArbiterIndex(isoDb: IsoDb, schema: string): Promise<void> {
  for (const name of await arbiterIndexNames(isoDb, schema)) {
    await isoDb.execute(sql.raw(`DROP INDEX "${schema}"."${name}"`));
  }
}

async function countRows(isoDb: IsoDb): Promise<number> {
  const res = await isoDb.execute(sql`SELECT COUNT(*)::int AS n FROM raw_communication_records`);
  return Number(((res as any).rows ?? [])[0]?.n) || 0;
}

async function main(): Promise<void> {
  // ── Pure classifier checks (no DB) ──
  assert.equal(
    isMissingOnConflictArbiterError({ code: "42P10" }),
    true,
    "classifies bare pg 42P10",
  );
  assert.equal(
    isMissingOnConflictArbiterError(
      new Error("Failed query: insert into ...", {
        cause: Object.assign(
          new Error(
            "there is no unique or exclusion constraint matching the ON CONFLICT specification",
          ),
          { code: "42P10" },
        ),
      }),
    ),
    true,
    "classifies drizzle-wrapped error via the cause chain",
  );
  assert.equal(
    isMissingOnConflictArbiterError(new Error("duplicate key value violates unique constraint")),
    false,
    "does NOT classify a duplicate-key error",
  );
  assert.equal(isMissingOnConflictArbiterError(null), false, "null-safe");
  ok("isMissingOnConflictArbiterError: 42P10/arbiter-missing only, cause-chain aware");

  // Capture alerts instead of dispatching them.
  const alerts: Array<{ typeId: string; text: string; options: any }> = [];
  __rawCommIndexSelfHealTestHelpers.setNotifyByTypeOverride((async (
    typeId: string,
    payload: any,
    options?: any,
  ) => {
    alerts.push({ typeId, text: payload?.text ?? "", options });
    return {
      attempted: true,
      delivered: true,
      skipped: false,
      status: "delivered" as const,
    };
  }) as any);
  __rawCommIndexSelfHealTestHelpers.reset();

  __frontAnalyticsClientTestHelpers.setEnumerationOverride(
    async (): Promise<EnumerationTickResult> => ({
      checkpoint: fakeCheckpoint(),
      done: true,
      conversationsProcessedThisTick: 1,
      searchPagesFetchedThisTick: 1,
      messagePagesFetchedThisTick: 1,
      allMessagesThisTick: FAKE_MESSAGES,
    }),
  );

  try {
    await runInIsolatedSchema(async ({ db, schema }) => {
      // The clone (LIKE ... INCLUDING ALL) carries the partial unique index.
      assert.equal(
        await arbiterIndexExists(db, schema),
        true,
        "precondition: cloned table carries the unique arbiter index",
      );

      // Seed a duplicate pair with NO arbiter present so the heal's dedupe
      // has something to prune — dupes are only insertable while the index
      // is absent, so drop first.
      await dropArbiterIndex(db, schema);
      assert.equal(
        await arbiterIndexExists(db, schema),
        false,
        "index dropped (simulating the silent vanish)",
      );
      ok("simulated drift: unique index dropped in isolated schema");

      const dupeId = `msg_${RUN}_dupe`;
      await db.execute(sql`
        INSERT INTO raw_communication_records
          (source_type, source_subtype, title, timestamp, direction,
           external_source_id, external_thread_id, processing_status, review_status, created_at)
        VALUES
          ('front_email','email_message','older dupe','2026-07-01T00:00:00Z','inbound',
           ${dupeId}, ${CONV_ID}, 'processed','unreviewed','2026-07-01T00:00:00Z'),
          ('front_email','email_message','newer dupe','2026-07-01T01:00:00Z','inbound',
           ${dupeId}, ${CONV_ID}, 'processed','unreviewed','2026-07-01T01:00:00Z')
      `);

      // ── Tick with the index missing ──
      const tick = await materializeAppliedConvMessagesForMonthTick(
        MONTH,
        MONTH_START,
        MONTH_END,
        null,
      );

      // Before the fix: inserted=0, skipped=3 (every write swallowed as
      // "msg write failed"). After: the first failure heals, retries, and
      // every message lands.
      assert.equal(
        tick.inserted,
        FAKE_MESSAGES.length,
        "all messages inserted despite the index having been missing (self-heal + retry)",
      );
      assert.equal(tick.skipped, 0, "no silent per-message failures");
      ok("tick with missing index: every row landed (no silent failure storm)");

      assert.equal(
        await arbiterIndexExists(db, schema),
        true,
        "self-heal recreated the unique arbiter index",
      );
      ok("self-heal recreated the unique index in the schema");

      // Dedupe keep-oldest pruned the newer duplicate.
      const dupeRows = await db.execute(sql`
        SELECT title FROM raw_communication_records WHERE external_source_id = ${dupeId}
      `);
      const titles = ((dupeRows as any).rows ?? []).map((r: any) => r.title);
      assert.deepEqual(titles, ["older dupe"], "heal pruned duplicates keep-oldest");
      ok("heal deduped keep-oldest before recreating the index");

      assert.equal(
        await countRows(db),
        FAKE_MESSAGES.length + 1,
        "row count = 3 materialized + 1 surviving dupe row",
      );

      // ── Exactly ONE alert, with dedupe key + heal outcome ──
      assert.equal(alerts.length, 1, "exactly one alert fired (not N per-message)");
      const alert = alerts[0];
      assert.equal(alert.typeId, "infra.database.raw_comm_unique_index_missing");
      assert.ok(
        alert.text.includes(RAW_COMM_UNIQUE_INDEX_NAME),
        "alert names the missing index",
      );
      assert.ok(alert.text.includes("SUCCEEDED"), "alert reports heal success");
      assert.equal(
        alert.options?.dedupeKey,
        "raw_comm_unique_index_missing:global",
        "alert carries the dedupe key",
      );
      ok("one alert: correct type id, dedupe key, names the index, heal outcome");

      // ── Once-per-process latch: a second drop is NOT re-healed ──
      await dropArbiterIndex(db, schema);
      const secondHeal = await reportAndHealMissingArbiterIndex();
      assert.equal(secondHeal, false, "second heal attempt refuses (once per process)");
      assert.equal(
        await arbiterIndexExists(db, schema),
        false,
        "index NOT recreated by the refused second attempt",
      );
      assert.equal(alerts.length, 1, "no second alert from the refused attempt");
      ok("once-per-process: second drop is not heal-looped");

      // Restore the index so schema drop-order is irrelevant (and to mirror
      // real recovery via restart). Also proves the latch resets cleanly.
      __rawCommIndexSelfHealTestHelpers.reset();
      const healAfterReset = await reportAndHealMissingArbiterIndex();
      assert.equal(healAfterReset, true, "after reset (≈ new process) the heal runs again");
      assert.equal(await arbiterIndexExists(db, schema), true, "index restored");
      assert.equal(alerts.length, 2, "fresh-process heal fires its own alert");
      ok("fresh process (reset) heals + alerts again");
    }, { tables: TABLES });
  } finally {
    __frontAnalyticsClientTestHelpers.setEnumerationOverride(null);
    __rawCommIndexSelfHealTestHelpers.setNotifyByTypeOverride(null);
    __rawCommIndexSelfHealTestHelpers.reset();
  }

  console.log(`\nraw-comm-index-self-heal: ${passed} checks passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("raw-comm-index-self-heal FAILED:", err);
    process.exit(1);
  });
