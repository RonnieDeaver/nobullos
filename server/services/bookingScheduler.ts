import crypto from "crypto";
import { storage } from "../storage";
import * as zoom from "./zoomIntegration";
import * as googleCalendar from "./googleCalendarIntegration";
import {
  isSlotAvailable,
  CalendarBusyUnavailableError,
  checkOccurrencesAvailability,
  formatInTimeZone,
  type RecurrenceConflict,
} from "./bookingAvailability";
import { expandRecurrence } from "./bookingRecurrence";
import { getBookingFeatureFlags } from "./bookingFeatureFlags";
import { sendEmail, isMailerConfigured } from "./mailer";
import type {
  BookingPage,
  BookingSource,
  ScheduledMeeting,
  InsertScheduledMeeting,
  NormalizedRecurrence,
  RecurrenceExceptionScope,
  ZoomRecurrenceMode,
  CleanAttribution,
} from "@shared/schema";

/**
 * Emit a structured observability event. We use the same
 * `console.log(JSON.stringify({ event, ...payload }))` pattern as the
 * Zoom and Google Calendar wrappers so log scrapers can `rg event=`
 * across all booking-saga sources uniformly.
 */
function emitEvent(event: string, payload: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ event, ...payload }));
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Recurrence-aware attendee notification adapter (Task #1039)
// ---------------------------------------------------------------------------

export type RecurringNotificationKind =
  | "recurring_created"
  | "recurring_canceled"
  | "recurring_edited";

export interface RecurringNotificationContext {
  meeting: ScheduledMeeting;
  scope?: RecurrenceExceptionScope;
  originalStartTime?: Date | null;
  occurrenceCount?: number;
  truncated?: boolean;
  recurrenceSummary?: string | null;
  recurrenceTimezone?: string | null;
  zoomRecurrenceMode?: ZoomRecurrenceMode | null;
  zoomFallbackReason?: string | null;
  joinUrl?: string | null;
  reason?: string | null;
}

function describeRecurrenceLine(ctx: RecurringNotificationContext): string {
  const parts: string[] = [];
  if (typeof ctx.occurrenceCount === "number") {
    parts.push(
      `${ctx.occurrenceCount} occurrence${ctx.occurrenceCount === 1 ? "" : "s"}${ctx.truncated ? " (capped)" : ""}`,
    );
  }
  if (ctx.recurrenceSummary) parts.push(ctx.recurrenceSummary);
  if (ctx.recurrenceTimezone) parts.push(`timezone: ${ctx.recurrenceTimezone}`);
  if (ctx.zoomRecurrenceMode === "static_link_fallback") {
    parts.push(
      `Zoom: shared join link (recurrence not natively representable${ctx.zoomFallbackReason ? `: ${ctx.zoomFallbackReason}` : ""})`,
    );
  } else if (ctx.zoomRecurrenceMode === "zoom_recurring") {
    parts.push("Zoom: native recurring meeting");
  }
  return parts.join(" · ");
}

function buildNotificationContent(
  kind: RecurringNotificationKind,
  ctx: RecurringNotificationContext,
): { subject: string; text: string } {
  const tz = ctx.recurrenceTimezone || ctx.meeting.timezone || "UTC";
  const localStart = (() => {
    try {
      return formatInTimeZone(
        ctx.meeting.startTimeUtc,
        tz,
        "EEE, MMM d yyyy 'at' h:mm a zzz",
      );
    } catch {
      return ctx.meeting.startTimeUtc.toISOString();
    }
  })();
  const recurrenceLine = describeRecurrenceLine(ctx);
  const occLine = ctx.originalStartTime
    ? `Occurrence: ${ctx.originalStartTime.toISOString()}\n`
    : "";
  const scopeLine = ctx.scope ? `Scope: ${ctx.scope}\n` : "";
  switch (kind) {
    case "recurring_created":
      return {
        subject: `Recurring meeting confirmed — ${localStart}`,
        text: `Your recurring meeting has been confirmed.

First occurrence: ${localStart}
${recurrenceLine ? `Recurrence: ${recurrenceLine}\n` : ""}${ctx.joinUrl ? `Join: ${ctx.joinUrl}\n` : ""}`,
      };
    case "recurring_canceled":
      return {
        subject:
          ctx.scope === "entire_series"
            ? `Recurring meeting series canceled`
            : `Meeting occurrence canceled`,
        text: `A recurring meeting was canceled.

${scopeLine}${occLine}${recurrenceLine ? `Recurrence: ${recurrenceLine}\n` : ""}${ctx.reason ? `Reason: ${ctx.reason}\n` : ""}`,
      };
    case "recurring_edited":
      return {
        subject: `Recurring meeting updated`,
        text: `A recurring meeting was updated.

${scopeLine}${occLine}${recurrenceLine ? `Recurrence: ${recurrenceLine}\n` : ""}${ctx.joinUrl ? `Join: ${ctx.joinUrl}\n` : ""}`,
      };
  }
}

/**
 * Recurrence-aware attendee notification dispatcher. Sends a transactional
 * email to the invitee (and CCs the host) using the shared mailer pipeline
 * already used by every other booking-side alert in the project. Failures
 * (mailer not configured, send error, etc.) are SURFACED to the caller via
 * a thrown error so the saga can record `notification_failed` against the
 * meeting and operators can locate partial-state cases — this is the
 * intentional contract per the #1032D done criteria.
 */
async function sendBookingNotification(
  kind: RecurringNotificationKind,
  ctx: RecurringNotificationContext,
): Promise<void> {
  const recipients: string[] = [];
  if (ctx.meeting.inviteeEmail) recipients.push(ctx.meeting.inviteeEmail);
  if (recipients.length === 0) {
    // No recipient — record as a structured event but don't throw; nothing
    // to dispatch.
    emitEvent("booking_notification_skipped_no_recipient", {
      meetingId: ctx.meeting.id,
      kind,
    });
    return;
  }
  if (!isMailerConfigured()) {
    // Mailer not configured on this environment. We still want operators
    // to be able to see partial states, so surface as a thrown error
    // (consistent with the "notifications failed" branch) but with a
    // dedicated reason so the operator log can distinguish "no mailer"
    // from "send failed".
    throw new Error("notification_unavailable: mailer not configured");
  }
  const { subject, text } = buildNotificationContent(kind, ctx);
  const result = await sendEmail({
    to: recipients,
    subject,
    text,
    logPrefix: `[BookingScheduler:${kind}]`,
  });
  if (!result.ok) {
    throw new Error(
      `notification_send_failed: ${result.reason}${"message" in result && result.message ? ` (${result.message})` : ""}`,
    );
  }
}

/**
 * Booking saga (Task #840).
 *
 * Reserves an availability slot, creates the Zoom scheduled meeting (type 2,
 * never PMI), creates the Google Calendar event, and records a confirmed
 * `scheduled_meetings` row. On any partial failure the previously created
 * external artifacts are rolled back and the local row is marked failed.
 *
 * Idempotency: callers may pass an `idempotencyKey` so retries (network
 * blips, double-clicks, replayed webhooks) collapse onto the same row.
 *
 * Concurrency: a per-AM Postgres advisory lock prevents two simultaneous
 * bookings from claiming the same slot. After the lock is held, availability
 * is recomputed against the latest DB state before insert.
 */

export interface BookHostInput {
  hostUserId: string;        // OS user id of the AM hosting the meeting
  // Email used to resolve the Zoom host when no override is set on the
  // user row. After Task #932 (929C) the saga loads the user via
  // `storage.getUser(hostUserId)` and runs `resolveEffectiveZoomHostForUser`
  // — the override (if any) wins over `hostEmail`. We keep this field
  // for compatibility with callers that don't have the user in scope,
  // but the override path makes it advisory only — and it is OPTIONAL
  // so an AM with no app email can still host via an override.
  hostEmail?: string | null;
  hostDisplayName?: string;
}

export interface BookInviteeInput {
  email: string;
  name?: string;
}

export interface BookingRequest {
  page: BookingPage;
  host: BookHostInput;
  invitee: BookInviteeInput;
  startTimeUtc: Date;
  source: BookingSource;
  clientId?: string | null;
  idempotencyKey?: string;
  notes?: string;
  /**
   * Skip Calendar busy lookup during availability recheck. Used when Calendar
   * is intentionally optional (e.g. AM hasn't connected one).
   */
  skipCalendar?: boolean;
  /**
   * Per-meeting overrides (Task #887). When the AM books internally for a
   * client they can pick a length / buffers different from whatever's
   * saved on their booking page. When omitted the page's stored values
   * are used. The same effective values are used for the pre-lock
   * availability re-check, the post-lock re-check, the saga's `endUtc`
   * computation, and the Zoom meeting duration so the second
   * `isSlotAvailable` check cannot reject the slot for a length
   * mismatch with the first.
   */
  durationMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  /**
   * Optional saved meeting type used for this booking (Task #890). The
   * id is persisted on the row so the meetings list can show which
   * preset was used; the name is denormalized so it survives later
   * rename/delete of the meeting-type row.
   */
  meetingTypeId?: string | null;
  meetingTypeName?: string | null;
  /**
   * Optional normalized recurrence payload (Task #1039). When present
   * the saga creates a recurring series instead of a one-off meeting.
   * Callers MUST pass the result of `validateRecurrencePayload(...)` —
   * the saga does not re-validate.
   */
  recurrence?: NormalizedRecurrence;
  /**
   * Task #4337 — first-touch UTM/referrer captured by the PUBLIC booking
   * page at confirm time (already cleaned: "" → null). Persisted raw on the
   * meeting row; the lead-intake lifecycle hook normalizes it into the
   * client's immutable first-touch stamp. Internal/staff bookings omit it.
   */
  attribution?: CleanAttribution;
}

export interface BookingResult {
  meeting: ScheduledMeeting;
  joinUrl: string | null;
  startUrl: string | null;
  calendarEventUrl: string | null;
  /** Populated when the booking is part of a recurring series. */
  recurrence?: {
    occurrenceCount: number;
    truncated: boolean;
    summary?: string | null;
    timezone: string;
    zoomMode: ZoomRecurrenceMode;
    zoomFallbackReason?: string | null;
  };
}

export class BookingError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "slot_taken"
      | "slot_unavailable"
      | "invalid_input"
      | "zoom_failure"
      | "calendar_failure"
      | "internal_failure"
      | "recurrence_invalid"
      | "recurrence_conflicts"
      | "recurrence_expansion_failed"
      // Task #1044: thrown when a `system_settings` kill-switch
      // (`booking_recurring_enabled` master, or
      // `booking_recurring_edit_scopes_enabled` for PATCH/DELETE on
      // a recurring meeting) administratively disables the recurrence
      // saga. Routes map this to HTTP 403.
      | "recurrence_disabled"
      | "not_found",
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "BookingError";
  }
}

