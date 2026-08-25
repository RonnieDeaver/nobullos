/* test-registration
{
  "name": "Stale-lease threshold audit prune",
  "tier": "medium"
}
test-registration */
/**
 * Regression coverage for `pruneStaleLeaseThresholdAudit` and the
 * `setStaleLeaseThresholds` -> prune wiring.
 *
 * The prune helper was added to mirror `pruneQueueTimingAudit` so the
 * `stale_lease_threshold_audit` table cannot grow unboundedly. These tests
 * pin three things so future refactors don't silently regress:
 *
 *   1. `pruneStaleLeaseThresholdAudit({ maxAgeDays })` deletes only rows
 *      strictly older than the cutoff and leaves rows on/after the cutoff
 *      alone.
 *   2. `pruneStaleLeaseThresholdAudit({ maxEntries })` keeps exactly the N
 *      most-recent rows, including the edge case where the computed
 *      survivor set is empty (keepIds.length === 0 branch) — in that case
 *      every row in the table is deleted.
 *   3. `setStaleLeaseThresholds` invokes the prune with the configured
 *      retention bounds AFTER a successful audit insert, and only when the
 *      threshold values actually changed.
 *
 * All DB work runs inside `runInTxSandbox` so it's rolled back regardless
 * of pass/fail.
 */

import { sql } from "drizzle-orm";
import { staleLeaseThresholdAudit } from "@shared/schema";
import { getDb } from "../server/db";
import { runInTxSandbox } from "./db-sandbox";
import {
  pruneStaleLeaseThresholdAudit,
  recordStaleLeaseThresholdChange,
} from "../server/storage/settingsStorage";
import { storage } from "../server/storage";
import {
  STALE_LEASE_THRESHOLD_AUDIT_RETENTION,
  STALE_LEASE_THRESHOLDS_KEY,
  setStaleLeaseThresholds,
  invalidateStaleLeaseThresholdsCache,
} from "../server/services/staleLeaseThresholds";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function clearAuditTable(): Promise<void> {
  await getDb().execute(sql`DELETE FROM stale_lease_threshold_audit`);
}

async function insertAuditRow(changedAt: Date): Promise<string> {
  const [row] = await getDb()
    .insert(staleLeaseThresholdAudit)
    .values({
      changedBy: null,
      oldValues: null,
      newValues: { staleWarning: 1, staleCritical: 2, exhaustedWarning: 1, exhaustedCritical: 2, leaseCutoffMs: 60_000 },
    })
    .returning({ id: staleLeaseThresholdAudit.id });
  // Force the changedAt so the row is deterministic for time-based pruning.
  await getDb().execute(
    sql`UPDATE stale_lease_threshold_audit SET changed_at = ${changedAt} WHERE id = ${row.id}`,
  );
  return row.id;
}

async function listAllIdsByRecency(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: staleLeaseThresholdAudit.id })
    .from(staleLeaseThresholdAudit)
    .orderBy(sql`changed_at DESC`);
  return rows.map((r) => r.id);
}

async function testMaxAgeDaysCutoff(): Promise<void> {
  await runInTxSandbox(async () => {
    await clearAuditTable();

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // Old rows: 30 and 10 days old (should be deleted at maxAgeDays=7).
    const old30 = await insertAuditRow(new Date(now - 30 * day));
    const old10 = await insertAuditRow(new Date(now - 10 * day));
    // Fresh row: 1 day old (should survive).
    const fresh1 = await insertAuditRow(new Date(now - 1 * day));

    const pruned = await pruneStaleLeaseThresholdAudit({ maxAgeDays: 7 });
    assert(pruned === 2, `expected 2 rows pruned by maxAgeDays, got ${pruned}`);

    const survivors = await listAllIdsByRecency();
    assert(survivors.length === 1, `expected 1 survivor, got ${survivors.length}`);
    assert(survivors[0] === fresh1, `expected fresh row to survive, got ${survivors[0]}`);
    assert(!survivors.includes(old30), "30-day-old row should have been pruned");
    assert(!survivors.includes(old10), "10-day-old row should have been pruned");

    // Second prune with same bound should be a no-op.
    const prunedAgain = await pruneStaleLeaseThresholdAudit({ maxAgeDays: 7 });
    assert(prunedAgain === 0, `second prune should remove 0 rows, got ${prunedAgain}`);
  });
  console.log("  ✓ maxAgeDays cutoff prunes only rows older than the window");
}

