// Task #5297 — stage 3 of the "New Client Onboarding" epic: the combined
// intake-and-booking orchestration consumed by `server/routes/onboardingIntake.ts`.
//
// Sequences three writes that each have a different owning module:
//   1. Client creation (`createValidatedClient` — shared with `POST /api/clients`).
//   2. Meeting booking + assignee resolution (`bookOnboardingSlot` — stage 2,
//      `server/services/onboardingBooking.ts`).
//   3. Intel-feed entry from the sales rep's private call notes
//      (`storage.createIntelligenceFeedEntry`).
//
// Deliberately NOT one DB transaction: booking calls out to Zoom/Calendar and
// must never hold a transaction open across an external round-trip, and the
// task requires the client record to survive a booking failure (a
// recoverable, visible error) rather than disappearing with it. Each stage
// past client creation is allowed to fail independently; the caller reports
// exactly which stage failed and always includes the already-created
// `clientId` so the rep can resume manually from the client's page.
import { storage } from "../storage";
import { createValidatedClient } from "./clientIntake";
import {
  bookOnboardingSlot,
  OnboardingAssignmentError,
  ONBOARDING_MEETING_DURATION_MINUTES,
} from "./onboardingBooking";
import * as scheduler from "./bookingScheduler";
import { insertIntelligenceFeedEntrySchema } from "@shared/schema";
import type { Client } from "@shared/schema";
import type { InsertCommandPanel } from "@shared/models/commandCenter";

export interface OnboardingIntakeInput {
  rawClientBody: Record<string, any>;
  actingUserId: string;
  actingUserRole: string | null | undefined;
  contactEmail: string;
  contactName?: string;
  notes: string;
  startTimeUtc: Date;
  idempotencyKey?: string;
  commandPanelSetup: Pick<
    InsertCommandPanel,
    | "productTypes"
    | "googleAdsBudget"
    | "lsaBudget"
    | "webinarBudget"
    | "gbpPlannedLocationCount"
    | "gbpPlannedLocationCities"
  >;
}

export type OnboardingIntakeResult =
  | {
      ok: true;
      client: Client;
      resolvedUserId: string;
      resolvedUser: { id: string; name: string | null; email: string | null } | null;
      meeting: scheduler.BookingResult["meeting"];
      joinUrl: string | null;
      calendarEventUrl: string | null;
      intelEntry: { id: string } | null;
      intelWarning: string | null;
    }
  | {
      ok: false;
      stage: "client";
      status: number;
      body: Record<string, any>;
    }
  | {
      ok: false;
      stage: "command_panel" | "booking";
      status: number;
      body: Record<string, any>;
      clientId: string;
    };

/**
 * Runs the full intake sequence. Only the client-creation stage can leave
 * nothing behind on failure — every stage after it always reports the
 * already-created `clientId` in its error body so the caller can render a
 * "client saved, but…" recoverable error rather than a bare failure.
 */
