import { fromZonedTime, toZonedTime, formatInTimeZone } from "date-fns-tz";
import { storage } from "../storage";
import * as googleCalendar from "./googleCalendarIntegration";
import type {
  BookingPage,
  BookingAvailabilityRule,
  BookingAvailabilityOverride,
  ScheduledMeeting,
} from "@shared/schema";

/**
 * Booking-tool availability engine (Task #840).
 *
 * Given a booking page and a [from, to] window in *UTC*, compute the set of
 * bookable slot start times (UTC) by intersecting:
 *   - the AM's recurring weekly availability rules (in the page's tz)
 *   - any per-date overrides (block / custom hours)
 *   - the AM's Google Calendar busy windows (best-effort: skipped if not connected)
 *   - already-scheduled OS bookings in `scheduled_meetings`
 *   - per-page buffer-before / buffer-after minutes
 *   - a minimum lead time (no slots in the past or in the next N minutes)
 *
 * All slot timestamps in the result are UTC. The slot interval equals
 * `bookingPage.durationMinutes`.
 */

export interface AvailableSlot {
  startUtc: Date;
  endUtc: Date;
}

export interface ComputeAvailabilityOptions {
  /** Inclusive lower bound (UTC). Slots start ≥ this instant. */
  fromUtc: Date;
  /** Exclusive upper bound (UTC). Slots start < this instant. */
  toUtc: Date;
  /** Minutes from "now" before a slot is bookable. Defaults to 60. */
  minLeadMinutes?: number;
  /** Step between candidate slots in minutes. Defaults to durationMinutes. */
  slotStepMinutes?: number;
  /** Override "now" for testing. */
  now?: Date;
  /** Skip Calendar busy lookup even if connected (e.g. for tests). */
  skipCalendar?: boolean;
  /**
   * Purpose tag forwarded to the Google Calendar token accessor (Task
   * #2286). Non-authoritative previews (public/AM/settings slot views)
   * pass `"probe"` so a transient auth blip during a busy lookup never
   * durably disconnects a still-valid calendar. The booking saga's
   * authoritative re-check leaves this unset (default = authoritative).
   */
  calendarRefreshPurpose?: string;
}

interface DayWindow {
  /** Local YYYY-MM-DD in the page tz. */
  dateLocal: string;
  /** Allowed working windows in local "HH:MM"–"HH:MM". */
  windows: Array<{ start: string; end: string }>;
}

function parseHHMM(value: string): { hours: number; minutes: number } {
  const [h, m] = value.split(":").map((n) => parseInt(n, 10));
  if (
    Number.isNaN(h) || Number.isNaN(m) ||
    h < 0 || h > 23 || m < 0 || m > 59
  ) {
    throw new Error(`Invalid HH:MM time string: "${value}"`);
  }
  return { hours: h, minutes: m };
}

