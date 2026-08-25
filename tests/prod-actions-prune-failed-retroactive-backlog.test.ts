/* test-registration
{
  "name": "Prod-actions prune failed no-handler retroactive_reprocess backlog — scoped delete + per-client re-enqueue (Task #2832)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2832: the prune of the ~112k failed no-handler retroactive_reprocess rows (left behind while the #2637 removal had deleted the handler, restored by #2824) plus the one-per-affected-client re-enqueue. The DELETE scope (failed + no-handler error only) and the dedupe/ceiling idempotency are the safety contract — a regression could silently delete diagnostic failed rows or double-enqueue every client. Isolated-schema DB test; drain is chunked and converges in-process.",
  "timeoutMs": 180000,
  "tier": "small"
}
test-registration */
/**
 * Task #2832 — regression guard for the
 * `prune_failed_retroactive_reprocess_backlog` registry action.
 *
 * The action cleans up the terminal `failed` work_queue rows the
 * `retroactive_reprocess` queue accumulated while its handler was missing
 * (restored by Task #2824): it enqueues ONE fresh reprocess per affected
 * still-active client (through the Task #1025 safe-enqueue path with the
 * version-agnostic periodic dedupe key), then background-drains a DELETE
 * of the failed rows whose error_message carries the no-handler signature.
 *
 * Constraints this test locks in:
 *   1. Only `status='failed'` rows with the no-handler error_message are
 *      deleted. Failed rows with OTHER error reasons, pending rows, and
 *      completed rows survive untouched.
 *   2. Each affected ACTIVE client gets exactly one fresh pending
 *      `retroactive_reprocess` row; a client that already has a pending
 *      periodic row is deduped (still exactly one pending row).
 *   3. Archived clients and clientIds with no clients row get NO fresh
 *      enqueue (their failed rows are still pruned).
 *   4. Second press after the drain converges is not-needed and does not
 *      duplicate any pending row.
 *
 * Runs inside `runInIsolatedSchema` so seeded work_queue rows live in a
 * per-test schema that the live `Start application` workers cannot see,
 * claim, or race-write. `LIKE public.work_queue INCLUDING ALL` clones the
 * partial unique index `wq_dedupe_key_idx`, so the real dedupe path
 * (onConflictDoNothing) is exercised, not simulated.
 *
 * NOTE: the Task #1025 per-client pending ceiling pre-check reads
 * `public.work_queue` through the raw worker pool (not getDb()), so it
 * sees 0 pending rows for these synthetic clientIds — the ceiling never
 * fires here, which is exactly the pass-through this test wants.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  getDrainState,
  __resetDrainsForTest,
} from "../server/services/prodActionBackgroundDrain";
import { periodicDedupeKey } from "../server/services/retroactiveReprocessControl";
import { runInIsolatedSchema } from "./db-sandbox";

const ACTION_ID = "prune_failed_retroactive_reprocess_backlog";
const SEED_TAG = "task-2832-prune-test";
const NO_HANDLER_MSG = 'No handler registered for queue "retroactive_reprocess"';

const CLIENT_A = `${SEED_TAG}-client-active`;
const CLIENT_D = `${SEED_TAG}-client-active-with-pending`;
const CLIENT_B = `${SEED_TAG}-client-archived`;
const CLIENT_C = `${SEED_TAG}-client-vanished`;

async function waitForDrainFinish(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = getDrainState(ACTION_ID);
    if (s && s.finishedAt !== null) {
      if (s.error) {
        throw new Error(`drain finished with error: ${s.error}`);
      }
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `drain did not finish within ${timeoutMs}ms — state: ${JSON.stringify(s)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      // --- Seed clients: two active, one archived; CLIENT_C gets no row. ---
      for (const [id, archived] of [
        [CLIENT_A, false],
        [CLIENT_D, false],
        [CLIENT_B, true],
      ] as const) {
        await isoDb.execute(sql`
          INSERT INTO clients (id, firm_name, is_archived)
          VALUES (${id}, ${`Firm ${id}`}, ${archived})
        `);
      }

      const seedRow = async (opts: {
        id: string;
        clientId: string;
        status: string;
        errorMessage?: string | null;
        dedupeKey?: string | null;
      }) => {
        await isoDb.execute(sql`
          INSERT INTO work_queue (id, queue_name, job_type, workload_class, status, payload, error_message, dedupe_key, created_at, updated_at)
          VALUES (
            ${opts.id},
            'retroactive_reprocess',
            'retroactive_reprocess',
            'repair',
            ${opts.status},
            ${JSON.stringify({ clientId: opts.clientId, seedTag: SEED_TAG })}::jsonb,
            ${opts.errorMessage ?? null},
            ${opts.dedupeKey ?? null},
            NOW() - interval '30 days',
            NOW() - interval '30 days'
          )
        `);
      };

      // Failed no-handler rows: A x3, D x2, B (archived) x2, C (vanished) x1 = 8.
      let seq = 0;
      for (const [clientId, count] of [
        [CLIENT_A, 3],
        [CLIENT_D, 2],
        [CLIENT_B, 2],
        [CLIENT_C, 1],
      ] as const) {
        for (let i = 0; i < count; i++) {
          await seedRow({
            id: `${SEED_TAG}-nohandler-${seq++}`,
            clientId,
            status: "failed",
            errorMessage: NO_HANDLER_MSG,
          });
        }
      }
      // Failed row with a DIFFERENT error reason — must survive.
      await seedRow({
        id: `${SEED_TAG}-other-failed`,
        clientId: CLIENT_A,
        status: "failed",
        errorMessage: "stale_lease_exhaustion: lease expired 3 times",
      });
      // Completed row — must survive.
      await seedRow({
        id: `${SEED_TAG}-completed`,
        clientId: CLIENT_A,
        status: "completed",
      });
      // CLIENT_D already has a pending periodic row — enqueue must dedupe
      // onto it (still exactly one pending row after apply).
      await seedRow({
        id: `${SEED_TAG}-d-pending`,
        clientId: CLIENT_D,
        status: "pending",
        dedupeKey: periodicDedupeKey(CLIENT_D),
      });

      const action = PROD_ACTIONS.find((a) => a.id === ACTION_ID);
      if (!action) throw new Error(`${ACTION_ID} action missing from registry`);

      // --- status() before: pending, sees 8 rows / 2 affected active clients. ---
      const before = await action.status(null);
      assert.equal(before.state, "pending", `expected pending, got ${JSON.stringify(before)}`);
      assert(
        before.detail?.includes("8 failed no-handler"),
        `status detail should count 8 rows: ${before.detail}`,
      );
      assert(
        before.detail?.includes("2 affected active client(s)"),
        `status detail should count 2 affected active clients: ${before.detail}`,
      );

      // --- apply() → enqueues + starts the delete drain. ---
      const outcome = await action.apply(null);
      assert.equal(outcome.state, "applied", `expected applied, got ${JSON.stringify(outcome)}`);
      await waitForDrainFinish();

      const countRows = async (where: ReturnType<typeof sql>): Promise<number> => {
        const res: any = await isoDb.execute(sql`
          SELECT COUNT(*)::int AS n FROM work_queue WHERE ${where}
        `);
        const rows = Array.isArray(res) ? res : res?.rows ?? [];
        return Number(rows[0]?.n ?? 0);
      };

      // 1. All no-handler failed rows deleted.
      const remainingNoHandler = await countRows(
        sql`status = 'failed' AND error_message LIKE 'No handler registered for queue%'`,
      );
      assert.equal(remainingNoHandler, 0, "no-handler failed rows must all be deleted");

      // 2. Other-reason failed + completed rows survive.
      assert.equal(
        await countRows(sql`id = ${`${SEED_TAG}-other-failed`}`),
        1,
        "failed row with a different error reason must survive",
      );
      assert.equal(
        await countRows(sql`id = ${`${SEED_TAG}-completed`}`),
        1,
        "completed row must survive",
      );

      // 3. CLIENT_A got exactly one fresh pending reprocess with the
      //    periodic dedupe key.
      assert.equal(
        await countRows(
          sql`status = 'pending' AND dedupe_key = ${periodicDedupeKey(CLIENT_A)}`,
        ),
        1,
        "active client without a pending row must get exactly one fresh enqueue",
      );

      // 4. CLIENT_D still has exactly ONE pending row (dedupe collapsed onto
      //    the seeded periodic row).
      assert.equal(
        await countRows(
          sql`status = 'pending' AND payload->>'clientId' = ${CLIENT_D}`,
        ),
        1,
        "client with an existing pending periodic row must NOT get a duplicate",
      );

      // 5. Archived + vanished clients get NO fresh enqueue.
      for (const ghost of [CLIENT_B, CLIENT_C]) {
        assert.equal(
          await countRows(sql`status = 'pending' AND payload->>'clientId' = ${ghost}`),
          0,
          `no fresh enqueue expected for ${ghost}`,
        );
      }

      // --- Second press: converged → not-needed, no duplicate enqueues. ---
      __resetDrainsForTest();
      const second = await action.apply(null);
      assert.equal(
        second.state,
        "not-needed",
        `second press must be not-needed, got ${JSON.stringify(second)}`,
      );
      assert.equal(
        await countRows(sql`status = 'pending' AND payload->>'clientId' = ${CLIENT_A}`),
        1,
        "second press must not duplicate CLIENT_A's pending row",
      );

      const after = await action.status(null);
      assert.equal(after.state, "not-needed", `status after drain: ${JSON.stringify(after)}`);

      console.log(
        "  ok  8 no-handler rows pruned; other failed/completed survived; 1 fresh + 1 deduped enqueue; archived/vanished skipped; second press not-needed",
      );
    },
    { tables: ["work_queue", "clients", "prod_action_runs"] },
  );
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles.
main().then(
  () => {
    console.log("prod-actions-prune-failed-retroactive-backlog: passed");
  },
  (err) => {
    console.error(
      "prod-actions-prune-failed-retroactive-backlog: FAILED —",
      err?.stack ?? err,
    );
    process.exitCode = 1;
  },
);
