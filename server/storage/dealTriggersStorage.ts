// @db-pool-intent: ambient
//
// Task #4332 — storage for the native deal auto-move trigger log
// (deal_trigger_events) plus the PandaDoc document→deal link.
//
// Invariants owned here:
//   - Emit is INSERT … ON CONFLICT (event_key) DO NOTHING RETURNING — the
//     replay guard. A null return means the event already exists (webhook /
//     sync replay) and the caller must NOT process; only the inserting
//     caller runs the processor, so double-moves are structurally
//     impossible.
//   - Manual reprocess claims via a CAS on (claimable status, attempts) so
//     two concurrent admin presses cannot both win. `processed` rows are
//     terminal — never reclaimable.
//   - Reads are bounded (limit-capped, index-backed: event_key unique,
//     (trigger_type, created_at), (source_id)).

import { and, desc, eq, isNull, inArray, sql, type SQL } from "drizzle-orm";
import {
  dealStages,
  dealTriggerEvents,
  deals,
  pandadocDocuments,
  type Deal,
  type DealStage,
  type DealTriggerEvent,
  type DealTriggerEventStatus,
  type DealTriggerOutcome,
  type DealTriggerType,
  type InsertDealTriggerEvent,
  type PandadocDocument,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";

// ── Event log ────────────────────────────────────────────────────────────────

/**
 * Replay-safe emit. Returns the inserted row, or null when an event with
 * the same eventKey already exists (replay — caller must not process).
 */
export async function insertTriggerEvent(
  input: InsertDealTriggerEvent,
): Promise<DealTriggerEvent | null> {
  return withDbAttribution("dealTriggers:emit", async () => {
    const [row] = await getDb()
      .insert(dealTriggerEvents)
      .values(input)
      .onConflictDoNothing({ target: dealTriggerEvents.eventKey })
      .returning();
    return row ?? null;
  });
}

export const TRIGGER_EVENTS_DEFAULT_LIMIT = 50;
export const TRIGGER_EVENTS_MAX_LIMIT = 200;

export interface ListTriggerEventsOpts {
  triggerType?: DealTriggerType;
  status?: DealTriggerEventStatus;
  limit?: number;
}

export async function listTriggerEvents(
  opts: ListTriggerEventsOpts = {},
): Promise<DealTriggerEvent[]> {
  const limit = Math.min(
    Math.max(1, opts.limit ?? TRIGGER_EVENTS_DEFAULT_LIMIT),
    TRIGGER_EVENTS_MAX_LIMIT,
  );
  const conditions: SQL[] = [];
  if (opts.triggerType) conditions.push(eq(dealTriggerEvents.triggerType, opts.triggerType));
  if (opts.status) conditions.push(eq(dealTriggerEvents.status, opts.status));
  return withDbAttribution("dealTriggers:list", async () => {
    return getDb()
      .select()
      .from(dealTriggerEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(dealTriggerEvents.createdAt))
      .limit(limit);
  });
}

export async function getTriggerEvent(id: string): Promise<DealTriggerEvent | undefined> {
  return withDbAttribution("dealTriggers:get", async () => {
    const [row] = await getDb()
      .select()
      .from(dealTriggerEvents)
      .where(eq(dealTriggerEvents.id, id))
      .limit(1);
    return row;
  });
}

/** Minutes after which a still-`pending` row counts as stuck (its inline
 * processor died mid-flight) and becomes reclaimable. */
export const TRIGGER_EVENT_STUCK_PENDING_MINUTES = 2;

/**
 * CAS claim for manual reprocess: skipped/failed rows (any age) or stuck
 * pending rows flip back to pending. `expectedAttempts` is the CAS token —
 * a concurrent claimer already bumped it, so the second press loses and
 * gets null. Processed rows are terminal and never match.
 */
export async function claimTriggerEventForReprocess(
  id: string,
  expectedAttempts: number,
): Promise<DealTriggerEvent | null> {
  return withDbAttribution("dealTriggers:claim", async () => {
    const [row] = await getDb()
      .update(dealTriggerEvents)
      .set({ status: "pending", error: null, attempts: sql`${dealTriggerEvents.attempts} + 1` })
      .where(
        and(
          eq(dealTriggerEvents.id, id),
          eq(dealTriggerEvents.attempts, expectedAttempts),
          sql`(${dealTriggerEvents.status} IN ('skipped', 'failed') OR (${dealTriggerEvents.status} = 'pending' AND ${dealTriggerEvents.createdAt} < now() - interval '${sql.raw(String(TRIGGER_EVENT_STUCK_PENDING_MINUTES))} minutes'))`,
        ),
      )
      .returning();
    return row ?? null;
  });
}

export interface TriggerEventResolution {
  outcome: DealTriggerOutcome;
  dealId?: string | null;
  stageHistoryId?: string | null;
  error?: string | null;
}

export async function markTriggerEventProcessed(
  id: string,
  res: TriggerEventResolution,
): Promise<void> {
  await withDbAttribution("dealTriggers:markProcessed", async () => {
    await getDb()
      .update(dealTriggerEvents)
      // TriggerEventResolution is built only by the internal dealTriggers
      // processors (server/services/dealTriggers.ts) from server-resolved row
      // IDs (deals.id, stage-history id) — no request-shaped data can reach it.
      .set({ // spread-write-approved: internal processor literals only — dealId/stageHistoryId are server-resolved row IDs, no request-shaped caller
        status: "processed",
        outcome: res.outcome,
        ...(res.dealId !== undefined ? { dealId: res.dealId } : {}),
        ...(res.stageHistoryId !== undefined ? { stageHistoryId: res.stageHistoryId } : {}),
        error: null,
        processedAt: new Date(),
      })
      .where(eq(dealTriggerEvents.id, id));
  });
}

export async function markTriggerEventSkipped(
  id: string,
  outcome: DealTriggerOutcome,
  error?: string | null,
): Promise<void> {
  await withDbAttribution("dealTriggers:markSkipped", async () => {
    await getDb()
      .update(dealTriggerEvents)
      .set({ status: "skipped", outcome, error: error ?? null, processedAt: new Date() })
      .where(eq(dealTriggerEvents.id, id));
  });
}

export async function markTriggerEventFailed(id: string, error: string): Promise<void> {
  await withDbAttribution("dealTriggers:markFailed", async () => {
    await getDb()
      .update(dealTriggerEvents)
      .set({ status: "failed", error, processedAt: new Date() })
      .where(eq(dealTriggerEvents.id, id));
  });
}

/**
 * Leading run of consecutive `failed` rows for a hook, newest-first over
 * the last `window` settled (non-pending) events. Powers the repeated-
 * failure alert streak (≥3).
 */
export async function countLeadingConsecutiveFailures(
  triggerType: DealTriggerType,
  window = 10,
): Promise<number> {
  const rows = await withDbAttribution("dealTriggers:streak", async () => {
    return getDb()
      .select({ status: dealTriggerEvents.status })
      .from(dealTriggerEvents)
      .where(
        and(
          eq(dealTriggerEvents.triggerType, triggerType),
          inArray(dealTriggerEvents.status, ["processed", "skipped", "failed"]),
        ),
      )
      .orderBy(desc(dealTriggerEvents.createdAt))
      .limit(window);
  });
  let streak = 0;
  for (const row of rows) {
    if (row.status !== "failed") break;
    streak += 1;
  }
  return streak;
}

/** Latest reprocessable (skipped, outcome-matched) event for a source —
 * used to auto-reprocess a doc's event right after an operator links it. */
export async function getLatestSkippedEventForSource(
  sourceId: string,
  outcome: DealTriggerOutcome,
): Promise<DealTriggerEvent | undefined> {
  return withDbAttribution("dealTriggers:latestSkipped", async () => {
    const [row] = await getDb()
      .select()
      .from(dealTriggerEvents)
      .where(
        and(
          eq(dealTriggerEvents.sourceId, sourceId),
          eq(dealTriggerEvents.status, "skipped"),
          eq(dealTriggerEvents.outcome, outcome),
        ),
      )
      .orderBy(desc(dealTriggerEvents.createdAt))
      .limit(1);
    return row;
  });
}

// ── Deal / stage lookups for processing ──────────────────────────────────────

export async function getDealById(dealId: string): Promise<Deal | undefined> {
  return withDbAttribution("dealTriggers:getDeal", async () => {
    const [row] = await getDb().select().from(deals).where(eq(deals.id, dealId)).limit(1);
    return row;
  });
}

export async function getStageById(stageId: string): Promise<DealStage | undefined> {
  return withDbAttribution("dealTriggers:getStage", async () => {
    const [row] = await getDb()
      .select()
      .from(dealStages)
      .where(eq(dealStages.id, stageId))
      .limit(1);
    return row;
  });
}

export async function getStageBySlug(
  pipelineId: string,
  slug: string,
): Promise<DealStage | undefined> {
  return withDbAttribution("dealTriggers:getStageBySlug", async () => {
    const [row] = await getDb()
      .select()
      .from(dealStages)
      .where(and(eq(dealStages.pipelineId, pipelineId), eq(dealStages.slug, slug)))
      .limit(1);
    return row;
  });
}

/** Non-archived deals sitting in an OPEN stage of the given pipeline. */
export async function listOpenDealsForClientInPipeline(
  clientId: string,
  pipelineId: string,
): Promise<Deal[]> {
  return withDbAttribution("dealTriggers:openDeals", async () => {
    const rows = await getDb()
      .select({ deal: deals })
      .from(deals)
      .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
      .where(
        and(
          eq(deals.clientId, clientId),
          eq(deals.pipelineId, pipelineId),
          eq(deals.isArchived, false),
          eq(dealStages.stageType, "open"),
        ),
      );
    return rows.map((r) => r.deal);
  });
}

// ── PandaDoc deal link ───────────────────────────────────────────────────────

export async function getPandadocDocumentRow(
  id: string,
): Promise<PandadocDocument | undefined> {
  return withDbAttribution("dealTriggers:getDoc", async () => {
    const [row] = await getDb()
      .select()
      .from(pandadocDocuments)
      .where(eq(pandadocDocuments.id, id))
      .limit(1);
    return row;
  });
}

/** The ONLY writer of pandadoc_documents.linked_deal_id (see model note). */
export async function linkPandadocDocumentToDeal(
  id: string,
  dealId: string | null,
): Promise<PandadocDocument | undefined> {
  return withDbAttribution("dealTriggers:linkDoc", async () => {
    const [row] = await getDb()
      .update(pandadocDocuments)
      .set({ linkedDealId: dealId })
      .where(eq(pandadocDocuments.id, id))
      .returning();
    return row;
  });
}

export const UNLINKED_DOCS_LIMIT = 50;

/**
 * Docs whose CURRENT status is covered by the admin mapping but that have
 * no deal link — the manual-linking review surface.
 */
export async function listUnlinkedMappedPandadocDocuments(
  mappedStatuses: string[],
): Promise<PandadocDocument[]> {
  if (mappedStatuses.length === 0) return [];
  return withDbAttribution("dealTriggers:unlinkedDocs", async () => {
    return getDb()
      .select()
      .from(pandadocDocuments)
      .where(
        and(
          inArray(pandadocDocuments.status, mappedStatuses),
          isNull(pandadocDocuments.linkedDealId),
        ),
      )
      .orderBy(desc(pandadocDocuments.lastSyncedAt))
      .limit(UNLINKED_DOCS_LIMIT);
  });
}
