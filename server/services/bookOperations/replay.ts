// @db-pool-intent: ambient
/**
 * Book outbox replay — transition a GHL-handled failed/dead_letter outbox row
 * back to pending so the GHL relay can retry it.
 *
 * Safety guarantees:
 *   1. Only GHL-handled event types may be replayed (allow-list enforced in
 *      the UPDATE WHERE clause — non-GHL rows are rejected at the DB level
 *      regardless of their status).
 *   2. Concurrent same-key replays converge to idempotent: the lifecycle
 *      idempotency key is unique; the first writer wins, the second returns
 *      idempotent.
 *   3. The conditional UPDATE uses RETURNING to confirm ownership.  If the
 *      row is not in ('failed','dead_letter') when the UPDATE runs (e.g.
 *      another process already transitioned it), we return not-eligible
 *      rather than silently treating it as idempotent.
 *   4. The result shape is { replayed: boolean; idempotent: boolean; outboxId }
 *      to satisfy the route's `result.replayed === true` check for the
 *      GHL kick.
 *
 * GHL event type allow-list:
 *   LOCKSTEP: keep in sync with GHL_HANDLED_EVENT_TYPES in
 *   server/services/ghlOutboundSync.ts.  Any change there must be reflected
 *   here in the same commit.  Search "GHL_OPS_HANDLED_EVENT_TYPES" for all
 *   copies in the codebase.
 *
 * No GHL / external calls are made here.
 */

import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, withDbAttribution } from "../../db";
import {
  bookOutbox,
  bookOrders,
  bookLifecycleEvents,
} from "@shared/schema";
import {
  bookCommerceLabel,
  insertLifecycleEventTx,
} from "../../storage/bookCommerceStorage";
import type {
  ReplayBookOutboxEntryInput,
  ReplayBookOutboxEntryResult,
} from "./types";
import {
  ghlOpsHandledEventTypesSql,
  isGhlOpsHandledEventType,
} from "./ghlPolicy";

const OPS_LABEL = bookCommerceLabel("ops-replay-outbox");

// ─── Typed errors ─────────────────────────────────────────────────────────────

export class OutboxReplayNotFoundError extends Error {
  constructor(public readonly outboxId: string) {
    super(`Outbox entry ${outboxId} not found`);
    this.name = "OutboxReplayNotFoundError";
  }
}