/**
 * Run the booking saga end-to-end.
 */
export async function bookSlot(req: BookingRequest): Promise<BookingResult> {
  // Recurring branch: when a normalized recurrence payload is supplied,
  // delegate to the recurrence-aware saga. One-off bookings (no
  // `recurrence` field) continue down the existing single-occurrence
  // path unchanged so existing callers see no behavior change.
  if (req.recurrence) {
    return bookRecurringSlot(req, req.recurrence);
  }
  // 1) Idempotency dedupe — if a row already exists for this key, return it.
  if (req.idempotencyKey) {
    const existing = await storage.getScheduledMeetingByIdempotencyKey(
      req.idempotencyKey,
    );
    if (existing && existing.status === "confirmed") {
      return {
        meeting: existing,
        joinUrl: existing.zoomJoinUrl,
        startUrl: existing.zoomStartUrl,
        calendarEventUrl: existing.googleCalendarEventUrl,
      };
    }
    if (existing && existing.status === "creating") {
      throw new BookingError(
        "A booking with this idempotency key is already in flight",
        "internal_failure",
      );
    }
    // If existing status is failed/canceled, fall through to retry.
  }

  // 2) Validate basic inputs. Note: `req.host.hostEmail` is NOT
  //    required after Task #932 (929C) — the canonical resolver in
  //    step 6 will use a per-user Zoom host override when the AM has
  //    no app email but has explicitly mapped a Zoom user.
  if (!req.invitee.email) {
    throw new BookingError("Missing invitee email", "invalid_input");
  }
  const startUtc = new Date(req.startTimeUtc);
  if (Number.isNaN(startUtc.getTime())) {
    throw new BookingError("Invalid start time", "invalid_input");
  }

  // Per-meeting overrides win over the page defaults. The same effective
  // page is used for both pre-lock and post-lock availability re-checks
  // and for `endUtc`, so a slot that's bookable in the slot list cannot
  // be rejected by the second check for a length mismatch (Task #887).
  const effectivePage: BookingPage = {
    ...req.page,
    durationMinutes:
      typeof req.durationMinutes === "number"
        ? req.durationMinutes
        : req.page.durationMinutes,
    bufferBeforeMinutes:
      typeof req.bufferBeforeMinutes === "number"
        ? req.bufferBeforeMinutes
        : req.page.bufferBeforeMinutes,
    bufferAfterMinutes:
      typeof req.bufferAfterMinutes === "number"
        ? req.bufferAfterMinutes
        : req.page.bufferAfterMinutes,
  };
  const duration = effectivePage.durationMinutes;
  const endUtc = new Date(startUtc.getTime() + duration * 60_000);

  // 3) Recompute availability with the live DB / Calendar state. The slot
  //    must still be free at the moment of booking. We treat a
  //    `CalendarBusyUnavailableError` as a fail-closed condition — if the
  //    AM is connected but Google free/busy is unreachable, we cannot
  //    safely confirm the slot doesn't overlap a real busy interval, so
  //    we refuse the booking with `calendar_failure` rather than risking
  //    a double-booking over an opaque calendar conflict.
  let stillFree: boolean;
  try {
    stillFree = await isSlotAvailable(effectivePage, startUtc, {
      skipCalendar: req.skipCalendar,
    });
  } catch (err: any) {
    if (err instanceof CalendarBusyUnavailableError) {
      throw new BookingError(
        "Could not verify the host's Google Calendar free/busy state. The booking has been refused to avoid scheduling over an existing event. Please try again in a moment.",
        "calendar_failure",
      );
    }
    throw err;
  }
  if (!stillFree) {
    throw new BookingError(
      "The selected time is no longer available. Please pick another slot.",
      "slot_unavailable",
    );
  }

  // 4) Acquire a Postgres advisory lock keyed on the AM. This prevents two
  //    simultaneous bookings against the same AM from racing past the
  //    availability re-check.
  const lockKey = stableLockKey(req.host.hostUserId);
  return await withAdvisoryLock(lockKey, async () => {
    // Re-check after lock acquisition (TOCTOU guard). Same fail-closed
    // semantics for `CalendarBusyUnavailableError` as the pre-lock check
    // above — a transient Google outage between the two reads must not
    // promote a busy interval into a bookable slot.
    let stillFree2: boolean;
    try {
      stillFree2 = await isSlotAvailable(effectivePage, startUtc, {
        skipCalendar: req.skipCalendar,
      });
    } catch (err: any) {
      if (err instanceof CalendarBusyUnavailableError) {
        throw new BookingError(
          "Could not verify the host's Google Calendar free/busy state. The booking has been refused to avoid scheduling over an existing event. Please try again in a moment.",
          "calendar_failure",
        );
      }
      throw err;
    }
    if (!stillFree2) {
      throw new BookingError(
        "The selected time was just booked by someone else. Please pick another slot.",
        "slot_taken",
      );
    }
    // Cross-page guard: also ensure there isn't another OS-booked meeting
    // for this AM that overlaps. (computeAvailableSlots already checks this
    // for the page's own bookings, but the AM may host multiple pages.)
    const overlapping = await storage.listOverlappingScheduledMeetingsForAm(
      req.host.hostUserId,
      startUtc,
      endUtc,
    );
    if (overlapping.length > 0) {
      throw new BookingError(
        "The selected time conflicts with another booking on this account manager.",
        "slot_taken",
      );
    }

    return await createBookingTransactional(req, effectivePage, startUtc, endUtc);
  });
}

/** Task #4337 — raw first-touch UTM/referrer columns for a new meeting row. */
function attributionColumns(
  attribution: CleanAttribution | undefined,
): Pick<
  InsertScheduledMeeting,
  "utmSource" | "utmMedium" | "utmCampaign" | "utmTerm" | "utmContent" | "referrer"
> {
  return {
    utmSource: attribution?.utmSource ?? null,
    utmMedium: attribution?.utmMedium ?? null,
    utmCampaign: attribution?.utmCampaign ?? null,
    utmTerm: attribution?.utmTerm ?? null,
    utmContent: attribution?.utmContent ?? null,
    referrer: attribution?.referrer ?? null,
  };
}

