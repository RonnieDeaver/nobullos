/* test-registration
{
  "name": "Semrush sync-state claim/lease + stale-owner guard (workers parity E-F01/E-F16)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy focused worker-reliability suite (auto-retry claim races, runId finalization guard, sweep cutoff sourcing) in the style of the other custom-table worker suites; runs in the full suite and the nightly --regression sweep rather than the routine TEST_SMOKE gate.",
  "tier": "small"
}
test-registration */
/**
 * Workers/queues parity (E-F01/E-F16) — focused suite for the
 * semrush_location_sync_state lease controls shared by the Local
 * Dominance worker and the auto-retry lane:
 *
 *  - claimDueAutoRetries: atomic claim of due failed rows via
 *    FOR UPDATE SKIP LOCKED, with the pushed next_retry_at acting as a
 *    recoverable bounded lease (a crashed claimer's rows re-due on
 *    their own);
 *  - one owner under concurrent claims; non-due / terminal / NULL
 *    next_retry_at rows are never claimed;
 *  - completeAttempt expectedRunId guard: a stale owner (older runId)
 *    cannot finalize a row a newer run owns — row untouched, no attempt
 *    history recorded, staleRunIgnored flag returned; the current owner
 *    and legacy callers (no expectedRunId) write normally;
 *  - sweepStuckInProgress honors an injected cutoff (canonical
 *    local_dominance_sync ceiling at the call site) and promotes stuck
 *    rows to failed/timeout.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import {
  claimDueAutoRetries,
  completeAttempt,
  sweepStuckInProgress,
} from "../server/services/semrushLocationSyncState";

const MARKER = `t_srs_${process.pid}_${Date.now()}`;

let clientId = "";
let locationId = "";

async function seedParents(): Promise<void> {
  const cr = await workerDb.execute(sql`
    INSERT INTO clients (firm_name) VALUES (${`${MARKER} Firm`}) RETURNING id
  `);
  clientId = String((cr.rows?.[0] as any)?.id);
  const lr = await workerDb.execute(sql`
    INSERT INTO client_locations (client_id, name) VALUES (${clientId}, ${`${MARKER} Loc`}) RETURNING id
  `);
  locationId = String((lr.rows?.[0] as any)?.id);
}

interface SyncRow {
  id: string;
  status: string;
  next_retry_at: Date | null;
  run_id: string | null;
  last_error: string | null;
  error_category: string | null;
  imported_keyword_count: number;
  message: string | null;
}

async function insertSyncRow(opts: {
  status: string;
  campaignId?: string;
  nextRetryOffsetMs?: number | null; // relative to now; null/undefined = NULL
  lastAttemptOffsetMs?: number | null;
  runId?: string | null;
  attemptCount?: number;
}): Promise<{ id: string; campaignId: string }> {
  const campaignId = opts.campaignId ?? `${MARKER}_camp_${randomUUID().slice(0, 8)}`;
  const iv = (ms: number | null | undefined) =>
    ms == null ? sql`NULL` : sql`NOW() + (${Math.round(ms / 1000)} || ' seconds')::interval`;
  const r = await workerDb.execute(sql`
    INSERT INTO semrush_location_sync_state
      (client_id, location_id, campaign_id, status, attempt_count, max_attempts,
       next_retry_at, last_attempt_at, run_id, created_at, updated_at)
    VALUES
      (${clientId}, ${locationId}, ${campaignId}, ${opts.status}, ${opts.attemptCount ?? 1}, 3,
       ${iv(opts.nextRetryOffsetMs)}, ${iv(opts.lastAttemptOffsetMs)}, ${opts.runId ?? null}, NOW(), NOW())
    RETURNING id
  `);
  return { id: String((r.rows?.[0] as any)?.id), campaignId };
}

async function getRow(id: string): Promise<SyncRow> {
  const r = await workerDb.execute(sql`
    SELECT id, status, next_retry_at, run_id, last_error, error_category,
           imported_keyword_count, message
    FROM semrush_location_sync_state WHERE id = ${id}
  `);
  const row = r.rows?.[0] as unknown as SyncRow | undefined;
  assert.ok(row, `sync-state row ${id} should exist`);
  return row;
}

async function countAttemptHistory(syncStateId: string): Promise<number> {
  const r = await workerDb.execute(sql`
    SELECT COUNT(*)::int AS n FROM semrush_location_sync_attempts WHERE sync_state_id = ${syncStateId}
  `);
  return Number((r.rows?.[0] as any)?.n ?? 0);
}

async function cleanup(): Promise<void> {
  if (clientId) {
    // FK cascade removes locations + sync rows; attempts reference sync rows.
    await workerDb.execute(sql`
      DELETE FROM semrush_location_sync_attempts
      WHERE sync_state_id IN (SELECT id FROM semrush_location_sync_state WHERE client_id = ${clientId})
    `).catch(() => {});
    await workerDb.execute(sql`DELETE FROM semrush_location_sync_state WHERE client_id = ${clientId}`);
    await workerDb.execute(sql`DELETE FROM client_locations WHERE client_id = ${clientId}`);
    await workerDb.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  }
}

async function main(): Promise<void> {
  await seedParents();
  // Prune litter a SIGKILL'd earlier suite may have left: the claim
  // sweeps table-wide, so stray due rows would be claimed alongside our
  // fixtures and break exact-count asserts.
  await workerDb.execute(sql`
    DELETE FROM semrush_location_sync_state
    WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()
  `);
  try {
    // ------------------------------------------------------------------
    // 1. claimDueAutoRetries claims due rows and pushes next_retry_at
    //    forward as a bounded recoverable lease.
    // ------------------------------------------------------------------
    {
      const due = await insertSyncRow({ status: "failed", nextRetryOffsetMs: -5 * 60_000 });
      const notDue = await insertSyncRow({ status: "failed", nextRetryOffsetMs: 10 * 60_000 });
      const noRetry = await insertSyncRow({ status: "failed", nextRetryOffsetMs: null });
      const terminal = await insertSyncRow({ status: "succeeded", nextRetryOffsetMs: -5 * 60_000 });
      const inProgress = await insertSyncRow({ status: "in_progress", nextRetryOffsetMs: -5 * 60_000 });

      const leaseMs = 15 * 60_000;
      const before = Date.now();
      const claimed = await claimDueAutoRetries(10, leaseMs);
      assert.equal(claimed.length, 1, "only the due failed row is claimable");
      assert.equal(claimed[0].id, due.id);

      const row = await getRow(due.id);
      const nra = new Date(row.next_retry_at!).getTime();
      assert.ok(nra > before + leaseMs - 60_000, "next_retry_at pushed ~leaseMs into the future (lease taken)");
      assert.ok(nra < before + leaseMs + 60_000, "lease is bounded (not indefinite)");
      assert.equal(row.status, "failed", "claim does not change status — crash-recoverable by design");

      // Second sweep inside the lease window: nothing due.
      const second = await claimDueAutoRetries(10, leaseMs);
      assert.equal(second.length, 0, "an unexpired lease cannot be re-claimed");

      // Untouched rows.
      assert.equal((await getRow(notDue.id)).status, "failed");
      assert.ok(new Date((await getRow(notDue.id)).next_retry_at!).getTime() > Date.now(), "future retry untouched");
      assert.equal((await getRow(noRetry.id)).next_retry_at, null, "NULL next_retry_at (terminal budget) untouched");
      assert.equal((await getRow(terminal.id)).status, "succeeded");
      assert.equal((await getRow(inProgress.id)).status, "in_progress");

      // Expired lease recovers on its own: simulate a crashed claimer by
      // rewinding next_retry_at past due again — claimable once more.
      await workerDb.execute(sql`
        UPDATE semrush_location_sync_state SET next_retry_at = NOW() - interval '1 minute' WHERE id = ${due.id}
      `);
      const reclaimed = await claimDueAutoRetries(10, leaseMs);
      assert.equal(reclaimed.length, 1, "an expired lease is reclaimable (no permanent lock)");
      assert.equal(reclaimed[0].id, due.id);
      await workerDb.execute(sql`DELETE FROM semrush_location_sync_state WHERE client_id = ${clientId}`);
      console.log("PASS: claimDueAutoRetries bounded-lease semantics");
    }

    // ------------------------------------------------------------------
    // 2. Concurrent claims: one due row, two claimers -> exactly one owner.
    // ------------------------------------------------------------------
    {
      const due = await insertSyncRow({ status: "failed", nextRetryOffsetMs: -60_000 });
      const [a, b] = await Promise.all([
        claimDueAutoRetries(1, 15 * 60_000),
        claimDueAutoRetries(1, 15 * 60_000),
      ]);
      const winners = [...a, ...b];
      assert.equal(winners.length, 1, `exactly one concurrent claimer wins (got ${winners.length})`);
      assert.equal(winners[0].id, due.id);
      await workerDb.execute(sql`DELETE FROM semrush_location_sync_state WHERE client_id = ${clientId}`);
      console.log("PASS: concurrent auto-retry claims produce one owner");
    }

    // ------------------------------------------------------------------
    // 3. completeAttempt stale-owner guard (expectedRunId).
    // ------------------------------------------------------------------
    {
      const { id, campaignId } = await insertSyncRow({
        status: "in_progress",
        runId: "run-NEW",
        lastAttemptOffsetMs: -60_000,
      });
      const historyBefore = await countAttemptHistory(id);

      // Stale owner (older runId) tries to finalize: skipped entirely.
      const stale = await completeAttempt({
        clientId,
        locationId,
        campaignId,
        status: "succeeded",
        importedKeywordCount: 42,
        expectedRunId: "run-OLD",
      });
      assert.equal((stale as any).staleRunIgnored, true, "stale finalization flagged");
      const afterStale = await getRow(id);
      assert.equal(afterStale.status, "in_progress", "newer run's in-flight state untouched");
      assert.equal(Number(afterStale.imported_keyword_count), 0, "no business output written by the stale owner");
      assert.equal(await countAttemptHistory(id), historyBefore, "no attempt history recorded for the stale write");

      // Current owner finalizes normally (business output unchanged).
      const ok = await completeAttempt({
        clientId,
        locationId,
        campaignId,
        status: "succeeded",
        importedKeywordCount: 42,
        expectedKeywordCount: 42,
        expectedRunId: "run-NEW",
      });
      assert.notEqual((ok as any).staleRunIgnored, true);
      const afterOk = await getRow(id);
      assert.equal(afterOk.status, "succeeded");
      assert.equal(Number(afterOk.imported_keyword_count), 42, "current owner's business output persisted");
      assert.equal(await countAttemptHistory(id), historyBefore + 1, "attempt history recorded once");

      // Legacy caller (no expectedRunId) keeps last-writer-wins.
      const legacy = await completeAttempt({
        clientId,
        locationId,
        campaignId,
        status: "partial",
        importedKeywordCount: 10,
      });
      assert.notEqual((legacy as any).staleRunIgnored, true, "legacy callers unaffected by the guard");
      assert.equal((await getRow(id)).status, "partial");
      await workerDb.execute(sql`DELETE FROM semrush_location_sync_state WHERE client_id = ${clientId}`);
      console.log("PASS: expectedRunId guard blocks stale finalization only");
    }

    // ------------------------------------------------------------------
    // 4. sweepStuckInProgress honors the injected cutoff (the worker now
    //    passes the canonical local_dominance_sync ceiling).
    // ------------------------------------------------------------------
    {
      const stuck = await insertSyncRow({ status: "in_progress", lastAttemptOffsetMs: -10 * 60_000 });
      const fresh = await insertSyncRow({ status: "in_progress", lastAttemptOffsetMs: -1 * 60_000 });

      // Default 4h cutoff: neither row is stuck.
      const sweptDefault = await sweepStuckInProgress();
      const stuckAfterDefault = await getRow(stuck.id);
      assert.equal(stuckAfterDefault.status, "in_progress", "10min-old row not stuck at the 4h default");

      // Injected 5-minute cutoff: only the 10-minute-old row is promoted.
      const swept = await sweepStuckInProgress(5 * 60_000);
      assert.ok(swept >= 1, "customized cutoff promotes the stuck row");
      const promoted = await getRow(stuck.id);
      assert.equal(promoted.status, "failed", "stuck row promoted to failed");
      assert.equal(promoted.error_category, "timeout", "typed timeout category");
      assert.match(String(promoted.last_error), /0\.1-hour cutoff/, "message reflects the injected cutoff, not the constant");
      assert.equal((await getRow(fresh.id)).status, "in_progress", "fresh in-flight row untouched");
      assert.ok((await countAttemptHistory(stuck.id)) >= 1, "sweep records attempt history");
      console.log(`PASS: sweepStuckInProgress cutoff injection (swept=${swept}, default=${sweptDefault})`);
    }

    console.log("ALL semrush sync-state lease-control tests passed");
  } finally {
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("FAIL:", err);
    process.exit(1);
  },
);