function compareHHMM(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the working windows for each calendar date in [fromLocal, toLocal] by
 * applying overrides on top of the recurring rules. A blocked override removes
 * all windows for that date; a custom-hours override replaces them.
 */
function buildDayWindows(
  rules: BookingAvailabilityRule[],
  overrides: BookingAvailabilityOverride[],
  page: BookingPage,
  fromUtc: Date,
  toUtc: Date,
): DayWindow[] {
  const tz = page.timezone;
  // Walk one local day at a time. Use the local date that contains fromUtc as
  // the start, and the local date that contains toUtc as the end (inclusive,
  // because a window may straddle the UTC boundary).
  const startLocalStr = formatInTimeZone(fromUtc, tz, "yyyy-MM-dd");
  const endLocalStr = formatInTimeZone(toUtc, tz, "yyyy-MM-dd");

  const overridesByDate = new Map<string, BookingAvailabilityOverride>();
  for (const o of overrides) {
    // dateLocal column is `date` → Drizzle returns a string like "YYYY-MM-DD".
    const key = typeof o.dateLocal === "string"
      ? o.dateLocal
      : (o.dateLocal as unknown as Date).toISOString().slice(0, 10);
    overridesByDate.set(key, o);
  }

  const rulesByDay = new Map<number, BookingAvailabilityRule[]>();
  for (const r of rules) {
    if (!r.active) continue;
    const list = rulesByDay.get(r.dayOfWeek) || [];
    list.push(r);
    rulesByDay.set(r.dayOfWeek, list);
  }

  const out: DayWindow[] = [];
  let cursor = startLocalStr;
  // Hard guard: no more than 366 iterations.
  for (let i = 0; i < 400 && cursor <= endLocalStr; i++) {
    const dayOfWeek = computeDayOfWeek(cursor);
    const override = overridesByDate.get(cursor);

    let windows: Array<{ start: string; end: string }> = [];
    if (override?.isBlocked) {
      windows = [];
    } else if (override?.customStartTimeLocal && override?.customEndTimeLocal) {
      windows = [{
        start: override.customStartTimeLocal,
        end: override.customEndTimeLocal,
      }];
    } else {
      windows = (rulesByDay.get(dayOfWeek) || []).map((r) => ({
        start: r.startTimeLocal,
        end: r.endTimeLocal,
      }));
    }

    // Sort & merge overlapping windows on the same day.
    windows.sort((a, b) => compareHHMM(a.start, b.start));
    const merged: typeof windows = [];
    for (const w of windows) {
      if (compareHHMM(w.start, w.end) >= 0) continue;
      const tail = merged[merged.length - 1];
      if (tail && compareHHMM(w.start, tail.end) <= 0) {
        if (compareHHMM(w.end, tail.end) > 0) tail.end = w.end;
      } else {
        merged.push({ ...w });
      }
    }

    if (merged.length > 0) {
      out.push({ dateLocal: cursor, windows: merged });
    }
    cursor = nextDate(cursor);
  }
  return out;
}

function computeDayOfWeek(yyyymmdd: string): number {
  // Treat midnight in any tz — day-of-week is independent of the tz for a
  // local-date string, so use UTC arithmetic.
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  return d.getUTCDay();
}

function nextDate(yyyymmdd: string): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

interface BusyInterval {
  startUtc: Date;
  endUtc: Date;
}

function expandBusyWithBuffers(
  intervals: BusyInterval[],
  bufferBeforeMin: number,
  bufferAfterMin: number,
): BusyInterval[] {
  const before = bufferBeforeMin * 60_000;
  const after = bufferAfterMin * 60_000;
  return intervals.map((b) => ({
    startUtc: new Date(b.startUtc.getTime() - before),
    endUtc: new Date(b.endUtc.getTime() + after),
  }));
}

function mergeIntervals(intervals: BusyInterval[]): BusyInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort(
    (a, b) => a.startUtc.getTime() - b.startUtc.getTime(),
  );
  const out: BusyInterval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const tail = out[out.length - 1];
    const cur = sorted[i];
    if (cur.startUtc.getTime() <= tail.endUtc.getTime()) {
      if (cur.endUtc.getTime() > tail.endUtc.getTime()) {
        tail.endUtc = cur.endUtc;
      }
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

function overlapsAnyBusy(
  slotStart: Date,
  slotEnd: Date,
  busy: BusyInterval[],
): boolean {
  // Binary-search optimization not necessary at expected sizes (<=500 busy/week).
  for (const b of busy) {
    if (slotStart.getTime() < b.endUtc.getTime() && slotEnd.getTime() > b.startUtc.getTime()) {
      return true;
    }
  }
  return false;
}

/**
 * Compute available slot start times in UTC for a booking page over the
 * supplied window. The returned list is sorted, deduplicated, and respects
 * all constraints (rules, overrides, buffers, busy events, lead time).
 */
export async function computeAvailableSlots(
  page: BookingPage,
  options: ComputeAvailabilityOptions,
): Promise<AvailableSlot[]> {
  const tz = page.timezone;
  const duration = Math.max(5, page.durationMinutes);
  const step = Math.max(5, options.slotStepMinutes ?? duration);
  const now = options.now ?? new Date();
  const minLeadMs = (options.minLeadMinutes ?? 60) * 60_000;
  const earliestBookable = new Date(now.getTime() + minLeadMs);

  const fromUtc = options.fromUtc < earliestBookable ? earliestBookable : options.fromUtc;
  const toUtc = options.toUtc;
  if (toUtc.getTime() <= fromUtc.getTime()) return [];

  // Pull all the data in parallel.
  const [rules, overrides, scheduled, calendarBusy] = await Promise.all([
    storage.listAvailabilityRules(page.id),
    storage.listAvailabilityOverrides(
      page.id,
      formatInTimeZone(fromUtc, tz, "yyyy-MM-dd"),
      // listAvailabilityOverrides uses < toDateLocal — pad +1 day to be safe.
      nextDate(formatInTimeZone(toUtc, tz, "yyyy-MM-dd")),
    ),
    storage.listScheduledMeetingsForAm(page.accountManagerUserId, {
      status: ["creating", "confirmed"],
      from: new Date(fromUtc.getTime() - 24 * 60 * 60 * 1000),
      to: new Date(toUtc.getTime() + 24 * 60 * 60 * 1000),
    }),
    fetchCalendarBusy(
      page.accountManagerUserId,
      fromUtc,
      toUtc,
      options.skipCalendar,
      options.calendarRefreshPurpose,
    ),
  ]);

  const dayWindows = buildDayWindows(rules, overrides, page, fromUtc, toUtc);

  // Convert busy sources into a single sorted/merged list, expanded by buffers.
  const busyFromScheduled: BusyInterval[] = scheduled.map(
    (s: ScheduledMeeting) => ({
      startUtc: s.startTimeUtc,
      endUtc: s.endTimeUtc,
    }),
  );
  const busy = mergeIntervals(
    expandBusyWithBuffers(
      [...calendarBusy, ...busyFromScheduled],
      page.bufferBeforeMinutes,
      page.bufferAfterMinutes,
    ),
  );

  const out: AvailableSlot[] = [];
  const seen = new Set<number>();

  for (const day of dayWindows) {
    for (const w of day.windows) {
      const startLocalDate = `${day.dateLocal}T${w.start}:00`;
      const endLocalDate = `${day.dateLocal}T${w.end}:00`;
      const windowStartUtc = fromZonedTime(startLocalDate, tz);
      const windowEndUtc = fromZonedTime(endLocalDate, tz);

      // Iterate slot starts in UTC. Slots must fit entirely within the window.
      let slotStart = windowStartUtc;
      while (slotStart.getTime() + duration * 60_000 <= windowEndUtc.getTime()) {
        const slotEnd = new Date(slotStart.getTime() + duration * 60_000);

        if (
          slotStart.getTime() >= fromUtc.getTime() &&
          slotStart.getTime() < toUtc.getTime() &&
          slotStart.getTime() >= earliestBookable.getTime() &&
          !overlapsAnyBusy(slotStart, slotEnd, busy)
        ) {
          const key = slotStart.getTime();
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ startUtc: slotStart, endUtc: slotEnd });
          }
        }
        slotStart = new Date(slotStart.getTime() + step * 60_000);
      }
    }
  }

  out.sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
  return out;
}