async function testMaxEntriesCap(): Promise<void> {
  await runInTxSandbox(async () => {
    await clearAuditTable();

    const now = Date.now();
    // 5 rows, oldest first.
    const t1 = new Date(now - 5000);
    const t2 = new Date(now - 4000);
    const t3 = new Date(now - 3000);
    const t4 = new Date(now - 2000);
    const t5 = new Date(now - 1000);
    const id1 = await insertAuditRow(t1);
    const id2 = await insertAuditRow(t2);
    const id3 = await insertAuditRow(t3);
    const id4 = await insertAuditRow(t4);
    const id5 = await insertAuditRow(t5);

    const pruned = await pruneStaleLeaseThresholdAudit({ maxEntries: 2 });
    assert(pruned === 3, `expected 3 rows pruned by maxEntries cap, got ${pruned}`);

    const survivors = await listAllIdsByRecency();
    assert(survivors.length === 2, `expected 2 survivors, got ${survivors.length}`);
    assert(survivors[0] === id5 && survivors[1] === id4,
      `expected the two newest rows to survive, got ${JSON.stringify(survivors)}`);
    assert(!survivors.includes(id1), "id1 should have been pruned");
    assert(!survivors.includes(id2), "id2 should have been pruned");
    assert(!survivors.includes(id3), "id3 should have been pruned");
  });
  console.log("  ✓ maxEntries cap keeps only the N most recent rows");
}

async function testEmptySurvivorsDeletesAll(): Promise<void> {
  // Edge case: when the computed `survivors` set is empty
  // (Math.floor(maxEntries) === 0), the function falls into the
  // keepIds.length === 0 branch and deletes EVERY row in the table.
  await runInTxSandbox(async () => {
    await clearAuditTable();

    await insertAuditRow(new Date(Date.now() - 3000));
    await insertAuditRow(new Date(Date.now() - 2000));
    await insertAuditRow(new Date(Date.now() - 1000));

    // 0.5 passes the `> 0` outer guard but Math.floor(0.5) === 0, so the
    // SELECT … LIMIT 0 returns no survivor ids.
    const pruned = await pruneStaleLeaseThresholdAudit({ maxEntries: 0.5 });
    assert(pruned === 3, `expected all 3 rows pruned when survivors is empty, got ${pruned}`);

    const survivors = await listAllIdsByRecency();
    assert(survivors.length === 0, `expected 0 survivors, got ${survivors.length}`);
  });
  console.log("  ✓ empty survivor set deletes every row (keepIds.length === 0 branch)");
}

async function testMaxEntriesAndMaxAgeCombined(): Promise<void> {
  await runInTxSandbox(async () => {
    await clearAuditTable();

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // 4 rows: 30d, 10d, 2d, 1d.
    await insertAuditRow(new Date(now - 30 * day));
    await insertAuditRow(new Date(now - 10 * day));
    const id2d = await insertAuditRow(new Date(now - 2 * day));
    const id1d = await insertAuditRow(new Date(now - 1 * day));

    // maxAgeDays=7 removes the 30d and 10d rows (2). maxEntries=1 then
    // keeps only the freshest (1d), removing the 2d row (1 more).
    const pruned = await pruneStaleLeaseThresholdAudit({ maxAgeDays: 7, maxEntries: 1 });
    assert(pruned === 3, `expected 3 rows pruned (2 by age + 1 by cap), got ${pruned}`);

    const survivors = await listAllIdsByRecency();
    assert(survivors.length === 1 && survivors[0] === id1d,
      `expected only the 1-day-old row to survive, got ${JSON.stringify(survivors)}`);
    assert(!survivors.includes(id2d), "2-day-old row should have been pruned by maxEntries");
  });
  console.log("  ✓ maxAgeDays and maxEntries combine correctly");
}

async function testSetStaleLeaseThresholdsInvokesPrune(): Promise<void> {
  // Wraps the live storage method to record invocations, then runs
  // setStaleLeaseThresholds inside the sandbox and asserts the call
  // happened with the configured retention bounds — and only after the
  // audit row was actually inserted.
  await runInTxSandbox(async () => {
    await clearAuditTable();
    // Make sure the cache doesn't short-circuit our "previous" read.
    invalidateStaleLeaseThresholdsCache();
    // Seed a baseline so the first setStaleLeaseThresholds call below has
    // a concrete "previous" snapshot to diff against.
    await storage.setSystemSetting(
      STALE_LEASE_THRESHOLDS_KEY,
      JSON.stringify({
        staleWarning: 3,
        staleCritical: 10,
        exhaustedWarning: 2,
        exhaustedCritical: 5,
        leaseCutoffMs: 300_000,
      }),
      "system",
    );
    invalidateStaleLeaseThresholdsCache();

    const pruneCalls: Array<{ maxEntries?: number; maxAgeDays?: number; auditCountAtCall: number }> = [];
    const originalPrune = storage.pruneStaleLeaseThresholdAudit.bind(storage);
    (storage as any).pruneStaleLeaseThresholdAudit = async (opts: { maxEntries?: number; maxAgeDays?: number }) => {
      const rows = await getDb().select({ id: staleLeaseThresholdAudit.id }).from(staleLeaseThresholdAudit);
      pruneCalls.push({ ...opts, auditCountAtCall: rows.length });
      return originalPrune(opts);
    };

    try {
      // Pass updatedBy=undefined so the storage layer writes NULL into
      // updated_by / changed_by — sidesteps the users FK without needing
      // to seed a user inside the sandbox.
      await setStaleLeaseThresholds({
        staleWarning: 4,
        staleCritical: 11,
        exhaustedWarning: 2,
        exhaustedCritical: 5,
        leaseCutoffMs: 300_000,
      });
    } finally {
      (storage as any).pruneStaleLeaseThresholdAudit = originalPrune;
    }

    assert(pruneCalls.length === 1,
      `expected prune to be called exactly once on a real change, got ${pruneCalls.length}`);
    const call = pruneCalls[0];
    assert(call.maxEntries === STALE_LEASE_THRESHOLD_AUDIT_RETENTION.maxEntries,
      `expected maxEntries=${STALE_LEASE_THRESHOLD_AUDIT_RETENTION.maxEntries}, got ${call.maxEntries}`);
    assert(call.maxAgeDays === STALE_LEASE_THRESHOLD_AUDIT_RETENTION.maxAgeDays,
      `expected maxAgeDays=${STALE_LEASE_THRESHOLD_AUDIT_RETENTION.maxAgeDays}, got ${call.maxAgeDays}`);
    // Critically: the audit insert must precede the prune so the row that
    // was just written is itself a candidate to be retained. If the audit
    // table was empty when prune ran, the ordering regressed.
    assert(call.auditCountAtCall >= 1,
      `expected audit row to exist before prune ran, table had ${call.auditCountAtCall} rows`);
  });
  console.log("  ✓ setStaleLeaseThresholds calls prune once after recording the audit row");
}

