/* test-registration
{
  "name": "Front materialized-message AI-study (Task #2602)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2602: the materialized-Front-message AI-study core decides client attribution + claim/stamp for ~100% of historical Front messages and gates ~unbounded OpenAI spend behind a switch. Gate the service test so a regression in the scope predicate, match→enqueue, unmatched→terminal, or idempotency wiring fails fast (isolated-schema, fast, deterministic).",
  "tier": "small"
}
test-registration */
/**
 * Task #2602 — Verification for AI-studying the materialized Front messages.
 *
 * The per-message materialization path writes one `raw_communication_records`
 * row per historical Front message at `processing_status='processed'` with NO
 * `clientId`, so the row never enters the classifier queue and is never
 * studied into `agent_knowledge_base`. `frontMaterializedMessageStudy.ts`
 * closes that gap: it resolves each materialized message to a client via the
 * deterministic hard-match index and enqueues the existing
 * `analyze_communication` job (matched), or stamps it terminal (unmatched).
 *
 * This suite exercises the service core (`studyMaterializedMessageChunk` +
 * `countPendingMaterializedMessageStudy`) and the prod-action's switch gate.
 *
 * Isolation (Task #1929 pattern): everything runs inside
 * `runInIsolatedSchema` so the live `Start application` workers (default
 * search_path = public) can neither see, claim, nor race-write the rows the
 * test seeds. The process-global hard-match index cache is invalidated before
 * AND after so neither direction leaks isolated client rows.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import {
  countPendingMaterializedMessageStudy,
  studyMaterializedMessageChunk,
} from "../server/services/frontMaterializedMessageStudy";
import { invalidateHardMatchIndexes } from "../server/services/frontHardMatch";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import { runInIsolatedSchema } from "./db-sandbox";

const ACTION_ID = "study_materialized_front_messages";
const TABLES = ["raw_communication_records", "clients", "client_contacts", "work_queue"] as const;

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

const FLOOR_IN_SCOPE = "2025-09-01T12:00:00.000Z"; // after FRONT_ADOPTION_DATE (2025-07-01)
const BEFORE_FLOOR = "2025-06-15T12:00:00.000Z"; // before FRONT_ADOPTION_DATE

async function seedClient(isoDb: IsoDb, id: string, firmName: string, contactEmail: string): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, contact_email, is_archived)
    VALUES (${id}, ${firmName}, ${contactEmail}, false)
  `);
}

async function seedMaterializedMessage(
  isoDb: IsoDb,
  row: {
    id: string;
    direction: "inbound" | "outbound";
    participantEmail: string;
    timestamp: string;
    sourceSubtype?: string;
    processingStatus?: string;
    aiProcessedAt?: string | null;
  },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO raw_communication_records
      (id, source_type, source_subtype, title, timestamp, direction,
       participants_json, processing_status, ai_processed_at, created_at, updated_at)
    VALUES (
      ${row.id},
      'front_email',
      ${row.sourceSubtype ?? "email_message"},
      ${"msg " + row.id},
      ${row.timestamp},
      ${row.direction},
      ${JSON.stringify([{ email: row.participantEmail, role: "external" }])}::jsonb,
      ${row.processingStatus ?? "processed"},
      ${row.aiProcessedAt ?? null},
      now(),
      now()
    )
  `);
}

async function getRow(isoDb: IsoDb, id: string): Promise<{ client_id: string | null; processing_status: string; ai_processed_at: string | null }> {
  const res = await isoDb.execute(sql`
    SELECT client_id, processing_status, ai_processed_at
    FROM raw_communication_records WHERE id = ${id}
  `);
  const rows = ((res as any).rows ?? (res as unknown as any[])) as any[];
  return rows[0];
}

async function countAnalyzeJobs(isoDb: IsoDb): Promise<number> {
  const res = await isoDb.execute(sql`
    SELECT COUNT(*)::int AS n FROM work_queue WHERE queue_name = 'analyze_communication'
  `);
  const rows = ((res as any).rows ?? (res as unknown as any[])) as any[];
  return Number(rows[0]?.n) || 0;
}

async function main(): Promise<void> {
  // ── Test 1: service core — match / no-match / scope / idempotency ──
  await runInIsolatedSchema(async ({ db }) => {
    invalidateHardMatchIndexes();
    try {
      const clientId = "11111111-1111-1111-1111-111111111111";
      await seedClient(db, clientId, "Lawfirm LLC", "alice@lawfirm.test");

      // matched inbound message (participant email == client contact email)
      await seedMaterializedMessage(db, {
        id: "msg-matched",
        direction: "inbound",
        participantEmail: "alice@lawfirm.test",
        timestamp: FLOOR_IN_SCOPE,
      });
      // unmatched outbound message (unknown participant)
      await seedMaterializedMessage(db, {
        id: "msg-unmatched",
        direction: "outbound",
        participantEmail: "nobody@stranger.test",
        timestamp: FLOOR_IN_SCOPE,
      });
      // out-of-scope: before the adoption floor — must be untouched
      await seedMaterializedMessage(db, {
        id: "msg-before-floor",
        direction: "inbound",
        participantEmail: "alice@lawfirm.test",
        timestamp: BEFORE_FLOOR,
      });
      // out-of-scope: already studied (ai_processed_at set) — untouched
      await seedMaterializedMessage(db, {
        id: "msg-already-studied",
        direction: "inbound",
        participantEmail: "alice@lawfirm.test",
        timestamp: FLOOR_IN_SCOPE,
        aiProcessedAt: FLOOR_IN_SCOPE,
      });
      // out-of-scope: conversation envelope, not a per-message row
      await seedMaterializedMessage(db, {
        id: "msg-envelope",
        direction: "inbound",
        participantEmail: "alice@lawfirm.test",
        timestamp: FLOOR_IN_SCOPE,
        sourceSubtype: "email_conversation",
      });

      const pendingBefore = await countPendingMaterializedMessageStudy();
      assert.equal(pendingBefore, 2, "only the 2 in-scope unstudied messages are pending");
      ok("countPending counts only in-scope, unstudied, per-message rows");

      const result = await studyMaterializedMessageChunk(50);
      assert.equal(result.examined, 2, "chunk examined exactly the 2 candidates");
      assert.equal(result.enqueued, 1, "one matched row enqueued");
      assert.equal(result.unmatchedStamped, 1, "one unmatched row stamped");
      ok("studyMaterializedMessageChunk processed both candidates");

      const matched = await getRow(db, "msg-matched");
      assert.equal(matched.client_id, clientId, "matched row got its clientId");
      assert.equal(matched.processing_status, "pending", "matched row claimed (status pending)");
      assert.equal(matched.ai_processed_at, null, "matched row not yet stamped (analyze job will)");
      ok("matched row: clientId persisted + claimed + left for the analyze job");

      const unmatched = await getRow(db, "msg-unmatched");
      assert.equal(unmatched.client_id, null, "unmatched row stays clientless");
      assert.notEqual(unmatched.ai_processed_at, null, "unmatched row stamped terminal");
      ok("unmatched row: stamped terminal with no client + no AI spend");

      const beforeFloor = await getRow(db, "msg-before-floor");
      assert.equal(beforeFloor.processing_status, "processed", "before-floor row untouched");
      assert.equal(beforeFloor.ai_processed_at, null, "before-floor row not stamped");
      ok("out-of-scope rows (before floor / already studied / envelope) untouched");

      const jobs = await countAnalyzeJobs(db);
      assert.equal(jobs, 1, "exactly one analyze_communication job enqueued");
      ok("exactly one analyze_communication job was enqueued");

      // Idempotency: a second pass must find nothing (claimed + stamped rows
      // dropped out of the candidate set) and enqueue no new jobs.
      const pendingAfter = await countPendingMaterializedMessageStudy();
      assert.equal(pendingAfter, 0, "no candidates remain after the first pass");
      const second = await studyMaterializedMessageChunk(50);
      assert.equal(second.examined, 0, "second pass examines nothing");
      assert.equal(await countAnalyzeJobs(db), 1, "no duplicate analyze job on re-run");
      ok("idempotent: a second pass does no work and enqueues no duplicate job");
    } finally {
      invalidateHardMatchIndexes();
    }
  }, { tables: TABLES });

  // ── Test 2: prod-action is switch-gated (default OFF → not-needed) ──
  const action = PROD_ACTIONS.find((a) => a.id === ACTION_ID);
  assert.ok(action, `${ACTION_ID} registered in PROD_ACTIONS`);
  const status = await action!.status();
  assert.equal(status.state, "not-needed", "switch OFF (default) → action reports not-needed");
  assert.match(
    status.detail ?? "",
    /front_materialized_message_study_enabled/,
    "not-needed detail names the gating switch",
  );
  ok("prod-action is registered and gated OFF by default (not-needed)");

  console.log(`\nfront-materialized-message-study: ${passed} assertions passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
