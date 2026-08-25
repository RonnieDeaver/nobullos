/* test-registration
{
  "name": "Unmatched-backlog prod actions: estimate, enqueue, handler lift (Task #4049)",
  "smoke": true,
  "smokeReason": "Fast fixture-scoped DB test: covers both Task #4049 CEO buttons — delta-asserted estimate SQL, durable producer enqueue with in-flight no-op, handler batch routing, and the terminal-partial-page finalizer chain (defer while batches pending, settled lift row exactly once).",
  "tier": "small"
}
test-registration */
// Task #4049 — the two CEO buttons and their drain wiring:
//
//   `seed_client_trusted_email_domains`
//     - registered in PROD_ACTIONS; status() returns a reviewable state
//       without throwing (derivation itself is pinned in
//       tests/client-domain-seeding.test.ts).
//
//   `rematch_unmatched_front_backlog`
//     - `countRematchableUnmatchedSyncEmails` (the status() estimate) counts
//       ONLY rows with a HUMAN sender on a single-owner trusted domain —
//       DELTA-asserted against a pre-seed baseline so other suites' litter in
//       the shared run DB cannot flake the test. Automated-only rows,
//       resolver-adjudicated `[shared_…` rows, and already-matched rows are
//       all excluded.
//     - apply() enqueues ONE durable `front_sync_reprocess` producer job with
//       the `rematchUnmatchedBacklog` payload flag + baselines; a second
//       apply() while the chain is in flight is a no-op (no second producer).
//     - the REGISTERED work-queue handler routes flagged id-batches through
//       the deterministic re-match core (cursor string `unmatched_rematch:…`);
//       the TERMINAL enumeration page (normal case: a partial page) enqueues a
//       finalize-only continuation whose settle-gate defers until every
//       fan-out batch reaches a terminal state, then records the before/after
//       lift in `prod_action_runs` exactly once (version-marker idempotence).
//
// Hermetic: pre-seeded raw record + hydrate snapshot suppress Front ingest.
// The empty-cohort completion is exercised with a far-future cursor; the
// chain e2e then drives the handler's own real work_queue rows in scheduler
// order over the live (fixture-dominated) cohort with fixture-scoped asserts.

import assert from "node:assert/strict";
import { eq, inArray, sql as dsql } from "drizzle-orm";
import { db } from "../server/db";
import {
  clients,
  clientContacts,
  users,
  frontSyncEmails,
  frontMatchAuditLog,
  rawCommunicationRecords,
  workQueue,
  prodActionRuns,
} from "@shared/schema";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  countRematchableUnmatchedSyncEmails,
  isUnmatchedBacklogRematchActive,
} from "../server/services/frontIntegration";
import { invalidateHardMatchIndexes } from "../server/services/frontHardMatch";
import { registerAllHandlers } from "../server/services/workQueueHandlers";
import { getRegisteredHandler } from "../server/services/workScheduler";

