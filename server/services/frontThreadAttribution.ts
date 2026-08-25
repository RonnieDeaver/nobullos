import { storage } from "../storage";

/**
 * Task #2637 — Front conversation-wide attribution.
 *
 * Stamp the resolved client_id onto EVERY `raw_communication_records` row that
 * belongs to a Front conversation/thread — the `email_thread` rollup row AND
 * every per-message `email_message` row materialized under the same
 * `externalThreadId` — so attribution is conversation-wide instead of living
 * only on the single row the matcher happened to touch.
 *
 * Invariants:
 * - `clientId` is the already-resolved deterministic-participant match or the
 *   operator's manual link. Internal `@nobullmarketing.com` senders are filtered
 *   out upstream (frontHardMatch / companyIdentity), so an internal sender can
 *   never be the resolved `clientId` — we never stamp an internal address as a
 *   client identifier.
 * - Orphaned-client guard: if `clientId` is non-null but the client no longer
 *   exists or is archived, we SKIP the stamp (leave the rows untouched) and
 *   return 0 — a thread is never attributed to a dead/archived client.
 * - `clientId === null` clears attribution across the whole thread (used when a
 *   re-match moves a conversation back to unmatched).
 *
 * One short, idempotent UPDATE — call it right after the rollup row's client_id
 * is written so the per-message rows stay in lockstep.
 *
 * @returns the number of rows stamped (0 when skipped).
 */
export async function stampThreadWideClientAttribution(
  conversationId: string,
  clientId: string | null,
): Promise<number> {
  if (!conversationId) return 0;
  if (clientId) {
    const client = await storage.getClient(clientId);
    if (!client || client.isArchived) {
      console.warn(
        `[Front ThreadAttribution] Skipped thread-wide stamp for conversation ${conversationId}: client ${clientId} is missing or archived (orphaned).`,
      );
      return 0;
    }
  }
  return storage.updateRawCommunicationsByThreadId(conversationId, { clientId });
}

/**
 * Task #4054 — insert-time attribution for NEW `raw_communication_records`
 * rows of an already-matched Front conversation.
 *
 * The webhook thread-envelope writer and the per-message materializer used
 * to insert rows with `client_id = NULL` even when the conversation was
 * already matched in `front_sync_emails` — every such row was born pending
 * for the `backfill_front_message_attribution` prod-action (71–211 rows
 * re-pending per press in prod). This resolver applies the SAME rule as
 * that action's phase-1 predicate and the thread-wide stamp above, at
 * insert time:
 *   - conversation must be `auto_matched` / `manually_matched` with a
 *     non-null `matched_client_id`, and
 *   - the client must exist and not be archived (orphaned-client guard),
 * otherwise null (row stays unattributed, exactly as before).
 *
 * Best-effort by design: any lookup error returns null (the pre-#4054
 * behavior) so attribution can never block ingestion — the self-heal
 * enrolled backfill action remains the mop-up for residual races.
 */
export async function resolveMatchedClientForConversation(
  conversationId: string | null | undefined,
): Promise<string | null> {
  if (!conversationId) return null;
  try {
    const syncEmail = await storage.getFrontSyncEmailByConversationId(conversationId);
    if (!syncEmail) return null;
    if (
      syncEmail.matchStatus !== "auto_matched" &&
      syncEmail.matchStatus !== "manually_matched"
    ) {
      return null;
    }
    const clientId = syncEmail.matchedClientId;
    if (!clientId) return null;
    const client = await storage.getClient(clientId);
    if (!client || client.isArchived) return null;
    return clientId;
  } catch (err) {
    console.warn(
      `[Front ThreadAttribution] Insert-time client resolution failed for conversation ${conversationId} (non-fatal, row stays unattributed):`,
      (err as Error)?.message,
    );
    return null;
  }
}
