/**
 * Task #5105 — GHL outbound buyer lifecycle sync: outbox relay queue.
 *
 * Queue: `ghl_outbound_sync` (workload class "maintenance" — low-priority
 * background work, never preempts interactive/ingestion).
 *
 * Every authoritative book-commerce event producer writes a row to book_outbox
 * in the same transaction as the business write. This module:
 *
 *   1. Atomically LEASES one pending, handled outbox entry. Claiming exactly
 *      one row prevents later rows from spending their lease waiting behind
 *      earlier network calls in this worker. The claim returns a LEASE TOKEN
 *      (the exact next_retry_at + last_attempt_at values
 *      it stamped) so every later finalization can prove it still owns the
 *      exact lease and an expired worker cannot clobber a fresh attempt.
 *   2. Dispatches each entry to dispatchGhlBuyerSyncEvent (the sole GHL HTTP
 *      boundary, via ghlBuyerSync.ts → ghlIntegration.ts).
 *   3. Finalizes each entry CONDITIONALLY on the lease token:
 *        - handled + successful → delivered
 *        - genuine failure → failed (bounded retry) or dead_letter
 *        - config not-ready / disabled / approval pending / kill switch →
 *          DEFERRED: push next_retry_at forward with a bounded delay WITHOUT
 *          incrementing attempt_count and WITHOUT marking delivered/dead-letter.
 *   4. Bounded retries: maxAttempts (stored on the outbox row at insert).
 *   5. Dead-letter after maxAttempts exhausted.
 *   6. Kill switch: ghl_outbound_sync — stops CLAIMING new work. A row that was
 *      already leased before the switch flipped is DEFERRED (never delivered,
 *      never counted as an attempt).
 *   7. Boot catch-up: a deployment-only one-shot at +30 s re-enqueues any
 *      outbox rows stuck in pending (post-commit kick lost). Bounded page.
 *
 * Producers call kickGhlOutboundSyncJobSafe after committing their business
 * transaction. A kick failure never fails the producer's write.
 */
// @db-pool-intent: worker

import { sql } from "drizzle-orm";
import { type BookOutboxEventType } from "@shared/schema";
import { getDb, runWithWorkerDb, withDbAttribution } from "../db";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { isKillSwitchEnabled } from "./killSwitches";
import { dispatchGhlBuyerSyncEvent, type GhlSyncResult } from "./ghlBuyerSync";
import { enqueueGhlOutboundSyncJob } from "./ghlOutboundKick";

export {
  GHL_OUTBOUND_SYNC_QUEUE,
  enqueueGhlOutboundSyncJob,
  kickGhlOutboundSyncJobSafe,
} from "./ghlOutboundKick";

// ─── Retry policy ─────────────────────────────────────────────────────────────

/** Exponential back-off capped at 1 h: 30s, 2m, 10m, 30m, 60m. */
export function retryDelayMs(attempt: number): number {
  const delays = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
  return delays[Math.min(attempt, delays.length - 1)];
}

/**
 * Bounded delay applied when a row is DEFERRED (config not ready / disabled /
 * approval pending / kill switch). Deferral does NOT consume an attempt, so we
 * use a fixed, bounded backoff so a not-yet-activated feature does not hot-loop
 * the row while still recovering promptly once the config/kill switch flips.
 */
export const DEFER_DELAY_MS = 5 * 60_000;

// ─── Pure relay transition seam (unit-testable; no self-rederived constants) ──

export type RelayFinalizeAction =
  | { kind: "delivered" }
  | { kind: "deferred"; nextRetryAt: Date }
  | { kind: "failed"; attemptCount: number; nextRetryAt: Date; error: string }
  | { kind: "dead_letter"; attemptCount: number; error: string };

/**
 * Pure decision function: given a dispatch result and the row's attempt
 * bookkeeping, decide how the row must be finalized. Kept pure and exported so
 * the transition table is unit-testable without any DB.
 *
 *   - deferred  → config not ready / disabled / approval pending / kill switch.
 *                 next_retry_at pushed forward by a bounded delay, attempt_count
 *                 UNCHANGED, never delivered / dead-lettered.
 *   - delivered → the event was truly handled + succeeded, OR it is genuinely
 *                 irrelevant to GHL (unhandled type) so it can be retired.
 *   - failed    → genuine transient failure with attempts remaining.
 *   - dead_letter → genuine failure with attempts exhausted.
 */
