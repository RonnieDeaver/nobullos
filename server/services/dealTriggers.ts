// @db-pool-intent: ambient
//
// Task #4332 — Native deal auto-move triggers.
//
// Three first-party events NoBull OS already captures move deals without
// manual dragging (the thing HubSpot needs marketplace integrations for):
//
//   booking_confirmed        confirmed booking → the client's single open
//                            deal in the default pipeline moves to the
//                            configured stage (forward-only, never backward;
//                            when lead-intake auto-created a deal for the
//                            same booking we record deal_created instead of
//                            double-acting). 0 or >1 open deals = skipped
//                            with a visible reason — never guess.
//   pandadoc_status_changed  document status transition → the EXPLICITLY
//                            linked deal moves per the admin status→stage
//                            mapping. Unlinked docs surface for manual
//                            linking; linking auto-reprocesses the event.
//   front_inbound_reply      inbound reply from a matched contact → durable
//                            reply_logged event only (the sequences feature
//                            consumes it later); recency-gated so historical
//                            re-apply sweeps can't flood the log.
//
// Processing is INLINE at the tap — emit inserts the durable event row
// (INSERT … ON CONFLICT (event_key) DO NOTHING) and only the inserting
// caller processes, so webhook/sync replays are structurally single-shot.
// Moves ride dealsStorage.moveDealStage (the only stage writer): history,
// required-fields policy, and stage automations all apply, and the history
// row carries movedBySource + triggerEventId attribution.
//
// Config lives in system_settings, read FRESH per event (no cache latch;
// all hooks default OFF). Emitters never throw — a trigger failure must
// never break booking confirmation, PandaDoc sync, or Front apply.

import {
  DEAL_TRIGGERS_BOOKING_ENABLED_KEY,
  DEAL_TRIGGERS_BOOKING_STAGE_KEY,
  DEAL_TRIGGERS_BOOKING_DEFAULT_STAGE_SLUG,
  DEAL_TRIGGERS_FRONT_REPLY_ENABLED_KEY,
  DEAL_TRIGGERS_PANDADOC_ENABLED_KEY,
  DEAL_TRIGGERS_PANDADOC_STAGE_MAP_KEY,
  dealTriggerTypeLabels,
  pandadocStageMapSchema,
  type DealTriggerEvent,
  type DealTriggerType,
  type DealTriggersConfig,
  type PandadocStageMap,
} from "@shared/schema";
import {
  claimTriggerEventForReprocess,
  countLeadingConsecutiveFailures,
  getDealById,
  getLatestSkippedEventForSource,
  getPandadocDocumentRow,
  getStageById,
  getStageBySlug,
  getTriggerEvent,
  insertTriggerEvent,
  listOpenDealsForClientInPipeline,
  markTriggerEventFailed,
  markTriggerEventProcessed,
  markTriggerEventSkipped,
} from "../storage/dealTriggersStorage";
import { getDefaultPipeline, moveDealStage } from "../storage/dealsStorage";
import { getSystemSettingFresh, setSystemSetting } from "../storage/settingsStorage";
import { notifyByType } from "./notifications/dispatcher";

export const DEAL_TRIGGERS_HOOK_FAILED_NOTIFICATION_ID =
  "workflow.deal_triggers.hook_failed";

/** Consecutive failed events (per hook) before the house alert fires. */
export const DEAL_TRIGGERS_FAILURE_STREAK_THRESHOLD = 3;

/** Inbound replies older than this never mint events — historical Front
 * re-apply sweeps re-run applyMatchedConversation over old threads. */
export const FRONT_REPLY_RECENCY_DAYS = 14;

// ── Config ───────────────────────────────────────────────────────────────────

function isTruthySetting(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "yes";
}

function parseStageMap(raw: string | null | undefined): PandadocStageMap {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = pandadocStageMapSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    console.warn("[DealTriggers] stored PandaDoc stage map failed validation — treating as empty");
  } catch {
    console.warn("[DealTriggers] stored PandaDoc stage map is not valid JSON — treating as empty");
  }
  return {};
}

