/* test-registration
{
  "name": "Call-archive health trend (Task #1094)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1094 regression test for the call-archive backlog trend
 * sparkline pipeline.
 *
 * Verifies:
 *   1. `recordCallArchiveHealthSnapshot` writes a row that mirrors
 *      the watcher's current pending/failed counts and returns the
 *      same numbers it inserted.
 *   2. `getCallArchiveHealthTrend` returns those snapshots ordered
 *      oldest → newest and respects the `hours` window.
 *   3. The 24h sparkline data set is what the admin UI consumes
 *      (sampledAt as ISO string, numeric counters) so a contract
 *      change in the helper trips this test.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import {
  recordCallArchiveHealthSnapshot,
  getCallArchiveHealthTrend,
} from "../server/services/callArchiveBacklogAlerts";

async function clearSnapshotTable(): Promise<void> {
  await workerDb.execute(sql`TRUNCATE TABLE call_archive_health_snapshots`);
}

async function run(): Promise<void> {
  await clearSnapshotTable();

  // (1) write three snapshots back-to-back; each should land in the
  // table with current-time `sampled_at` and the same counts the
  // watcher would have computed.
  const s1 = await recordCallArchiveHealthSnapshot();
  const s2 = await recordCallArchiveHealthSnapshot();
  const s3 = await recordCallArchiveHealthSnapshot();

  for (const s of [s1, s2, s3]) {
    assert.equal(typeof s.pendingStuckCount, "number");
    assert.equal(typeof s.recentFailedCount, "number");
    assert.ok(s.pendingHours > 0, "pendingHours should be a positive int");
    assert.ok(s.failedLookbackHours > 0, "failedLookbackHours should be a positive int");
  }

  const countResult = await workerDb.execute(
    sql`SELECT COUNT(*)::int AS n FROM call_archive_health_snapshots`,
  );
  const countRows = (countResult.rows ?? []) as Array<{ n: number | string }>;
  const insertedRows = Number(countRows[0]?.n ?? 0);
  assert.equal(insertedRows, 3, "expected 3 rows in call_archive_health_snapshots");

  // (2) the trend helper should return all three points (24h window
  // by default), ordered oldest → newest.
  const trend = await getCallArchiveHealthTrend(24);
  assert.equal(trend.length, 3, "trend should expose all three samples");
  for (let i = 1; i < trend.length; i++) {
    const prev = new Date(trend[i - 1].sampledAt).getTime();
    const cur = new Date(trend[i].sampledAt).getTime();
    assert.ok(prev <= cur, "trend points must be ordered ascending by sampledAt");
  }
  for (const p of trend) {
    assert.equal(typeof p.sampledAt, "string");
    assert.ok(!Number.isNaN(new Date(p.sampledAt).getTime()), "sampledAt must parse");
    assert.equal(typeof p.pendingStuckCount, "number");
    assert.equal(typeof p.recentFailedCount, "number");
    // oldestPendingAgeSeconds may legitimately be null when the
    // pending bucket is empty.
    assert.ok(
      p.oldestPendingAgeSeconds === null || typeof p.oldestPendingAgeSeconds === "number",
      "oldestPendingAgeSeconds is number | null",
    );
  }

  // (3) push one snapshot back in time and confirm the hours window
  // excludes it. We update the row's `sampled_at` directly because
  // the helper uses `now()` server-side; this is the cheapest way
  // to assert the WHERE clause.
  await workerDb.execute(sql`
    UPDATE call_archive_health_snapshots
    SET sampled_at = NOW() - INTERVAL '48 hours'
    WHERE id = (SELECT id FROM call_archive_health_snapshots ORDER BY sampled_at ASC LIMIT 1)
  `);
  const trend24h = await getCallArchiveHealthTrend(24);
  assert.equal(
    trend24h.length,
    2,
    "the 48h-old snapshot must be excluded from the 24h window",
  );
  const trend72h = await getCallArchiveHealthTrend(72);
  assert.equal(
    trend72h.length,
    3,
    "widening the window to 72h must include the back-dated snapshot",
  );

  await clearSnapshotTable();
  console.log("call-archive-health-trend.test.ts OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
