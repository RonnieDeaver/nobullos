// @db-pool-intent: api — this module only reads via `storage`/`onboardingRoster`
// (no runWithWorkerDb wrapper anywhere in its call graph), so any getDb()
// call underneath it always resolves to the API pool.
/**
 * Onboarding pool availability & assignment (Task #5296) — stage 2 of the
 * New Client Onboarding epic.
 *
 * Generalizes the single-AM booking availability/assignment engine
 * (`server/services/bookingAvailability.ts`, `server/services/bookingScheduler.ts`)
 * across the onboarding roster built in stage 1
 * (`server/services/onboardingRoster.ts`):
 *
 *   1. Find real open slots across every active onboarding assignee.
 *   2. Given a chosen slot, deterministically resolve exactly one assignee:
 *      the default person if THEY are free at that exact instant,
 *      otherwise the first other active + available member (roster order),
 *      otherwise a clear "nobody available" result — never an ambiguous
 *      or double assignment.
 *   3. Create the actual meeting under the resolved assignee's identity —
 *      Zoom host, Google Calendar event ownership, and the AM/host field
 *      on the `scheduled_meetings` row all attach to that person, the same
 *      way single-AM booking creation already works. `bookSlot` already
 *      threads host identity (`req.host.hostUserId`) independently of the
 *      booking page it's given, so nothing in the saga itself needed to
 *      change — this module just resolves who that host is first.
 *
 * Deliberately reuses each roster member's OWN personal booking page
 * (working-hour rules, buffers, timezone, Google Calendar, scheduled
 * meetings) rather than inventing a second "onboarding schedule" concept —
 * "who is free" for onboarding purposes is exactly "who is free on their
 * regular calendar", the same signal single-AM availability already
 * trusts (lazily created via `ensureBookingPage`, same as any AM's first
 * use of the booking tool).
 *
 * Stage 3 (intake form + client creation) is the only intended consumer;
 * this module has no HTTP surface of its own — no routes are added here.
 */
import { storage } from "../storage";
import { ensureBookingPage } from "../routes/booking";
import { listOnboardingRoster } from "./onboardingRoster";
import * as scheduler from "./bookingScheduler";
import {
  isSlotAvailable,
  computeAvailableSlotsForPool,
  CalendarBusyUnavailableError,
  type PoolCandidate,
  type PoolAvailabilityResult,
} from "./bookingAvailability";
import type { BookingPage } from "@shared/schema";

/**
 * Onboarding calls have one fixed length regardless of who ends up
 * hosting — independent of each roster member's own personal
 * client-booking-page duration, which reflects THEIR client meetings and
 * has nothing to do with onboarding calls.
 */
export const ONBOARDING_MEETING_DURATION_MINUTES = 30;

export interface OnboardingPoolMember {
  userId: string;
  isDefault: boolean;
  page: BookingPage;
}

/**
 * Load the resolvable onboarding pool: every ACTIVE roster member, each
 * paired with their own real booking page (lazy-created via
 * `ensureBookingPage` if they've never used the booking tool before —
 * the same affordance single-AM booking already gives). Order matches
 * roster order (`listOnboardingRoster` — createdAt ascending); resolution
 * callers sort the default to the front explicitly rather than relying on
 * this order alone. Roster rows whose user account no longer exists are
 * skipped defensively rather than throwing.
 */
export async function loadOnboardingPool(): Promise<OnboardingPoolMember[]> {
  const roster = await listOnboardingRoster();
  const active = roster.filter((m) => m.active);
  const members = await Promise.all(
    active.map(async (m): Promise<OnboardingPoolMember | null> => {
      const user = await storage.getUser(m.userId);
      if (!user) return null;
      const page = await ensureBookingPage(user);
      return { userId: m.userId, isDefault: m.isDefault, page };
    }),
  );
  return members.filter((m): m is OnboardingPoolMember => m !== null);
}