/** Fresh-per-event settings read (P7: toggles/mappings must not latch). */
export async function readDealTriggersConfig(): Promise<DealTriggersConfig> {
  const [booking, bookingStage, pandadoc, stageMap, frontReply] = await Promise.all([
    getSystemSettingFresh(DEAL_TRIGGERS_BOOKING_ENABLED_KEY),
    getSystemSettingFresh(DEAL_TRIGGERS_BOOKING_STAGE_KEY),
    getSystemSettingFresh(DEAL_TRIGGERS_PANDADOC_ENABLED_KEY),
    getSystemSettingFresh(DEAL_TRIGGERS_PANDADOC_STAGE_MAP_KEY),
    getSystemSettingFresh(DEAL_TRIGGERS_FRONT_REPLY_ENABLED_KEY),
  ]);
  return {
    bookingEnabled: isTruthySetting(booking?.value),
    bookingStageSlug:
      bookingStage?.value?.trim() || DEAL_TRIGGERS_BOOKING_DEFAULT_STAGE_SLUG,
    pandadocEnabled: isTruthySetting(pandadoc?.value),
    pandadocStageMap: parseStageMap(stageMap?.value),
    frontReplyEnabled: isTruthySetting(frontReply?.value),
  };
}

/** Persist the admin config (route-called; userId = acting operator). */
export async function saveDealTriggersConfig(
  config: DealTriggersConfig,
  userId: string,
): Promise<void> {
  await setSystemSetting(
    DEAL_TRIGGERS_BOOKING_ENABLED_KEY,
    config.bookingEnabled ? "true" : "false",
    userId,
  );
  await setSystemSetting(
    DEAL_TRIGGERS_BOOKING_STAGE_KEY,
    config.bookingStageSlug,
    userId,
  );
  await setSystemSetting(
    DEAL_TRIGGERS_PANDADOC_ENABLED_KEY,
    config.pandadocEnabled ? "true" : "false",
    userId,
  );
  await setSystemSetting(
    DEAL_TRIGGERS_PANDADOC_STAGE_MAP_KEY,
    JSON.stringify(config.pandadocStageMap),
    userId,
  );
  await setSystemSetting(
    DEAL_TRIGGERS_FRONT_REPLY_ENABLED_KEY,
    config.frontReplyEnabled ? "true" : "false",
    userId,
  );
}

// ── Emitters (tap-facing; never throw) ───────────────────────────────────────

export interface BookingTriggerInput {
  meetingId: string;
  meetingTypeName?: string | null;
  /** Resolved client (existing or lead-intake-created). Null = nothing actionable. */
  clientId: string | null;
  /** Deal lead-intake auto-created for THIS booking (recorded, not re-moved). */
  autoDealId: string | null;
  createdLead?: boolean;
}

export async function emitBookingConfirmedTrigger(
  input: BookingTriggerInput,
): Promise<DealTriggerEvent | null> {
  try {
    if (!input.clientId) return null;
    const config = await readDealTriggersConfig();
    if (!config.bookingEnabled) return null;
    const row = await insertTriggerEvent({
      triggerType: "booking_confirmed",
      eventKey: `booking_confirmed:${input.meetingId}`,
      sourceId: input.meetingId,
      clientId: input.clientId,
      dealId: input.autoDealId ?? null,
      payload: {
        meetingTypeName: input.meetingTypeName ?? null,
        autoDealId: input.autoDealId ?? null,
        createdLead: !!input.createdLead,
      },
      attempts: 1,
    });
    if (!row) return null; // replay — the original insert owns processing
    await processTriggerEvent(row);
    return await getTriggerEvent(row.id) ?? row;
  } catch (err) {
    console.error("[DealTriggers] booking emit failed:", err);
    return null;
  }
}

export interface PandadocStatusTriggerInput {
  /** pandadoc_documents row id (sourceId for the event). */
  docRowId: string;
  /** Vendor document id (stable across syncs — the eventKey component). */
  documentId: string;
  title: string;
  oldStatus: string | null;
  newStatus: string;
  linkedDealId: string | null;
  linkedClientId: string | null;
}