/**
 * Task #5296 — Onboarding pool availability & assignment (stage 2 of the
 * New Client Onboarding epic).
 *
 * A single onboarding-pool candidate: their identity plus their OWN real
 * booking page (working-hour rules, buffers, timezone). Deliberately reuses
 * whatever page each roster member already has (or lazily gets via
 * `ensureBookingPage`) rather than inventing a second "onboarding
 * schedule" concept — "who is free" for onboarding is exactly "who is
 * free on their regular calendar", the same signal single-AM availability
 * already trusts.
 */
export interface PoolCandidate {
  userId: string;
  page: BookingPage;
}

export interface PoolAvailableSlot {
  startUtc: Date;
  endUtc: Date;
  /** Every candidate userId free for this exact slot (candidate order preserved). */
  availableUserIds: string[];
}

export interface ComputePoolAvailabilityOptions extends ComputeAvailabilityOptions {
  /**
   * Slot length applied uniformly to every candidate. An onboarding call
   * has one fixed length regardless of who ends up hosting it — this
   * deliberately overrides each candidate's own `page.durationMinutes`,
   * which reflects THEIR personal client-meeting length and has nothing
   * to do with onboarding calls.
   */
  durationMinutes: number;
  /** Buffer overrides applied uniformly; default to each candidate's own page buffers when omitted. */
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
}

