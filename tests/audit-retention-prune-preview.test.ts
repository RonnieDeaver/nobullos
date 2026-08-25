/* test-registration
{
  "name": "Audit retention prune-preview (Task #1185)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for the read-only retention prune-preview helpers
 * (Task #1185).
 *
 * `estimatePruneStaleLeaseThresholdAudit` and `estimatePruneQueueTimingAudit`
 * back the "Saving will drop ~N rows" hint shown next to the Save button in
 * the audit retention editor. They MUST return the same row count that the
 * real prune helpers would delete, and MUST never write to the table — if
 * either invariant breaks, admins either get a misleading impact estimate or
 * the preview becomes silently destructive.
 *
 * Each scenario runs inside `runInTxSandbox` so DB state is rolled back.
 */

import { sql } from "drizzle-orm";
import { staleLeaseThresholdAudit, queueTimingAudit } from "@shared/schema";
import { getDb } from "../server/db";
import { runInTxSandbox } from "./db-sandbox";
import {
  estimatePruneStaleLeaseThresholdAudit,
  estimatePruneQueueTimingAudit,
  pruneStaleLeaseThresholdAudit,
  pruneQueueTimingAudit,
  ensureQueueTimingAuditTable,
} from "../server/storage/settingsStorage";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function clearStaleAudit(): Promise<void> {
  await getDb().execute(sql`DELETE FROM stale_lease_threshold_audit`);
}

async function clearQueueAudit(): Promise<void> {
  await ensureQueueTimingAuditTable();
  await getDb().execute(sql`DELETE FROM queue_timing_audit`);
}

async function insertStaleRow(changedAt: Date): Promise<string> {
  const [row] = await getDb()
    .insert(staleLeaseThresholdAudit)
    .values({
      changedBy: null,
      oldValues: null,
      newValues: { staleWarning: 1, staleCritical: 2, exhaustedWarning: 1, exhaustedCritical: 2, leaseCutoffMs: 60_000 },
    })
    .returning({ id: staleLeaseThresholdAudit.id });
  await getDb().execute(
    sql`UPDATE stale_lease_threshold_audit SET changed_at = ${changedAt} WHERE id = ${row.id}`,
  );
  return row.id;
}

async function insertQueueRow(changedAt: Date): Promise<string> {
  await ensureQueueTimingAuditTable();
  const [row] = await getDb()
    .insert(queueTimingAudit)
    .values({
      changedBy: null,
      oldValues: null,
      newValues: { pollIntervalMs: 5000, heartbeatIntervalMs: 60_000, baseBackoffMs: 10_000, maxBackoffMs: 600_000 },
    })
    .returning({ id: queueTimingAudit.id });
  await getDb().execute(
    sql`UPDATE queue_timing_audit SET changed_at = ${changedAt} WHERE id = ${row.id}`,
  );
  return row.id;
}

async function countStaleRows(): Promise<number> {
  const r = await getDb().execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM stale_lease_threshold_audit`,
  );
  return Number(r.rows?.[0]?.count ?? 0);
}

async function countQueueRows(): Promise<number> {
  await ensureQueueTimingAuditTable();
  const r = await getDb().execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM queue_timing_audit`,
  );
  return Number(r.rows?.[0]?.count ?? 0);
}

async function testStaleEstimateMatchesPrune(): Promise<void> {
  await runInTxSandbox(async () => {
    await clearStaleAudit();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // 4 rows: 30d, 10d, 2d, 1d.
    await insertStaleRow(new Date(now - 30 * day));
    await insertStaleRow(new Date(now - 10 * day));
    await insertStaleRow(new Date(now - 2 * day));
    await insertStaleRow(new Date(now - 1 * day));

    const before = await countStaleRows();
    assert(before === 4, `seed should leave 4 rows, got ${before}`);

    // Tightened bounds: maxAgeDays=7 removes 2 (30d, 10d); maxEntries=1 then
    // also removes the 2d row, keeping only the 1d row -> 3 total removed.
    const estimate = await estimatePruneStaleLeaseThresholdAudit({ maxAgeDays: 7, maxEntries: 1 });
    assert(estimate.total === 4, `estimate.total should be 4, got ${estimate.total}`);
    assert(estimate.wouldRemove === 3, `estimate.wouldRemove should be 3, got ${estimate.wouldRemove}`);

    // The estimate must NOT have mutated anything — the real prune should
    // still find the same number of rows to remove.
    const stillHere = await countStaleRows();
    assert(stillHere === 4, `estimate must not delete rows, table still has ${stillHere} (expected 4)`);

    const actuallyPruned = await pruneStaleLeaseThresholdAudit({ maxAgeDays: 7, maxEntries: 1 });
    assert(
      actuallyPruned === estimate.wouldRemove,
      `prune count (${actuallyPruned}) must match estimate (${estimate.wouldRemove})`,
    );
  });
  console.log("  ✓ stale-lease estimate matches real prune count and writes nothing");
}

