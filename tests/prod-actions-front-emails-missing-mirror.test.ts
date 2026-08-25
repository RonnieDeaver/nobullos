/* test-registration
{
  "name": "Prod actions front emails missing mirror (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * Task #2670 — Verification for the `reconcile_front_emails_missing_mirror`
 * prod-action: one idempotent, breaker-aware, worker-pool background drain
 * that closes the Front Console "Tracked > Matchable" gap.
 *
 * The gap: a `front_email` record exists in `raw_communication_records`
 * (so it is tracked) but its Front conversation id (`external_thread_id`)
 * has NO `front_sync_emails` mirror row. The matching surface only ever
 * reads the mirror table, so such a conversation can never be matched,
 * dismissed, or surfaced as Unmatched — it just silently widens the
 * Tracked > Matchable delta.
 *
 * Per gap conversation the action: (1) creates the missing mirror row via
 * the canonical `mirrorWebhookToFrontSyncEmail` construction and
 * transitions it to pipeline_state='applied' + match_status='unmatched'
 * (the column default — never dismissed/blocked); (2) enqueues a
 * deterministic `front_sync_reprocess` (cohort `unmatched`) matching pass.
 *
 * Negative controls the action must NEVER touch:
 *   • an orphaned record (match_status='orphaned'),
 *   • a record that already has a client (client_id set),
 *   • a conversation that already has a mirror row,
 *   • a record with a NULL external_thread_id,
 *   • a non-front_email record.
 *
 * Isolation (Task #1929 pattern): everything runs inside
 * `runInIsolatedSchema` so the live `Start application` workers (default
 * search_path = public) can neither see nor race-write/claim the seeded
 * rows. The mirror helpers and `enqueueToQueue` both route their writes
 * through `getDb()`, which honors the isolated-schema override ahead of
 * the worker context, so every read+write stays in this schema.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  getDrainState,
  __resetDrainsForTest,
  type DrainState,
} from "../server/services/prodActionBackgroundDrain";
import { runInIsolatedSchema } from "./db-sandbox";

const ACTION_ID = "reconcile_front_emails_missing_mirror";
const TABLES = [
  "front_sync_emails",
  "raw_communication_records",
  "work_queue",
  "prod_action_runs",
] as const;

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

async function awaitDrain(timeoutMs = 20_000): Promise<DrainState> {
  const start = Date.now();
  for (;;) {
    const st = getDrainState(ACTION_ID);
    if (st && st.finishedAt !== null) return st;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `drain ${ACTION_ID} did not finish within ${timeoutMs}ms (state=${JSON.stringify(st)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function getAction() {
  const action = PROD_ACTIONS.find((a) => a.id === ACTION_ID);
  if (!action) throw new Error(`${ACTION_ID} missing from PROD_ACTIONS registry`);
  return action;
}

async function seedRawRecord(
  isoDb: IsoDb,
  row: {
    id: string;
    threadId: string | null;
    clientId?: string | null;
    matchStatus?: string | null;
    sourceType?: string;
    title?: string | null;
    contentText?: string | null;
    participantsJson?: unknown;
    externalSourceId?: string | null;
    timestamp?: string; // ISO, controls DISTINCT ON pick
  },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO raw_communication_records
      (id, source_type, title, content_text, timestamp, external_source_id,
       external_thread_id, participants_json, client_id, match_status,
       created_at, updated_at)
    VALUES (
      ${row.id},
      ${row.sourceType ?? "front_email"},
      ${row.title ?? `seed ${row.id}`},
      ${row.contentText ?? null},
      ${row.timestamp ? sql`${row.timestamp}::timestamp` : sql`NOW()`},
      ${row.externalSourceId ?? row.id},
      ${row.threadId},
      ${row.participantsJson ? JSON.stringify(row.participantsJson) : null}::jsonb,
      ${row.clientId ?? null},
      ${row.matchStatus ?? null},
      NOW(),
      NOW()
    )
  `);
}

async function seedMirror(
  isoDb: IsoDb,
  row: { id: string; conversationId: string; matchStatus?: string },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO front_sync_emails
      (id, conversation_id, match_status, pipeline_state, created_at, state_changed_at)
    VALUES (
      ${row.id},
      ${row.conversationId},
      ${row.matchStatus ?? "unmatched"},
      'applied',
      NOW(),
      NOW()
    )
  `);
}

async function readMirror(
  isoDb: IsoDb,
  conversationId: string,
): Promise<
  | { id: string; match_status: string; pipeline_state: string; subject: string | null }
  | null
> {
  const res: any = await isoDb.execute(sql`
    SELECT id, match_status, pipeline_state, subject
    FROM front_sync_emails WHERE conversation_id = ${conversationId}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    match_status: String(r.match_status),
    pipeline_state: String(r.pipeline_state),
    subject: r.subject === null || r.subject === undefined ? null : String(r.subject),
  };
}

async function countMirrors(isoDb: IsoDb, conversationId: string): Promise<number> {
  const res: any = await isoDb.execute(sql`
    SELECT COUNT(*)::int AS n FROM front_sync_emails WHERE conversation_id = ${conversationId}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

async function readQueuedMatchJobs(
  isoDb: IsoDb,
): Promise<Array<{ syncEmailIds: unknown; cohort: unknown; source: unknown }>> {
  const res: any = await isoDb.execute(sql`
    SELECT payload FROM work_queue WHERE queue_name = 'front_sync_reprocess'
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return rows.map((r: any) => {
    const p = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload ?? {};
    return { syncEmailIds: p.syncEmailIds, cohort: p.cohort, source: p.source };
  });
}

async function testConvergenceAndNegatives(): Promise<void> {
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();

    // ── Gap 1 — a plain missing-mirror front_email conversation ──
    await seedRawRecord(isoDb, {
      id: "raw-gap-1",
      threadId: "cnv_gap_1",
      title: "Gap one subject",
      contentText: "hello from gap one",
      participantsJson: [{ email: "a@client.example", role: "from" }],
      externalSourceId: "msg-gap-1",
    });

    // ── Gap 2 — TWO raw rows on the same conversation; DISTINCT ON must
    //    create exactly ONE mirror and pick the latest by timestamp. ──
    await seedRawRecord(isoDb, {
      id: "raw-gap-2-old",
      threadId: "cnv_gap_2",
      title: "older subject",
      timestamp: "2026-01-01T00:00:00Z",
      externalSourceId: "msg-gap-2-old",
    });
    await seedRawRecord(isoDb, {
      id: "raw-gap-2-new",
      threadId: "cnv_gap_2",
      title: "newer subject",
      timestamp: "2026-02-01T00:00:00Z",
      externalSourceId: "msg-gap-2-new",
    });

    // ── Negatives ──
    // Orphaned record — must be skipped.
    await seedRawRecord(isoDb, {
      id: "raw-orphan",
      threadId: "cnv_orphan",
      matchStatus: "orphaned",
    });
    // Already has a client — must be skipped.
    await seedRawRecord(isoDb, {
      id: "raw-hasclient",
      threadId: "cnv_hasclient",
      clientId: "client-x",
    });
    // Conversation already mirrored — must be skipped (no new mirror, no enqueue).
    await seedRawRecord(isoDb, { id: "raw-mirrored", threadId: "cnv_mirrored" });
    await seedMirror(isoDb, { id: "fse-existing", conversationId: "cnv_mirrored" });
    // NULL external_thread_id — must be skipped.
    await seedRawRecord(isoDb, { id: "raw-nothread", threadId: null });
    // Non-front_email source — must be skipped.
    await seedRawRecord(isoDb, {
      id: "raw-zoom",
      threadId: "cnv_zoom",
      sourceType: "zoom_recording",
    });

    const action = getAction();

    const pre = await action.status(null);
    assert.equal(pre.state, "pending", `expected pending status, got ${JSON.stringify(pre)}`);

    const out = await action.apply(null);
    assert.equal(out.state, "applied", `expected applied, got ${JSON.stringify(out)}`);

    const state = await awaitDrain();
    assert.equal(state.error, null, `drain errored — ${state.error}`);
    // 2 gap conversations reconciled (gap_1 + gap_2 deduped to one).
    assert.equal(
      state.processed,
      2,
      `expected 2 processed, got ${state.processed} (${JSON.stringify(state.perKey)})`,
    );
    assert.deepEqual(
      state.perKey,
      { mirror_reconciled: 2, matching_enqueued: 2 },
      `unexpected perKey ${JSON.stringify(state.perKey)}`,
    );

    // Gap 1 — mirror created in applied + unmatched, subject carried over.
    const g1 = await readMirror(isoDb, "cnv_gap_1");
    assert.notEqual(g1, null, "gap 1 mirror created");
    assert.equal(g1!.pipeline_state, "applied", "gap 1 mirror is applied");
    assert.equal(g1!.match_status, "unmatched", "gap 1 mirror is unmatched (never dismissed/blocked)");
    assert.equal(g1!.subject, "Gap one subject", "gap 1 subject mirrored from raw record");

    // Gap 2 — exactly one mirror, latest subject by timestamp.
    assert.equal(await countMirrors(isoDb, "cnv_gap_2"), 1, "gap 2 produced exactly one mirror (DISTINCT ON)");
    const g2 = await readMirror(isoDb, "cnv_gap_2");
    assert.equal(g2!.subject, "newer subject", "gap 2 picked the newest raw record by timestamp");
    assert.equal(g2!.match_status, "unmatched", "gap 2 mirror is unmatched");

    // Negatives — no mirrors minted.
    assert.equal(await countMirrors(isoDb, "cnv_orphan"), 0, "orphaned record not mirrored");
    assert.equal(await countMirrors(isoDb, "cnv_hasclient"), 0, "client-attributed record not mirrored");
    assert.equal(await countMirrors(isoDb, "cnv_zoom"), 0, "non-front_email record not mirrored");
    // The pre-existing mirror is untouched (still exactly one row).
    assert.equal(await countMirrors(isoDb, "cnv_mirrored"), 1, "already-mirrored conversation unchanged");

    // Matching enqueued — exactly the two reconciled rows, cohort unmatched.
    const jobs = await readQueuedMatchJobs(isoDb);
    assert.equal(jobs.length, 2, `expected 2 matching jobs, got ${jobs.length}`);
    const reconciledIds = new Set([g1!.id, g2!.id]);
    const enqueuedIds = new Set<string>();
    for (const j of jobs) {
      assert.equal(j.cohort, "unmatched", "matching job cohort is unmatched");
      const ids = j.syncEmailIds as string[];
      assert.equal(ids.length, 1, "matching job targets a single sync-email id");
      enqueuedIds.add(String(ids[0]));
    }
    assert.deepEqual(enqueuedIds, reconciledIds, "matching enqueued exactly the two reconciled mirror ids");

    ok("2 gap conversations reconciled (applied+unmatched) + matching enqueued; all 5 negatives untouched");
  }, { tables: TABLES });
}

async function testIdempotentSecondPress(): Promise<void> {
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();

    await seedRawRecord(isoDb, {
      id: "raw-only",
      threadId: "cnv_only",
      title: "only subject",
    });

    const action = getAction();
    const out1 = await action.apply(null);
    assert.equal(out1.state, "applied", `first press should be applied, got ${JSON.stringify(out1)}`);
    const state1 = await awaitDrain();
    assert.equal(state1.processed, 1, `first press should process 1, got ${state1.processed}`);
    assert.notEqual(await readMirror(isoDb, "cnv_only"), null, "mirror created on first press");

    // Second press: nothing left → not-needed (idempotent, clean no-op).
    __resetDrainsForTest();
    const status2 = await action.status(null);
    assert.equal(
      status2.state,
      "not-needed",
      `after drain, status should be not-needed, got ${JSON.stringify(status2)}`,
    );
    const out2 = await action.apply(null);
    assert.equal(out2.state, "not-needed", `second press should be not-needed, got ${JSON.stringify(out2)}`);

    // No duplicate mirror, no duplicate matching job.
    assert.equal(await countMirrors(isoDb, "cnv_only"), 1, "no duplicate mirror on second press");
    const jobs = await readQueuedMatchJobs(isoDb);
    assert.equal(jobs.length, 1, `expected exactly 1 matching job after idempotent re-press, got ${jobs.length}`);

    ok("second press is a safe not-needed no-op (idempotent, no duplicate mirror/enqueue)");
  }, { tables: TABLES });
}

async function main(): Promise<void> {
  await testConvergenceAndNegatives();
  await testIdempotentSecondPress();
  console.log(`\n${passed} assertion group(s) passed`);
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
