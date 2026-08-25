/**
 * Task #4330 — lead intake: promotes existing intake events (website
 * inquiries, confirmed bookings) into first-class lead records on the
 * clients model.
 *
 * Both entry points are called BEST-EFFORT (dynamic import + try/catch at
 * the call sites): the public inquiry endpoint and the booking saga must
 * never fail because lead promotion did. Failures log loudly; the
 * notification flow they sit next to is untouched either way.
 *
 * Lifecycle semantics live in server/storage/leadLifecycleStorage.ts
 * (forward-only advance, per-email advisory-lock match-or-create). This
 * module wires the events, links the source rows, keeps the Front
 * hard-match index fresh, and owns the OPT-IN auto-deal on booking:
 *
 *   leads_booking_auto_deal_enabled  ('true' to enable; default OFF so the
 *                                     session_booked funnel stage stays
 *                                     visible unless an operator opts in)
 *   leads_booking_auto_deal_stage    (default pipeline stage slug for the
 *                                     auto-created deal; default
 *                                     'discovery-call')
 */

import {
  deriveFirstTouch,
  type ScheduledMeeting,
  type WebsiteInquiry,
} from "@shared/schema";
import { storage } from "../storage";
import {
  advanceClientLifecycle,
  hasOpenDealForClient,
  linkWebsiteInquiryToLead,
  matchOrCreateLeadClient,
  type MatchOrCreateLeadResult,
} from "../storage/leadLifecycleStorage";
import {
  createDeal,
  ensureDefaultDealPipelineSeeded,
  getDefaultPipeline,
  listPipelinesWithStages,
} from "../storage/dealsStorage";
import { invalidateHardMatchIndexes } from "./frontHardMatch";

export const LEADS_BOOKING_AUTO_DEAL_ENABLED_KEY = "leads_booking_auto_deal_enabled";
export const LEADS_BOOKING_AUTO_DEAL_STAGE_KEY = "leads_booking_auto_deal_stage";
const DEFAULT_AUTO_DEAL_STAGE_SLUG = "discovery-call";

function isTruthySetting(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "yes";
}

/**
 * Website inquiry (kind 'contact') → match-or-create a lead at stage
 * 'lead', stamp source, link the inquiry row to the client record.
 * Unsubscribe rows are NOT leads. Returns the promotion result (null when
 * skipped) so tests can assert directly.
 */
export async function promoteWebsiteInquiryToLead(
  inquiry: WebsiteInquiry,
): Promise<MatchOrCreateLeadResult | null> {
  if (inquiry.kind !== "contact") return null;
  if (!inquiry.email?.trim()) return null;

  const result = await matchOrCreateLeadClient({
    email: inquiry.email,
    name: inquiry.fullName,
    phone: inquiry.phone,
    initialStage: "lead",
    leadSource: "website_inquiry",
    changeSource: "website_inquiry",
    reason: inquiry.sourcePage ? `Website inquiry from ${inquiry.sourcePage}` : "Website inquiry",
    // Task #4337 — normalized first-touch stamp (no capture → "direct").
    // Only used when this call MINTS the record; matched clients keep
    // their original stamp (first touch is immutable).
    firstTouch: deriveFirstTouch(inquiry),
  });
  if (!result) return null;

  await linkWebsiteInquiryToLead(inquiry.id, result.client.id);
  if (result.created) {
    // The new lead has a contact row now — let the Front matcher see it
    // without waiting out the index TTL.
    invalidateHardMatchIndexes();
  }
  return result;
}

export interface BookingLifecycleOutcome {
  clientId: string | null;
  createdLead: boolean;
  linkedMeeting: boolean;
  autoDealId: string | null;
}

/**
 * Confirmed booking → lifecycle hook.
 *
 *  - Meeting already client-bound (AM on-behalf, client-bound public link):
 *    forward-only advance to 'session_booked' (customers no-op).
 *  - Anonymous public booking: match-or-create by invitee email. If the
 *    resulting record is a PROSPECT, stamp meeting.client_id so the session
 *    shows on the lead's record. A matched CUSTOMER does NOT auto-link the
 *    meeting — public bookings by existing clients behave exactly as they
 *    did before this task (out of scope to change).
 *  - Optional auto-deal (settings above): for prospect records with no open
 *    deal yet, create one in the default pipeline at the configured stage,
 *    owned by the host AM. The deal-created storage hook then advances the
 *    lifecycle to 'opportunity'.
 */
