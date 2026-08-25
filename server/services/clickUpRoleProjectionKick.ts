/**
 * Task #5156 — ClickUp role projection post-commit kick (dependency-light).
 *
 * Mirrors the pattern from ghlOutboundKick.ts: holds ONLY the enqueue/kick
 * helpers so that assignment transaction producers can fire a post-commit kick
 * without importing the full projection handler.
 *
 * Contract:
 *   - `kickClickUpRoleProjectionSafe()` NEVER throws. It is only a post-commit
 *     accelerator: each new/superseded command already has an immediate wake
 *     inserted in the same transaction as the command.
 *   - The producer drain enqueue is idempotent via a FIXED dedupeKey
 *     (`clickup_role_projection:drain`) so a burst of producers coalesces into
 *     one immediate drain.
 *   - Durable command wakes (crash-safe delivery driver): initial staging
 *     inserts an immediate wake, and retryable/ambiguous finalization inserts a
 *     delayed wake at `next_attempt_at`, always in the SAME short DB transaction
 *     as the command state change (`enqueueProjectionWakeInTx`). Boot catch-up
 *     is defense in depth, not the normal delivery mechanism.
 */
// @db-pool-intent: ambient

import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { workQueue } from "@shared/schema";
import type * as schema from "@shared/schema";

/**
 * The drizzle transaction handle type produced by `getDb().transaction(...)`
 * with the full app schema. Typed here (not `any`) so the atomic-wake insert is
 * checked against the real work_queue columns, while keeping this module free of
 * a runtime dependency on the worker's getDb.
 */
export type ProjectionTx = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export const CLICKUP_ROLE_PROJECTION_QUEUE = "clickup_role_projection";

const DRAIN_DEDUPE_KEY = "clickup_role_projection:drain";

export interface ProjectionWakeIdentity {
  commandId: string;
  revision: string;
  attemptCount: number;
}

/**
 * One live wake per exact command revision/attempt. A time-bucket key is unsafe:
 * an earlier wake in the bucket can run before a later command is due, then
 * suppress the later wake and strand that command. This key only coalesces a
 * replay of the same finalize CAS.
 */
export function projectionWakeDedupeKey(identity: ProjectionWakeIdentity): string {
  return [
    "clickup_role_projection:wake",
    identity.commandId,
    identity.revision,
    identity.attemptCount,
  ].join(":");
}

export interface EnqueueProjectionJobOptions {
  /** Override the fixed drain dedupe key (used for durable continuations). */
  dedupeKey?: string;
  /** Delay the job until this time (durable retry wake). Omit for immediate. */
  retryAt?: Date;
}

type EnqueueOverride =
  | ((options: EnqueueProjectionJobOptions) => Promise<void>)
  | null;
let enqueueDrainOverride: EnqueueOverride = null;

/** Test-only seam; null restores the real scheduler enqueue. */
export function __test_setClickUpRoleProjectionEnqueueOverride(
  override: EnqueueOverride,
): void {
  enqueueDrainOverride = override;
}

/**
 * Enqueue a ClickUp role projection drain/continuation job. Idempotent via
 * dedupeKey. May throw — callers that must not fail should use
 * kickClickUpRoleProjectionSafe.
 *
 * With no options this preserves the historical fixed producer-drain dedupe
 * default (`clickup_role_projection:drain`) so a burst of producers coalesces.
 * A caller (e.g. the 50-command handler continuation) may pass a unique
 * `dedupeKey` to force a distinct durable job, and/or a `retryAt` delay.
 */
export async function enqueueClickUpRoleProjectionJob(
  options: EnqueueProjectionJobOptions = {},
): Promise<void> {
  if (enqueueDrainOverride) {
    await enqueueDrainOverride(options);
    return;
  }
  const { enqueueJob } = await import("./workScheduler");
  await enqueueJob({
    queueName: CLICKUP_ROLE_PROJECTION_QUEUE,
    workloadClass: "maintenance",
    dedupeKey: options.dedupeKey ?? DRAIN_DEDUPE_KEY,
    maxAttempts: 3,
    ...(options.retryAt ? { retryAt: options.retryAt } : {}),
  });
}

/**
 * Insert a durable projection wake using the CALLER'S transaction handle so it
 * commits atomically with either initial command staging (immediate retryAt) or
 * a retry finalize CAS update (delayed retryAt). No vendor call or separate
 * connection. Coalesces via a deterministic command-revision-attempt key.
 * Idempotent: `onConflictDoNothing` drops only a replay of the same state
 * transition against the partial unique dedupe index.
 *
 * Callers pass the exact typed transaction used for the command CAS update.
 */
export async function enqueueProjectionWakeInTx(
  tx: ProjectionTx,
  retryAt: Date,
  identity: ProjectionWakeIdentity,
): Promise<void> {
  await enqueueProjectionWakesInTx(tx, retryAt, [identity]);
}

/**
 * Batch form used by role-wide operator resync. Every reset command gets its
 * own exact revision/attempt wake in the SAME transaction as the reset.
 */
export async function enqueueProjectionWakesInTx(
  tx: ProjectionTx,
  retryAt: Date,
  identities: ProjectionWakeIdentity[],
): Promise<void> {
  if (identities.length === 0) return;
  await tx
    .insert(workQueue)
    .values(identities.map((identity) => ({
      queueName: CLICKUP_ROLE_PROJECTION_QUEUE,
      jobType: CLICKUP_ROLE_PROJECTION_QUEUE,
      workloadClass: "maintenance",
      status: "pending",
      maxAttempts: 3,
      retryAt,
      dedupeKey: projectionWakeDedupeKey(identity),
    })))
    .onConflictDoNothing();
}

/**
 * Post-commit accelerator kick — never throws. Assignment writers
 * fire-and-forget this AFTER their business transaction commits. A kick
 * failure is logged and swallowed because the command's immediate durable wake
 * was already committed atomically during staging.
 */
export async function kickClickUpRoleProjectionSafe(): Promise<void> {
  try {
    await enqueueClickUpRoleProjectionJob();
  } catch (err: unknown) {
    console.error(
      "[ClickUpRoleProjection] Post-commit accelerator kick failed; " +
        "atomic command wakes remain durable:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Synchronous fire-and-forget wrapper for producers that cannot await.
 * Swallows all errors.
 */
export function kickClickUpRoleProjectionFireAndForget(): void {
  void kickClickUpRoleProjectionSafe();
}
