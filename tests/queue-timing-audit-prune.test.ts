/* test-registration
{
  "name": "Queue-timing audit prune (Task #716)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for `pruneQueueTimingAudit` and the
 * `setQueueTimings` -> prune wiring.
 *
 * These helpers were the original model for `pruneStaleLeaseThresholdAudit`
 * / `setStaleLeaseThresholds`, but they had no automated coverage of their
 * own. Without tests, future refactors of the queue-timing retention logic
 * could silently regress and `queue_timing_audit` could start growing
 * unboundedly again. These tests pin three things:
 *
 *   1. `pruneQueueTimingAudit({ maxAgeDays })` deletes only rows strictly
 *      older than the cutoff and leaves rows on/after the cutoff alone.
 *   2. `pruneQueueTimingAudit({ maxEntries })` keeps exactly the N most
 *      recent rows, including the edge case where the computed survivor
 *      set is empty (keepIds.length === 0 branch) — in that case every
 *      row in the table is deleted.
 *   3. `setQueueTimings` invokes the prune with the configured retention
 *      bounds AFTER a successful audit insert, and only when the timing
 *      values actually changed.
 *
 * All DB work runs inside `runInTxSandbox` so it's rolled back regardless
 * of pass/fail.
 */

import { sql } from "drizzle-orm";
import { queueTimingAudit } from "@shared/schema";
import { getDb } from "../server/db";
import { runInTxSandbox } from "./db-sandbox";
import {
  pruneQueueTimingAudit,
  recordQueueTimingChange,
} from "../server/storage/settingsStorage";
import { storage } from "../server/storage";
import {
  QUEUE_TIMING_AUDIT_RETENTION,
  QUEUE_TIMING_SETTINGS_KEY,
  DEFAULT_QUEUE_TIMINGS,
  setQueueTimings,
  invalidateQueueTimingsCache,
} from "../server/services/queueTimingSettings";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function clearAuditTable(): Promise<void> {
  await getDb().execute(sql`DELETE FROM queue_timing_audit`);
}

async function insertAuditRow(changedAt: Date): Promise<string> {
  const [row] = await getDb()
    .insert(queueTimingAudit)
    .values({
      changedBy: null,
      oldValues: null,
      newValues: { ...DEFAULT_QUEUE_TIMINGS },
    })
    .returning({ id: queueTimingAudit.id });
  // Force the changedAt so the row is deterministic for time-based pruning.
  await getDb().execute(
    sql`UPDATE queue_timing_audit SET changed_at = ${changedAt} WHERE id = ${row.id}`,
  );
  return row.id;
}

async function listAllIdsByRecency(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: queueTimingAudit.id })
    .from(queueTimingAudit)
    .orderBy(sql`changed_at DESC`);
  return rows.map((r) => r.id);
}

async function testMaxAgeDaysCutoff(): Promise<void> {
  await runInTxSandbox(async () => {
    await clearAuditTable();

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const old30 = await insertAuditRow(new Date(now - 30 * day));
    const old10 = await insertAuditRow(new Date(now - 10 * day));
    const fresh1 = await insertAuditRow(new Date(now - 1 * day));

    const pruned = await pruneQueueTimingAudit({ maxAgeDays: 7 });
    assert(pruned === 2, `expected 2 rows pruned by maxAgeDays, got ${pruned}`);

    const survivors = await listAllIdsByRecency();
    assert(survivors.length === 1, `expected 1 survivor, got ${survivors.length}`);
    assert(survivors[0] === fresh1, `expected fresh row to survive, got ${survivors[0]}`);
    assert(!survivors.includes(old30), "30-day-old row should have been pruned");
    assert(!survivors.includes(old10), "10-day-old row should have been pruned");

    const prunedAgain = await pruneQueueTimingAudit({ maxAgeDays: 7 });
    assert(prunedAgain === 0, `second prune should remove 0 rows, got ${prunedAgain}`);
  });
  console.log("  ✓ maxAgeDays cutoff prunes only rows older than the window");
}