export async function emitPandadocStatusTrigger(
  input: PandadocStatusTriggerInput,
): Promise<DealTriggerEvent | null> {
  try {
    const config = await readDealTriggersConfig();
    if (!config.pandadocEnabled) return null;
    // Only statuses the mapping covers mint events — a mapping-less status
    // transition is noise, not a pending action.
    if (!config.pandadocStageMap[input.newStatus]) return null;
    const row = await insertTriggerEvent({
      triggerType: "pandadoc_status_changed",
      eventKey: `pandadoc_status:${input.documentId}:${input.newStatus}`,
      sourceId: input.docRowId,
      clientId: input.linkedClientId,
      dealId: input.linkedDealId,
      payload: {
        documentId: input.documentId,
        title: input.title,
        oldStatus: input.oldStatus,
        newStatus: input.newStatus,
      },
      attempts: 1,
    });
    if (!row) return null; // replay (sync re-observation)
    await processTriggerEvent(row);
    return await getTriggerEvent(row.id) ?? row;
  } catch (err) {
    console.error("[DealTriggers] pandadoc emit failed:", err);
    return null;
  }
}

export interface FrontReplyTriggerInput {
  conversationId: string;
  /** Latest INBOUND message id (eventKey component — replays with an
   * unchanged latest inbound message dedupe away). */
  messageId: string;
  clientId: string;
  receivedAt: Date | null;
  subject?: string | null;
}

export async function emitFrontInboundReplyTrigger(
  input: FrontReplyTriggerInput,
): Promise<DealTriggerEvent | null> {
  try {
    if (!input.messageId) return null;
    if (
      !input.receivedAt ||
      Date.now() - input.receivedAt.getTime() >
        FRONT_REPLY_RECENCY_DAYS * 24 * 60 * 60 * 1000
    ) {
      return null; // historical sweep — not a live reply
    }
    const config = await readDealTriggersConfig();
    if (!config.frontReplyEnabled) return null;
    const row = await insertTriggerEvent({
      triggerType: "front_inbound_reply",
      eventKey: `front_reply:${input.conversationId}:${input.messageId}`,
      sourceId: input.conversationId,
      clientId: input.clientId,
      payload: {
        messageId: input.messageId,
        receivedAt: input.receivedAt.toISOString(),
        subject: input.subject ?? null,
      },
      attempts: 1,
    });
    if (!row) return null;
    await processTriggerEvent(row);
    return await getTriggerEvent(row.id) ?? row;
  } catch (err) {
    console.error("[DealTriggers] front reply emit failed:", err);
    return null;
  }
}

// ── Processing ───────────────────────────────────────────────────────────────

/** Settles the event exactly once (processed/skipped/failed). Never throws. */
export async function processTriggerEvent(event: DealTriggerEvent): Promise<void> {
  try {
    switch (event.triggerType) {
      case "booking_confirmed":
        await processBookingEvent(event);
        return;
      case "pandadoc_status_changed":
        await processPandadocEvent(event);
        return;
      case "front_inbound_reply": {
        // Task #4335 — reply-detected cancel: an inbound reply stops every
        // active sequence enrollment for the client (nobody gets a
        // follow-up after they've answered). Dynamic import keeps the
        // dependency one-directional; the cancel helper never throws.
        if (event.clientId) {
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          const messageId = typeof payload.messageId === "string" ? payload.messageId : null;
          const { cancelActiveEnrollmentsForClient } = await import("./emailSequences");
          const cancelled = await cancelActiveEnrollmentsForClient(
            event.clientId,
            "replied",
            messageId ? `Inbound reply (Front message ${messageId})` : "Inbound reply detected",
          );
          if (cancelled > 0) {
            console.log(
              `[DealTriggers] front_inbound_reply cancelled ${cancelled} sequence enrollment(s) for client ${event.clientId}`,
            );
          }
        }
        await markTriggerEventProcessed(event.id, { outcome: "reply_logged" });
        return;
      }
      default: {
        await markTriggerEventFailed(
          event.id,
          `Unknown trigger type: ${String(event.triggerType)}`,
        );
        return;
      }
    }
  } catch (err: any) {
    const message = err?.message ? String(err.message) : String(err);
    console.error(
      `[DealTriggers] ${event.triggerType} processing failed for ${event.eventKey}: ${message}`,
    );
    try {
      await markTriggerEventFailed(event.id, message);
      await maybeAlertRepeatedFailures(event.triggerType, message);
    } catch (markErr) {
      console.error("[DealTriggers] failed to record trigger failure:", markErr);
    }
  }
}

