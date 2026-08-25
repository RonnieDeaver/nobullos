/* test-registration
{
  "name": "Queue drain history paging (Task #997)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #997 regression test: action-filtered drain history must page
 * through the audit store and still return the most recent N matching
 * entries, even when non-matching events dominate the head of the
 * stream. Guards against the previous bug where a single over-fetch
 * (capped at the storage layer's 100-row clamp) silently dropped
 * matching rows older than the most recent 100 events.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  listQueueDrainHistory,
  QUEUE_DRAIN_HISTORY_MAX_LIMIT,
} from "../server/services/queueDrainControl";

const HISTORY_KEY = "queue_drain_action";
const MARKER = `t997_${process.pid}_${Date.now()}`;
const Q = `${MARKER}_q`;

async function cleanup(): Promise<void> {
  await db.execute(sql`
    DELETE FROM admin_setting_audit
    WHERE setting_key = ${HISTORY_KEY} AND scope = ${Q}
  `);
}

async function seed(action: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    // Match the shape that `coerceHistoryDetails` accepts so these rows
    // survive the post-filter and surface in `listQueueDrainHistory`.
    let newValues: Record<string, unknown>;
    if (action === "queue_paused" || action === "queue_resumed") {
      const before = action === "queue_resumed";
      newValues = {
        action,
        paused: { before, after: !before },
      };
    } else if (action === "queue_rate_limit_set") {
      newValues = {
        action,
        ratePerMinute: { before: null, after: 30 + i },
      };
    } else {
      newValues = { action, cancelled: i, limit: 100 };
    }
    await storage.recordAdminSettingChange({
      settingKey: HISTORY_KEY,
      scope: Q,
      changedBy: null,
      oldValues: null,
      newValues,
    });
  }
}

async function main() {
  await cleanup();
  try {
    // Seed older matching events first, then bury them under newer
    // non-matching events that exceed the storage layer's 100-row clamp.
    await seed("queue_paused", 3);
    await seed("queue_rate_limit_set", 120);

    // Without paging the old single-page over-fetch would return zero
    // queue_paused entries because all 100 newest rows are
    // queue_rate_limit_set events.
    const paused = await listQueueDrainHistory({
      queueName: Q,
      action: "queue_paused",
      limit: 10,
    });
    assert.equal(
      paused.length,
      3,
      `expected paging to surface all 3 buried 'queue_paused' entries, got ${paused.length}`,
    );
    for (const e of paused) {
      assert.equal(e.action, "queue_paused");
      assert.equal(e.queueName, Q);
    }

    // Unfiltered call should still respect the storage-layer cap.
    const unfiltered = await listQueueDrainHistory({
      queueName: Q,
      limit: QUEUE_DRAIN_HISTORY_MAX_LIMIT,
    });
    assert.equal(unfiltered.length, QUEUE_DRAIN_HISTORY_MAX_LIMIT);
    // Newest first.
    assert.equal(unfiltered[0].action, "queue_rate_limit_set");
  } finally {
    await cleanup();
  }
  console.log("[Task #997] queue drain history paging test passed");
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