export function decideRelayFinalize(
  result: GhlSyncResult,
  attemptCount: number,
  maxAttempts: number,
  now: number = Date.now(),
): RelayFinalizeAction {
  // Deferral: NEVER counts as an attempt, NEVER delivered.
  if (result.deferred) {
    return { kind: "deferred", nextRetryAt: new Date(now + DEFER_DELAY_MS) };
  }
  // Truly handled + successful, or intentionally-irrelevant skip → retire.
  if (result.ok || result.skipped) {
    return { kind: "delivered" };
  }
  // Genuine failure — bounded retry or dead-letter.
  const newAttempt = attemptCount + 1;
  const error = result.error ?? "unknown";
  if (newAttempt >= maxAttempts) {
    return { kind: "dead_letter", attemptCount: newAttempt, error };
  }
  return {
    kind: "failed",
    attemptCount: newAttempt,
    nextRetryAt: new Date(now + retryDelayMs(newAttempt)),
    error,
  };
}

// ─── Outbox claim + dispatch ──────────────────────────────────────────────────

/**
 * One row per claim is deliberate. A page-wide lease plus serial dispatch lets
 * a later row's lease expire before its first GHL call, allowing a second
 * instance to dispatch that same event concurrently. Per-row claims preserve
 * cross-instance exclusivity for the full dispatch window.
 */
export const GHL_OUTBOUND_CLAIM_SIZE = 1;
const BOOT_CATCHUP_DELAY_MS = 30_000;
const CATCHUP_MIN_AGE_MS = 2 * 60_000;
const CATCHUP_LIMIT = 100;

/**
 * Lease duration. When a page is claimed, each row's `next_retry_at` and
 * `last_attempt_at` are stamped with specific timestamps that TOGETHER form the
 * row's LEASE TOKEN. No other instance (and no re-entry of THIS handler)
 * reclaims a row while it is being dispatched, and every finalize proves it
 * still owns EXACTLY that lease before mutating the row. If the process crashes
 * mid-dispatch, the lease expires and the row becomes eligible again — an
 * expired worker that wakes late can no longer overwrite the newer attempt.
 * A single GHL dispatch must finish well within this window; ghlIntegration
 * enforces per-call timeouts far below.
 */
const LEASE_MS = 5 * 60_000;

/**
 * The set of outbox event types this relay handles. The claim query filters to
 * EXACTLY these types via SQL so the relay NEVER touches (never leases, never
 * marks delivered) unrelated book_outbox rows owned by other consumers.
 *
 * SOURCE-SCAN CONTRACT: the conditional-lease-finalization scanner and the
 * handled-event-filter scanner in the test assert against this literal list.
 */
const GHL_HANDLED_EVENT_TYPES: readonly BookOutboxEventType[] = [
  "checkout.recoverable",
  "checkout.completed",
  "order.payment_captured",
  "order.partially_refunded",
  "application.submitted",
  "application.qualified",
  "application.not_qualified",
  "appointment.scheduled",
  "appointment.cancelled",
  "appointment.completed",
  "appointment.no_show",
  "order.refunded",
  "order.cancelled",
  "bonus.viewed",
  "consent.sms_updated",
];

/** SQL fragment: the handled event-type IN(...) list. */
function handledEventTypesSql() {
  return sql.join(
    GHL_HANDLED_EVENT_TYPES.map((t) => sql`${t}`),
    sql`, `,
  );
}

export interface ClaimedOutboxRow {
  id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  attempt_count: number;
  max_attempts: number;
  /** Lease token part 1: the next_retry_at value stamped at claim time. */
  lease_next_retry_at: string;
  /** Lease token part 2: the last_attempt_at value stamped at claim time. */
  lease_last_attempt_at: string;
}

/**
 * Atomically LEASE one due, handled outbox row and return it WITH its lease
 * token.
 *
 * This is a single `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`
 * so the claim + lease is one atomic, cross-instance-exclusive statement:
 *   - `FOR UPDATE SKIP LOCKED` skips rows another instance is claiming.
 *   - Setting `next_retry_at = now + LEASE_MS` and `last_attempt_at = now` in
 *     the same UPDATE hides the row from every subsequent claim until the lease
 *     expires; those two stamped values ARE the lease token RETURNED here.
 *   - The event_type IN (...) filter guarantees we lease ONLY GHL-relevant rows.
 *   - Tests may narrow the candidate IDs so fixture assertions cannot claim
 *     ambient rows. Production omits this scope and preserves normal ordering.
 */