async function processBookingEvent(event: DealTriggerEvent): Promise<void> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const autoDealId = typeof payload.autoDealId === "string" ? payload.autoDealId : null;
  if (autoDealId) {
    // Lead-intake already created a deal in its configured stage for this
    // exact booking — record it; moving too would double-act on one event.
    await markTriggerEventProcessed(event.id, {
      outcome: "deal_created",
      dealId: autoDealId,
    });
    return;
  }
  if (!event.clientId) {
    await markTriggerEventSkipped(event.id, "no_open_deal", "No client resolved for booking");
    return;
  }
  const config = await readDealTriggersConfig();
  const pipeline = await getDefaultPipeline();
  if (!pipeline) {
    await markTriggerEventSkipped(event.id, "stage_not_found", "No default pipeline");
    return;
  }
  const stage = await getStageBySlug(pipeline.id, config.bookingStageSlug);
  if (!stage) {
    await markTriggerEventSkipped(
      event.id,
      "stage_not_found",
      `No stage with slug "${config.bookingStageSlug}" in the default pipeline`,
    );
    return;
  }
  if (stage.stageType !== "open") {
    await markTriggerEventSkipped(
      event.id,
      "stage_not_found",
      `Configured stage "${config.bookingStageSlug}" is ${stage.stageType} — bookings only move deals between open stages`,
    );
    return;
  }
  const openDeals = await listOpenDealsForClientInPipeline(event.clientId, pipeline.id);
  if (openDeals.length === 0) {
    await markTriggerEventSkipped(event.id, "no_open_deal");
    return;
  }
  if (openDeals.length > 1) {
    await markTriggerEventSkipped(
      event.id,
      "multiple_open_deals",
      `${openDeals.length} open deals for this client — not guessing which to move`,
    );
    return;
  }
  const deal = openDeals[0];
  if (deal.stageId === stage.id) {
    await markTriggerEventProcessed(event.id, {
      outcome: "already_in_stage",
      dealId: deal.id,
    });
    return;
  }
  // Forward-only: a new booking must never yank a deal BACKWARD from a
  // later stage (e.g. negotiation → discovery-call).
  const currentStage = await getStageById(deal.stageId);
  if (currentStage && currentStage.position >= stage.position) {
    await markTriggerEventProcessed(event.id, {
      outcome: "already_past_stage",
      dealId: deal.id,
    });
    return;
  }
  const moved = await moveDealStage(deal.id, {
    toStageId: stage.id,
    movedByUserId: null,
    movedBySource: event.triggerType,
    triggerEventId: event.id,
  });
  if (!moved) {
    await markTriggerEventFailed(event.id, "Deal disappeared during move");
    await maybeAlertRepeatedFailures(event.triggerType, "Deal disappeared during move");
    return;
  }
  await markTriggerEventProcessed(event.id, {
    outcome: "deal_moved",
    dealId: deal.id,
    stageHistoryId: moved.historyEntry.id,
  });
}