async function testSetStaleLeaseThresholdsSkipsPruneWhenUnchanged(): Promise<void> {
  // No-change path: prune must NOT run when the new values match the
  // current ones, mirroring the queue-timings behavior.
  await runInTxSandbox(async () => {
    await clearAuditTable();
    invalidateStaleLeaseThresholdsCache();
    const baseline = {
      staleWarning: 3,
      staleCritical: 10,
      exhaustedWarning: 2,
      exhaustedCritical: 5,
      leaseCutoffMs: 300_000,
    };
    await storage.setSystemSetting(
      STALE_LEASE_THRESHOLDS_KEY,
      JSON.stringify(baseline),
      "system",
    );
    invalidateStaleLeaseThresholdsCache();

    let pruneCallCount = 0;
    const originalPrune = storage.pruneStaleLeaseThresholdAudit.bind(storage);
    (storage as any).pruneStaleLeaseThresholdAudit = async (opts: { maxEntries?: number; maxAgeDays?: number }) => {
      pruneCallCount += 1;
      return originalPrune(opts);
    };

    try {
      // Exact same values — should not record an audit row and should not prune.
      await setStaleLeaseThresholds(baseline);
    } finally {
      (storage as any).pruneStaleLeaseThresholdAudit = originalPrune;
    }

    assert(pruneCallCount === 0,
      `expected prune to be skipped on a no-op change, got ${pruneCallCount} call(s)`);

    const auditRows = await getDb().select({ id: staleLeaseThresholdAudit.id }).from(staleLeaseThresholdAudit);
    assert(auditRows.length === 0,
      `expected no audit rows on a no-op change, got ${auditRows.length}`);
  });
  console.log("  ✓ setStaleLeaseThresholds does not prune when nothing changed");
}

async function testRecordChangeRoundtrip(): Promise<void> {
  // Sanity check: recordStaleLeaseThresholdChange persists what we asked
  // for, and pruneStaleLeaseThresholdAudit({ maxEntries: 1 }) keeps that
  // most-recent row even in the presence of older noise.
  await runInTxSandbox(async () => {
    await clearAuditTable();
    await insertAuditRow(new Date(Date.now() - 60_000));
    const recent = await recordStaleLeaseThresholdChange({
      changedBy: null,
      oldValues: { staleWarning: 1, staleCritical: 2, exhaustedWarning: 1, exhaustedCritical: 2, leaseCutoffMs: 60_000 },
      newValues: { staleWarning: 4, staleCritical: 5, exhaustedWarning: 1, exhaustedCritical: 2, leaseCutoffMs: 60_000 },
    });
    const pruned = await pruneStaleLeaseThresholdAudit({ maxEntries: 1 });
    assert(pruned === 1, `expected 1 row pruned, got ${pruned}`);
    const survivors = await listAllIdsByRecency();
    assert(survivors.length === 1 && survivors[0] === recent.id,
      `expected newest recorded row to survive, got ${JSON.stringify(survivors)}`);
  });
  console.log("  ✓ recordStaleLeaseThresholdChange + prune({maxEntries:1}) keeps the newest row");
}

async function main(): Promise<void> {
  console.log("Stale-lease threshold audit prune tests");
  await testMaxAgeDaysCutoff();
  await testMaxEntriesCap();
  await testEmptySurvivorsDeletesAll();
  await testMaxEntriesAndMaxAgeCombined();
  await testSetStaleLeaseThresholdsInvokesPrune();
  await testSetStaleLeaseThresholdsSkipsPruneWhenUnchanged();
  await testRecordChangeRoundtrip();
  console.log("All stale-lease threshold audit prune tests passed.");
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
