// @db-pool-intent: api
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import { writeLimiter, hasRole } from "./middleware";
import * as scheduler from "../services/bookingScheduler";
import {
  computeAvailableSlots,
  localDateKey,
  localTimeKey,
  CalendarBusyUnavailableError,
  checkOccurrencesAvailability,
} from "../services/bookingAvailability";
import {
  validateRecurrencePayload,
  expandRecurrence,
} from "../services/bookingRecurrence";
import { getBookingFeatureFlags } from "../services/bookingFeatureFlags";
import { getBookedMeetingsFeatureFlags } from "../services/bookedMeetingsFeatureFlags";
import {
  recurrencePayloadSchema,
  recurrenceExceptionScopes,
  type RecurrenceExceptionScope,
} from "@shared/schema";
import * as googleCalendar from "../services/googleCalendarIntegration";
import {
  generateOpaqueToken,
  hashOpaqueToken,
  signHmacPayload,
  verifyHmacPayload,
} from "../utils/tokenCrypto";
import { isGoogleCalendarConfigured } from "../services/googleCalendarIntegration";
import { checkBookingScopeReadiness } from "../services/zoomIntegration";
import * as zoomIntegration from "../services/zoomIntegration";
import * as bookingDbConstraints from "../services/bookingDbConstraints";
import {
  getBookingSchemaReadiness,
  isMissingBookingRelationError,
  recheckBookingSchemaReadiness,
} from "../services/bookingSchemaReadiness";
import type {
  BookingPage,
  InsertBookingAvailabilityRule,
  ScheduledMeeting,
  ScheduledMeetingStatus,
} from "@shared/schema";
import { users, publicAttributionSchema, cleanAttribution } from "@shared/schema";
import { eq } from "drizzle-orm";
import { getDb } from "../db";

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])?$/;

/**
 * Default weekly availability rules seeded for newly-created booking pages
 * (and back-filled for legacy pages that have never had any rules or
 * overrides configured): Mon–Fri 09:00–17:00 in the page's local timezone,
 * weekends remain unavailable. AMs can edit or remove any of these after
 * the fact via the Weekly Availability editor.
 */
function defaultWeeklyAvailabilityRules(
  bookingPageId: string,
): InsertBookingAvailabilityRule[] {
  return [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    bookingPageId,
    dayOfWeek,
    startTimeLocal: "09:00",
    endTimeLocal: "17:00",
    active: true,
  }));
}

async function seedDefaultAvailabilityRules(bookingPageId: string): Promise<void> {
  try {
    await storage.replaceAvailabilityRules(
      bookingPageId,
      defaultWeeklyAvailabilityRules(bookingPageId),
    );
  } catch (err) {
    // Non-fatal — the AM can always add windows manually. Log and move on.
    console.error("[Booking] Failed to seed default availability rules:", err);
  }
}

// Public booking endpoints get their own rate limiter — looser per-IP than
// authenticated routes since each AM has many anonymous visitors, but tight
// enough to defeat scrapers / brute-force booking attempts.
const publicBookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});

const publicBookingConfirmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many booking attempts. Please wait a moment." },
});

function getUserId(req: Request): string | null {
  const user = (req as any).user;
  return user?.claims?.sub || user?.id || null;
}

async function loadCurrentUser(req: Request) {
  const userId = getUserId(req);
  if (!userId) return null;
  return storage.getUser(userId);
}

function makeShareUrl(req: Request, slug: string): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = req.get("host");
  return `${proto}://${host}/book/${slug}`;
}

// ---------------------------------------------------------------------------
// Default booking page values (Task #887)
//
// An AM should be able to open the Schedule panel on a client and book a
// meeting without first manually saving a Booking Page in their Profile.
// `GET /api/booking/me/page` returns these defaults flagged with
// `isDefault: true` when no row exists yet, the settings card pre-fills
// from them, and the AM-side slot listing + book endpoints lazy-create
// the row using the same defaults so the public slug is reserved and the
// saga's `req.page` is real.
// ---------------------------------------------------------------------------

const DEFAULT_BOOKING_DURATION_MINUTES = 30;
const DEFAULT_BOOKING_BUFFER_MINUTES = 0;
const DEFAULT_BOOKING_TIMEZONE = "America/Chicago";

interface MinimalUser {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  timezone?: string | null;
}

/**
 * Suggest a public slug for an AM that hasn't picked one yet. Built from
 * their first/last name (preferred) or the local part of their email,
 * sanitized to the same alphabet `SLUG_RE` enforces. Falls back to
 * "user-<short-id>" if nothing usable can be derived. Caller is
 * responsible for de-duplicating against `getBookingPageBySlug`.
 */
function suggestSlugForUser(user: MinimalUser): string {
  const fromName = [user.firstName, user.lastName]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join("-");
  const fromEmail = (user.email || "").split("@")[0] || "";
  const raw = (fromName || fromEmail || "user").toLowerCase();
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (cleaned.length >= 3 && SLUG_RE.test(cleaned)) return cleaned;
  return `user-${user.id.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "ax"}`;
}

/** Build the unsaved default page object returned to the client when the
 *  AM has no booking_pages row yet. `id` is null so the client can tell
 *  it isn't persisted; `isDefault` is true for the same reason. */
export function buildDefaultBookingPageDraft(user: MinimalUser) {
  return {
    id: null as string | null,
    accountManagerUserId: user.id,
    slug: suggestSlugForUser(user),
    timezone: user.timezone || DEFAULT_BOOKING_TIMEZONE,
    durationMinutes: DEFAULT_BOOKING_DURATION_MINUTES,
    bufferBeforeMinutes: DEFAULT_BOOKING_BUFFER_MINUTES,
    bufferAfterMinutes: DEFAULT_BOOKING_BUFFER_MINUTES,
    active: true,
    // Recurring bookings are opt-in per page (Task #1032E). Default to
    // OFF for the lazy draft so the public surface stays one-off-only
    // until the AM explicitly turns the feature on in their settings.
    allowRecurring: false,
    // Spec asks for empty title/description on the lazy default so the
    // settings form renders with truly blank fields (a literal `null`
    // would be rendered as the string "null" by some controlled inputs).
    title: "",
    description: "",
    createdAt: null,
    updatedAt: null,
    isDefault: true,
  };
}

/**
 * Ensure the AM has a real booking_pages row. Used by AM-side endpoints
 * (slot listing, internal book) so the saga's `req.page` is a real row
 * with a reserved slug — the AM doesn't have to visit Profile first.
 *
 * Slug uniqueness: tries the suggested slug, then up to 6 random
 * suffixes. Concurrent first-uses race on the `account_manager_user_id`
 * unique constraint and either side falls back to re-fetching the
 * winner.
 */
export async function ensureBookingPage(user: MinimalUser): Promise<BookingPage> {
  const existing = await storage.getBookingPageByUserId(user.id);
  if (existing) return existing;

  const baseSlug = suggestSlugForUser(user);
  let slug = baseSlug;
  for (let i = 0; i < 6; i++) {
    const taken = await storage.getBookingPageBySlug(slug);
    if (!taken) break;
    if (taken.accountManagerUserId === user.id) {
      // Race-with-self — page already exists.
      return taken;
    }
    slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
  }

  try {
    const created = await storage.createBookingPage({
      accountManagerUserId: user.id,
      slug,
      timezone: user.timezone || DEFAULT_BOOKING_TIMEZONE,
      durationMinutes: DEFAULT_BOOKING_DURATION_MINUTES,
      bufferBeforeMinutes: DEFAULT_BOOKING_BUFFER_MINUTES,
      bufferAfterMinutes: DEFAULT_BOOKING_BUFFER_MINUTES,
      active: true,
      allowRecurring: false,
      title: null,
      description: null,
    });
    await seedDefaultAvailabilityRules(created.id);
    return created;
  } catch (err: any) {
    // Concurrent first-use — another request just created the row.
    // Re-fetch and return the winner instead of bubbling the unique
    // violation up to the caller.
    const winner = await storage.getBookingPageByUserId(user.id);
    if (winner) return winner;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const settingsSchema = z.object({
  slug: z.string().regex(SLUG_RE, "Slug must be lowercase alphanumeric with hyphens, 3-64 chars"),
  timezone: z.string().min(1).max(64),
  durationMinutes: z.number().int().min(15).max(240),
  bufferBeforeMinutes: z.number().int().min(0).max(120).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(120).default(0),
  active: z.boolean().default(true),
  // Per-page opt-in for recurring bookings on the public surface
  // (Task #1032E). Optional + defaults to false so older clients that
  // never POST it leave the page in single-event-only mode.
  allowRecurring: z.boolean().optional().default(false),
  title: z.string().max(120).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
});

const ruleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTimeLocal: z.string().regex(/^\d{2}:\d{2}$/),
  endTimeLocal: z.string().regex(/^\d{2}:\d{2}$/),
  active: z.boolean().default(true),
});

const overrideSchema = z.object({
  dateLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  isBlocked: z.boolean(),
  customStartTimeLocal: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  customEndTimeLocal: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  reason: z.string().max(500).optional().nullable(),
});

const confirmSchema = z.object({
  startTimeUtc: z.string().datetime(),
  invitee: z.object({
    email: z.string().email().max(254),
    name: z.string().max(120).optional(),
  }),
  notes: z.string().max(2000).optional(),
  // Honeypot — bots fill it, humans don't see it.
  website: z.string().max(0).optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
  signedToken: z.string().min(8).max(256).optional(),
  // Optional recurrence (Task #1032E). When omitted the booking is a
  // plain one-off — same shape as before. When present the saga's
  // recurrence path is invoked. Public confirms are additionally
  // gated by `bookingPage.allowRecurring`.
  recurrence: recurrencePayloadSchema.optional(),
  // Task #4337 — optional first-touch attribution captured by the public
  // booking page (utm_* from its URL + external referrer). Additive and
  // hard-capped; validation is not weakened.
  attribution: publicAttributionSchema.optional(),
});

// ---------------------------------------------------------------------------
// Public sanitization
// ---------------------------------------------------------------------------

function publicPageView(
  page: BookingPage,
  opts: { recurrenceFeatureEnabled?: boolean } = {},
) {
  // Task #1044: the public UI's recurrence picker is gated on the
  // page's own `allowRecurring` AND the global feature flags
  // (`booking_recurring_enabled` master + `booking_recurring_public_enabled`).
  // We compute the effective value here so the public response — and
  // therefore the rendered UI — can never disagree with what the
  // confirm endpoint will actually accept.
  const recurrenceFeatureEnabled = opts.recurrenceFeatureEnabled ?? true;
  return {
    id: page.id,
    slug: page.slug,
    timezone: page.timezone,
    durationMinutes: page.durationMinutes,
    title: page.title,
    description: page.description,
    active: page.active,
    // Exposed so the public booking UI (Task #1032G/H) can decide
    // whether to render the recurrence picker. Default-false rows
    // simply hide it — no breaking change for existing pages.
    allowRecurring: page.allowRecurring && recurrenceFeatureEnabled,
  };
}

// ---------------------------------------------------------------------------
// BookingError → HTTP mapping (Task #1032E). The saga uses a small set
// of codes; the public-API contract from the epic uses slightly more
// specific names for the recurrence path. We translate at the route
// boundary so the client gets the conventional status + epic code, and
// callers don't have to repeat this `switch` everywhere.
// ---------------------------------------------------------------------------
function bookingErrorToHttp(
  err: scheduler.BookingError,
  isRecurring: boolean,
): { status: number; code: string; message: string; details?: unknown; operatorDetail?: string } {
  const details = (err as any).details;
  switch (err.code) {
    case "slot_taken":
    case "slot_unavailable":
      return { status: 409, code: err.code, message: err.message };
    case "invalid_input":
      return { status: 400, code: err.code, message: err.message };
    case "not_found":
      return { status: 404, code: err.code, message: err.message };
    case "zoom_failure":
      return {
        status: 502,
        code: isRecurring ? "zoom_recurring_create_failed" : "zoom_failure",
        // Visitor-safe copy — the raw reason (auth gate text, invalid_grant
        // detail) is preserved in server logs and the operator alert only.
        message:
          "This host's video conferencing isn't available right now. Please try again shortly or contact your account manager.",
        operatorDetail: err.message,
      };
    case "calendar_failure":
      return {
        status: 502,
        code: isRecurring ? "google_recurring_create_failed" : "calendar_failure",
        message:
          "This host's calendar isn't available right now. Please try again shortly or contact your account manager.",
        operatorDetail: err.message,
      };
    case "recurrence_invalid":
      return {
        status: 400,
        code:
          typeof details?.code === "string"
            ? details.code
            : "recurrence_invalid_rrule",
        message: err.message,
        details,
      };
    case "recurrence_conflicts":
      return {
        status: 409,
        code: "recurrence_freebusy_conflict",
        message: err.message,
        details,
      };
    case "recurrence_expansion_failed": {
      const code =
        details && typeof details.code === "string"
          ? details.code
          : "recurrence_expansion_limit_exceeded";
      return { status: 400, code, message: err.message, details };
    }
    case "recurrence_disabled":
      // Task #1044: surfaced when a `system_settings` kill-switch
      // (master `booking_recurring_enabled` or per-orchestrator
      // `booking_recurring_edit_scopes_enabled`) is off. 403 — the
      // request was syntactically valid but administratively refused.
      return {
        status: 403,
        code: "recurrence_disabled",
        message: err.message,
        details,
      };
    case "internal_failure":
    default:
      return { status: 500, code: "internal_failure", message: err.message };
  }
}

/**
 * Project a `ScheduledMeeting` row into the slim `MeetingListItem`
 * shape consumed by the My Meetings console (Task #1064). Trims
 * server-only Zoom credentials (`zoomStartUrl`, `zoomMeetingUuid`)
 * that the UI doesn't need, normalizes Date columns to ISO strings,
 * and adds a derived `isRecurring` boolean so the panel can
 * conditionally show the scope picker without re-deriving the rule
 * everywhere.
 */