export async function __test_claimGhlOutboxPage(
  db: ReturnType<typeof getDb>,
  candidateIds?: readonly string[],
): Promise<ClaimedOutboxRow[]> {
  const leaseExpiry = new Date(Date.now() + LEASE_MS);
  const now = new Date();
  const candidateIdsSql =
    candidateIds === undefined
      ? sql``
      : candidateIds.length === 0
        ? sql`AND FALSE`
        : sql`AND id IN (${sql.join(candidateIds.map((id) => sql`${id}`), sql`, `)})`;

  const result = await withDbAttribution("ghlOutboundSync:claim", async () =>
    db.execute(sql`
      UPDATE book_outbox
      SET
        next_retry_at = ${leaseExpiry},
        last_attempt_at = ${now},
        updated_at = now()
      WHERE id IN (
        SELECT id FROM book_outbox
        WHERE status = 'pending'
          AND event_type IN (${handledEventTypesSql()})
          AND (next_retry_at IS NULL OR next_retry_at <= ${now})
          ${candidateIdsSql}
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${GHL_OUTBOUND_CLAIM_SIZE}
      )
      RETURNING id, event_type, payload, attempt_count, max_attempts,
                next_retry_at AS lease_next_retry_at,
                last_attempt_at AS lease_last_attempt_at
    `),
  );

  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    event_type: String(r.event_type),
    payload: (r.payload as Record<string, unknown> | null) ?? null,
    attempt_count: Number(r.attempt_count ?? 0),
    max_attempts: Number(r.max_attempts ?? 5),
    lease_next_retry_at: toIso(r.lease_next_retry_at),
    lease_last_attempt_at: toIso(r.lease_last_attempt_at),
  }));
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v)).toISOString();
}

/**
 * Claim and process one page of due, handled outbox entries for GHL sync.
 * Returns the count processed and whether a full batch was claimed.
 *
 * This is NOT a work_queue handler — it is called BY the work_queue handler
 * with the DB handle already in worker context.
 */
async function processGhlOutboxPage(): Promise<{ processed: number; hadWork: boolean }> {
  // Kill switch: do NOT claim new work. Rows already leased below are DEFERRED
  // (never delivered / counted) if the switch flips mid-page.
  if (isKillSwitchEnabled("ghl_outbound_sync")) {
    return { processed: 0, hadWork: false };
  }

  return withDbAttribution("ghlOutboundSync:processPage", async () => {
    const db = getDb();
    const entries = await __test_claimGhlOutboxPage(db);
    if (!entries.length) return { processed: 0, hadWork: false };

    let processed = 0;
    for (const entry of entries) {
      const eventType = entry.event_type as BookOutboxEventType;

      // If the kill switch flipped after this row was leased, DEFER it instead
      // of dispatching — never deliver, never consume an attempt. We still
      // finalize conditionally on the lease so an expired worker cannot clobber
      // it.
      let result: GhlSyncResult;
      if (isKillSwitchEnabled("ghl_outbound_sync")) {
        result = {
          ok: false,
          skipped: false,
          deferred: true,
          skipReason: "kill_switch_raced",
        };
      } else {
        result = await dispatchGhlBuyerSyncEvent(eventType, entry.payload);
      }

      await finalizeEntry(db, entry, result);
      processed++;
    }

    return {
      processed,
      hadWork: entries.length === GHL_OUTBOUND_CLAIM_SIZE,
    };
  });
}

/**
 * Finalize one leased entry CONDITIONALLY on its lease token. Every terminal
 * update proves it still owns the exact lease (id + next_retry_at token +
 * last_attempt_at token) so an expired worker that wakes late — after the lease
 * expired and another worker re-claimed the row — cannot overwrite the newer
 * attempt.
 */
async function finalizeEntry(
  db: ReturnType<typeof getDb>,
  entry: ClaimedOutboxRow,
  result: GhlSyncResult,
): Promise<void> {
  const action = decideRelayFinalize(result, entry.attempt_count, entry.max_attempts);
  switch (action.kind) {
    case "delivered":
      await markEntryDelivered(db, entry);
      return;
    case "deferred":
      await deferEntry(db, entry, action.nextRetryAt);
      return;
    case "failed":
      await markEntryFailed(db, entry, action.attemptCount, action.error, action.nextRetryAt);
      return;
    case "dead_letter":
      await markEntryDeadLetter(db, entry, action.attemptCount, action.error);
      return;
  }
}

/**
 * The lease-ownership WHERE clause shared by EVERY finalize. It matches the row
 * by id AND both lease-token columns, so a row that was re-leased by another
 * worker (which advanced next_retry_at / last_attempt_at) will NOT be updated
 * by a stale worker.
 */
function ownsLease(entry: ClaimedOutboxRow) {
  return sql`id = ${entry.id}
    AND next_retry_at = ${new Date(entry.lease_next_retry_at)}
    AND last_attempt_at = ${new Date(entry.lease_last_attempt_at)}`;
}

async function markEntryDelivered(
  db: ReturnType<typeof getDb>,
  entry: ClaimedOutboxRow,
): Promise<void> {
  await withDbAttribution("ghlOutboundSync:delivered", async () => {
    await db.execute(sql`
      UPDATE book_outbox
      SET status = 'delivered', delivered_at = now(), next_retry_at = NULL, updated_at = now()
      WHERE ${ownsLease(entry)}
    `);
  });
}