async function createBookingTransactional(
  req: BookingRequest,
  effectivePage: BookingPage,
  startUtc: Date,
  endUtc: Date,
): Promise<BookingResult> {
  // 5) Insert the local row in `creating` state. The unique partial index on
  //    idempotency_key means a duplicate concurrent caller will collide here
  //    rather than create a second Zoom meeting.
  let pending: ScheduledMeeting;
  try {
    pending = await storage.createScheduledMeeting({
      clientId: req.clientId ?? null,
      accountManagerUserId: req.host.hostUserId,
      bookingPageId: req.page.id,
      bookingSource: req.source,
      inviteeName: req.invitee.name ?? null,
      inviteeEmail: req.invitee.email,
      startTimeUtc: startUtc,
      endTimeUtc: endUtc,
      timezone: req.page.timezone,
      status: "creating",
      idempotencyKey: req.idempotencyKey ?? null,
      meetingTypeId: req.meetingTypeId ?? null,
      meetingTypeName: req.meetingTypeName ?? null,
      ...attributionColumns(req.attribution),
    });
  } catch (err: any) {
    // Idempotency unique-violation → return the winning row if it confirmed.
    if (req.idempotencyKey && /idempotency/i.test(err?.message || "")) {
      const winner = await storage.getScheduledMeetingByIdempotencyKey(
        req.idempotencyKey,
      );
      if (winner && winner.status === "confirmed") {
        return {
          meeting: winner,
          joinUrl: winner.zoomJoinUrl,
          startUrl: winner.zoomStartUrl,
          calendarEventUrl: winner.googleCalendarEventUrl,
        };
      }
    }
    throw new BookingError(
      `Failed to record pending booking: ${err.message || err}`,
      "internal_failure",
    );
  }

  // 6) Resolve the effective Zoom host for this AM via the canonical
  //    resolver (Task #932 / 929C). This is the SINGLE point at which
  //    the booking saga decides which Zoom user owns the meeting:
  //      - If the AM has a validated per-user override, it wins.
  //      - Otherwise we fall back to the AM's app-login email.
  //      - If neither produces a Zoom user we refuse the booking with
  //        a clear `zoom_failure` so the AM is told to set an override.
  //    This guarantees readiness (`/api/booking/me/readiness`) and the
  //    saga can never disagree about the host identity.
  // Distinguish "user row missing" (a host-resolution failure that
  // belongs in `zoom_failure`) from a transient DB read failure (an
  // infra problem that belongs in `internal_failure`). Swallowing both
  // as `zoom_failure` would mislead operators investigating a flaky
  // database into thinking they had a Zoom mapping problem.
  let hostUser: Awaited<ReturnType<typeof storage.getUser>> | null;
  try {
    hostUser = (await storage.getUser(req.host.hostUserId)) || null;
  } catch (err: any) {
    await storage.updateScheduledMeeting(pending.id, {
      status: "failed",
      failureReason: `Host user lookup failed: ${err?.message || err}`.slice(0, 1000),
    });
    throw new BookingError(
      `Could not load host account to resolve Zoom host: ${err?.message || err}`,
      "internal_failure",
    );
  }
  const effectiveHost = await zoom.resolveEffectiveZoomHostForUser(hostUser);
  if (effectiveHost.source === "none" || !effectiveHost.zoomEmail) {
    await storage.updateScheduledMeeting(pending.id, {
      status: "failed",
      failureReason: `Zoom host unresolved: ${effectiveHost.error || "no effective Zoom user for this account"}`.slice(0, 1000),
    });
    throw new BookingError(
      `Could not resolve a Zoom host for this account: ${effectiveHost.error || "no Zoom user mapped"}. Set a Zoom host override in Booking settings.`,
      "zoom_failure",
    );
  }

  // Create the Zoom meeting. Save ids onto the row immediately so we can
  //    delete it during compensation even if the process dies.
  let zoomMeeting: zoom.CreatedZoomMeeting;
  try {
    zoomMeeting = await zoom.createScheduledMeeting({
      hostEmail: effectiveHost.zoomEmail,
      topic: buildTopic(req),
      startTimeUtc: startUtc,
      durationMinutes: effectivePage.durationMinutes,
      timezone: effectivePage.timezone,
      agenda: req.notes,
      inviteeEmail: req.invitee.email,
      inviteeName: req.invitee.name,
    });
  } catch (err: any) {
    await storage.updateScheduledMeeting(pending.id, {
      status: "failed",
      failureReason: `Zoom create failed: ${err.message || err}`.slice(0, 1000),
    });
    throw new BookingError(
      `Could not create Zoom meeting: ${err.message || err}`,
      "zoom_failure",
    );
  }

  await storage.updateScheduledMeeting(pending.id, {
    zoomMeetingId: zoomMeeting.id,
    zoomMeetingUuid: zoomMeeting.uuid,
    zoomJoinUrl: zoomMeeting.joinUrl,
    zoomStartUrl: zoomMeeting.startUrl,
  });

  // 7) Create Google Calendar event. The whole point of this feature is a
  // deterministic Zoom-meeting → Calendar-event → client chain, so the
  // Calendar event is REQUIRED — not best-effort. If the AM doesn't have
  // a connected Calendar (or OAuth isn't configured server-side), we
  // refuse the booking with a clear, actionable error and roll back the
  // Zoom meeting we just created so we don't leak orphaned resources.
  let calendarEventUrl: string | null = null;
  let calendarEventId: string | null = null;
  let calendarId: string | null = null;
  const credential = await storage
    .getGoogleCalendarCredential(req.host.hostUserId)
    .catch(() => null);
  const calendarConfigured = googleCalendar.isGoogleCalendarConfigured();
  const hasCalendar =
    !!credential && credential.status === "connected" && calendarConfigured;

  if (!hasCalendar) {
    await safeDeleteZoom(zoomMeeting.id);
    const reason = !calendarConfigured
      ? "Google Calendar OAuth is not configured on this server."
      : !credential
        ? "The host has not connected their Google Calendar."
        : `The host's Google Calendar credential is in state "${credential.status}" — they need to reconnect.`;
    await safeMarkRowFailed(
      pending.id,
      `Calendar prerequisite missing: ${reason}`,
    );
    throw new BookingError(
      `Cannot book — ${reason}`,
      "calendar_failure",
    );
  }

  if (credential) {
    try {
      const event = await googleCalendar.insertEvent(
        req.host.hostUserId,
        credential.calendarId || "primary",
        {
          summary: buildTopic(req),
          description: buildEventDescription(req, zoomMeeting.joinUrl),
          startUtc,
          endUtc,
          timezone: req.page.timezone,
          location: zoomMeeting.joinUrl,
          attendees: [
            { email: req.invitee.email, displayName: req.invitee.name },
          ],
          // Google Calendar email reminders for this event: one an hour
          // before and one ten minutes before. Per Google's API, reminder
          // overrides apply to the *calendar owner* (the host) — Google
          // itself doesn't send reminder emails to attendees on the
          // organizer's behalf; invitees rely on their own calendar's
          // reminder settings once they accept the invite.
          reminderOverrides: [
            { method: "email", minutes: 60 },
            { method: "email", minutes: 10 },
          ],
        },
      );
      calendarEventUrl = event.htmlLink;
      calendarEventId = event.id;
      calendarId = credential.calendarId || "primary";
    } catch (err: any) {
      // Compensation: delete the Zoom meeting we just created.
      await safeDeleteZoom(zoomMeeting.id);
      await storage.updateScheduledMeeting(pending.id, {
        status: "failed",
        failureReason: `Calendar create failed: ${err.message || err}`.slice(0, 1000),
        zoomMeetingId: null,
        zoomMeetingUuid: null,
        zoomJoinUrl: null,
        zoomStartUrl: null,
      });
      throw new BookingError(
        `Could not create Google Calendar event: ${err.message || err}`,
        "calendar_failure",
      );
    }
  }

  // 8) Mark confirmed. If the DB write fails (or the row vanished), we MUST
  // roll back the external artifacts we just created — otherwise we leave an
  // orphaned Zoom meeting + Calendar event with no DB anchor.
  let confirmed: ScheduledMeeting | undefined;
  try {
    confirmed = await storage.updateScheduledMeeting(pending.id, {
      status: "confirmed",
      googleCalendarEventId: calendarEventId,
      googleCalendarEventUrl: calendarEventUrl,
      googleCalendarId: calendarId,
      zoomHostUserId: zoomMeeting.raw?.host_id || null,
    });
  } catch (err: any) {
    await safeDeleteCalendarEvent(
      req.host.hostUserId,
      calendarId,
      calendarEventId,
    );
    await safeDeleteZoom(zoomMeeting.id);
    await safeMarkRowFailed(
      pending.id,
      `Booking confirmation update failed: ${err?.message || err}`,
    );
    throw new BookingError(
      `Booking confirmation update failed: ${err?.message || err}`,
      "internal_failure",
    );
  }

  if (!confirmed) {
    await safeDeleteCalendarEvent(
      req.host.hostUserId,
      calendarId,
      calendarEventId,
    );
    await safeDeleteZoom(zoomMeeting.id);
    await safeMarkRowFailed(
      pending.id,
      "Booking row vanished during confirmation",
    );
    throw new BookingError(
      "Booking row vanished during confirmation",
      "internal_failure",
    );
  }

  // Task #1688 — Per-user inbox: ping the host AM that a booking just
  // landed on their calendar. Best-effort; never blocks the saga.
  if (confirmed.accountManagerUserId) {
    try {
      const { notifyUser } = await import("./notifications/userInbox");
      await notifyUser(confirmed.accountManagerUserId, {
        category: "booking",
        title: `New booking: ${req.invitee.email}`,
        body: `${confirmed.startTimeUtc.toISOString()} — ${req.invitee.name ?? req.invitee.email}`,
        deepLink: `/booking/meetings/${confirmed.id}`,
        dedupeKey: `booking-created:${confirmed.id}`,
        metadata: {
          meetingId: confirmed.id,
          clientId: confirmed.clientId ?? null,
          source: req.source,
        },
      });
    } catch (err: any) {
      console.warn("[BookingScheduler] notifyUser (created) failed:", err?.message ?? err);
    }
  }

  // Task #4330 — lead lifecycle: a confirmed session advances (or creates)
  // the invitee's lead record; optional settings-gated auto-deal. Best-effort
  // — the booking saga's outcome never depends on lifecycle bookkeeping.
  try {
    const { handleBookingConfirmedForLifecycle } = await import("./leadIntake");
    await handleBookingConfirmedForLifecycle(confirmed);
  } catch (err: any) {
    console.error("[BookingScheduler] lead lifecycle hook failed:", err?.message ?? err);
  }

  return {
    meeting: confirmed,
    joinUrl: zoomMeeting.joinUrl,
    startUrl: zoomMeeting.startUrl,
    calendarEventUrl,
  };
}

// ---------------------------------------------------------------------------
// cancelBooking — supports both the legacy positional form (one-off cancel)
// and the recurrence-aware object form with scope semantics (Task #1039).
// ---------------------------------------------------------------------------

export interface CancelBookingOptions {
  meetingId: string;
  scope?: RecurrenceExceptionScope;
  /** Required for `this_event` and `this_and_following`. */
  originalStartTime?: Date;
  sendUpdates?: googleCalendar.CalendarSendUpdates;
  reason?: string;
  actorUserId?: string | null;
}