async function processPandadocEvent(event: DealTriggerEvent): Promise<void> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const newStatus = typeof payload.newStatus === "string" ? payload.newStatus : "";
  const config = await readDealTriggersConfig();
  const slug = config.pandadocStageMap[newStatus];
  if (!slug) {
    await markTriggerEventSkipped(
      event.id,
      "no_mapping",
      `No stage mapping for status "${newStatus}"`,
    );
    return;
  }
  // Re-read the doc row — the deal link may have been added AFTER the
  // original skip (that's exactly what reprocess-after-link relies on).
  const doc = await getPandadocDocumentRow(event.sourceId);
  const dealId = doc?.linkedDealId ?? event.dealId ?? null;
  if (!dealId) {
    await markTriggerEventSkipped(
      event.id,
      "no_deal_link",
      doc
        ? `Document "${doc.title}" is not linked to a deal — link it to enable auto-moves`
        : "Document row no longer exists and the event has no deal",
    );
    return;
  }
  const deal = await getDealById(dealId);
  if (!deal) {
    await markTriggerEventSkipped(event.id, "no_deal_link", "Linked deal no longer exists");
    return;
  }
  const currentStage = await getStageById(deal.stageId);
  if (currentStage && currentStage.stageType !== "open") {
    await markTriggerEventSkipped(
      event.id,
      "deal_closed",
      `Deal is already ${currentStage.stageType} — not reopening it`,
    );
    return;
  }
  const stage = await getStageBySlug(deal.pipelineId, slug);
  if (!stage) {
    await markTriggerEventSkipped(
      event.id,
      "stage_not_found",
      `No stage with slug "${slug}" in the deal's pipeline`,
    );
    return;
  }
  if (deal.stageId === stage.id) {
    await markTriggerEventProcessed(event.id, {
      outcome: "already_in_stage",
      dealId: deal.id,
    });
    return;
  }
  const moved = await moveDealStage(deal.id, {
    toStageId: stage.id,
    movedByUserId: null,
    movedBySource: event.triggerType,
    triggerEventId: event.id,
  });
  if (!moved) {
    await markTriggerEventFailed(event.id, "Deal disappeared during move");
    await maybeAlertRepeatedFailures(event.triggerType, "Deal disappeared during move");
    return;
  }
  await markTriggerEventProcessed(event.id, {
    outcome: "deal_moved",
    dealId: deal.id,
    stageHistoryId: moved.historyEntry.id,
  });
}

// ── Manual levers ────────────────────────────────────────────────────────────

export interface ReprocessResult {
  ok: boolean;
  error?: "not_found" | "not_reprocessable";
  event?: DealTriggerEvent;
}

/** Admin reprocess: CAS-claims skipped/failed (or stuck-pending) rows. */
export async function reprocessTriggerEvent(id: string): Promise<ReprocessResult> {
  const existing = await getTriggerEvent(id);
  if (!existing) return { ok: false, error: "not_found" };
  const claimed = await claimTriggerEventForReprocess(id, existing.attempts);
  if (!claimed) return { ok: false, error: "not_reprocessable" };
  await processTriggerEvent(claimed);
  const after = await getTriggerEvent(id);
  return { ok: true, event: after ?? claimed };
}

/** After an operator links a doc to a deal, immediately re-run the doc's
 * latest no_deal_link skip so the move happens without waiting. */
export async function reprocessAfterPandadocLink(
  docRowId: string,
): Promise<DealTriggerEvent | null> {
  const ev = await getLatestSkippedEventForSource(docRowId, "no_deal_link");
  if (!ev) return null;
  const res = await reprocessTriggerEvent(ev.id);
  return res.event ?? null;
}

// ── Alerting ─────────────────────────────────────────────────────────────────

async function maybeAlertRepeatedFailures(
  triggerType: DealTriggerType,
  latestError: string,
): Promise<void> {
  try {
    const streak = await countLeadingConsecutiveFailures(triggerType);
    if (streak < DEAL_TRIGGERS_FAILURE_STREAK_THRESHOLD) return;
    // House alerting: never gate on promise resolution — notifyByType
    // resolves for skips/failures too; the delivery row is the evidence.
    await notifyByType(
      DEAL_TRIGGERS_HOOK_FAILED_NOTIFICATION_ID,
      {
        text:
          `${dealTriggerTypeLabels[triggerType]} deal trigger has failed ` +
          `${streak} events in a row — latest: ${latestError} ` +
          `(run log: /admin/deal-automation)`,
      },
      {
        dedupeKey: `deal_triggers:${triggerType}`,
        failureType: "repeated_failures",
        metadata: { triggerType, streak },
        mirrorDeepLink: "/admin/deal-automation",
      },
    );
  } catch (err) {
    console.error("[DealTriggers] repeated-failure alert failed:", err);
  }
}
