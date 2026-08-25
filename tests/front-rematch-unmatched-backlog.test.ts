/* test-registration
{
  "name": "Unmatched-backlog re-match batch semantics (Task #4049)",
  "smoke": true,
  "smokeReason": "Fast fixture-scoped DB test (~2s): pins the drain's per-row semantics (match + thread-wide stamp + audit, automated-only stays unmatched, rule paths, idempotent re-run) behind the CEO button.",
  "tier": "small"
}
test-registration */
// Task #4049 — semantics of `rematchUnmatchedBacklogByIds`, the per-batch core
// the fanned-out `front_sync_reprocess` drain runs over the unmatched cohort:
//
//   - HUMAN sender on a trusted client domain → `auto_matched`, thread-wide
//     raw-record stamp (BOTH rows sharing the external thread id flip), and a
//     `front_match_audit_log` row with source `rematch_unmatched_backlog`.
//   - Automated-only sender on the SAME trusted domain → stays `unmatched`
//     with the explicit `[automated_senders_only_no_autoclaim…]` reason
//     (review-tool noise cannot ride a client domain into a match).
//   - Sender matching an operator BLOCK filter rule → leaves the cohort
//     (blocked), counted as `dismissedByRule`.
//   - Sender matching a NEVER_MATCH rule → stays unmatched, reason written
//     once (`[never_match] …`).
//   - Freemail sender with no client evidence → stays unmatched, reason
//     refreshed only when it CHANGED.
//   - A row that is no longer `unmatched` at fetch time is skipped entirely.
//   - Re-running the SAME batch is idempotent: no second audit row, zero
//     reason rewrites, matched row skipped.
//   - Task #4769: a match on a conversation with NO hydrate snapshot still
//     stamps thread-wide raw-record attribution BEFORE the snapshot gate
//     throws (apply reports `error`, match fields committed, raw rows
//     stamped) — the born-pending residue class the
//     `backfill_front_message_attribution` drain used to mop up daily.
//
// Hermetic: pre-seeded raw records (matched on external_source_id) make
// `applyMatchedConversation` take the existing-record branch, and a pre-seeded
// hydrate snapshot satisfies the apply-stage guard — no Front API egress. The
// no-snapshot conversation throws at the gate BEFORE the ingest branch, so it
// cannot egress either. A scoped fetch guard makes any frontapp.com call loud.

import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { db } from "../server/db";
import {
  clients,
  clientContacts,
  users,
  frontSyncEmails,
  frontMatchAuditLog,
  frontFilterRules,
  rawCommunicationRecords,
} from "@shared/schema";
import { rematchUnmatchedBacklogByIds } from "../server/services/frontIntegration";
import { invalidateFilterRulesCache } from "../server/services/frontFilterRules";
import { invalidateHardMatchIndexes } from "../server/services/frontHardMatch";
import { MATCH_REASON_CODES } from "../server/services/companyIdentity";