function toMeetingListItem(m: ScheduledMeeting) {
  return {
    id: m.id,
    clientId: m.clientId,
    accountManagerUserId: m.accountManagerUserId,
    bookingPageId: m.bookingPageId,
    meetingTypeId: m.meetingTypeId,
    meetingTypeName: m.meetingTypeName,
    bookingSource: m.bookingSource,
    inviteeName: m.inviteeName,
    inviteeEmail: m.inviteeEmail,
    startTimeUtc: m.startTimeUtc.toISOString(),
    endTimeUtc: m.endTimeUtc.toISOString(),
    timezone: m.timezone,
    status: m.status,
    failureReason: m.failureReason,
    zoomJoinUrl: m.zoomJoinUrl,
    googleCalendarEventId: m.googleCalendarEventId,
    googleCalendarEventUrl: m.googleCalendarEventUrl,
    googleCalendarId: m.googleCalendarId,
    recurrence: m.recurrence,
    recurrenceSummary: m.recurrenceSummary,
    recurrenceTimezone: m.recurrenceTimezone,
    seriesMasterId: m.seriesMasterId,
    recurringEventId: m.recurringEventId,
    originalStartTime: m.originalStartTime?.toISOString() ?? null,
    zoomRecurrenceMode: m.zoomRecurrenceMode,
    zoomRecurrenceFallbackReason: m.zoomRecurrenceFallbackReason,
    durationMinutes: Math.round(
      (m.endTimeUtc.getTime() - m.startTimeUtc.getTime()) / 60_000,
    ),
    isRecurring:
      !!m.recurringEventId ||
      !!m.seriesMasterId ||
      (m.recurrence?.length ?? 0) > 0,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerBookingRoutes(app: Express) {
  // -----------------------------------------------------------------------
  // AM-facing settings & management
  // -----------------------------------------------------------------------

  /** Get the current user's booking page (creates a draft if none yet). */
  app.get("/api/booking/me/page", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const readiness = getBookingSchemaReadiness();
      if (!readiness.tables.bookingPages) {
        return res.status(503).json({
          error: "booking_schema_not_ready",
          message: "Booking database tables are not installed.",
          operatorAction: "Apply booking migrations 0034-0036.",
        });
      }

      // Task #1044: surface the effective recurrence flag (master AND
      // internal) so the staff UI's recurrence toggle hides itself when
      // an admin has switched the feature off. The internal book route
      // also re-checks these flags, so a stale client cache cannot
      // bypass the gate.
      const flags = await getBookingFeatureFlags();
      const recurrenceFeatureEnabled = flags.master && flags.internal;
      const page = await storage.getBookingPageByUserId(user.id);
      if (page) {
        res.json({
          page: { ...page, isDefault: false },
          recurrenceFeatureEnabled,
        });
      } else {
        // Task #887: never block the AM with an empty form. The settings
        // card and the Schedule panel both pre-fill from these defaults
        // and the AM-side book / slot endpoints lazy-create the row on
        // first internal use.
        res.json({
          page: buildDefaultBookingPageDraft(user),
          recurrenceFeatureEnabled,
        });
      }
    } catch (err: any) {
      if (isMissingBookingRelationError(err)) {
        console.error("[Booking] Get my page — booking schema not ready:", err.message);
        return res.status(503).json({
          error: "booking_schema_not_ready",
          message: "Booking database tables are not installed.",
          operatorAction: "Apply booking migrations 0034-0036.",
        });
      }
      console.error("[Booking] Get my page error:", err);
      res.status(500).json({ error: "Failed to load booking page" });
    }
  });

  /** Create or update the current user's booking page. */
  app.put("/api/booking/me/page", isAuthenticated, writeLimiter, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const parsed = settingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid settings", details: parsed.error.flatten() });
      }
      const data = parsed.data;

      // Slug uniqueness — disallow stealing another user's slug.
      const existingForSlug = await storage.getBookingPageBySlug(data.slug);
      if (existingForSlug && existingForSlug.accountManagerUserId !== user.id) {
        return res.status(409).json({ error: "That URL is already taken. Please choose another." });
      }

      const mine = await storage.getBookingPageByUserId(user.id);
      let saved: BookingPage;
      if (mine) {
        saved = (await storage.updateBookingPage(mine.id, {
          slug: data.slug,
          timezone: data.timezone,
          durationMinutes: data.durationMinutes,
          bufferBeforeMinutes: data.bufferBeforeMinutes,
          bufferAfterMinutes: data.bufferAfterMinutes,
          active: data.active,
          allowRecurring: data.allowRecurring,
          title: data.title ?? null,
          description: data.description ?? null,
        }))!;
      } else {
        saved = await storage.createBookingPage({
          accountManagerUserId: user.id,
          slug: data.slug,
          timezone: data.timezone,
          durationMinutes: data.durationMinutes,
          bufferBeforeMinutes: data.bufferBeforeMinutes,
          bufferAfterMinutes: data.bufferAfterMinutes,
          active: data.active,
          allowRecurring: data.allowRecurring,
          title: data.title ?? null,
          description: data.description ?? null,
        });
        await seedDefaultAvailabilityRules(saved.id);
      }
      res.json({ page: saved, shareUrl: makeShareUrl(req, saved.slug) });
    } catch (err: any) {
      console.error("[Booking] Save my page error:", err);
      res.status(500).json({ error: "Failed to save booking page" });
    }
  });

  /** Get availability rules + overrides for the current user's page. */
  app.get("/api/booking/me/availability", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const page = await storage.getBookingPageByUserId(user.id);
      if (!page) return res.json({ rules: [], overrides: [] });
      let [rules, overrides] = await Promise.all([
        storage.listAvailabilityRules(page.id),
        storage.listAvailabilityOverrides(page.id),
      ]);
      // Back-fill defaults for legacy pages that pre-date the seeding logic
      // and have never been configured (no rules AND no overrides AND the
      // page is still active). A user who deliberately cleared their
      // schedule will normally either toggle the page inactive or leave at
      // least one override, so guarding on (active && no rules && no
      // overrides) keeps this a safe one-shot back-fill rather than a
      // re-seed loop.
      if (page.active && rules.length === 0 && overrides.length === 0) {
        await seedDefaultAvailabilityRules(page.id);
        rules = await storage.listAvailabilityRules(page.id);
      }
      res.json({ rules, overrides });
    } catch (err: any) {
      console.error("[Booking] Get availability error:", err);
      res.status(500).json({ error: "Failed to load availability" });
    }
  });

  /** Replace the entire weekly recurring rule set in one call. */
  app.put("/api/booking/me/availability/rules", isAuthenticated, writeLimiter, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const page = await storage.getBookingPageByUserId(user.id);
      if (!page) return res.status(400).json({ error: "Create a booking page first" });
      const parsed = z.array(ruleSchema).safeParse(req.body?.rules);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid rules", details: parsed.error.flatten() });
      }
      // Reject windows where end <= start.
      for (const r of parsed.data) {
        if (r.startTimeLocal >= r.endTimeLocal) {
          return res.status(400).json({ error: "Each window's end time must be after its start time" });
        }
      }
      const saved = await storage.replaceAvailabilityRules(
        page.id,
        parsed.data.map((r) => ({ ...r, bookingPageId: page.id })),
      );
      res.json({ rules: saved });
    } catch (err: any) {
      console.error("[Booking] Save rules error:", err);
      res.status(500).json({ error: "Failed to save rules" });
    }
  });

  app.post("/api/booking/me/availability/overrides", isAuthenticated, writeLimiter, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const page = await storage.getBookingPageByUserId(user.id);
      if (!page) return res.status(400).json({ error: "Create a booking page first" });
      const parsed = overrideSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid override", details: parsed.error.flatten() });
      }
      const saved = await storage.upsertAvailabilityOverride({
        bookingPageId: page.id,
        ...parsed.data,
      });
      res.json({ override: saved });
    } catch (err: any) {
      console.error("[Booking] Save override error:", err);
      res.status(500).json({ error: "Failed to save override" });
    }
  });

  app.delete("/api/booking/me/availability/overrides/:id", isAuthenticated, writeLimiter, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const page = await storage.getBookingPageByUserId(user.id);
      if (!page) return res.status(404).json({ error: "No booking page" });

      // Ownership check: the override must belong to THIS user's booking
      // page. Without this check any authenticated user could delete any
      // other AM's availability override by guessing its id.
      const override = await storage.getAvailabilityOverride(req.params.id);
      if (!override) return res.status(404).json({ error: "Override not found" });
      if (override.bookingPageId !== page.id) {
        return res.status(403).json({ error: "Not your override" });
      }

      await storage.deleteAvailabilityOverride(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[Booking] Delete override error:", err);
      res.status(500).json({ error: "Failed to delete override" });
    }
  });

  // -----------------------------------------------------------------------
  // Saved meeting types (Task #890) — small per-AM catalogue of named
  // presets (e.g. "Discovery 30min") rendered as one-click chips on the
  // Schedule panel.
  // -----------------------------------------------------------------------

  const meetingTypeSchema = z.object({
    name: z.string().trim().min(1, "Name is required").max(80),
    durationMinutes: z.number().int().min(15).max(240),
    bufferBeforeMinutes: z.number().int().min(0).max(120).default(0),
    bufferAfterMinutes: z.number().int().min(0).max(120).default(0),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  });

  app.get("/api/booking/me/meeting-types", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const types = await storage.listBookingMeetingTypes(user.id);
      res.json({ meetingTypes: types });
    } catch (err: any) {
      if (isMissingBookingRelationError(err)) {
        return res.status(503).json({
          error: "booking_schema_not_ready",
          message: "Booking database tables are not installed.",
          operatorAction: "Apply booking migrations 0034-0036 and 0044.",
        });
      }
      console.error("[Booking] List meeting types error:", err);
      res.status(500).json({ error: "Failed to load meeting types" });
    }
  });

  app.post(
    "/api/booking/me/meeting-types",
    isAuthenticated,
    writeLimiter,
    async (req: any, res) => {
      try {
        const user = await loadCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Not authenticated" });
        const parsed = meetingTypeSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid meeting type", details: parsed.error.flatten() });
        }
        try {
          const created = await storage.createBookingMeetingType({
            accountManagerUserId: user.id,
            name: parsed.data.name,
            durationMinutes: parsed.data.durationMinutes,
            bufferBeforeMinutes: parsed.data.bufferBeforeMinutes,
            bufferAfterMinutes: parsed.data.bufferAfterMinutes,
            sortOrder: parsed.data.sortOrder ?? 0,
          });
          res.json({ meetingType: created });
        } catch (err: any) {
          if (/unique/i.test(err?.message || "")) {
            return res.status(409).json({
              error: "You already have a meeting type with that name.",
              code: "duplicate_name",
            });
          }
          throw err;
        }
      } catch (err: any) {
        console.error("[Booking] Create meeting type error:", err);
        res.status(500).json({ error: "Failed to create meeting type" });
      }
    },
  );

  app.put(
    "/api/booking/me/meeting-types/:id",
    isAuthenticated,
    writeLimiter,
    async (req: any, res) => {
      try {
        const user = await loadCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Not authenticated" });
        const existing = await storage.getBookingMeetingType(req.params.id);
        if (!existing) return res.status(404).json({ error: "Meeting type not found" });
        if (existing.accountManagerUserId !== user.id) {
          return res.status(403).json({ error: "Not your meeting type" });
        }
        const parsed = meetingTypeSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid meeting type", details: parsed.error.flatten() });
        }
        try {
          const updated = await storage.updateBookingMeetingType(req.params.id, {
            name: parsed.data.name,
            durationMinutes: parsed.data.durationMinutes,
            bufferBeforeMinutes: parsed.data.bufferBeforeMinutes,
            bufferAfterMinutes: parsed.data.bufferAfterMinutes,
            sortOrder: parsed.data.sortOrder ?? existing.sortOrder,
          });
          res.json({ meetingType: updated });
        } catch (err: any) {
          if (/unique/i.test(err?.message || "")) {
            return res.status(409).json({
              error: "You already have a meeting type with that name.",
              code: "duplicate_name",
            });
          }
          throw err;
        }
      } catch (err: any) {
        console.error("[Booking] Update meeting type error:", err);
        res.status(500).json({ error: "Failed to update meeting type" });
      }
    },
  );

  app.delete(
    "/api/booking/me/meeting-types/:id",
    isAuthenticated,
    writeLimiter,
    async (req: any, res) => {
      try {
        const user = await loadCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Not authenticated" });
        const existing = await storage.getBookingMeetingType(req.params.id);
        if (!existing) return res.status(404).json({ error: "Meeting type not found" });
        if (existing.accountManagerUserId !== user.id) {
          return res.status(403).json({ error: "Not your meeting type" });
        }
        await storage.deleteBookingMeetingType(req.params.id);
        res.json({ success: true });
      } catch (err: any) {
        console.error("[Booking] Delete meeting type error:", err);
        res.status(500).json({ error: "Failed to delete meeting type" });
      }
    },
  );

  /**
   * GET /api/booking/me/meetings — Booked Meetings Console list (Task #1064).
   *
   * Cursor-paginated view of every NoBull-created meeting hosted by
   * the signed-in user. Replaces the prior naive
   * `{upcoming, recent}` shape with a proper paginated payload + filters
   * so the My Meetings tab on /profile can show 100s of meetings.
   *
   * Query params (all optional):
   *   - tense:    "upcoming" (default) | "past"
   *   - status:   comma-separated subset of {creating,confirmed,canceled,failed}
   *               Defaults: ["confirmed"] for upcoming, ["confirmed","canceled"] for past.
   *   - search:   free-text match against summary / invitee email / invitee name
   *   - clientId: filter by linked client
   *   - limit:    1..200, default 25
   *   - cursor:   `<startTimeUtcIso>|<id>` from a previous page's `nextCursor`
   *
   * Response: `{ items: MeetingListItem[], nextCursor: string|null }`.
   *
   * Gated by the `booked_meetings_console_enabled` system_setting kill
   * switch (default ON). Per-meeting PATCH/DELETE on `/api/booking/:id`
   * are NOT gated by this flag — admins can still operate on individual
   * rows even with the console disabled.
   */
  app.get("/api/booking/me/meetings", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const flags = await getBookedMeetingsFeatureFlags();
      if (!flags.console) {
        return res.status(403).json({
          error:
            "The Booked Meetings console is currently disabled by an administrator.",
          code: "console_disabled",
        });
      }

      const querySchema = z.object({
        tense: z.enum(["upcoming", "past"]).default("upcoming"),
        status: z.string().optional(),
        search: z.string().max(200).optional(),
        clientId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(25),
        cursor: z.string().min(1).max(200).optional(),
      });
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid query", details: parsed.error.flatten() });
      }

      const allowedStatuses: ScheduledMeetingStatus[] = [
        "creating",
        "confirmed",
        "canceled",
        "failed",
      ];
      let statuses: ScheduledMeetingStatus[] | undefined;
      if (parsed.data.status) {
        const requested = parsed.data.status
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean) as ScheduledMeetingStatus[];
        statuses = requested.filter((s) => allowedStatuses.includes(s));
      } else {
        statuses =
          parsed.data.tense === "upcoming"
            ? ["confirmed"]
            : ["confirmed", "canceled"];
      }

      let cursor: { startTimeUtc: string; id: string } | null = null;
      if (parsed.data.cursor) {
        const idx = parsed.data.cursor.indexOf("|");
        if (idx > 0) {
          const startIso = parsed.data.cursor.slice(0, idx);
          const id = parsed.data.cursor.slice(idx + 1);
          if (id && !Number.isNaN(new Date(startIso).getTime())) {
            cursor = { startTimeUtc: startIso, id };
          }
        }
      }

      const page = await storage.listScheduledMeetingsForUser(user.id, {
        tense: parsed.data.tense,
        status: statuses,
        search: parsed.data.search,
        clientId: parsed.data.clientId,
        limit: parsed.data.limit,
        cursor,
      });

      res.json({
        items: page.items.map(toMeetingListItem),
        nextCursor: page.nextCursor
          ? `${page.nextCursor.startTimeUtc}|${page.nextCursor.id}`
          : null,
      });
    } catch (err: any) {
      console.error("[Booking] List my meetings error:", err);
      res.status(500).json({ error: "Failed to load meetings" });
    }
  });

  /**
   * GET /api/booking/me/meetings/:id — single meeting detail for the
   * console drawer. Owner-only; admins (`team_lead+`) can view a
   * colleague's meeting. Returns the full ScheduledMeeting row plus
   * the recurrence exception list when the row is a series master.
   */
  app.get(
    "/api/booking/me/meetings/:id",
    isAuthenticated,
    async (req: any, res) => {
      try {
        const user = await loadCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Not authenticated" });

        const flags = await getBookedMeetingsFeatureFlags();
        if (!flags.console) {
          return res.status(403).json({
            error:
              "The Booked Meetings console is currently disabled by an administrator.",
            code: "console_disabled",
          });
        }

        const m = await storage.getScheduledMeetingById(req.params.id);
        if (!m) return res.status(404).json({ error: "Meeting not found" });
        const isAdminOverride = hasRole(user.role, "team_lead");
        if (!isAdminOverride && m.accountManagerUserId !== user.id) {
          return res.status(403).json({ error: "Not your meeting" });
        }

        // Gather exceptions for the master (or the parent master if this
        // row is itself a sibling). One-off meetings get an empty list.
        let exceptions: any[] = [];
        const masterId = m.seriesMasterId || (m.recurringEventId ? m.id : null);
        if (masterId) {
          try {
            exceptions =
              await storage.listMeetingRecurrenceExceptionsForMaster(masterId);
          } catch (e) {
            // Non-fatal: detail still useful without exception list.
            console.warn(
              "[Booking] Could not load exceptions for meeting detail:",
              (e as Error).message,
            );
          }
        }

        res.json({
          meeting: toMeetingListItem(m),
          raw: m,
          exceptions,
        });
      } catch (err: any) {
        console.error("[Booking] Meeting detail error:", err);
        res.status(500).json({ error: "Failed to load meeting" });
      }
    },
  );

  /** Cancel a meeting I host. */
  app.post("/api/booking/me/meetings/:id/cancel", isAuthenticated, writeLimiter, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const m = await storage.getScheduledMeetingById(req.params.id);
      if (!m) return res.status(404).json({ error: "Meeting not found" });
      if (m.accountManagerUserId !== user.id) {
        return res.status(403).json({ error: "Not your meeting" });
      }
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
      const updated = await scheduler.cancelBooking(req.params.id, reason);
      res.json({ meeting: updated });
    } catch (err: any) {
      console.error("[Booking] Cancel meeting error:", err);
      res.status(500).json({ error: "Failed to cancel meeting" });
    }
  });

  // -----------------------------------------------------------------------
  // Google Calendar OAuth (per-AM)
  // -----------------------------------------------------------------------

  app.get("/api/integrations/google-calendar/status", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const status = await googleCalendar.getStatus(user.id);
      // Task #1033: one-time backfill — for users who connected before
      // this shipped (or whose seed previously failed), opportunistically
      // seed their display timezone from Google Calendar settings.
      // Skipped silently if the user already picked one explicitly.
      if (status.connected) {
        googleCalendar
          .seedDisplayTimezoneFromGoogleCalendar(user.id)
          .catch(() => {});
      }
      res.json(status);
    } catch (err: any) {
      console.error("[Booking/Calendar] Status error:", err);
      res.status(500).json({ error: err.message || "Failed to load Calendar status" });
    }
  });

  app.get("/api/integrations/google-calendar/authorize", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!isGoogleCalendarConfigured()) {
        return res.status(503).json({ error: "Google Calendar OAuth is not configured. Add GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET in Secrets." });
      }
      const url = await googleCalendar.getAuthorizationUrl(user.id);
      res.json({ url });
    } catch (err: any) {
      console.error("[Booking/Calendar] Authorize error:", err);
      res.status(500).json({ error: err.message || "Failed to start OAuth" });
    }
  });

  app.get("/api/integrations/google-calendar/callback", async (req, res) => {
    try {
      const code = String(req.query.code || "");
      const state = String(req.query.state || "");
      if (!code || !state) return res.status(400).send("Missing code or state");
      const v = await googleCalendar.validateOAuthState(state);
      if (!v.valid || !v.userId) return res.status(400).send("Invalid OAuth state");
      await googleCalendar.exchangeCodeForToken(v.userId, code);
      // Task #1033: seed the user's display timezone from their Google
      // Calendar account on first connect so AMs don't have to hand-pick
      // it. Best-effort — a failure here doesn't break the connect flow.
      googleCalendar
        .seedDisplayTimezoneFromGoogleCalendar(v.userId)
        .catch(() => {});
      // Bounce the AM back to the booking settings page.
      const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
      res.redirect(`${proto}://${req.get("host")}/profile?calendar=connected`);
    } catch (err: any) {
      console.error("[Booking/Calendar] Callback error:", err);
      // Redirect back to the booking settings page with an error flag
      // instead of leaving the user on a raw 500 page. The settings
      // panel listens for `?calendar=error` and surfaces a toast +
      // refetches the status query so the AM can immediately retry.
      const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
      res.redirect(`${proto}://${req.get("host")}/profile?calendar=error`);
    }
  });

  app.post("/api/integrations/google-calendar/disconnect", isAuthenticated, writeLimiter, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      await googleCalendar.disconnect(user.id);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[Booking/Calendar] Disconnect error:", err);
      res.status(500).json({ error: err.message || "Failed to disconnect" });
    }
  });

  // Spec Done line 33: AM can choose the target calendar (defaults to
  // primary). Returns the writable calendars on the connected
  // credential so the settings UI can render a picker.
  app.get("/api/booking/me/calendars", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const cred = await storage.getGoogleCalendarCredential(user.id);
      if (!cred || cred.status !== "connected") {
        return res
          .status(409)
          .json({ error: "Connect Google Calendar before selecting a calendar." });
      }
      const calendars = await googleCalendar.listCalendars(user.id);
      res.json({ calendars, selectedCalendarId: cred.calendarId || "primary" });
    } catch (err: any) {
      console.error("[Booking/Calendar] List calendars error:", err);
      res.status(500).json({ error: err.message || "Failed to load calendars" });
    }
  });

  // Persist the AM's chosen target calendar id. The booking saga and
  // free/busy lookups already read `cred.calendarId` so this single
  // write is the only mutation required to switch targets.
  app.put("/api/booking/me/calendar", isAuthenticated, writeLimiter, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const calendarId = String(req.body?.calendarId || "").trim();
      if (!calendarId || calendarId.length > 256) {
        return res.status(400).json({ error: "Invalid calendarId" });
      }
      const cred = await storage.getGoogleCalendarCredential(user.id);
      if (!cred || cred.status !== "connected") {
        return res
          .status(409)
          .json({ error: "Connect Google Calendar before selecting a calendar." });
      }
      // Validate the chosen id is one of the writable calendars on this
      // credential — prevents a stale UI from saving an id the AM no
      // longer has writer access to (which would silently fail at
      // event-insert time inside the saga).
      const calendars = await googleCalendar.listCalendars(user.id);
      const allowed = new Set(calendars.map((c) => c.id));
      if (!allowed.has(calendarId)) {
        return res.status(400).json({
          error:
            "Selected calendar is not writable on the connected Google account.",
        });
      }
      const updated = await storage.updateGoogleCalendarCredential(user.id, {
        calendarId,
      });
      res.json({
        selectedCalendarId: updated?.calendarId || calendarId,
      });
    } catch (err: any) {
      console.error("[Booking/Calendar] Set calendar error:", err);
      res.status(500).json({ error: err.message || "Failed to update calendar" });
    }
  });

  // Per-AM setup readiness. Spec step 7: "Show setup readiness
  // checks: Google Calendar connected, Zoom host mapped, booking page
  // active, availability configured." This powers the readiness card
  // on `BookingSettingsPanel` so an operator can verify their booking
  // chain end-to-end before going live.
  app.get("/api/booking/me/readiness", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      // Calendar — connected per the persisted credential status.
      const cred = await storage.getGoogleCalendarCredential(user.id);
      const calendar = {
        configured: googleCalendar.isGoogleCalendarConfigured(),
        connected: !!cred && cred.status === "connected",
        status: cred?.status || "disconnected",
        selectedCalendarId: cred?.calendarId || "primary",
      };

      // Zoom host mapping — does Zoom recognize a user that can host
      // scheduled meetings on this AM's behalf? Task #932 (929C):
      // resolution goes through the canonical effective-host resolver
      // so this endpoint and the booking saga always agree on the
      // identity. `source` is surfaced so 929E can render
      // "Mapped to <email>" vs "Auto-resolved from app email".
      //
      // Task #934 (929E): we additionally classify the failure mode
      // with a stable `code` so the admin UI can branch on it:
      //   - `ok`                       → mapped (override or app_email)
      //   - `zoom_host_not_mapped`     → no Zoom user found → CTA to set override
      //   - `zoom_unreachable`         → Zoom API call failed (transient)
      //   - `no_user_email`            → account has no email and no override
      const effective =
        await zoomIntegration.resolveEffectiveZoomHostForUser(user);
      let zoomHostCode: "ok" | "zoom_host_not_mapped" | "zoom_unreachable" | "no_user_email";
      let zoomHostClassification: "transient" | "configuration" | "auth" | null;
      if (effective.source !== "none") {
        zoomHostCode = "ok";
        zoomHostClassification = null;
      } else if (!user.email && !user.zoomHostOverrideEmail && !user.zoomHostOverrideUserId) {
        zoomHostCode = "no_user_email";
        zoomHostClassification = "configuration";
      } else if (
        effective.error &&
        /unreachable|network|timed out|fetch failed|ECONN|5\d\d/i.test(effective.error) &&
        !/no zoom user/i.test(effective.error)
      ) {
        zoomHostCode = "zoom_unreachable";
        zoomHostClassification = "transient";
      } else {
        zoomHostCode = "zoom_host_not_mapped";
        zoomHostClassification = "configuration";
      }
      const zoomHost: {
        mapped: boolean;
        source: "override" | "app_email" | "none";
        zoomUserId?: string;
        email?: string | null;
        error?: string;
        code: typeof zoomHostCode;
        classification: typeof zoomHostClassification;
      } = {
        mapped: effective.source !== "none",
        source: effective.source,
        zoomUserId: effective.zoomUserId,
        email: effective.zoomEmail || user.email || null,
        error: effective.error,
        code: zoomHostCode,
        classification: zoomHostClassification,
      };

      // Booking page — exists and is active.
      const page = await storage.getBookingPageByUserId(user.id);
      const bookingPage = {
        exists: !!page,
        active: !!page?.active,
        slug: page?.slug || null,
      };

      // Availability — at least one weekly rule (otherwise no slots
      // will ever be offered).
      let availability: { hasRules: boolean; ruleCount: number } = {
        hasRules: false,
        ruleCount: 0,
      };
      if (page) {
        const rules = await storage.listAvailabilityRules(page.id);
        availability = { hasRules: rules.length > 0, ruleCount: rules.length };
      }

      const ready =
        calendar.connected &&
        zoomHost.mapped &&
        bookingPage.active &&
        availability.hasRules;

      res.json({ ready, calendar, zoomHost, bookingPage, availability });
    } catch (err: any) {
      console.error("[Booking] Readiness error:", err);
      res.status(500).json({ error: err.message || "Failed to load readiness" });
    }
  });

  // -----------------------------------------------------------------------
  // Admin slot preview (Task #934 / 929E).
  //
  // The booking-settings panel previously hit the *public* slots endpoint
  // to render its preview, which meant admins saw the same generic public
  // copy ("calendar service is unreachable") instead of the actionable
  // diagnostic they need. This authenticated endpoint reuses the same
  // `computeAvailableSlots` engine but, on failure, returns a typed
  // **admin diagnostic envelope**:
  //
  //   { error, code, classification, httpStatus?, reason?, retriable? }
  //
  // `code` is one of:
  //   - `calendar_reauth_required`  (auth)          — Reconnect Google CTA
  //   - `calendar_unavailable`      (transient)     — Retry CTA
  //   - `endpoint_misrouted`        (configuration) — request-shape bug from 929D
  //   - `booking_schema_not_ready`  (configuration) — operator must apply migrations
  //   - `internal_error`            (transient)     — fall-through
  //
  // The admin-only fields (`httpStatus`, `reason`, `classification`) are
  // emitted only on this authenticated path; the public `/api/book/:slug/slots`
  // endpoint is intentionally untouched so anonymous bookers continue to
  // see the existing generic copy.
  // -----------------------------------------------------------------------
  app.get("/api/booking/me/slots-preview", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const schemaReadiness = getBookingSchemaReadiness();
      if (!schemaReadiness.tables.bookingPages) {
        return res.status(503).json({
          error: "Booking database tables are not installed.",
          code: "booking_schema_not_ready",
          classification: "configuration",
          operatorAction: "Apply booking migrations 0034-0036.",
        });
      }

      // Lazy-create so the preview works even before the AM has saved
      // their booking page — same affordance as the AM-side
      // `/api/booking/clients/:clientId/slots` endpoint.
      const page = await ensureBookingPage(user);

      const fromUtc = new Date();
      const toUtc = new Date(fromUtc.getTime() + 14 * 24 * 60 * 60 * 1000);
      // Task #2286 — a slots preview is a non-authoritative read; tag the
      // calendar busy lookup as `probe` so a transient auth blip can't
      // durably disconnect the AM's still-valid calendar.
      const slots = await computeAvailableSlots(page, {
        fromUtc,
        toUtc,
        calendarRefreshPurpose: "probe",
      });

      res.json({
        timezone: page.timezone,
        slots: slots.map((s) => ({
          startUtc: s.startUtc.toISOString(),
          endUtc: s.endUtc.toISOString(),
        })),
      });
    } catch (err: any) {
      if (err instanceof CalendarBusyUnavailableError) {
        if (!err.transient) {
          // Either a dead credential (`calendar_reauth_required`) or a
          // request-shape bug from 929D (`endpoint_misrouted`). They
          // need different CTAs — Reconnect vs "report a bug" — so we
          // distinguish them at the wire.
          const isMisrouted =
            err.transportClassification === "endpoint_misrouted" ||
            err.transportClassification === "non_json_response";
          if (isMisrouted) {
            console.error(
              `[Booking] Admin slot preview misrouted: userId=${err.userId} reason=${err.reason} httpStatus=${err.httpStatus}`,
            );
            return res.status(502).json({
              error:
                "Calendar request was misrouted (Google returned a non-JSON response). This is a server-side request configuration bug — check server logs and report.",
              code: "endpoint_misrouted",
              classification: "configuration",
              httpStatus: err.httpStatus,
              reason: err.reason,
              retriable: false,
            });
          }
          console.warn(
            `[Booking] Admin slot preview reauth-required: userId=${err.userId} reason=${err.reason}`,
          );
          return res.status(409).json({
            error:
              "Your Google Calendar needs to be reconnected before slots can be offered.",
            code: "calendar_reauth_required",
            classification: "auth",
            httpStatus: err.httpStatus,
            reason: err.reason,
            retriable: false,
          });
        }
        console.warn(
          "[Booking] Admin slot preview transient calendar failure:",
          err.message,
        );
        return res.status(503).json({
          error:
            "Could not load your calendar availability right now. Try again in a moment.",
          code: "calendar_unavailable",
          classification: "transient",
          httpStatus: err.httpStatus,
          reason: err.reason,
          retriable: true,
        });
      }
      if (isMissingBookingRelationError(err)) {
        console.error(
          "[Booking] Admin slot preview — booking schema not ready:",
          err.message,
        );
        return res.status(503).json({
          error: "Booking database tables are not installed.",
          code: "booking_schema_not_ready",
          classification: "configuration",
          operatorAction: "Apply booking migrations 0034-0036.",
        });
      }
      console.error("[Booking] Admin slot preview error:", err);
      res.status(500).json({
        error: err.message || "Failed to load slot preview",
        code: "internal_error",
        classification: "transient",
        retriable: true,
      });
    }
  });

  // -----------------------------------------------------------------------
  // Per-user Zoom host override (Task #931 / 929B).
  //
  // The AM's app-login email frequently does not match their Zoom user
  // email, which makes the readiness check report "No Zoom user found
  // for this email" and silently breaks booking creation. These three
  // endpoints let the AM persist (and clear) an explicit override that
  // 929C will read from the canonical effective-host resolver.
  //
  // GET    — return the current override + last validation metadata so
  //          the UI can render "Mapped to <email> (validated 3 days
  //          ago)", "Override in use", or the "no host found" CTA.
  // PUT    — set the override after validating against Zoom. If Zoom
  //          returns no user we respond with `zoom_host_override_invalid`
  //          and DO NOT persist anything.
  // DELETE — clear the override, returning the AM to the auto-resolve
  //          fallback (lookup by `users.email`).
  //
  // Operates on the current user only; gated by `isAuthenticated`. The
  // PUT path uses `writeLimiter` consistent with every other booking
  // write endpoint above.
  // -----------------------------------------------------------------------

  // Build the GET response payload. Includes the persisted override
  // values + last validation metadata + the *effective* host state so
  // 929E can render every UX state in a single roundtrip:
  //   - `effective.mode = "override"` → "Override in use, mapped to <email>"
  //   - `effective.mode = "auto"`     → "Auto-resolved host: <email>"
  //   - `effective.mode = "none"`     → "No host found — set an override" CTA
  // When `effective.mode = "none"`, `effective.errorCode` carries the
  // reason ("no_user_email" | "zoom_host_override_invalid" |
  // "zoom_unreachable") so the UI can pick the right sub-message.
  async function buildZoomHostOverridePayload(user: any) {
    const overrideEmail: string | null = user.zoomHostOverrideEmail || null;
    const overrideUserId: string | null = user.zoomHostOverrideUserId || null;
    const inUse = !!(overrideEmail || overrideUserId);

    let effective: {
      mode: "override" | "auto" | "none";
      zoomUserId?: string;
      zoomEmail?: string;
      displayName?: string;
      errorCode?: string;
      errorMessage?: string;
    };

    // Task #932 (929C): route all effective-host resolution through
    // the canonical helper so this payload, the readiness card, and
    // the booking saga can never disagree. We translate the helper's
    // `source` into the GET endpoint's existing `mode` contract +
    // legacy `errorCode` values that 929E will rework.
    if (!inUse && !user.email) {
      effective = {
        mode: "none",
        errorCode: "no_user_email",
        errorMessage: "Account has no email — set an override to enable booking.",
      };
    } else {
      const resolved = await zoomIntegration.resolveEffectiveZoomHostForUser(user);
      if (resolved.source === "override") {
        effective = {
          mode: "override",
          zoomUserId: resolved.zoomUserId,
          zoomEmail: resolved.zoomEmail,
          displayName: resolved.displayName,
        };
      } else if (resolved.source === "app_email") {
        effective = {
          mode: "auto",
          zoomUserId: resolved.zoomUserId,
          zoomEmail: resolved.zoomEmail,
          displayName: resolved.displayName,
        };
      } else {
        const isUnreachable = /zoom/i.test(resolved.error || "") &&
          !/no zoom user/i.test(resolved.error || "");
        effective = {
          mode: "none",
          errorCode: isUnreachable
            ? "zoom_unreachable"
            : "zoom_host_override_invalid",
          errorMessage: isUnreachable
            ? resolved.error || "Zoom user lookup failed."
            : "No Zoom user found for your account email. Set an override to map your Zoom identity.",
        };
      }
    }

    return {
      overrideInUse: inUse,
      override: inUse
        ? {
            email: overrideEmail,
            zoomUserId: overrideUserId,
          }
        : null,
      lastValidatedAt: user.zoomHostOverrideValidatedAt
        ? (user.zoomHostOverrideValidatedAt as Date).toISOString()
        : null,
      lastValidatedZoomEmail: user.zoomHostOverrideValidatedEmail || null,
      lastValidatedDisplayName: user.zoomHostOverrideDisplayName || null,
      autoResolveEmail: user.email || null,
      effective,
    };
  }

  app.get("/api/booking/me/zoom-host", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      res.json(await buildZoomHostOverridePayload(user));
    } catch (err: any) {
      console.error("[Booking/ZoomHost] Get error:", err);
      res.status(500).json({ error: err.message || "Failed to load Zoom host override" });
    }
  });

  // List active Zoom users on the connected account so the AM can pick
  // the right host from a dropdown instead of typing an email that may
  // not match Zoom's records. Uses the existing `user:read:list_users:admin`
  // scope that the OAuth flow already requests. Failures (auth/scope
  // gate, transient) come back as `{ users: [], error, code }` so the
  // panel can degrade gracefully to the free-text input.
  app.get("/api/booking/me/zoom-account-users", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      try {
        const users = await zoomIntegration.listAllAccountUsers();
        const sorted = users
          .map((u) => ({
            id: u.id,
            email: (u.email || "").toLowerCase(),
            name: u.name || "",
          }))
          .filter((u) => !!u.id && !!u.email)
          .sort((a, b) => a.email.localeCompare(b.email));
        res.json({ users: sorted });
      } catch (err: any) {
        const msg = err?.message || "Failed to list Zoom users";
        let code: string;
        if (err?.kind === "scope") {
          code = "zoom_scope_missing";
        } else if (err?.kind === "auth") {
          code = "zoom_auth_required";
        } else if (
          /not connected|no (?:access )?token|refresh.*fail|reconnect/i.test(msg)
        ) {
          code = "zoom_auth_required";
        } else {
          code = "zoom_unreachable";
        }
        res.json({ users: [], error: msg, code });
      }
    } catch (err: any) {
      console.error("[Booking/ZoomHost] List users error:", err);
      res.status(500).json({ error: err.message || "Failed to list Zoom users" });
    }
  });

  const zoomHostOverrideSchema = z
    .object({
      email: z.string().trim().email().max(254).optional(),
      zoomUserId: z.string().trim().min(1).max(64).optional(),
    })
    .refine((v) => !!v.email || !!v.zoomUserId, {
      message: "Provide an email and/or a Zoom user id",
    });

  app.put(
    "/api/booking/me/zoom-host",
    isAuthenticated,
    writeLimiter,
    async (req: any, res) => {
      // Stage-tagged error logging so a 500 from this endpoint pinpoints
      // exactly which step failed (auth load, schema parse, Zoom
      // validation, DB update, or response shaping). Without this the
      // generic catch swallows the call site and we have to guess.
      let stage: "load_user" | "parse" | "validate" | "update" | "build_payload" =
        "load_user";
      try {
        const user = await loadCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Not authenticated" });
        if (!user.id) {
          console.error("[Booking/ZoomHost] Put error: loaded user has no id", {
            userKeys: Object.keys(user),
          });
          return res.status(500).json({
            error: "Authenticated user is missing an id",
            code: "zoom_host_override_missing_user_id",
          });
        }

        stage = "parse";
        const parsed = zoomHostOverrideSchema.safeParse(req.body || {});
        if (!parsed.success) {
          return res.status(400).json({
            error: parsed.error.issues[0]?.message || "Invalid request body",
            code: "zoom_host_override_invalid_input",
          });
        }

        stage = "validate";
        // Validate against Zoom BEFORE we persist. The helper returns
        // a typed discriminated-union result; we map each error code
        // to a stable HTTP response so 929E can branch on it. The
        // user row is NEVER touched on a non-ok result.
        const validated = await zoomIntegration.validateZoomHostOverride({
          email: parsed.data.email,
          zoomUserId: parsed.data.zoomUserId,
        });
        if (!validated.ok) {
          if (validated.code === "zoom_unreachable") {
            return res.status(502).json({
              error: validated.message,
              code: validated.code,
            });
          }
          return res.status(400).json({
            error: validated.message,
            code: validated.code,
          });
        }

        stage = "update";
        const [updated] = await getDb()
          .update(users)
          .set({
            zoomHostOverrideEmail: parsed.data.email || null,
            // Always persist the canonical Zoom user id returned by
            // the validator (never the raw input) so a row can never
            // contain an unverified id alongside the verified email.
            zoomHostOverrideUserId: validated.zoomUserId,
            zoomHostOverrideValidatedAt: new Date(),
            zoomHostOverrideValidatedEmail: validated.zoomEmail,
            zoomHostOverrideDisplayName: validated.displayName || null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id))
          .returning();

        // Mirror the DELETE handler's defensive fallback: if the UPDATE
        // returned 0 rows for any reason (replica lag, transient write
        // pool quirk) we still have the validated values + the in-memory
        // `user` row, so we can construct a coherent response instead of
        // dereferencing `undefined.zoomHostOverrideEmail` and 500-ing.
        const effectiveRow =
          updated ||
          ({
            ...user,
            zoomHostOverrideEmail: parsed.data.email || null,
            zoomHostOverrideUserId: validated.zoomUserId,
            zoomHostOverrideValidatedAt: new Date(),
            zoomHostOverrideValidatedEmail: validated.zoomEmail,
            zoomHostOverrideDisplayName: validated.displayName || null,
          } as typeof user);
        if (!updated) {
          console.error(
            "[Booking/ZoomHost] Put: UPDATE returned 0 rows — row missing or write rolled back",
            { userId: user.id },
          );
        }

        stage = "build_payload";
        res.json(await buildZoomHostOverridePayload(effectiveRow));
      } catch (err: any) {
        console.error(`[Booking/ZoomHost] Put error at stage=${stage}:`, {
          message: err?.message,
          code: err?.code,
          name: err?.name,
          stack: err?.stack,
        });
        res.status(500).json({
          error: err?.message || "Failed to save Zoom host override",
          stage,
        });
      }
    },
  );

  app.delete(
    "/api/booking/me/zoom-host",
    isAuthenticated,
    writeLimiter,
    async (req: any, res) => {
      try {
        const user = await loadCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Not authenticated" });

        const [updated] = await getDb()
          .update(users)
          .set({
            zoomHostOverrideEmail: null,
            zoomHostOverrideUserId: null,
            zoomHostOverrideValidatedAt: null,
            zoomHostOverrideValidatedEmail: null,
            zoomHostOverrideDisplayName: null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id))
          .returning();

        res.json(await buildZoomHostOverridePayload(updated || user));
      } catch (err: any) {
        console.error("[Booking/ZoomHost] Delete error:", err);
        res.status(500).json({ error: err.message || "Failed to clear Zoom host override" });
      }
    },
  );

  // -----------------------------------------------------------------------
  // Client-bound public links (issued by AMs)
  // -----------------------------------------------------------------------

  /** Issue a one-time client-bound public link. */
  app.post("/api/booking/me/client-links", isAuthenticated, writeLimiter, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { clientId, expiresInDays } = req.body || {};
      if (!clientId || typeof clientId !== "string") {
        return res.status(400).json({ error: "clientId is required" });
      }
      const client = await storage.getClient(clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      // Same access policy as /api/clients/:id and the other client-scoped
      // booking endpoints. Without this, any authenticated user could mint
      // a working booking token bound to any client they don't own.
      const isCeo = user.role === "ceo";
      if (client.isDemo && !isCeo) {
        return res.status(404).json({ error: "Client not found" });
      }
      if (!hasRole(user.role, "account_manager") && client.ownerId !== user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      const page = await storage.getBookingPageByUserId(user.id);
      if (!page) return res.status(400).json({ error: "Create your booking page first" });

      const opaque = generateOpaqueToken(32);
      const ttlDays = Math.min(Math.max(Number(expiresInDays) || 14, 1), 90);
      const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

      const stored = await storage.createBookingClientToken({
        tokenHash: hashOpaqueToken(opaque),
        clientId,
        accountManagerUserId: user.id,
        bookingPageId: page.id,
        expiresAt,
        createdByUserId: user.id,
      });

      const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
      const url = `${proto}://${req.get("host")}/book/${page.slug}/client/${opaque}`;
      res.json({
        token: { id: stored.id, expiresAt: stored.expiresAt },
        url,
      });
    } catch (err: any) {
      console.error("[Booking] Issue client link error:", err);
      res.status(500).json({ error: "Failed to create client link" });
    }
  });

  // -----------------------------------------------------------------------
  // Public booking endpoints
  // -----------------------------------------------------------------------

  // Public booking endpoints. Spec requires `/api/book/:slug/...` —
  // we register both the spec path AND the historical
  // `/api/public/booking/:slug/...` path on the same handler so the
  // contract is satisfied without breaking anything that already
  // points at the legacy URL.
  app.get(["/api/book/:slug", "/api/public/booking/:slug"], publicBookingLimiter, async (req, res) => {
    try {
      const slug = String(req.params.slug || "").toLowerCase();
      if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "Invalid slug" });
      const page = await storage.getBookingPageBySlug(slug);
      if (!page || !page.active) return res.status(404).json({ error: "Booking page not found" });
      const am = await storage.getUser(page.accountManagerUserId);
      // Privacy: do NOT expose the AM's email on this public, no-auth
      // endpoint — it would let any visitor scrape host email
      // addresses by enumerating slugs. The displayName is sufficient
      // for the booking UI (the system sends confirmation emails on
      // the host's behalf, so the invitee never needs the address
      // upfront). The email is still used server-side as a fallback
      // when no first/last name is set so the page never renders an
      // empty host label.
      // Task #1044: combine the page's own `allowRecurring` with the
      // global feature flags so the public UI never advertises a
      // picker the confirm endpoint would refuse.
      const flags = await getBookingFeatureFlags();
      res.json({
        page: publicPageView(page, {
          recurrenceFeatureEnabled: flags.master && flags.public,
        }),
        host: am
          ? {
              displayName:
                [am.firstName, am.lastName].filter(Boolean).join(" ") ||
                am.email ||
                "Your host",
            }
          : null,
      });
    } catch (err: any) {
      console.error("[Booking] Public page error:", err);
      res.status(500).json({ error: "Failed to load booking page" });
    }
  });

  app.get(["/api/book/:slug/slots", "/api/public/booking/:slug/slots"], publicBookingLimiter, async (req, res) => {
    try {
      const slug = String(req.params.slug || "").toLowerCase();
      if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "Invalid slug" });
      const page = await storage.getBookingPageBySlug(slug);
      if (!page || !page.active) return res.status(404).json({ error: "Booking page not found" });

      const fromStr = String(req.query.from || "");
      const toStr = String(req.query.to || "");
      const fromUtc = fromStr ? new Date(fromStr) : new Date();
      const toUtc = toStr
        ? new Date(toStr)
        : new Date(fromUtc.getTime() + 14 * 24 * 60 * 60 * 1000);
      if (Number.isNaN(fromUtc.getTime()) || Number.isNaN(toUtc.getTime())) {
        return res.status(400).json({ error: "Invalid from/to dates (must be ISO-8601)" });
      }
      // Cap at 90 days to bound query cost while still allowing
      // multi-month booking horizons from the AM panel and public page.
      const cappedTo = new Date(
        Math.min(toUtc.getTime(), fromUtc.getTime() + 90 * 24 * 60 * 60 * 1000),
      );

      // Visitor's IANA timezone (e.g. "Europe/Berlin"). The frontend renders
      // each slot's clock time in this timezone, so we must also compute the
      // `dateLocal` grouping key in this timezone — otherwise a 11pm host-TZ
      // slot can be displayed under the previous day's header in the
      // visitor's TZ. Validated via Intl.DateTimeFormat below to reject
      // garbage / injection attempts.
      let viewerTimezone = String(req.query.viewerTimezone || "").trim();
      if (viewerTimezone) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: viewerTimezone });
        } catch {
          viewerTimezone = "";
        }
      }
      // Build a "virtual page" with the viewer's TZ so the existing helpers
      // produce viewer-local date keys without polluting the real page row.
      const groupingPage = viewerTimezone
        ? ({ ...page, timezone: viewerTimezone } as BookingPage)
        : page;

      const slots = await computeAvailableSlots(page, {
        fromUtc,
        toUtc: cappedTo,
        // Task #2286 — non-authoritative preview; see route above.
        calendarRefreshPurpose: "probe",
      });

      res.json({
        timezone: page.timezone,
        viewerTimezone: viewerTimezone || null,
        slots: slots.map((s) => ({
          startUtc: s.startUtc.toISOString(),
          endUtc: s.endUtc.toISOString(),
          dateLocal: localDateKey(groupingPage, s.startUtc),
          timeLocal: localTimeKey(groupingPage, s.startUtc),
        })),
      });
    } catch (err: any) {
      // Fail-closed translation: if the AM is connected but Google
      // free/busy is unreachable, we cannot safely list slots without
      // risking offering a busy interval. Return 503 with an explicit
      // retriable error so the booking page can surface "try again
      // shortly" rather than silently rendering an unsafe slot list.
      if (err instanceof CalendarBusyUnavailableError) {
        if (!err.transient) {
          // Permanent credential failure — the AM must reconnect their
          // calendar before any retry can succeed. Public visitors get
          // a generic message (we never leak the AM's Google reason
          // to anonymous bookers).
          console.warn(
            `[Booking] Public slots reauth-required (calendar credential dead): userId=${err.userId} reason=${err.reason}`,
          );
          return res.status(409).json({
            error:
              "This host's calendar isn't connected right now. Please try again later or contact them directly.",
            code: "calendar_reauth_required",
            retriable: false,
          });
        }
        console.warn("[Booking] Public slots fail-closed (calendar unreachable):", err.message);
        return res.status(503).json({
          error:
            "Could not load this host's availability right now (calendar service is unreachable). Please try again in a moment.",
          code: "calendar_unavailable",
          retriable: true,
        });
      }
      if (isMissingBookingRelationError(err)) {
        console.error("[Booking] Public slots — booking schema not ready:", err.message);
        return res.status(503).json({
          error: "booking_schema_not_ready",
          message: "Booking database tables are not installed.",
          operatorAction: "Apply booking migrations 0034-0036.",
        });
      }
      console.error("[Booking] Public slots error:", err);
      res.status(500).json({ error: "Failed to load slots" });
    }
  });

  // Resolve a client-bound signed token without confirming a booking yet.
  // The public booking page hits this on mount when /book/:slug/client/:token
  // is loaded so it can show the client's name + pre-fill the invitee form
  // without leaking the token-validity decision into the (rate-limited)
  // confirm endpoint.
  app.get(
    [
      // Spec path uses `/client/:signedToken`; the legacy
      // `/client-token/:signedToken` is kept as an alias for back-compat.
      "/api/book/:slug/client/:signedToken",
      "/api/public/booking/:slug/client-token/:signedToken",
    ],
    publicBookingLimiter,
    async (req, res) => {
      try {
        const slug = String(req.params.slug || "").toLowerCase();
        if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "Invalid slug" });
        const signedToken = String(req.params.signedToken || "");
        if (!signedToken || signedToken.length < 8 || signedToken.length > 256) {
          return res.status(400).json({ error: "Invalid token" });
        }
        const page = await storage.getBookingPageBySlug(slug);
        if (!page || !page.active) return res.status(404).json({ error: "Booking page not found" });

        const row = await storage.findBookingClientTokenByHash(
          hashOpaqueToken(signedToken),
        );
        if (!row || row.bookingPageId !== page.id) {
          return res.status(400).json({
            valid: false,
            code: "invalid_client_link",
            error: "This booking link is invalid.",
          });
        }
        if (row.usedAt) {
          return res.status(409).json({
            valid: false,
            code: "client_link_already_used",
            error: "This booking link has already been used.",
          });
        }
        if (row.expiresAt <= new Date()) {
          return res.status(410).json({
            valid: false,
            code: "client_link_expired",
            error: "This booking link has expired.",
          });
        }

        const client = await storage.getClient(row.clientId);
        // Public response — never expose internal client.id or AM
        // identifiers. Return only the display fields the booking page
        // actually needs to greet the client and pre-fill the form.
        res.json({
          valid: true,
          expiresAt: row.expiresAt.toISOString(),
          client: client
            ? {
                firmName: client.firmName,
                contactName: client.contactName,
                contactEmail: client.contactEmail,
              }
            : null,
        });
      } catch (err: any) {
        console.error("[Booking] Token resolution error:", err);
        res.status(500).json({ error: "Failed to resolve booking link" });
      }
    },
  );

  app.post(["/api/book/:slug/confirm", "/api/public/booking/:slug/confirm"], publicBookingConfirmLimiter, async (req, res) => {
    try {
      const slug = String(req.params.slug || "").toLowerCase();
      if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "Invalid slug" });
      const page = await storage.getBookingPageBySlug(slug);
      if (!page || !page.active) return res.status(404).json({ error: "Booking page not found" });
      const am = await storage.getUser(page.accountManagerUserId);
      // Task #932 (929C): the AM may not have an app email but may
      // still have a validated Zoom host override. The booking saga
      // resolves the effective host via `resolveEffectiveZoomHostForUser`
      // and will refuse the booking with `zoom_failure` if neither the
      // override nor the email maps to a Zoom user.
      if (!am || (!am.email && !am.zoomHostOverrideEmail && !am.zoomHostOverrideUserId)) {
        return res.status(500).json({ error: "Booking page is misconfigured" });
      }

      const parsed = confirmSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      }
      const data = parsed.data;
      if (data.website && data.website.length > 0) {
        // Honeypot tripped — silently 200 to avoid signaling bots.
        return res.status(200).json({ status: "ok" });
      }

      let clientId: string | null = null;
      let source: "public_link" | "client_bound_public_link" = "public_link";
      let clientTokenId: string | null = null;
      if (data.signedToken) {
        // Client-bound link semantics are strict: if the token is present
        // it MUST be valid, scoped to this page, unexpired, and unused.
        // Silently downgrading to a public booking would break the
        // guaranteed client→meeting linkage that downstream deterministic
        // attribution depends on.
        const row = await storage.findBookingClientTokenByHash(
          hashOpaqueToken(data.signedToken),
        );
        if (!row || row.bookingPageId !== page.id) {
          return res.status(400).json({
            error: "This booking link is invalid.",
            code: "invalid_client_link",
          });
        }
        if (row.usedAt) {
          return res.status(409).json({
            error: "This booking link has already been used. Ask your account manager to send a new one.",
            code: "client_link_already_used",
          });
        }
        if (row.expiresAt <= new Date()) {
          return res.status(410).json({
            error: "This booking link has expired. Ask your account manager to send a new one.",
            code: "client_link_expired",
          });
        }
        clientId = row.clientId;
        source = "client_bound_public_link";
        clientTokenId = row.id;
        // NOTE: we deliberately DO NOT mark the token used here. We mark
        // it used only after `scheduler.bookSlot()` returns successfully,
        // so a failed booking (slot race, Zoom failure, Calendar failure,
        // validation conflict) doesn't burn the link and the client can
        // simply retry with another slot. The atomic "burn" lives in
        // markBookingClientTokenUsed (UPDATE ... WHERE used_at IS NULL),
        // which guarantees that even if two requests race past the check
        // above, only one succeeds in claiming the token.
      }

      // Recurrence is opt-in per page on the public surface
      // (Task #1032E). Reject before doing any expensive work so a
      // page that hasn't enabled the feature can't be tricked into
      // creating a series via a hand-rolled payload.
      let normalizedRecurrence:
        | NonNullable<Parameters<typeof scheduler.bookSlot>[0]["recurrence"]>
        | undefined;
      if (data.recurrence) {
        if (!page.allowRecurring) {
          return res.status(403).json({
            error: "This booking page does not allow recurring meetings.",
            code: "recurrence_not_allowed",
          });
        }
        // Task #1044: per-surface kill switches. The saga has its own
        // master-flag gate; we duplicate the public + master check
        // here so the response code is the conventional 403 with the
        // canonical `recurrence_disabled` code, before any expensive
        // saga work runs.
        const featureFlags = await getBookingFeatureFlags();
        if (!featureFlags.master || !featureFlags.public) {
          return res.status(403).json({
            error: "Recurring meetings are currently disabled by an administrator.",
            code: "recurrence_disabled",
            details: {
              flag: !featureFlags.master
                ? "booking_recurring_enabled"
                : "booking_recurring_public_enabled",
            },
          });
        }
        const validation = validateRecurrencePayload(data.recurrence);
        if (!validation.ok) {
          return res.status(400).json({
            error: validation.message,
            code: validation.code,
          });
        }
        normalizedRecurrence = validation.normalized;
      }

      try {
        const result = await scheduler.bookSlot({
          page,
          host: {
            hostUserId: am.id,
            hostEmail: am.email,
            hostDisplayName: [am.firstName, am.lastName].filter(Boolean).join(" ") || am.email || undefined,
          },
          invitee: { email: data.invitee.email, name: data.invitee.name },
          startTimeUtc: new Date(data.startTimeUtc),
          source,
          clientId,
          idempotencyKey: data.idempotencyKey,
          notes: data.notes,
          recurrence: normalizedRecurrence,
          // Task #4337 — raw first-touch capture ("" → NULL); persisted on
          // the meeting row, normalized at lead-stamp time.
          attribution: data.attribution ? cleanAttribution(data.attribution) : undefined,
        });

        // Booking succeeded — now atomically burn the client-bound token,
        // if one was supplied. If the burn fails because another concurrent
        // request beat us to it, we roll back our just-confirmed booking
        // so the client doesn't end up with two scheduled meetings off
        // the same single-use link.
        if (clientTokenId) {
          const burned = await storage.markBookingClientTokenUsed(
            clientTokenId,
          );
          if (!burned) {
            await scheduler.cancelBooking(
              result.meeting.id,
              "client_link_already_used_concurrently",
            );
            return res.status(409).json({
              error:
                "This booking link was used by another request at the same time. Ask your account manager to send a new one.",
              code: "client_link_already_used",
            });
          }
        }

        // Public response — never expose AM-internal calendar metadata
        // (calendarEventUrl) or any other private host data. The booker
        // only needs the join URL and a confirmation timestamp.
        res.json({
          status: "confirmed",
          meetingId: result.meeting.id,
          startTimeUtc: result.meeting.startTimeUtc,
          endTimeUtc: result.meeting.endTimeUtc,
          joinUrl: result.joinUrl,
          recurrence: result.recurrence
            ? {
                occurrenceCount: result.recurrence.occurrenceCount,
                truncated: result.recurrence.truncated,
                summary: result.recurrence.summary,
                timezone: result.recurrence.timezone,
              }
            : undefined,
        });

        // Recovery re-arm: a successful booking proves the integration is
        // healthy again. Clear any persisted host-auth outage flags for this
        // slug so the next failure will trigger a fresh alert. Best-effort.
        void (async () => {
          try {
            await Promise.allSettled([
              storage.setSystemSetting(`booking:auth-outage:zoom_failure:${slug}`, ""),
              storage.setSystemSetting(`booking:auth-outage:calendar_failure:${slug}`, ""),
            ]);
          } catch {
            // Non-fatal — outage flag clear failure doesn't affect the booking.
          }
        })();
      } catch (err: any) {
        if (err instanceof scheduler.BookingError) {
          const mapped = bookingErrorToHttp(err, !!normalizedRecurrence);

          // Host integration auth failures: log the detailed reason for
          // operators (never send to the visitor) and fire a deduped alert
          // so the AM/admins learn about the outage without a client complaint.
          //
          // Dedupe semantics: one alert per ONGOING OUTAGE, re-armed on
          // recovery. A persisted outage flag in system_settings keyed by
          // (err.code, slug) tracks streak state. The flag is set on the
          // first failure (triggering one alert) and suppresses subsequent
          // alerts while the outage persists. The successful-booking path
          // clears the flag (recovery re-arm) so the next failure alerts
          // again. This is independent of whether anyone reads the in-app
          // notification — reading/archiving the bell entry does not re-arm.
          const isHostAuthFailure =
            err.code === "zoom_failure" || err.code === "calendar_failure";
          if (isHostAuthFailure && mapped.operatorDetail) {
            const provider = err.code === "zoom_failure" ? "Zoom" : "Calendar";
            console.warn(
              `[Booking] Host integration auth failure (${provider}) on slug="${slug}" — operator detail: ${mapped.operatorDetail}`,
            );
            // Fire-and-forget: never block the visitor response.
            void (async () => {
              try {
                const outageKey = `booking:auth-outage:${err.code}:${slug}`;
                // Check whether an outage was already flagged for this
                // (provider, slug) pair. A truthy value means an alert
                // was already sent during the current outage streak; skip.
                const existingRow = await storage.getSystemSetting(outageKey).catch(() => null);
                const alreadyActive = !!(existingRow?.value);
                if (alreadyActive) {
                  // Outage streak in progress — alert already sent, suppress.
                  return;
                }

                // First failure in this outage streak: mark active, then alert.
                await storage.setSystemSetting(outageKey, "1");

                const { notifyUser } = await import(
                  "../services/notifications/userInbox"
                );
                const { getResponsibleAdminsForAlert } = await import(
                  "../services/notifications/recipients"
                );
                const amId = page.accountManagerUserId;
                const admins = await getResponsibleAdminsForAlert();
                const title = `${provider} disconnected — bookings on "${slug}" are failing`;
                const body =
                  `A visitor could not book on page "${slug}" because ${provider} ` +
                  `is not connected. Reconnect ${provider} in Integrations or Booking settings ` +
                  `to restore bookings. Detail: ${mapped.operatorDetail}`;
                const deepLink = "/admin/integrations";
                const recipients = Array.from(
                  new Set([amId, ...admins].filter(Boolean) as string[]),
                );
                for (const uid of recipients) {
                  try {
                    await notifyUser(uid, {
                      category: "system",
                      title,
                      body,
                      deepLink,
                      // No dedupeKey here — the outage flag above is the
                      // single-alert gate; each recipient gets one notification
                      // per outage streak regardless of read state.
                      metadata: {
                        provider: err.code,
                        slug,
                        operatorDetail: mapped.operatorDetail,
                      },
                    });
                  } catch (notifyErr: any) {
                    console.warn(
                      `[Booking] auth-alert notifyUser(${uid}) failed: ${notifyErr?.message ?? notifyErr}`,
                    );
                  }
                }
              } catch (alertErr: any) {
                console.warn(
                  `[Booking] Host auth alert dispatch failed: ${alertErr?.message ?? alertErr}`,
                );
              }
            })();
          }

          return res.status(mapped.status).json({
            error: mapped.message,
            code: mapped.code,
            ...(mapped.details ? { details: mapped.details } : {}),
          });
        }
        throw err;
      }
    } catch (err: any) {
      console.error("[Booking] Confirm error:", err);
      res.status(500).json({ error: "Failed to confirm booking" });
    }
  });

  // -----------------------------------------------------------------------
  // AM "book on behalf of client" endpoint (used from client profile)
  // -----------------------------------------------------------------------

  /**
   * AM-side slot listing for the Schedule panel on a client view (Task
   * #887). Unlike the public `/api/book/:slug/slots` endpoint, this one:
   *
   *  - Requires authentication and enforces the same per-client access
   *    model as `/api/booking/clients/:clientId/book`.
   *  - Lazily creates the AM's booking page on first internal use so
   *    the AM doesn't need to set one up in Profile first.
   *  - Accepts optional `durationMinutes` / `bufferBeforeMinutes` /
   *    `bufferAfterMinutes` overrides so the AM can preview slots for a
   *    longer / shorter / differently-buffered meeting before booking.
   *    The same effective values must be sent on the subsequent
   *    book mutation so the saga uses the same numbers it offered.
   *
   * Public `/api/book/:slug/slots` is intentionally unchanged — public
   * invitees still see the AM's saved page values.
   */
  app.get("/api/booking/clients/:clientId/slots", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const client = await storage.getClient(req.params.clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const isCeo = user.role === "ceo";
      if (client.isDemo && !isCeo) {
        return res.status(404).json({ error: "Client not found" });
      }
      if (!hasRole(user.role, "account_manager") && client.ownerId !== user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      const readiness = getBookingSchemaReadiness();
      if (!readiness.tables.bookingPages) {
        return res.status(503).json({
          error: "booking_schema_not_ready",
          message: "Booking database tables are not installed.",
          operatorAction: "Apply booking migrations 0034-0036.",
        });
      }

      const querySchema = z.object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        viewerTimezone: z.string().max(64).optional(),
        durationMinutes: z.coerce.number().int().min(15).max(240).optional(),
        bufferBeforeMinutes: z.coerce.number().int().min(0).max(120).optional(),
        bufferAfterMinutes: z.coerce.number().int().min(0).max(120).optional(),
      });
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid query", details: parsed.error.flatten() });
      }
      const q = parsed.data;

      const fromUtc = q.from ? new Date(q.from) : new Date();
      const toUtc = q.to
        ? new Date(q.to)
        : new Date(fromUtc.getTime() + 14 * 24 * 60 * 60 * 1000);
      if (Number.isNaN(fromUtc.getTime()) || Number.isNaN(toUtc.getTime())) {
        return res.status(400).json({ error: "Invalid from/to dates (must be ISO-8601)" });
      }
      // Cap at 90 days to bound query cost, mirroring the public endpoint.
      const cappedTo = new Date(
        Math.min(toUtc.getTime(), fromUtc.getTime() + 90 * 24 * 60 * 60 * 1000),
      );

      let viewerTimezone = (q.viewerTimezone || "").trim();
      if (viewerTimezone) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: viewerTimezone });
        } catch {
          viewerTimezone = "";
        }
      }

      // Lazy-create the AM's booking page on first internal use so the
      // saga / availability rules / public slug all exist before the AM
      // actually books.
      const page = await ensureBookingPage(user);

      // Effective page applies any per-meeting overrides for slot
      // computation. We never persist these — they're a per-request
      // preview only.
      const effectivePage: BookingPage = {
        ...page,
        durationMinutes: q.durationMinutes ?? page.durationMinutes,
        bufferBeforeMinutes:
          q.bufferBeforeMinutes ?? page.bufferBeforeMinutes,
        bufferAfterMinutes:
          q.bufferAfterMinutes ?? page.bufferAfterMinutes,
      };

      const groupingPage = viewerTimezone
        ? ({ ...effectivePage, timezone: viewerTimezone } as BookingPage)
        : effectivePage;

      const slots = await computeAvailableSlots(effectivePage, {
        fromUtc,
        toUtc: cappedTo,
        // Task #2286 — non-authoritative preview; see route above.
        calendarRefreshPurpose: "probe",
      });

      res.json({
        timezone: effectivePage.timezone,
        viewerTimezone: viewerTimezone || null,
        durationMinutes: effectivePage.durationMinutes,
        bufferBeforeMinutes: effectivePage.bufferBeforeMinutes,
        bufferAfterMinutes: effectivePage.bufferAfterMinutes,
        slots: slots.map((s) => ({
          startUtc: s.startUtc.toISOString(),
          endUtc: s.endUtc.toISOString(),
          dateLocal: localDateKey(groupingPage, s.startUtc),
          timeLocal: localTimeKey(groupingPage, s.startUtc),
        })),
      });
    } catch (err: any) {
      // Same fail-closed translation as the public slot endpoint — if
      // the AM is connected to Calendar but free/busy is unreachable,
      // we can't safely list slots without risking offering a busy
      // interval. 503 + retriable code so the UI can recover gracefully.
      if (err instanceof CalendarBusyUnavailableError) {
        if (!err.transient) {
          // AM-facing route — surface the verbatim Google reason so
          // the AM understands *why* their connection is dead before
          // clicking Reconnect. The credential status was already
          // flipped server-side by `calendarRequest`, so the booking
          // settings card will show the matching state on next
          // refetch.
          console.warn(
            `[Booking] AM client slots reauth-required: userId=${err.userId} reason=${err.reason}`,
          );
          return res.status(409).json({
            error:
              "Your Google Calendar needs to be reconnected before bookings can be scheduled.",
            code: "calendar_reauth_required",
            reason: err.reason,
            retriable: false,
          });
        }
        console.warn(
          "[Booking] AM client slots fail-closed (calendar unreachable):",
          err.message,
        );
        return res.status(503).json({
          error:
            "Could not load your calendar availability right now. Please try again in a moment.",
          code: "calendar_unavailable",
          retriable: true,
        });
      }
      if (isMissingBookingRelationError(err)) {
        console.error(
          "[Booking] AM client slots — booking schema not ready:",
          err.message,
        );
        return res.status(503).json({
          error: "booking_schema_not_ready",
          message: "Booking database tables are not installed.",
          operatorAction: "Apply booking migrations 0034-0036.",
        });
      }
      console.error("[Booking] AM client slots error:", err);
      res.status(500).json({ error: "Failed to load slots" });
    }
  });

  app.post("/api/booking/clients/:clientId/book", isAuthenticated, writeLimiter, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const client = await storage.getClient(req.params.clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      // Match the access model used by /api/clients/:id — demo clients are
      // CEO-only, and AMs without account_manager+ role can only act on
      // clients they own.
      const isCeo = user.role === "ceo";
      if (client.isDemo && !isCeo) {
        return res.status(404).json({ error: "Client not found" });
      }
      if (!hasRole(user.role, "account_manager") && client.ownerId !== user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Task #932 (929C): allow override-only booking. If the AM has
      // no app email but has set a validated Zoom host override, the
      // canonical resolver in the saga will use it.
      if (!user.email && !user.zoomHostOverrideEmail && !user.zoomHostOverrideUserId) {
        return res.status(400).json({
          error:
            "Your account has no email and no Zoom host override — set a Zoom host override in Booking settings to book.",
        });
      }
      // Task #887: lazy-create the AM's booking page on first internal
      // use so the AM doesn't have to visit Profile and save a page
      // before they can book on a client's behalf. The saga's `req.page`
      // must be a real persisted row (it owns availability rules, the
      // public slug reservation, and is FK-referenced by
      // scheduled_meetings).
      const page = await ensureBookingPage(user);

      const parsed = z.object({
        startTimeUtc: z.string().datetime(),
        inviteeEmail: z.string().email(),
        inviteeName: z.string().max(120).optional(),
        notes: z.string().max(2000).optional(),
        idempotencyKey: z.string().min(8).max(128).optional(),
        // Per-meeting overrides — same bounds as the page settings
        // schema so the saga's effective page can never violate the
        // limits the rest of the system enforces.
        durationMinutes: z.number().int().min(15).max(240).optional(),
        bufferBeforeMinutes: z.number().int().min(0).max(120).optional(),
        bufferAfterMinutes: z.number().int().min(0).max(120).optional(),
        // Optional saved meeting type (Task #890). When present we
        // verify ownership and use its values as the effective
        // overrides so the booked row records which preset was used.
        meetingTypeId: z.string().min(1).optional(),
        // Optional recurrence (Task #1032E). Internal staff bookings
        // are NOT gated by `page.allowRecurring` — that flag exists
        // only to control the public surface.
        recurrence: recurrencePayloadSchema.optional(),
      }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      }

      // If a meeting type was picked, look it up, verify it belongs to
      // this AM, and let its values override anything the client sent —
      // we trust the saved preset over a possibly-stale chip click.
      let meetingTypeRow: Awaited<ReturnType<typeof storage.getBookingMeetingType>> | undefined;
      if (parsed.data.meetingTypeId) {
        meetingTypeRow = await storage.getBookingMeetingType(parsed.data.meetingTypeId);
        if (!meetingTypeRow || meetingTypeRow.accountManagerUserId !== user.id) {
          return res.status(400).json({ error: "Invalid meeting type", code: "invalid_meeting_type" });
        }
      }

      const effectiveDuration = meetingTypeRow?.durationMinutes ?? parsed.data.durationMinutes;
      const effectiveBufferBefore = meetingTypeRow?.bufferBeforeMinutes ?? parsed.data.bufferBeforeMinutes;
      const effectiveBufferAfter = meetingTypeRow?.bufferAfterMinutes ?? parsed.data.bufferAfterMinutes;

      // Validate recurrence (if present) at the API boundary so the
      // saga's contract — caller passes already-normalized recurrence —
      // is honored. No `allowRecurring` gate on the staff path.
      let normalizedRecurrence:
        | NonNullable<Parameters<typeof scheduler.bookSlot>[0]["recurrence"]>
        | undefined;
      if (parsed.data.recurrence) {
        // Task #1044: internal-surface kill switches. Mirrors the
        // public-confirm gate above; saga also re-checks the master
        // flag, but failing fast here gives a 403 with the canonical
        // code before any saga work runs.
        const featureFlags = await getBookingFeatureFlags();
        if (!featureFlags.master || !featureFlags.internal) {
          return res.status(403).json({
            error:
              "Recurring meetings are currently disabled by an administrator.",
            code: "recurrence_disabled",
            details: {
              flag: !featureFlags.master
                ? "booking_recurring_enabled"
                : "booking_recurring_internal_enabled",
            },
          });
        }
        const validation = validateRecurrencePayload(parsed.data.recurrence);
        if (!validation.ok) {
          return res
            .status(400)
            .json({ error: validation.message, code: validation.code });
        }
        normalizedRecurrence = validation.normalized;
      }

      try {
        const result = await scheduler.bookSlot({
          page,
          host: {
            hostUserId: user.id,
            hostEmail: user.email,
            hostDisplayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || undefined,
          },
          invitee: { email: parsed.data.inviteeEmail, name: parsed.data.inviteeName },
          startTimeUtc: new Date(parsed.data.startTimeUtc),
          source: "client_profile",
          clientId: client.id,
          idempotencyKey: parsed.data.idempotencyKey,
          notes: parsed.data.notes,
          durationMinutes: effectiveDuration,
          bufferBeforeMinutes: effectiveBufferBefore,
          bufferAfterMinutes: effectiveBufferAfter,
          meetingTypeId: meetingTypeRow?.id ?? null,
          meetingTypeName: meetingTypeRow?.name ?? null,
          recurrence: normalizedRecurrence,
        });
        res.json({
          status: "confirmed",
          meeting: result.meeting,
          joinUrl: result.joinUrl,
          calendarEventUrl: result.calendarEventUrl,
          recurrence: result.recurrence ?? undefined,
        });
      } catch (err: any) {
        if (err instanceof scheduler.BookingError) {
          const mapped = bookingErrorToHttp(err, !!normalizedRecurrence);
          return res.status(mapped.status).json({
            error: mapped.message,
            code: mapped.code,
            ...(mapped.details ? { details: mapped.details } : {}),
          });
        }
        throw err;
      }
    } catch (err: any) {
      console.error("[Booking] AM book error:", err);
      res.status(500).json({ error: "Failed to book meeting" });
    }
  });

  app.get("/api/booking/clients/:clientId/meetings", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const client = await storage.getClient(req.params.clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      // Same access model as /api/clients/:id — without this, any
      // authenticated user could enumerate any client's meeting history.
      const isCeo = user.role === "ceo";
      if (client.isDemo && !isCeo) {
        return res.status(404).json({ error: "Client not found" });
      }
      if (!hasRole(user.role, "account_manager") && client.ownerId !== user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      const readiness = getBookingSchemaReadiness();
      if (!readiness.tables.scheduledMeetings) {
        return res.status(503).json({
          error: "booking_schema_not_ready",
          message: "Booking database tables are not installed.",
          operatorAction: "Apply booking migrations 0034-0036.",
        });
      }

      const meetings = await storage.listScheduledMeetingsForClient(req.params.clientId);
      res.json({ meetings });
    } catch (err: any) {
      if (isMissingBookingRelationError(err)) {
        console.error("[Booking] Client meetings — booking schema not ready:", err.message);
        return res.status(503).json({
          error: "booking_schema_not_ready",
          message: "Booking database tables are not installed.",
          operatorAction: "Apply booking migrations 0034-0036.",
        });
      }
      console.error("[Booking] Client meetings error:", err);
      res.status(500).json({ error: "Failed to load meetings" });
    }
  });

  // -----------------------------------------------------------------------
  // Admin reporting (Task #840 T009)
  // -----------------------------------------------------------------------

  app.get("/api/admin/booking/health", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      // Same access pattern as other admin endpoints — team_lead+ only.
      if (user.role !== "team_lead" && user.role !== "ceo" && user.role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }
      // Run the four reads in parallel — none of them depend on each other,
      // and `checkBookingScopeReadiness` does a real Zoom API roundtrip so
      // we don't want to serialize behind it.
      const [stats, allPages, allCreds, zoomScopeStatus] = await Promise.all([
        storage.getScheduledMeetingMatchStats(30),
        storage.listBookingPages({ active: true }),
        storage.listGoogleCalendarCredentials(),
        checkBookingScopeReadiness().catch((err) => ({
          ready: false,
          missing: [],
          errors: { _check: err?.message || String(err) },
        })),
      ]);

      const failed =
        stats.byStatus.find((s) => s.status === "failed")?.count ?? 0;
      const confirmed =
        stats.byStatus.find((s) => s.status === "confirmed")?.count ?? 0;
      const canceled =
        stats.byStatus.find((s) => s.status === "canceled")?.count ?? 0;

      // AM-level readiness rollups so an admin can immediately see how many
      // account managers can actually take a booking right now.
      const amsWithActivePages = new Set(
        allPages.map((p) => p.accountManagerUserId),
      );
      const amsConnectedToCalendar = new Set(
        allCreds.filter((c) => c.status === "connected").map((c) => c.userId),
      );
      const amsMissingCalendar = Array.from(amsWithActivePages).filter(
        (uid) => !amsConnectedToCalendar.has(uid),
      ).length;
      const calendarStatusBreakdown = allCreds.reduce<Record<string, number>>(
        (acc, c) => {
          acc[c.status] = (acc[c.status] || 0) + 1;
          return acc;
        },
        {},
      );

      // DB-level guards status — surfaced so an admin can see whether
      // the deterministic no-double-booking + one-page-per-AM invariants
      // are actually backed by the database (vs. only by the
      // application-level advisory lock). If `ready` is false here, the
      // booking saga is running in a degraded mode and ops needs to
      // re-run the migration / restart the server.
      const dbConstraints = bookingDbConstraints.getBookingDbConstraintStatus();

      // Schema readiness snapshot (Task #865) — surfaces whether the
      // booking tables exist and the unique/overlap constraints are
      // installed so the admin UI can show a single red/green tile and
      // an actionable operatorAction string when something regresses.
      const schemaReadiness = getBookingSchemaReadiness();
      const schemaOperatorAction = schemaReadiness.ready
        ? null
        : "Apply booking migrations 0034-0036.";

      res.json({
        bookings: {
          totalLast30Days: stats.totalLast30Days,
          confirmed,
          failed,
          canceled,
          byStatus: stats.byStatus,
          bySource: stats.bySource,
          byMatchMethod: stats.byMatchMethod,
        },
        accountManagers: {
          withActivePage: amsWithActivePages.size,
          connectedToCalendar: amsConnectedToCalendar.size,
          missingCalendar: amsMissingCalendar,
          calendarStatusBreakdown,
        },
        zoom: {
          scopesValid: zoomScopeStatus.ready,
          missingScopes: zoomScopeStatus.missing,
          errors: zoomScopeStatus.errors,
        },
        dbConstraints,
        schemaReadiness: {
          ...schemaReadiness,
          operatorAction: schemaOperatorAction,
        },
        calendarConfigured: googleCalendar.isGoogleCalendarConfigured(),
      });
    } catch (err: any) {
      console.error("[Booking] Admin health error:", err);
      res.status(500).json({ error: "Failed to load booking health" });
    }
  });

  // Task #1102 — let admins re-probe the cached booking schema-readiness
  // snapshot on demand. The snapshot is normally only refreshed at server
  // boot (`ensureBookingTables` / `ensureBookingDbConstraints`); after an
  // operator applies a missing migration they previously had to wait for
  // the next restart for the health tile to flip back to green. This
  // endpoint runs the existing `recheckBookingSchemaReadiness()` helper
  // and returns the fresh snapshot in the same shape the GET endpoint
  // exposes under `schemaReadiness` so the admin UI can drop it straight
  // into its query cache.
  app.post("/api/admin/booking/health/recheck", isAuthenticated, async (req: any, res) => {
    try {
      const user = await loadCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role !== "team_lead" && user.role !== "ceo" && user.role !== "admin") {
        return res.status(403).json({ error: "Access denied" });
      }
      const schemaReadiness = await recheckBookingSchemaReadiness();
      const operatorAction = schemaReadiness.ready
        ? null
        : "Apply booking migrations 0034-0036.";
      res.json({
        schemaReadiness: {
          ...schemaReadiness,
          operatorAction,
        },
      });
    } catch (err: any) {
      console.error("[Booking] Admin health recheck error:", err);
      res.status(500).json({ error: "Failed to re-check booking health" });
    }
  });

  // -----------------------------------------------------------------------
  // Recurrence-aware routes (Task #1032E)
  //
  // Three new HTTP surfaces wired on top of the saga shipped in #1032D:
  //
  //   1. POST /api/booking/me/recurrence/preview-availability
  //      POST /api/book/:slug/recurrence/preview-availability
  //        Validate + expand a proposed recurrence and return per-
  //        occurrence conflict info so the UI can render a "this will
  //        produce N meetings; M conflict" preview before the user
  //        actually books.
  //
  //   2. PATCH /api/booking/:id   (staff-only)
  //        Edit an existing meeting (one-off or series) via the
  //        recurrence-aware orchestrator from #1039. Public PATCH is
  //        out of scope for this task.
  //
  //   3. DELETE /api/booking/:id  (staff-only)
  //        Cancel an existing meeting with explicit scope semantics.
  //        Public cancellation via signed link is deferred until the
  //        public-cancel-link infrastructure lands with #1032H.
  // -----------------------------------------------------------------------

  /**
   * Body schema for preview-availability. Caller supplies the proposed
   * first-occurrence start, the recurrence payload, and (optional)
   * effective duration / buffers — same per-meeting overrides accepted
   * by the AM book endpoint so the preview matches what the booking
   * would actually do.
   */
  const previewAvailabilitySchema = z.object({
    startTimeUtc: z.string().datetime(),
    recurrence: recurrencePayloadSchema,
    durationMinutes: z.number().int().min(15).max(240).optional(),
    bufferBeforeMinutes: z.number().int().min(0).max(120).optional(),
    bufferAfterMinutes: z.number().int().min(0).max(120).optional(),
  });

  async function runRecurrencePreview(
    page: BookingPage,
    body: z.infer<typeof previewAvailabilitySchema>,
  ) {
    const validation = validateRecurrencePayload(body.recurrence);
    if (!validation.ok) {
      return {
        status: 400,
        json: { error: validation.message, code: validation.code },
      } as const;
    }
    const startUtc = new Date(body.startTimeUtc);
    if (Number.isNaN(startUtc.getTime())) {
      return {
        status: 400,
        json: { error: "Invalid startTimeUtc", code: "invalid_input" },
      } as const;
    }
    const effectiveDuration = body.durationMinutes ?? page.durationMinutes;
    // 24-month horizon matches the saga + perfConfig defaults so the
    // preview can never disagree with what bookSlot would actually
    // accept.
    const horizonMonths = 24;
    const horizonMs = horizonMonths * 30 * 24 * 60 * 60 * 1000;
    const expanded = expandRecurrence(validation.normalized, {
      dtstart: startUtc,
      durationMinutes: effectiveDuration,
      from: startUtc,
      to: new Date(startUtc.getTime() + horizonMs),
    });
    if (!expanded.ok) {
      return {
        status: 400,
        json: { error: expanded.message, code: expanded.code },
      } as const;
    }
    const effectivePage: BookingPage = {
      ...page,
      durationMinutes: effectiveDuration,
      bufferBeforeMinutes:
        body.bufferBeforeMinutes ?? page.bufferBeforeMinutes,
      bufferAfterMinutes:
        body.bufferAfterMinutes ?? page.bufferAfterMinutes,
    };
    const { conflicts } = await checkOccurrencesAvailability(
      effectivePage,
      expanded.occurrences.map((o) => ({ start: o.start, end: o.end })),
    );
    return {
      status: 200,
      json: {
        ok: conflicts.length === 0,
        occurrences: expanded.occurrences.map((o) => ({
          startUtc: o.start.toISOString(),
          endUtc: o.end.toISOString(),
          originalStartTime: o.originalStartTime.toISOString(),
        })),
        conflicts: conflicts.map((c) => ({
          startUtc: c.start.toISOString(),
          endUtc: c.end.toISOString(),
          reason: c.reason,
        })),
        truncated: expanded.truncated,
        summary: validation.normalized.summary ?? null,
        timezone: validation.normalized.timezone,
      },
    } as const;
  }

  /**
   * Staff variant: auth-required, lazy-creates the AM's booking page.
   *
   * Spec path is `/api/booking/recurrence/preview-availability`; we
   * also keep the `/me/...` alias so any client that already wired
   * the namespaced URL keeps working.
   */
  app.post(
    [
      "/api/booking/recurrence/preview-availability",
      "/api/booking/me/recurrence/preview-availability",
    ],
    isAuthenticated,
    publicBookingLimiter,
    async (req: any, res) => {
      try {
        const user = await loadCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Not authenticated" });
        // Task #1044: internal-surface kill switches. Refuse before any
        // expansion / free-busy work so a disabled feature can't be
        // probed via the preview endpoint.
        const featureFlags = await getBookingFeatureFlags();
        if (!featureFlags.master || !featureFlags.internal) {
          return res.status(403).json({
            error:
              "Recurring meetings are currently disabled by an administrator.",
            code: "recurrence_disabled",
            details: {
              flag: !featureFlags.master
                ? "booking_recurring_enabled"
                : "booking_recurring_internal_enabled",
            },
          });
        }
        const parsed = previewAvailabilitySchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid request", details: parsed.error.flatten() });
        }
        const page = await ensureBookingPage(user);
        const result = await runRecurrencePreview(page, parsed.data);
        res.status(result.status).json(result.json);
      } catch (err: any) {
        console.error("[Booking] Recurrence preview (me) error:", err);
        res.status(500).json({ error: "Failed to preview recurrence" });
      }
    },
  );

  /** Public variant: gated by booking-page slug + `allowRecurring`. */
  app.post(
    "/api/book/:slug/recurrence/preview-availability",
    publicBookingLimiter,
    async (req, res) => {
      try {
        const slug = String(req.params.slug || "").toLowerCase();
        if (!SLUG_RE.test(slug)) {
          return res.status(400).json({ error: "Invalid slug" });
        }
        const page = await storage.getBookingPageBySlug(slug);
        if (!page || !page.active) {
          return res.status(404).json({ error: "Booking page not found" });
        }
        if (!page.allowRecurring) {
          return res.status(403).json({
            error: "This booking page does not allow recurring meetings.",
            code: "recurrence_not_allowed",
          });
        }
        // Task #1044: per-surface kill switches.
        const featureFlags = await getBookingFeatureFlags();
        if (!featureFlags.master || !featureFlags.public) {
          return res.status(403).json({
            error:
              "Recurring meetings are currently disabled by an administrator.",
            code: "recurrence_disabled",
            details: {
              flag: !featureFlags.master
                ? "booking_recurring_enabled"
                : "booking_recurring_public_enabled",
            },
          });
        }
        const parsed = previewAvailabilitySchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid request", details: parsed.error.flatten() });
        }
        const result = await runRecurrencePreview(page, parsed.data);
        res.status(result.status).json(result.json);
      } catch (err: any) {
        console.error("[Booking] Recurrence preview (public) error:", err);
        res.status(500).json({ error: "Failed to preview recurrence" });
      }
    },
  );

  /**
   * PATCH /api/booking/:id — staff-only edit.
   *
   * Ownership: the caller must either be the AM who owns the meeting
   * (`accountManagerUserId === user.id`) or have `account_manager+`
   * role (which already covers admin/CEO via the role hierarchy in
   * `hasRole`). Public PATCH is explicitly out of scope per the
   * #1032E spec.
   */
  const editScopeSchema = z.enum(recurrenceExceptionScopes);
  const editChangesSchema = z
    .object({
      startTimeUtc: z.string().datetime().optional(),
      endTimeUtc: z.string().datetime().optional(),
      durationMinutes: z.number().int().min(15).max(240).optional(),
      timezone: z.string().min(1).max(64).optional(),
      summary: z.string().max(500).optional(),
      description: z.string().max(5000).optional(),
      location: z.string().max(500).optional(),
      attendees: z
        .array(
          z.object({
            email: z.string().email().max(254),
            displayName: z.string().max(120).optional(),
          }),
        )
        .max(50)
        .optional(),
      recurrence: recurrencePayloadSchema.optional(),
      reminderOverrides: z
        .array(
          z.object({
            method: z.enum(["email", "popup"]),
            minutes: z.number().int().min(0).max(40320),
          }),
        )
        .max(5)
        .optional(),
    })
    .refine(
      (c) => Object.keys(c).length > 0,
      "At least one change must be supplied",
    );

  app.patch(
    "/api/booking/:id",
    isAuthenticated,
    writeLimiter,
    async (req: any, res) => {
      try {
        const user = await loadCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Not authenticated" });

        const meeting = await storage.getScheduledMeetingById(req.params.id);
        if (!meeting) {
          return res.status(404).json({ error: "Meeting not found" });
        }
        // Ownership: by default only the AM who owns the meeting can
        // edit it. Admins (`team_lead+`) get an explicit override so
        // they can intervene on a colleague's calendar — being
        // generically `account_manager` is NOT enough, otherwise any
        // AM could mutate any other AM's bookings.
        const isAdminOverride = hasRole(user.role, "team_lead");
        if (!isAdminOverride && meeting.accountManagerUserId !== user.id) {
          return res.status(403).json({ error: "Not your meeting" });
        }

        const bodySchema = z.object({
          scope: editScopeSchema,
          originalStartTime: z.string().datetime().optional(),
          changes: editChangesSchema,
          sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
        });
        const parsed = bodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid request", details: parsed.error.flatten() });
        }

        // Validate the (optional) replacement recurrence at the API
        // boundary so the saga's "caller must pre-normalize" contract
        // holds. The saga itself rejects `this_event` + recurrence as
        // a misuse, but we surface invalid RRULEs early either way.
        let normalizedRecurrence: scheduler.EditBookingChanges["recurrence"];
        if (parsed.data.changes.recurrence) {
          const validation = validateRecurrencePayload(
            parsed.data.changes.recurrence,
          );
          if (!validation.ok) {
            return res
              .status(400)
              .json({ error: validation.message, code: validation.code });
          }
          normalizedRecurrence = validation.normalized;
        }

        try {
          const result = await scheduler.editBooking({
            meetingId: meeting.id,
            scope: parsed.data.scope as RecurrenceExceptionScope,
            originalStartTime: parsed.data.originalStartTime
              ? new Date(parsed.data.originalStartTime)
              : undefined,
            sendUpdates: parsed.data.sendUpdates,
            actorUserId: user.id,
            changes: {
              startTimeUtc: parsed.data.changes.startTimeUtc
                ? new Date(parsed.data.changes.startTimeUtc)
                : undefined,
              endTimeUtc: parsed.data.changes.endTimeUtc
                ? new Date(parsed.data.changes.endTimeUtc)
                : undefined,
              durationMinutes: parsed.data.changes.durationMinutes,
              timezone: parsed.data.changes.timezone,
              summary: parsed.data.changes.summary,
              description: parsed.data.changes.description,
              location: parsed.data.changes.location,
              attendees: parsed.data.changes.attendees,
              recurrence: normalizedRecurrence,
              reminderOverrides: parsed.data.changes.reminderOverrides,
            },
          });
          res.json({
            status: "edited",
            master: result.master,
            newMaster: result.newMaster,
          });
        } catch (err: any) {
          if (err instanceof scheduler.BookingError) {
            const mapped = bookingErrorToHttp(err, !!normalizedRecurrence);
            return res.status(mapped.status).json({
              error: mapped.message,
              code: mapped.code,
              ...(mapped.details ? { details: mapped.details } : {}),
            });
          }
          throw err;
        }
      } catch (err: any) {
        console.error("[Booking] Edit booking error:", err);
        res.status(500).json({ error: "Failed to edit meeting" });
      }
    },
  );

  /**
   * DELETE /api/booking/:id — recurrence-aware cancel.
   *
   * Two authentication modes are accepted:
   *
   *   1. **Staff (auth):** the caller must be the AM who owns the
   *      meeting OR have `team_lead+` role (admin override). All three
   *      scopes (`this_event`, `this_and_following`, `entire_series`)
   *      are allowed.
   *
   *   2. **Public (signed cancel link):** the caller passes a
   *      `cancelToken` (query or body) minted via
   *      `signHmacPayload("booking_cancel", meetingId)` — i.e. a
   *      stateless link that proves the holder was issued a cancel
   *      URL for THIS meeting. Per the epic this surface is allowed
   *      to use only `this_event` or `entire_series` — `this_and_
   *      following` requires staff auth and is rejected with 403.
   *
   * Body / query (parsed from both so a one-click link works):
   *   `{ scope, originalStartTime?, sendUpdates?, reason?, cancelToken? }`.
   */
  function isAuthenticatedOrSignedCancel(
    req: any,
    res: any,
    next: any,
  ): void {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    const tokenSrc = (req.body && req.body.cancelToken) ?? req.query?.cancelToken;
    if (typeof tokenSrc === "string" && tokenSrc.length > 0) {
      // Defer the actual HMAC check to the handler so it can compare
      // against the meetingId from the URL and emit a precise error.
      return next();
    }
    res.status(401).json({ error: "Not authenticated" });
  }

  app.delete(
    "/api/booking/:id",
    isAuthenticatedOrSignedCancel,
    writeLimiter,
    async (req: any, res) => {
      try {
        const meeting = await storage.getScheduledMeetingById(req.params.id);
        if (!meeting) {
          return res.status(404).json({ error: "Meeting not found" });
        }

        const bodySchema = z.object({
          scope: editScopeSchema.optional(),
          originalStartTime: z.string().datetime().optional(),
          sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
          reason: z.string().max(1000).optional(),
          cancelToken: z.string().min(8).max(1024).optional(),
        });
        const merged = {
          ...(req.query as Record<string, unknown>),
          ...(typeof req.body === "object" && req.body ? req.body : {}),
        };
        const parsed = bodySchema.safeParse(merged);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid request", details: parsed.error.flatten() });
        }

        // Resolve auth mode + actor id.
        let actorUserId: string | null = null;
        let isPublicSignedLink = false;
        const isLoggedIn =
          typeof req.isAuthenticated === "function" && req.isAuthenticated();
        if (isLoggedIn) {
          const user = await loadCurrentUser(req);
          if (!user) return res.status(401).json({ error: "Not authenticated" });
          // Owner-only by default; team_lead+ overrides for admin
          // intervention on a colleague's calendar. Generic
          // `account_manager` is NOT enough.
          const isAdminOverride = hasRole(user.role, "team_lead");
          if (!isAdminOverride && meeting.accountManagerUserId !== user.id) {
            return res.status(403).json({ error: "Not your meeting" });
          }
          actorUserId = user.id;
        } else {
          if (!parsed.data.cancelToken) {
            return res.status(401).json({ error: "Not authenticated" });
          }
          const verified = verifyHmacPayload(
            "booking_cancel",
            parsed.data.cancelToken,
          );
          if (!verified || verified !== meeting.id) {
            return res.status(403).json({
              error: "This cancel link is invalid or has expired.",
              code: "invalid_cancel_token",
            });
          }
          isPublicSignedLink = true;
          // Public callers may NOT request `this_and_following` —
          // that scope can re-shape the master + spawn a sibling
          // series and is an admin-only operation per the epic.
          if (parsed.data.scope === "this_and_following") {
            return res.status(403).json({
              error:
                "Public cancel links cannot request scope=this_and_following.",
              code: "scope_not_allowed_for_public",
            });
          }
        }

        try {
          const updated = await scheduler.cancelBooking({
            meetingId: meeting.id,
            scope: parsed.data.scope,
            originalStartTime: parsed.data.originalStartTime
              ? new Date(parsed.data.originalStartTime)
              : undefined,
            sendUpdates: parsed.data.sendUpdates,
            reason: parsed.data.reason,
            actorUserId,
          });
          if (!updated) {
            return res.status(404).json({ error: "Meeting not found" });
          }
          // Public surface trims AM-internal calendar metadata to
          // match the public confirm response shape.
          if (isPublicSignedLink) {
            return res.json({
              status: "canceled",
              meetingId: updated.id,
              startTimeUtc: updated.startTimeUtc,
              endTimeUtc: updated.endTimeUtc,
            });
          }
          res.json({ status: "canceled", meeting: updated });
        } catch (err: any) {
          if (err instanceof scheduler.BookingError) {
            // Cancel paths can fail with recurrence error codes only
            // on the recurring branch; pass `isRecurring=true`
            // whenever the row was part of a series so the public
            // code mapping matches.
            const isRec =
              !!meeting.recurringEventId ||
              (meeting.recurrence?.length ?? 0) > 0 ||
              !!meeting.seriesMasterId;
            const mapped = bookingErrorToHttp(err, isRec);
            return res.status(mapped.status).json({
              error: mapped.message,
              code: mapped.code,
              ...(mapped.details ? { details: mapped.details } : {}),
            });
          }
          throw err;
        }
      } catch (err: any) {
        console.error("[Booking] Cancel booking error:", err);
        res.status(500).json({ error: "Failed to cancel meeting" });
      }
    },
  );
}