export interface PoolAvailabilityResult {
  slots: PoolAvailableSlot[];
  /**
   * Candidates whose calendar could not be verified for this window — a
   * fail-closed EXCLUSION from `slots`, never proof they're busy (see
   * `CalendarBusyUnavailableError`). One candidate's calendar outage must
   * not take down the whole pool's availability view, but it must also
   * never silently promote them to "available" — so they're dropped from
   * the union and reported here so callers can surface the gap.
   */
  unresolvedCandidates: Array<{
    userId: string;
    transient: boolean;
    reason: string | null;
  }>;
}

/**
 * Compute available slots across a POOL of candidate users (Task #5296),
 * generalizing `computeAvailableSlots`'s single-AM contract to N people.
 * Reuses the exact same per-person calendar-busy/meeting-conflict engine
 * (one `computeAvailableSlots` call per candidate, run in parallel) and
 * unions the results by exact slot start time — a slot is available for
 * the pool the moment at least one candidate is free at that instant, and
 * `availableUserIds` lists every candidate free then so resolution rules
 * (default-first, etc.) can be applied at the exact chosen time.
 */
export async function computeAvailableSlotsForPool(
  candidates: PoolCandidate[],
  options: ComputePoolAvailabilityOptions,
): Promise<PoolAvailabilityResult> {
  if (candidates.length === 0) return { slots: [], unresolvedCandidates: [] };

  const { durationMinutes, bufferBeforeMinutes, bufferAfterMinutes, ...rest } = options;

  const settled = await Promise.all(
    candidates.map(async (c) => {
      const effectivePage: BookingPage = {
        ...c.page,
        durationMinutes,
        bufferBeforeMinutes: bufferBeforeMinutes ?? c.page.bufferBeforeMinutes,
        bufferAfterMinutes: bufferAfterMinutes ?? c.page.bufferAfterMinutes,
      };
      try {
        const slots = await computeAvailableSlots(effectivePage, rest);
        return { userId: c.userId, slots, error: null as CalendarBusyUnavailableError | null };
      } catch (err) {
        if (err instanceof CalendarBusyUnavailableError) {
          return { userId: c.userId, slots: [] as AvailableSlot[], error: err };
        }
        throw err;
      }
    }),
  );

  const byStart = new Map<number, PoolAvailableSlot>();
  const unresolvedCandidates: PoolAvailabilityResult["unresolvedCandidates"] = [];
  for (const { userId, slots, error } of settled) {
    if (error) {
      unresolvedCandidates.push({ userId, transient: error.transient, reason: error.reason });
      continue;
    }
    for (const slot of slots) {
      const key = slot.startUtc.getTime();
      const existing = byStart.get(key);
      if (existing) {
        existing.availableUserIds.push(userId);
      } else {
        byStart.set(key, {
          startUtc: slot.startUtc,
          endUtc: slot.endUtc,
          availableUserIds: [userId],
        });
      }
    }
  }

  const slots = Array.from(byStart.values()).sort(
    (a, b) => a.startUtc.getTime() - b.startUtc.getTime(),
  );
  return { slots, unresolvedCandidates };
}

/**
 * Thrown when the AM has an actively-connected Google Calendar credential
 * but the free/busy lookup fails (network error, Google 5xx, token
 * refresh race, etc.). This MUST be treated as fail-closed by callers
 * — we cannot safely offer or confirm slots without knowing the AM's
 * busy intervals, otherwise we'd risk double-booking over a real
 * calendar conflict. The slots HTTP route translates this to a 503 so
 * the client can retry; the booking saga translates it to a
 * `calendar_failure` BookingError so the booking is refused (no Zoom
 * meeting is created).
 */