const TAG = `4049p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const DOM_TRUSTED = `trusted-action-${TAG}.com`;

const CONV_CLAIMABLE = `conv-${TAG}-claimable`;
const CONV_AUTOMATED = `conv-${TAG}-automated`;
const CONV_SHARED = `conv-${TAG}-shared`;
const CONV_MATCHED = `conv-${TAG}-matched`;
const CONV_CHAIN = `conv-${TAG}-chain`;
const ALL_CONVS = [CONV_CLAIMABLE, CONV_AUTOMATED, CONV_SHARED, CONV_MATCHED, CONV_CHAIN];

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

async function deleteRematchQueueJobs(): Promise<void> {
  await db.execute(dsql`
    DELETE FROM work_queue
    WHERE queue_name = 'front_sync_reprocess'
      AND payload->>'rematchUnmatchedBacklog' = 'true'
  `);
}

async function run(): Promise<void> {
  await db.insert(users).values({ id: "system" } as any).onConflictDoNothing();

  // Other suites (or earlier crashed runs) may have left flagged queue jobs —
  // they would make isUnmatchedBacklogRematchActive() true and poison the
  // enqueue assertions. The runner is serial, so clearing them is safe.
  await deleteRematchQueueJobs();

  const [client] = await db
    .insert(clients)
    .values({ firmName: `Action Firm ${TAG}`, isArchived: false, emailDomains: [DOM_TRUSTED] } as any)
    .returning();
  invalidateHardMatchIndexes();

  const seedAction = PROD_ACTIONS.find((a) => a.id === "seed_client_trusted_email_domains");
  const rematchAction = PROD_ACTIONS.find((a) => a.id === "rematch_unmatched_front_backlog");

  check("both Task #4049 actions are registered", () => {
    assert.ok(seedAction, "seed_client_trusted_email_domains missing from PROD_ACTIONS");
    assert.ok(rematchAction, "rematch_unmatched_front_backlog missing from PROD_ACTIONS");
    assert.ok(!seedAction!.selfHeal, "seeding is a reviewed config write — must have NO selfHeal");
    // Task #4762 — the re-match is deterministic and idempotent, so it now
    // drains itself: enrolled in self-heal (6h/6h) instead of waiting for a
    // manual re-press, with the domain-edit feeder as the primary trigger.
    assert.deepEqual(
      rematchAction!.selfHeal,
      { cadenceMs: 6 * 60 * 60 * 1000, backoffMs: 6 * 60 * 60 * 1000 },
      "re-match must be self-heal enrolled at 6h/6h (Task #4762)",
    );
  });

  try {
    // ── Estimate: delta-asserted around OUR fixtures ────────────────────────
    const baseline = await countRematchableUnmatchedSyncEmails();
    check("trusted-domain set includes the fixture domain", () =>
      assert.ok(baseline.trustedDomains >= 1, `trustedDomains=${baseline.trustedDomains}`));

    const mkRow = async (conversationId: string, senderEmail: string, extra: Record<string, unknown> = {}) => {
      const [row] = await db
        .insert(frontSyncEmails)
        .values({
          conversationId,
          subject: `Subject ${conversationId}`,
          snippet: "snippet",
          participantsJson: [
            { name: "Sender", email: senderEmail, role: "from" },
            { name: "Ops", email: "ops@nobullmarketing.com", role: "to" },
          ] as any,
          matchStatus: "unmatched",
          pipelineState: "applied",
          versionKey: `${conversationId}::no_msg`,
          lastMessageAt: new Date(),
          ...extra,
        } as any)
        .returning();
      return row.id;
    };

    const idClaimable = await mkRow(CONV_CLAIMABLE, `human@${DOM_TRUSTED}`);
    await mkRow(CONV_AUTOMATED, `noreply@${DOM_TRUSTED}`);
    await mkRow(CONV_SHARED, `human2@${DOM_TRUSTED}`, {
      matchReason: "[shared_domain] Domain signals point to 2 clients",
    });
    await mkRow(CONV_MATCHED, `human3@${DOM_TRUSTED}`, {
      matchStatus: "auto_matched",
      matchedClientId: client.id,
    });

    const withRows = await countRematchableUnmatchedSyncEmails();
    check("estimate counts ONLY the human-claimable row (delta +1)", () =>
      assert.equal(
        withRows.count,
        baseline.count + 1,
        `baseline=${baseline.count} withRows=${withRows.count} (automated/shared/matched must not count)`,
      ));

    // ── status() → pending with a claimable count ──────────────────────────
    const st1 = await rematchAction!.status();
    check("status() is pending when claimable rows exist", () =>
      assert.equal(st1.state, "pending", JSON.stringify(st1)));

    // ── apply() → durable producer job ─────────────────────────────────────
    const ap1 = await rematchAction!.apply();
    check("apply() reports applied with baseline counts", () => {
      assert.equal(ap1.state, "applied", JSON.stringify(ap1));
      assert.match(ap1.detail ?? "", /Enqueued fanned-out re-match drain/);
    });
    const producerRows = (await db.execute(dsql`
      SELECT id, dedupe_key, payload FROM work_queue
      WHERE queue_name = 'front_sync_reprocess'
        AND payload->>'rematchUnmatchedBacklog' = 'true'
        AND status IN ('pending', 'leased', 'processing')
    `)).rows as Array<{ id: string; dedupe_key: string | null; payload: any }>;
    check("exactly one flagged producer job is queued", () => {
      assert.equal(producerRows.length, 1, JSON.stringify(producerRows));
      assert.match(producerRows[0].dedupe_key ?? "", /^producer:unmatched_backlog_rematch:v\d+$/);
      const payload = producerRows[0].payload;
      assert.equal(payload.cohort, "unmatched");
      assert.equal(typeof payload.baselineUnmatched, "number");
      assert.equal(typeof payload.baselineAutoMatched, "number");
    });
    const activeNow = await isUnmatchedBacklogRematchActive();
    check("active-chain probe returns true while the producer is pending", () =>
      assert.equal(activeNow, true));

    const st2 = await rematchAction!.status();
    check("status() reports the in-flight chain", () => {
      assert.equal(st2.state, "pending", JSON.stringify(st2));
      assert.match(st2.detail ?? "", /in flight/);
    });
    const ap2 = await rematchAction!.apply();
    check("re-press while active is a no-op (no second chain)", () =>
      assert.match(ap2.detail ?? "", /already in flight/));
    const producerCount = (await db.execute(dsql`
      SELECT count(*)::int AS n FROM work_queue
      WHERE queue_name = 'front_sync_reprocess'
        AND payload->>'rematchUnmatchedBacklog' = 'true'
    `)).rows as Array<{ n: number }>;
    check("still exactly one flagged job after the re-press", () =>
      assert.equal(producerCount[0].n, 1, JSON.stringify(producerCount)));

    // ── Handler: flagged id-batch routes through the re-match core ─────────
    registerAllHandlers();
    const handler = getRegisteredHandler("front_sync_reprocess");
    check("front_sync_reprocess handler is registered", () => assert.ok(handler));

    // Satisfy applyMatchedConversation for the claimable row (existing-record
    // branch + snapshot) so the batch actually flips it without Front egress.
    await db.execute(dsql`
      INSERT INTO front_hydrate_snapshots
        (conversation_id, version_key, conversation_json, messages_json, message_count)
      VALUES (${CONV_CLAIMABLE}, ${`${CONV_CLAIMABLE}::no_msg`}, '{}'::jsonb, '[]'::jsonb, 0)
    `);
    await db.insert(rawCommunicationRecords).values({
      clientId: client.id,
      sourceType: "front_email",
      title: "raw claimable",
      timestamp: new Date(),
      externalSourceId: CONV_CLAIMABLE,
      externalThreadId: CONV_CLAIMABLE,
    } as any);

    const batchJob = {
      id: `job-${TAG}-batch`,
      queueName: "front_sync_reprocess",
      workloadClass: "repair",
      priority: 50,
      payload: {
        syncEmailIds: [idClaimable],
        rematchUnmatchedBacklog: true,
        producerVersion: 999_999,
      },
      maxAttempts: 3,
    } as any;
    const batchResult = (await handler!(batchJob)) as { cursor?: string } | void;
    check("flagged batch routes through the unmatched re-match core", () => {
      assert.ok(batchResult && batchResult.cursor, "handler must return a cursor");
      assert.match(batchResult!.cursor!, /^unmatched_rematch:batch:1,matched:1,/, batchResult!.cursor);
    });
    const [claimableAfter] = await db
      .select()
      .from(frontSyncEmails)
      .where(eq(frontSyncEmails.id, idClaimable));
    check("claimable row flipped to auto_matched via the handler path", () => {
      assert.equal(claimableAfter.matchStatus, "auto_matched");
      assert.equal(claimableAfter.matchedClientId, client.id);
    });
    const estAfter = await countRematchableUnmatchedSyncEmails();
    check("estimate converges back to baseline once the row leaves the cohort", () =>
      assert.equal(estAfter.count, baseline.count, `baseline=${baseline.count} after=${estAfter.count}`));

    // ── Handler: empty enumeration records the before/after lift ───────────
    const completionJob = {
      id: `job-${TAG}-completion`,
      queueName: "front_sync_reprocess",
      workloadClass: "repair",
      priority: 50,
      payload: {
        cohort: "unmatched",
        rematchUnmatchedBacklog: true,
        producerVersion: 999_999,
        baselineUnmatched: 12_345,
        baselineAutoMatched: 42,
        cumulativeOffset: 7,
        maxItems: 10,
        // Far-future cursor → enumeration returns zero ids immediately (never
        // scans other suites' unmatched litter).
        cursorState: { createdAt: "2099-01-01T00:00:00.000Z", id: "zzzzzzzz" },
      },
      maxAttempts: 3,
    } as any;
    const completionResult = (await handler!(completionJob)) as { cursor?: string } | void;
    check("completion continuation reports the cumulative cursor", () => {
      assert.ok(completionResult && completionResult.cursor, "handler must return a cursor");
      assert.match(completionResult!.cursor!, /^complete:cumulative:7,/, completionResult!.cursor);
    });
    const liftRows = await db
      .select()
      .from(prodActionRuns)
      .where(eq(prodActionRuns.actionId, "rematch_unmatched_front_backlog"));
    check("completion recorded the before/after lift in prod_action_runs", () => {
      const mine = liftRows.filter((r) => (r.detail ?? "").includes("auto_matched: 42 →"));
      assert.equal(mine.length, 1, `lift rows: ${JSON.stringify(liftRows.map((r) => r.detail))}`);
      assert.match(mine[0].detail ?? "", /unmatched: 12345 →/);
      assert.equal(mine[0].outcomeState, "applied");
      assert.equal(mine[0].actorUserId, null);
    });

    // ── Full chain e2e: terminal PARTIAL page → finalizer defers while ─────
    // batches are pending → settles with post-apply counts, exactly once.
    // This drives REAL work_queue rows (the handler's own enqueues) through
    // the registered handler in scheduler order, so it covers the normal
    // (< CHUNK_SIZE) terminal page the far-future-cursor case above cannot.
    const V2 = 999_998;
    const idChain = await mkRow(CONV_CHAIN, `human-chain@${DOM_TRUSTED}`);
    await db.execute(dsql`
      INSERT INTO front_hydrate_snapshots
        (conversation_id, version_key, conversation_json, messages_json, message_count)
      VALUES (${CONV_CHAIN}, ${`${CONV_CHAIN}::no_msg`}, '{}'::jsonb, '[]'::jsonb, 0)
    `);
    await db.insert(rawCommunicationRecords).values({
      clientId: client.id,
      sourceType: "front_email",
      title: "raw chain",
      timestamp: new Date(),
      externalSourceId: CONV_CHAIN,
      externalThreadId: CONV_CHAIN,
    } as any);

    const jobFromRow = (row: { id: string; priority: number | null; payload: any; maxAttempts: number | null }) =>
      ({
        id: row.id,
        queueName: "front_sync_reprocess",
        workloadClass: "repair",
        priority: row.priority ?? 50,
        payload: row.payload,
        maxAttempts: row.maxAttempts ?? 3,
      }) as any;
    const flaggedRowsV2 = async (extraSql: ReturnType<typeof dsql>) =>
      (await db.execute(dsql`
        SELECT id, priority, payload, max_attempts AS "maxAttempts", retry_at AS "retryAt"
        FROM work_queue
        WHERE queue_name = 'front_sync_reprocess'
          AND status = 'pending'
          AND payload->>'rematchUnmatchedBacklog' = 'true'
          AND payload->>'producerVersion' = ${String(V2)}
          AND ${extraSql}
        ORDER BY created_at ASC
      `)).rows as Array<{ id: string; priority: number | null; payload: any; maxAttempts: number | null; retryAt: string | null }>;
    const markDone = (id: string) =>
      db.execute(dsql`UPDATE work_queue SET status = 'completed' WHERE id = ${id}`);

    // 1) Enumerate to exhaustion WITHOUT running any batches, so the terminal
    //    page fires while its fan-out is still pending. The first enumerate is
    //    synthetic; every continuation it spawns is a real row.
    await handler!({
      id: `job-${TAG}-enum`,
      queueName: "front_sync_reprocess",
      workloadClass: "repair",
      priority: 50,
      payload: {
        cohort: "unmatched",
        rematchUnmatchedBacklog: true,
        producerVersion: V2,
        baselineUnmatched: 500,
        baselineAutoMatched: 5,
        maxItems: 5_000,
      },
      maxAttempts: 3,
    } as any);
    for (let i = 0; i < 12; i++) {
      const conts = await flaggedRowsV2(
        dsql`payload->'syncEmailIds' IS NULL AND payload->>'finalizeOnly' IS DISTINCT FROM 'true'`,
      );
      if (conts.length === 0) break;
      await handler!(jobFromRow(conts[0]));
      await markDone(conts[0].id);
    }

    const finalizePending = await flaggedRowsV2(dsql`payload->>'finalizeOnly' = 'true'`);
    check("terminal partial page enqueued exactly one finalize-only continuation", () =>
      assert.equal(finalizePending.length, 1, JSON.stringify(finalizePending.map((r) => r.payload))));
    const batchesPending = await flaggedRowsV2(dsql`payload->'syncEmailIds' IS NOT NULL`);
    check("fan-out batches are still pending when the finalizer first runs", () =>
      assert.ok(batchesPending.length >= 1, `batches=${batchesPending.length}`));
    check("a pending batch covers the fresh claimable row", () =>
      assert.ok(
        batchesPending.some((b) => (b.payload.syncEmailIds as string[]).includes(idChain)),
        "chain row missing from fan-out",
      ));

    // 2) Finalizer runs EARLY (batches pending) → must defer, not report.
    const deferRes = (await handler!(jobFromRow(finalizePending[0]))) as { cursor?: string };
    await markDone(finalizePending[0].id);
    check("finalizer defers while batches are in flight", () =>
      assert.match(deferRes.cursor ?? "", /^finalize_deferred:wait1,/, deferRes.cursor));
    const markerV2 = `(v${V2},`;
    const liftCountEarly = (await db
      .select()
      .from(prodActionRuns)
      .where(eq(prodActionRuns.actionId, "rematch_unmatched_front_backlog")))
      .filter((r) => (r.detail ?? "").includes(markerV2)).length;
    check("no completion row is written before batches settle", () =>
      assert.equal(liftCountEarly, 0));
    const deferredRows = await flaggedRowsV2(dsql`payload->>'finalizeOnly' = 'true'`);
    check("deferred finalizer re-enqueued durably with a retry delay", () => {
      assert.equal(deferredRows.length, 1, JSON.stringify(deferredRows.map((r) => r.payload)));
      assert.equal(deferredRows[0].payload.finalizeWaitCount, 1);
      assert.ok(
        deferredRows[0].retryAt && new Date(deferredRows[0].retryAt).getTime() > Date.now(),
        `retryAt=${deferredRows[0].retryAt}`,
      );
    });

    // 3) Batches run and settle.
    for (const b of batchesPending) {
      const r = (await handler!(jobFromRow(b))) as { cursor?: string };
      assert.match(r.cursor ?? "", /^unmatched_rematch:batch:/, r.cursor);
      await markDone(b.id);
    }
    const [chainAfter] = await db.select().from(frontSyncEmails).where(eq(frontSyncEmails.id, idChain));
    check("chain claimable row auto_matched once batches ran", () => {
      assert.equal(chainAfter.matchStatus, "auto_matched");
      assert.equal(chainAfter.matchedClientId, client.id);
    });

    // 4) Deferred finalizer now settles: exactly one completion row with
    //    POST-apply counts (the chain row's match is included).
    const settleRes = (await handler!(jobFromRow(deferredRows[0]))) as { cursor?: string };
    await markDone(deferredRows[0].id);
    check("finalizer completes once batches settled", () =>
      assert.match(settleRes.cursor ?? "", /^complete:cumulative:/, settleRes.cursor));
    const autoMatchedNow = ((await db.execute(dsql`
      SELECT count(*)::int AS n FROM front_sync_emails WHERE match_status = 'auto_matched'
    `)).rows as Array<{ n: number }>)[0].n;
    const liftRowsV2 = (await db
      .select()
      .from(prodActionRuns)
      .where(eq(prodActionRuns.actionId, "rematch_unmatched_front_backlog")))
      .filter((r) => (r.detail ?? "").includes(markerV2));
    check("exactly one completion row, reporting settled post-apply counts", () => {
      assert.equal(liftRowsV2.length, 1, JSON.stringify(liftRowsV2.map((r) => r.detail)));
      assert.match(liftRowsV2[0].detail ?? "", /all fan-out batches settled/);
      assert.ok(
        (liftRowsV2[0].detail ?? "").includes(`auto_matched: 5 → ${autoMatchedNow}`),
        `detail="${liftRowsV2[0].detail}" live auto_matched=${autoMatchedNow}`,
      );
    });

    // 5) A retried finalizer (queue redelivery) must not double-write.
    const retryRes = (await handler!(jobFromRow(deferredRows[0]))) as { cursor?: string };
    check("retried finalizer suppresses a duplicate lift row", () =>
      assert.match(retryRes.cursor ?? "", /^complete:duplicate_lift_suppressed,/, retryRes.cursor));
    const liftCountFinal = (await db
      .select()
      .from(prodActionRuns)
      .where(eq(prodActionRuns.actionId, "rematch_unmatched_front_backlog")))
      .filter((r) => (r.detail ?? "").includes(markerV2)).length;
    check("still exactly one completion row after the retry", () =>
      assert.equal(liftCountFinal, 1));

    // ── Seeding action smoke: status() returns a reviewable state ──────────
    const seedStatus = await seedAction!.status();
    check("seeding action status() returns a valid state without throwing", () =>
      assert.ok(["pending", "not-needed"].includes(seedStatus.state), JSON.stringify(seedStatus)));
  } finally {
    global.fetch = originalFetch;
    await deleteRematchQueueJobs();
    await db.delete(prodActionRuns).where(eq(prodActionRuns.actionId, "rematch_unmatched_front_backlog"));
    await db.delete(frontMatchAuditLog).where(inArray(frontMatchAuditLog.conversationId, ALL_CONVS));
    await db
      .delete(rawCommunicationRecords)
      .where(inArray(rawCommunicationRecords.externalThreadId, [CONV_CLAIMABLE, CONV_CHAIN]));
    await db.execute(
      dsql`DELETE FROM front_hydrate_snapshots WHERE conversation_id IN (${CONV_CLAIMABLE}, ${CONV_CHAIN})`,
    );
    await db.delete(frontSyncEmails).where(inArray(frontSyncEmails.conversationId, ALL_CONVS));
    await db.delete(clientContacts).where(eq(clientContacts.clientId, client.id));
    await db.delete(clients).where(eq(clients.id, client.id));
    invalidateHardMatchIndexes();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error("prod-action-rematch-unmatched-backlog test crashed:", err);
    process.exit(1);
  },
);