async function deferEntry(
  db: ReturnType<typeof getDb>,
  entry: ClaimedOutboxRow,
  nextRetryAt: Date,
): Promise<void> {
  // DEFER: stay pending, push next_retry_at forward by a bounded delay, do NOT
  // touch attempt_count and do NOT mark delivered/dead-letter.
  await withDbAttribution("ghlOutboundSync:deferred", async () => {
    await db.execute(sql`
      UPDATE book_outbox
      SET status = 'pending',
          next_retry_at = ${nextRetryAt},
          updated_at = now()
      WHERE ${ownsLease(entry)}
    `);
  });
}

async function markEntryFailed(
  db: ReturnType<typeof getDb>,
  entry: ClaimedOutboxRow,
  attemptCount: number,
  errorMessage: string,
  nextRetryAt: Date,
): Promise<void> {
  const bounded = errorMessage.slice(0, 2000);
  await withDbAttribution("ghlOutboundSync:failed", async () => {
    await db.execute(sql`
      UPDATE book_outbox
      SET status = 'pending',
          attempt_count = ${attemptCount},
          last_attempt_at = now(),
          next_retry_at = ${nextRetryAt},
          error_message = ${bounded},
          updated_at = now()
      WHERE ${ownsLease(entry)}
    `);
  });
}

async function markEntryDeadLetter(
  db: ReturnType<typeof getDb>,
  entry: ClaimedOutboxRow,
  attemptCount: number,
  errorMessage: string,
): Promise<void> {
  const bounded = errorMessage.slice(0, 2000);
  await withDbAttribution("ghlOutboundSync:dead_letter", async () => {
    await db.execute(sql`
      UPDATE book_outbox
      SET status = 'dead_letter',
          attempt_count = ${attemptCount},
          last_attempt_at = now(),
          next_retry_at = NULL,
          error_message = ${bounded},
          updated_at = now()
      WHERE ${ownsLease(entry)}
    `);
  });
}

// ─── Work queue handler ───────────────────────────────────────────────────────

export async function handleGhlOutboundSyncJob(): Promise<{ cursor?: string }> {
  if (isKillSwitchEnabled("ghl_outbound_sync")) {
    return { cursor: "kill_switch:ghl_outbound_sync:aborted" };
  }

  let totalProcessed = 0;
  let hadWork = true;

  while (hadWork) {
    const result = await runWithWorkerDb(() => processGhlOutboxPage());
    totalProcessed += result.processed;
    hadWork = result.hadWork;
    if (isKillSwitchEnabled("ghl_outbound_sync")) break;
  }

  return { cursor: `processed:${totalProcessed}` };
}

// ─── Boot catch-up ────────────────────────────────────────────────────────────

/**
 * Deployment-only one-shot boot catch-up. Re-enqueues a bounded page of
 * pending outbox rows older than CATCHUP_MIN_AGE_MS whose post-commit kick
 * was lost (process death between commit and kick). Not a periodic scheduler.
 */
export function scheduleGhlOutboundSyncBootCatchup(): void {
  if (!isRunningInDeployment()) return;

  setTimeout(async () => {
    try {
      if (isKillSwitchEnabled("ghl_outbound_sync")) return;

      const cutoff = new Date(Date.now() - CATCHUP_MIN_AGE_MS);

      // Only count rows this relay actually owns (handled event types) that are
      // pending, past their lease/retry time, and older than the catch-up floor.
      const stuckEntries = await runWithWorkerDb(() =>
        withDbAttribution("ghlOutboundSync:bootCatchup", async () => {
          const db = getDb();
          const now = new Date();
          const res = await db.execute(sql`
            SELECT id FROM book_outbox
            WHERE status = 'pending'
              AND event_type IN (${handledEventTypesSql()})
              AND created_at < ${cutoff}
              AND (next_retry_at IS NULL OR next_retry_at <= ${now})
            LIMIT ${CATCHUP_LIMIT}
          `);
          return res.rows as Array<{ id: string }>;
        }),
      );

      if (stuckEntries.length > 0) {
        console.log(
          `[GhlOutboundSync] Boot catch-up: found ${stuckEntries.length} stuck pending ` +
            `outbox entries — enqueueing drain job.`,
        );
        await enqueueGhlOutboundSyncJob();
      } else {
        console.log("[GhlOutboundSync] Boot catch-up: no stuck pending entries found.");
      }
    } catch (err: unknown) {
      console.error(
        "[GhlOutboundSync] Boot catch-up failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }, BOOT_CATCHUP_DELAY_MS);
}