export class CalendarBusyUnavailableError extends Error {
  readonly userId: string;
  /**
   * `true` when the failure is a transient network/5xx that the
   * caller should advertise as retriable. `false` when the underlying
   * cause is a `CalendarReauthRequiredError` (revoked grant / missing
   * scope / dead refresh token) — the AM must reconnect before any
   * retry can possibly succeed.
   */
  readonly transient: boolean;
  /** Short Google reason ("invalid_grant", "insufficient_scope", …) when known. */
  readonly reason: string | null;
  /** HTTP status from Google, when the cause was an API call. */
  readonly httpStatus: number | null;
  /**
   * Structured tag describing why the call failed, for admin
   * diagnostics (929E). `endpoint_misrouted` / `non_json_response`
   * indicate a request-shape bug (Google returned its generic HTML
   * landing page rather than a Calendar API JSON response) and are
   * NOT retriable; `null` falls back to the generic transient label.
   */
  readonly transportClassification:
    | "endpoint_misrouted"
    | "non_json_response"
    | null;
  constructor(userId: string, cause: unknown) {
    super(
      `Could not load Google Calendar free/busy for user ${userId}: ${
        (cause as any)?.message || String(cause)
      }`,
    );
    this.name = "CalendarBusyUnavailableError";
    this.userId = userId;
    if (cause instanceof googleCalendar.CalendarReauthRequiredError) {
      this.transient = false;
      this.reason = cause.reason;
      this.httpStatus = cause.httpStatus;
      this.transportClassification = null;
    } else if (cause instanceof googleCalendar.CalendarTransportError) {
      // Request-shape bug: re-issuing the same call will fail the
      // same way, so callers must not advertise it as retriable.
      this.transient = false;
      this.reason = cause.classification;
      this.httpStatus = cause.httpStatus;
      this.transportClassification = cause.classification;
    } else {
      this.transient = true;
      this.reason = null;
      this.httpStatus = (cause as any)?.httpStatus ?? null;
      this.transportClassification = null;
    }
  }
}

async function fetchCalendarBusy(
  userId: string,
  fromUtc: Date,
  toUtc: Date,
  skipCalendar: boolean | undefined,
  calendarRefreshPurpose?: string,
): Promise<BusyInterval[]> {
  if (skipCalendar) return [];
  // No global Google config — system never promised calendar awareness,
  // so it's safe to treat as no busy intervals.
  if (!googleCalendar.isGoogleCalendarConfigured()) return [];
  // Resolve the user's credential. If the AM has not connected (or the
  // credential is in a non-connected state like `expired` /
  // `refresh_failed`), we have no calendar to consult — return empty.
  // The booking saga independently rejects bookings in that case
  // (round-6 fix), so this branch only covers the slots-listing path.
  const cred = await storage.getGoogleCalendarCredential(userId);
  if (!cred || cred.status !== "connected") return [];
  // From here on the AM IS connected, so a failure to read busy
  // intervals is a fail-closed condition: we throw so the caller can
  // refuse to compute / confirm slots. Returning [] here would silently
  // expose busy time as bookable — the exact "respect busy time"
  // violation flagged in code review.
  try {
    return await googleCalendar.getFreeBusy(
      userId,
      fromUtc,
      toUtc,
      [cred.calendarId || "primary"],
      { purpose: calendarRefreshPurpose },
    );
  } catch (err: any) {
    logFreeBusyFailure(userId, err);
    throw new CalendarBusyUnavailableError(userId, err);
  }
}

function logFreeBusyFailure(userId: string, err: any): void {
  const reauth = err instanceof googleCalendar.CalendarReauthRequiredError;
  const transport = err instanceof googleCalendar.CalendarTransportError;
  const reason = reauth ? err.reason : transport ? err.classification : null;
  const status = reauth || transport ? err.httpStatus : null;
  console.warn(
    `[BookingAvailability] free/busy failed user=${userId} transient=${
      !reauth && !transport
    } httpStatus=${status ?? "n/a"} reason=${reason ?? "n/a"} msg=${
      err?.message || err
    }`,
  );
}

