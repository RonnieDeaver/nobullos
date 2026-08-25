/* test-registration
{
  "name": "Audit retention pruneOldAuditRows (Task #670)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for `pruneOldAuditRows` (server/services/auditRetention.ts).
 *
 * The daily scheduled prune trims three audit tables by age:
 *   - admin_setting_audit
 *   - stale_lease_threshold_audit
 *   - queue_timing_audit
 *
 * This test seeds each table with a mix of backdated and fresh rows,
 * runs `pruneOldAuditRows(retentionDays)`, and asserts:
 *   1. Only rows whose `changed_at` is strictly older than the retention
 *      window are deleted.
 *   2. The per-table deleted counts returned by `pruneOldAuditRows` match
 *      the number of backdated rows we seeded.
 *   3. Fresh rows survive in every table.
 *
 * All work runs inside `runInTxSandbox` so nothing is left behind.
 */

import { sql } from "drizzle-orm";
import {
  adminSettingAudit,
  staleLeaseThresholdAudit,
  queueTimingAudit,
} from "@shared/schema";
import { getDb } from "../server/db";
import { runInTxSandbox } from "./db-sandbox";
import { pruneOldAuditRows } from "../server/services/auditRetention";
import {
  ensureAdminSettingAuditTable,
  ensureQueueTimingAuditTable,
} from "../server/storage/settingsStorage";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `arp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SETTING_KEY = `test_retention_${TAG}`;
const DAY_MS = 24 * 60 * 60 * 1000;

async function insertAdminRow(changedAt: Date): Promise<string> {
  const [row] = await getDb()
    .insert(adminSettingAudit)
    .values({
      settingKey: SETTING_KEY,
      scope: null,
      changedBy: null,
      oldValues: null,
      newValues: { ts: changedAt.toISOString() },
    })
    .returning({ id: adminSettingAudit.id });
  await getDb().execute(
    sql`UPDATE admin_setting_audit SET changed_at = ${changedAt} WHERE id = ${row.id}`,
  );
  return row.id;
}

async function insertStaleRow(changedAt: Date): Promise<string> {
  const [row] = await getDb()
    .insert(staleLeaseThresholdAudit)
    .values({
      changedBy: null,
      oldValues: null,
      newValues: {
        staleWarning: 1,
        staleCritical: 2,
        exhaustedWarning: 1,
        exhaustedCritical: 2,
        leaseCutoffMs: 60_000,
      },
    })
    .returning({ id: staleLeaseThresholdAudit.id });
  await getDb().execute(
    sql`UPDATE stale_lease_threshold_audit SET changed_at = ${changedAt} WHERE id = ${row.id}`,
  );
  return row.id;
}

async function insertQueueTimingRow(changedAt: Date): Promise<string> {
  const [row] = await getDb()
    .insert(queueTimingAudit)
    .values({
      changedBy: null,
      oldValues: null,
      newValues: { ts: changedAt.toISOString() },
    })
    .returning({ id: queueTimingAudit.id });
  await getDb().execute(
    sql`UPDATE queue_timing_audit SET changed_at = ${changedAt} WHERE id = ${row.id}`,
  );
  return row.id;
}

async function existsAdmin(id: string): Promise<boolean> {
  const r = await getDb().execute<{ id: string }>(
    sql`SELECT id FROM admin_setting_audit WHERE id = ${id}`,
  );
  return r.rows.length > 0;
}

async function existsStale(id: string): Promise<boolean> {
  const r = await getDb().execute<{ id: string }>(
    sql`SELECT id FROM stale_lease_threshold_audit WHERE id = ${id}`,
  );
  return r.rows.length > 0;
}

async function existsQueueTiming(id: string): Promise<boolean> {
  const r = await getDb().execute<{ id: string }>(
    sql`SELECT id FROM queue_timing_audit WHERE id = ${id}`,
  );
  return r.rows.length > 0;
}

async function testPruneOldRowsDeletesOnlyAged(): Promise<void> {
  await ensureAdminSettingAuditTable();
  await ensureQueueTimingAuditTable();

  await runInTxSandbox(async () => {
    const now = Date.now();
    const RETENTION_DAYS = 7;

    // Clear any pre-existing rows in the sandbox so the deleted counts
    // returned by the prune are exactly what THIS test seeded.
    await getDb().execute(sql`DELETE FROM admin_setting_audit`);
    await getDb().execute(sql`DELETE FROM stale_lease_threshold_audit`);
    await getDb().execute(sql`DELETE FROM queue_timing_audit`);

    // Seed backdated rows (must be deleted) and fresh rows (must survive)
    // in each of the three tables. Mix the counts so a regression where
    // one table is wired to another's count would still fail.
    const adminOldIds = [
      await insertAdminRow(new Date(now - 30 * DAY_MS)),
      await insertAdminRow(new Date(now - 10 * DAY_MS)),
      await insertAdminRow(new Date(now - 8 * DAY_MS)),
    ];
    const adminFreshIds = [
      await insertAdminRow(new Date(now - 1 * DAY_MS)),
      await insertAdminRow(new Date(now - 2 * DAY_MS)),
    ];

    const staleOldIds = [
      await insertStaleRow(new Date(now - 30 * DAY_MS)),
      await insertStaleRow(new Date(now - 10 * DAY_MS)),
    ];
    const staleFreshIds = [
      await insertStaleRow(new Date(now - 1 * DAY_MS)),
    ];

    const queueOldIds = [
      await insertQueueTimingRow(new Date(now - 30 * DAY_MS)),
      await insertQueueTimingRow(new Date(now - 14 * DAY_MS)),
      await insertQueueTimingRow(new Date(now - 9 * DAY_MS)),
      await insertQueueTimingRow(new Date(now - 8 * DAY_MS)),
    ];
    const queueFreshIds = [
      await insertQueueTimingRow(new Date(now - 1 * DAY_MS)),
      await insertQueueTimingRow(new Date(now - 6 * DAY_MS)),
    ];

    const result = await pruneOldAuditRows(RETENTION_DAYS);

    assert(
      result.retentionDays === RETENTION_DAYS,
      `expected retentionDays=${RETENTION_DAYS}, got ${result.retentionDays}`,
    );
    assert(
      result.adminSettingAuditDeleted === adminOldIds.length,
      `admin_setting_audit: expected ${adminOldIds.length} deleted, got ${result.adminSettingAuditDeleted}`,
    );
    assert(
      result.staleLeaseThresholdAuditDeleted === staleOldIds.length,
      `stale_lease_threshold_audit: expected ${staleOldIds.length} deleted, got ${result.staleLeaseThresholdAuditDeleted}`,
    );
    assert(
      result.queueTimingAuditDeleted === queueOldIds.length,
      `queue_timing_audit: expected ${queueOldIds.length} deleted, got ${result.queueTimingAuditDeleted}`,
    );

    for (const id of adminOldIds) {
      assert(!(await existsAdmin(id)), `admin row ${id} should have been pruned`);
    }
    for (const id of adminFreshIds) {
      assert(await existsAdmin(id), `fresh admin row ${id} should have survived`);
    }
    for (const id of staleOldIds) {
      assert(!(await existsStale(id)), `stale row ${id} should have been pruned`);
    }
    for (const id of staleFreshIds) {
      assert(await existsStale(id), `fresh stale row ${id} should have survived`);
    }
    for (const id of queueOldIds) {
      assert(!(await existsQueueTiming(id)), `queue_timing row ${id} should have been pruned`);
    }
    for (const id of queueFreshIds) {
      assert(await existsQueueTiming(id), `fresh queue_timing row ${id} should have survived`);
    }

    // Boundary: a row whose changed_at is exactly `retentionDays` old must
    // survive, locking in the strict `<` (older-than) cutoff so a regression
    // to `<=` would fail this test. We seed with pg `now() - interval` (not
    // a JS-computed Date) because within `runInTxSandbox`'s single
    // transaction pg `now()` is constant — so prune's `now() - 7 days`
    // compares equal to the row's `changed_at` and strict `<` returns 0.
    // A JS-computed timestamp would be slightly older than pg `now() - 7d`
    // by the time prune runs, causing a false-positive deletion.
    const adminBoundary = await insertAdminRow(new Date(now - RETENTION_DAYS * DAY_MS));
    const staleBoundary = await insertStaleRow(new Date(now - RETENTION_DAYS * DAY_MS));
    const queueBoundary = await insertQueueTimingRow(new Date(now - RETENTION_DAYS * DAY_MS));
    await getDb().execute(
      sql`UPDATE admin_setting_audit SET changed_at = now() - (${RETENTION_DAYS} || ' days')::interval WHERE id = ${adminBoundary}`,
    );
    await getDb().execute(
      sql`UPDATE stale_lease_threshold_audit SET changed_at = now() - (${RETENTION_DAYS} || ' days')::interval WHERE id = ${staleBoundary}`,
    );
    await getDb().execute(
      sql`UPDATE queue_timing_audit SET changed_at = now() - (${RETENTION_DAYS} || ' days')::interval WHERE id = ${queueBoundary}`,
    );

    const boundaryResult = await pruneOldAuditRows(RETENTION_DAYS);
    assert(
      boundaryResult.adminSettingAuditDeleted === 0 &&
        boundaryResult.staleLeaseThresholdAuditDeleted === 0 &&
        boundaryResult.queueTimingAuditDeleted === 0,
      `boundary prune should delete 0 rows from each table, got ${JSON.stringify(boundaryResult)}`,
    );
    assert(await existsAdmin(adminBoundary), "admin row at exactly the retention boundary should survive");
    assert(await existsStale(staleBoundary), "stale row at exactly the retention boundary should survive");
    assert(await existsQueueTiming(queueBoundary), "queue_timing row at exactly the retention boundary should survive");

    // A second prune at the same retention is a no-op for our seeded rows.
    const second = await pruneOldAuditRows(RETENTION_DAYS);
    assert(
      second.adminSettingAuditDeleted === 0 &&
        second.staleLeaseThresholdAuditDeleted === 0 &&
        second.queueTimingAuditDeleted === 0,
      `second prune should delete 0 rows from each table, got ${JSON.stringify(second)}`,
    );
  });
  console.log("  ✓ pruneOldAuditRows deletes only rows older than retention and reports accurate per-table counts");
}

async function main(): Promise<void> {
  console.log("Audit-retention pruneOldAuditRows tests");
  await testPruneOldRowsDeletesOnlyAged();
  console.log("All audit-retention prune tests passed.");
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
