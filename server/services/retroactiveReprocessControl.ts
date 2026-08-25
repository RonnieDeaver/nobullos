/**
 * Task #1025: centralized backpressure for `retroactive_reprocess`
 * enqueues.
 *
 * Background: the periodic client-matching sweep
 * (`startPeriodicClientMatching`) historically used a version-stamped
 * dedupe key (`periodic:retroactive_reprocess:v${version}:${clientId}`).
 * Each new sweep advanced `producerVersion`, so the dedupe key never
 * collided with the previous sweep's pending row. When the consumer ran
 * slower than the sweep (the common case under DB pressure), every
 * sweep added one fresh row per active client and the queue grew
 * unboundedly — the bug that produced ~91k pending rows across 57
 * clients in production.
 *
 * Fix surface:
 *   1. `periodicDedupeKey(clientId)` — version-agnostic key. As long
 *      as a periodic row for the client is still pending the next
 *      sweep dedupes against it instead of inserting a duplicate.
 *   2. `enqueueRetroactiveReprocessSafe(...)` — used by every
 *      producer (periodic sweep, manual retroactive route, contact
 *      add/update auto-rematch, and the env-gated boot memory-reset
 *      remediation — the release-and-rematch route was removed in
 *      Task #4087). Counts pending rows for the target client and
 *      refuses to enqueue past `RETROACTIVE_REPROCESS_PENDING_PER_CLIENT_MAX`.
 *      The producer still gets a clear `{ enqueued: false, reason }`
 *      result so it can log/observe without raising.
 *   3. `getPendingCountForClient` / `getPendingCountsByClient` —
 *      observability primitives the admin queue-control endpoint
 *      surfaces so operators can see which clients are at the ceiling.
 *
 * This module is purely the deterministic enqueue/backpressure control
 * for the `retroactive_reprocess` queue. The pre-enqueue ceiling means
 * the *queue* won't bloat regardless of how fast the consumer drains.
 */
import { sql } from "drizzle-orm";
import { workerDb } from "../db";
import { PERF } from "../perfConfig";
import { workerLog } from "./workerLogger";
import { enqueueRepairJob } from "./repairDispatcher";

export const RETROACTIVE_REPROCESS_QUEUE = "retroactive_reprocess";

export function periodicDedupeKey(clientId: string): string {
  return `periodic:retroactive_reprocess:${clientId}`;
}

export async function getPendingCountForClient(clientId: string): Promise<number> {
  const rows = await workerDb.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM work_queue
    WHERE queue_name = ${RETROACTIVE_REPROCESS_QUEUE}
      AND status = 'pending'
      AND payload->>'clientId' = ${clientId}
  `);
  const list = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
  return Number(list[0]?.count ?? 0);
}

export interface PerClientPendingRow {
  clientId: string;
  pendingCount: number;
  oldestCreatedAt: string | null;
}

export async function getPendingCountsByClient(): Promise<PerClientPendingRow[]> {
  const rows = await workerDb.execute(sql`
    SELECT
      payload->>'clientId' AS client_id,
      COUNT(*)::int AS count,
      MIN(created_at) AS oldest_created_at
    FROM work_queue
    WHERE queue_name = ${RETROACTIVE_REPROCESS_QUEUE}
      AND status = 'pending'
      AND payload ? 'clientId'
    GROUP BY payload->>'clientId'
    ORDER BY count DESC, client_id ASC
  `);
  const list = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
  return list.map((r: any) => ({
    clientId: String(r.client_id),
    pendingCount: Number(r.count ?? 0),
    oldestCreatedAt: r.oldest_created_at
      ? (r.oldest_created_at instanceof Date
          ? r.oldest_created_at.toISOString()
          : new Date(r.oldest_created_at).toISOString())
      : null,
  }));
}

// Throttled per-client warn so a saturated producer (periodic sweep on
// a slow consumer) doesn't flood logs. One log per client per minute is
// enough to surface the problem; the per-client pending count is also
// visible from the admin queue-control endpoint at any time.
const lastSkipLogAt = new Map<string, number>();
const SKIP_LOG_COOLDOWN_MS = 60_000;

function logCeilingSkip(
  clientId: string,
  source: string,
  pendingCount: number,
  ceiling: number,
): void {
  const key = `${source}:${clientId}`;
  const now = Date.now();
  const last = lastSkipLogAt.get(key) ?? 0;
  if (now - last < SKIP_LOG_COOLDOWN_MS) return;
  lastSkipLogAt.set(key, now);
  workerLog({
    worker: RETROACTIVE_REPROCESS_QUEUE,
    event: "retroactive_reprocess_ceiling_skip",
    workloadClass: "repair",
    clientId,
    source,
    pendingCount,
    ceiling,
  });
}

export type RetroactiveReprocessEnqueueSource =
  | "periodic_sweep"
  | "manual_route"
  | "contact_add"
  | "contact_update"
  | "release_and_rematch"
  | "memory_reset_remediation"
  // Task #2832 — one-time prune of the failed no-handler backlog
  // re-enqueues one fresh job per affected client.
  | "failed_backlog_cleanup"
  // Task #4762 — trusted-domain changes drain their own backlog: adding or
  // editing a client's emailDomains (route edit / client create) or applying
  // the domain seed plan auto-enqueues the scoped deterministic re-match for
  // that client instead of waiting for an operator to press the backlog
  // action (the 6h self-heal enrollment of the full re-match is the backstop).
  | "client_domain_edit"
  | "client_domain_seed";

export interface SafeEnqueueOpts {
  clientId: string;
  source: RetroactiveReprocessEnqueueSource;
  workloadClass?: "interactive_repair" | "repair" | "maintenance";
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  dedupeKey?: string;
}

export interface SafeEnqueueResult {
  enqueued: boolean;
  jobId?: string;
  reason?: "per_client_ceiling";
  pendingCount: number;
  ceiling: number;
}

export async function enqueueRetroactiveReprocessSafe(
  opts: SafeEnqueueOpts,
): Promise<SafeEnqueueResult> {
  const ceiling = PERF.RETROACTIVE_REPROCESS_PENDING_PER_CLIENT_MAX;
  const pendingCount = await getPendingCountForClient(opts.clientId);
  if (pendingCount >= ceiling) {
    logCeilingSkip(opts.clientId, opts.source, pendingCount, ceiling);
    return { enqueued: false, reason: "per_client_ceiling", pendingCount, ceiling };
  }

  const payload = { clientId: opts.clientId, ...(opts.payload ?? {}) };
  const jobId = await enqueueRepairJob({
    queueName: RETROACTIVE_REPROCESS_QUEUE,
    workloadClass: opts.workloadClass ?? "interactive_repair",
    payload,
    priority: opts.priority,
    maxAttempts: opts.maxAttempts,
    dedupeKey: opts.dedupeKey,
  });
  return { enqueued: true, jobId, pendingCount, ceiling };
}