export class OutboxReplayNotEligibleError extends Error {
  constructor(
    public readonly outboxId: string,
    public readonly detail: string,
  ) {
    super(`Outbox entry ${outboxId} not eligible for replay: ${detail}`);
    this.name = "OutboxReplayNotEligibleError";
  }
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function replayBookOutboxEntry({
  outboxId,
  actorUserId,
  idempotencyKey,
}: ReplayBookOutboxEntryInput): Promise<ReplayBookOutboxEntryResult> {
  return withDbAttribution(OPS_LABEL, async () => {
    const db = getDb();
    const keyDigest = crypto
      .createHash("sha256")
      .update(idempotencyKey)
      .digest("hex")
      .slice(0, 24);
    const auditIdempotencyKey =
      `ops:ghl-replay:${outboxId.slice(0, 48)}:${keyDigest}`;

    return db.transaction(async (tx) => {
      // ── 1. Load the outbox row (existence + type guard) ──────────────────
      const [row] = await tx
        .select({
          id:           bookOutbox.id,
          status:       bookOutbox.status,
          eventType:    bookOutbox.eventType,
          sourceType:   bookOutbox.sourceType,
          sourceId:     bookOutbox.sourceId,
          attemptCount: bookOutbox.attemptCount,
        })
        .from(bookOutbox)
        .where(eq(bookOutbox.id, outboxId))
        .limit(1);

      if (!row) {
        throw new OutboxReplayNotFoundError(outboxId);
      }

      // ── 2. GHL event type guard — non-GHL rows may not be replayed here ──
      const isGhlHandled = isGhlOpsHandledEventType(row.eventType);
      if (!isGhlHandled) {
        throw new OutboxReplayNotEligibleError(
          outboxId,
          `event_type '${row.eventType}' is not a GHL-handled type; ` +
            `use the appropriate relay owner to manage this row`,
        );
      }

      // ── 3. Idempotency check — same audit key already written? ───────────
      //    If the exact lifecycle idempotency key already exists, a previous
      //    call completed; return idempotent without any further mutation.
      const [existingLifecycle] = await tx
        .select({ id: bookLifecycleEvents.id })
        .from(bookLifecycleEvents)
        .where(eq(bookLifecycleEvents.idempotencyKey, auditIdempotencyKey))
        .limit(1);

      if (existingLifecycle) {
        return { replayed: false, idempotent: true, outboxId };
      }

      // ── 4. Validate current status ────────────────────────────────────────
      if (row.status !== "failed" && row.status !== "dead_letter") {
        throw new OutboxReplayNotEligibleError(
          outboxId,
          `status is '${row.status}'; only 'failed' or 'dead_letter' rows may be replayed`,
        );
      }

      // ── 5. Conditional UPDATE RETURNING (concurrent-safe) ────────────────
      //    The WHERE includes the status predicate so that if another process
      //    transitions the row between our SELECT and this UPDATE, the UPDATE
      //    matches zero rows and we can detect it.
      const updateResult = await tx.execute(sql`
        UPDATE book_outbox
        SET
          status        = 'pending',
          next_retry_at = NULL,
          error_message = NULL,
          updated_at    = now()
        WHERE id = ${outboxId}
          AND status IN ('failed', 'dead_letter')
          AND event_type IN (${ghlOpsHandledEventTypesSql()})
        RETURNING id
      `);

      if (!updateResult.rows.length) {
        // READ COMMITTED gives this statement a fresh snapshot after the
        // conditional UPDATE waited on a concurrent writer. Re-check the audit
        // key so duplicate clicks converge even when they raced.
        const [concurrentAudit] = await tx
          .select({ id: bookLifecycleEvents.id })
          .from(bookLifecycleEvents)
          .where(eq(bookLifecycleEvents.idempotencyKey, auditIdempotencyKey))
          .limit(1);
        if (concurrentAudit) {
          return { replayed: false, idempotent: true, outboxId };
        }
        throw new OutboxReplayNotEligibleError(
          outboxId,
          `concurrent update detected; the row was already transitioned by another process`,
        );
      }

      // ── 6. Resolve entity IDs for the lifecycle event ────────────────────
      let contactId: string | null = null;
      let orderId: string | null = null;
      let checkoutSessionId: string | null = null;

      if (row.sourceType === "order")            orderId = row.sourceId;
      else if (row.sourceType === "contact")      contactId = row.sourceId;
      else if (row.sourceType === "checkout_session") checkoutSessionId = row.sourceId;

      // If we have an order but no contact, look it up
      if (orderId && !contactId) {
        const [orderRow] = await tx
          .select({ contactId: bookOrders.contactId })
          .from(bookOrders)
          .where(eq(bookOrders.id, orderId))
          .limit(1);
        contactId = orderRow?.contactId ?? null;
      }

      // ── 7. Append manual_correction lifecycle event (via shared helper) ──
      await insertLifecycleEventTx(tx, {
        contactId,
        orderId,
        checkoutSessionId,
        eventType:    "manual_correction",
        fromStatus:   row.status,
        toStatus:     "pending",
        actorUserId,
        reason:       "operator_requested_ghl_outbox_replay",
        metadata: {
          outboxId,
          previousStatus:     row.status,
          replayedEventType:  row.eventType,
          attemptCountBefore: row.attemptCount,
        },
        idempotencyKey: auditIdempotencyKey,
      });

      return { replayed: true, idempotent: false, outboxId };
    });
  });
}