export interface OnboardingAvailabilityOptions {
  fromUtc: Date;
  toUtc: Date;
  now?: Date;
  minLeadMinutes?: number;
  slotStepMinutes?: number;
  skipCalendar?: boolean;
  calendarRefreshPurpose?: string;
  /** Defaults to ONBOARDING_MEETING_DURATION_MINUTES. */
  durationMinutes?: number;
}

export interface OnboardingAvailabilityResult extends PoolAvailabilityResult {
  /** Number of active roster members considered (pool size at load time). */
  poolSize: number;
}

/**
 * Step 1 — "given a requested time window, report which onboarding roster
 * members are actually free": loads the active pool and unions their real
 * per-person availability (calendar-busy + scheduled-meeting conflicts
 * checked exactly as single-AM availability checks them today).
 */
export async function computeOnboardingAvailability(
  options: OnboardingAvailabilityOptions,
): Promise<OnboardingAvailabilityResult> {
  const pool = await loadOnboardingPool();
  const candidates: PoolCandidate[] = pool.map((m) => ({ userId: m.userId, page: m.page }));
  const result = await computeAvailableSlotsForPool(candidates, {
    ...options,
    durationMinutes: options.durationMinutes ?? ONBOARDING_MEETING_DURATION_MINUTES,
  });
  return { ...result, poolSize: pool.length };
}

export interface OnboardingAssignmentAttempt {
  userId: string;
  isDefault: boolean;
  available: boolean;
  error?: { transient: boolean; reason: string | null };
}

export type OnboardingAssignmentResult =
  | { ok: true; userId: string; page: BookingPage; attempts: OnboardingAssignmentAttempt[] }
  | {
      ok: false;
      reason: "empty_pool" | "none_available";
      attempts: OnboardingAssignmentAttempt[];
    };

/**
 * Step 2 — resolve exactly one onboarding assignee for a specific chosen
 * slot start time: the default roster member if THEY are free at this
 * exact instant, otherwise the first other active member who is free, in
 * roster order. Never returns more than one match.
 *
 * A candidate whose calendar can't be verified
 * (`CalendarBusyUnavailableError`) is treated as fail-closed for THAT
 * person — never assumed free — but does not abort resolution for the
 * rest of the pool, since the whole point of a pool is resilience via
 * fallback. Every attempt (available, unavailable, or errored) is
 * recorded in `attempts` so callers can distinguish "genuinely nobody
 * free" from "we couldn't verify everyone" rather than getting a bare
 * boolean.
 */
export async function resolveOnboardingAssignee(
  startUtc: Date,
  options?: {
    durationMinutes?: number;
    now?: Date;
    skipCalendar?: boolean;
    calendarRefreshPurpose?: string;
  },
): Promise<OnboardingAssignmentResult> {
  const pool = await loadOnboardingPool();
  if (pool.length === 0) {
    return { ok: false, reason: "empty_pool", attempts: [] };
  }

  const duration = options?.durationMinutes ?? ONBOARDING_MEETING_DURATION_MINUTES;
  // Default-first, then everyone else in roster order (Task #5296 rule).
  const ordered = [...pool.filter((m) => m.isDefault), ...pool.filter((m) => !m.isDefault)];

  const attempts: OnboardingAssignmentAttempt[] = [];
  for (const member of ordered) {
    const effectivePage: BookingPage = { ...member.page, durationMinutes: duration };
    try {
      const available = await isSlotAvailable(effectivePage, startUtc, {
        now: options?.now,
        skipCalendar: options?.skipCalendar,
        calendarRefreshPurpose: options?.calendarRefreshPurpose,
      });
      attempts.push({ userId: member.userId, isDefault: member.isDefault, available });
      if (available) {
        return { ok: true, userId: member.userId, page: member.page, attempts };
      }
    } catch (err) {
      if (err instanceof CalendarBusyUnavailableError) {
        attempts.push({
          userId: member.userId,
          isDefault: member.isDefault,
          available: false,
          error: { transient: err.transient, reason: err.reason },
        });
        continue;
      }
      throw err;
    }
  }
  return { ok: false, reason: "none_available", attempts };
}

