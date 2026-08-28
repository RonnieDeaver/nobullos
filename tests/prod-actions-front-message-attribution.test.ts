/* test-registration
{
  "name": "Prod actions front message attribution (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #2662 — Verification for the `backfill_front_message_attribution`
 * prod-action: one idempotent, breaker-aware, three-phase background drain
 * that brings Front message attribution to 100%.
 *
 * Phases (all pure DB, no Front API):
 *   1. Stamp `raw_communication_records.client_id` from the matched
 *      conversation for every `front_email` message whose conversation IS
 *      matched (`front_sync_emails.match_status` auto/manually_matched,
 *      `matched_client_id` set) but whose message row client_id is NULL.
 *      Skips conversations whose matched client is archived (orphaned guard).
 *   2. Reconcile the stuck `failed` discovered-apply-tail rows FORWARD to
 *      `applied` when a raw_communication_record now exists; rows without a
 *      record stay terminally failed and stop counting.
 *   3. Reset legacy `dismissed`/`blocked` conversations (created 2026-04-01..14)
 *      to `unmatched` ONLY when no active manual filter rule still fires.
 *
 * Negative controls each phase must NEVER touch:
 *   • a message already attributed (client_id set),
 *   • a message in an unmatched / archived-client conversation,
 *   • a failed discovered-tail row with no raw record,
 *   • a dismissed row OUTSIDE the legacy window.
 *
 * Isolation (Task #1929 pattern): everything runs inside
 * `runInIsolatedSchema` so the live `Start application` workers (default
 * search_path = public) can neither see nor race-write the seeded rows.
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

const ACTION_ID = "backfill_front_message_attribution";
const TABLES = [
  "front_sync_emails",
  "raw_communication_records",
  "clients",
  "front_filter_rules",
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

async function seedClient(
  isoDb: IsoDb,
  row: { id: string; name: string; isArchived?: boolean },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, is_archived)
    VALUES (${row.id}, ${row.name}, ${row.isArchived ?? false})
  `);
}

async function seedConversation(
  isoDb: IsoDb,
  row: {
    id: string;
    conversationId: string;
    matchStatus: string;
    matchedClientId?: string | null;
    pipelineState?: string;
    pipelineError?: string | null;
    subject?: string | null;
    participantsJson?: unknown;
    createdAt?: string; // ISO date
  },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO front_sync_emails
      (id, conversation_id, match_status, matched_client_id, pipeline_state,
       pipeline_error, subject, participants_json, created_at, state_changed_at)
    VALUES (
      ${row.id},
      ${row.conversationId},
      ${row.matchStatus},
      ${row.matchedClientId ?? null},
      ${row.pipelineState ?? "applied"},
      ${row.pipelineError ?? null},
      ${row.subject ?? null},
      ${row.participantsJson ? JSON.stringify(row.participantsJson) : null}::jsonb,
      ${row.createdAt ? sql`${row.createdAt}::timestamp` : sql`NOW()`},
      NOW()
    )
  `);
}

async function seedMessage(
  isoDb: IsoDb,
  row: {
    id: string;
    conversationId: string;
    clientId?: string | null;
    isThreadRollup?: boolean;
  },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO raw_communication_records
      (id, source_type, title, timestamp, external_source_id,
       external_thread_id, client_id, created_at, updated_at)
    VALUES (
      ${row.id},
      'front_email',
      ${`seed ${row.id}`},
      NOW(),
      ${row.isThreadRollup ? row.conversationId : row.id},
      ${row.conversationId},
      ${row.clientId ?? null},
      NOW(),
      NOW()
    )
  `);
}

async function seedFilterRule(
  isoDb: IsoDb,
  row: { id: string; type: string; scope: string; value: string },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO front_filter_rules (id, type, scope, value, enabled, created_at)
    VALUES (${row.id}, ${row.type}, ${row.scope}, ${row.value}, true, NOW())
  `);
}

async function readMessageClient(isoDb: IsoDb, id: string): Promise<string | null> {
  const res: any = await isoDb.execute(sql`
    SELECT client_id FROM raw_communication_records WHERE id = ${id}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  const c = rows[0]?.client_id;
  return c === null || c === undefined ? null : String(c);
}

async function readConv(
  isoDb: IsoDb,
  id: string,
): Promise<{ match_status: string; pipeline_state: string; ingested_record_id: string | null }> {
  const res: any = await isoDb.execute(sql`
    SELECT match_status, pipeline_state, ingested_record_id
    FROM front_sync_emails WHERE id = ${id}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  const r = rows[0];
  return {
    match_status: String(r.match_status),
    pipeline_state: String(r.pipeline_state),
    ingested_record_id:
      r.ingested_record_id === null ? null : String(r.ingested_record_id),
  };
}

const FAILED_REASON =
  "[task-2089] discovered_apply_tail: no raw_communication_record — closed terminal";

async function testThreePhaseConvergence(): Promise<void> {
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();

    await seedClient(isoDb, { id: "client-active", name: "Active Co" });
    await seedClient(isoDb, { id: "client-archived", name: "Archived Co", isArchived: true });

    // ── Phase 1 — matched conversation w/ null-client messages ──
    await seedConversation(isoDb, {
      id: "fse-matched",
      conversationId: "cnv_matched",
      matchStatus: "auto_matched",
      matchedClientId: "client-active",
    });
    await seedMessage(isoDb, { id: "raw-matched-rollup", conversationId: "cnv_matched", isThreadRollup: true });
    await seedMessage(isoDb, { id: "raw-matched-msg1", conversationId: "cnv_matched" });
    await seedMessage(isoDb, { id: "raw-matched-msg2", conversationId: "cnv_matched" });
    // Already-attributed message in the same thread — must stay untouched.
    await seedMessage(isoDb, { id: "raw-matched-done", conversationId: "cnv_matched", clientId: "client-active" });

    // Negative: matched to an ARCHIVED client — orphaned guard must skip.
    await seedConversation(isoDb, {
      id: "fse-archived",
      conversationId: "cnv_archived",
      matchStatus: "manually_matched",
      matchedClientId: "client-archived",
    });
    await seedMessage(isoDb, { id: "raw-archived-msg", conversationId: "cnv_archived" });

    // Negative: unmatched conversation — never stamped.
    await seedConversation(isoDb, {
      id: "fse-unmatched",
      conversationId: "cnv_unmatched",
      matchStatus: "unmatched",
      matchedClientId: null,
    });
    await seedMessage(isoDb, { id: "raw-unmatched-msg", conversationId: "cnv_unmatched" });

    // ── Phase 2 — stuck failed discovered-apply-tail rows ──
    // Reconcilable: a raw record now exists.
    await seedConversation(isoDb, {
      id: "fse-failed-reconcile",
      conversationId: "cnv_failed_reconcile",
      matchStatus: "unmatched",
      pipelineState: "failed",
      pipelineError: FAILED_REASON,
    });
    await seedMessage(isoDb, { id: "raw-failed-reconcile", conversationId: "cnv_failed_reconcile", isThreadRollup: true });
    // Non-reconcilable: failed with NO raw record — stays terminal, no count.
    await seedConversation(isoDb, {
      id: "fse-failed-orphan",
      conversationId: "cnv_failed_orphan",
      matchStatus: "unmatched",
      pipelineState: "failed",
      pipelineError: FAILED_REASON,
    });

    // ── Phase 3 — legacy dismissed/blocked in window ──
    // Resettable: no active filter rule fires.
    await seedConversation(isoDb, {
      id: "fse-legacy-reset",
      conversationId: "cnv_legacy_reset",
      matchStatus: "dismissed",
      pipelineState: "triage_dismissed",
      subject: "old legacy thread",
      participantsJson: [{ email: "someone@nomatch.example", role: "from" }],
      createdAt: "2026-04-05",
    });
    // Rule-protected: an active block rule still fires → must stay dismissed.
    await seedFilterRule(isoDb, { id: "rule-block", type: "block", scope: "domain", value: "blocked.example" });
    await seedConversation(isoDb, {
      id: "fse-legacy-protected",
      conversationId: "cnv_legacy_protected",
      matchStatus: "blocked",
      pipelineState: "triage_dismissed",
      subject: "protected thread",
      participantsJson: [{ email: "sender@blocked.example", role: "from" }],
      createdAt: "2026-04-06",
    });
    // Negative: dismissed OUTSIDE the window — must stay dismissed.
    await seedConversation(isoDb, {
      id: "fse-dismissed-recent",
      conversationId: "cnv_dismissed_recent",
      matchStatus: "dismissed",
      pipelineState: "triage_dismissed",
      subject: "recent dismissal",
      participantsJson: [{ email: "x@nomatch.example", role: "from" }],
      createdAt: "2026-05-20",
    });

    const action = getAction();

    const pre = await action.status(null);
    assert.equal(pre.state, "pending", `expected pending status, got ${JSON.stringify(pre)}`);

    const out = await action.apply(null);
    assert.equal(out.state, "applied", `expected applied, got ${JSON.stringify(out)}`);

    const state = await awaitDrain();
    assert.equal(state.error, null, `drain errored — ${state.error}`);
    // 3 null-client matched messages + 1 reconcile + 1 legacy reset = 5.
    assert.equal(state.processed, 5, `expected 5 processed, got ${state.processed} (${JSON.stringify(state.perKey)})`);
    assert.deepEqual(
      state.perKey,
      { attributed: 3, reconciled_applied: 1, legacy_reset: 1 },
      `unexpected perKey ${JSON.stringify(state.perKey)}`,
    );

    // Phase 1 — the 3 null-client matched messages stamped to the client.
    assert.equal(await readMessageClient(isoDb, "raw-matched-rollup"), "client-active", "rollup stamped");
    assert.equal(await readMessageClient(isoDb, "raw-matched-msg1"), "client-active", "msg1 stamped");
    assert.equal(await readMessageClient(isoDb, "raw-matched-msg2"), "client-active", "msg2 stamped");
    assert.equal(await readMessageClient(isoDb, "raw-matched-done"), "client-active", "already-done untouched");
    // Orphaned-client guard + unmatched negatives.
    assert.equal(await readMessageClient(isoDb, "raw-archived-msg"), null, "archived-client message must NOT be stamped");
    assert.equal(await readMessageClient(isoDb, "raw-unmatched-msg"), null, "unmatched-conv message must NOT be stamped");

    // Phase 2 — reconcile.
    const reconciled = await readConv(isoDb, "fse-failed-reconcile");
    assert.equal(reconciled.pipeline_state, "applied", "failed row with record reconciles to applied");
    assert.equal(reconciled.ingested_record_id, "raw-failed-reconcile", "ingested_record_id backfilled");
    const failedOrphan = await readConv(isoDb, "fse-failed-orphan");
    assert.equal(failedOrphan.pipeline_state, "failed", "failed row with no record stays terminal");

    // Phase 3 — legacy reset.
    const legacyReset = await readConv(isoDb, "fse-legacy-reset");
    assert.equal(legacyReset.match_status, "unmatched", "no-rule legacy row reset to unmatched");
    const protectedRow = await readConv(isoDb, "fse-legacy-protected");
    assert.equal(protectedRow.match_status, "blocked", "rule-protected legacy row stays blocked");
    const recent = await readConv(isoDb, "fse-dismissed-recent");
    assert.equal(recent.match_status, "dismissed", "out-of-window dismissal stays dismissed");

    ok("3 phases converged: 3 attributed, 1 reconciled, 1 reset; all negatives untouched");
  }, { tables: TABLES });
}

async function testIdempotentSecondPress(): Promise<void> {
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();

    await seedClient(isoDb, { id: "client-2", name: "Co Two" });
    await seedConversation(isoDb, {
      id: "fse-2",
      conversationId: "cnv_2",
      matchStatus: "auto_matched",
      matchedClientId: "client-2",
    });
    await seedMessage(isoDb, { id: "raw-2", conversationId: "cnv_2", isThreadRollup: true });

    const action = getAction();
    const out1 = await action.apply(null);
    assert.equal(out1.state, "applied", `first press should be applied, got ${JSON.stringify(out1)}`);
    const state1 = await awaitDrain();
    assert.equal(state1.processed, 1, `first press should process 1, got ${state1.processed}`);

    // Second press: nothing left → not-needed.
    __resetDrainsForTest();
    const status2 = await action.status(null);
    assert.equal(status2.state, "not-needed", `after drain, status should be not-needed, got ${JSON.stringify(status2)}`);
    const out2 = await action.apply(null);
    assert.equal(out2.state, "not-needed", `second press should be not-needed, got ${JSON.stringify(out2)}`);

    assert.equal(await readMessageClient(isoDb, "raw-2"), "client-2", "row stays attributed");

    ok("second press is a safe not-needed no-op (idempotent)");
  }, { tables: TABLES });
}

async function main(): Promise<void> {
  await testThreePhaseConvergence();
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