export async function handleBookingConfirmedForLifecycle(
  meeting: ScheduledMeeting,
): Promise<BookingLifecycleOutcome> {
  const outcome: BookingLifecycleOutcome = {
    clientId: meeting.clientId ?? null,
    createdLead: false,
    linkedMeeting: false,
    autoDealId: null,
  };

  let prospectClientId: string | null = null;
  let prospectFirmName: string | null = null;

  if (meeting.clientId) {
    const lifecycle = await advanceClientLifecycle(meeting.clientId, "session_booked", {
      source: "booking",
      reason: `Session booked${meeting.meetingTypeName ? `: ${meeting.meetingTypeName}` : ""}`,
    });
    if (lifecycle.client && lifecycle.client.lifecycleStage !== "customer") {
      prospectClientId = lifecycle.client.id;
      prospectFirmName = lifecycle.client.firmName;
    }
  } else if (meeting.inviteeEmail?.trim()) {
    const result = await matchOrCreateLeadClient({
      email: meeting.inviteeEmail,
      name: meeting.inviteeName,
      phone: null,
      initialStage: "session_booked",
      leadSource: "booking",
      changeSource: "booking",
      reason: `Session booked${meeting.meetingTypeName ? `: ${meeting.meetingTypeName}` : ""}`,
      // Task #4337 — normalized first-touch stamp from the meeting row's
      // raw capture (public booking page). Create-path only, immutable.
      firstTouch: deriveFirstTouch(meeting),
    });
    if (result) {
      outcome.clientId = result.client.id;
      outcome.createdLead = result.created;
      if (result.created) invalidateHardMatchIndexes();
      if (result.client.lifecycleStage !== "customer") {
        // Link the session to the lead so the record shows its meeting.
        await storage.updateScheduledMeeting(meeting.id, { clientId: result.client.id });
        outcome.linkedMeeting = true;
        prospectClientId = result.client.id;
        prospectFirmName = result.client.firmName;
      }
    }
  }

  if (prospectClientId) {
    outcome.autoDealId = await maybeAutoCreateDealForBooking(
      prospectClientId,
      prospectFirmName ?? "New lead",
      meeting,
    );
  }

  // Task #4332 — native booking deal trigger. Single seam covering both
  // scheduler confirm sites; replay-safe via booking_confirmed:<meetingId>.
  // Best-effort: a trigger failure must never fail the booking lifecycle.
  // Dynamic import keeps this module out of the trigger service's closure
  // (same sanctioned pattern as the stage-automation kick).
  try {
    const { emitBookingConfirmedTrigger } = await import("./dealTriggers");
    await emitBookingConfirmedTrigger({
      meetingId: meeting.id,
      meetingTypeName: meeting.meetingTypeName ?? null,
      clientId: outcome.clientId,
      autoDealId: outcome.autoDealId,
      createdLead: outcome.createdLead,
    });
  } catch (err) {
    console.error(
      `[LeadIntake] booking deal-trigger emit failed for meeting ${meeting.id}:`,
      err,
    );
  }

  return outcome;
}

/** Opt-in auto-deal for booked sessions. Returns the new deal id or null. */
async function maybeAutoCreateDealForBooking(
  clientId: string,
  firmName: string,
  meeting: ScheduledMeeting,
): Promise<string | null> {
  const enabledRow = await storage.getSystemSetting(LEADS_BOOKING_AUTO_DEAL_ENABLED_KEY);
  if (!isTruthySetting(enabledRow?.value)) return null;

  // The deal needs a creator/owner users-row: the hosting AM. Without one
  // (should not happen for confirmed bookings) we skip rather than invent
  // an actor.
  const actorId = meeting.accountManagerUserId;
  if (!actorId) {
    console.warn(`[LeadIntake] auto-deal skipped for meeting ${meeting.id}: no host AM user`);
    return null;
  }

  await ensureDefaultDealPipelineSeeded();
  const pipeline = await getDefaultPipeline();
  if (!pipeline) {
    console.error("[LeadIntake] auto-deal skipped: no default pipeline");
    return null;
  }

  // Dedupe: one open deal per prospect is enough — rebookings and
  // reschedules must not spawn deal spam.
  if (await hasOpenDealForClient(clientId)) return null;

  const stageRow = await resolveAutoDealStage(pipeline.id);
  if (!stageRow) return null;

  const deal = await createDeal({
    name: `${firmName} — ${meeting.meetingTypeName || "Session"}`,
    pipelineId: pipeline.id,
    stageId: stageRow.id,
    clientId,
    contactIds: [],
    amount: null,
    expectedCloseDate: null,
    ownerId: actorId,
    notes: `Auto-created from booked session (${meeting.startTimeUtc.toISOString()}).`,
    createdBy: actorId,
  });
  return deal.id;
}

async function resolveAutoDealStage(
  pipelineId: string,
): Promise<{ id: string } | null> {
  const slugRow = await storage.getSystemSetting(LEADS_BOOKING_AUTO_DEAL_STAGE_KEY);
  const wantSlug = slugRow?.value?.trim() || DEFAULT_AUTO_DEAL_STAGE_SLUG;

  const pipelines = await listPipelinesWithStages();
  const pipeline = pipelines.find((p) => p.id === pipelineId);
  if (!pipeline) return null;

  const bySlug = pipeline.stages.find((s) => s.slug === wantSlug && s.stageType === "open");
  if (bySlug) return { id: bySlug.id };

  // Misconfigured slug: fall back to the first open stage, loudly.
  const firstOpen = pipeline.stages.find((s) => s.stageType === "open");
  if (!firstOpen) {
    console.error(`[LeadIntake] auto-deal skipped: pipeline ${pipelineId} has no open stage`);
    return null;
  }
  console.warn(
    `[LeadIntake] auto-deal stage slug '${wantSlug}' not found/open in default pipeline — using '${firstOpen.slug}'`,
  );
  return { id: firstOpen.id };
}