/** Thrown by `bookOnboardingSlot` when no roster member can be resolved. */
export class OnboardingAssignmentError extends Error {
  constructor(
    message: string,
    public readonly reason: "empty_pool" | "none_available",
    public readonly attempts: OnboardingAssignmentAttempt[],
  ) {
    super(message);
    this.name = "OnboardingAssignmentError";
  }
}

export interface BookOnboardingSlotInput {
  startTimeUtc: Date;
  invitee: { email: string; name?: string };
  clientId?: string | null;
  notes?: string;
  idempotencyKey?: string;
  durationMinutes?: number;
}

/**
 * Step 3 — resolve + book in one call: the actual pool-based booking path
 * stage 3's intake form calls once the sales rep confirms a slot. Resolves
 * exactly one assignee (default-first, else first other available) and
 * creates the meeting UNDER THAT PERSON via the existing
 * `scheduler.bookSlot` saga — Zoom host, Google Calendar event ownership,
 * and the AM/host field on the `scheduled_meetings` row all attach to the
 * resolved assignee, not the sales rep who initiated the call. Follows
 * the exact same saga single-AM booking creation already uses end-to-end
 * (advisory lock + live re-check, Zoom create, Calendar create, DB
 * confirm, compensation on partial failure) — nothing about that saga
 * needed to change, since it already parameterizes host identity per
 * request rather than assuming a single fixed AM.
 *
 * Throws `OnboardingAssignmentError` when nobody can be resolved (empty
 * roster or nobody available at the requested time) — callers must
 * surface this clearly rather than silently booking the wrong person.
 *
 * Note: resolution and the saga's own per-host lock + re-check are two
 * separate steps. If the resolved assignee gets booked elsewhere in the
 * narrow gap between them, `scheduler.bookSlot` will throw its own
 * `BookingError` (`slot_taken` / `slot_unavailable` / `calendar_failure`)
 * rather than silently double-booking — callers should treat that as
 * "please re-resolve and retry", the same way any single-AM booking
 * caller already must handle a post-lock rejection.
 */
export async function bookOnboardingSlot(
  req: BookOnboardingSlotInput,
): Promise<scheduler.BookingResult & { resolvedUserId: string }> {
  const durationMinutes = req.durationMinutes ?? ONBOARDING_MEETING_DURATION_MINUTES;
  const resolution = await resolveOnboardingAssignee(req.startTimeUtc, { durationMinutes });
  if (!resolution.ok) {
    throw new OnboardingAssignmentError(
      resolution.reason === "empty_pool"
        ? "There is nobody on the onboarding roster to book with."
        : "Nobody on the onboarding roster is available at the selected time.",
      resolution.reason,
      resolution.attempts,
    );
  }

  const hostUser = await storage.getUser(resolution.userId);
  if (!hostUser) {
    // Roster/user row vanished between resolution and booking — extremely
    // unlikely (resolution just loaded it), but never silently proceed
    // with an unresolved host identity.
    throw new OnboardingAssignmentError(
      "The resolved onboarding assignee's account could not be loaded.",
      "none_available",
      resolution.attempts,
    );
  }

  const result = await scheduler.bookSlot({
    page: resolution.page,
    host: {
      hostUserId: hostUser.id,
      hostEmail: hostUser.email,
      hostDisplayName:
        [hostUser.firstName, hostUser.lastName].filter(Boolean).join(" ") ||
        hostUser.email ||
        undefined,
    },
    invitee: req.invitee,
    startTimeUtc: req.startTimeUtc,
    source: "onboarding_pool",
    clientId: req.clientId ?? null,
    idempotencyKey: req.idempotencyKey,
    notes: req.notes,
    durationMinutes,
  });

  return { ...result, resolvedUserId: result.meeting.accountManagerUserId ?? resolution.userId };
}