/**
 * Convenience: check if a single proposed slot is available right now.
 * Used by the booking saga to re-validate just before insert.
 *
 * Throws `CalendarBusyUnavailableError` (NOT swallowed) when the AM is
 * connected to Google Calendar but the free/busy lookup fails. The
 * caller (saga / slots route) MUST translate this to a fail-closed
 * response — returning `false` here would still let the booking
 * proceed via the AM-book "skipCalendar" path; throwing propagates the
 * fail-closed signal correctly.
 */
export async function isSlotAvailable(
  page: BookingPage,
  startUtc: Date,
  options?: { now?: Date; skipCalendar?: boolean; calendarRefreshPurpose?: string },
): Promise<boolean> {
  const slots = await computeAvailableSlots(page, {
    fromUtc: startUtc,
    toUtc: new Date(startUtc.getTime() + page.durationMinutes * 60_000),
    minLeadMinutes: 0,
    slotStepMinutes: page.durationMinutes,
    now: options?.now,
    skipCalendar: options?.skipCalendar,
    calendarRefreshPurpose: options?.calendarRefreshPurpose,
  });
  return slots.some((s) => s.startUtc.getTime() === startUtc.getTime());
}

/**
 * Returns the local-day date string (YYYY-MM-DD) in the page's timezone for
 * a UTC instant. Useful for grouping slots in the UI.
 */
export function localDateKey(page: BookingPage, utc: Date): string {
  return formatInTimeZone(utc, page.timezone, "yyyy-MM-dd");
}

/**
 * Returns the local time-of-day "HH:MM" in the page's timezone for a UTC instant.
 */
export function localTimeKey(page: BookingPage, utc: Date): string {
  return formatInTimeZone(utc, page.timezone, "HH:mm");
}

/** Re-export so callers can use the same toZonedTime wherever they're rendering. */
export { toZonedTime, fromZonedTime, formatInTimeZone };

// ---------------------------------------------------------------------------
// Recurrence-aware availability check (Task #1039 / #1032D)
// ---------------------------------------------------------------------------

export type RecurrenceConflictReason =
  | "in_past"
  | "lead_time_violation"
  | "outside_working_hours"
  | "overlaps_existing_booking"
  | "overlaps_calendar_busy";

export interface RecurrenceConflict {
  /** Original (unshifted) occurrence start in UTC. */
  start: Date;
  /** Occurrence end in UTC. */
  end: Date;
  reason: RecurrenceConflictReason;
}

export interface CheckOccurrencesOptions {
  minLeadMinutes?: number;
  now?: Date;
  skipCalendar?: boolean;
  /**
   * When checking availability for an existing recurring series being
   * edited, exclude scheduled meetings whose `seriesMasterId` (or `id`,
   * if it's the master itself) matches — otherwise the series's own
   * existing rows would be flagged as conflicts with the new occurrences.
   */
  excludeSeriesMasterId?: string | null;
  /**
   * For the one-off edit case, exclude a single meeting by id from the
   * scheduled-meeting overlap check.
   */
  excludeMeetingId?: string | null;
  /**
   * Purpose tag forwarded to the Google Calendar token accessor (Task
   * #2286). Authoritative saga callers leave this unset; only a
   * non-authoritative preview would pass `"probe"`.
   */
  calendarRefreshPurpose?: string;
}

/**
 * Validate every occurrence of an expanded recurrence in one pass:
 *   - in the past / lead-time
 *   - inside one of the page's working windows for the local day
 *   - no overlap with the AM's other scheduled meetings (with buffers)
 *   - no overlap with the AM's Google Calendar busy intervals (with buffers)
 *
 * Returns the FULL conflict list (not just the first hit) so the caller
 * can surface every problem in one shot.
 */