export async function runOnboardingIntake(
  input: OnboardingIntakeInput,
): Promise<OnboardingIntakeResult> {
  const clientResult = await createValidatedClient({
    rawBody: input.rawClientBody,
    actingUserId: input.actingUserId,
    actingUserRole: input.actingUserRole,
    route: "/onboarding-intake",
  });
  if (!clientResult.ok) {
    return { ok: false, stage: "client", status: clientResult.status, body: clientResult.body };
  }
  const { client } = clientResult;

  try {
    await storage.upsertCommandPanel({
      clientId: client.id,
      productTypes: input.commandPanelSetup.productTypes,
      googleAdsBudget: input.commandPanelSetup.googleAdsBudget,
      lsaBudget: input.commandPanelSetup.lsaBudget,
      webinarBudget: input.commandPanelSetup.webinarBudget,
      gbpPlannedLocationCount: input.commandPanelSetup.gbpPlannedLocationCount,
      gbpPlannedLocationCities: input.commandPanelSetup.gbpPlannedLocationCities,
      lastUpdatedBy: input.actingUserId,
    });
  } catch (err: any) {
    console.error("[OnboardingIntake] Command Panel initialization failed:", err?.message ?? err);
    return {
      ok: false,
      stage: "command_panel",
      status: 500,
      clientId: client.id,
      body: {
        error:
          "The client was saved, but the product setup could not be initialized. Open the client to finish Command Panel setup.",
        code: "onboarding_setup_failed",
        clientId: client.id,
        clientCreated: true,
      },
    };
  }

  let bookingResult: Awaited<ReturnType<typeof bookOnboardingSlot>>;
  try {
    bookingResult = await bookOnboardingSlot({
      startTimeUtc: input.startTimeUtc,
      // Task #5297: the invitee IS the new client's contact — this booking
      // has no separate "meeting notes" field, and the sales notes below are
      // never passed here (that field becomes the Zoom agenda / calendar
      // description, which the client-invitee sees).
      invitee: { email: input.contactEmail, name: input.contactName },
      clientId: client.id,
      idempotencyKey: input.idempotencyKey,
      durationMinutes: ONBOARDING_MEETING_DURATION_MINUTES,
    });
  } catch (err) {
    if (err instanceof OnboardingAssignmentError) {
      return {
        ok: false,
        stage: "booking",
        status: 409,
        clientId: client.id,
        body: {
          error: err.message,
          code: "onboarding_assignment_failed",
          reason: err.reason,
          attempts: err.attempts,
          clientId: client.id,
          clientCreated: true,
        },
      };
    }
    if (err instanceof scheduler.BookingError) {
      return {
        ok: false,
        stage: "booking",
        status: bookingErrorStatus(err.code),
        clientId: client.id,
        body: {
          error: err.message,
          code: err.code,
          clientId: client.id,
          clientCreated: true,
        },
      };
    }
    throw err;
  }

  const resolvedUser = await storage.getUser(bookingResult.resolvedUserId);

  // The notes are the whole point of this tool for anyone opening the
  // client's Journal later — required at the request-validation boundary,
  // so this write should always succeed. It's still wrapped so a transient
  // DB error here degrades to a visible, actionable warning instead of
  // masking a fully successful client-and-meeting outcome as a total
  // failure (the client + meeting are already real by this point).
  let intelEntry: { id: string } | null = null;
  let intelWarning: string | null = null;
  try {
    const parsed = insertIntelligenceFeedEntrySchema.parse({
      clientId: client.id,
      createdBy: input.actingUserId,
      entryType: "meeting_takeaway",
      title: "Onboarding call notes",
      body: input.notes,
      status: "approved",
    });
    const created = await storage.createIntelligenceFeedEntry(parsed);
    intelEntry = { id: created.id };
  } catch (err: any) {
    console.error("[OnboardingIntake] Intel entry creation failed:", err?.message ?? err);
    intelWarning =
      "The client was created and the meeting was booked, but your notes could not be saved. Add them from the client's Intel feed.";
  }

  return {
    ok: true,
    client,
    resolvedUserId: bookingResult.resolvedUserId,
    resolvedUser: resolvedUser
      ? {
          id: resolvedUser.id,
          name: [resolvedUser.firstName, resolvedUser.lastName].filter(Boolean).join(" ") || null,
          email: resolvedUser.email ?? null,
        }
      : null,
    meeting: bookingResult.meeting,
    joinUrl: bookingResult.joinUrl,
    calendarEventUrl: bookingResult.calendarEventUrl,
    intelEntry,
    intelWarning,
  };
}

function bookingErrorStatus(code: scheduler.BookingError["code"]): number {
  switch (code) {
    case "slot_taken":
    case "slot_unavailable":
      return 409;
    case "invalid_input":
      return 400;
    case "not_found":
      return 404;
    case "zoom_failure":
    case "calendar_failure":
      return 502;
    default:
      return 500;
  }
}