const TAG = `4049d${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const DOM_TRUSTED = `malik-trusted-${TAG}.com`;
const DOM_BLOCKED = `blockdom-${TAG}.com`;
const DOM_NEVER = `neverdom-${TAG}.com`;

const CONV_MATCH = `conv-${TAG}-match`;
const CONV_AUTOMATED = `conv-${TAG}-automated`;
const CONV_BLOCKED = `conv-${TAG}-blocked`;
const CONV_NEVER = `conv-${TAG}-never`;
const CONV_FREEMAIL = `conv-${TAG}-freemail`;
const CONV_ALREADY = `conv-${TAG}-already`;
const CONV_NOSNAP = `conv-${TAG}-nosnap`;
const ALL_CONVS = [CONV_MATCH, CONV_AUTOMATED, CONV_BLOCKED, CONV_NEVER, CONV_FREEMAIL, CONV_ALREADY, CONV_NOSNAP];

// Hermetic guard: the pre-seeded raw record + snapshot suppress Front ingest;
// any frontapp.com egress is a regression. Everything else passes through
// (DB is TCP, but settings caches may use HTTP backends).
const originalFetch: typeof fetch = global.fetch;
global.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (String(url).includes("frontapp.com")) {
    throw new Error(`[task-4049] Unexpected Front API call during hermetic test: ${url}`);
  }
  return originalFetch(input, init);
}) as any;

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
  }
}

async function seedSyncRow(opts: {
  conversationId: string;
  senderEmail: string;
  matchStatus?: string;
  matchedClientId?: string | null;
  matchReason?: string | null;
}): Promise<string> {
  const versionKey = `${opts.conversationId}::no_msg`;
  const [row] = await db
    .insert(frontSyncEmails)
    .values({
      conversationId: opts.conversationId,
      subject: `Subject ${opts.conversationId}`,
      snippet: "snippet",
      participantsJson: [
        { name: "Sender", email: opts.senderEmail, role: "from" },
        { name: "Ops", email: "ops@nobullmarketing.com", role: "to" },
      ] as any,
      matchStatus: (opts.matchStatus ?? "unmatched") as any,
      matchedClientId: opts.matchedClientId ?? null,
      matchReason: opts.matchReason ?? null,
      pipelineState: "applied",
      versionKey,
      lastMessageAt: new Date(),
    } as any)
    .returning();
  return row.id;
}

async function run(): Promise<void> {
  // Block/never_match rule application stamps dismissedBy "system" (FK to
  // users). Ensure the shared fixture row exists; never delete it (other
  // suites in the run may rely on it).
  await db.insert(users).values({ id: "system" } as any).onConflictDoNothing();

  const [clientNew] = await db
    .insert(clients)
    .values({ firmName: `Rematch Target Firm ${TAG}`, isArchived: false, emailDomains: [DOM_TRUSTED] } as any)
    .returning();
  // Placeholder prior owner for the raw records so the thread-wide stamp has
  // an observable flip (old → new).
  const [clientOld] = await db
    .insert(clients)
    .values({ firmName: `Rematch Prior Firm ${TAG}`, isArchived: false } as any)
    .returning();
  const clientIds = [clientNew.id, clientOld.id];

  const [blockRule] = await db
    .insert(frontFilterRules)
    .values({ type: "block", scope: "domain", value: DOM_BLOCKED, enabled: true } as any)
    .returning();
  const [neverRule] = await db
    .insert(frontFilterRules)
    .values({ type: "never_match", scope: "domain", value: DOM_NEVER, enabled: true } as any)
    .returning();
  invalidateFilterRulesCache();
  invalidateHardMatchIndexes();

  try {
    const idMatch = await seedSyncRow({ conversationId: CONV_MATCH, senderEmail: `ricky@${DOM_TRUSTED}` });
    const idAutomated = await seedSyncRow({ conversationId: CONV_AUTOMATED, senderEmail: `noreply@${DOM_TRUSTED}` });
    const idBlocked = await seedSyncRow({ conversationId: CONV_BLOCKED, senderEmail: `x@${DOM_BLOCKED}` });
    const idNever = await seedSyncRow({ conversationId: CONV_NEVER, senderEmail: `y@${DOM_NEVER}` });
    const idFreemail = await seedSyncRow({ conversationId: CONV_FREEMAIL, senderEmail: `someone@gmail.com` });
    const idAlready = await seedSyncRow({
      conversationId: CONV_ALREADY,
      senderEmail: `z@${DOM_TRUSTED}`,
      matchStatus: "auto_matched",
      matchedClientId: clientNew.id,
      matchReason: "[seed] already matched",
    });
    // Task #4769: trusted-domain human sender, but NO hydrate snapshot — the
    // late-match shape (retroactive re-evals / backlog rematch on old
    // conversations whose snapshot was pruned or never written).
    const idNoSnap = await seedSyncRow({ conversationId: CONV_NOSNAP, senderEmail: `paula@${DOM_TRUSTED}` });
    const allIds = [idMatch, idAutomated, idBlocked, idNever, idFreemail, idAlready, idNoSnap];

    // Hydrate snapshot for the row that will reach apply.
    await db.execute(
      (await import("drizzle-orm")).sql`
        INSERT INTO front_hydrate_snapshots
          (conversation_id, version_key, conversation_json, messages_json, message_count)
        VALUES (${CONV_MATCH}, ${`${CONV_MATCH}::no_msg`}, '{}'::jsonb, '[]'::jsonb, 0)
      `,
    );
    // Two raw records on the SAME external thread: the conversation-grain row
    // (external_source_id = conversation id — the one apply finds) and a
    // message-grain sibling. Thread-wide stamping must flip BOTH.
    await db.insert(rawCommunicationRecords).values([
      {
        clientId: clientOld.id,
        sourceType: "front_email",
        title: "raw conv-grain",
        timestamp: new Date(),
        externalSourceId: CONV_MATCH,
        externalThreadId: CONV_MATCH,
      },
      {
        clientId: clientOld.id,
        sourceType: "front_email",
        title: "raw message-grain",
        timestamp: new Date(),
        externalSourceId: `${CONV_MATCH}-msg-1`,
        externalThreadId: CONV_MATCH,
      },
      // No-snapshot conversation: two message-grain rows born with NULL
      // client_id (the prod born-pending shape). NO conversation-grain row and
      // NO hydrate snapshot — apply must throw at the snapshot gate, AFTER
      // stamping these rows thread-wide.
      {
        clientId: null,
        sourceType: "front_email",
        title: "raw nosnap msg 1",
        timestamp: new Date(),
        externalSourceId: `${CONV_NOSNAP}-msg-1`,
        externalThreadId: CONV_NOSNAP,
      },
      {
        clientId: null,
        sourceType: "front_email",
        title: "raw nosnap msg 2",
        timestamp: new Date(),
        externalSourceId: `${CONV_NOSNAP}-msg-2`,
        externalThreadId: CONV_NOSNAP,
      },
    ] as any);

    // ── First pass ──────────────────────────────────────────────────────────
    const r1 = await rematchUnmatchedBacklogByIds(allIds);
    console.log("first pass:", JSON.stringify(r1));

    check("scans only rows still unmatched (already-matched row skipped)", () =>
      assert.equal(r1.scanned, 6, JSON.stringify(r1)));
    check("exactly one row matched", () => assert.equal(r1.matched, 1, JSON.stringify(r1)));
    check("block-rule row counted as dismissedByRule", () => assert.equal(r1.dismissedByRule, 1, JSON.stringify(r1)));
    check("never_match row counted", () => assert.equal(r1.neverMatch, 1, JSON.stringify(r1)));
    check("automated-only + freemail rows stay unmatched", () =>
      assert.equal(r1.stillUnmatched, 2, JSON.stringify(r1)));
    check("no-snapshot conversation is the only apply error", () =>
      assert.equal(r1.errors, 1, JSON.stringify(r1)));

    const rows = await db.select().from(frontSyncEmails).where(inArray(frontSyncEmails.id, allIds));
    const byId = new Map(rows.map((r) => [r.id, r]));

    check("human-evidence row flipped to auto_matched with the trusted-domain client", () => {
      const row = byId.get(idMatch)!;
      assert.equal(row.matchStatus, "auto_matched");
      assert.equal(row.matchedClientId, clientNew.id);
    });
    const rawRows = await db
      .select()
      .from(rawCommunicationRecords)
      .where(eq(rawCommunicationRecords.externalThreadId, CONV_MATCH));
    check("both raw records on the thread now carry the matched client", () => {
      assert.equal(rawRows.length, 2, `raw rows: ${rawRows.length}`);
      for (const rr of rawRows) {
        assert.equal(rr.clientId, clientNew.id, `raw ${rr.externalSourceId} clientId=${rr.clientId}`);
      }
    });
    const auditRows = await db
      .select()
      .from(frontMatchAuditLog)
      .where(eq(frontMatchAuditLog.conversationId, CONV_MATCH));
    check("audit row recorded with the rematch_unmatched_backlog source", () => {
      assert.equal(auditRows.length, 1, `audit rows: ${auditRows.length}`);
      assert.equal((auditRows[0] as any).source, "rematch_unmatched_backlog");
    });
    check("automated-only row stays unmatched with the explicit guard reason", () => {
      const row = byId.get(idAutomated)!;
      assert.equal(row.matchStatus, "unmatched");
      assert.match(row.matchReason ?? "", new RegExp(MATCH_REASON_CODES.AUTOMATED_SENDERS_ONLY));
    });
    check("block-rule row left the cohort", () => {
      const row = byId.get(idBlocked)!;
      assert.notEqual(row.matchStatus, "unmatched");
      assert.equal(row.matchedClientId, null);
    });
    check("never_match row stays unmatched with the rule reason", () => {
      const row = byId.get(idNever)!;
      assert.equal(row.matchStatus, "unmatched");
      assert.equal(row.matchReason, "[never_match] operator filter rule");
    });
    check("freemail row stays unmatched with a refreshed reason", () => {
      const row = byId.get(idFreemail)!;
      assert.equal(row.matchStatus, "unmatched");
      assert.ok((row.matchReason ?? "").length > 0, "reason must be populated");
    });
    check("already-matched row untouched", () => {
      const row = byId.get(idAlready)!;
      assert.equal(row.matchStatus, "auto_matched");
      assert.equal(row.matchReason, "[seed] already matched");
    });

    // ── Task #4769: no-snapshot late match still stamps thread-wide ────────
    check("no-snapshot row committed the match decision despite the apply error", () => {
      const row = byId.get(idNoSnap)!;
      assert.equal(row.matchStatus, "auto_matched");
      assert.equal(row.matchedClientId, clientNew.id);
      assert.equal(row.ingestedRecordId, null, "apply must NOT have completed ingest");
    });
    const noSnapRaw = await db
      .select()
      .from(rawCommunicationRecords)
      .where(eq(rawCommunicationRecords.externalThreadId, CONV_NOSNAP));
    check("no-snapshot thread rows stamped BEFORE the snapshot gate threw", () => {
      assert.equal(noSnapRaw.length, 2, `raw rows: ${noSnapRaw.length}`);
      for (const rr of noSnapRaw) {
        assert.equal(rr.clientId, clientNew.id, `raw ${rr.externalSourceId} clientId=${rr.clientId}`);
      }
    });
    const noSnapAudit = await db
      .select()
      .from(frontMatchAuditLog)
      .where(eq(frontMatchAuditLog.conversationId, CONV_NOSNAP));
    check("backlog chunk writes no audit row for the errored apply (existing semantics)", () =>
      assert.equal(noSnapAudit.length, 0, `audit rows: ${noSnapAudit.length}`));

    // ── Second pass: idempotent ────────────────────────────────────────────
    const r2 = await rematchUnmatchedBacklogByIds(allIds);
    console.log("second pass:", JSON.stringify(r2));
    check("second pass scans only the still-unmatched remainder", () =>
      assert.equal(r2.scanned, 3, JSON.stringify(r2)));
    check("second pass matches nothing new", () => assert.equal(r2.matched, 0, JSON.stringify(r2)));
    check("second pass rewrites no reasons (write-on-change only)", () =>
      assert.equal(r2.reasonRefreshed, 0, JSON.stringify(r2)));
    check("second pass has no errors", () => assert.equal(r2.errors, 0, JSON.stringify(r2)));
    const auditRows2 = await db
      .select()
      .from(frontMatchAuditLog)
      .where(eq(frontMatchAuditLog.conversationId, CONV_MATCH));
    check("no duplicate audit row on re-run", () => assert.equal(auditRows2.length, 1));
  } finally {
    global.fetch = originalFetch;
    await db.delete(frontMatchAuditLog).where(inArray(frontMatchAuditLog.conversationId, ALL_CONVS));
    await db.delete(rawCommunicationRecords).where(inArray(rawCommunicationRecords.externalThreadId, [CONV_MATCH, CONV_NOSNAP]));
    await db.execute(
      (await import("drizzle-orm")).sql`DELETE FROM front_hydrate_snapshots WHERE conversation_id = ${CONV_MATCH}`,
    );
    await db.delete(frontSyncEmails).where(inArray(frontSyncEmails.conversationId, ALL_CONVS));
    await db.delete(frontFilterRules).where(inArray(frontFilterRules.id, [blockRule.id, neverRule.id]));
    await db.delete(clientContacts).where(inArray(clientContacts.clientId, clientIds));
    await db.delete(clients).where(inArray(clients.id, clientIds));
    invalidateFilterRulesCache();
    invalidateHardMatchIndexes();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error("front-rematch-unmatched-backlog test crashed:", err);
    process.exit(1);
  },
);