export async function checkOccurrencesAvailability(
  page: BookingPage,
  occurrences: Array<{ start: Date; end: Date }>,
  options?: CheckOccurrencesOptions,
): Promise<{ conflicts: RecurrenceConflict[] }> {
  if (occurrences.length === 0) return { conflicts: [] };
  const tz = page.timezone;
  const now = options?.now ?? new Date();
  const minLeadMs = (options?.minLeadMinutes ?? 60) * 60_000;
  const earliestBookable = new Date(now.getTime() + minLeadMs);

  const sorted = [...occurrences].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  const fromUtc = sorted[0].start;
  const toUtc = sorted[sorted.length - 1].end;

  const [rules, overrides, scheduled, calendarBusy] = await Promise.all([
    storage.listAvailabilityRules(page.id),
    storage.listAvailabilityOverrides(
      page.id,
      formatInTimeZone(fromUtc, tz, "yyyy-MM-dd"),
      nextDate(formatInTimeZone(toUtc, tz, "yyyy-MM-dd")),
    ),
    storage.listScheduledMeetingsForAm(page.accountManagerUserId, {
      status: ["creating", "confirmed"],
      from: new Date(fromUtc.getTime() - 24 * 60 * 60 * 1000),
      to: new Date(toUtc.getTime() + 24 * 60 * 60 * 1000),
    }),
    fetchCalendarBusy(
      page.accountManagerUserId,
      fromUtc,
      toUtc,
      options?.skipCalendar,
      options?.calendarRefreshPurpose,
    ),
  ]);

  const dayWindows = buildDayWindows(rules, overrides, page, fromUtc, toUtc);
  // Index working windows by local-date for O(1) per-occurrence lookup.
  const windowsByDay = new Map<
    string,
    Array<{ startUtc: Date; endUtc: Date }>
  >();
  for (const day of dayWindows) {
    const wins: Array<{ startUtc: Date; endUtc: Date }> = [];
    for (const w of day.windows) {
      wins.push({
        startUtc: fromZonedTime(`${day.dateLocal}T${w.start}:00`, tz),
        endUtc: fromZonedTime(`${day.dateLocal}T${w.end}:00`, tz),
      });
    }
    windowsByDay.set(day.dateLocal, wins);
  }

  // Build buffer-expanded busy list, separating the two sources so we
  // can attribute each conflict to a precise reason.
  const filteredScheduled = scheduled.filter((s) => {
    if (options?.excludeMeetingId && s.id === options.excludeMeetingId) {
      return false;
    }
    if (options?.excludeSeriesMasterId) {
      if (s.id === options.excludeSeriesMasterId) return false;
      if (s.seriesMasterId === options.excludeSeriesMasterId) return false;
    }
    return true;
  });
  const scheduledBusy = mergeIntervals(
    expandBusyWithBuffers(
      filteredScheduled.map((s: ScheduledMeeting) => ({
        startUtc: s.startTimeUtc,
        endUtc: s.endTimeUtc,
      })),
      page.bufferBeforeMinutes,
      page.bufferAfterMinutes,
    ),
  );
  const calendarBusyMerged = mergeIntervals(
    expandBusyWithBuffers(
      calendarBusy,
      page.bufferBeforeMinutes,
      page.bufferAfterMinutes,
    ),
  );

  const conflicts: RecurrenceConflict[] = [];
  for (const occ of sorted) {
    if (occ.start.getTime() < now.getTime()) {
      conflicts.push({ start: occ.start, end: occ.end, reason: "in_past" });
      continue;
    }
    if (occ.start.getTime() < earliestBookable.getTime()) {
      conflicts.push({
        start: occ.start,
        end: occ.end,
        reason: "lead_time_violation",
      });
      continue;
    }
    const dateLocal = formatInTimeZone(occ.start, tz, "yyyy-MM-dd");
    const wins = windowsByDay.get(dateLocal) || [];
    const fitsWindow = wins.some(
      (w) =>
        occ.start.getTime() >= w.startUtc.getTime() &&
        occ.end.getTime() <= w.endUtc.getTime(),
    );
    if (!fitsWindow) {
      conflicts.push({
        start: occ.start,
        end: occ.end,
        reason: "outside_working_hours",
      });
      continue;
    }
    if (overlapsAnyBusy(occ.start, occ.end, scheduledBusy)) {
      conflicts.push({
        start: occ.start,
        end: occ.end,
        reason: "overlaps_existing_booking",
      });
      continue;
    }
    if (overlapsAnyBusy(occ.start, occ.end, calendarBusyMerged)) {
      conflicts.push({
        start: occ.start,
        end: occ.end,
        reason: "overlaps_calendar_busy",
      });
      continue;
    }
  }
  return { conflicts };
}
