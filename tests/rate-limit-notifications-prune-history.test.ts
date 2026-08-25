/* test-registration
{
  "name": "Rate-limit notifications prune history (Task #1117)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for the notification-history cleanup audit log
 * added in Task #1117.
 *
 * `pruneOldRateLimitAlertNotifications(retentionDays, context)` writes
 * one row to `rate_limit_notification_prune_history` per run with the
 * provided `triggeredBy` / `actorId`, the retention used, the cutoff,
 * the number of rows deleted, and the wall-clock duration.
 *
 * Pinned behavior:
 *   1. Successful prune persists a `status = 'ok'` row before returning.
 *   2. The persisted row carries the caller-supplied context.
 *   3. `listRateLimitNotificationPruneHistory(limit)` returns rows in
 *      most-recent-first order.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { ensureRateLimitAlertNotificationsTable } from "../server/storage/rateLimitAlertNotificationsStorage";
import {
  ensureRateLimitNotificationPruneHistoryTable,
  listRateLimitNotificationPruneHistory,
} from "../server/storage/rateLimitNotificationPruneHistoryStorage";
import { pruneOldRateLimitAlertNotifications } from "../server/services/rateLimitNotificationRetention";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function clearHistory(): Promise<void> {
  await db.execute(sql`DELETE FROM rate_limit_notification_prune_history`);
}

async function main(): Promise<void> {
  await ensureRateLimitAlertNotificationsTable();
  await ensureRateLimitNotificationPruneHistoryTable();
  await clearHistory();

  try {
    const before = Date.now();
    const result = await pruneOldRateLimitAlertNotifications(7, {
      triggeredBy: "on_demand",
      actorId: "test-actor-1117",
    });
    const after = Date.now();

    assert(result.retentionDays === 7, `retentionDays should be 7, got ${result.retentionDays}`);
    assert(typeof result.durationMs === "number", "result should include durationMs");
    assert(result.durationMs >= 0, `durationMs should be >= 0, got ${result.durationMs}`);

    // (1) After the prune resolves, history must already contain the row.
    const rows = await listRateLimitNotificationPruneHistory(5);
    assert(rows.length >= 1, `expected >=1 history row, got ${rows.length}`);
    const top = rows[0];
    assert(top.status === "ok", `top row status should be 'ok', got ${top.status}`);
    assert(top.triggeredBy === "on_demand", `triggeredBy should be 'on_demand', got ${top.triggeredBy}`);
    assert(top.actorId === "test-actor-1117", `actorId should be 'test-actor-1117', got ${top.actorId}`);
    assert(top.retentionDays === 7, `retentionDays should be 7, got ${top.retentionDays}`);
    const ranAtMs = top.ranAt instanceof Date
      ? top.ranAt.getTime()
      : new Date(top.ranAt as unknown as string).getTime();
    assert(
      ranAtMs >= before - 1000 && ranAtMs <= after + 1000,
      `ranAt should be within run window, got ${new Date(ranAtMs).toISOString()}`,
    );

    // (2) Most-recent-first ordering: a second prune should land in front.
    await new Promise((r) => setTimeout(r, 10));
    await pruneOldRateLimitAlertNotifications(14, {
      triggeredBy: "scheduler",
      actorId: null,
    });
    const rows2 = await listRateLimitNotificationPruneHistory(5);
    assert(rows2.length >= 2, `expected >=2 history rows, got ${rows2.length}`);
    assert(rows2[0].triggeredBy === "scheduler",
      `most recent row should be scheduler, got ${rows2[0].triggeredBy}`);
    assert(rows2[0].retentionDays === 14, `most recent retentionDays should be 14, got ${rows2[0].retentionDays}`);

    console.log("rate-limit-notifications-prune-history: PASSED");
  } finally {
    await clearHistory().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("rate-limit-notifications-prune-history: FAILED", err);
  await clearHistory().catch(() => undefined);
  process.exitCode = 1;
});
