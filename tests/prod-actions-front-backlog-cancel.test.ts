/* test-registration
{
  "name": "Prod-actions Front backlog cancel \u2014 pending untouched (Task #1787 Stage 2)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Regression guard for the Task #1787 Stage 2 constraint inside the
 * `cancel_stale_front_backlog` registry action:
 *
 *   pending and processing rows must NEVER be cancelled, no matter how
 *   old they are. Only `failed` and `dead_letter` rows in the three
 *   Front queues are eligible.
 *
 * This test seeds one row of every status/age combination, runs the
 * action's apply(), and asserts the after-state of each seeded row.
 *
 * Task #1929 — runs inside `runInIsolatedSchema` so `work_queue` rows
 * the test seeds live in a per-test schema that the live `Start
 * application` workers (default search_path = public) cannot see,
 * claim, or race-write. That replaces the previous queue-pause
 * scaffolding (Task #1833).
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import { runInIsolatedSchema } from "./db-sandbox";

const TAG_USER = "test-prod-actions-front-backlog";
const SEED_TAG = "task-1808-front-backlog-test";

interface Seed {
  id: string;
  queue: "front_webhook_apply" | "front_webhook_normalize" | "front_sync_reprocess";
  status: "pending" | "processing" | "failed" | "dead_letter";
  ageHours: number;
  /** true → action should cancel this row, false → action must leave it alone */
  expectCancelled: boolean;
}

const SEEDS: Seed[] = [
  // Pending rows — must NEVER be cancelled (even 48h old).
  { id: `${SEED_TAG}-apply-pending-48h`,     queue: "front_webhook_apply",     status: "pending",     ageHours: 48, expectCancelled: false },
  { id: `${SEED_TAG}-apply-pending-1h`,      queue: "front_webhook_apply",     status: "pending",     ageHours: 1,  expectCancelled: false },
  { id: `${SEED_TAG}-norm-pending-48h`,      queue: "front_webhook_normalize", status: "pending",     ageHours: 48, expectCancelled: false },
  { id: `${SEED_TAG}-repro-pending-48h`,     queue: "front_sync_reprocess",    status: "pending",     ageHours: 48, expectCancelled: false },
  // Processing rows — must NEVER be cancelled.
  { id: `${SEED_TAG}-apply-processing-48h`,  queue: "front_webhook_apply",     status: "processing",  ageHours: 48, expectCancelled: false },
  // Failed + dead_letter rows — SHOULD be cancelled.
  { id: `${SEED_TAG}-apply-failed`,          queue: "front_webhook_apply",     status: "failed",      ageHours: 2,  expectCancelled: true },
  { id: `${SEED_TAG}-apply-dead`,            queue: "front_webhook_apply",     status: "dead_letter", ageHours: 2,  expectCancelled: true },
  { id: `${SEED_TAG}-norm-failed`,           queue: "front_webhook_normalize", status: "failed",      ageHours: 2,  expectCancelled: true },
  { id: `${SEED_TAG}-repro-dead`,            queue: "front_sync_reprocess",    status: "dead_letter", ageHours: 2,  expectCancelled: true },
];

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      // Seed every status/age combination into the isolated work_queue.
      for (const s of SEEDS) {
        await isoDb.execute(sql`
          INSERT INTO work_queue (id, queue_name, job_type, workload_class, status, payload, created_at, updated_at)
          VALUES (
            ${s.id},
            ${s.queue},
            ${s.queue},
            'maintenance',
            ${s.status},
            ${JSON.stringify({ seedTag: SEED_TAG })}::jsonb,
            NOW() - (${s.ageHours} || ' hours')::interval,
            NOW() - (${s.ageHours} || ' hours')::interval
          )
        `);
      }

      const action = PROD_ACTIONS.find((a) => a.id === "cancel_stale_front_backlog");
      if (!action) throw new Error("cancel_stale_front_backlog action missing from registry");

      const expectedCancellable = SEEDS.filter((s) => s.expectCancelled).length;
      const s = await action.status(TAG_USER);
      assert(
        s.state === "pending" || s.state === "not-needed",
        `unexpected status state: ${JSON.stringify(s)}`,
      );

      const outcome = await action.apply(TAG_USER);
      assert(
        outcome.state === "applied" || outcome.state === "not-needed",
        `unexpected outcome: ${JSON.stringify(outcome)}`,
      );

      const loadStatuses = async (): Promise<Map<string, string>> => {
        const res: any = await isoDb.execute(sql`
          SELECT id, status FROM work_queue WHERE id LIKE ${`${SEED_TAG}-%`}
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        const m = new Map<string, string>();
        for (const r of rows) m.set(String(r.id), String(r.status));
        return m;
      };

      const after = await loadStatuses();
      let cancelledOfOurs = 0;
      for (const seedRow of SEEDS) {
        const finalStatus = after.get(seedRow.id);
        assert(finalStatus, `seed row ${seedRow.id} disappeared`);
        if (seedRow.expectCancelled) {
          assert.equal(
            finalStatus,
            "cancelled",
            `expected ${seedRow.id} (${seedRow.queue}/${seedRow.status}) to be cancelled, got ${finalStatus}`,
          );
          cancelledOfOurs++;
        } else {
          assert.notEqual(
            finalStatus,
            "cancelled",
            `REGRESSION: ${seedRow.id} (${seedRow.queue}/${seedRow.status}) was cancelled — pending/processing rows must NEVER be cancelled by this action`,
          );
          assert.equal(
            finalStatus,
            seedRow.status,
            `${seedRow.id}: expected status to stay ${seedRow.status}, got ${finalStatus}`,
          );
        }
      }
      assert.equal(
        cancelledOfOurs,
        expectedCancellable,
        `expected to cancel ${expectedCancellable} of our seed rows, cancelled ${cancelledOfOurs}`,
      );

      // Idempotency: second press must not flip any of our pending/processing rows.
      await action.apply(TAG_USER);
      const after2 = await loadStatuses();
      for (const seedRow of SEEDS.filter((s) => !s.expectCancelled)) {
        assert.equal(
          after2.get(seedRow.id),
          seedRow.status,
          `REGRESSION on second press: ${seedRow.id} was cancelled`,
        );
      }

      console.log(`  ok  pending/processing Front rows untouched; ${cancelledOfOurs} failed/dead_letter rows cancelled`);
    },
    { tables: ["work_queue", "system_settings", "admin_setting_audit"] },
  );
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {
    console.log("prod-actions-front-backlog-cancel: regression guard passed");
  },
  (err) => {
    console.error("prod-actions-front-backlog-cancel: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