async function testMaxEntriesCap(): Promise<void> {
  await runInTxSandbox(async () => {
    await clearAuditTable();

    const now = Date.now();
    const id1 = await insertAuditRow(new Date(now - 5000));
    const id2 = await insertAuditRow(new Date(now - 4000));
    const id3 = await insertAuditRow(new Date(now - 3000));
    const id4 = await insertAuditRow(new Date(now - 2000));
    const id5 = await insertAuditRow(new Date(now - 1000));

    const pruned = await pruneQueueTimingAudit({ maxEntries: 2 });
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
  // Edge case: when the computed survivor set is empty
  // (Math.floor(maxEntries) === 0), the function falls into the
  // keepIds.length === 0 branch and deletes EVERY row in the table.
  await runInTxSandbox(async () => {
    await clearAuditTable();

    await insertAuditRow(new Date(Date.now() - 3000));
    await insertAuditRow(new Date(Date.now() - 2000));
    await insertAuditRow(new Date(Date.now() - 1000));

    // 0.5 passes the `> 0` outer guard but Math.floor(0.5) === 0, so the
    // SELECT … LIMIT 0 returns no survivor ids.
    const pruned = await pruneQueueTimingAudit({ maxEntries: 0.5 });
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
    await insertAuditRow(new Date(now - 30 * day));
    await insertAuditRow(new Date(now - 10 * day));
    const id2d = await insertAuditRow(new Date(now - 2 * day));
    const id1d = await insertAuditRow(new Date(now - 1 * day));

    // maxAgeDays=7 removes 30d + 10d (2). maxEntries=1 then keeps only
    // the freshest (1d), removing the 2d row (1 more).
    const pruned = await pruneQueueTimingAudit({ maxAgeDays: 7, maxEntries: 1 });
    assert(pruned === 3, `expected 3 rows pruned (2 by age + 1 by cap), got ${pruned}`);

    const survivors = await listAllIdsByRecency();
    assert(survivors.length === 1 && survivors[0] === id1d,
      `expected only the 1-day-old row to survive, got ${JSON.stringify(survivors)}`);
    assert(!survivors.includes(id2d), "2-day-old row should have been pruned by maxEntries");
  });
  console.log("  ✓ maxAgeDays and maxEntries combine correctly");
}

async function testSetQueueTimingsInvokesPrune(): Promise<void> {
  // Wraps the live storage method to record invocations, then runs
  // setQueueTimings inside the sandbox and asserts the call happened with
  // the configured retention bounds — and only after the audit row was
  // actually inserted.
  await runInTxSandbox(async () => {
    await clearAuditTable();
    invalidateQueueTimingsCache();
    // Seed a baseline so the first setQueueTimings call below has a
    // concrete "previous" snapshot to diff against.
    const baseline = { ...DEFAULT_QUEUE_TIMINGS };
    await storage.setSystemSetting(
      QUEUE_TIMING_SETTINGS_KEY,
      JSON.stringify(baseline),
      "system",
    );
    invalidateQueueTimingsCache();

    const pruneCalls: Array<{ maxEntries?: number; maxAgeDays?: number; auditCountAtCall: number }> = [];
    const originalPrune = storage.pruneQueueTimingAudit.bind(storage);
    (storage as any).pruneQueueTimingAudit = async (opts: { maxEntries?: number; maxAgeDays?: number }) => {
      const rows = await getDb().select({ id: queueTimingAudit.id }).from(queueTimingAudit);
      pruneCalls.push({ ...opts, auditCountAtCall: rows.length });
      return originalPrune(opts);
    };

    try {
      // Bump pollIntervalMs so the diff is non-empty. updatedBy=undefined
      // -> NULL changed_by (no users FK seed needed).
      await setQueueTimings({
        pollIntervalMs: baseline.pollIntervalMs + 1000,
      });
    } finally {
      (storage as any).pruneQueueTimingAudit = originalPrune;
    }

    assert(pruneCalls.length === 1,
      `expected prune to be called exactly once on a real change, got ${pruneCalls.length}`);
    const call = pruneCalls[0];
    assert(call.maxEntries === QUEUE_TIMING_AUDIT_RETENTION.maxEntries,
      `expected maxEntries=${QUEUE_TIMING_AUDIT_RETENTION.maxEntries}, got ${call.maxEntries}`);
    assert(call.maxAgeDays === QUEUE_TIMING_AUDIT_RETENTION.maxAgeDays,
      `expected maxAgeDays=${QUEUE_TIMING_AUDIT_RETENTION.maxAgeDays}, got ${call.maxAgeDays}`);
    // Critically: the audit insert must precede the prune so the row that
    // was just written is itself a candidate to be retained. If the audit
    // table was empty when prune ran, the ordering regressed.
    assert(call.auditCountAtCall >= 1,
      `expected audit row to exist before prune ran, table had ${call.auditCountAtCall} rows`);
  });
  console.log("  ✓ setQueueTimings calls prune once after recording the audit row");
}

async function testSetQueueTimingsSkipsPruneWhenUnchanged(): Promise<void> {
  // No-change path: prune must NOT run when the new values match the
  // current ones.
  await runInTxSandbox(async () => {
    await clearAuditTable();
    invalidateQueueTimingsCache();
    const baseline = { ...DEFAULT_QUEUE_TIMINGS };
    await storage.setSystemSetting(
      QUEUE_TIMING_SETTINGS_KEY,
      JSON.stringify(baseline),
      "system",
    );
    invalidateQueueTimingsCache();

    let pruneCallCount = 0;
    const originalPrune = storage.pruneQueueTimingAudit.bind(storage);
    (storage as any).pruneQueueTimingAudit = async (opts: { maxEntries?: number; maxAgeDays?: number }) => {
      pruneCallCount += 1;
      return originalPrune(opts);
    };

    try {
      // Exact same values — should not record an audit row and should not prune.
      await setQueueTimings(baseline);
    } finally {
      (storage as any).pruneQueueTimingAudit = originalPrune;
    }

    assert(pruneCallCount === 0,
      `expected prune to be skipped on a no-op change, got ${pruneCallCount} call(s)`);

    const auditRows = await getDb().select({ id: queueTimingAudit.id }).from(queueTimingAudit);
    assert(auditRows.length === 0,
      `expected no audit rows on a no-op change, got ${auditRows.length}`);
  });
  console.log("  ✓ setQueueTimings does not prune when nothing changed");
}

async function testRecordChangeRoundtrip(): Promise<void> {
  // Sanity check: recordQueueTimingChange persists what we asked for, and
  // pruneQueueTimingAudit({ maxEntries: 1 }) keeps that most-recent row
  // even in the presence of older noise.
  await runInTxSandbox(async () => {
    await clearAuditTable();
    await insertAuditRow(new Date(Date.now() - 60_000));
    const recent = await recordQueueTimingChange({
      changedBy: null,
      oldValues: { ...DEFAULT_QUEUE_TIMINGS },
      newValues: { ...DEFAULT_QUEUE_TIMINGS, pollIntervalMs: DEFAULT_QUEUE_TIMINGS.pollIntervalMs + 1000 },
    });
    const pruned = await pruneQueueTimingAudit({ maxEntries: 1 });
    assert(pruned === 1, `expected 1 row pruned, got ${pruned}`);
    const survivors = await listAllIdsByRecency();
    assert(survivors.length === 1 && survivors[0] === recent.id,
      `expected newest recorded row to survive, got ${JSON.stringify(survivors)}`);
  });
  console.log("  ✓ recordQueueTimingChange + prune({maxEntries:1}) keeps the newest row");
}

async function main(): Promise<void> {
  console.log("Queue-timing audit prune tests");
  await testMaxAgeDaysCutoff();
  await testMaxEntriesCap();
  await testEmptySurvivorsDeletesAll();
  await testMaxEntriesAndMaxAgeCombined();
  await testSetQueueTimingsInvokesPrune();
  await testSetQueueTimingsSkipsPruneWhenUnchanged();
  await testRecordChangeRoundtrip();
  console.log("All queue-timing audit prune tests passed.");
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