async function testStaleEstimateZeroWhenBoundsLoose(): Promise<void> {
  await runInTxSandbox(async () => {
    await clearStaleAudit();
    await insertStaleRow(new Date(Date.now() - 1000));
    await insertStaleRow(new Date(Date.now() - 2000));
    await insertStaleRow(new Date(Date.now() - 3000));

    const estimate = await estimatePruneStaleLeaseThresholdAudit({ maxEntries: 500, maxAgeDays: 365 });
    assert(estimate.total === 3, `total should be 3, got ${estimate.total}`);
    assert(estimate.wouldRemove === 0, `wouldRemove should be 0, got ${estimate.wouldRemove}`);
  });
  console.log("  ✓ stale-lease estimate returns 0 when bounds are looser than current data");
}

async function testQueueEstimateMatchesPrune(): Promise<void> {
  await runInTxSandbox(async () => {
    await clearQueueAudit();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    await insertQueueRow(new Date(now - 30 * day));
    await insertQueueRow(new Date(now - 10 * day));
    await insertQueueRow(new Date(now - 2 * day));
    await insertQueueRow(new Date(now - 1 * day));
    await insertQueueRow(new Date(now - 500));

    const before = await countQueueRows();
    assert(before === 5, `seed should leave 5 rows, got ${before}`);

    // maxAgeDays=7 removes 2 (30d, 10d); maxEntries=2 keeps the two newest
    // (1d, 500ms) so it additionally removes the 2d row -> 3 total.
    const estimate = await estimatePruneQueueTimingAudit({ maxAgeDays: 7, maxEntries: 2 });
    assert(estimate.total === 5, `estimate.total should be 5, got ${estimate.total}`);
    assert(estimate.wouldRemove === 3, `estimate.wouldRemove should be 3, got ${estimate.wouldRemove}`);

    const stillHere = await countQueueRows();
    assert(stillHere === 5, `estimate must not delete rows, table still has ${stillHere} (expected 5)`);

    const actuallyPruned = await pruneQueueTimingAudit({ maxAgeDays: 7, maxEntries: 2 });
    assert(
      actuallyPruned === estimate.wouldRemove,
      `prune count (${actuallyPruned}) must match estimate (${estimate.wouldRemove})`,
    );
  });
  console.log("  ✓ queue-timing estimate matches real prune count and writes nothing");
}

async function testQueueEstimateNoBoundsReturnsZero(): Promise<void> {
  // When no bounds are supplied (the editor draft is incomplete / invalid),
  // the helper should short-circuit to 0 instead of doing a CTE.
  await runInTxSandbox(async () => {
    await clearQueueAudit();
    await insertQueueRow(new Date(Date.now() - 1000));
    await insertQueueRow(new Date(Date.now() - 2000));

    const estimate = await estimatePruneQueueTimingAudit({});
    assert(estimate.total === 2, `total should be 2, got ${estimate.total}`);
    assert(estimate.wouldRemove === 0, `wouldRemove should be 0 with no bounds, got ${estimate.wouldRemove}`);
  });
  console.log("  ✓ queue-timing estimate returns 0 when no bounds are supplied");
}

async function main(): Promise<void> {
  console.log("Audit retention prune-preview tests (Task #1185)");
  await testStaleEstimateMatchesPrune();
  await testStaleEstimateZeroWhenBoundsLoose();
  await testQueueEstimateMatchesPrune();
  await testQueueEstimateNoBoundsReturnsZero();
  console.log("All audit retention prune-preview tests passed.");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