export async function cancelBooking(
  meetingId: string,
  reason?: string,
): Promise<ScheduledMeeting | undefined>;
export async function cancelBooking(
  options: CancelBookingOptions,
): Promise<ScheduledMeeting | undefined>;
export async function cancelBooking(
  meetingIdOrOptions: string | CancelBookingOptions,
  legacyReason?: string,
): Promise<ScheduledMeeting | undefined> {
  const opts: CancelBookingOptions =
    typeof meetingIdOrOptions === "string"
      ? { meetingId: meetingIdOrOptions, reason: legacyReason }
      : meetingIdOrOptions;

  const m = await storage.getScheduledMeetingById(opts.meetingId);
  if (!m) return undefined;

  // The "master" (or the one-off itself) is the row that owns the Google
  // recurringEventId / Zoom meeting id. For a child row of a series, walk
  // up to the master so all per-series operations use the canonical row.
  const master = m.seriesMasterId
    ? (await storage.getScheduledMeetingById(m.seriesMasterId)) || m
    : m;
  const isRecurring = !!master.recurringEventId || (master.recurrence?.length ?? 0) > 0;
  const scope: RecurrenceExceptionScope =
    opts.scope ?? (isRecurring ? "entire_series" : "entire_series");
  const sendUpdates = opts.sendUpdates ?? "all";

  // Task #1044: cancel orchestrator gate. Only blocks recurring
  // cancels — one-off cancellation must always work even if the
  // recurrence feature is administratively disabled.
  if (isRecurring) {
    const flags = await getBookingFeatureFlags();
    if (!flags.master || !flags.editScopes) {
      emitEvent("recurring_booking_rejected_disabled", {
        meetingId: master.id,
        flow: "cancel",
        scope,
        flag: !flags.master
          ? "booking_recurring_enabled"
          : "booking_recurring_edit_scopes_enabled",
      });
      throw new BookingError(
        "Recurring meeting edit/cancel is currently disabled by an administrator.",
        "recurrence_disabled",
        {
          flag: !flags.master
            ? "booking_recurring_enabled"
            : "booking_recurring_edit_scopes_enabled",
          flow: "cancel",
        },
      );
    }
  }

  // Non-recurring (one-off) — preserve the original behavior. Any scope
  // other than `entire_series` is meaningless here and treated as
  // entire_series.
  if (!isRecurring) {
    if (m.status === "canceled") return m;
    if (m.googleCalendarEventId && m.accountManagerUserId && m.googleCalendarId) {
      try {
        await googleCalendar.deleteEvent(
          m.accountManagerUserId,
          m.googleCalendarId,
          m.googleCalendarEventId,
        );
      } catch (err: any) {
        console.warn(
          `[BookingScheduler] Calendar delete failed for ${m.id}: ${err.message || err}`,
        );
      }
    }
    if (m.zoomMeetingId) {
      await safeDeleteZoom(m.zoomMeetingId);
    }
    const updated = await storage.updateScheduledMeeting(m.id, {
      status: "canceled",
      failureReason: opts.reason ? opts.reason.slice(0, 1000) : null,
    });

    // Task #1688 — Per-user inbox: notify the booking host that the
    // meeting was canceled. Best-effort.
    if (updated?.accountManagerUserId) {
      try {
        const { notifyUser } = await import("./notifications/userInbox");
        await notifyUser(updated.accountManagerUserId, {
          category: "booking",
          title: `Booking canceled: ${updated.inviteeEmail ?? "(unknown invitee)"}`,
          body: `${updated.startTimeUtc.toISOString()}${opts.reason ? ` — ${opts.reason}` : ""}`,
          deepLink: `/booking/meetings/${updated.id}`,
          dedupeKey: `booking-canceled:${updated.id}`,
          metadata: {
            meetingId: updated.id,
            clientId: updated.clientId ?? null,
            reason: opts.reason ?? null,
          },
        });
      } catch (err: any) {
        console.warn("[BookingScheduler] notifyUser (canceled) failed:", err?.message ?? err);
      }
    }
    return updated;
  }

  // ---- Recurring series cancel paths --------------------------------------
  emitEvent("recurring_booking_cancel_by_scope", {
    meetingId: master.id,
    scope,
    originalStartTime: opts.originalStartTime?.toISOString() ?? null,
    recurringEventId: master.recurringEventId ?? null,
    zoomRecurrenceMode: master.zoomRecurrenceMode ?? null,
  });

  if (scope === "this_event") {
    if (!opts.originalStartTime) {
      throw new BookingError(
        "originalStartTime is required for scope=this_event",
        "invalid_input",
      );
    }
    if (
      master.recurringEventId &&
      master.googleCalendarId &&
      master.accountManagerUserId
    ) {
      try {
        await googleCalendar.deleteEvent(master.accountManagerUserId, {
          calendarId: master.googleCalendarId,
          eventId: master.recurringEventId,
          scope: "this_event",
          originalStartTime: opts.originalStartTime,
          sendUpdates,
        });
      } catch (err: any) {
        emitEvent("recurring_booking_compensation_required", {
          meetingId: master.id,
          step: "google_instance_cancel",
          error: err?.message || String(err),
        });
        throw new BookingError(
          `Google Calendar instance cancel failed: ${err?.message || err}`,
          "calendar_failure",
        );
      }
    }
    // DB exception row — Google Calendar is the source of truth for
    // per-instance state per the epic; Zoom recurring meetings keep all
    // their occurrences even when one is cancelled in Google.
    try {
      await storage.upsertMeetingRecurrenceException({
        seriesMasterId: master.id,
        scheduledMeetingId: master.id,
        recurringEventId: master.recurringEventId ?? null,
        originalStartTime: opts.originalStartTime,
        exceptionType: "canceled",
        reason: opts.reason ?? null,
        createdByUserId: opts.actorUserId ?? null,
      });
    } catch (err: any) {
      emitEvent("recurring_booking_compensation_required", {
        meetingId: master.id,
        step: "exception_persist",
        error: err?.message || String(err),
        notice:
          "Google instance was cancelled but DB exception row could not be written — manual reconciliation needed.",
      });
      throw new BookingError(
        `Could not record recurrence exception: ${err?.message || err}`,
        "internal_failure",
      );
    }
    try {
      await sendBookingNotification("recurring_canceled", {
        meeting: master,
        scope,
        originalStartTime: opts.originalStartTime,
        recurrenceSummary: master.recurrenceSummary,
        recurrenceTimezone: master.recurrenceTimezone,
        zoomRecurrenceMode: (master.zoomRecurrenceMode as ZoomRecurrenceMode) ?? null,
        zoomFallbackReason: master.zoomRecurrenceFallbackReason,
        reason: opts.reason ?? null,
      });
    } catch (err: any) {
      emitEvent("notification_failed", {
        meetingId: master.id,
        kind: "recurring_canceled",
        error: err?.message || String(err),
      });
    }
    return master;
  }

  if (scope === "this_and_following") {
    if (!opts.originalStartTime) {
      throw new BookingError(
        "originalStartTime is required for scope=this_and_following",
        "invalid_input",
      );
    }
    if (
      master.recurringEventId &&
      master.googleCalendarId &&
      master.accountManagerUserId
    ) {
      try {
        await googleCalendar.deleteEvent(master.accountManagerUserId, {
          calendarId: master.googleCalendarId,
          eventId: master.recurringEventId,
          scope: "this_and_following",
          originalStartTime: opts.originalStartTime,
          sendUpdates,
        });
      } catch (err: any) {
        emitEvent("recurring_booking_compensation_required", {
          meetingId: master.id,
          step: "google_truncate",
          error: err?.message || String(err),
        });
        throw new BookingError(
          `Google Calendar series truncate failed: ${err?.message || err}`,
          "calendar_failure",
        );
      }
    }
    try {
      await storage.upsertMeetingRecurrenceException({
        seriesMasterId: master.id,
        scheduledMeetingId: master.id,
        recurringEventId: master.recurringEventId ?? null,
        originalStartTime: opts.originalStartTime,
        exceptionType: "canceled",
        reason:
          (opts.reason ? opts.reason + " " : "") +
          "[this_and_following truncate]",
        createdByUserId: opts.actorUserId ?? null,
      });
    } catch (err: any) {
      emitEvent("recurring_booking_compensation_required", {
        meetingId: master.id,
        step: "exception_persist",
        error: err?.message || String(err),
        notice:
          "Google series was truncated but DB exception row could not be written — manual reconciliation needed.",
      });
      throw new BookingError(
        `Could not record recurrence exception: ${err?.message || err}`,
        "internal_failure",
      );
    }
    try {
      await sendBookingNotification("recurring_canceled", {
        meeting: master,
        scope,
        originalStartTime: opts.originalStartTime,
        recurrenceSummary: master.recurrenceSummary,
        recurrenceTimezone: master.recurrenceTimezone,
        zoomRecurrenceMode: (master.zoomRecurrenceMode as ZoomRecurrenceMode) ?? null,
        zoomFallbackReason: master.zoomRecurrenceFallbackReason,
        reason: opts.reason ?? null,
      });
    } catch (err: any) {
      emitEvent("notification_failed", {
        meetingId: master.id,
        kind: "recurring_canceled",
        error: err?.message || String(err),
      });
    }
    return master;
  }

  // scope === "entire_series"
  if (master.status === "canceled") return master;
  if (
    master.recurringEventId &&
    master.googleCalendarId &&
    master.accountManagerUserId
  ) {
    try {
      await googleCalendar.deleteEvent(master.accountManagerUserId, {
        calendarId: master.googleCalendarId,
        eventId: master.recurringEventId,
        scope: "entire_series",
        sendUpdates,
      });
    } catch (err: any) {
      console.warn(
        `[BookingScheduler] Calendar series delete failed for ${master.id}: ${err.message || err}`,
      );
      emitEvent("recurring_booking_compensation_required", {
        meetingId: master.id,
        step: "google_series_delete",
        error: err?.message || String(err),
      });
    }
  }
  if (master.zoomMeetingId) {
    await safeDeleteZoom(master.zoomMeetingId);
  }
  const updated = await storage.updateScheduledMeeting(master.id, {
    status: "canceled",
    failureReason: opts.reason ? opts.reason.slice(0, 1000) : null,
  });
  try {
    await sendBookingNotification("recurring_canceled", {
      meeting: updated || master,
      scope: "entire_series",
      recurrenceSummary: master.recurrenceSummary,
      recurrenceTimezone: master.recurrenceTimezone,
      zoomRecurrenceMode: (master.zoomRecurrenceMode as ZoomRecurrenceMode) ?? null,
      zoomFallbackReason: master.zoomRecurrenceFallbackReason,
      reason: opts.reason ?? null,
    });
  } catch (err: any) {
    emitEvent("notification_failed", {
      meetingId: master.id,
      kind: "recurring_canceled",
      error: err?.message || String(err),
    });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// editBooking — Task #1039 recurrence-aware edit orchestrator
// ---------------------------------------------------------------------------

export interface EditBookingChanges {
  startTimeUtc?: Date;
  endTimeUtc?: Date;
  durationMinutes?: number;
  timezone?: string;
  summary?: string;
  description?: string;
  location?: string;
  attendees?: Array<{ email: string; displayName?: string }>;
  /**
   * Replace the master's RRULE/EXDATE/RDATE lines (entire_series and
   * this_and_following only). Caller is responsible for supplying an
   * already-validated normalized recurrence.
   */
  recurrence?: NormalizedRecurrence;
  reminderOverrides?: Array<{ method: "email" | "popup"; minutes: number }>;
}

export interface EditBookingOptions {
  meetingId: string;
  scope: RecurrenceExceptionScope;
  /** Required for `this_event` and `this_and_following`. */
  originalStartTime?: Date;
  changes: EditBookingChanges;
  sendUpdates?: googleCalendar.CalendarSendUpdates;
  actorUserId?: string | null;
}

export interface EditBookingResult {
  master: ScheduledMeeting;
  /** New sibling master created by `this_and_following` splits. */
  newMaster?: ScheduledMeeting;
}

export async function editBooking(
  options: EditBookingOptions,
): Promise<EditBookingResult> {
  const m = await storage.getScheduledMeetingById(options.meetingId);
  if (!m) {
    throw new BookingError(`Meeting ${options.meetingId} not found`, "not_found");
  }
  const master = m.seriesMasterId
    ? (await storage.getScheduledMeetingById(m.seriesMasterId)) || m
    : m;
  const sendUpdates = options.sendUpdates ?? "all";
  const scope = options.scope;

  // Task #1044: edit orchestrator gate. Only fires for meetings that
  // are part of a recurring series — editing a one-off must always
  // work even with the recurrence feature off.
  const isRecurringEdit =
    !!master.recurringEventId || (master.recurrence?.length ?? 0) > 0;
  if (isRecurringEdit) {
    const flags = await getBookingFeatureFlags();
    if (!flags.master || !flags.editScopes) {
      emitEvent("recurring_booking_rejected_disabled", {
        meetingId: master.id,
        flow: "edit",
        scope,
        flag: !flags.master
          ? "booking_recurring_enabled"
          : "booking_recurring_edit_scopes_enabled",
      });
      throw new BookingError(
        "Recurring meeting edit/cancel is currently disabled by an administrator.",
        "recurrence_disabled",
        {
          flag: !flags.master
            ? "booking_recurring_enabled"
            : "booking_recurring_edit_scopes_enabled",
          flow: "edit",
        },
      );
    }
  }

  emitEvent("recurring_booking_edit_by_scope", {
    meetingId: master.id,
    scope,
    originalStartTime: options.originalStartTime?.toISOString() ?? null,
    recurringEventId: master.recurringEventId ?? null,
  });

  if (scope === "this_event") {
    if (!options.originalStartTime) {
      throw new BookingError(
        "originalStartTime is required for scope=this_event",
        "invalid_input",
      );
    }
    if (
      !master.recurringEventId ||
      !master.googleCalendarId ||
      !master.accountManagerUserId
    ) {
      throw new BookingError(
        "Cannot edit a single instance: master has no Google Calendar recurring event",
        "calendar_failure",
      );
    }
    try {
      await googleCalendar.updateInstance({
        userId: master.accountManagerUserId,
        calendarId: master.googleCalendarId,
        recurringEventId: master.recurringEventId,
        originalStartTime: options.originalStartTime,
        changes: {
          summary: options.changes.summary,
          description: options.changes.description,
          startUtc: options.changes.startTimeUtc,
          endUtc: options.changes.endTimeUtc,
          timezone: options.changes.timezone,
          location: options.changes.location,
          attendees: options.changes.attendees,
          reminderOverrides: options.changes.reminderOverrides,
        },
        sendUpdates,
      });
    } catch (err: any) {
      emitEvent("recurring_booking_compensation_required", {
        meetingId: master.id,
        step: "google_instance_update",
        error: err?.message || String(err),
      });
      throw new BookingError(
        `Google Calendar instance update failed: ${err?.message || err}`,
        "calendar_failure",
      );
    }
    try {
      await storage.upsertMeetingRecurrenceException({
        seriesMasterId: master.id,
        scheduledMeetingId: master.id,
        recurringEventId: master.recurringEventId,
        originalStartTime: options.originalStartTime,
        exceptionType: "rescheduled",
        overrideStartTimeUtc: options.changes.startTimeUtc ?? null,
        overrideEndTimeUtc: options.changes.endTimeUtc ?? null,
        overrideTimezone: options.changes.timezone ?? null,
        reason: null,
        createdByUserId: options.actorUserId ?? null,
      });
    } catch (err: any) {
      emitEvent("recurring_booking_compensation_required", {
        meetingId: master.id,
        step: "exception_persist",
        error: err?.message || String(err),
        notice:
          "Google instance was updated but DB exception row could not be written — manual reconciliation needed.",
      });
      throw new BookingError(
        `Could not record recurrence exception: ${err?.message || err}`,
        "internal_failure",
      );
    }
    try {
      await sendBookingNotification("recurring_edited", {
        meeting: master,
        scope,
        originalStartTime: options.originalStartTime,
        recurrenceSummary: master.recurrenceSummary,
        recurrenceTimezone: master.recurrenceTimezone,
        zoomRecurrenceMode: (master.zoomRecurrenceMode as ZoomRecurrenceMode) ?? null,
        zoomFallbackReason: master.zoomRecurrenceFallbackReason,
        joinUrl: master.zoomJoinUrl,
      });
    } catch (err: any) {
      emitEvent("notification_failed", {
        meetingId: master.id,
        kind: "recurring_edited",
        error: err?.message || String(err),
      });
    }
    return { master };
  }

  if (scope === "this_and_following") {
    if (!options.originalStartTime) {
      throw new BookingError(
        "originalStartTime is required for scope=this_and_following",
        "invalid_input",
      );
    }
    if (
      !master.recurringEventId ||
      !master.googleCalendarId ||
      !master.accountManagerUserId
    ) {
      throw new BookingError(
        "Cannot split a series: master has no Google Calendar recurring event",
        "calendar_failure",
      );
    }
    let split: Awaited<ReturnType<typeof googleCalendar.updateThisAndFollowing>>;
    try {
      split = await googleCalendar.updateThisAndFollowing({
        userId: master.accountManagerUserId,
        calendarId: master.googleCalendarId,
        seriesEventId: master.recurringEventId,
        instanceOriginalStartTime: options.originalStartTime,
        changes: {
          summary: options.changes.summary,
          description: options.changes.description,
          startUtc: options.changes.startTimeUtc,
          endUtc: options.changes.endTimeUtc,
          timezone: options.changes.timezone,
          location: options.changes.location,
          attendees: options.changes.attendees,
          recurrence: options.changes.recurrence?.lines,
          reminderOverrides: options.changes.reminderOverrides,
        },
        sendUpdates,
      });
    } catch (err: any) {
      emitEvent("recurring_booking_compensation_required", {
        meetingId: master.id,
        step: "google_series_split",
        error: err?.message || String(err),
      });
      throw new BookingError(
        `Google Calendar series split failed: ${err?.message || err}`,
        "calendar_failure",
      );
    }

    // Persist the new sibling master row. Inherit the Zoom meeting from
    // the previous series — per the epic, per-instance Zoom updates are
    // out of scope, so the static-link / recurring meeting carries
    // through to the new sibling unchanged.
    const newStartUtc = options.changes.startTimeUtc ?? options.originalStartTime;
    const dur = options.changes.durationMinutes
      ? options.changes.durationMinutes * 60_000
      : master.endTimeUtc.getTime() - master.startTimeUtc.getTime();
    const newEndUtc =
      options.changes.endTimeUtc ?? new Date(newStartUtc.getTime() + dur);

    let newMaster: ScheduledMeeting;
    try {
      newMaster = await storage.createScheduledMeeting({
        clientId: master.clientId,
        accountManagerUserId: master.accountManagerUserId,
        bookingPageId: master.bookingPageId,
        bookingSource: master.bookingSource,
        inviteeName: master.inviteeName,
        inviteeEmail: master.inviteeEmail,
        startTimeUtc: newStartUtc,
        endTimeUtc: newEndUtc,
        timezone: options.changes.timezone ?? master.timezone,
        status: "confirmed",
        meetingTypeId: master.meetingTypeId,
        meetingTypeName: master.meetingTypeName,
        zoomMeetingId: master.zoomMeetingId,
        zoomMeetingUuid: master.zoomMeetingUuid,
        zoomJoinUrl: master.zoomJoinUrl,
        zoomStartUrl: master.zoomStartUrl,
        zoomHostUserId: master.zoomHostUserId,
        googleCalendarId: master.googleCalendarId,
        googleCalendarEventId: split.newSeriesEventId,
        googleCalendarEventUrl: split.newSeriesRaw?.htmlLink ?? null,
        // Task #4337 — carry the original booking's first-touch capture
        // through the series split so the raw attribution stays visible.
        utmSource: master.utmSource,
        utmMedium: master.utmMedium,
        utmCampaign: master.utmCampaign,
        utmTerm: master.utmTerm,
        utmContent: master.utmContent,
        referrer: master.referrer,
        recurrence:
          options.changes.recurrence?.lines ?? master.recurrence ?? null,
        recurrenceSource: master.recurrenceSource,
        recurringEventId: split.newSeriesEventId,
        recurrenceTimezone:
          options.changes.recurrence?.timezone ??
          master.recurrenceTimezone,
        recurrenceSummary:
          options.changes.recurrence?.summary ?? master.recurrenceSummary,
        zoomRecurrenceMode: master.zoomRecurrenceMode,
        zoomRecurrenceFallbackReason: master.zoomRecurrenceFallbackReason,
        previousSeriesMasterId: master.id,
        splitFromMeetingId: master.id,
        splitAtOriginalStartTime: options.originalStartTime,
      });
    } catch (err: any) {
      emitEvent("recurring_booking_compensation_required", {
        meetingId: master.id,
        step: "split_persist_new_master",
        error: err?.message || String(err),
        notice:
          "Google series was split but new master row could not be created — manual reconciliation needed.",
      });
      throw new BookingError(
        `Could not persist split sibling row: ${err?.message || err}`,
        "internal_failure",
      );
    }

    // Link the previous master to its successor.
    try {
      await storage.updateScheduledMeeting(master.id, {
        nextSeriesMasterId: newMaster.id,
        recurrence: master.recurrence, // truncated upstream by Google
      });
    } catch (err: any) {
      emitEvent("recurring_booking_compensation_required", {
        meetingId: master.id,
        step: "split_link_previous_master",
        error: err?.message || String(err),
      });
      // Not fatal — the new sibling exists and Google is split; this
      // only affects the previous→next pointer used by the UI.
    }

    try {
      await sendBookingNotification("recurring_edited", {
        meeting: newMaster,
        scope,
        originalStartTime: options.originalStartTime,
        recurrenceSummary: newMaster.recurrenceSummary,
        recurrenceTimezone: newMaster.recurrenceTimezone,
        zoomRecurrenceMode: (newMaster.zoomRecurrenceMode as ZoomRecurrenceMode) ?? null,
        zoomFallbackReason: newMaster.zoomRecurrenceFallbackReason,
        joinUrl: newMaster.zoomJoinUrl,
      });
    } catch (err: any) {
      emitEvent("notification_failed", {
        meetingId: master.id,
        kind: "recurring_edited",
        error: err?.message || String(err),
      });
    }
    return { master, newMaster };
  }

  // scope === "entire_series"
  if (
    !master.recurringEventId ||
    !master.googleCalendarId ||
    !master.accountManagerUserId
  ) {
    throw new BookingError(
      "Cannot update entire series: master has no Google Calendar recurring event",
      "calendar_failure",
    );
  }
  try {
    await googleCalendar.updateEvent({
      userId: master.accountManagerUserId,
      calendarId: master.googleCalendarId,
      eventId: master.recurringEventId,
      changes: {
        summary: options.changes.summary,
        description: options.changes.description,
        startUtc: options.changes.startTimeUtc,
        endUtc: options.changes.endTimeUtc,
        timezone: options.changes.timezone,
        location: options.changes.location,
        attendees: options.changes.attendees,
        recurrence: options.changes.recurrence?.lines,
        reminderOverrides: options.changes.reminderOverrides,
      },
      sendUpdates,
    });
  } catch (err: any) {
    emitEvent("recurring_booking_compensation_required", {
      meetingId: master.id,
      step: "google_series_update",
      error: err?.message || String(err),
    });
    throw new BookingError(
      `Google Calendar series update failed: ${err?.message || err}`,
      "calendar_failure",
    );
  }

  try {
    const updateFields: Partial<InsertScheduledMeeting> = {};
    if (options.changes.startTimeUtc) {
      updateFields.startTimeUtc = options.changes.startTimeUtc;
    }
    if (options.changes.endTimeUtc) {
      updateFields.endTimeUtc = options.changes.endTimeUtc;
    }
    if (options.changes.timezone) {
      updateFields.timezone = options.changes.timezone;
    }
    if (options.changes.recurrence) {
      updateFields.recurrence = options.changes.recurrence.lines;
      updateFields.recurrenceTimezone = options.changes.recurrence.timezone;
      updateFields.recurrenceSummary = options.changes.recurrence.summary ?? null;
    }
    if (Object.keys(updateFields).length > 0) {
      await storage.updateScheduledMeeting(master.id, updateFields);
    }
  } catch (err: any) {
    emitEvent("recurring_booking_compensation_required", {
      meetingId: master.id,
      step: "series_db_update",
      error: err?.message || String(err),
      notice:
        "Google series was updated but DB row could not be updated — manual reconciliation needed.",
    });
    throw new BookingError(
      `Could not persist series update: ${err?.message || err}`,
      "internal_failure",
    );
  }

  const refreshed = await storage.getScheduledMeetingById(master.id);
  try {
    await sendBookingNotification("recurring_edited", {
      meeting: refreshed || master,
      scope,
      recurrenceSummary:
        options.changes.recurrence?.summary ?? master.recurrenceSummary,
      recurrenceTimezone:
        options.changes.recurrence?.timezone ?? master.recurrenceTimezone,
      zoomRecurrenceMode: (master.zoomRecurrenceMode as ZoomRecurrenceMode) ?? null,
      zoomFallbackReason: master.zoomRecurrenceFallbackReason,
      joinUrl: master.zoomJoinUrl,
    });
  } catch (err: any) {
    emitEvent("notification_failed", {
      meetingId: master.id,
      kind: "recurring_edited",
      error: err?.message || String(err),
    });
  }
  return { master: refreshed || master };
}

// ---------------------------------------------------------------------------
// Recurring booking saga (create) — Task #1039
// ---------------------------------------------------------------------------

const RECURRING_HORIZON_MS = 24 * 30 * 24 * 60 * 60 * 1000; // ~24 months

async function bookRecurringSlot(
  req: BookingRequest,
  recurrence: NormalizedRecurrence,
): Promise<BookingResult> {
  // Task #1044: master kill switch. When the
  // `booking_recurring_enabled` system setting is OFF we refuse
  // brand-new recurring bookings before any expansion / Zoom / Calendar
  // work, but pre-existing one-off meetings (which never enter this
  // function) are unaffected. Routes translate this to HTTP 403.
  const flags = await getBookingFeatureFlags();
  if (!flags.master) {
    emitEvent("recurring_booking_rejected_disabled", {
      hostUserId: req.host.hostUserId,
      bookingPageId: req.page.id,
      flag: "booking_recurring_enabled",
    });
    throw new BookingError(
      "Recurring meetings are currently disabled by an administrator.",
      "recurrence_disabled",
      { flag: "booking_recurring_enabled" },
    );
  }

  // Idempotency: same key returning a confirmed series → return as-is.
  if (req.idempotencyKey) {
    const existing = await storage.getScheduledMeetingByIdempotencyKey(
      req.idempotencyKey,
    );
    if (existing && existing.status === "confirmed") {
      return {
        meeting: existing,
        joinUrl: existing.zoomJoinUrl,
        startUrl: existing.zoomStartUrl,
        calendarEventUrl: existing.googleCalendarEventUrl,
      };
    }
    if (existing && existing.status === "creating") {
      throw new BookingError(
        "A recurring booking with this idempotency key is already in flight",
        "internal_failure",
      );
    }
  }

  if (!req.invitee.email) {
    throw new BookingError("Missing invitee email", "invalid_input");
  }
  const startUtc = new Date(req.startTimeUtc);
  if (Number.isNaN(startUtc.getTime())) {
    throw new BookingError("Invalid start time", "invalid_input");
  }

  const effectivePage: BookingPage = {
    ...req.page,
    durationMinutes:
      typeof req.durationMinutes === "number"
        ? req.durationMinutes
        : req.page.durationMinutes,
    bufferBeforeMinutes:
      typeof req.bufferBeforeMinutes === "number"
        ? req.bufferBeforeMinutes
        : req.page.bufferBeforeMinutes,
    bufferAfterMinutes:
      typeof req.bufferAfterMinutes === "number"
        ? req.bufferAfterMinutes
        : req.page.bufferAfterMinutes,
  };
  const duration = effectivePage.durationMinutes;
  const endUtc = new Date(startUtc.getTime() + duration * 60_000);

  // Expand occurrences over the configured horizon. The expander
  // applies the per-rule horizon / occurrence cap and surfaces
  // truncation so the saga can emit the cap-hit observability event.
  const expanded = expandRecurrence(recurrence, {
    dtstart: startUtc,
    durationMinutes: duration,
    from: startUtc,
    to: new Date(startUtc.getTime() + RECURRING_HORIZON_MS),
  });
  if (!expanded.ok) {
    emitEvent("recurring_booking_failed_validation", {
      hostUserId: req.host.hostUserId,
      bookingPageId: req.page.id,
      code: expanded.code,
      message: expanded.message,
    });
    throw new BookingError(
      `Recurrence expansion failed: ${expanded.message}`,
      "recurrence_expansion_failed",
      { code: expanded.code },
    );
  }
  if (expanded.occurrences.length === 0) {
    emitEvent("recurring_booking_failed_validation", {
      hostUserId: req.host.hostUserId,
      bookingPageId: req.page.id,
      code: "no_occurrences",
    });
    throw new BookingError(
      "Recurrence produced zero occurrences within the horizon.",
      "recurrence_invalid",
    );
  }
  if (expanded.truncated) {
    emitEvent("recurrence_expansion_cap_hit", {
      hostUserId: req.host.hostUserId,
      bookingPageId: req.page.id,
      occurrenceCount: expanded.occurrences.length,
    });
  }

  // Per-occurrence free/busy validation. Returns the FULL conflict list
  // so the caller can surface every problem in one shot.
  let conflicts: RecurrenceConflict[];
  try {
    const result = await checkOccurrencesAvailability(
      effectivePage,
      expanded.occurrences,
      { skipCalendar: req.skipCalendar },
    );
    conflicts = result.conflicts;
  } catch (err: any) {
    if (err instanceof CalendarBusyUnavailableError) {
      throw new BookingError(
        "Could not verify the host's Google Calendar free/busy state. The recurring booking has been refused.",
        "calendar_failure",
      );
    }
    throw err;
  }
  emitEvent("freebusy_conflict_count", {
    hostUserId: req.host.hostUserId,
    bookingPageId: req.page.id,
    occurrenceCount: expanded.occurrences.length,
    conflictCount: conflicts.length,
  });
  if (conflicts.length > 0) {
    emitEvent("recurring_booking_failed_validation", {
      hostUserId: req.host.hostUserId,
      bookingPageId: req.page.id,
      code: "freebusy_conflicts",
      conflictCount: conflicts.length,
    });
    throw new BookingError(
      `Recurring booking has ${conflicts.length} conflict(s).`,
      "recurrence_conflicts",
      {
        conflicts: conflicts.map((c) => ({
          start: c.start.toISOString(),
          end: c.end.toISOString(),
          reason: c.reason,
        })),
      },
    );
  }

  // Serialize against same-AM races just like the one-off path. We MUST
  // re-validate every expanded occurrence inside the lock so that another
  // concurrent booking that landed on a later occurrence between our
  // pre-lock check and the lock acquisition is detected. Re-running the
  // full per-occurrence check (not just the first slot) closes the
  // late-conflict gap called out in the #1032D contract.
  const lockKey = stableLockKey(req.host.hostUserId);
  return await withAdvisoryLock(lockKey, async () => {
    let lockedConflicts: RecurrenceConflict[];
    try {
      const result = await checkOccurrencesAvailability(
        effectivePage,
        expanded.occurrences,
        { skipCalendar: req.skipCalendar },
      );
      lockedConflicts = result.conflicts;
    } catch (err: any) {
      if (err instanceof CalendarBusyUnavailableError) {
        throw new BookingError(
          "Could not verify the host's Google Calendar free/busy state.",
          "calendar_failure",
        );
      }
      throw err;
    }
    if (lockedConflicts.length > 0) {
      emitEvent("freebusy_conflict_count", {
        hostUserId: req.host.hostUserId,
        bookingPageId: req.page.id,
        occurrenceCount: expanded.occurrences.length,
        conflictCount: lockedConflicts.length,
        phase: "post_lock_revalidation",
      });
      // If only the first occurrence is taken we surface `slot_taken`
      // (matches the one-off path). Otherwise it's a late multi-
      // occurrence conflict — distinct error so callers can render it.
      const onlyFirst =
        lockedConflicts.length === 1 &&
        lockedConflicts[0].start.getTime() === startUtc.getTime();
      if (onlyFirst) {
        throw new BookingError(
          "The selected time was just booked by someone else. Please pick another slot.",
          "slot_taken",
        );
      }
      throw new BookingError(
        `Recurring booking has ${lockedConflicts.length} late conflict(s) detected after lock.`,
        "recurrence_conflicts",
        {
          conflicts: lockedConflicts.map((c) => ({
            start: c.start.toISOString(),
            end: c.end.toISOString(),
            reason: c.reason,
          })),
          phase: "post_lock_revalidation",
        },
      );
    }
    // Cross-page overlap guard for the first occurrence (cheap belt-and-
    // braces — the per-occurrence check above already covers buffered
    // overlaps with same-AM scheduled meetings, but this defends against
    // a race where another row was inserted with a status the
    // per-occurrence check filtered out).
    const overlapping = await storage.listOverlappingScheduledMeetingsForAm(
      req.host.hostUserId,
      startUtc,
      endUtc,
    );
    if (overlapping.length > 0) {
      throw new BookingError(
        "The selected time conflicts with another booking on this account manager.",
        "slot_taken",
      );
    }

    return await createRecurringBookingTransactional(
      req,
      effectivePage,
      startUtc,
      endUtc,
      recurrence,
      expanded.occurrences.length,
      expanded.truncated,
    );
  });
}

async function createRecurringBookingTransactional(
  req: BookingRequest,
  effectivePage: BookingPage,
  startUtc: Date,
  endUtc: Date,
  recurrence: NormalizedRecurrence,
  occurrenceCount: number,
  truncated: boolean,
): Promise<BookingResult> {
  // 1) Insert the master row in `creating` state with all recurrence metadata.
  let pending: ScheduledMeeting;
  try {
    pending = await storage.createScheduledMeeting({
      clientId: req.clientId ?? null,
      accountManagerUserId: req.host.hostUserId,
      bookingPageId: req.page.id,
      bookingSource: req.source,
      inviteeName: req.invitee.name ?? null,
      inviteeEmail: req.invitee.email,
      startTimeUtc: startUtc,
      endTimeUtc: endUtc,
      timezone: req.page.timezone,
      status: "creating",
      idempotencyKey: req.idempotencyKey ?? null,
      meetingTypeId: req.meetingTypeId ?? null,
      meetingTypeName: req.meetingTypeName ?? null,
      ...attributionColumns(req.attribution),
      recurrence: recurrence.lines,
      recurrenceSource: recurrence.source,
      recurrenceTimezone: recurrence.timezone,
      recurrenceSummary: recurrence.summary ?? null,
    });
  } catch (err: any) {
    if (req.idempotencyKey && /idempotency/i.test(err?.message || "")) {
      const winner = await storage.getScheduledMeetingByIdempotencyKey(
        req.idempotencyKey,
      );
      if (winner && winner.status === "confirmed") {
        return {
          meeting: winner,
          joinUrl: winner.zoomJoinUrl,
          startUrl: winner.zoomStartUrl,
          calendarEventUrl: winner.googleCalendarEventUrl,
        };
      }
    }
    throw new BookingError(
      `Failed to record pending recurring booking: ${err.message || err}`,
      "internal_failure",
    );
  }

  // 2) Resolve Zoom host (same canonical resolver as one-off path).
  let hostUser: Awaited<ReturnType<typeof storage.getUser>> | null;
  try {
    hostUser = (await storage.getUser(req.host.hostUserId)) || null;
  } catch (err: any) {
    await safeMarkRowFailed(
      pending.id,
      `Host user lookup failed: ${err?.message || err}`,
    );
    throw new BookingError(
      `Could not load host account: ${err?.message || err}`,
      "internal_failure",
    );
  }
  const effectiveHost = await zoom.resolveEffectiveZoomHostForUser(hostUser);
  if (effectiveHost.source === "none" || !effectiveHost.zoomEmail) {
    await safeMarkRowFailed(
      pending.id,
      `Zoom host unresolved: ${effectiveHost.error || "no Zoom user mapped"}`,
    );
    throw new BookingError(
      `Could not resolve a Zoom host: ${effectiveHost.error || "no Zoom user mapped"}`,
      "zoom_failure",
    );
  }

  // 3) Calendar prerequisite — same fail-closed contract as one-off.
  const credential = await storage
    .getGoogleCalendarCredential(req.host.hostUserId)
    .catch(() => null);
  const calendarConfigured = googleCalendar.isGoogleCalendarConfigured();
  const hasCalendar =
    !!credential && credential.status === "connected" && calendarConfigured;
  if (!hasCalendar || !credential) {
    const reason = !calendarConfigured
      ? "Google Calendar OAuth is not configured on this server."
      : !credential
        ? "The host has not connected their Google Calendar."
        : `The host's Google Calendar credential is in state "${credential.status}" — they need to reconnect.`;
    await safeMarkRowFailed(
      pending.id,
      `Calendar prerequisite missing: ${reason}`,
    );
    throw new BookingError(`Cannot book — ${reason}`, "calendar_failure");
  }
  const calendarId = credential.calendarId || "primary";

  // 4) Create the Google Calendar recurring master FIRST (Google is the
  //    source of truth for per-instance state per the epic).
  let calendarEventUrl: string | null = null;
  let calendarEventId: string | null = null;
  try {
    const event = await googleCalendar.insertEvent(
      req.host.hostUserId,
      calendarId,
      {
        summary: buildTopic(req),
        description: buildEventDescription(req, "(Zoom link assigned next)"),
        startUtc,
        endUtc,
        timezone: req.page.timezone,
        attendees: [{ email: req.invitee.email, displayName: req.invitee.name }],
        recurrence: recurrence.lines,
        reminderOverrides: [
          { method: "email", minutes: 60 },
          { method: "email", minutes: 10 },
        ],
      },
    );
    calendarEventUrl = event.htmlLink;
    calendarEventId = event.id;
  } catch (err: any) {
    await safeMarkRowFailed(
      pending.id,
      `Calendar recurring create failed: ${err?.message || err}`,
    );
    throw new BookingError(
      `Could not create Google Calendar recurring event: ${err?.message || err}`,
      "calendar_failure",
    );
  }

  // 5) Create the Zoom recurring meeting (or static-link fallback).
  //    Per the epic compensation matrix: Google created + Zoom failed
  //    → keep the Google event with a conferencing warning rather than
  //    silently rolling back the calendar; mark the row failed so the
  //    operator can intervene.
  let zoomMeeting: Awaited<ReturnType<typeof zoom.createRecurringMeeting>>;
  try {
    zoomMeeting = await zoom.createRecurringMeeting({
      hostEmail: effectiveHost.zoomEmail,
      topic: buildTopic(req),
      startTimeUtc: startUtc,
      durationMinutes: effectivePage.durationMinutes,
      timezone: effectivePage.timezone,
      agenda: req.notes,
      inviteeEmail: req.invitee.email,
      inviteeName: req.invitee.name,
      rrule: recurrence.rruleLine,
      exdates: recurrence.exdates,
    });
  } catch (err: any) {
    emitEvent("recurring_booking_compensation_required", {
      meetingId: pending.id,
      step: "zoom_create",
      googleCalendarEventId: calendarEventId,
      notice:
        "Google recurring event was created but Zoom failed — Google event left intact; conferencing link missing on the row.",
      error: err?.message || String(err),
    });
    await safeMarkRowFailed(
      pending.id,
      `Zoom recurring create failed (Google event ${calendarEventId} kept): ${err?.message || err}`,
    );
    throw new BookingError(
      `Could not create Zoom recurring meeting: ${err?.message || err}`,
      "zoom_failure",
    );
  }

  // 6) Patch the Google event description with the real Zoom join link
  //    so attendees can join from the calendar invite.
  try {
    await googleCalendar.updateEvent({
      userId: req.host.hostUserId,
      calendarId,
      eventId: calendarEventId!,
      changes: {
        description: buildEventDescription(req, zoomMeeting.joinUrl),
        location: zoomMeeting.joinUrl,
      },
      sendUpdates: "none",
    });
  } catch (err: any) {
    // Non-fatal: the row still has the join URL; the calendar event
    // simply won't surface it in the description. Log and continue.
    console.warn(
      `[BookingScheduler] Could not patch Google event with Zoom link for ${pending.id}: ${err?.message || err}`,
    );
  }

  // 7) Confirm the master row with all external ids. On failure, run
  //    the documented compensation: delete Google event + Zoom meeting
  //    so we don't leak orphans.
  let confirmed: ScheduledMeeting | undefined;
  try {
    confirmed = await storage.updateScheduledMeeting(pending.id, {
      status: "confirmed",
      zoomMeetingId: zoomMeeting.zoomMeetingId,
      zoomMeetingUuid: zoomMeeting.zoomMeetingUuid,
      zoomJoinUrl: zoomMeeting.joinUrl,
      zoomStartUrl: zoomMeeting.startUrl,
      zoomHostUserId: zoomMeeting.raw?.host_id || null,
      googleCalendarEventId: calendarEventId,
      googleCalendarEventUrl: calendarEventUrl,
      googleCalendarId: calendarId,
      recurringEventId: calendarEventId,
      zoomRecurrenceMode: zoomMeeting.mode,
      zoomRecurrenceFallbackReason: zoomMeeting.fallbackReason ?? null,
    });
  } catch (err: any) {
    await safeDeleteCalendarEvent(req.host.hostUserId, calendarId, calendarEventId);
    await safeDeleteZoom(zoomMeeting.zoomMeetingId);
    await safeMarkRowFailed(
      pending.id,
      `Recurring booking confirmation update failed: ${err?.message || err}`,
    );
    throw new BookingError(
      `Recurring booking confirmation update failed: ${err?.message || err}`,
      "internal_failure",
    );
  }
  if (!confirmed) {
    await safeDeleteCalendarEvent(req.host.hostUserId, calendarId, calendarEventId);
    await safeDeleteZoom(zoomMeeting.zoomMeetingId);
    throw new BookingError(
      "Recurring booking row vanished during confirmation",
      "internal_failure",
    );
  }

  // 8) Notify attendees (best-effort).
  try {
    await sendBookingNotification("recurring_created", {
      meeting: confirmed,
      occurrenceCount,
      truncated,
      recurrenceSummary: recurrence.summary ?? null,
      recurrenceTimezone: recurrence.timezone,
      zoomRecurrenceMode: zoomMeeting.mode,
      zoomFallbackReason: zoomMeeting.fallbackReason ?? null,
      joinUrl: zoomMeeting.joinUrl,
    });
  } catch (err: any) {
    emitEvent("notification_failed", {
      meetingId: confirmed.id,
      kind: "recurring_created",
      error: err?.message || String(err),
    });
  }

  emitEvent("recurring_booking_created", {
    meetingId: confirmed.id,
    hostUserId: req.host.hostUserId,
    bookingPageId: req.page.id,
    recurringEventId: calendarEventId,
    occurrenceCount,
    truncated,
    zoomRecurrenceMode: zoomMeeting.mode,
    zoomFallbackReason: zoomMeeting.fallbackReason ?? null,
    timezone: recurrence.timezone,
  });

  // Task #4330 — lead lifecycle hook for the initial recurring confirm
  // (series modifications/splits deliberately do NOT re-fire this: they are
  // edits to an already-counted session). Best-effort, never blocks.
  try {
    const { handleBookingConfirmedForLifecycle } = await import("./leadIntake");
    await handleBookingConfirmedForLifecycle(confirmed);
  } catch (err: any) {
    console.error("[BookingScheduler] lead lifecycle hook (recurring) failed:", err?.message ?? err);
  }

  return {
    meeting: confirmed,
    joinUrl: zoomMeeting.joinUrl,
    startUrl: zoomMeeting.startUrl,
    calendarEventUrl,
    recurrence: {
      occurrenceCount,
      truncated,
      summary: recurrence.summary ?? null,
      timezone: recurrence.timezone,
      zoomMode: zoomMeeting.mode,
      zoomFallbackReason: zoomMeeting.fallbackReason ?? null,
    },
  };
}

async function safeDeleteZoom(zoomMeetingId: string): Promise<void> {
  try {
    await zoom.deleteScheduledMeeting(zoomMeetingId, { cancelMeetingReminder: true });
  } catch (err: any) {
    console.warn(
      `[BookingScheduler] Zoom delete failed for ${zoomMeetingId}: ${err.message || err}`,
    );
  }
}

async function safeDeleteCalendarEvent(
  hostUserId: string,
  calendarId: string | null,
  eventId: string | null,
): Promise<void> {
  if (!calendarId || !eventId) return;
  try {
    await googleCalendar.deleteEvent(hostUserId, calendarId, eventId);
  } catch (err: any) {
    console.warn(
      `[BookingScheduler] Calendar delete failed for event ${eventId}: ${err?.message || err}`,
    );
  }
}

async function safeMarkRowFailed(
  meetingId: string,
  reason: string,
): Promise<void> {
  try {
    await storage.updateScheduledMeeting(meetingId, {
      status: "failed",
      failureReason: reason.slice(0, 1000),
      zoomMeetingId: null,
      zoomMeetingUuid: null,
      zoomJoinUrl: null,
      zoomStartUrl: null,
      googleCalendarEventId: null,
      googleCalendarEventUrl: null,
      googleCalendarId: null,
    });
  } catch (err: any) {
    // Last-resort log — we already cleaned up the external artifacts, the
    // worst case is a stuck "creating" row that the operator can mop up.
    console.error(
      `[BookingScheduler] Could not mark booking ${meetingId} as failed: ${err?.message || err}`,
    );
  }
}

function buildTopic(req: BookingRequest): string {
  const inviteeName = req.invitee.name || req.invitee.email;
  // Prefer the saved meeting type label (Task #890) when present so the
  // Zoom topic / Calendar event reflect the preset the AM picked
  // ("Discovery with Jane Doe" rather than the generic page title).
  const label = req.meetingTypeName || req.page.title || "Meeting";
  return `${label} with ${inviteeName}`;
}

function buildEventDescription(req: BookingRequest, joinUrl: string): string {
  // Task #891: surface the meeting length (and the booking page's
  // optional one-line description) in the calendar / Zoom invite copy
  // so invitees see the same context they saw on /book/:slug.
  const duration =
    typeof req.durationMinutes === "number"
      ? req.durationMinutes
      : req.page.durationMinutes;
  const lines = [
    `Booked via NoBull OS`,
    `Duration: ${duration} minutes`,
    `Invitee: ${req.invitee.name || ""} <${req.invitee.email}>`.trim(),
  ];
  const pageDescription = (req.page.description || "").trim();
  if (pageDescription) {
    lines.push("", pageDescription);
  }
  lines.push("", `Join Zoom: ${joinUrl}`);
  if (req.notes) {
    lines.push("", "Notes:", req.notes);
  }
  return lines.join("\n");
}

/** Convert an arbitrary string into the [-2^31, 2^31) range Postgres advisory locks accept. */
function stableLockKey(input: string): number {
  const h = crypto.createHash("sha256").update(`booking:${input}`).digest();
  // Read first 4 bytes as a signed int32.
  return h.readInt32BE(0);
}

/**
 * Acquire a Postgres session-level advisory lock for the duration of `fn`.
 *
 * IMPORTANT: `pg_advisory_lock` / `pg_advisory_unlock` are SESSION-scoped, so
 * they MUST run on the same Postgres session. With a connection pool, calling
 * `db.execute(...)` for the lock and again for the unlock can land on
 * different pooled connections — meaning the lock isn't actually held during
 * `fn` (defeating its purpose) and the unlock can fail (leaking the lock on
 * an unrelated client). To guarantee correctness, we explicitly check out a
 * single `PoolClient` from `apiPool`, hold it for the full critical section,
 * and release it via `client.release()` in the outer finally.
 *
 * The DB operations inside `fn` do not need to share this client — the actual
 * exclusivity guarantee for the booking row itself is enforced by the
 * `scheduled_meetings_no_overlap` EXCLUDE-tsrange constraint and the unique
 * partial index on `idempotency_key`. The advisory lock is a fast-path serial
 * gate so simultaneous bookings against the same AM don't both spin up a Zoom
 * meeting before one of them loses on the EXCLUDE constraint.
 */
async function withAdvisoryLock<T>(
  key: number,
  fn: () => Promise<T>,
): Promise<T> {
  const { apiPool } = await import("../db");
  const client = await apiPool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [key]);
    try {
      return await fn();
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [key]);
      } catch (err) {
        console.warn(
          `[BookingScheduler] Failed to release advisory lock ${key}:`,
          err,
        );
      }
    }
  } finally {
    client.release();
  }
}
