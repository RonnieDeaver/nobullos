/**
 * Task #5105 — GHL outbound sync post-commit kick (dependency-light).
 *
 * This module holds ONLY the enqueue/kick helpers so that storage-layer
 * producers can fire a post-commit kick without importing the full relay
 * handler (which pulls in ghlBuyerSync → ghlIntegration → storage and would
 * create an import cycle). The relay handler in ghlOutboundSync.ts re-exports
 * these symbols for its own callers.
 *
 * Contract:
 *   - `kickGhlOutboundSyncJobSafe()` NEVER throws. A failed kick leaves the
 *     outbox row pending; deployment boot catch-up recovers it.
 *   - The enqueue is idempotent via a fixed dedupeKey (`ghl_outbound_sync:drain`)
 *     so a burst of producers coalesces into one drain job.
 */

export const GHL_OUTBOUND_SYNC_QUEUE = "ghl_outbound_sync";

const DRAIN_DEDUPE_KEY = "ghl_outbound_sync:drain";

type EnqueueDrainOverride = (() => Promise<void>) | null;
let enqueueDrainOverride: EnqueueDrainOverride = null;

/** Test-only leaf seam; null restores the real scheduler enqueue. */
export function __test_setGhlOutboundEnqueueOverride(
  override: EnqueueDrainOverride,
): void {
  enqueueDrainOverride = override;
}

/**
 * Enqueue a GHL outbound sync drain job. Idempotent via dedupeKey.
 * May throw if the scheduler is unavailable — callers that must not fail
 * should use kickGhlOutboundSyncJobSafe instead.
 */
export async function enqueueGhlOutboundSyncJob(): Promise<void> {
  if (enqueueDrainOverride) {
    await enqueueDrainOverride();
    return;
  }
  const { enqueueJob } = await import("./workScheduler");
  await enqueueJob({
    queueName: GHL_OUTBOUND_SYNC_QUEUE,
    workloadClass: "maintenance",
    dedupeKey: DRAIN_DEDUPE_KEY,
    maxAttempts: 3,
  });
}

/**
 * Post-commit kick — never throws. Producers fire-and-forget this AFTER their
 * business transaction commits. A kick failure is logged and swallowed; the
 * outbox row stays pending and the deployment boot catch-up drains it later.
 */
export async function kickGhlOutboundSyncJobSafe(): Promise<void> {
  try {
    await enqueueGhlOutboundSyncJob();
  } catch (err: unknown) {
    console.error(
      "[GhlOutboundSync] Post-commit kick failed — outbox stays pending; " +
        "boot catch-up will recover it:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Synchronous fire-and-forget wrapper for producers that cannot await the kick
 * (e.g. inside a returning storage function). Swallows all errors, including
 * synchronous throws from the microtask scheduler.
 */
export function kickGhlOutboundSyncFireAndForget(): void {
  void kickGhlOutboundSyncJobSafe();
}
