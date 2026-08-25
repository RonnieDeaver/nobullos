// @db-pool-intent: worker
/**
 * Task #2832 — one-time cleanup of the failed `retroactive_reprocess`
 * backlog left behind by the months the queue's handler was missing.
 *
 * Background: Task #2824 restored the `retroactive_reprocess` handler,
 * but production's `work_queue` accumulated ~112k rows in terminal
 * `failed` status with `error_message` = 'No handler registered for
 * queue "retroactive_reprocess"'. Dedupe excludes failed rows, so they
 * are inert — they never re-run, but they pollute queue metrics and
 * backlog dashboards, and they represent clients whose unmatched
 * communications were never re-evaluated after contact changes.
 *
 * This module holds the DB primitives for the
 * `prune_failed_retroactive_reprocess_backlog` CEO prod-action:
 *   1. `getAffectedActiveClientIds()` — distinct clientIds referenced by
 *      the failed no-handler rows that still resolve to a live
 *      (non-archived) client. Computed BEFORE any deletion.
 *   2. `enqueueReprocessForAffectedClients()` — one fresh
 *      `retroactive_reprocess` per affected client through the Task
 *      #1025 safe-enqueue path (per-client pending ceiling + the
 *      version-agnostic periodic dedupe key), so a client that already
 *      has a pending periodic row is NOT double-enqueued. Idempotent.
 *   3. `countFailedNoHandlerRows()` / `deleteFailedNoHandlerChunk()` —
 *      the background-drain count + chunked DELETE. Scoped strictly to
 *      `status='failed'` rows whose error_message carries the
 *      no-handler signature; failed rows with OTHER error reasons
 *      (stale_lease_exhaustion, startup_stale_recovery, …) keep their
 *      diagnostic value and are never touched, and pending/processing/
 *      completed/cancelled/dead_letter rows are never touched.
 *
 * Every query routes through `getDb()` so the isolated-schema test
 * harness can exercise the real code path without leaking into the
 * shared `public.work_queue`.
 */
import { sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import {
  RETROACTIVE_REPROCESS_QUEUE,
  enqueueRetroactiveReprocessSafe,
  periodicDedupeKey,
} from "./retroactiveReprocessControl";

/**
 * Signature of the outage-era failure. `registerHandler` was missing, so
 * every claimed job failed with exactly this prefix. LIKE-prefix match
 * (not equality) so a future suffix tweak in the dispatcher's message
 * doesn't strand rows.
 */
export const NO_HANDLER_ERROR_PREFIX = "No handler registered for queue";

export const FAILED_RETRO_CLEANUP_CHUNK = 5000;

function noHandlerPattern(): string {
  return `${NO_HANDLER_ERROR_PREFIX}%`;
}

export async function countFailedNoHandlerRows(): Promise<number> {
  const result = await withDbAttribution(
    "maintenance:prod-actions-prune-failed-retro-count",
    () =>
      getDb().execute(sql`
        SELECT COUNT(*)::int AS n
        FROM work_queue
        WHERE queue_name = ${RETROACTIVE_REPROCESS_QUEUE}
          AND status = 'failed'
          AND error_message LIKE ${noHandlerPattern()}
      `),
  );
  return Number((result.rows as any[])[0]?.n ?? 0);
}

/**
 * Distinct clientIds referenced by the failed no-handler rows that still
 * resolve to a live, non-archived client. Archived or deleted clients are
 * intentionally excluded — their failed rows are pruned but no fresh
 * re-evaluation is enqueued for them.
 */
export async function getAffectedActiveClientIds(): Promise<string[]> {
  const result = await withDbAttribution(
    "maintenance:prod-actions-prune-failed-retro-clients",
    () =>
      getDb().execute(sql`
        SELECT DISTINCT wq.payload->>'clientId' AS client_id
        FROM work_queue wq
        JOIN clients c ON c.id = wq.payload->>'clientId'
        WHERE wq.queue_name = ${RETROACTIVE_REPROCESS_QUEUE}
          AND wq.status = 'failed'
          AND wq.error_message LIKE ${noHandlerPattern()}
          AND COALESCE(c.is_archived, false) = false
        ORDER BY client_id ASC
      `),
  );
  return (result.rows as any[])
    .map((r) => String(r.client_id))
    .filter((id) => id.length > 0);
}

export interface EnqueueForAffectedResult {
  affectedClients: number;
  enqueued: number;
  skippedCeiling: number;
}

/**
 * Enqueue one fresh `retroactive_reprocess` per affected active client.
 * Idempotent: the version-agnostic `periodicDedupeKey` collapses onto any
 * pending periodic row for the same client, and the Task #1025 per-client
 * pending ceiling refuses to over-enqueue. A ceiling skip means the
 * client ALREADY has pending re-evaluation work queued, which satisfies
 * this action's goal, so it is counted separately but not an error.
 */
export async function enqueueReprocessForAffectedClients(
  clientIds: string[],
): Promise<EnqueueForAffectedResult> {
  let enqueued = 0;
  let skippedCeiling = 0;
  for (const clientId of clientIds) {
    const result = await enqueueRetroactiveReprocessSafe({
      clientId,
      source: "failed_backlog_cleanup",
      workloadClass: "repair",
      payload: { maxItems: 100, reason: "task_2832_failed_backlog_cleanup" },
      priority: 100,
      maxAttempts: 2,
      dedupeKey: periodicDedupeKey(clientId),
    });
    if (result.enqueued) enqueued++;
    else if (result.reason === "per_client_ceiling") skippedCeiling++;
  }
  return { affectedClients: clientIds.length, enqueued, skippedCeiling };
}

/**
 * Delete one chunk of failed no-handler rows. Returns the number of rows
 * deleted; 0 ends the background drain. Chunked so each DELETE stays well
 * under the 10s DB-hold cap.
 */
export async function deleteFailedNoHandlerChunk(
  limit: number = FAILED_RETRO_CLEANUP_CHUNK,
): Promise<number> {
  const result = await withDbAttribution(
    "maintenance:prod-actions-prune-failed-retro-delete",
    () =>
      getDb().execute(sql`
        DELETE FROM work_queue
        WHERE id IN (
          SELECT id
          FROM work_queue
          WHERE queue_name = ${RETROACTIVE_REPROCESS_QUEUE}
            AND status = 'failed'
            AND error_message LIKE ${noHandlerPattern()}
          ORDER BY id ASC
          LIMIT ${limit}
        )
        RETURNING id
      `),
  );
  return result.rowCount ?? (result.rows as any[]).length;
}
